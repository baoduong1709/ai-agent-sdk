import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, rmdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { test } from 'node:test';
import { strFromU8, unzipSync } from 'fflate';
import { formAppHtml } from 'agent-studio-sdk';
import { startStudio } from '../studio/server.js';

function close(server) {
  server.closeAllConnections();
  return new Promise((done) => server.close(done));
}

function post(base, path, body, headers) {
  return fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body) });
}

async function deployedAddress(child) {
  const lines = createInterface({ input: child.stdout });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  for await (const line of lines) {
    const address = line.match(/http:\/\/127\.0\.0\.1:\d+$/)?.[0];
    if (address) return address;
  }
  throw new Error(`Agent app failed to start. ${stderr}`);
}

test('a built app runs independently with the saved model and HTTP tool and separates client identities', { timeout: 15_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-app-test-'));
  const studioData = join(directory, 'studio.json');
  const runtimeData = join(directory, 'runtime.json');
  const requests = [];
  const confirmations = [];
  const cancellations = [];
  const fixture = createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json');
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    if (request.url === '/api/chat') {
      const body = JSON.parse(Buffer.concat(chunks));
      requests.push(body);
      const last = body.messages.at(-1);
      let message;
      if (last.role === 'tool') message = { content: JSON.parse(last.content).value.answer };
      else if (last.content === 'follow-up') message = { content: body.messages.some(({ role }) => role === 'assistant') ? 'Resumed' : 'New session' };
      else if (last.content === 'Propose leave') message = { tool_calls: [{ function: { name: 'propose', arguments: {} } }] };
      else if (last.content === 'Cancel order') message = { tool_calls: [{ function: { name: 'cancel', arguments: { id: 'DH123' } } }] };
      else message = { tool_calls: [{ function: { name: 'lookup', arguments: { id: 'DH123' } } }] };
      response.end(JSON.stringify({ message }));
    } else if (request.url === '/propose') {
      response.end(JSON.stringify({ answer: 'Draft ready', draftId: 'D1' }));
    } else if (request.url === '/cancel') {
      cancellations.push(JSON.parse(Buffer.concat(chunks)));
      response.end(JSON.stringify({ answer: 'Cancelled' }));
    } else if (request.url === '/confirm') {
      confirmations.push({ authorization: request.headers.authorization, body: JSON.parse(Buffer.concat(chunks)) });
      response.end(JSON.stringify({ leaveId: 'L1' }));
    } else {
      assert.equal(request.url, '/lookup?id=DH123');
      assert.equal(request.headers.authorization, 'Bearer deployment-tool-key');
      response.end(JSON.stringify({ answer: 'Order found' }));
    }
  });
  await new Promise((done) => fixture.listen(0, '127.0.0.1', done));
  const modelUrl = `http://127.0.0.1:${fixture.address().port}`;
  const studio = await startStudio({ port: 0, dataPath: studioData, environment: { TOOL_TEST_KEY: 'studio-tool-key' } });
  const base = `http://127.0.0.1:${studio.address().port}`;
  let child;
  const extracted = [];
  try {
    const config = {
      id: 'order-app', name: 'Order App', systemPrompt: 'Look up orders.',
      model: { provider: 'ollama', model: 'example-model', baseUrl: modelUrl, reasoningEffort: 'high' },
      execution: { maxSteps: 3, maxToolCalls: 1, timeoutMs: 5000 },
      tools: [{ kind: 'http', name: 'lookup', label: 'Lookup', description: 'Look up the order.', method: 'GET',
        url: `${modelUrl}/lookup`, apiKeyEnv: 'TOOL_TEST_KEY', timeoutMs: 3000,
        parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
      { kind: 'http', name: 'propose', label: 'Propose', description: 'Prepare a leave request.', method: 'POST',
        url: `${modelUrl}/propose`, apiKeyEnv: 'TOOL_TEST_KEY', parameters: { type: 'object', properties: {} },
        result: { type: 'object', 'x-form': 'confirm' },
        forms: { confirm: { html: '<form><input name="reason"><button>Send</button></form>', submit: { method: 'POST', url: `${modelUrl}/confirm` } } } },
      { kind: 'http', name: 'cancel', label: 'Cancel', description: 'Cancel the order.', method: 'POST',
        url: `${modelUrl}/cancel`, apiKeyEnv: 'TOOL_TEST_KEY', approval: true,
        parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } }],
    };
    const saved = await post(base, '/api/profiles', config);
    assert.equal(saved.status, 200);
    const archive = await fetch(`${base}/api/agents/order-app/build`, { method: 'POST' });
    assert.equal(archive.status, 200);
    assert.equal(archive.headers.get('content-type'), 'application/zip');
    assert.match(archive.headers.get('content-disposition'), /agent-order-app\.zip/);
    const files = unzipSync(new Uint8Array(await archive.arrayBuffer()));
    assert.deepEqual(Object.keys(files).sort(), [
      '.dockerignore', '.env.example', 'Dockerfile', 'README.md', 'THIRD-PARTY-NOTICES.txt', 'agent.json', 'app.mjs', 'package.json',
    ].sort());
    assert.deepEqual(JSON.parse(strFromU8(files['agent.json'])), config);
    assert.match(strFromU8(files['.env.example']), /^TOOL_TEST_KEY=$/m);
    assert.ok(Object.values(files).every((content) => !strFromU8(content).includes('studio-tool-key')));
    for (const [name, content] of Object.entries(files)) {
      const path = join(directory, name);
      await writeFile(path, content);
      extracted.push(path);
    }

    assert.equal((await fetch(`${base}/api/profiles/order-app`, { method: 'DELETE' })).status, 200);
    await close(studio);
    child = spawn(process.execPath, ['app.mjs'], { cwd: directory, windowsHide: true, env: {
      ...process.env, HOST: '127.0.0.1', PORT: '0', AGENT_API_KEY: '', AGENT_CLIENT_KEYS: '{"checkout":"key-one","helpdesk":"key-two"}',
      TOOL_TEST_KEY: 'deployment-tool-key', AGENT_DATA_PATH: runtimeData, AGENT_MODEL_BASE_URL: '',
    } });
    const deployed = await deployedAddress(child);
    assert.deepEqual(await (await fetch(`${deployed}/health`)).json(), { status: 'ok', agentId: 'order-app' });
    const headers = (key) => ({ Authorization: `Bearer ${key}` });
    const first = { appId: 'checkout', sessionId: 'same-session', message: 'Look up order' };
    assert.equal((await post(deployed, '/api/run', first, headers('key-two'))).status, 401);
    assert.equal((await (await post(deployed, '/api/run', first, headers('key-one'))).json()).text, 'Order found');
    assert.equal(requests[0].think, 'high');
    const followUp = { ...first, message: 'follow-up' };
    assert.equal((await (await post(deployed, '/api/agents/order-app/run', followUp, headers('key-one'))).json()).text, 'Resumed');
    assert.equal((await (await post(deployed, '/api/run', { ...followUp, appId: 'helpdesk' }, headers('key-two'))).json()).text, 'New session');
    assert.match(await readFile(runtimeData, 'utf8'), /Order found/);

    // An AG-UI client posts the whole conversation and reads the run as server-sent events.
    const agUiRun = { threadId: 'ag-thread', runId: 'ag-run', forwardedProps: { appId: 'checkout' },
      messages: [{ id: 'm0', role: 'user', content: 'Earlier question' }, { id: 'm1', role: 'user', content: 'Look up order' }] };
    assert.equal((await post(deployed, '/api/ag-ui', agUiRun, headers('key-two'))).status, 401);
    assert.equal((await post(deployed, '/api/ag-ui', { threadId: 'ag-thread', messages: [] }, headers('key-one'))).status, 400);
    const agUi = await post(deployed, '/api/agents/order-app/ag-ui', agUiRun, headers('key-one'));
    assert.equal(agUi.headers.get('content-type'), 'text/event-stream; charset=utf-8');
    const events = (await agUi.text()).split('\n\n').filter(Boolean).map((frame) => JSON.parse(frame.replace(/^data: /, '')));
    assert.deepEqual(events[0], { type: 'RUN_STARTED', threadId: 'ag-thread', runId: 'ag-run' });
    assert.deepEqual(events.at(-1), { type: 'RUN_FINISHED', threadId: 'ag-thread', runId: 'ag-run', result: { status: 'completed' } });
    assert.ok(events.some(({ type, toolCallName }) => type === 'TOOL_CALL_START' && toolCallName === 'lookup'));
    assert.equal(events.filter(({ type }) => type === 'TEXT_MESSAGE_CONTENT').map(({ delta }) => delta).join(''), 'Order found');
    assert.equal(events.find(({ type }) => type === 'TOOL_CALL_RESULT').content, '{"status":"completed"}');
    assert.equal(requests.at(-1).messages.filter(({ role }) => role === 'user').at(-1).content, 'Look up order');

    const proposal = { appId: 'checkout', sessionId: 'leave', userId: 'u1', message: 'Propose leave' };
    const { forms: [form] } = await (await post(deployed, '/api/run', proposal, headers('key-one'))).json();
    assert.deepEqual([form.tool, form.form, form.status, form.data.draftId, form.html],
      ['propose', 'confirm', 'open', 'D1', formAppHtml(config.tools[1].forms.confirm.html, { tool: 'propose', form: 'confirm', submit: true })]);
    const submit = (path, body, key) => post(deployed, path, { appId: 'checkout', sessionId: 'leave', userId: 'u1', formId: form.id,
      values: { reason: 'Family' }, ...body }, headers(key));
    assert.equal((await submit('/api/forms/submit', {}, 'key-two')).status, 401);
    assert.equal((await (await submit('/api/forms/submit', { userId: 'u2' }, 'key-one')).json()).error.code, 'form_not_found');
    assert.equal((await submit('/api/forms/submit', { values: 'Family' }, 'key-one')).status, 400);
    const submitted = await (await submit('/api/agents/order-app/forms/submit', {}, 'key-one')).json();
    assert.deepEqual([submitted.status, submitted.value], ['submitted', { leaveId: 'L1' }]);
    assert.deepEqual(confirmations, [{ authorization: 'Bearer deployment-tool-key',
      body: { formId: form.id, form: 'confirm', values: { reason: 'Family' }, data: { answer: 'Draft ready', draftId: 'D1' } } }]);
    assert.equal((await (await submit('/api/forms/submit', {}, 'key-one')).json()).error.code, 'form_closed');

    // A tool that needs approval pauses the turn; only the app and user that started it can continue it.
    const cancel = { appId: 'checkout', sessionId: 'cancel', userId: 'u1' };
    const paused = await (await post(deployed, '/api/run', { ...cancel, message: 'Cancel order' }, headers('key-one'))).json();
    assert.deepEqual([paused.status, paused.interruptions[0].tool, paused.interruptions[0].arguments], ['interrupted', 'cancel', { id: 'DH123' }]);
    assert.deepEqual(cancellations, []);
    const decision = { ...cancel, approvals: [{ id: paused.interruptions[0].id, approved: true }] };
    assert.equal((await post(deployed, '/api/run/resume', decision, headers('key-two'))).status, 401);
    assert.equal((await post(deployed, '/api/run/resume', { ...decision, approvals: [] }, headers('key-one'))).status, 400);
    const otherUser = await (await post(deployed, '/api/run/resume', { ...decision, userId: 'u2' }, headers('key-one'))).json();
    assert.equal(otherUser.error.code, 'approval_not_found');
    const resumed = await (await post(deployed, '/api/agents/order-app/resume', decision, headers('key-one'))).json();
    assert.deepEqual([resumed.status, resumed.text], ['completed', 'Cancelled']);
    assert.deepEqual(cancellations, [{ id: 'DH123' }]);
  } finally {
    if (child?.exitCode === null && child?.signalCode === null) {
      const stopped = once(child, 'exit');
      child.kill();
      await stopped;
    }
    if (studio.listening) await close(studio);
    await close(fixture);
    for (const file of [...extracted, studioData, runtimeData]) await rm(file, { force: true });
    await rmdir(directory);
  }
});

test('deletion removes only the selected agent history and rejects an old draft save', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-delete-test-'));
  const dataPath = join(directory, 'workspace.json');
  const studio = await startStudio({ port: 0, dataPath, environment: {} });
  const base = `http://127.0.0.1:${studio.address().port}`;
  try {
    const { profiles } = await (await fetch(`${base}/api/workspace`)).json();
    for (const profile of profiles) {
      const run = await post(base, '/api/run', { profile, message: 'Xin chào', sessionId: 'same-session' });
      assert.equal((await run.json()).status, 'completed');
    }
    const [first, second] = profiles;
    const remove = await fetch(`${base}/api/profiles/${first.id}`, { method: 'DELETE' });
    assert.equal(remove.status, 200);
    const remaining = await (await fetch(`${base}/api/workspace`)).json();
    assert.deepEqual(remaining.profiles, [second]);
    const history = async (id) => (await (await fetch(`${base}/api/history?agentId=${id}&mode=demo&sessionId=same-session`)).json()).messages;
    assert.deepEqual(await history(first.id), []);
    assert.equal((await history(second.id)).length, 2);
    assert.equal((await post(base, '/api/profiles', first)).status, 410);
    assert.equal((await fetch(`${base}/api/agents/${first.id}/build`, { method: 'POST' })).status, 404);
  } finally {
    await close(studio);
    await rm(dataPath, { force: true });
    await rmdir(directory);
  }
});
