import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSDK, defineTool, formAppHtml, ToolError } from 'agent-studio-sdk';

const noParameters = { type: 'object', properties: {}, additionalProperties: false };

/** A session store whose saved messages a test can read, as an application database would hold them. */
function inspectableStore() {
  const sessions = new Map();
  let writes = 0;
  return {
    sessions,
    get writes() { return writes; },
    async get(key) { return structuredClone(sessions.get(key) ?? []); },
    async set(key, messages) {
      writes += 1;
      sessions.set(key, structuredClone(messages));
    },
    only() {
      assert.equal(sessions.size, 1);
      return [...sessions.values()][0];
    },
  };
}

const isSummaryCall = ({ systemPrompt }) => systemPrompt.startsWith('You shorten the earlier part of a conversation');

test('a later turn reads the tool calls and shortened results of earlier turns, while the trace and getHistory leave them out', async () => {
  const orders = Array.from({ length: 300 }, (_, index) => ({ id: `DH${index}`, status: 'shipping', note: 'x'.repeat(100) }));
  const tools = [
    defineTool({ name: 'list_orders', description: 'List orders', parameters: noParameters, execute: () => orders }),
    defineTool({ name: 'get_salary', description: 'Read the salary', parameters: noParameters, history: false, execute: () => ({ salary: 1000 }) }),
    defineTool({
      name: 'get_order', description: 'Read one order', parameters: { type: 'object', properties: { id: { type: 'string' } } },
      execute: ({ id }) => { throw new ToolError('not_found', `No order ${id}`); },
    }),
  ];
  const seen = [];
  const model = {
    async generate({ history, steps }) {
      seen.push(history);
      if (history.length === 1 && !steps.length) {
        return { toolCalls: [
          { id: 'c1', name: 'list_orders', arguments: '{}' },
          { id: 'c2', name: 'get_salary', arguments: '{}' },
          { id: 'c3', name: 'get_order', arguments: '{"id":"DH9"}' },
        ] };
      }
      return { text: history.length === 1 ? 'You have 300 orders.' : 'DH0 is shipping.' };
    },
  };
  const store = inspectableStore();
  const sdk = createSDK({ model, tools, sessionStore: store });
  const agent = sdk.createAgent({ systemPrompt: 'Answer about orders', tools: ['list_orders', 'get_salary', 'get_order'] });

  const first = await agent.run({ sessionId: 's', message: 'List my orders' });
  assert.equal(first.status, 'completed');
  for (const entry of first.trace) {
    assert.deepEqual(Object.keys(entry).filter((key) => !['name', 'status', 'step', 'durationMs', 'error'].includes(key)), []);
  }

  const [, reply] = store.only();
  assert.equal(reply.tools.length, 3);
  const [list, salary, failed] = reply.tools;
  assert.deepEqual({ ...list, result: undefined }, { name: 'list_orders', arguments: '{}', ok: true, result: undefined });
  assert.ok(list.result.length <= 4_001, `result has ${list.result.length} characters`);
  assert.ok(list.result.startsWith('[{"id":"DH0","status":"shipping"'));
  assert.ok(list.result.endsWith(',"…(275 more items)"]'));
  assert.doesNotThrow(() => JSON.parse(list.result));
  assert.deepEqual(salary, { name: 'get_salary', arguments: '{}', ok: true });
  assert.deepEqual(failed, { name: 'get_order', arguments: '{"id":"DH9"}', ok: false,
    result: '{"code":"not_found","message":"No order DH9"}' });

  const second = await agent.run({ sessionId: 's', message: 'Which one is first?' });
  assert.equal(second.status, 'completed');
  const read = seen.at(-1)[1].content;
  assert.ok(read.startsWith('You have 300 orders.\n[Tool calls behind this reply.'));
  assert.ok(read.includes(`\n- list_orders({}) returned ${list.result}\n`));
  assert.ok(read.includes('\n- get_salary({}) completed; result not kept\n'));
  assert.ok(read.endsWith('\n- get_order({"id":"DH9"}) failed: {"code":"not_found","message":"No order DH9"}]'));
  assert.ok(!read.includes('1000'));

  const history = await agent.getHistory({ sessionId: 's' });
  assert.deepEqual(history.map(({ content }) => content),
    ['List my orders', 'You have 300 orders.', 'Which one is first?', 'DH0 is shipping.']);
  assert.ok(history.every((message) => !('tools' in message)));
});

test('over the history budget, the model reads the oldest tool results as left out before any turn is dropped', async () => {
  const fetchData = defineTool({ name: 'fetch_data', description: 'Fetch data', parameters: noParameters,
    execute: () => ({ data: 'y'.repeat(1_000) }) });
  const seen = [];
  const model = {
    async generate(input) {
      assert.ok(!isSummaryCall(input), 'the history fits once old results are left out, so nothing is summarized');
      if (!input.steps.length) return { toolCalls: [{ id: `c${seen.length}`, name: 'fetch_data', arguments: '{}' }] };
      seen.push(input.history);
      return { text: 'ok' };
    },
  };
  const sdk = createSDK({ model, tools: [fetchData], historyBudget: 1_000 });
  const agent = sdk.createAgent({ systemPrompt: 'Fetch data', tools: ['fetch_data'] });
  for (const turn of [1, 2, 3, 4]) {
    const result = await agent.run({ sessionId: 's', message: `Turn ${turn}` });
    assert.equal(result.status, 'completed');
    assert.equal(result.usage.modelCalls, 2);
  }
  const last = seen.at(-1);
  assert.deepEqual(last.map(({ role }) => role), ['user', 'assistant', 'user', 'assistant', 'user', 'assistant', 'user']);
  assert.ok(last[1].content.endsWith('- fetch_data({}) completed; result not kept]'));
  assert.ok(last[3].content.includes('- fetch_data({}) returned {"data":"yyy'));
  assert.ok(last[5].content.includes('- fetch_data({}) returned {"data":"yyy'));
});

test('a stored session past maxTurns is summarized by the model, keeping the newest turn and the forms still open', async () => {
  const propose = defineTool({
    name: 'propose_leave', description: 'Prepare a leave request', parameters: noParameters,
    result: { 'x-form': 'confirm', type: 'object' },
    forms: { confirm: { html: '<form>confirm</form>', submit: () => ({ leaveId: 'L1' }) } },
    execute: () => ({ date: '2026-11-21' }),
  });
  const summaries = [];
  const seen = [];
  const model = {
    async generate(input) {
      if (isSummaryCall(input)) {
        summaries.push(input);
        return { text: 'Leave for 2026-11-21 is waiting in a form. The user asked about DH1.', usage: { promptTokens: 7 } };
      }
      const last = input.history.at(-1).content;
      if (last === 'Nghỉ ngày mai' && !input.steps.length) return { toolCalls: [{ id: 'c1', name: 'propose_leave', arguments: '{}' }] };
      seen.push(input.history);
      return { text: `Reply to ${last}` };
    },
  };
  const store = inspectableStore();
  const sdk = createSDK({ model, tools: [propose], sessionStore: store, maxTurns: 2 });
  const agent = sdk.createAgent({ systemPrompt: 'Help with leave', tools: ['propose_leave'] });

  const results = [];
  const events = [];
  for (const message of ['Nghỉ ngày mai', 'Hỏi DH1', 'Hỏi DH2', 'Hỏi DH3']) {
    results.push(await agent.run({ sessionId: 's', message, onEvent: (event) => events.push(event) }));
  }
  assert.ok(results.every(({ status }) => status === 'completed'));
  const formId = results[0].forms[0].id;

  // Turn 4 found 3 past turns, one more than maxTurns: turns 1 and 2 went into the summary, turn 3 stayed.
  assert.equal(summaries.length, 1);
  const [summary] = summaries;
  assert.deepEqual([summary.tools, summary.toolChoice, summary.steps, summary.history.length], [[], 'none', [], 1]);
  const text = summary.history[0].content;
  assert.ok(text.startsWith('User:\nNghỉ ngày mai\n\nAssistant:\nReply to Nghỉ ngày mai\n[Tool calls behind this reply.'));
  assert.ok(text.includes('- propose_leave({}) returned {"date":"2026-11-21"}'));
  assert.ok(text.includes('[Form "confirm" of propose_leave: shown to the user, not submitted yet]'));
  assert.ok(text.endsWith('User:\nHỏi DH1\n\nAssistant:\nReply to Hỏi DH1'));
  assert.deepEqual(events.filter(({ type }) => type === 'history.compacted').map(({ status, turns }) => [status, turns]),
    [['completed', 2]]);
  assert.equal(results[3].usage.modelCalls, 2);
  assert.equal(results[3].usage.promptTokens, 7);

  // The summary is joined to the first kept message, so roles still alternate.
  const read = seen.at(-1);
  assert.deepEqual(read.map(({ role }) => role), ['user', 'assistant', 'user']);
  assert.ok(read[0].content.startsWith('[Summary of the earlier conversation, which was shortened to save space]\n' +
    'Leave for 2026-11-21 is waiting in a form. The user asked about DH1.\n' +
    '[Form "confirm" of propose_leave: shown to the user, not submitted yet]\n\nHỏi DH2'));
  assert.deepEqual(read.slice(1).map(({ content }) => content), ['Reply to Hỏi DH2', 'Hỏi DH3']);

  const saved = store.only();
  assert.deepEqual(saved.map(({ role, summary }) => [role, summary ?? false]),
    [['user', true], ['user', false], ['assistant', false], ['user', false], ['assistant', false]]);
  const history = await agent.getHistory({ sessionId: 's' });
  assert.equal(history[0].summary, true);
  assert.deepEqual(history[0].forms.map(({ id, status, html }) => [id, status, html]), [[formId, 'open', formAppHtml('<form>confirm</form>', { tool: 'propose_leave', form: 'confirm', submit: true })]]);

  // The form of a summarized turn can still be submitted.
  const submitted = await agent.submitForm({ sessionId: 's', formId, values: {} });
  assert.equal(submitted.status, 'submitted');
  assert.equal(store.only()[0].forms[0].status, 'submitted');

  // The session is within maxTurns again, so the next turn does not summarize.
  const fifth = await agent.run({ sessionId: 's', message: 'Hỏi DH4' });
  assert.equal(fifth.usage.modelCalls, 1);
  assert.equal(summaries.length, 1);
  assert.ok(seen.at(-1)[0].content.includes('[Form "confirm" of propose_leave: the user submitted it. Result: {"leaveId":"L1"}]'));
});

test('when the summary cannot be written, the turn still completes, the next turn tries again and the store keeps at most twice maxTurns', async () => {
  let summaryCalls = 0;
  const model = {
    async generate(input) {
      if (isSummaryCall(input)) {
        summaryCalls += 1;
        throw new Error('model unavailable');
      }
      return { text: `Reply ${input.history.length}` };
    },
  };
  const store = inspectableStore();
  const agent = createSDK({ model, sessionStore: store, maxTurns: 1 }).createAgent({ systemPrompt: 'Chat' });
  const events = [];
  for (const message of ['one', 'two', 'three', 'four']) {
    const result = await agent.run({ sessionId: 's', message, onEvent: (event) => events.push(event) });
    assert.equal(result.status, 'completed');
  }
  // Turns 3 and 4 found more past turns than maxTurns. Without a summary the model still read every stored turn
  // (Reply 5: four past messages and the new one), and the store dropped the turns beyond maxTurns * 2.
  assert.equal(summaryCalls, 2);
  assert.deepEqual(events.filter(({ type }) => type === 'history.compacted').map(({ status }) => status), ['error', 'error']);
  assert.deepEqual(store.only().map(({ content }) => content), ['three', 'Reply 5', 'four', 'Reply 5']);
});

test('history passed to run keeps its tool records, is trimmed to the budget and is never summarized or saved', async () => {
  const seen = [];
  const model = {
    async generate(input) {
      assert.ok(!isSummaryCall(input));
      seen.push(input.history);
      return { text: 'ok' };
    },
  };
  const store = inspectableStore();
  const agent = createSDK({ model, sessionStore: store, historyBudget: 1_000 }).createAgent({ systemPrompt: 'Chat' });
  const record = (letter) => ({ name: 'fetch_data', arguments: '{}', ok: true, result: JSON.stringify({ data: letter.repeat(2_000) }) });

  const short = [
    { role: 'user', content: 'Q1' }, { role: 'assistant', content: 'A1', tools: [record('z')] },
    { role: 'user', content: 'Q2' }, { role: 'assistant', content: 'A2', tools: [record('w')] },
  ];
  const first = await agent.run({ sessionId: 's', message: 'Q3', history: short });
  assert.equal(first.usage.modelCalls, 1);
  assert.equal(seen.at(-1).length, 5);
  assert.ok(seen.at(-1)[1].content.endsWith('- fetch_data({}) completed; result not kept]'));
  assert.ok(seen.at(-1)[3].content.includes('returned {"data":"www'));

  // Leaving out every result is not enough here, so the oldest turn is left out.
  const long = [{ role: 'user', content: 'old '.repeat(1_000) }, ...short.slice(1)];
  const second = await agent.run({ sessionId: 's', message: 'Q3', history: long });
  assert.equal(second.usage.modelCalls, 1);
  assert.deepEqual(seen.at(-1).map(({ content }) => content.slice(0, 2)), ['Q2', 'A2', 'Q3']);
  assert.equal(store.writes, 0);

  const invalid = await agent.run({ sessionId: 's', message: 'Q3', history: [{ role: 'assistant', content: 'A', tools: [{ name: 'x' }] }] });
  assert.equal(invalid.status, 'error');
});

test('rejects a history budget below 1000 tokens and a tool history setting that is not a boolean', () => {
  const model = { generate: async () => ({ text: 'ok' }) };
  assert.throws(() => createSDK({ model, historyBudget: 999 }), /historyBudget must be an integer between 1000 and 1000000/);
  assert.throws(() => defineTool({ name: 'x', description: 'x', parameters: noParameters, history: 'no', execute: () => null }),
    /Tool x history must be true or false/);
});
