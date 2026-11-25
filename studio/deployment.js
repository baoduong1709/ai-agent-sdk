import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createSDK, readAgUiInput } from 'agent-studio-sdk';
import { catalog } from './demo.js';
import { RequestError, modelAdapter, readApprovals, readId, readModel, readProfile, readRunInput, readText } from './config.js';
import { openWorkspace } from './storage.js';
import { attachmentBodyLimit, createRunTransport, json, listen, readJson } from './http.js';
import { createMcpPool, mcpToken } from './mcp.js';

function credentials(environment, host) {
  const sharedKey = environment.AGENT_API_KEY?.trim();
  let clientKeys;
  if (environment.AGENT_CLIENT_KEYS?.trim()) {
    try {
      const config = JSON.parse(environment.AGENT_CLIENT_KEYS);
      if (!config || typeof config !== 'object' || Array.isArray(config) || !Object.keys(config).length) throw new Error();
      clientKeys = new Map(Object.entries(config).map(([appId, key]) => [
        readId(appId, 'Mã ứng dụng'), readText(key, 1024, 'API key'),
      ]));
    } catch {
      throw new Error('AGENT_CLIENT_KEYS phải là JSON chứa mã ứng dụng và API key tương ứng.');
    }
  }
  if (!sharedKey && !clientKeys && !['localhost', '127.0.0.1', '::1'].includes(host)) {
    throw new Error('Đặt AGENT_API_KEY hoặc AGENT_CLIENT_KEYS khi mở dịch vụ ngoài localhost.');
  }
  return (request, appId) => {
    if (!sharedKey && !clientKeys) return;
    const key = clientKeys ? clientKeys.get(appId) : sharedKey;
    const token = request.headers.authorization?.match(/^Bearer (\S+)$/i)?.[1];
    if (key && token) {
      const expected = Buffer.from(key);
      const supplied = Buffer.from(token);
      if (expected.length === supplied.length && timingSafeEqual(expected, supplied)) return;
    }
    throw new RequestError(401, 'Bearer token không hợp lệ.');
  };
}

export async function launchDeployment(userTools = []) {
  const environment = process.env;
  const host = environment.HOST || '127.0.0.1';
  const port = Number(environment.PORT || 8080);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('PORT phải là số nguyên từ 0 đến 65535.');
  const authenticate = credentials(environment, host);
  const profile = JSON.parse(await readFile(new URL('./agent.json', import.meta.url), 'utf8'));
  const toolCatalog = new Map([...catalog, ...userTools].map((entry) => [entry.tool.name, entry]));
  const { config, tools } = readProfile(profile, toolCatalog, environment);
  const settings = config.model ?? { provider: 'demo' };
  const model = modelAdapter(environment.AGENT_MODEL_BASE_URL
    ? readModel({ ...settings, baseUrl: environment.AGENT_MODEL_BASE_URL }) : settings, environment);
  const path = environment.AGENT_DATA_PATH || fileURLToPath(new URL('./data/workspace.json', import.meta.url));
  const { sessionStore } = await openWorkspace(path, []);
  const sdk = createSDK({ model, sessionStore });
  const agentId = config.id;
  const agent = sdk.createAgent({ ...config, ...config.execution, tools, model });
  // Tools of MCP servers come from a connection made at the first run, not at start-up, so the app starts while a server
  // is down and connects again on a later run. Forms are submitted without them: MCP forms only show a tool result.
  const mcp = config.mcpServers ? createMcpPool({ detailedErrors: false }) : undefined;
  const mcpOptions = { token: (entry) => mcpToken(entry, new Map(), environment), tools, systemPrompt: config.systemPrompt };
  // Like the model key, a token variable that agent.json names but the environment leaves empty stops the start.
  for (const entry of config.mcpServers ?? []) mcpOptions.token(entry);
  async function withRunAgent(use) {
    if (!mcp) return use(agent);
    const lease = await mcp.lease(config.mcpServers, mcpOptions);
    try {
      return await use(sdk.createAgent({ ...config, ...config.execution, systemPrompt: lease.systemPrompt, tools: lease.tools, model }));
    } finally {
      lease.release();
    }
  }
  const transport = createRunTransport();
  const server = createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    try {
      const method = request.method;
      const path = new URL(request.url, 'http://localhost').pathname;
      if (method === 'GET' && path === '/health') return json(response, { status: 'ok', agentId });
      if (method === 'POST' && ['/api/ag-ui', `/api/agents/${agentId}/ag-ui`].includes(path)) {
        // AG-UI clients such as CopilotKit post the whole conversation each time; the agent reads the last user message
        // and keeps the history in its own session, under the thread ID.
        let input;
        try {
          input = readAgUiInput(await readJson(request, 1_000_000));
        } catch (error) {
          if (error instanceof TypeError) throw new RequestError(400, `Dữ liệu AG-UI không hợp lệ: ${error.message}`);
          throw error;
        }
        const appId = readId(input.forwardedProps?.appId ?? 'ag-ui', 'Mã ứng dụng');
        authenticate(request, appId);
        const context = { appId };
        if (input.forwardedProps?.userId !== undefined) context.userId = readText(input.forwardedProps.userId, 100, 'Mã người dùng');
        const sessionId = readId(input.threadId, 'Mã phiên');
        const message = readText(input.message, 4000, 'Tin nhắn');
        return await withRunAgent((runAgent) => transport.run(request, response, runAgent, { sessionId, message, context,
          scope: appId, agUi: { threadId: input.threadId, runId: input.runId, state: input.state } }));
      }
      const formSubmit = ['/api/forms/submit', `/api/agents/${agentId}/forms/submit`].includes(path);
      const resume = ['/api/run/resume', `/api/agents/${agentId}/resume`].includes(path);
      const run = ['/api/run', `/api/agents/${agentId}/run`].includes(path);
      if (method === 'POST' && (formSubmit || resume || run || path === '/api/run/cancel')) {
        // A run may carry attached files, so it accepts a larger body than the other routes.
        const body = await readJson(request, run ? 64_000 + attachmentBodyLimit : undefined);
        const appId = readId(body.appId, 'Mã ứng dụng');
        authenticate(request, appId);
        if (path === '/api/run/cancel') {
          return json(response, transport.cancel(readId(body.requestId, 'Mã lượt chạy'), appId));
        }
        const sessionId = readId(body.sessionId, 'Mã phiên');
        const context = { appId };
        if (body.userId !== undefined) context.userId = readText(body.userId, 100, 'Mã người dùng');
        if (formSubmit) {
          // The SDK only accepts forms shown in this session of this app and user, and runs each one once.
          const formId = readId(body.formId, 'Mã form');
          const { values } = body;
          if (!values || typeof values !== 'object' || Array.isArray(values)) throw new RequestError(400, 'Giá trị form phải là một đối tượng JSON.');
          return json(response, await agent.submitForm({ sessionId, context, formId, values }));
        }
        const requestId = body.requestId === undefined ? undefined : readId(body.requestId, 'Mã lượt chạy');
        if (resume) {
          // The SDK continues the paused turn only for the app and user that started it.
          const approvals = readApprovals(body.approvals);
          return await withRunAgent((runAgent) =>
            transport.run(request, response, runAgent, { sessionId, approvals, requestId, context, scope: appId }));
        }
        const input = readRunInput(body);
        return await withRunAgent((runAgent) => transport.run(request, response, runAgent,
          { ...input, sessionId, requestId, context, scope: appId }));
      }
      return json(response, { error: 'Không tìm thấy địa chỉ này.' }, 404);
    } catch (error) {
      if (response.headersSent) return response.destroy();
      if (error instanceof RequestError) return json(response, { error: error.message }, error.status);
      console.error(error);
      return json(response, { error: 'Agent gặp lỗi khi xử lý yêu cầu.' }, 500);
    }
  });
  if (mcp) server.on('close', () => mcp.close());
  await listen(server, port, host);
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => server.close());
  }
  console.log(`Agent ${agentId} → http://${host}:${server.address().port}`);
}
