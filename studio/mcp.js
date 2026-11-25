import { createHash } from 'node:crypto';
import { connectMcp } from 'agent-studio-sdk/mcp';
import { RequestError } from './config.js';

/** The most tools one agent gets, its own and those of its MCP servers together. Model APIs refuse more than 128. */
export const maxAgentTools = 128;
const maxInstructions = 4000;

/**
 * The Bearer token of an MCP server: one entered in Studio, else the environment variable the server names. A server
 * without either is called without a token. A named variable that is empty is a mistake, so it stops the run.
 */
export function mcpToken(server, credentialValues, environment) {
  const stored = credentialValues.get(`mcp:${server.prefix}`);
  if (stored) return stored;
  if (!server.apiKeyEnv) return undefined;
  const token = environment[server.apiKeyEnv]?.trim();
  if (!token) {
    throw new RequestError(400, `Chưa có token cho MCP server ${server.prefix}. Nhập token trong tab Tool của Studio hoặc đặt biến ${server.apiKeyEnv} cho dịch vụ đã triển khai.`);
  }
  return token;
}

function connectOptions(server, token) {
  return {
    url: server.url, prefix: server.prefix,
    ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}),
    ...(server.timeoutMs ? { timeoutMs: server.timeoutMs } : {}),
  };
}

/** The SDK names the server address in its errors; a deployed agent tells its callers only the prefix. */
function connectionError(server, error, detailed) {
  if (error instanceof RequestError) return error;
  if (error instanceof TypeError) return new RequestError(400, `MCP server ${server.prefix}: ${error.message}`);
  if (!detailed) {
    console.error(error);
    return new RequestError(502, `Không kết nối được MCP server ${server.prefix}.`);
  }
  return new RequestError(502, `Không kết nối được MCP server ${server.prefix}: ${error.cause?.message ?? error.message}`);
}

/**
 * Connections to MCP servers, kept open between runs and shared by runs with the same server settings and token.
 * A connection that fails is dropped, so the next run tries again; one nobody used for idleMs is closed.
 */
export function createMcpPool({ idleMs = 10 * 60_000, detailedErrors = true, connect = connectMcp } = {}) {
  const entries = new Map();
  const sweeper = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of entries) {
      if (entry.users || now - entry.lastUsed < idleMs) continue;
      entries.delete(key);
      entry.connection.then((connection) => connection.close(), () => {});
    }
  }, Math.min(idleMs, 60_000));
  sweeper.unref();

  function keyOf(server, token) {
    const digest = token ? createHash('sha256').update(token).digest('hex') : null;
    return JSON.stringify([server.url, server.prefix, server.tools ?? null, server.timeoutMs ?? null, digest]);
  }

  function open(server, token) {
    const key = keyOf(server, token);
    let entry = entries.get(key);
    if (!entry) {
      entry = { users: 0, lastUsed: Date.now(),
        connection: connect({ ...connectOptions(server, token), ...(server.tools ? { tools: server.tools } : {}) }) };
      entries.set(key, entry);
      entry.connection.catch(() => {
        if (entries.get(key) === entry) entries.delete(key);
      });
    }
    return entry;
  }

  /** The agent's own tools with those of the connected servers, and its prompt with what the servers say about them. */
  function combine(connections, tools, systemPrompt) {
    const names = new Set(tools.map(({ name }) => name));
    const combined = [...tools];
    for (const { server, connection } of connections) {
      for (const tool of connection.tools) {
        if (names.has(tool.name)) {
          throw new RequestError(400, `Tool ${tool.name} của MCP server ${server.prefix} trùng tên với một tool khác của agent. Hãy đổi tiền tố.`);
        }
        names.add(tool.name);
        combined.push(tool);
      }
    }
    if (combined.length > maxAgentTools) {
      throw new RequestError(400, `Agent có ${combined.length} tool tính cả tool MCP, vượt quá ${maxAgentTools}. Hãy chọn bớt tool của MCP server.`);
    }
    const notes = connections.flatMap(({ server, connection }) => {
      const text = connection.server.instructions?.slice(0, maxInstructions);
      return text ? [`Hướng dẫn của MCP server ${server.prefix} (${connection.server.title ?? connection.server.name}):\n${text}`] : [];
    });
    return { tools: combined, systemPrompt: notes.length ? `${systemPrompt}\n\n${notes.join('\n\n')}` : systemPrompt };
  }

  return {
    /**
     * Connects the servers of an agent and returns its tools and prompt. Call release when the run ends, so the pool
     * knows the connections are free again.
     */
    async lease(servers, { token, tools, systemPrompt }) {
      const held = [];
      const release = () => {
        for (const entry of held.splice(0)) {
          entry.users -= 1;
          entry.lastUsed = Date.now();
        }
      };
      try {
        const connections = await Promise.all(servers.map(async (server) => {
          const entry = open(server, token(server));
          entry.users += 1;
          held.push(entry);
          try {
            return { server, connection: await entry.connection };
          } catch (error) {
            throw connectionError(server, error, detailedErrors);
          }
        }));
        return { ...combine(connections, tools, systemPrompt), release };
      } catch (error) {
        release();
        throw error;
      }
    },
    /** The tools of servers that already have an open connection, without connecting, for showing stored forms. */
    async connected(servers, token) {
      const tools = [];
      for (const server of servers) {
        let value;
        try {
          value = token(server);
        } catch {
          continue;
        }
        const entry = entries.get(keyOf(server, value));
        const connection = entry && await entry.connection.catch(() => undefined);
        if (connection) tools.push(...connection.tools);
      }
      return tools;
    },
    async close() {
      clearInterval(sweeper);
      const open = [...entries.values()];
      entries.clear();
      await Promise.all(open.map((entry) => entry.connection.then((connection) => connection.close(), () => {})));
    },
  };
}

/**
 * Every tool the server offers the model, for choosing which ones an agent gets. It opens its own connection, without
 * the MCP Apps documents, and closes it before returning.
 */
export async function listMcpTools(server, token, { connect = connectMcp } = {}) {
  const offered = [];
  let connection;
  try {
    connection = await connect({ ...connectOptions(server, token), apps: false, tools: (info) => {
      offered.push(info);
      return true;
    } });
  } catch (error) {
    throw connectionError(server, error, true);
  }
  try {
    const skipped = connection.skipped;
    const unusable = new Set(skipped.map(({ name }) => name));
    const { name, title, version } = connection.server;
    return {
      server: { name, version, ...(title ? { title } : {}) },
      tools: offered.filter((info) => !unusable.has(info.name)).map((info) => ({
        name: info.name,
        ...(info.title ? { title: info.title } : {}),
        ...(info.description ? { description: info.description.slice(0, 500) } : {}),
        app: Boolean(info.app),
        readOnly: info.annotations?.readOnlyHint === true,
      })),
      skipped,
    };
  } finally {
    await connection.close();
  }
}
