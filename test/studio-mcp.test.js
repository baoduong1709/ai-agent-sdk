import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { test } from 'node:test';
import { strFromU8, unzipSync } from 'fflate';
import { startStudio } from '../studio/server.js';

function close(server) {
  server.closeAllConnections();
  return new Promise((done) => server.close(done));
}

const listen = (server) => new Promise((done) => server.listen(0, '127.0.0.1', done));

const tools = [
  { name: 'search_issues', title: 'Search issues', description: 'Search Jira issues',
    inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    annotations: { readOnlyHint: true } },
  { name: 'refresh_board', description: 'Only the board app calls this', inputSchema: { type: 'object' },
    _meta: { ui: { visibility: ['app'] } } },
  { name: 'pair_tool', description: 'Uses a keyword the SDK schema dialect does not know',
    inputSchema: { type: 'object', properties: { pair: { type: 'array', prefixItems: [{ type: 'string' }] } } } },
  { name: 'show_board', description: 'Show the sprint board', inputSchema: { type: 'object', properties: {} },
    _meta: { ui: { resourceUri: 'ui://board/view' } } },
];

/** A Streamable HTTP MCP server with a Jira-like tool set that accepts one Bearer token and records what it receives. */
async function mcpServer(token) {
  const log = { authorization: [], calls: [] };
  let sessions = 0;
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    const message = body ? JSON.parse(body) : undefined;
    log.authorization.push(request.headers.authorization);
    if (request.headers.authorization !== `Bearer ${token}`) return response.writeHead(401).end();
    if (request.method === 'DELETE') return response.writeHead(200).end();
    if (!message?.method || message.method.startsWith('notifications/')) return response.writeHead(202).end();
    const json = (reply, headers = {}) => {
      response.writeHead(200, { 'Content-Type': 'application/json', ...headers });
      response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, ...reply }));
    };
    if (message.method === 'initialize') {
      return json({ result: {
        protocolVersion: '2025-11-25', capabilities: { tools: {}, resources: {} },
        serverInfo: { name: 'jira-test', version: '1.2.0' }, instructions: 'Search before you create an issue.',
      } }, { 'Mcp-Session-Id': `session-${++sessions}` });
    }
    if (message.method === 'tools/list') return json({ result: { tools } });
    if (message.method === 'resources/read') {
      return json({ result: { contents: [{ uri: message.params.uri, mimeType: 'text/html; profile=mcp-app', text: '<p>Board</p>' }] } });
    }
    if (message.method === 'tools/call') {
      log.calls.push(message.params);
      return json({ result: { content: [{ type: 'text', text: 'KEY-1 Login fails' }] } });
    }
    return json({ error: { code: -32601, message: 'Method not found' } });
  });
  await listen(server);
  return { url: `http://127.0.0.1:${server.address().port}/mcp`, log, server };
}

/** An OpenAI-compatible model that calls the Jira search once, then answers with what the tool returned. */
async function modelServer() {
  const requests = [];
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    const payload = JSON.parse(body);
    requests.push(payload);
    const last = payload.messages.at(-1);
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ choices: [{ message: last.role === 'tool'
      ? { role: 'assistant', content: `Found: ${last.content}` }
      : { role: 'assistant', tool_calls: [
        { id: 'search-1', type: 'function', function: { name: 'jira_search_issues', arguments: '{"query":"login"}' } },
      ] } }] }));
  });
  await listen(server);
  return { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, requests, server };
}

async function studioFixture(t, environment = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'agent-studio-mcp-'));
  const dataPath = join(directory, 'workspace.json');
  const studio = await startStudio({ port: 0, dataPath, environment });
  t.after(async () => {
    if (studio.listening) await close(studio);
    await rm(directory, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${studio.address().port}`;
  const post = async (path, body) => {
    const response = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const type = response.headers.get('content-type') ?? '';
    return { status: response.status, result: type.includes('json') ? await response.json() : response };
  };
  return { base, directory, dataPath, post, studio };
}

/**
 * Starts an extracted agent app and returns its address, or the exit code and error output when it does not start.
 * stop ends the app; the caller runs it before the app folder is removed, since Windows keeps a running app's folder.
 */
async function startApp(directory, environment) {
  const child = spawn(process.execPath, ['app.mjs'], { cwd: directory, windowsHide: true, env: {
    ...process.env, HOST: '127.0.0.1', PORT: '0', AGENT_API_KEY: 'app-client-key', AGENT_CLIENT_KEYS: '',
    AGENT_DATA_PATH: join(directory, 'runtime.json'), AGENT_MODEL_BASE_URL: '', ...environment,
  } });
  const exited = once(child, 'exit');
  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await exited;
  };
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  for await (const line of createInterface({ input: child.stdout })) {
    const address = line.match(/http:\/\/127\.0\.0\.1:\d+$/)?.[0];
    if (address) return { address, stop };
  }
  const [code] = await exited;
  return { code, stderr, stop };
}

const profileFor = (id, model, mcpServers) => ({
  id, name: 'Jira agent', systemPrompt: 'Help with Jira.',
  model: { provider: 'compatible', model: 'test-model', baseUrl: model.baseUrl },
  tools: [], mcpServers,
});

test('Studio refuses MCP server settings it cannot use', async (t) => {
  const { post } = await studioFixture(t);
  const model = { baseUrl: 'http://127.0.0.1:9/v1' };
  const server = { prefix: 'jira', url: 'http://127.0.0.1:9/mcp' };
  const cases = [
    [{ ...server, prefix: 'jira tools' }],
    [server, { ...server, prefix: 'JIRA' }],
    [{ ...server, url: 'ftp://127.0.0.1/mcp' }],
    [{ ...server, url: 'http://user:secret@127.0.0.1/mcp' }],
    [{ ...server, tools: [] }],
    [{ ...server, timeoutMs: 0 }],
    Array.from({ length: 11 }, (_, index) => ({ ...server, prefix: `server${index}` })),
  ];
  for (const mcpServers of cases) {
    const { status } = await post('/api/profiles', profileFor('invalid', model, mcpServers));
    assert.equal(status, 400, JSON.stringify(mcpServers).slice(0, 120));
  }
  const saved = await post('/api/profiles', {
    ...profileFor('valid', model, [{ ...server, tools: ['search_issues', 'search_issues'] }]), credentialChanges: {},
  });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.result.profile.mcpServers, [{ ...server, tools: ['search_issues'] }]);
  assert.deepEqual(saved.result.credentialStatus.mcpServers, { jira: null });
  const empty = await post('/api/profiles', profileFor('empty', model, []));
  assert.equal(empty.status, 200);
  assert.equal(empty.result.mcpServers, undefined);
});

test('Studio lists the tools of an MCP server with a typed, a stored or no token', async (t) => {
  const { post } = await studioFixture(t);
  const jira = await mcpServer('jira-test-token');
  t.after(() => close(jira.server));
  const server = { prefix: 'jira', url: jira.url };

  const listed = await post('/api/mcp/tools', { profileId: 'lister', server, token: 'jira-test-token' });
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.result.server, { name: 'jira-test', version: '1.2.0' });
  assert.deepEqual(listed.result.tools, [
    { name: 'search_issues', title: 'Search issues', description: 'Search Jira issues', app: false, readOnly: true },
    { name: 'show_board', description: 'Show the sprint board', app: true, readOnly: false },
  ]);
  assert.deepEqual(listed.result.skipped.map(({ name }) => name), ['pair_tool']);

  const refused = await post('/api/mcp/tools', { profileId: 'lister', server, token: null });
  assert.equal(refused.status, 502);
  assert.match(refused.result.error, /MCP server jira/);

  const model = { baseUrl: 'http://127.0.0.1:9/v1' };
  const saved = await post('/api/profiles', { ...profileFor('lister', model, [server]), credentialChanges: { 'mcp:jira': 'jira-test-token' } });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.result.credentialStatus.mcpServers, { jira: 'studio' });
  assert.equal((await post('/api/mcp/tools', { profileId: 'lister', server })).status, 200);
  // The stored token belongs to the URL it was entered for.
  const elsewhere = await post('/api/mcp/tools', { profileId: 'lister', server: { ...server, url: `${jira.url}?other` } });
  assert.equal(elsewhere.status, 502);
  assert.equal((await post('/api/mcp/tools', { profileId: 'lister', server, token: 'line\nbreak' })).status, 400);
});

test('a Studio agent calls the tools of its MCP server with the stored token and the server instructions', async (t) => {
  const { base, dataPath, post } = await studioFixture(t);
  const jira = await mcpServer('jira-test-token');
  const model = await modelServer();
  t.after(() => Promise.all([close(jira.server), close(model.server)]));
  const profile = profileFor('jira-agent', model, [{ prefix: 'jira', url: jira.url, tools: ['search_issues'] }]);

  const saved = await post('/api/profiles', { ...profile, credentialChanges: { 'mcp:jira': 'jira-test-token' } });
  assert.equal(saved.status, 200);
  assert.ok(!(await readFile(dataPath, 'utf8')).includes('jira-test-token'));

  const run = await post('/api/agents/jira-agent/run', { appId: 'test', sessionId: 'mcp-1', message: 'Find login bugs' });
  assert.equal(run.status, 200);
  assert.match(run.result.text, /^Found: .*KEY-1 Login fails/);
  assert.deepEqual(jira.log.calls, [{ name: 'search_issues', arguments: { query: 'login' } }]);
  assert.ok(jira.log.authorization.every((value) => value === 'Bearer jira-test-token'));
  const [first] = model.requests;
  assert.deepEqual(first.tools.map(({ function: { name } }) => name), ['jira_search_issues']);
  const system = first.messages.find(({ role }) => role === 'system').content;
  assert.match(system, /^Help with Jira\./);
  assert.match(system, /Hướng dẫn của MCP server jira \(jira-test\):\nSearch before you create an issue\./);

  // A draft run with a different token uses it, and the server refuses it.
  const draft = await post('/api/run', { profile, sessionId: 'mcp-2', message: 'Find login bugs', credentialChanges: { 'mcp:jira': 'wrong-token' } });
  assert.equal(draft.status, 502);

  const bundle = await fetch(`${base}/api/agents/jira-agent/build`, { method: 'POST' });
  assert.equal(bundle.status, 200);
  const files = unzipSync(new Uint8Array(await bundle.arrayBuffer()));
  assert.ok(Object.values(files).every((data) => !strFromU8(data).includes('jira-test-token')));
  const deployed = JSON.parse(strFromU8(files['agent.json']));
  assert.equal(deployed.mcpServers.length, 1);
  assert.match(deployed.mcpServers[0].apiKeyEnv, /^MCP_JIRA_[0-9A-F]{8}_TOKEN$/);
  assert.match(strFromU8(files['.env.example']), new RegExp(`^${deployed.mcpServers[0].apiKeyEnv}=$`, 'm'));
  assert.match(strFromU8(files['README.md']), /## MCP server/);
});

test('a Studio agent reads the MCP token from the environment variable the server names', async (t) => {
  const { post } = await studioFixture(t, { JIRA_MCP_TOKEN: 'jira-env-token' });
  const jira = await mcpServer('jira-env-token');
  const model = await modelServer();
  t.after(() => Promise.all([close(jira.server), close(model.server)]));
  const profile = profileFor('env-agent', model, [{ prefix: 'jira', url: jira.url, apiKeyEnv: 'JIRA_MCP_TOKEN' }]);

  const saved = await post('/api/profiles', { ...profile, credentialChanges: {} });
  assert.deepEqual(saved.result.credentialStatus.mcpServers, { jira: 'environment' });
  const run = await post('/api/run', { profile, sessionId: 'env-1', message: 'Find login bugs' });
  assert.equal(run.status, 200);
  assert.match(run.result.text, /^Found: .*KEY-1 Login fails/);
  assert.deepEqual(model.requests[0].tools.map(({ function: { name } }) => name), ['jira_search_issues', 'jira_show_board']);

  const missing = await post('/api/run', {
    profile: { ...profile, mcpServers: [{ ...profile.mcpServers[0], apiKeyEnv: 'MISSING_MCP_TOKEN' }] },
    sessionId: 'env-2', message: 'Find login bugs',
  });
  assert.equal(missing.status, 400);
  assert.match(missing.result.error, /MISSING_MCP_TOKEN/);
});

test('a built agent app reads the MCP token from its own environment and does not start without it', { timeout: 20_000 }, async (t) => {
  const { base, directory, post, studio } = await studioFixture(t);
  const jira = await mcpServer('jira-deployed-token');
  const model = await modelServer();
  t.after(() => Promise.all([close(jira.server), close(model.server)]));
  const profile = profileFor('jira-app', model, [{ prefix: 'jira', url: jira.url, tools: ['search_issues'], timeoutMs: 5000 }]);
  assert.equal((await post('/api/profiles', { ...profile, credentialChanges: { 'mcp:jira': 'jira-studio-token' } })).status, 200);
  const bundle = await fetch(`${base}/api/agents/jira-app/build`, { method: 'POST' });
  const files = unzipSync(new Uint8Array(await bundle.arrayBuffer()));
  const app = join(directory, 'app');
  await mkdir(app);
  for (const [name, content] of Object.entries(files)) await writeFile(join(app, name), content);
  await close(studio);
  const variable = JSON.parse(strFromU8(files['agent.json'])).mcpServers[0].apiKeyEnv;

  const stopped = await startApp(app, { [variable]: '' });
  await stopped.stop();
  assert.notEqual(stopped.code, 0);
  assert.match(stopped.stderr, new RegExp(variable));

  const started = await startApp(app, { [variable]: 'jira-deployed-token' });
  try {
    assert.ok(started.address, started.stderr);
    assert.equal(jira.log.authorization.length, 0, 'the app connects at the first run, not at start-up');
    const run = await fetch(`${started.address}/api/run`, { method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer app-client-key' },
      body: JSON.stringify({ appId: 'test', sessionId: 'deployed-1', message: 'Find login bugs' }) });
    assert.equal(run.status, 200);
    assert.match((await run.json()).text, /^Found: .*KEY-1 Login fails/);
    assert.ok(jira.log.authorization.length && jira.log.authorization.every((value) => value === 'Bearer jira-deployed-token'));
    assert.match(model.requests[0].messages[0].content, /Search before you create an issue\./);
  } finally {
    await started.stop();
  }
});

test('an MCP tool that has the name of another agent tool stops the run', async (t) => {
  const { post } = await studioFixture(t);
  const jira = await mcpServer('jira-test-token');
  const model = await modelServer();
  t.after(() => Promise.all([close(jira.server), close(model.server)]));
  const profile = {
    ...profileFor('twice', model, [{ prefix: 'jira', url: jira.url }]),
    tools: [{ kind: 'http', name: 'jira_search_issues', label: 'Search', description: 'Search issues', method: 'GET',
      url: 'http://127.0.0.1:9/search', parameters: { type: 'object', properties: {} } }],
  };
  const run = await post('/api/run', { profile, sessionId: 'twice-1', message: 'Find login bugs',
    credentialChanges: { 'mcp:jira': 'jira-test-token' } });
  assert.equal(run.status, 400);
  assert.match(run.result.error, /jira_search_issues .*trùng tên/);
  assert.equal(model.requests.length, 0);
});
