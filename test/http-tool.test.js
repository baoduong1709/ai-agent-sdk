import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSDK } from 'agent-studio-sdk';
import { defineHttpTool } from 'agent-studio-sdk/http-tool';

/** Runs one call of an HTTP tool backed by a fake fetch and returns the output the model received. */
async function callTool(answer, options = {}) {
  const tool = defineHttpTool({
    name: 'lookup_order', description: 'Look up an order', method: 'GET', url: 'https://api.example.test/orders',
    parameters: { type: 'object', properties: { id: { type: 'string' } } },
    fetch: async () => {
      if (answer instanceof Error) throw answer;
      return typeof answer === 'function' ? answer() : answer;
    },
    ...options,
  });
  let output;
  const model = { async generate({ steps }) {
    if (steps.length) {
      output = steps[0].outputs[0].output;
      return { text: 'Done.' };
    }
    return { toolCalls: [{ id: '1', name: 'lookup_order', arguments: '{"id":"DH1"}' }] };
  } };
  const result = await createSDK({ model, tools: [tool] }).createAgent({ systemPrompt: 'Answer', tools: ['lookup_order'] })
    .run({ sessionId: '1', message: 'Where is DH1?' });
  assert.equal(result.status, 'completed');
  return output;
}

test('maps HTTP statuses to tool error codes the model can act on', async () => {
  for (const [status, code] of [
    [400, 'invalid_request'], [422, 'invalid_request'], [401, 'unauthorized'], [403, 'forbidden'],
    [404, 'not_found'], [410, 'not_found'], [409, 'conflict'], [429, 'rate_limited'],
    [408, 'unavailable'], [500, 'unavailable'], [503, 'unavailable'], [405, 'request_failed'],
  ]) {
    const output = await callTool(new Response('{"trace":"internal stack detail"}', { status }));
    assert.equal(output.ok, false);
    assert.equal(output.error.code, code, `HTTP ${status}`);
    assert.match(output.error.message, new RegExp(`HTTP ${status}`));
    assert.doesNotMatch(output.error.message, /internal stack detail/);
  }
});

test('reports unreachable services, missing keys, oversized and malformed responses by name', async () => {
  for (const [answer, options, code] of [
    [new TypeError('fetch failed'), {}, 'unavailable'],
    [Response.json({}), { apiKey: () => '  ' }, 'unavailable'],
    [() => new Response('x'.repeat(64_001)), {}, 'output_too_large'],
    [() => new Response('{"id":', { headers: { 'Content-Type': 'application/json' } }), {}, 'invalid_response'],
  ]) {
    const output = await callTool(answer, options);
    assert.equal(output.error.code, code);
  }
});

test('successful responses are still parsed by content type', async () => {
  assert.deepEqual(await callTool(Response.json({ status: 'shipping' })), { ok: true, value: { status: 'shipping' } });
  assert.deepEqual(await callTool(new Response('shipping')), { ok: true, value: 'shipping' });
  assert.deepEqual(await callTool(new Response(null, { status: 204 })), { ok: true, value: null });
});
