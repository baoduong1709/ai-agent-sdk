import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createSDK, defineTool } from 'agent-studio-sdk';
import { createOpenAIModel } from 'agent-studio-sdk/openai';

const parameters = {
  type: 'object', required: ['id'], properties: { id: { type: 'string' } }, additionalProperties: false,
};

test('runs permitted tools, rejects invalid and forbidden calls, and passes ordered results to the model', async () => {
  const executed = [];
  const fetchOrder = defineTool({
    name: 'fetch_order', description: 'Look up a single order', parameters,
    authorize: ({ id }, { userId }) => userId === 'customer' && id === 'DH123',
    execute: ({ id }, context) => {
      executed.push({ id, userId: context.userId, callId: context.toolCallId });
      return { status: 'shipping' };
    },
  });
  const model = {
    async generate({ systemPrompt, tools, steps }) {
      assert.equal(systemPrompt, 'Use order data');
      assert.deepEqual(tools, [{ name: 'fetch_order', parameters, description: 'Look up a single order' }]);
      if (!steps.length) {
        return { toolCalls: [
          { id: '1', name: 'fetch_order', arguments: '{"id":123}' },
          { id: '2', name: 'fetch_order', arguments: '{"id":"DH456"}' },
          { id: '3', name: 'fetch_order', arguments: '{"id":"DH123"}' },
          { id: '4', name: 'another_tool', arguments: '{}' },
        ] };
      }
      const { outputs } = steps[0];
      assert.deepEqual(outputs.map(({ callId, output }) => [callId, output.error?.code ?? output.value.status]), [
        ['1', 'invalid_arguments'], ['2', 'tool_forbidden'], ['3', 'shipping'], ['4', 'unknown_tool'],
      ]);
      return { text: 'Your order is shipping.' };
    },
  };
  const sdk = createSDK({ model, tools: [fetchOrder] });
  const agent = sdk.createAgent({ systemPrompt: 'Use order data', tools: ['fetch_order'] });
  const input = { sessionId: '1', context: { appId: 'store', tenantId: 'acme', userId: 'customer' } };
  const result = await agent.run({ ...input, message: 'Where is DH123?' });
  assert.equal(result.status, 'completed');
  assert.equal(result.text, 'Your order is shipping.');
  assert.deepEqual(result.trace.map(({ status }) => status), ['error', 'error', 'completed', 'error']);
  assert.deepEqual(executed, [{ id: 'DH123', userId: 'customer', callId: '3' }]);
  assert.deepEqual((await agent.getHistory(input)).map(({ role }) => role), ['user', 'assistant']);
  assert.deepEqual(await agent.getHistory({ ...input, context: { ...input.context, tenantId: 'other' } }), []);
});

test('treats null as absent for optional arguments, but keeps nulls a schema accepts and rejects the rest', async () => {
  const received = [];
  const search = defineTool({
    name: 'search_leave', description: 'Search leave requests',
    parameters: {
      type: 'object', required: ['employee'], additionalProperties: false,
      properties: {
        employee: { type: 'string' }, status: { type: 'string', enum: ['approved', 'pending'] },
        note: { type: ['string', 'null'] }, filter: { type: 'object', properties: { month: { type: 'string' } } },
      },
    },
    execute: (args) => {
      received.push(args);
      return 'ok';
    },
  });
  const calls = [
    '{"employee":"lan","status":null}',
    '{"employee":"lan","note":null}',
    '{"employee":null}',
    '{"employee":"lan","filter":{"month":null}}',
    '{"employee":"lan","unknown":null}',
    '{"employee":"lan","status":null,"note":7}',
  ];
  const model = {
    async generate({ steps }) {
      if (!steps.length) return { toolCalls: calls.map((args, index) => ({ id: String(index), name: 'search_leave', arguments: args })) };
      const codes = steps[0].outputs.map(({ output }) => output.ok ? 'ok' : output.error.code);
      assert.deepEqual(codes, ['ok', 'ok', 'invalid_arguments', 'invalid_arguments', 'invalid_arguments', 'invalid_arguments']);
      assert.match(steps[0].outputs[5].output.error.message, /arguments\/note/);
      assert.doesNotMatch(steps[0].outputs[5].output.error.message, /arguments\/status/);
      return { text: 'Done' };
    },
  };
  const result = await createSDK({ model, tools: [search] })
    .createAgent({ systemPrompt: 'Search', tools: ['search_leave'] }).run({ sessionId: 'nulls', message: 'Leave of Lan' });
  assert.equal(result.status, 'completed');
  assert.deepEqual(received, [{ employee: 'lan' }, { employee: 'lan', note: null }]);
});

test('serializes concurrent messages for the same session and splits application histories', async () => {
  const sdk = createSDK({ model: { async generate({ history }) {
    await delay(5);
    return { text: String(history.length) };
  } } });
  const agent = sdk.createAgent({ systemPrompt: 'Answer' });
  const input = { sessionId: 'same', context: { appId: 'one' } };
  const [first, second, elsewhere] = await Promise.all([
    agent.run({ ...input, message: 'First' }), agent.run({ ...input, message: 'Second' }),
    agent.run({ ...input, context: { appId: 'two' }, message: 'Other application' }),
  ]);
  assert.deepEqual([first.text, second.text, elsewhere.text], ['1', '3', '1']);
});

test('skips actions at the step limit and blocks repeated tool calls', async () => {
  let executed = 0;
  const tool = defineTool({ name: 'record', description: 'Record', parameters, execute: () => ++executed });
  const sdk = createSDK({ model: { async generate() {
    return { toolCalls: [{ id: 'duplicate', name: 'record', arguments: '{"id":"1"}' }] };
  } } });
  const config = { systemPrompt: 'Record', tools: [tool] };
  const input = { sessionId: '1', message: 'Go' };
  assert.equal((await sdk.createAgent({ ...config, maxSteps: 1 }).run(input)).status, 'limit_reached');
  assert.equal(executed, 0);
  const agent = sdk.createAgent(config);
  assert.equal((await agent.run(input)).error.code, 'duplicate_call');
  assert.equal(executed, 1);
  assert.deepEqual(await agent.getHistory(input), []);
});

test('answers from gathered results once the tool call limit is reached', async () => {
  let executed = 0;
  const lookup = defineTool({ name: 'lookup', description: 'Look up an order', parameters, execute: ({ id }) => {
    executed += 1;
    return { id, status: 'shipping' };
  } });
  const inputs = [];
  const model = { async generate(input) {
    inputs.push(input);
    if (input.toolChoice === 'none') return { text: 'DH1 is shipping. I could not check DH2 and DH3.' };
    if (!input.steps.length) return { toolCalls: [{ id: '1', name: 'lookup', arguments: '{"id":"DH1"}' }] };
    return { toolCalls: [
      { id: '2', name: 'lookup', arguments: '{"id":"DH2"}' }, { id: '3', name: 'lookup', arguments: '{"id":"DH3"}' },
    ] };
  } };
  const agent = createSDK({ model, tools: [lookup] }).createAgent({ systemPrompt: 'Track orders', tools: ['lookup'], maxToolCalls: 2 });
  const events = [];
  const input = { sessionId: '1', message: 'Track DH1, DH2 and DH3' };
  const result = await agent.run({ ...input, onEvent: (event) => events.push(event) });
  assert.equal(result.status, 'limit_reached');
  assert.equal(result.error.code, 'run_limit');
  assert.equal(result.text, 'DH1 is shipping. I could not check DH2 and DH3.');
  assert.equal(executed, 1);
  assert.equal(result.usage.modelCalls, 3);
  const closing = inputs.at(-1);
  assert.equal(inputs[1].toolChoice, undefined);
  assert.match(closing.systemPrompt, /^Track orders\n\nTools are no longer available/);
  assert.equal(closing.tools.length, 1);
  assert.equal(closing.steps.length, 1, 'skipped calls are not sent back');
  assert.deepEqual(events.filter(({ type }) => type === 'model.started').map(({ step }) => step), [1, 2, 3]);
  assert.deepEqual((await agent.getHistory(input)).map(({ content }) => content),
    ['Track DH1, DH2 and DH3', 'DH1 is shipping. I could not check DH2 and DH3.']);
});

test('reports the limit without an answer when the closing call fails or still asks for tools', async () => {
  const lookup = defineTool({ name: 'lookup', description: 'Look up', parameters, execute: () => 'found' });
  const call = { toolCalls: [{ id: '1', name: 'lookup', arguments: '{"id":"1"}' }] };
  for (const closing of [
    async () => ({ ...call, text: 'Let me check that.' }),
    async () => { throw new Error('provider down'); },
    async () => ({ text: '  ' }),
  ]) {
    const model = { generate: (input) => input.toolChoice === 'none' ? closing() : Promise.resolve(call) };
    const agent = createSDK({ model, tools: [lookup] }).createAgent({ systemPrompt: 'Look up', tools: ['lookup'], maxSteps: 1 });
    const input = { sessionId: '1', message: 'Go' };
    const result = await agent.run(input);
    assert.equal(result.status, 'limit_reached');
    assert.equal(result.error.code, 'run_limit');
    assert.equal(result.text, undefined);
    assert.deepEqual(await agent.getHistory(input), []);
  }
});

test('a run that answers within its last step is still completed', async () => {
  const lookup = defineTool({ name: 'lookup', description: 'Look up', parameters, execute: () => 'found' });
  const model = { async generate({ steps, toolChoice }) {
    assert.equal(toolChoice, undefined);
    return steps.length ? { text: 'Found it.' } : { toolCalls: [{ id: '1', name: 'lookup', arguments: '{"id":"1"}' }] };
  } };
  const result = await createSDK({ model, tools: [lookup] })
    .createAgent({ systemPrompt: 'Look up', tools: ['lookup'], maxSteps: 2 }).run({ sessionId: '1', message: 'Go' });
  assert.equal(result.status, 'completed');
  assert.equal(result.usage.modelCalls, 2);
});

test('cancels a queued run without letting later runs bypass the active run', async () => {
  let release;
  const hold = new Promise((resolve) => { release = resolve; });
  const sdk = createSDK({ model: { async generate({ history }) {
    if (history.at(-1).content === 'Hold') await hold;
    return { text: String(history.length) };
  } } });
  const agent = sdk.createAgent({ systemPrompt: 'Answer' });
  const first = agent.run({ sessionId: '1', message: 'Hold' });
  const controller = new AbortController();
  const cancelled = agent.run({ sessionId: '1', message: 'Cancel', signal: controller.signal });
  controller.abort();
  assert.equal((await cancelled).status, 'cancelled');
  const third = agent.run({ sessionId: '1', message: 'Continue' });
  release();
  assert.equal((await first).status, 'completed');
  assert.equal((await third).text, '3');
});

test('forwards OpenAI function outputs with the original call ID and keeps credentials out of inputs', async () => {
  const inputBodies = [];
  const model = createOpenAIModel({ apiKey: 'test-key', model: 'test-model', reasoningEffort: 'high', fetch: async (url, options) => {
    assert.equal(url, 'https://api.openai.com/v1/responses');
    assert.equal(options.headers.Authorization, 'Bearer test-key');
    assert.ok(!options.body.includes('test-key'));
    inputBodies.push(JSON.parse(options.body));
    return Response.json({ status: 'completed', output: inputBodies.length === 1
      ? [{ type: 'function_call', call_id: 'order_call', name: 'fetch_order', arguments: '{"id":"DH123"}', created_by: { type: 'model' } }]
      : [{ type: 'message', content: [{ type: 'output_text', text: 'Order found.' }] }],
    });
  } });
  const tool = defineTool({ name: 'fetch_order', description: 'Fetch order', parameters, execute: ({ id }) => ({ id }) });
  const agent = createSDK({ model }).createAgent({ systemPrompt: 'Check the order', tools: [tool] });
  const result = await agent.run({ sessionId: '1', message: 'Status of DH123?' });
  assert.equal(result.text, 'Order found.');
  assert.equal(inputBodies[0].store, false);
  assert.equal(inputBodies[0].instructions, 'Check the order');
  assert.equal(inputBodies[0].reasoning.effort, 'high');
  assert.equal(inputBodies[1].input.at(-2).type, 'function_call');
  assert.equal(inputBodies[1].input.at(-2).created_by, undefined);
  assert.deepEqual(inputBodies[1].input.at(-1), {
    type: 'function_call_output', call_id: 'order_call', output: '{"ok":true,"value":{"id":"DH123"}}',
  });
});

test('adds, edits and removes tools for one agent without changing another agent', async () => {
  const tool = defineTool({ name: 'inspect', description: 'Original', parameters, execute: () => 'A' });
  const model = { async generate({ tools }) { return { text: tools[0]?.description ?? 'No tools' }; } };
  const sdk = createSDK({ model, tools: [tool] });
  const agentA = sdk.createAgent({ systemPrompt: 'Test' });
  const agentB = sdk.createAgent({ systemPrompt: 'Test', tools: ['inspect'] });
  const run = (agent) => agent.run({ sessionId: '1', message: 'Inspect' });
  agentA.addTool('inspect');
  assert.throws(() => agentA.addTool('inspect'), /selected twice/);
  assert.equal((await run(agentA)).text, 'Original');
  agentA.updateTool('inspect', { ...tool, description: 'Edited for A' });
  assert.equal((await run(agentA)).text, 'Edited for A');
  assert.equal((await run(agentB)).text, 'Original');
  assert.equal(agentA.removeTool('inspect'), true);
  assert.equal((await run(agentA)).text, 'No tools');
  assert.equal((await run(agentB)).text, 'Original');
});

test('emits ordered lifecycle events and returns an application policy denial to the model', async () => {
  const events = [];
  let executions = 0;
  const tool = defineTool({
    name: 'lookup', description: 'Look up an order', parameters,
    execute: ({ id }) => { executions++; return id; },
  });
  const sdk = createSDK({
    beforeTool: (call) => {
      const allowed = call.context.userId === 'allowed';
      call.arguments.id = 'mutated by policy';
      return allowed;
    },
    model: { async generate({ steps }) {
      if (!steps.length) return { toolCalls: [{ id: 'one', name: 'lookup', arguments: '{"id":"DH123"}' }] };
      const { output } = steps[0].outputs[0];
      return { text: output.ok ? output.value : output.error.code };
    } },
  });
  const agent = sdk.createAgent({ systemPrompt: 'Use the lookup tool', tools: [tool] });
  const denied = await agent.run({ sessionId: '1', message: 'Look up order', onEvent(event) {
    events.push(event);
    if (event.type === 'tool.finished') {
      event.tool.status = 'completed';
      throw new Error('observer only');
    }
  } });
  assert.equal(denied.text, 'tool_forbidden');
  assert.equal(denied.trace[0].status, 'error');
  assert.equal(executions, 0);
  assert.deepEqual(events.map(({ type }) => type), [
    'run.queued', 'run.started', 'model.started', 'model.finished', 'tool.started', 'tool.finished',
    'model.started', 'model.finished', 'run.finished',
  ]);
  assert.ok(events.every(({ runId }) => runId === denied.runId));
  assert.equal(events.at(-1).result.trace[0].error.code, 'tool_forbidden');
  assert.equal((await agent.run({ sessionId: '1', context: { userId: 'allowed' }, message: 'Look up order' })).text, 'DH123');
  assert.equal(executions, 1);
});

test('a tool timeout aborts that tool and lets the model finish the run with a structured error', async () => {
  let signal;
  const wait = defineTool({ name: 'lookup', description: 'Look up an order', parameters, timeoutMs: 15, async execute(_, context) {
    signal = context.signal;
    await delay(1000, undefined, { signal });
  } });
  const agent = createSDK({ model: { async generate({ steps }) {
    if (!steps.length) return { toolCalls: [{ id: 'one', name: 'lookup', arguments: '{"id":"1"}' }] };
    return { text: steps[0].outputs[0].output.error.code };
  } } }).createAgent({ systemPrompt: 'Use the lookup tool', tools: [wait] });
  const result = await agent.run({ sessionId: '1', message: 'Look up order' });
  assert.equal(result.status, 'completed');
  assert.equal(result.text, 'tool_timeout');
  assert.equal(result.trace[0].error.code, 'tool_timeout');
  assert.equal(signal.aborted, true);
});
