import { setTimeout as sleep } from 'node:timers/promises';
import { ToolError, defineTool } from './index.js';
import { httpStatusError, parseHttpUrl } from './http-tool.js';
import { mcpAppMimeType } from './mcp-apps.js';
import type { ToolDefinition } from './types.js';

/**
 * Tools of MCP servers (https://modelcontextprotocol.io) as agent tools, over the Streamable HTTP transport. The client
 * asks for protocol 2025-11-25 and also speaks the two versions before it, which most servers still answer with.
 */
export const mcpProtocolVersion = '2025-11-25';
const protocolVersions = [mcpProtocolVersion, '2025-06-18', '2025-03-26'];
/** Larger responses are refused. An MCP App document may be up to 1 MB, and arrives as JSON text or base64. */
const responseLimit = 4_000_000;
const appExtension = 'io.modelcontextprotocol/ui';
const validPrefix = /^[A-Za-z0-9_-]{1,32}$/;

type Json = Record<string, unknown>;
export type McpTool = Readonly<ToolDefinition<Record<string, unknown>>>;

/** A tool as the MCP server lists it, before it becomes an agent tool. */
export interface McpToolInfo {
  /** The name on the server. The agent tool has the prefix in front, and _ in place of characters tool names cannot have. */
  name: string;
  title?: string;
  description?: string;
  inputSchema: { type: 'object'; [keyword: string]: unknown };
  /** Hints such as readOnlyHint and destructiveHint. The server sets them; they are not checked. */
  annotations?: Record<string, unknown>;
  /** The ui:// resource of the tool's MCP App, shown in the chat as the tool's form when the server can send it. */
  app?: string;
}

/** Server tool names (without the prefix), or a function that keeps a tool when it returns true. */
export type McpToolFilter = readonly string[] | ((tool: McpToolInfo) => boolean);

export interface McpOptions {
  /** The MCP endpoint, such as https://mcp.example.com/mcp. */
  url: string;
  /** Sent with every request, such as Authorization. A function is called each time, so a token can be renewed. */
  headers?: HeadersInit | (() => HeadersInit | Promise<HeadersInit>);
  fetch?: typeof fetch;
  /** Put in front of every tool name with _, such as jira for jira_search, so tools of two servers cannot clash. */
  prefix?: string;
  /** Only these tools are offered. Names the server does not have make connectMcp fail, to catch misspellings. */
  tools?: McpToolFilter;
  /** Time limit of each tool call, at most 300000 ms. Without it a call may take as long as the agent run. */
  timeoutMs?: number;
  /** Time limit to connect and to list the tools. Defaults to 30000 ms. */
  connectTimeoutMs?: number;
  /** false: do not ask the server for the MCP Apps of its tools. Defaults to true. */
  apps?: boolean;
}

export interface McpServerInfo {
  name: string;
  version: string;
  title?: string;
  /** The protocol version the server chose. */
  protocolVersion: string;
  /** How the server says its tools are best used. Worth adding to the system prompt of an agent that uses them. */
  instructions?: string;
}

export interface McpConnection {
  readonly server: McpServerInfo;
  /** The agent tools, after the tools option. Give them to createSDK or to an agent. */
  readonly tools: McpTool[];
  /** Server tools that could not become agent tools, and why: an invalid name or input schema, or a name clash. */
  readonly skipped: readonly { name: string; reason: string }[];
  /** The tools one agent gets. Names the connection does not offer throw a TypeError. */
  select(filter: McpToolFilter): McpTool[];
  /** Lists the tools again, for a server whose tools changed. Agents keep the tools they were given. */
  refresh(): Promise<McpTool[]>;
  /** Ends the session on the server. Tools of a closed connection fail with unavailable. */
  close(): Promise<void>;
}

interface Session {
  id?: string;
  version: string;
}

interface StreamCursor {
  lastEventId?: string;
  retry?: number;
}

function plain(value: unknown): value is Json {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function text(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function unavailable(message = 'Could not reach the MCP server.') {
  return new ToolError('unavailable', message);
}

function invalidResponse(message: string) {
  return new ToolError('invalid_response', message);
}

/** The tool error for a JSON-RPC error. The server message is kept: it tells the model what to correct. */
function rpcError(error: unknown) {
  const code = plain(error) ? error.code : undefined;
  const message = (plain(error) ? text(error.message) : undefined)?.slice(0, 500) ?? 'no details';
  const failure = (name: string) => new ToolError(name, `The MCP server refused the request (${String(code)}): ${message}`);
  if (code === -32602 || code === -32600) return failure('invalid_request');
  if (code === -32601) return failure('not_supported');
  if (code === -32002) return failure('not_found');
  if (code === -32603) return failure('unavailable');
  return failure('request_failed');
}

function mediaType(response: Response) {
  return response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
}

/** Waits for a promise, or stops waiting when the signal aborts. */
function abortable<Value>(promise: Promise<Value>, signal: AbortSignal) {
  return new Promise<Value>((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const stop = () => reject(signal.reason);
    signal.addEventListener('abort', stop, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', stop));
  });
}

async function discard(response: Response) {
  await response.body?.cancel().catch(() => {});
}

/** The response body as text, at most 4 MB. Leaving the loop early stops the download. */
async function* chunks(response: Response, signal: AbortSignal) {
  if (!response.body) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  try {
    while (true) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch (error) {
        if (signal.aborted) throw error;
        throw unavailable('The connection to the MCP server broke while reading its response.');
      }
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > responseLimit) throw new ToolError('output_too_large', 'The MCP server response exceeds 4 MB.');
      yield decoder.decode(chunk.value, { stream: true });
    }
    const rest = decoder.decode();
    if (rest) yield rest;
  } finally {
    reader.cancel().catch(() => {});
  }
}

/** The JSON-RPC messages of one server-sent event. Events without data only move the cursor. */
function eventMessages(block: string, cursor: StreamCursor): Json[] {
  const data: string[] = [];
  for (const line of block.split('\n')) {
    if (!line || line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') data.push(value);
    else if (field === 'id' && !value.includes('\0')) cursor.lastEventId = value;
    else if (field === 'retry' && /^\d+$/.test(value)) cursor.retry = Number(value);
  }
  if (!data.length) return [];
  try {
    const parsed: unknown = JSON.parse(data.join('\n'));
    return (Array.isArray(parsed) ? parsed : [parsed]).filter(plain);
  } catch {
    // Not a JSON-RPC message, such as a keep-alive some servers send.
    return [];
  }
}

/** The messages of a response: one JSON body, or a stream of server-sent events. */
async function* serverMessages(response: Response, signal: AbortSignal, cursor: StreamCursor): AsyncGenerator<Json> {
  const type = mediaType(response);
  if (type === 'application/json') {
    let body = '';
    for await (const part of chunks(response, signal)) body += part;
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      throw invalidResponse('The MCP server returned invalid JSON.');
    }
    yield* (Array.isArray(parsed) ? parsed : [parsed]).filter(plain);
    return;
  }
  if (type !== 'text/event-stream') throw invalidResponse('The MCP server answered with neither JSON nor an event stream.');
  let pending = '';
  let carry = '';
  for await (const part of chunks(response, signal)) {
    // A carriage return at the end of a chunk may be the first half of a CRLF line break.
    let piece = carry + part;
    carry = piece.endsWith('\r') ? '\r' : '';
    if (carry) piece = piece.slice(0, -1);
    pending += piece.replace(/\r\n?/g, '\n');
    let end: number;
    while ((end = pending.indexOf('\n\n')) !== -1) {
      const block = pending.slice(0, end);
      pending = pending.slice(end + 2);
      yield* eventMessages(block, cursor);
    }
  }
}

/** What a tool call returns to the agent: the structured content, else the text, else a description of each block. */
function toolValue(result: Json) {
  const content = Array.isArray(result.content) ? result.content.filter(plain) : [];
  const texts = content.filter((block) => block.type === 'text' && typeof block.text === 'string').map((block) => block.text as string);
  if (result.isError === true) {
    // A failed tool explains itself in its content, so the model can correct the arguments and try again.
    throw new ToolError('execution_error', texts.join('\n').trim().slice(0, 4000) || 'The MCP tool failed without saying why.');
  }
  if (result.structuredContent !== undefined) return result.structuredContent;
  if (texts.length === content.length) return texts.join('\n');
  // Pictures, audio and files are not passed on: the model reads their kind and where they are.
  return content.map((block) => {
    if (block.type === 'text') return { type: 'text', text: block.text };
    if (block.type === 'resource' && plain(block.resource)) {
      const { uri, mimeType, text: body } = block.resource;
      return { type: 'resource', uri, mimeType, ...(typeof body === 'string' ? { text: body } : {}) };
    }
    if (block.type === 'resource_link') return { type: 'resource_link', uri: block.uri, name: block.name, mimeType: block.mimeType };
    return { type: block.type, mimeType: block.mimeType, omitted: 'Binary content is not passed to the model.' };
  });
}

function readFilter(filter: unknown): McpToolFilter {
  if (typeof filter === 'function') return filter as (tool: McpToolInfo) => boolean;
  if (Array.isArray(filter) && filter.every((name) => typeof name === 'string')) return filter;
  throw new TypeError('Bộ lọc tool MCP phải là danh sách tên tool hoặc một hàm.');
}

/**
 * Connects to an MCP server over Streamable HTTP and lists its tools as agent tools. Tool calls go to the server;
 * its errors become ToolError codes the model can act on: execution_error when the tool itself failed,
 * invalid_request for arguments the server refused, unavailable when the server cannot be reached, and the codes of
 * httpStatusError for HTTP statuses. Throws when the server cannot be reached or a tools name is not on it.
 */
export async function connectMcp(options: McpOptions): Promise<McpConnection> {
  if (!plain(options)) throw new TypeError('Thiếu cấu hình kết nối MCP.');
  const { url, headers: extraHeaders, fetch: request = globalThis.fetch, prefix, tools: toolFilter,
    timeoutMs, connectTimeoutMs = 30_000, apps = true } = options;
  const endpoint = parseHttpUrl(url);
  if (prefix !== undefined && (typeof prefix !== 'string' || !validPrefix.test(prefix))) {
    throw new TypeError('Tiền tố tool MCP chỉ gồm chữ, số, _ hoặc -, tối đa 32 ký tự.');
  }
  for (const [value, name] of [[timeoutMs, 'timeoutMs'], [connectTimeoutMs, 'connectTimeoutMs']] as const) {
    if (value !== undefined && (!Number.isInteger(value) || value < 1 || value > 300_000)) {
      throw new TypeError(`${name} của MCP phải là số nguyên từ 1 đến 300000.`);
    }
  }
  if (typeof apps !== 'boolean') throw new TypeError('apps của MCP phải là true hoặc false.');
  if (typeof request !== 'function') throw new TypeError('fetch của MCP phải là một hàm.');
  const filter = toolFilter === undefined ? undefined : readFilter(toolFilter);
  const place = `${endpoint.origin}${endpoint.pathname}`;

  let current: Promise<Session> | undefined;
  let closed = false;
  let nextId = 1;
  let server: McpServerInfo | undefined;
  let capabilities: Json = {};
  let state: { tools: McpTool[]; skipped: { name: string; reason: string }[]; infos: Map<McpTool, McpToolInfo> } =
    { tools: [], skipped: [], infos: new Map() };

  async function headersFor(session?: Session) {
    const headers = new Headers(typeof extraHeaders === 'function' ? await extraHeaders() : extraHeaders);
    if (session) {
      headers.set('MCP-Protocol-Version', session.version);
      if (session.id) headers.set('MCP-Session-Id', session.id);
    }
    return headers;
  }

  async function send(method: 'POST' | 'GET' | 'DELETE', session: Session | undefined, signal: AbortSignal,
    { message, lastEventId }: { message?: Json; lastEventId?: string } = {}) {
    const headers = await headersFor(session);
    if (method === 'POST') {
      headers.set('Accept', 'application/json, text/event-stream');
      headers.set('Content-Type', 'application/json');
    } else if (method === 'GET') {
      headers.set('Accept', 'text/event-stream');
      if (lastEventId !== undefined) headers.set('Last-Event-ID', lastEventId);
    }
    try {
      // No redirects: the headers may hold credentials meant for this server only.
      return await request(endpoint, { method, headers, signal, redirect: 'error',
        ...(message ? { body: JSON.stringify(message) } : {}) });
    } catch (error) {
      if (signal.aborted) throw error;
      throw unavailable();
    }
  }

  /** Sends a message that needs no answer, such as a reply to the server or a cancellation, without waiting for it. */
  function post(message: Json, session: Session) {
    send('POST', session, AbortSignal.timeout(connectTimeoutMs), { message }).then(discard).catch(() => {});
  }

  /** Reads a response until the answer to the request with this id, answering what the server asks on the way. */
  async function answerOf(response: Response, id: number, session: Session | undefined, signal: AbortSignal) {
    const cursor: StreamCursor = {};
    for (let resumed = 0; ; resumed++) {
      for await (const message of serverMessages(response, signal, cursor)) {
        if (message.id === id && ('result' in message || 'error' in message)) {
          if ('error' in message) throw rpcError(message.error);
          if (!plain(message.result)) throw invalidResponse('The MCP server returned an invalid result.');
          return message.result;
        }
        if (typeof message.method === 'string' && message.id !== undefined && session) {
          // The client offers no sampling, roots or elicitation, so it only answers ping.
          post({ jsonrpc: '2.0', id: message.id, ...(message.method === 'ping' ? { result: {} }
            : { error: { code: -32601, message: `Method not found: ${message.method}` } }) }, session);
        }
      }
      // A server may end the stream before it answers; the client then resumes it from the last event ID.
      if (mediaType(response) !== 'text/event-stream' || cursor.lastEventId === undefined || resumed >= 3) {
        throw invalidResponse('The MCP server ended its response without answering.');
      }
      await sleep(Math.min(cursor.retry ?? 1000, 5000), undefined, { signal });
      response = await send('GET', session, signal, { lastEventId: cursor.lastEventId });
      if (!response.ok) {
        await discard(response);
        throw httpStatusError(response.status);
      }
    }
  }

  async function initialize(): Promise<Session> {
    const signal = AbortSignal.timeout(connectTimeoutMs);
    const id = nextId++;
    const response = await send('POST', undefined, signal, { message: { jsonrpc: '2.0', id, method: 'initialize', params: {
      protocolVersion: mcpProtocolVersion,
      capabilities: apps ? { extensions: { [appExtension]: { mimeTypes: [mcpAppMimeType] } } } : {},
      clientInfo: { name: 'agent-studio-sdk', version: '0.1.0' },
    } } });
    if (!response.ok) {
      await discard(response);
      throw httpStatusError(response.status);
    }
    const sessionId = response.headers.get('mcp-session-id') ?? undefined;
    if (sessionId !== undefined && !/^[!-~]{1,256}$/.test(sessionId)) throw invalidResponse('The MCP server sent an invalid session ID.');
    const result = await answerOf(response, id, undefined, signal);
    const version = result.protocolVersion;
    if (typeof version !== 'string' || !protocolVersions.includes(version)) {
      throw new ToolError('not_supported', `The MCP server uses protocol version ${String(version)}, which this client does not speak.`);
    }
    const info = plain(result.serverInfo) ? result.serverInfo : {};
    server = {
      name: text(info.name) ?? 'mcp', version: text(info.version) ?? '',
      ...(text(info.title) ? { title: text(info.title) } : {}),
      protocolVersion: version,
      ...(text(result.instructions) ? { instructions: text(result.instructions) } : {}),
    };
    capabilities = plain(result.capabilities) ? result.capabilities : {};
    const session = { ...(sessionId ? { id: sessionId } : {}), version };
    const initialized = await send('POST', session, signal, { message: { jsonrpc: '2.0', method: 'notifications/initialized' } });
    await discard(initialized);
    if (!initialized.ok) throw httpStatusError(initialized.status);
    return session;
  }

  function openSession() {
    const opening = initialize();
    current = opening;
    // A failed start is not kept: the next request tries again.
    opening.catch(() => {
      if (current === opening) current = undefined;
    });
    return opening;
  }

  async function call(method: string, params: Json, signal: AbortSignal) {
    for (let attempt = 0; ; attempt++) {
      if (closed) throw unavailable('The MCP connection is closed.');
      const opening = current ?? openSession();
      const session = await abortable(opening, signal);
      const id = nextId++;
      // Registered before sending: a run may stop while the server already works on the request.
      const cancel = () => post({ jsonrpc: '2.0', method: 'notifications/cancelled',
        params: { requestId: id, reason: 'The agent run was cancelled or timed out.' } }, session);
      signal.addEventListener('abort', cancel, { once: true });
      try {
        const response = await send('POST', session, signal, { message: { jsonrpc: '2.0', id, method, params } });
        if (response.status === 404 && session.id && attempt === 0) {
          // The server ended the session, so it did not run the request: start a new session and send it again.
          await discard(response);
          if (current === opening) current = undefined;
          continue;
        }
        if (!response.ok) {
          await discard(response);
          throw httpStatusError(response.status);
        }
        return await answerOf(response, id, session, signal);
      } finally {
        signal.removeEventListener('abort', cancel);
      }
    }
  }

  async function listTools(signal: AbortSignal) {
    if (!current) await openSession();
    if (!plain(capabilities.tools)) return [];
    const listed: Json[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 100; page++) {
      const result = await call('tools/list', cursor === undefined ? {} : { cursor }, signal);
      if (!Array.isArray(result.tools)) throw invalidResponse('The MCP server returned an invalid tool list.');
      listed.push(...result.tools.filter(plain));
      if (!text(result.nextCursor)) return listed;
      cursor = result.nextCursor as string;
    }
    throw invalidResponse('The MCP server tool list has more than 100 pages.');
  }

  /** The MCP App document at a ui:// address, or undefined when the server cannot send one. */
  async function readApp(uri: string, signal: AbortSignal) {
    try {
      const result = await call('resources/read', { uri }, signal);
      const contents = Array.isArray(result.contents) ? result.contents.filter(plain) : [];
      const app = contents.find(({ mimeType }) => typeof mimeType === 'string' &&
        mimeType.replace(/\s+/g, '').toLowerCase() === mcpAppMimeType);
      const html = typeof app?.text === 'string' ? app.text
        : typeof app?.blob === 'string' ? Buffer.from(app.blob, 'base64').toString('utf8') : undefined;
      // The tool still works without its app; an app over 1 MB is not shown.
      return html && Buffer.byteLength(html) <= 1_000_000 ? html : undefined;
    } catch {
      return undefined;
    }
  }

  function unknownNames(names: readonly string[], known: Iterable<McpToolInfo>, skipped: { name: string; reason: string }[]) {
    const offered = new Set(Array.from(known, ({ name }) => name));
    const missing = names.filter((name) => !offered.has(name));
    if (!missing.length) return;
    throw new TypeError(`MCP server ${server?.name ?? place} không cung cấp tool: ${missing.map((name) => {
      const reason = skipped.find((entry) => entry.name === name)?.reason;
      return reason ? `${name} (${reason})` : name;
    }).join(', ')}`);
  }

  function matches(info: McpToolInfo, chosen: McpToolFilter) {
    return typeof chosen === 'function' ? chosen(info) === true : chosen.includes(info.name);
  }

  async function build(listed: Json[], strict: boolean, signal: AbortSignal) {
    const skipped: { name: string; reason: string }[] = [];
    const infos: McpToolInfo[] = [];
    for (const entry of listed) {
      const meta = plain(entry._meta) ? entry._meta : {};
      const ui = plain(meta.ui) ? meta.ui : {};
      // Only the tool's own app may call a tool hidden from the model.
      if (Array.isArray(ui.visibility) && !ui.visibility.includes('model')) continue;
      const name = text(entry.name);
      if (!name) {
        skipped.push({ name: String(entry.name), reason: 'the tool has no name' });
        continue;
      }
      if (!plain(entry.inputSchema) || entry.inputSchema.type !== 'object') {
        skipped.push({ name, reason: 'its input schema is not an object schema' });
        continue;
      }
      const app = text(ui.resourceUri) ?? text(meta['ui/resourceUri']);
      infos.push({
        name, inputSchema: entry.inputSchema as McpToolInfo['inputSchema'],
        ...(text(entry.title) ? { title: text(entry.title) } : {}),
        ...(text(entry.description) ? { description: text(entry.description) } : {}),
        ...(plain(entry.annotations) ? { annotations: entry.annotations } : {}),
        ...(app?.startsWith('ui://') ? { app } : {}),
      });
    }
    const chosen = filter ? infos.filter((info) => matches(info, filter)) : infos;
    const documents = new Map<string, string | undefined>();
    if (apps && plain(capabilities.resources)) {
      for (const uri of new Set(chosen.flatMap(({ app }) => app ?? []))) documents.set(uri, await readApp(uri, signal));
    }
    const tools: McpTool[] = [];
    const byTool = new Map<McpTool, McpToolInfo>();
    for (const info of chosen) {
      const name = (prefix ? `${prefix}_${info.name}` : info.name).replace(/[^A-Za-z0-9_-]/g, '_');
      if (name.length > 64) {
        skipped.push({ name: info.name, reason: `its tool name ${name} is longer than 64 characters` });
        continue;
      }
      if (tools.some((tool) => tool.name === name)) {
        skipped.push({ name: info.name, reason: `its tool name ${name} clashes with another tool` });
        continue;
      }
      // $schema only names the JSON Schema dialect; the SDK checks arguments with its own.
      const { $schema, ...parameters } = info.inputSchema;
      const html = info.app ? documents.get(info.app) : undefined;
      try {
        const tool = defineTool<Record<string, unknown>>({
          name, description: info.description ?? info.title ?? text(info.annotations?.title) ?? info.name,
          parameters: parameters as McpToolInfo['inputSchema'],
          ...(timeoutMs === undefined ? {} : { timeoutMs }),
          // The server says the tool changes nothing, so its calls may run alongside other read-only calls.
          ...(info.annotations?.readOnlyHint === true ? { readOnly: true } : {}),
          ...(html ? { result: { 'x-form': 'app' }, forms: { app: { html, mcpApp: true } } } : {}),
          async execute(args, { signal: callSignal }) {
            return toolValue(await call('tools/call', { name: info.name, arguments: args }, callSignal));
          },
        });
        tools.push(tool);
        byTool.set(tool, info);
      } catch (error) {
        skipped.push({ name: info.name, reason: (error as Error).message });
      }
    }
    // Named tools the server lacks, hides from the model or offers in a form the SDK cannot use.
    if (strict && Array.isArray(filter)) unknownNames(filter, byTool.values(), skipped);
    return { tools, skipped, infos: byTool };
  }

  async function load(strict: boolean) {
    const signal = AbortSignal.timeout(connectTimeoutMs);
    state = await build(await listTools(signal), strict, signal);
    return [...state.tools];
  }

  async function close() {
    if (closed) return;
    closed = true;
    const session = await current?.catch(() => undefined);
    current = undefined;
    if (!session?.id) return;
    // A server that does not let clients end sessions answers 405; the session then simply expires.
    await send('DELETE', session, AbortSignal.timeout(connectTimeoutMs)).then(discard).catch(() => {});
  }

  try {
    await load(true);
  } catch (error) {
    // A session the server already started is ended, so a failed connection leaves nothing open.
    await close();
    if (error instanceof TypeError) throw error;
    throw new Error(`Không kết nối được MCP server ${place}: ${(error as Error).message}`, { cause: error });
  }

  return {
    get server() {
      return server as McpServerInfo;
    },
    get tools() {
      return [...state.tools];
    },
    get skipped() {
      return [...state.skipped];
    },
    select(chosen) {
      const selected = readFilter(chosen);
      if (Array.isArray(selected)) unknownNames(selected, state.infos.values(), state.skipped);
      return state.tools.filter((tool) => matches(state.infos.get(tool) as McpToolInfo, selected));
    },
    refresh: () => load(false),
    close,
  };
}
