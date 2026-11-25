import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { ToolError, createSDK, mcpAppMimeType } from 'agent-studio-sdk';
import { connectMcp } from 'agent-studio-sdk/mcp';

const boardHtml = '<!doctype html><html><body><p>Board</p></body></html>';
const issues = [{ key: 'KEY-1', summary: 'Login fails' }, { key: 'KEY-2', summary: 'Login is slow' }];

const firstPage = [
  { name: 'search_issues', title: 'Search issues', description: 'Search Jira issues',
    inputSchema: { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object',
      properties: { query: { type: 'string' } }, required: ['query'] },
    annotations: { readOnlyHint: true } },
  { name: 'issue.create', description: 'Create an issue',
    inputSchema: { type: 'object', properties: { summary: { type: 'string' } } } },
  { name: 'refresh_board', description: 'Only the board app calls this', inputSchema: { type: 'object' },
    _meta: { ui: { visibility: ['app'] } } },
  { name: 'pair_tool', description: 'Uses a keyword the SDK schema dialect does not know',
    inputSchema: { type: 'object', properties: { pair: { type: 'array', prefixItems: [{ type: 'string' }] } } } },
];
const secondPage = [
  { name: 'show_board', description: 'Show the sprint board', inputSchema: { type: 'object', properties: {} },
    _meta: { ui: { resourceUri: 'ui://board/view' } } },
];

const sse = (...events) => events.map((event) => `${event}\n\n`).join('');
const data = (message) => `data: ${JSON.stringify(message)}`;

/** A Streamable HTTP MCP server with a Jira-like tool set, recording every request it receives. */
async function mcpServer({ token = 't1' } = {}) {
  const log = { requests: [], sessions: 0, deleted: [] };
  const sessions = new Set();
  const resumable = new Map();
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    const message = body ? JSON.parse(body) : undefined;
    log.requests.push({ method: request.method, headers: request.headers, message });
    const json = (reply, headers = {}) => {
      response.writeHead(200, { 'Content-Type': 'application/json', ...headers });
      response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, ...reply }));
    };
    if (request.headers.authorization !== `Bearer ${token}`) return response.writeHead(401).end();
    if (message?.method === 'initialize') {
      const id = `session-${++log.sessions}`;
      sessions.add(id);
      return json({ result: {
        protocolVersion: '2025-11-25', capabilities: { tools: { listChanged: true }, resources: {} },
        serverInfo: { name: 'jira-test', version: '1.2.0' }, instructions: 'Search before you create an issue.',
      } }, { 'Mcp-Session-Id': id });
    }
    if (!sessions.has(request.headers['mcp-session-id'])) return response.writeHead(404).end();
    if (request.method === 'DELETE') {
      log.deleted.push(request.headers['mcp-session-id']);
      sessions.delete(request.headers['mcp-session-id']);
      return response.writeHead(200).end();
    }
    if (request.method === 'GET') {
      // The client resumes a stream the server ended before it answered.
      const id = resumable.get(request.headers['last-event-id']);
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      return response.end(sse(data({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'Resumed answer' }] } })));
    }
    // Notifications and the client's replies to server requests are accepted without a body.
    if (!message.method || message.method.startsWith('notifications/')) return response.writeHead(202).end();
    const { name, arguments: args } = message.params ?? {};
    if (message.method === 'tools/list') {
      return json({ result: message.params?.cursor === 'page-2' ? { tools: secondPage } : { tools: firstPage, nextCursor: 'page-2' } });
    }
    if (message.method === 'resources/read') {
      return json({ result: { contents: [{ uri: message.params.uri, mimeType: 'text/html; profile=mcp-app', text: boardHtml }] } });
    }
    if (message.method !== 'tools/call') return json({ error: { code: -32601, message: 'Method not found' } });
    if (name === 'search_issues' && args.query === 'short') {
      return json({ error: { code: -32602, message: 'Invalid arguments: query must have at least 3 characters' } });
    }
    if (name === 'search_issues' && args.query === 'slow') {
      // Never answers: the client has to cancel.
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      return response.write(': waiting\n\n');
    }
    if (name === 'search_issues' && args.query === 'resume') {
      resumable.set('event-7', message.id);
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      return response.end(sse('id: event-7\nretry: 10\ndata:'));
    }
    if (name === 'search_issues') {
      // Answers as a stream, asking the client for a ping on the way, with CRLF line breaks.
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.write('id: event-1\r\ndata:\r\n\r\n');
      response.write(`${data({ jsonrpc: '2.0', id: 'server-1', method: 'ping' })}\r\n\r\n`);
      response.write(`${data({ jsonrpc: '2.0', method: 'notifications/progress', params: { progress: 1 } })}\r\n\r`);
      return response.end(`\n${data({ jsonrpc: '2.0', id: message.id, result: {
        content: [{ type: 'text', text: '2 issues' }], structuredContent: { issues } } })}\r\n\r\n`);
    }
    if (name === 'issue.create') {
      return json({ result: { isError: true, content: [{ type: 'text', text: 'Project KEY does not exist.' }] } });
    }
    if (name === 'show_board') {
      return json({ result: { content: [{ type: 'text', text: 'Board' }, { type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgo=' }] } });
    }
    return json({ error: { code: -32602, message: `Unknown tool: ${name}` } });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}/mcp`, log, sessions,
    close: () => new Promise((resolve) => {
      server.closeAllConnections();
      server.close(resolve);
    }),
  };
}

async function rejectsWith(promise, code, message) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof ToolError, `expected ToolError, got ${error}`);
    assert.equal(error.code, code);
    if (message) assert.match(error.message, message);
    return true;
  });
}

const signal = () => AbortSignal.timeout(5000);

test('lists every page of tools, with a prefix, the MCP App of a tool, and the tools it cannot use set aside', async (t) => {
  const server = await mcpServer();
  t.after(server.close);
  let tokenReads = 0;
  const mcp = await connectMcp({ url: server.url, prefix: 'jira', headers: () => {
    tokenReads++;
    return { Authorization: 'Bearer t1' };
  } });
  t.after(() => mcp.close());
  assert.deepEqual(mcp.server, { name: 'jira-test', version: '1.2.0', protocolVersion: '2025-11-25',
    instructions: 'Search before you create an issue.' });
  assert.deepEqual(mcp.tools.map(({ name }) => name), ['jira_search_issues', 'jira_issue_create', 'jira_show_board']);
  assert.deepEqual(mcp.skipped.map(({ name }) => name), ['pair_tool']);
  assert.match(mcp.skipped[0].reason, /prefixItems/);
  const [search, , board] = mcp.tools;
  assert.equal(search.description, 'Search Jira issues');
  assert.deepEqual(search.parameters, { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] });
  assert.deepEqual(board.result, { 'x-form': 'app' });
  assert.deepEqual(board.forms.app, { html: boardHtml, mcpApp: true });

  const [initialize, initialized, ...rest] = server.log.requests;
  assert.equal(initialize.message.params.protocolVersion, '2025-11-25');
  assert.deepEqual(initialize.message.params.capabilities,
    { extensions: { 'io.modelcontextprotocol/ui': { mimeTypes: [mcpAppMimeType] } } });
  assert.equal(initialize.headers.accept, 'application/json, text/event-stream');
  assert.equal(initialize.headers['mcp-session-id'], undefined);
  assert.equal(initialized.message.method, 'notifications/initialized');
  for (const { headers } of [initialized, ...rest]) {
    assert.equal(headers['mcp-session-id'], 'session-1');
    assert.equal(headers['mcp-protocol-version'], '2025-11-25');
  }
  assert.deepEqual(rest.map(({ message }) => [message.method, message.params]), [
    ['tools/list', {}], ['tools/list', { cursor: 'page-2' }], ['resources/read', { uri: 'ui://board/view' }],
  ]);
  assert.equal(tokenReads, server.log.requests.length);
});

test('an agent calls MCP tools and reads their results and failures as tool error codes', async (t) => {
  const server = await mcpServer();
  t.after(server.close);
  const mcp = await connectMcp({ url: server.url, prefix: 'jira', headers: { Authorization: 'Bearer t1' }, apps: false });
  t.after(() => mcp.close());
  assert.equal(mcp.tools.find(({ name }) => name === 'jira_show_board').forms, undefined);
  assert.equal(server.log.requests.some(({ message }) => message?.method === 'resources/read'), false);
  let outputs;
  const model = { async generate({ steps }) {
    if (steps.length) {
      outputs = steps[0].outputs.map(({ output }) => output);
      return { text: 'Found 2 issues; the new one could not be created.' };
    }
    return { toolCalls: [
      { id: '1', name: 'jira_search_issues', arguments: '{"query":"login"}' },
      { id: '2', name: 'jira_issue_create', arguments: '{"summary":"Login fails"}' },
      { id: '3', name: 'jira_search_issues', arguments: '{"query":"short"}' },
    ] };
  } };
  const agent = createSDK({ model }).createAgent({ systemPrompt: `Jira helper. ${mcp.server.instructions}`,
    tools: mcp.select(['search_issues', 'issue.create']) });
  const result = await agent.run({ sessionId: 'mcp', message: 'Find login issues and file one' });
  assert.equal(result.status, 'completed');
  assert.deepEqual(outputs[0], { ok: true, value: { issues } });
  assert.deepEqual(outputs[1], { ok: false, error: { code: 'execution_error', message: 'Project KEY does not exist.' } });
  assert.equal(outputs[2].error.code, 'invalid_request');
  assert.match(outputs[2].error.message, /at least 3 characters/);
  // The server asked for a ping in the middle of its stream and got an answer.
  const pong = server.log.requests.find(({ message }) => message?.id === 'server-1');
  assert.deepEqual(pong.message, { jsonrpc: '2.0', id: 'server-1', result: {} });
  // Only the selected tools reach the model; text and pictures are told apart.
  assert.deepEqual(await mcp.tools[2].execute({}, { signal: signal() }), [
    { type: 'text', text: 'Board' }, { type: 'image', mimeType: 'image/png', omitted: 'Binary content is not passed to the model.' },
  ]);
});

test('starts a new session when the server forgot it, resumes ended streams and cancels calls', async (t) => {
  const server = await mcpServer();
  t.after(server.close);
  const mcp = await connectMcp({ url: server.url, headers: { Authorization: 'Bearer t1' } });
  const search = mcp.select(['search_issues'])[0];
  assert.equal(search.name, 'search_issues');

  server.sessions.clear();
  assert.deepEqual(await search.execute({ query: 'login' }, { signal: signal() }), { issues });
  assert.equal(server.log.sessions, 2);

  assert.equal(await search.execute({ query: 'resume' }, { signal: signal() }), 'Resumed answer');
  const resume = server.log.requests.find(({ method }) => method === 'GET');
  assert.equal(resume.headers['last-event-id'], 'event-7');
  assert.equal(resume.headers.accept, 'text/event-stream');

  const controller = new AbortController();
  const slow = search.execute({ query: 'slow' }, { signal: controller.signal });
  while (!server.log.requests.some(({ message }) => message?.params?.arguments?.query === 'slow')) await sleep(5);
  controller.abort();
  await assert.rejects(slow, { name: 'AbortError' });
  const slowCall = server.log.requests.find(({ message }) => message?.params?.arguments?.query === 'slow').message;
  while (!server.log.requests.some(({ message }) => message?.method === 'notifications/cancelled')) await sleep(5);
  assert.equal(server.log.requests.find(({ message }) => message?.method === 'notifications/cancelled').message.params.requestId,
    slowCall.id);

  await mcp.close();
  assert.deepEqual(server.log.deleted, ['session-2']);
  await rejectsWith(search.execute({ query: 'login' }, { signal: signal() }), 'unavailable', /closed/);
});

test('picks tools per connection and per agent, and refuses names the server does not offer', async (t) => {
  const server = await mcpServer();
  t.after(server.close);
  const headers = { Authorization: 'Bearer t1' };
  const readOnly = await connectMcp({ url: server.url, headers, tools: (tool) => tool.annotations?.readOnlyHint === true });
  t.after(() => readOnly.close());
  assert.deepEqual(readOnly.tools.map(({ name, readOnly: parallel }) => [name, parallel]), [['search_issues', true]],
    'a read-only server tool may run alongside other read-only calls');
  assert.throws(() => readOnly.select(['issue.create']), /issue\.create/);

  const named = await connectMcp({ url: server.url, headers, tools: ['show_board'], apps: false });
  t.after(() => named.close());
  assert.deepEqual(named.tools.map(({ name, readOnly: parallel }) => [name, parallel]), [['show_board', undefined]]);
  assert.deepEqual(named.select((tool) => tool.app === 'ui://board/view').map(({ name }) => name), ['show_board']);

  await assert.rejects(connectMcp({ url: server.url, headers, tools: ['search_issue'] }), /search_issue/);
  await assert.rejects(connectMcp({ url: server.url, headers, tools: ['refresh_board'] }), /refresh_board/);
  await assert.rejects(connectMcp({ url: server.url, headers, tools: ['pair_tool'] }), /pair_tool \(.*prefixItems/);
  // A refused connection ends the session it had started.
  assert.equal(server.log.deleted.length, 3);
});

test('reports a server that refuses the client or cannot be reached', async (t) => {
  const server = await mcpServer();
  t.after(server.close);
  for (const [options, code] of [
    [{ url: server.url, headers: { Authorization: 'Bearer wrong' } }, 'unauthorized'],
    [{ url: server.url, fetch: async () => { throw new TypeError('fetch failed'); } }, 'unavailable'],
    [{ url: server.url, fetch: async () => Response.json({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2024-11-05' } }) },
      'not_supported'],
    [{ url: server.url, fetch: async () => new Response('<html>', { headers: { 'Content-Type': 'text/html' } }) },
      'invalid_response'],
  ]) {
    await assert.rejects(connectMcp(options), (error) => {
      assert.match(error.message, /^Không kết nối được MCP server http:\/\/127\.0\.0\.1:\d+\/mcp: /);
      assert.equal(error.cause.code, code);
      return true;
    });
  }
  for (const options of [{ url: 'ftp://example.test' }, { url: server.url, prefix: 'jira.tools' },
    { url: server.url, timeoutMs: 0 }, { url: server.url, tools: 'search_issues' }]) {
    await assert.rejects(connectMcp(options), TypeError);
  }
});
