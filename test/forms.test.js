import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { ToolError, createSDK, defineTool, formAppHtml, mcpAppMimeType } from 'agent-studio-sdk';
import { defineHttpTool } from 'agent-studio-sdk/http-tool';

const parameters = { type: 'object', properties: { date: { type: 'string' } }, additionalProperties: false };
const html = '<form><input name="reason"><button>Gửi</button></form>';
const resolveHtml = '<form><input name="choice"><button>Chọn</button></form>';
const context = { appId: 'app', userId: 'u1' };
/** How the chat receives a form: the tool's HTML wrapped into an MCP App document, with its ui:// URI. */
const app = (source, tool, form, submit = true) => ({ html: formAppHtml(source, { tool, form, submit }), uri: `ui://${tool}/${form}`, mimeType: mcpAppMimeType });

/** A draft shows the confirm form, a conflict shows the resolve form, and plain information shows none. */
const result = {
  type: 'object', required: ['kind'],
  oneOf: [
    { 'x-form': 'confirm', properties: { kind: { const: 'draft' } } },
    { 'x-form': 'resolve', properties: { kind: { const: 'conflict' } } },
    { properties: { kind: { const: 'info' } } },
  ],
};

function proposal({ date }) {
  if (date === '2026-12-01') return { kind: 'conflict', leaveId: 'L0' };
  if (date === '2026-12-02') return { kind: 'info', remaining: 9 };
  return { kind: 'draft', draftId: 'd1', date };
}

/** A model that proposes once per user message, then answers from the tool output. */
function proposingModel(seen = [], date = '2026-11-27') {
  return {
    async generate({ history, steps, tools }) {
      seen.push({ history, tools, steps: JSON.parse(JSON.stringify(steps)) });
      if (!steps.length) return { toolCalls: [{ id: `c${seen.length}`, name: 'propose_leave', arguments: JSON.stringify({ date }) }] };
      return { text: 'Đây là đơn nghỉ, kiểm tra và gửi trong form.' };
    },
  };
}

function leaveTool(submit, form = {}, { resolve = () => ({ resolved: true }), execute = proposal } = {}) {
  return defineTool({
    name: 'propose_leave', description: 'Chuẩn bị đơn nghỉ', parameters, execute, result,
    forms: { confirm: { html, submit, ...form }, resolve: { html: resolveHtml, submit: resolve } },
  });
}

function leaveAgent(tool, model = proposingModel()) {
  return createSDK({ model, tools: [tool] }).createAgent({ systemPrompt: 'Nhân sự', tools: ['propose_leave'] });
}

test('the form named by the matching result branch is returned with the stored turn, and the model learns its name', async () => {
  const seen = [];
  const sdk = createSDK({ model: proposingModel(seen), tools: [leaveTool(() => ({ leaveId: 'L1' }))] });
  const agent = sdk.createAgent({ systemPrompt: 'Nhân sự', tools: ['propose_leave'] });
  const run = await agent.run({ sessionId: 's', context, message: 'Xin nghỉ thứ 6' });

  assert.equal(run.status, 'completed');
  assert.equal(run.forms.length, 1);
  const [form] = run.forms;
  assert.deepEqual({ ...form, id: undefined }, {
    id: undefined, tool: 'propose_leave', form: 'confirm', toolCallId: 'c1', arguments: { date: '2026-11-27' },
    data: { kind: 'draft', draftId: 'd1', date: '2026-11-27' }, status: 'open', ...app(html, 'propose_leave', 'confirm'),
  });
  assert.match(seen[0].tools[0].description, /^Chuẩn bị đơn nghỉ\n\nSome results of this tool show the user a form/);
  assert.deepEqual(seen[1].steps[0].outputs[0].output,
    { ok: true, value: { kind: 'draft', draftId: 'd1', date: '2026-11-27' }, form: 'confirm' });
  assert.deepEqual(agent.listTools()[0].description, 'Chuẩn bị đơn nghỉ');

  const [, reply] = await agent.getHistory({ sessionId: 's', context });
  assert.deepEqual(reply.forms, [form]);
  // html comes from the tool, not from the session store
  assert.equal((await sdk.createAgent({ systemPrompt: 'x', id: agent.id }).getHistory({ sessionId: 's', context }))[1].forms[0].html,
    undefined);
});

test('another result branch shows its own form, and a branch without x-form shows none', async () => {
  const conflict = await leaveAgent(leaveTool(() => null), proposingModel([], '2026-12-01'))
    .run({ sessionId: 's', context, message: 'nghỉ 1/12' });
  assert.deepEqual(conflict.forms.map(({ form, html: shown, data }) => ({ form, html: shown, data })),
    [{ form: 'resolve', html: app(resolveHtml, 'propose_leave', 'resolve').html, data: { kind: 'conflict', leaveId: 'L0' } }]);

  const seen = [];
  const info = await leaveAgent(leaveTool(() => null), proposingModel(seen, '2026-12-02'))
    .run({ sessionId: 's', context, message: 'còn mấy ngày phép?' });
  assert.equal(info.status, 'completed');
  assert.equal(info.forms, undefined);
  assert.deepEqual(seen[1].steps[0].outputs[0].output, { ok: true, value: { kind: 'info', remaining: 9 } });
});

test('a result that does not match the result schema fails the call and shows no form', async () => {
  const tool = leaveTool(() => null, {}, { execute: () => ({ kind: 'unknown' }) });
  const seen = [];
  const run = await leaveAgent(tool, proposingModel(seen)).run({ sessionId: 's', context, message: 'nghỉ' });
  assert.equal(run.forms, undefined);
  assert.equal(run.trace[0].error.code, 'invalid_result');
  assert.equal(seen[1].steps[0].outputs[0].output.error.code, 'invalid_result');
});

test('submitForm runs the submit of the shown form once with the values, the shown data and the run context', async () => {
  const submitted = [];
  const seen = [];
  const tool = leaveTool((values, formContext) => {
    submitted.push({ values, data: formContext.data, userId: formContext.userId, formId: formContext.formId,
      form: formContext.form, toolCallId: formContext.toolCallId, sessionId: formContext.sessionId });
    return { leaveId: 'L1' };
  }, { schema: { type: 'object', required: ['reason'], properties: { reason: { type: 'string', minLength: 2 } } } },
  { resolve: () => assert.fail('the resolve form was not shown') });
  const agent = leaveAgent(tool, proposingModel(seen));
  const { forms: [form] } = await agent.run({ sessionId: 's', context, message: 'Xin nghỉ thứ 6' });

  const invalid = await agent.submitForm({ sessionId: 's', context, formId: form.id, values: { reason: '' } });
  assert.equal(invalid.status, 'error');
  assert.equal(invalid.error.code, 'invalid_values');
  assert.equal(invalid.form.status, 'open');
  assert.equal((await agent.submitForm({ sessionId: 's', context, formId: form.id, values: [] })).error.code, 'invalid_values');

  const wrongUser = await agent.submitForm({ sessionId: 's', context: { ...context, userId: 'u2' }, formId: form.id, values: { reason: 'ốm' } });
  assert.equal(wrongUser.error.code, 'form_not_found');

  const done = await agent.submitForm({ sessionId: 's', context, formId: form.id, values: { reason: 'Việc nhà' } });
  const { html: _html, uri: _uri, mimeType: _mimeType, ...stored } = form;
  assert.deepEqual(done, { status: 'submitted', formId: form.id, value: { leaveId: 'L1' },
    form: { ...stored, status: 'submitted', result: { leaveId: 'L1' } } });
  assert.deepEqual(submitted, [{ values: { reason: 'Việc nhà' }, data: { kind: 'draft', draftId: 'd1', date: '2026-11-27' },
    userId: 'u1', formId: form.id, form: 'confirm', toolCallId: 'c1', sessionId: 's' }]);

  const again = await agent.submitForm({ sessionId: 's', context, formId: form.id, values: { reason: 'Việc nhà' } });
  assert.equal(again.error.code, 'form_closed');
  assert.equal(submitted.length, 1);

  await agent.run({ sessionId: 's', context, message: 'Xong chưa?' });
  const lastHistory = seen.at(-1).history;
  assert.equal(lastHistory[1].role, 'assistant');
  assert.match(lastHistory[1].content, /\n\[Form "confirm" of propose_leave: the user submitted it\. Result: \{"leaveId":"L1"\}\]$/);
});

test('a form the tool no longer has cannot be submitted and has no html', async () => {
  const agent = leaveAgent(leaveTool(() => assert.fail('the old form must not run')));
  const { forms: [form] } = await agent.run({ sessionId: 's', context, message: 'nghỉ' });
  agent.updateTool('propose_leave', defineTool({ name: 'propose_leave', description: 'x', parameters, execute: proposal,
    result: { type: 'object', 'x-form': 'other' }, forms: { other: { html, submit: () => null } } }));
  const missing = await agent.submitForm({ sessionId: 's', context, formId: form.id, values: {} });
  assert.deepEqual([missing.error.code, missing.form.status], ['unknown_form', 'open']);
  assert.equal((await agent.getHistory({ sessionId: 's', context }))[1].forms[0].html, undefined);
});

test('a ToolError keeps the form open to send again; an unknown outcome closes it as failed', async () => {
  let attempts = 0;
  const tool = leaveTool(() => {
    attempts += 1;
    if (attempts === 1) throw new ToolError('conflict', 'Ngày này đã có đơn.');
    throw new Error('database down');
  });
  const agent = leaveAgent(tool);
  const { forms: [form] } = await agent.run({ sessionId: 's', context, message: 'nghỉ' });

  const rejected = await agent.submitForm({ sessionId: 's', context, formId: form.id, values: {} });
  assert.deepEqual([rejected.status, rejected.error.code, rejected.form.status], ['error', 'conflict', 'open']);
  const failed = await agent.submitForm({ sessionId: 's', context, formId: form.id, values: {} });
  assert.deepEqual([failed.error.code, failed.form.status], ['tool_failed', 'failed']);
  assert.equal((await agent.submitForm({ sessionId: 's', context, formId: form.id, values: {} })).error.code, 'form_closed');
  assert.equal(attempts, 2);
});

test('a submit that runs past its time limit closes the form', async () => {
  const agent = leaveAgent(leaveTool(() => delay(200), { timeoutMs: 20 }));
  const { forms: [form] } = await agent.run({ sessionId: 's', context, message: 'nghỉ' });
  const timedOut = await agent.submitForm({ sessionId: 's', context, formId: form.id, values: {} });
  assert.deepEqual([timedOut.error.code, timedOut.form.status], ['tool_timeout', 'failed']);
});

test('a form without submit only shows the result: it is shown once, the model is told not to repeat it, and it cannot be submitted', async () => {
  const tableHtml = '<table><tbody id="rows"></tbody></table>';
  let rows = [{ date: '2026-11-26', status: 'PENDING' }, { date: '2026-11-11', status: 'APPROVED' }];
  const seen = [];
  const model = {
    async generate({ history, steps, tools }) {
      seen.push({ history, tools, steps: JSON.parse(JSON.stringify(steps)) });
      if (!steps.length) return { toolCalls: [{ id: `c${seen.length}`, name: 'list_requests', arguments: '{}' }] };
      return { text: 'Có 1 đơn chờ duyệt, chi tiết trong bảng.' };
    },
  };
  const tool = defineTool({
    name: 'list_requests', description: 'Liệt kê đơn', parameters: { type: 'object', properties: {} }, execute: () => rows,
    // A list with rows shows the table; an empty list shows nothing
    result: { anyOf: [{ 'x-form': 'table', type: 'array', minItems: 1 }, { type: 'array' }] },
    forms: { table: { html: tableHtml } },
  });
  const agent = createSDK({ model, tools: [tool] }).createAgent({ systemPrompt: 'Nhân sự', tools: ['list_requests'] });
  const run = await agent.run({ sessionId: 's', context, message: 'Đơn của tôi' });

  assert.equal(run.status, 'completed');
  const [form] = run.forms;
  assert.deepEqual({ ...form, id: undefined },
    { id: undefined, tool: 'list_requests', form: 'table', toolCallId: 'c1', arguments: {}, data: rows, status: 'shown',
      ...app(tableHtml, 'list_requests', 'table', false) });
  const { description } = seen[0].tools[0];
  assert.match(description, /^Liệt kê đơn\n\nSome results of this tool are also shown to the user in the chat/);
  assert.doesNotMatch(description, /show the user a form/);
  assert.deepEqual(seen[1].steps[0].outputs[0].output, { ok: true, value: rows, form: 'table' });

  const closed = await agent.submitForm({ sessionId: 's', context, formId: form.id, values: {} });
  assert.deepEqual([closed.status, closed.error.code, closed.form.status], ['error', 'form_closed', 'shown']);
  const [, reply] = await agent.getHistory({ sessionId: 's', context });
  assert.deepEqual(reply.forms, [form]);

  rows = [];
  const empty = await agent.run({ sessionId: 's', context, message: 'Còn đơn nào không?' });
  assert.equal(empty.forms, undefined);
  assert.match(seen.at(-1).history[1].content,
    /\n\[Form "table" of list_requests: the result was shown to the user in the chat; there is nothing to submit\]$/);
});

test('a tool with a form to submit and a form that only shows the result gets both notes', async () => {
  const seen = [];
  const tool = defineTool({
    name: 'propose_leave', description: 'Chuẩn bị đơn nghỉ', parameters, execute: proposal,
    result: { type: 'object', required: ['kind'], oneOf: [
      { 'x-form': 'confirm', properties: { kind: { const: 'draft' } } },
      { 'x-form': 'summary', properties: { kind: { const: 'info' } } },
      { properties: { kind: { const: 'conflict' } } },
    ] },
    forms: { confirm: { html, submit: () => null }, summary: { html: '<p data-field="remaining"></p>' } },
  });
  const run = await leaveAgent(tool, proposingModel(seen, '2026-12-02')).run({ sessionId: 's', context, message: 'còn mấy ngày phép?' });
  assert.deepEqual(run.forms.map(({ form, status }) => [form, status]), [['summary', 'shown']]);
  assert.match(seen[0].tools[0].description, /\n\nSome results of this tool show the user a form.*\n\nSome results of this tool are also shown/s);
});

test('forms are not offered for an application-managed history, and failed tools show no form', async () => {
  const seen = [];
  const agent = leaveAgent(leaveTool(() => null), proposingModel(seen));
  const given = await agent.run({ sessionId: 's', context, message: 'nghỉ', history: [] });
  assert.equal(given.forms, undefined);
  assert.equal(seen[0].tools[0].description, 'Chuẩn bị đơn nghỉ');
  assert.equal(seen[1].steps[0].outputs[0].output.form, undefined);

  const failing = leaveTool(() => null, {}, { execute() { throw new ToolError('forbidden', 'Không có quyền.'); } });
  assert.equal((await leaveAgent(failing).run({ sessionId: 's', context, message: 'nghỉ' })).forms, undefined);
});

test('defineTool rejects invalid forms and x-form keywords it would not read', () => {
  const base = { name: 't', description: 'd', parameters, execute: () => null, result: { type: 'object', 'x-form': 'a' } };
  for (const form of [{ submit: () => null }, { html: '', submit: () => null }, { html: 'x'.repeat(64_001), submit: () => null },
    { html, submit: 'https://hr.example.test' }, { html, submit: () => null, schema: { type: 'string' } },
    { html, submit: () => null, timeoutMs: 0 }, { html, schema: { type: 'object' } }, { html, timeoutMs: 1_000 },
    { html, mcpApp: true, submit: () => null }, { html, mcpApp: 'yes' }, { html: 'x'.repeat(1_000_001), mcpApp: true }]) {
    assert.throws(() => defineTool({ ...base, forms: { a: form } }), TypeError, JSON.stringify(form));
  }
  // Without submit a form only shows the result
  assert.deepEqual({ ...defineTool({ ...base, forms: { a: { html } } }).forms.a }, { html });
  const a = { html, submit: () => null };
  const invalid = [
    { forms: { 'bad name': a }, result: { type: 'object', 'x-form': 'bad name' } },
    { forms: [a] },
    { forms: { a }, result: { type: 'object', 'x-form': 'missing' } },
    { forms: { a }, result: { type: 'object', 'x-form': 1 } },
    { forms: { a, b: a } },
    { forms: { a }, result: undefined },
    { forms: { a }, result: { type: 'object', properties: { draft: { type: 'object', 'x-form': 'a' } } } },
    { forms: { a }, result: { 'x-form': 'a', oneOf: [{ type: 'object' }, { type: 'array' }] } },
    { forms: { a }, result: { oneOf: [{ 'x-form': 'a', oneOf: [{ 'x-form': 'a' }] }] } },
    { forms: { a }, result: { type: 'object', 'x-form': 'a', properties: { x: { type: 'nope' } } } },
    { forms: { a }, result: 'object' },
  ];
  for (const change of invalid) assert.throws(() => defineTool({ ...base, ...change }), TypeError, JSON.stringify(change));
  assert.throws(() => defineTool({ ...base, forms: { a }, form: a }), /replaced by forms/);

  const tool = defineTool({ ...base, forms: { a } });
  assert.equal(Object.isFrozen(tool.forms), true);
  assert.equal(Object.isFrozen(tool.forms.a), true);
  // A property called x-form, an example holding one and an anyOf branch are not misread.
  defineTool({ ...base, forms: { a }, result: { type: 'object', properties: { 'x-form': { type: 'string' } },
    anyOf: [{ 'x-form': 'a', required: ['x-form'], examples: [{ 'x-form': 'b' }] }, { required: ['other'] }] } });
  defineTool({ ...base, result: { type: 'object' } });
});

test('an HTTP tool form posts its name, the values and the shown data, and sends the tool key only to the same service', async () => {
  const requests = [];
  const fetch = async (url, init) => {
    requests.push({ url: String(url), method: init.method, headers: Object.fromEntries(new Headers(init.headers)),
      body: init.body && JSON.parse(init.body) });
    return url.pathname.endsWith('/confirm') ? Response.json({ leaveId: 'L9' }) : Response.json({ draftId: 'd9' });
  };
  for (const [submitUrl, keySent] of [['https://hr.example.test/leave/confirm', true], ['https://other.example.test/confirm', false]]) {
    requests.length = 0;
    const tool = defineHttpTool({
      name: 'propose_leave', description: 'Chuẩn bị đơn nghỉ', parameters, method: 'POST', url: 'https://hr.example.test/leave/propose',
      apiKey: () => 'secret-key', fetch, result: { type: 'object', 'x-form': 'confirm' }, forms: { confirm: { html, submit: { url: submitUrl } } },
    });
    const agent = leaveAgent(tool);
    const { forms: [form] } = await agent.run({ sessionId: 's', context, message: 'nghỉ' });
    assert.deepEqual([form.form, form.data], ['confirm', { draftId: 'd9' }]);
    const done = await agent.submitForm({ sessionId: 's', context, formId: form.id, values: { reason: 'Việc nhà' } });
    assert.deepEqual(done.value, { leaveId: 'L9' });
    const confirm = requests[1];
    assert.equal(confirm.url, submitUrl);
    assert.equal(confirm.method, 'POST');
    assert.deepEqual(confirm.body, { formId: form.id, form: 'confirm', values: { reason: 'Việc nhà' }, data: { draftId: 'd9' } });
    assert.equal(confirm.headers['idempotency-key'], form.id);
    assert.equal(confirm.headers.authorization, keySent ? 'Bearer secret-key' : undefined);
  }
  const withForm = (submit) => defineHttpTool({ name: 'p', description: 'd', parameters, method: 'POST', url: 'https://a.test/x',
    result: { type: 'object', 'x-form': 'f' }, forms: { f: { html, submit } } });
  assert.throws(() => withForm({ url: 'ftp://a.test/x' }), TypeError);
  assert.throws(() => withForm({ url: 'https://a.test/x', method: 'GET' }), TypeError);
  assert.deepEqual({ ...withForm(undefined).forms.f }, { html });

  // Without submit the form only shows the result, and submitting it posts nothing
  requests.length = 0;
  const viewAgent = leaveAgent(defineHttpTool({
    name: 'propose_leave', description: 'Chuẩn bị đơn nghỉ', parameters, method: 'POST', url: 'https://hr.example.test/leave/propose',
    fetch, result: { type: 'object', 'x-form': 'confirm' }, forms: { confirm: { html } },
  }));
  const { forms: [shown] } = await viewAgent.run({ sessionId: 's', context, message: 'nghỉ' });
  assert.deepEqual([shown.status, shown.data], ['shown', { draftId: 'd9' }]);
  const closed = await viewAgent.submitForm({ sessionId: 's', context, formId: shown.id, values: {} });
  assert.equal(closed.error.code, 'form_closed');
  assert.equal(requests.length, 1);
});

test('an HTTP 409 from the form service keeps the form open with the mapped error', async () => {
  const tool = defineHttpTool({
    name: 'propose_leave', description: 'd', parameters, method: 'POST', url: 'https://hr.example.test/propose',
    fetch: async (url) => url.pathname === '/confirm' ? new Response('dup', { status: 409 }) : Response.json({ draftId: 'd' }),
    result: { type: 'object', 'x-form': 'confirm' }, forms: { confirm: { html, submit: { url: 'https://hr.example.test/confirm' } } },
  });
  const agent = leaveAgent(tool);
  const { forms: [form] } = await agent.run({ sessionId: 's', context, message: 'nghỉ' });
  const outcome = await agent.submitForm({ sessionId: 's', context, formId: form.id, values: {} });
  assert.deepEqual([outcome.error.code, outcome.form.status], ['conflict', 'open']);
});

test('a form is an MCP App document; an mcpApp form is shown as the tool wrote it', async () => {
  // The form HTML sits in a script element of the document, so it cannot close that element early.
  const document = formAppHtml('<p>a</p></script><script>alert(1)</script>', { tool: 't', form: 'f', submit: false });
  assert.equal(document.match(/<\/script>/g).length, 1);
  assert.match(document, /^<!doctype html>/);
  assert.match(document, /'ui\/initialize'/);

  const appHtml = `<!doctype html><html><body>${'x'.repeat(100_000)}</body></html>`;
  const tool = defineTool({
    name: 'show_chart', description: 'Biểu đồ', parameters, execute: () => ({ points: [1, 2] }),
    result: { type: 'object', 'x-form': 'chart' }, forms: { chart: { html: appHtml, mcpApp: true } },
  });
  assert.deepEqual({ ...tool.forms.chart }, { html: appHtml, mcpApp: true });
  const model = {
    async generate({ steps }) {
      return steps.length ? { text: 'Đây là biểu đồ.' } : { toolCalls: [{ id: 'c1', name: 'show_chart', arguments: '{"date":"2026-11-27"}' }] };
    },
  };
  const run = await createSDK({ model, tools: [tool] }).createAgent({ systemPrompt: 'x', tools: ['show_chart'] })
    .run({ sessionId: 's', context, message: 'Vẽ biểu đồ' });
  const [form] = run.forms;
  assert.deepEqual([form.status, form.html, form.uri, form.mimeType, form.arguments],
    ['shown', appHtml, 'ui://show_chart/chart', mcpAppMimeType, { date: '2026-11-27' }]);
});
