import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export async function openWorkspace(path, initialProfiles) {
  let state = { profiles: initialProfiles, sessions: {}, deletedProfileIds: [], credentials: {} };
  try {
    state = JSON.parse(await readFile(path, 'utf8'));
    if (!Array.isArray(state.profiles) || !state.sessions || typeof state.sessions !== 'object') {
      throw new Error('Workspace must contain profiles and sessions');
    }
    state.deletedProfileIds ??= [];
    state.credentials ??= {};
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  let pending = Promise.resolve();
  function write(update) {
    const job = pending.then(async () => {
      const next = update(state);
      if (next === state) return;
      await mkdir(dirname(path), { recursive: true });
      const temp = `${path}.${randomUUID()}.tmp`;
      try {
        await writeFile(temp, JSON.stringify(next, null, 2), { mode: 0o600 });
        await rename(temp, path);
        state = next;
      } finally {
        await rm(temp, { force: true }).catch(() => {});
      }
    });
    pending = job.catch(() => {});
    return job;
  }

  return {
    getProfiles: () => structuredClone(state.profiles),
    getCredentialRecords: (id) => Object.hasOwn(state.credentials, id) ? structuredClone(state.credentials[id]) : {},
    isDeleted: (id) => state.deletedProfileIds.includes(id),
    async saveProfile(profile, { bindings = new Map(), sealed = new Map() } = {}) {
      await write((current) => {
        if (current.deletedProfileIds.includes(profile.id)) {
          throw Object.assign(new Error('Agent was deleted'), { code: 'AGENT_DELETED' });
        }
        const { profiles } = current;
        const existing = Object.hasOwn(current.credentials, profile.id) ? current.credentials[profile.id] : {};
        const records = new Map(Object.entries(existing).filter(([slot, record]) => bindings.get(slot) === record.binding));
        for (const [slot, record] of sealed) {
          if (record) records.set(slot, record);
          else records.delete(slot);
        }
        const credentials = { ...current.credentials };
        if (records.size) credentials[profile.id] = Object.fromEntries(records);
        else delete credentials[profile.id];
        return { ...current, credentials, profiles: profiles.some(({ id }) => id === profile.id)
          ? profiles.map((item) => item.id === profile.id ? profile : item)
          : [...profiles, profile] };
      });
      return profile;
    },
    async deleteProfile(id) {
      let deleted = false;
      await write((current) => {
        const profiles = current.profiles.filter((profile) => profile.id !== id);
        const previousSessions = Object.entries(current.sessions);
        const entries = previousSessions.filter(([key]) => {
          try { return JSON.parse(key)?.[3] !== id; } catch { return true; }
        });
        if (profiles.length === current.profiles.length && entries.length === previousSessions.length) return current;
        deleted = true;
        const credentials = { ...current.credentials };
        delete credentials[id];
        return { profiles, sessions: Object.fromEntries(entries), credentials,
          deletedProfileIds: [...current.deletedProfileIds, id] };
      });
      return deleted;
    },
    sessionStore: {
      async get(key) {
        return structuredClone(state.sessions[key] ?? []);
      },
      async set(key, messages) {
        await write((current) => ({ ...current, sessions: { ...current.sessions, [key]: messages } }));
      },
    },
  };
}
