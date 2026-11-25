import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { RequestError } from './config.js';

export function credentialBindings(profile) {
  const bindings = new Map();
  const model = profile.model;
  if (model && model.provider !== 'demo') bindings.set('model', JSON.stringify([model.provider, model.baseUrl ?? null]));
  for (const tool of profile.tools) {
    if (tool?.kind === 'http') bindings.set(`tool:${tool.name}`, tool.url);
  }
  // A stored MCP token only goes to the server it was entered for; changing the URL drops it.
  for (const server of profile.mcpServers ?? []) bindings.set(`mcp:${server.prefix}`, server.url);
  return bindings;
}

/** An environment variable name for a key that Studio stored, so the deployed app reads it from its own environment. */
function referenceName(kind, name) {
  const suffix = createHash('sha256').update(name).digest('hex').slice(0, 8).toUpperCase();
  return `${kind}_${name.toUpperCase().replaceAll('-', '_')}_${suffix}_TOKEN`;
}

export function parseCredentialChanges(changes, bindings) {
  const result = new Map();
  if (changes === undefined) return result;
  if (!changes || typeof changes !== 'object' || Array.isArray(changes)) throw new RequestError(400, 'Thay đổi API key không hợp lệ.');
  for (const [slot, value] of Object.entries(changes)) {
    if (!bindings.has(slot) && value !== null) throw new RequestError(400, 'API key cần gắn với model, tool HTTP hoặc MCP server hiện tại.');
    if (value !== null && (typeof value !== 'string' || !value.trim() || value.length > 2048 || /[\r\n]/.test(value))) {
      throw new RequestError(400, 'API key hoặc token không hợp lệ.');
    }
    result.set(slot, value === null ? null : value.trim());
  }
  return result;
}

export function createCredentialVault(path) {
  let pending;
  async function load(create) {
    try {
      const key = await readFile(path);
      if (key.length !== 32) throw new Error('Invalid workspace credential key');
      return key;
    } catch (error) {
      if (error.code !== 'ENOENT' || !create) throw error;
      await mkdir(dirname(path), { recursive: true });
      const key = randomBytes(32);
      try {
        await writeFile(path, key, { flag: 'wx', mode: 0o600 });
        return key;
      } catch (failure) {
        if (failure.code !== 'EEXIST') throw failure;
        return load(false);
      }
    }
  }
  function key(create) {
    pending ??= load(create).catch((error) => {
      pending = undefined;
      throw error;
    });
    return pending;
  }
  const aad = (agentId, slot, binding) => Buffer.from(JSON.stringify([agentId, slot, binding]));
  return {
    async seal(agentId, changes, bindings) {
      const sealed = new Map();
      for (const [slot, value] of changes) {
        if (value === null) {
          sealed.set(slot, null);
          continue;
        }
        const binding = bindings.get(slot);
        const nonce = randomBytes(12);
        const cipher = createCipheriv('aes-256-gcm', await key(true), nonce);
        cipher.setAAD(aad(agentId, slot, binding));
        const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
        sealed.set(slot, { binding, nonce: nonce.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') });
      }
      return sealed;
    },
    async resolve(agentId, records, bindings, changes) {
      const values = new Map();
      for (const [slot, binding] of bindings) {
        const record = records[slot];
        if (changes.has(slot)) {
          if (changes.get(slot) !== null) values.set(slot, changes.get(slot));
        } else if (record?.binding === binding) {
          try {
            const decipher = createDecipheriv('aes-256-gcm', await key(false), Buffer.from(record.nonce, 'base64'));
            decipher.setAAD(aad(agentId, slot, binding));
            decipher.setAuthTag(Buffer.from(record.tag, 'base64'));
            values.set(slot, Buffer.concat([decipher.update(Buffer.from(record.ciphertext, 'base64')), decipher.final()]).toString('utf8'));
          } catch {
            throw new RequestError(409, 'Không mở được API key đã lưu. Hãy nhập lại key trong Studio.');
          }
        }
      }
      return values;
    },
  };
}

export function credentialStatus(profile, records, environment) {
  const bindings = credentialBindings(profile);
  function source(slot, environmentName) {
    if (bindings.has(slot) && records[slot]?.binding === bindings.get(slot)) return 'studio';
    return environmentName && environment[environmentName]?.trim() ? 'environment' : null;
  }
  return {
    model: source('model', profile.model?.apiKeyEnv),
    tools: Object.fromEntries(profile.tools.filter((tool) => tool?.kind === 'http').map((tool) => [tool.name, source(`tool:${tool.name}`, tool.apiKeyEnv)])),
    mcpServers: Object.fromEntries((profile.mcpServers ?? []).map((server) => [server.prefix, source(`mcp:${server.prefix}`, server.apiKeyEnv)])),
  };
}

export function deploymentKeyReferences(profile, records) {
  const bindings = credentialBindings(profile);
  const needsReference = (slot) => bindings.has(slot) && records[slot]?.binding === bindings.get(slot);
  return {
    ...profile,
    ...(needsReference('model') ? { model: { ...profile.model, apiKeyEnv: profile.model.apiKeyEnv ?? 'MODEL_API_KEY' } } : {}),
    tools: profile.tools.map((tool) => {
      if (tool?.kind !== 'http' || !needsReference(`tool:${tool.name}`) || tool.apiKeyEnv) return tool;
      return { ...tool, apiKeyEnv: referenceName('TOOL', tool.name) };
    }),
    ...(profile.mcpServers ? { mcpServers: profile.mcpServers.map((server) =>
      !needsReference(`mcp:${server.prefix}`) || server.apiKeyEnv ? server : { ...server, apiKeyEnv: referenceName('MCP', server.prefix) }) } : {}),
  };
}
