import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, rmdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { formAppHtml, mcpAppMimeType } from 'agent-studio-sdk';
import { startStudio } from '../studio/server.js';

test('Studio saves an agent, lets another app run it by ID, and restores configuration and chat on restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-studio-test-'));
  const dataPath = join(directory, 'workspace.json');
  const close = (server) => new Promise((done, reject) => server.close((error) => error ? reject(error) : done()));
  const start = () => startStudio({ port: 0, dataPath, apiKey: '', model: '' });
  let server;
  let base;
  const post = (path, payload) => fetch(`${base}${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
  });

  try {
    server = await start();
    base = `http://127.0.0.1:${server.address().port}`;
    assert.match(await (await fetch(base)).text(), /System prompt/);
    const workspace = await (await fetch(`${base}/api/workspace`)).json();
    assert.equal(workspace.openAI, null);
    const profile = { ...workspace.profiles[0], id: 'new-agent', name: 'My agent' };
    assert.equal((await post('/api/profiles', { ...profile, tools: ['missing'] })).status, 400);
    assert.equal((await post('/api/profiles', profile)).status, 200);

    const payload = { mode: 'demo', sessionId: 'test-session', message: 'Đơn DH123 đang ở đâu?' };
    const response = await post('/api/agents/new-agent/run', { ...payload, appId: 'checkout' });
    const result = await response.json();
    assert.equal(result.status, 'completed');
    assert.match(result.text, /Đang giao/);
    assert.equal(result.trace[0].name, 'get_order_status');
    const openedElsewhere = await post('/api/agents/new-agent/run', {
      ...payload, appId: 'helpdesk', message: 'Khi nào giao đơn đó?',
    });
    assert.match((await openedElsewhere.json()).text, /mã đơn hàng/);

    const draft = await post('/api/run', { ...payload, profile: { ...profile, tools: [] } });
    assert.match((await draft.json()).text, /bật tool/);
    const crossOrigin = await fetch(`${base}/api/workspace`, { headers: { Origin: 'https://example.org' } });
    assert.equal(crossOrigin.status, 403);

    await close(server);
    server = await start();
    base = `http://127.0.0.1:${server.address().port}`;
    const persisted = await (await fetch(`${base}/api/workspace`)).json();
    assert.deepEqual(persisted.profiles.at(-1), profile);
    const chat = await (await fetch(`${base}/api/history?agentId=new-agent&mode=demo&sessionId=test-session`)).json();
    assert.equal(chat.messages.length, 2);
    assert.match(chat.messages[1].content, /bật tool/);
    const followUp = await post('/api/agents/new-agent/run', { ...payload, appId: 'checkout', message: 'Khi nào giao đơn đó?' });
    assert.match((await followUp.json()).text, /17:00/);
  } finally {
    if (server?.listening) await close(server);
    await rm(dataPath, { force: true });
    await rmdir(directory);
  }
});

test('Studio persists isolated tool edits and sends each agent’s reasoning setting to its local model', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-studio-test-'));
  const dataPath = join(directory, 'workspace.json');
  const requests = [];
  const toolCalls = [];
  const fixture = createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json');
    const url = new URL(request.url, 'http://127.0.0.1');
    if (url.pathname === '/api/chat') {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      requests.push(body);
      const result = body.messages.at(-1);
      if (result.role === 'tool') {
        response.end(JSON.stringify({ message: { content: JSON.parse(result.content).value.status } }));
      } else if (body.tools?.length) {
        response.end(JSON.stringify({ message: { content: '', thinking: 'private stub', tool_calls: [
          { function: { name: body.tools[0].function.name, arguments: { id: 'DH123' } } },
        ] } }));
      } else {
        response.end(JSON.stringify({ message: { content: 'No tools.' } }));
      }
      return;
    }
    toolCalls.push({ path: url.pathname, id: url.searchParams.get('id'), authorization: request.headers.authorization });
    response.end(JSON.stringify({ status: 'Order data from custom HTTP tool' }));
  });
  const listen = (server) => new Promise((done) => server.listen(0, '127.0.0.1', done));
  const close = (server) => new Promise((done) => server.close(done));
  await listen(fixture);
  t.after(async () => {
    await close(fixture);
    await rm(dataPath, { force: true });
    await rmdir(directory);
  });
  const local = `http://127.0.0.1:${fixture.address().port}`;
  const server = await startStudio({ port: 0, dataPath, environment: { ORDER_TEST_KEY: 'test-secret' } });
  t.after(() => close(server));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = async (path, body) => {
    const response = await fetch(`${base}${path}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    return { status: response.status, result: await response.json() };
  };

  const custom = {
    kind: 'http', name: 'lookup_order', label: 'Xem đơn', description: 'Fetch the order status',
    method: 'GET', url: `${local}/v1/order`, apiKeyEnv: 'ORDER_TEST_KEY',
    parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false },
  };
  const config = { id: 'agent-a', name: 'Agent A', systemPrompt: 'Use the order tool', tools: [custom],
    model: { provider: 'ollama', model: 'gpt-oss:20b', baseUrl: local, reasoningEffort: 'high' } };
  const run = (id) => post(`/api/agents/${id}/run`, { appId: 'integration', sessionId: 'test', message: 'Look up order' });
  assert.equal((await post('/api/profiles', config)).status, 200);
  assert.equal((await post('/api/profiles', { ...config, id: 'agent-b', model: { ...config.model, reasoningEffort: 'low' } })).status, 200);
  assert.equal((await run('agent-a')).result.text, 'Order data from custom HTTP tool');
  assert.equal(requests[0].think, 'high');
  assert.equal(requests[1].messages.at(-2).thinking, 'private stub');
  assert.equal(requests[1].messages.at(-1).tool_name, 'lookup_order');
  assert.deepEqual(toolCalls[0], { path: '/v1/order', id: 'DH123', authorization: 'Bearer test-secret' });

  assert.equal((await post('/api/profiles', { ...config, tools: [{ ...custom, url: `${local}/v2/order` }] })).status, 200);
  assert.equal((await run('agent-a')).result.status, 'completed');
  assert.equal(toolCalls.at(-1).path, '/v2/order');
  assert.equal((await post('/api/profiles', { ...config, tools: [] })).status, 200);
  assert.equal((await run('agent-a')).result.text, 'No tools.');
  assert.equal((await run('agent-b')).result.status, 'completed');
  assert.equal(requests.at(-1).think, 'low');
  assert.equal(toolCalls.at(-1).path, '/v1/order');
  const workspace = await readFile(dataPath, 'utf8');
  assert.ok(!workspace.includes('test-secret'));
  assert.ok(!workspace.includes('private stub'));
});

test('HTTP tool forms named by its result schema are saved with the agent, shown in the run and history, and submitted once', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-studio-test-'));
  const dataPath = join(directory, 'workspace.json');
  const models = [];
  const calls = [];
  const fixture = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : undefined;
    response.setHeader('Content-Type', 'application/json');
    if (request.url === '/api/chat') {
      models.push(body);
      const message = body.messages.at(-1).role === 'tool' ? { content: 'Kiểm tra đơn trong form.' }
        : { tool_calls: [{ function: { name: 'propose_leave', arguments: { date: '2026-11-27' } } }] };
      return response.end(JSON.stringify({ message }));
    }
    calls.push({ path: request.url, method: request.method, authorization: request.headers.authorization,
      idempotencyKey: request.headers['idempotency-key'], body });
    response.end(JSON.stringify(request.url === '/confirm' ? { leaveId: 'L1' } : { draftId: 'D1' }));
  });
  await new Promise((done) => fixture.listen(0, '127.0.0.1', done));
  t.after(async () => {
    await new Promise((done) => fixture.close(done));
    await rm(dataPath, { force: true });
    await rmdir(directory);
  });
  const local = `http://127.0.0.1:${fixture.address().port}`;
  const server = await startStudio({ port: 0, dataPath, environment: { HR_TEST_KEY: 'hr-secret' } });
  t.after(() => { server.closeAllConnections(); return new Promise((done) => server.close(done)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = async (path, body) => {
    const response = await fetch(`${base}${path}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    return { status: response.status, result: await response.json() };
  };

  const html = '<form><input name="reason"><button>Gửi</button></form>';
  const form = { html, submit: { method: 'POST', url: `${local}/confirm` } };
  // A draft shows the confirm form; a note (another branch) would show none.
  const result = { type: 'object', oneOf: [{ 'x-form': 'confirm', required: ['draftId'] }, { required: ['note'] }] };
  const tool = {
    kind: 'http', name: 'propose_leave', label: 'Đề xuất nghỉ', description: 'Prepare a leave request', method: 'POST',
    url: `${local}/propose`, apiKeyEnv: 'HR_TEST_KEY', result, forms: { confirm: form },
    parameters: { type: 'object', properties: { date: { type: 'string' } }, required: ['date'] },
  };
  const config = { id: 'agent-a', name: 'Agent A', systemPrompt: 'Prepare leave requests', tools: [tool],
    model: { provider: 'ollama', model: 'stub', baseUrl: local } };

  const rejected = async (change) => {
    const response = await post('/api/profiles', { ...config, tools: [{ ...tool, ...change }] });
    assert.equal(response.status, 400);
    return response.result.error;
  };
  for (const invalid of [{ ...form, html: ' ' }, { ...form, html: 'x'.repeat(64_001) }, { ...form, submit: { url: form.submit.url, method: 'GET' } },
    { ...form, submit: { url: 'ftp://127.0.0.1/confirm' } }, 'form']) {
    await rejected({ forms: { confirm: invalid } });
  }
  await rejected({ forms: 'confirm' });
  await rejected({ result: [] });
  await rejected({ forms: { 'bad name': form }, result: { type: 'object', 'x-form': 'bad name' } });
  assert.match(await rejected({ forms: undefined, form }), /còn dùng một form cố định/);
  assert.match(await rejected({ forms: { confirm: form, extra: form } }), /Schema kết quả chưa có x-form nào gọi form extra.$/);
  assert.match(await rejected({ result: { type: 'object', 'x-form': 'other' } }), /gọi form "other" nhưng tool chưa có form tên này.$/);
  assert.match(await rejected({ result: { ...result, 'x-form': 'confirm' } }), /x-form phải đặt trên từng nhánh/);
  assert.match(await rejected({ result: { type: 'object', properties: { d: { type: 'object', 'x-form': 'confirm' } } } }),
    /x-form chỉ được đặt ở gốc schema kết quả/);
  // A profile with the form HTML of several tools is larger than other requests.
  const large = { html: `<form>${'x'.repeat(40_000)}</form>`, submit: form.submit };
  assert.equal((await post('/api/profiles', { ...config, id: 'agent-large',
    tools: [{ ...tool, forms: { confirm: large } }, { ...tool, name: 'second_form', forms: { confirm: large } }] })).status, 200);
  // A form without an endpoint only shows the result
  for (const view of [{ html }, { html, submit: null }, { html, submit: { url: ' ' } }]) {
    const shownOnly = await post('/api/profiles', { ...config, id: 'agent-view', tools: [{ ...tool, forms: { confirm: view } }] });
    assert.equal(shownOnly.status, 200, JSON.stringify(view));
    assert.deepEqual(shownOnly.result.tools[0].forms, { confirm: { html } });
  }
  assert.match(await rejected({ forms: { confirm: { html, submit: `${local}/confirm` } } }), /Nơi nhận form confirm không hợp lệ/);
  const saved = await post('/api/profiles', config);
  assert.equal(saved.status, 200);
  assert.deepEqual([saved.result.tools[0].forms, saved.result.tools[0].result], [{ confirm: form }, result]);

  const frame = await fetch(`${base}/form-frame.html`);
  assert.equal(frame.status, 200);
  assert.match(frame.headers.get('content-security-policy'),
    /^default-src 'none'; script-src 'unsafe-inline';.*frame-ancestors 'self'; sandbox allow-scripts allow-forms$/);
  assert.match(await frame.text(), /'ui.notifications.sandbox-proxy-ready'/);

  const run = await post('/api/run', { profile: config, sessionId: 's1', message: 'Xin nghỉ thứ 6' });
  assert.equal(run.result.status, 'completed');
  const [shown] = run.result.forms;
  assert.deepEqual({ ...shown, id: undefined, toolCallId: undefined },
    { id: undefined, toolCallId: undefined, tool: 'propose_leave', form: 'confirm', arguments: { date: '2026-11-27' }, data: { draftId: 'D1' },
      status: 'open', html: formAppHtml(html, { tool: 'propose_leave', form: 'confirm', submit: true }), uri: 'ui://propose_leave/confirm', mimeType: mcpAppMimeType });
  assert.match(models[0].tools[0].function.description, /^Prepare a leave request\n\nSome results of this tool show the user a form/);
  assert.deepEqual(JSON.parse(models[1].messages.at(-1).content), { ok: true, value: { draftId: 'D1' }, form: 'confirm' });
  const history = await (await fetch(`${base}/api/history?agentId=agent-a&mode=ollama&sessionId=s1`)).json();
  assert.deepEqual(history.messages[1].forms, [shown]);

  const submit = (values, extra = {}) => post('/api/forms/submit', { profile: config, sessionId: 's1', formId: shown.id, values, ...extra });
  assert.equal((await submit([])).status, 400);
  const done = await submit({ reason: 'Việc nhà' });
  assert.equal(done.status, 200);
  assert.deepEqual([done.result.status, done.result.value, done.result.form.status], ['submitted', { leaveId: 'L1' }, 'submitted']);
  assert.deepEqual(calls.at(-1), { path: '/confirm', method: 'POST', authorization: 'Bearer hr-secret', idempotencyKey: shown.id,
    body: { formId: shown.id, form: 'confirm', values: { reason: 'Việc nhà' }, data: { draftId: 'D1' } } });
  assert.equal((await submit({ reason: 'Việc nhà' })).result.error.code, 'form_closed');
  assert.equal(calls.filter(({ path }) => path === '/confirm').length, 1);
  await post('/api/run', { profile: config, sessionId: 's1', message: 'Xong chưa?' });
  assert.ok(models.at(-1).messages.some(({ content }) => /\[Form "confirm" of propose_leave: the user submitted it\. Result: \{"leaveId":"L1"\}\]/.test(content)));

  // Another app sees only the forms of its own sessions.
  const app = await post('/api/agents/agent-a/run', { appId: 'hr', sessionId: 's2', message: 'Xin nghỉ' });
  const formId = app.result.forms[0].id;
  const appSubmit = (appId) => post('/api/agents/agent-a/forms/submit', { appId, sessionId: 's2', formId, values: { reason: 'Ốm' } });
  assert.equal((await appSubmit('other')).result.error.code, 'form_not_found');
  assert.equal((await appSubmit('hr')).result.status, 'submitted');
});

test('streams progress and cancels an in-flight HTTP tool, reporting the final outcome to the same client', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-studio-test-'));
  const dataPath = join(directory, 'workspace.json');
  let started;
  let disconnected;
  const toolStarted = new Promise((ready) => { started = ready; });
  const toolDisconnected = new Promise((ready) => { disconnected = ready; });
  const fixture = createServer(async (request, response) => {
    if (request.url === '/api/chat') {
      for await (const _ of request) { /* drain the body */ }
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ message: { tool_calls: [{ function: { name: 'wait', arguments: {} } }] } }));
    } else {
      response.once('close', disconnected);
      started();
    }
  });
  await new Promise((done) => fixture.listen(0, '127.0.0.1', done));
  t.after(async () => {
    fixture.closeAllConnections();
    await new Promise((done) => fixture.close(done));
    await rm(dataPath, { force: true });
    await rmdir(directory);
  });
  const local = `http://127.0.0.1:${fixture.address().port}`;
  const server = await startStudio({ port: 0, dataPath, environment: {} });
  t.after(() => { server.closeAllConnections(); return new Promise((done) => server.close(done)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (path, body, headers) => fetch(`${base}${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
  });
  const profile = {
    id: 'agent-a', name: 'Agent A', systemPrompt: 'Wait for the result',
    model: { provider: 'ollama', model: 'stub', baseUrl: local },
    execution: { maxSteps: 3, maxToolCalls: 1, timeoutMs: 5_000 },
    tools: [{ kind: 'http', name: 'wait', label: 'Wait', description: 'Await a result', url: `${local}/wait`,
      method: 'GET', parameters: { type: 'object', properties: {} } }],
  };
  const saved = await post('/api/profiles', profile);
  assert.deepEqual((await saved.json()).execution, profile.execution);
  const body = { appId: 'integration', sessionId: 'session-1', message: 'Wait', requestId: 'request-1' };
  const response = await post('/api/agents/agent-a/run', body, { Accept: 'application/x-ndjson' });
  assert.match(response.headers.get('Content-Type'), /application\/x-ndjson/);
  const reader = response.body.getReader();
  const first = Buffer.from((await reader.read()).value).toString();
  assert.match(first, /"type":"run\.queued"/);
  await toolStarted;
  assert.equal((await post('/api/agents/agent-a/run', body)).status, 409);
  assert.equal((await fetch(`${base}/api/profiles/agent-a`, { method: 'DELETE' })).status, 409);
  assert.equal((await post('/api/run/cancel', { requestId: body.requestId })).status, 200);
  let transcript = first;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    transcript += Buffer.from(value).toString();
  }
  await toolDisconnected;
  const events = transcript.trim().split('\n').map(JSON.parse);
  const final = events.at(-1);
  assert.equal(events.find(({ type }) => type === 'tool.started').name, 'wait');
  assert.equal(final.type, 'run.finished');
  assert.equal(final.result.status, 'cancelled');
  assert.equal(final.result.trace[0].error.code, 'tool_cancelled');
  assert.equal((await post('/api/run/cancel', { requestId: body.requestId })).status, 404);
});

test('Studio pauses a tool for approval, continues the turn only for the app that started it, and takes files without a caption', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-studio-test-'));
  const dataPath = join(directory, 'workspace.json');
  const server = await startStudio({ port: 0, dataPath, apiKey: '', model: '' });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = async (path, payload) => {
    const response = await fetch(`${base}${path}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    });
    return { status: response.status, body: await response.json() };
  };
  const history = async (sessionId) =>
    (await fetch(`${base}/api/history?agentId=approval-agent&mode=demo&sessionId=${sessionId}`)).json();
  try {
    const workspace = await (await fetch(`${base}/api/workspace`)).json();
    const profile = { ...workspace.profiles[0], id: 'approval-agent', name: 'Approval agent', tools: ['get_order_status', 'cancel_order'] };
    assert.equal((await post('/api/profiles', profile)).status, 200);

    // A draft run in the editor: the turn waits for the user, then runs the tool once it is approved.
    const draft = { mode: 'demo', profile, credentialChanges: {} };
    const paused = (await post('/api/run', { ...draft, sessionId: 'approve', message: 'Hủy đơn DH123' })).body;
    assert.equal(paused.status, 'interrupted');
    const [approval] = paused.interruptions;
    assert.deepEqual([approval.tool, approval.arguments], ['cancel_order', { orderId: 'DH123' }]);
    assert.deepEqual((await history('approve')).messages.at(-1).approvals.map(({ status }) => status), ['pending']);
    assert.equal((await post('/api/run/resume', { ...draft, sessionId: 'approve', approvals: [{ id: approval.id }] })).status, 400);
    const decision = { ...draft, sessionId: 'approve', approvals: [{ id: approval.id, approved: true }] };
    const approved = (await post('/api/run/resume', decision)).body;
    assert.equal(approved.status, 'completed');
    assert.match(approved.text, /Đã hủy đơn DH123/);
    assert.equal(approved.trace[0].name, 'cancel_order');
    assert.equal((await post('/api/run/resume', decision)).body.error.code, 'approval_not_found');
    const closed = (await history('approve')).messages;
    assert.deepEqual(closed.at(-1).approvals.map(({ status }) => status), ['approved']);
    assert.ok(closed.every(({ approvals }) => !approvals || approvals.every(({ status }) => status !== 'pending')));

    // A saved agent called by another app: only the app that started the turn can answer it.
    const saved = { mode: 'demo', sessionId: 'deny' };
    const waiting = (await post('/api/agents/approval-agent/run', { ...saved, appId: 'checkout', message: 'Hủy đơn DH123' })).body;
    const answer = [{ id: waiting.interruptions[0].id, approved: false, reason: 'Khách đổi ý' }];
    const elsewhere = (await post('/api/agents/approval-agent/resume', { ...saved, appId: 'helpdesk', approvals: answer })).body;
    assert.equal(elsewhere.error.code, 'approval_not_found');
    const denied = (await post('/api/agents/approval-agent/resume', { ...saved, appId: 'checkout', approvals: answer })).body;
    assert.equal(denied.status, 'completed');
    assert.match(denied.text, /từ chối/);
    assert.equal(denied.trace[0].error.code, 'tool_rejected');

    // A photo sent without a caption, like a medical certificate for a leave request.
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
    const photo = { name: 'giay-kham.png', mediaType: 'image/png', data: png };
    const received = (await post('/api/run', { ...draft, sessionId: 'files', attachments: [photo] })).body;
    assert.equal(received.status, 'completed');
    assert.match(received.text, /đã nhận 1 tệp: giay-kham\.png/);
    const notAnImage = { mediaType: 'image/png', data: Buffer.from('not an image').toString('base64') };
    const rejected = (await post('/api/run', { ...draft, sessionId: 'files', message: 'Ảnh khác', attachments: [notAnImage] })).body;
    assert.equal(rejected.error.code, 'invalid_attachment');
    assert.equal((await post('/api/run', { ...draft, sessionId: 'files', attachments: [{ mediaType: 'image/png' }] })).status, 400);
    assert.equal((await post('/api/run', { ...draft, sessionId: 'files', message: '' })).status, 400);
    const stored = (await history('files')).messages;
    assert.equal(stored.length, 2);
    assert.equal(stored[0].content, '');
    assert.deepEqual(stored[0].attachments, [{ name: 'giay-kham.png', mediaType: 'image/png', size: Buffer.from(png, 'base64').length }]);
    assert.ok(!JSON.stringify(stored).includes(png));
  } finally {
    await new Promise((done) => server.close(done));
    await rm(dataPath, { force: true });
    await rmdir(directory);
  }
});
