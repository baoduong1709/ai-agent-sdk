import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSDK, defaultRunLimits } from 'agent-studio-sdk';
import { modelProviders } from 'agent-studio-sdk/models';
import { catalog, demoModel, initialProfiles } from './demo.js';
import { openWorkspace } from './storage.js';
import { userTools } from './user-tools.js';
import { RequestError, modelAdapter, readApprovals, readId, readMcpServers, readProfile, readRunInput } from './config.js';
import { attachmentBodyLimit, createRunTransport, json, listen, readJson } from './http.js';
import { buildAgentApp } from './build.js';
import { createCredentialVault, credentialBindings, credentialStatus, deploymentKeyReferences, parseCredentialChanges } from './credentials.js';
import { createMcpPool, listMcpTools, mcpToken } from './mcp.js';

const staticFiles = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/tool-editor.js', ['tool-editor.js', 'text/javascript; charset=utf-8']],
  ['/mcp-editor.js', ['mcp-editor.js', 'text/javascript; charset=utf-8']],
  ['/form-frame.html', ['form-frame.html', 'text/html; charset=utf-8']],
]);
// Tool forms run in a sandboxed frame with an opaque origin: their own inline code may run, but they cannot load or send
// anything. They reach the Studio only through messages to the chat, which forwards a submit to the tool.
// The sandbox comes from this policy, not from an iframe attribute: some embedded browsers (the Claude app's browser pane)
// refuse to load a frame that has the attribute. Every other Studio page has frame-ancestors 'none', so the form cannot
// navigate its frame to a Studio page that is not sandboxed.
const formFramePolicy = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; " +
  "form-action 'none'; base-uri 'none'; frame-ancestors 'self'; sandbox allow-scripts allow-forms";
// A profile carries the form HTML of its tools, so Studio routes that receive one accept more than a chat message.
const profileBodyLimit = 1_000_000;

export async function startStudio({
  port = 4173,
  dataPath = fileURLToPath(new URL('../.agent-studio/workspace.json', import.meta.url)),
  environment = process.env, apiKey = environment.OPENAI_API_KEY, model = environment.OPENAI_MODEL,
} = {}) {
  const workspace = await openWorkspace(dataPath, initialProfiles);
  const vault = createCredentialVault(`${dataPath}.credentials.key`);
  const openAI = apiKey?.trim() && model?.trim() ? { model: model.trim() } : null;
  const registered = [...catalog, ...userTools];
  const toolCatalog = new Map(registered.map((entry) => [entry.tool.name, entry]));
  if (toolCatalog.size !== registered.length) throw new Error('Tool catalog contains duplicate names');
  const sdk = createSDK({ model: demoModel, sessionStore: workspace.sessionStore });
  const transport = createRunTransport();
  const mcp = createMcpPool();
  const runningProfiles = new Map();
  const deletingProfiles = new Set();
  const tools = registered.map(({ tool: { name, description, parameters, timeoutMs, forms, approval, readOnly }, label, icon = 'agent' }) =>
    ({ name, description, parameters, timeoutMs, label: label ?? name, icon, formCount: Object.keys(forms ?? {}).length,
      ...(approval ? { approval: true } : {}), ...(readOnly ? { readOnly: true } : {}) }));
  const providers = Object.entries(modelProviders).map(([id, settings]) => ({
    id, ...settings,
    defaultModel: id === 'openai' ? model?.trim() : undefined,
    keyConfigured: settings.apiKeyEnv ? Boolean(environment[settings.apiKeyEnv]?.trim()) : undefined,
  }));

  function modelContext(provider, appId) {
    if (provider !== 'demo' && !Object.hasOwn(modelProviders, provider)) {
      throw new RequestError(400, 'Nhà cung cấp model không hợp lệ.');
    }
    return { appId: appId ? JSON.stringify(['client', provider, appId]) : `agent-studio-${provider}`, tenantId: 'local', userId: 'local' };
  }

  /**
   * Builds the agent of a profile with its credentials and hands it to use, counting the profile as running meanwhile.
   * A form submission does not call the model, so it skips the model key check, and it does not connect the MCP servers:
   * their forms only show what a tool returned.
   */
  async function withAgent(profile, body, appId, use, { needsModel = true } = {}) {
    const prepared = readProfile(profile, toolCatalog, environment);
    const { config } = prepared;
    if (workspace.isDeleted(config.id) || deletingProfiles.has(config.id)) throw new RequestError(410, 'Agent này đã được xóa.');
    let settings = config.model;
    if (!settings) {
      if (body.mode === 'openai' && openAI) settings = { provider: 'openai', model: openAI.model };
      else if (!body.mode || body.mode === 'demo') settings = { provider: 'demo' };
      else throw new RequestError(400, 'Hãy cấu hình model cho agent trước khi chạy.');
    }
    const context = modelContext(settings.provider, appId);
    runningProfiles.set(config.id, (runningProfiles.get(config.id) ?? 0) + 1);
    let lease;
    try {
      const bindings = credentialBindings({ ...config, model: settings });
      const changes = parseCredentialChanges(appId === undefined ? body.credentialChanges : undefined, bindings);
      const values = await vault.resolve(config.id, workspace.getCredentialRecords(config.id), bindings, changes);
      const toolCredentials = [...values.keys()].some((slot) => slot.startsWith('tool:'));
      let tools = toolCredentials ? readProfile(config, toolCatalog, environment, values).tools : prepared.tools;
      let { systemPrompt } = config;
      const model = needsModel ? modelAdapter(settings, environment, apiKey, values.get('model')) : demoModel;
      if (needsModel && config.mcpServers) {
        lease = await mcp.lease(config.mcpServers, { token: (server) => mcpToken(server, values, environment), tools, systemPrompt });
        ({ tools, systemPrompt } = lease);
      }
      const agent = sdk.createAgent({ ...config, ...config.execution, systemPrompt, tools, model });
      return await use(agent, context);
    } finally {
      lease?.release();
      const remaining = runningProfiles.get(config.id) - 1;
      if (remaining) runningProfiles.set(config.id, remaining);
      else runningProfiles.delete(config.id);
    }
  }

  async function runAgent(request, response, profile, body, appId) {
    const input = readRunInput(body);
    const sessionId = readId(body.sessionId, 'Mã phiên');
    const requestId = body.requestId === undefined ? null : readId(body.requestId, 'Mã lượt chạy');
    await withAgent(profile, body, appId, (agent, context) =>
      transport.run(request, response, agent, { ...input, sessionId, context, requestId }));
  }

  /** Answers tool calls that wait for approval; the SDK continues the paused turn only for the same app and user. */
  async function resumeAgent(request, response, profile, body, appId) {
    const sessionId = readId(body.sessionId, 'Mã phiên');
    const requestId = body.requestId === undefined ? null : readId(body.requestId, 'Mã lượt chạy');
    const approvals = readApprovals(body.approvals);
    await withAgent(profile, body, appId, (agent, context) =>
      transport.run(request, response, agent, { sessionId, context, requestId, approvals }));
  }

  /** Sends the values of a form shown in the session to its tool. It is not cancelled when the caller disconnects. */
  async function submitForm(profile, body, appId) {
    const sessionId = readId(body.sessionId, 'Mã phiên');
    const formId = readId(body.formId, 'Mã form');
    const { values } = body;
    if (!values || typeof values !== 'object' || Array.isArray(values)) throw new RequestError(400, 'Giá trị form phải là một đối tượng JSON.');
    return withAgent(profile, body, appId, (agent, context) => agent.submitForm({ sessionId, context, formId, values }),
      { needsModel: false });
  }

  /**
   * The tools of a saved profile, so a loaded conversation shows their forms. MCP tools are added only when their server
   * is already connected: loading a conversation does not wait for a server.
   */
  async function savedTools(profileId) {
    const saved = workspace.getProfiles().find(({ id }) => id === profileId);
    if (!saved) return [];
    let prepared;
    try {
      prepared = readProfile(saved, toolCatalog, environment);
    } catch {
      return [];
    }
    const { config, tools } = prepared;
    if (!config.mcpServers) return tools;
    try {
      const bindings = credentialBindings(config);
      const values = await vault.resolve(config.id, workspace.getCredentialRecords(config.id), bindings, new Map());
      const names = new Set(tools.map(({ name }) => name));
      const connected = await mcp.connected(config.mcpServers, (server) => mcpToken(server, values, environment));
      return [...tools, ...connected.filter(({ name }) => !names.has(name) && names.add(name))];
    } catch {
      return tools;
    }
  }

  /**
   * The tools an MCP server offers, for the dialog that picks them. A token typed in the dialog is used as given; without
   * one, the token stored for this prefix is used only while the URL is the one it was entered for.
   */
  async function inspectMcpServer(body) {
    const profileId = readId(body.profileId, 'Mã agent');
    const [server] = readMcpServers([{ ...body.server, tools: undefined }]);
    let token;
    if (typeof body.token === 'string' && body.token.trim()) {
      token = parseCredentialChanges({ [`mcp:${server.prefix}`]: body.token }, new Map([[`mcp:${server.prefix}`, server.url]]))
        .get(`mcp:${server.prefix}`);
    } else if (body.token !== null) {
      const bindings = new Map([[`mcp:${server.prefix}`, server.url]]);
      const values = await vault.resolve(profileId, workspace.getCredentialRecords(profileId), bindings, new Map());
      token = mcpToken(server, values, environment);
    }
    return listMcpTools(server, token);
  }

  const server = createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Security-Policy', "default-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    try {
      const authority = request.headers.host;
      const { port: listenPort } = server.address();
      if (authority !== `127.0.0.1:${listenPort}` && authority !== `localhost:${listenPort}`) {
        throw new RequestError(403, 'Agent Studio chỉ phục vụ địa chỉ localhost.');
      }
      const url = new URL(request.url, `http://${authority}`);
      if (url.pathname.startsWith('/api/') && ((request.headers.origin && request.headers.origin !== `http://${authority}`) ||
          request.headers['sec-fetch-site'] === 'cross-site')) {
        throw new RequestError(403, 'Trang gửi yêu cầu không cùng địa chỉ với Agent Studio.');
      }

      const method = request.method;
      if (method === 'GET' && staticFiles.has(url.pathname)) {
        const [file, contentType] = staticFiles.get(url.pathname);
        const content = await readFile(new URL(`./public/${file}`, import.meta.url));
        if (url.pathname === '/form-frame.html') response.setHeader('Content-Security-Policy', formFramePolicy);
        response.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-cache' });
        response.end(content);
        return;
      }
      if (method === 'GET' && url.pathname === '/api/workspace') {
        const profiles = workspace.getProfiles();
        const credentials = Object.fromEntries(profiles.map((profile) => [profile.id,
          credentialStatus(profile, workspace.getCredentialRecords(profile.id), environment)]));
        return json(response, { profiles, tools, openAI, providers, defaultRunLimits, credentials });
      }
      if (method === 'POST' && url.pathname === '/api/profiles') {
        const body = await readJson(request, profileBodyLimit);
        const { config } = readProfile(body, toolCatalog, environment);
        const bindings = credentialBindings(config);
        const changes = parseCredentialChanges(body.credentialChanges, bindings);
        const sealed = await vault.seal(config.id, changes, bindings);
        const profile = await workspace.saveProfile(config, { bindings, sealed });
        if (body.credentialChanges === undefined) return json(response, profile);
        return json(response, { profile, credentialStatus: credentialStatus(profile, workspace.getCredentialRecords(profile.id), environment) });
      }
      if (method === 'GET' && url.pathname === '/api/history') {
        const profileId = readId(url.searchParams.get('agentId'), 'Mã agent');
        const sessionId = readId(url.searchParams.get('sessionId'), 'Mã phiên');
        const context = modelContext(url.searchParams.get('mode'));
        const agent = sdk.createAgent({ id: profileId, systemPrompt: 'Conversation history', tools: await savedTools(profileId) });
        return json(response, { messages: await agent.getHistory({ sessionId, context }) });
      }
      if (method === 'POST' && url.pathname === '/api/mcp/tools') {
        return json(response, await inspectMcpServer(await readJson(request)));
      }
      if (method === 'POST' && url.pathname === '/api/run') {
        const body = await readJson(request, profileBodyLimit + attachmentBodyLimit);
        return await runAgent(request, response, body.profile, body);
      }
      if (method === 'POST' && url.pathname === '/api/run/resume') {
        const body = await readJson(request, profileBodyLimit);
        return await resumeAgent(request, response, body.profile, body);
      }
      if (method === 'POST' && url.pathname === '/api/forms/submit') {
        const body = await readJson(request, profileBodyLimit);
        return json(response, await submitForm(body.profile, body));
      }
      if (method === 'POST' && url.pathname === '/api/run/cancel') {
        const { requestId } = await readJson(request);
        return json(response, transport.cancel(readId(requestId, 'Mã lượt chạy')));
      }
      const profileRoute = url.pathname.match(/^\/api\/profiles\/([a-z0-9-]+)$/i);
      if (method === 'DELETE' && profileRoute) {
        const id = readId(profileRoute[1], 'Mã agent');
        if (runningProfiles.has(id)) throw new RequestError(409, 'Agent đang chạy. Hãy dừng hoặc chờ lượt chạy hoàn tất.');
        if (deletingProfiles.has(id)) throw new RequestError(409, 'Agent đang được xóa.');
        deletingProfiles.add(id);
        try {
          if (!await workspace.deleteProfile(id)) throw new RequestError(404, 'Agent không còn trong Studio.');
          return json(response, { id });
        } finally {
          deletingProfiles.delete(id);
        }
      }
      const buildRoute = url.pathname.match(/^\/api\/agents\/([a-z0-9-]+)\/build$/i);
      if (method === 'POST' && buildRoute) {
        const id = readId(buildRoute[1], 'Mã agent');
        const saved = workspace.getProfiles().find((profile) => profile.id === id);
        if (!saved || deletingProfiles.has(id)) throw new RequestError(404, 'Hãy lưu cấu hình agent trước khi build.');
        const { config } = readProfile(saved, toolCatalog, environment);
        const deployConfig = deploymentKeyReferences(config, workspace.getCredentialRecords(id));
        const bundle = await buildAgentApp(deployConfig, { customToolNames: new Set(userTools.map(({ tool }) => tool.name)) });
        if (response.destroyed) return;
        response.writeHead(200, { 'Content-Type': 'application/zip', 'Cache-Control': 'no-store',
          'Content-Length': bundle.length, 'Content-Disposition': `attachment; filename="agent-${id}.zip"` });
        response.end(bundle);
        return;
      }
      const savedRun = url.pathname.match(/^\/api\/agents\/([a-z0-9-]+)\/(run|resume|forms\/submit)$/i);
      if (method === 'POST' && savedRun) {
        const saved = workspace.getProfiles().find(({ id }) => id === savedRun[1]);
        if (!saved) throw new RequestError(404, 'Hãy lưu cấu hình agent trước khi gọi từ ứng dụng.');
        const body = await readJson(request, savedRun[2] === 'run' ? 64_000 + attachmentBodyLimit : undefined);
        const appId = readId(body.appId, 'Mã ứng dụng');
        if (savedRun[2] === 'run') return await runAgent(request, response, saved, body, appId);
        if (savedRun[2] === 'resume') return await resumeAgent(request, response, saved, body, appId);
        return json(response, await submitForm(saved, body, appId));
      }
      return json(response, { error: 'Không tìm thấy địa chỉ này.' }, 404);
    } catch (error) {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      if (error instanceof RequestError) return json(response, { error: error.message }, error.status);
      if (error.code === 'AGENT_DELETED') return json(response, { error: 'Agent này đã được xóa. Hãy tạo agent mới.' }, 410);
      console.error(error);
      return json(response, { error: 'Agent Studio gặp lỗi. Kiểm tra tiến trình backend rồi thử lại.' }, 500);
    }
  });

  server.on('close', () => mcp.close());
  return listen(server, port, '127.0.0.1');
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const server = await startStudio({ port: Number(process.env.PORT || 4173) });
  console.log(`Agent Studio → http://127.0.0.1:${server.address().port}`);
}
