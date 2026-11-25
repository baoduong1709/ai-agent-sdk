import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { strFromU8, unzipSync } from 'fflate';
import { startStudio } from '../studio/server.js';

function close(server) {
  server.closeAllConnections();
  return new Promise((done) => server.close(done));
}

test('Studio saves encrypted credentials, uses draft changes, and exports only deployment references', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-credentials-'));
  const dataPath = join(directory, 'workspace.json');
  const headers = [];
  const fixture = createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json');
    if (request.url.endsWith('/chat/completions')) {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const { messages } = JSON.parse(Buffer.concat(chunks));
      const last = messages.at(-1);
      if (last.role === 'tool') {
        response.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'Done' } }] }));
      } else {
        headers.push(['model', request.headers.authorization]);
        response.end(JSON.stringify({ choices: [{ message: { role: 'assistant', tool_calls: [
          { id: 'lookup-1', type: 'function', function: { name: 'lookup', arguments: '{}' } },
        ] } }] }));
      }
    } else {
      headers.push(['tool', request.headers.authorization]);
      response.end('{"status":"found"}');
    }
  });
  await new Promise((done) => fixture.listen(0, '127.0.0.1', done));
  const upstream = `http://127.0.0.1:${fixture.address().port}`;
  const start = () => startStudio({ port: 0, dataPath, environment: {} });
  let studio = await start();
  const base = () => `http://127.0.0.1:${studio.address().port}`;
  const post = (path, body) => fetch(base() + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const profile = {
    id: 'secrets', name: 'Agent', systemPrompt: 'Use the tool',
    model: { provider: 'compatible', model: 'test-model', baseUrl: `${upstream}/v1` },
    tools: [{ kind: 'http', name: 'lookup', label: 'Lookup', description: 'Look up data', method: 'GET',
      url: `${upstream}/lookup`, parameters: { type: 'object', properties: {} } }],
  };
  const credentials = { model: 'test-model-secret', 'tool:lookup': 'test-tool-secret' };
  const save = (changes) => post('/api/profiles', { ...profile, credentialChanges: changes });
  const input = { sessionId: '1', message: 'Look up something' };
  const apiRun = () => post('/api/agents/secrets/run', { appId: 'test', ...input });
  try {
    const saved = await (await save(credentials)).json();
    assert.deepEqual(saved.credentialStatus, { model: 'studio', tools: { lookup: 'studio' }, mcpServers: {} });
    assert.ok(!JSON.stringify(saved).includes(credentials.model));
    const disk = await readFile(dataPath, 'utf8');
    assert.ok(!disk.includes(credentials.model) && !disk.includes(credentials['tool:lookup']));
    assert.ok(JSON.parse(disk).credentials.secrets.model.ciphertext);
    const workspace = await (await fetch(base() + '/api/workspace')).json();
    assert.deepEqual(workspace.credentials.secrets, saved.credentialStatus);
    assert.ok(!JSON.stringify(workspace).includes(credentials['tool:lookup']));

    const draft = await post('/api/run', { profile, ...input,
      credentialChanges: { model: 'temporary-model', 'tool:lookup': 'temporary-tool' } });
    assert.equal((await draft.json()).text, 'Done');
    assert.deepEqual(headers.splice(0), [['model', 'Bearer temporary-model'], ['tool', 'Bearer temporary-tool']]);

    const bundle = await fetch(base() + '/api/agents/secrets/build', { method: 'POST' });
    assert.equal(bundle.status, 200);
    const files = unzipSync(new Uint8Array(await bundle.arrayBuffer()));
    assert.ok(Object.values(files).every((data) => Object.values(credentials).every((secret) => !strFromU8(data).includes(secret))));
    const deployed = JSON.parse(strFromU8(files['agent.json']));
    assert.equal(deployed.model.apiKeyEnv, 'MODEL_API_KEY');
    assert.match(deployed.tools[0].apiKeyEnv, /^TOOL_LOOKUP_.*_TOKEN$/);

    await close(studio);
    studio = await start();
    assert.equal((await (await apiRun()).json()).text, 'Done');
    assert.deepEqual(headers.splice(0), [['model', 'Bearer test-model-secret'], ['tool', 'Bearer test-tool-secret']]);

    const retargeted = { ...profile, model: { ...profile.model, baseUrl: `${upstream}/another/v1` },
      tools: [{ ...profile.tools[0], url: `${upstream}/another-tool` }] };
    assert.equal((await (await post('/api/run', { profile: retargeted, ...input })).json()).text, 'Done');
    assert.deepEqual(headers.splice(0), [['model', undefined], ['tool', undefined]]);

    const removed = await (await save({ model: null, 'tool:lookup': null })).json();
    assert.deepEqual(removed.credentialStatus, { model: null, tools: { lookup: null }, mcpServers: {} });
    assert.equal((await (await apiRun()).json()).text, 'Done');
    assert.deepEqual(headers.splice(0), [['model', undefined], ['tool', undefined]]);
    assert.deepEqual(JSON.parse(await readFile(dataPath, 'utf8')).credentials, {});
  } finally {
    if (studio.listening) await close(studio);
    await close(fixture);
    for (const path of [dataPath, `${dataPath}.credentials.key`]) await rm(path, { force: true });
    await rmdir(directory);
  }
});
