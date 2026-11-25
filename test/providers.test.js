import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSDK, defineTool } from 'agent-studio-sdk';
import { createModel } from 'agent-studio-sdk/models';

const input = { sessionId: '1', message: 'Hello' };
const done = { choices: [{ message: { role: 'assistant', content: 'Done.' }, finish_reason: 'stop' }] };
const compatible = { provider: 'compatible', model: 'test', baseUrl: 'http://127.0.0.1:9000/v1' };

function run(options, extra = {}) {
  return createSDK({ model: createModel(options) }).createAgent({ systemPrompt: 'Answer' }).run({ ...input, ...extra });
}

/** A fake fetch that answers from a list of responses (the last one repeats) and counts the calls. */
function replies(...responses) {
  const fetch = async () => {
    const next = responses[Math.min(fetch.calls++, responses.length - 1)];
    if (next instanceof Error) throw next;
    if (typeof next === 'function') return next();
    // A fresh copy each time: a cloned body would tee the stream and keep the SDK's cancel() waiting.
    return new Response(await next.clone().text(), { status: next.status, headers: next.headers });
  };
  fetch.calls = 0;
  return fetch;
}

function status(code, headers = {}) {
  return new Response(JSON.stringify({ error: { message: 'mock' } }), { status: code, headers });
}

function stream(...chunks) {
  const body = `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}`).join('\n\n')}\n\ndata: [DONE]\n\n`;
  return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } });
}

test('tool schemas accept OpenAPI formats, annotations and x- extensions', async () => {
  const notify = defineTool({
    name: 'notify', description: 'Send a reminder',
    parameters: {
      type: 'object', 'x-internal': true, discriminator: { propertyName: 'kind' },
      properties: {
        kind: { type: 'string', example: 'email' },
        email: { type: 'string', format: 'email', 'x-order': 1 },
        at: { type: 'string', format: 'date-time', nullable: true },
      },
      required: ['kind', 'email'],
    },
    execute: ({ email }) => ({ sent: email }),
  });
  const calls = [
    { kind: 'email', email: 'not-an-email' },
    { kind: 'email', email: 'khach@example.vn', at: 'tomorrow' },
    { kind: 'email', email: 'khach@example.vn', at: '2026-11-18T09:00:00+07:00' },
  ];
  let step = 0;
  const model = {
    async generate() {
      if (step === calls.length) return { text: 'Done.', toolCalls: [] };
      const call = { id: `call_${step}`, name: 'notify', arguments: JSON.stringify(calls[step++]) };
      return { toolCalls: [call], continuation: call };
    },
  };
  const observed = [];
  const result = await createSDK({ model, tools: [notify], afterTool: (entry) => observed.push(entry.output) })
    .createAgent({ systemPrompt: 'Answer', tools: ['notify'] }).run(input);
  assert.equal(result.text, 'Done.');
  assert.deepEqual(observed.map((output) => output.ok ? 'ok' : output.error.code),
    ['invalid_arguments', 'invalid_arguments', 'ok']);
  assert.match(observed[0].error.message, /format "email"/);
});

test('tool schemas still reject misspelled keywords with the tool name', () => {
  assert.throws(() => defineTool({
    name: 'broken', description: 'Typo in the schema',
    parameters: { type: 'object', properties: { id: { type: 'string' } }, requried: ['id'] },
    execute: () => 'ok',
  }), { name: 'TypeError', message: /Tool broken has an invalid parameters schema: .*requried/ });
});

test('retries 5xx responses and honours Retry-After before succeeding', async () => {
  const fetch = replies(status(503, { 'retry-after': '0' }), Response.json(done));
  const result = await run({ ...compatible, fetch });
  assert.equal(result.text, 'Done.');
  assert.equal(fetch.calls, 2);
});

test('retries a connection failure', async () => {
  const fetch = replies(new TypeError('fetch failed'), Response.json(done));
  const result = await run({ ...compatible, fetch });
  assert.equal(result.text, 'Done.');
  assert.equal(fetch.calls, 2);
});

test('gives up after maxRetries with a code that names the failure', async () => {
  for (const [options, response, code, calls] of [
    [{}, status(429, { 'retry-after-ms': '0' }), 'provider_rate_limited', 3],
    [{ maxRetries: 0 }, status(502), 'provider_server_error', 1],
    [{ maxRetries: 1 }, () => { throw new TypeError('fetch failed'); }, 'provider_unavailable', 2],
  ]) {
    const fetch = replies(response);
    const result = await run({ ...compatible, ...options, fetch });
    assert.equal(result.status, 'error');
    assert.equal(result.error.code, code);
    assert.equal(fetch.calls, calls);
  }
});

test('does not retry client errors or waits longer than the run should hold', async () => {
  for (const [response, code] of [
    [status(401), 'provider_auth'],
    [status(403), 'provider_auth'],
    [status(404), 'provider_not_found'],
    [status(400), 'provider_rejected'],
    [status(429, { 'retry-after': '120' }), 'provider_rate_limited'],
  ]) {
    const fetch = replies(response);
    const result = await run({ ...compatible, fetch });
    assert.equal(result.error.code, code);
    assert.equal(fetch.calls, 1);
  }
});

test('a cancelled run stops waiting for a retry', async () => {
  const controller = new AbortController();
  const fetch = replies(status(503, { 'retry-after': '15' }));
  setTimeout(() => controller.abort(), 20);
  const started = Date.now();
  const result = await run({ ...compatible, fetch }, { signal: controller.signal });
  assert.equal(result.status, 'cancelled');
  assert.ok(Date.now() - started < 5000);
  assert.equal(fetch.calls, 1);
});

test('rejects an out-of-range maxRetries', () => {
  assert.throws(() => createModel({ ...compatible, maxRetries: 9 }), /maxRetries/);
  assert.throws(() => createModel({ ...compatible, maxRetries: 1.5 }), /maxRetries/);
});

test('reports replies cut off at the output token limit or stopped by a content filter', async () => {
  const half = (reason) => ({ choices: [{ message: { role: 'assistant', content: 'Đơn hàng của' }, finish_reason: reason }] });
  for (const [options, response, code, extra] of [
    [compatible, Response.json(half('length')), 'provider_truncated'],
    [compatible, Response.json(half('content_filter')), 'provider_content_filtered'],
    [compatible, stream({ choices: [{ delta: { content: 'Đơn hàng của' } }] },
      { choices: [{ delta: {}, finish_reason: 'length' }] }), 'provider_truncated', { onDelta: () => {} }],
    [{ provider: 'anthropic', model: 'claude-test', apiKey: 'fake' },
      Response.json({ content: [{ type: 'text', text: 'Đơn hàng của' }], stop_reason: 'max_tokens' }), 'provider_truncated'],
    [{ provider: 'anthropic', model: 'claude-test', apiKey: 'fake' },
      Response.json({ content: [], stop_reason: 'refusal' }), 'provider_content_filtered'],
    [{ provider: 'gemini', model: 'gemini-test', apiKey: 'fake' },
      Response.json({ candidates: [{ finishReason: 'MAX_TOKENS' }] }), 'provider_truncated'],
    [{ provider: 'gemini', model: 'gemini-test', apiKey: 'fake' },
      Response.json({ candidates: [{ content: { role: 'model', parts: [] }, finishReason: 'SAFETY' }] }), 'provider_content_filtered'],
    [{ provider: 'gemini', model: 'gemini-test', apiKey: 'fake' },
      Response.json({ promptFeedback: { blockReason: 'SAFETY' } }), 'provider_content_filtered'],
    [{ provider: 'ollama', model: 'qwen3' },
      Response.json({ message: { role: 'assistant', content: 'Đơn hàng của' }, done_reason: 'length' }), 'provider_truncated'],
    [{ provider: 'openai', model: 'gpt-test', apiKey: 'fake' },
      Response.json({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [] }), 'provider_truncated'],
  ]) {
    const result = await run({ ...options, fetch: replies(response) }, extra);
    assert.equal(result.status, 'error', `${options.provider} should fail`);
    assert.equal(result.error.code, code, `${options.provider} → ${code}`);
  }
});

test('the closing call at the run limit switches tools off in each provider request', async () => {
  const lookup = defineTool({ name: 'lookup', description: 'Look up', parameters: { type: 'object', properties: {} }, execute: () => 'found' });
  const anthropic = { provider: 'anthropic', model: 'claude-test', apiKey: 'fake' };
  const gemini = { provider: 'gemini', model: 'gemini-test', apiKey: 'fake' };
  for (const [options, call, answer, withdrawn] of [
    [{ ...compatible, body: { tool_choice: 'required' } },
      { choices: [{ message: { role: 'assistant', content: null, tool_calls: [
        { id: 'c1', type: 'function', function: { name: 'lookup', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] },
      done, (body) => body.tool_choice === 'none' && body.tools.length === 1],
    [anthropic, { content: [{ type: 'tool_use', id: 'c1', name: 'lookup', input: {} }], stop_reason: 'tool_use' },
      { content: [{ type: 'text', text: 'Done.' }], stop_reason: 'end_turn' },
      (body) => body.tool_choice?.type === 'none' && body.tools.length === 1],
    [gemini, { candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: 'lookup', args: {} } }] }, finishReason: 'STOP' }] },
      { candidates: [{ content: { role: 'model', parts: [{ text: 'Done.' }] }, finishReason: 'STOP' }] },
      (body) => body.toolConfig?.functionCallingConfig?.mode === 'NONE' && body.tools.length === 1],
    [{ provider: 'ollama', model: 'qwen3' },
      { message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'lookup', arguments: {} } }] }, done_reason: 'stop' },
      { message: { role: 'assistant', content: 'Done.' }, done_reason: 'stop' }, (body) => body.tools === undefined],
    [{ provider: 'openai', model: 'gpt-test', apiKey: 'fake' },
      { status: 'completed', output: [{ type: 'function_call', call_id: 'c1', name: 'lookup', arguments: '{}' }] },
      { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'Done.' }] }] },
      (body) => body.tool_choice === 'none' && body.tools.length === 1],
  ]) {
    const bodies = [];
    const fetch = async (url, init) => {
      bodies.push(JSON.parse(init.body));
      return Response.json(bodies.length === 1 ? call : answer);
    };
    const result = await createSDK({ model: createModel({ ...options, fetch }), tools: [lookup] })
      .createAgent({ systemPrompt: 'Answer', tools: ['lookup'], maxSteps: 1 }).run(input);
    assert.equal(result.status, 'limit_reached', options.provider);
    assert.equal(result.text, 'Done.', options.provider);
    assert.equal(bodies.length, 2, options.provider);
    assert.ok(!withdrawn(bodies[0]), `${options.provider} first call keeps tools on`);
    assert.ok(withdrawn(bodies[1]), `${options.provider} closing call switches tools off`);
  }
});

test('a compatible tool call without arguments is sent back with {} as its arguments', async () => {
  const lookup = defineTool({ name: 'lookup', description: 'Look up', parameters: { type: 'object', properties: {} }, execute: () => 'found' });
  const plain = { choices: [{ message: { role: 'assistant', content: null, tool_calls: [
    { id: 'c1', type: 'function', function: { name: 'lookup', arguments: '' } }] }, finish_reason: 'tool_calls' }] };
  // The streamed call never sends an arguments chunk
  const streamed = () => stream({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'lookup' } }] } }] },
    { choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
  const streamedDone = () => stream({ choices: [{ delta: { content: 'Done.' } }] }, { choices: [{ delta: {}, finish_reason: 'stop' }] });
  for (const [first, second, extra] of [[() => Response.json(plain), () => Response.json(done), {}],
    [streamed, streamedDone, { onDelta: () => {} }]]) {
    const bodies = [];
    const fetch = async (url, init) => {
      bodies.push(JSON.parse(init.body));
      return bodies.length === 1 ? first() : second();
    };
    const result = await createSDK({ model: createModel({ ...compatible, fetch }), tools: [lookup] })
      .createAgent({ systemPrompt: 'Answer', tools: ['lookup'] }).run({ ...input, ...extra });
    assert.equal(result.text, 'Done.');
    assert.deepEqual(result.trace.map((entry) => entry.status), ['completed']);
    const replayed = bodies[1].messages.find((message) => message.role === 'assistant');
    assert.equal(replayed.tool_calls[0].function.arguments, '{}');
  }
});

test('a normal stop is still a successful reply', async () => {
  for (const [options, response] of [
    [{ provider: 'anthropic', model: 'claude-test', apiKey: 'fake' },
      Response.json({ content: [{ type: 'text', text: 'Done.' }], stop_reason: 'end_turn' })],
    [{ provider: 'gemini', model: 'gemini-test', apiKey: 'fake' },
      Response.json({ candidates: [{ content: { role: 'model', parts: [{ text: 'Done.' }] }, finishReason: 'STOP' }] })],
    [{ provider: 'ollama', model: 'qwen3' },
      Response.json({ message: { role: 'assistant', content: 'Done.' }, done_reason: 'stop' })],
  ]) {
    const result = await run({ ...options, fetch: replies(response) });
    assert.equal(result.text, 'Done.', options.provider);
  }
});

test('a request larger than the context window is told apart from other rejections', async () => {
  const tooLong = () => new Response(JSON.stringify({ error: { message: 'prompt is too long: 210000 tokens > 200000 maximum' } }),
    { status: 400, headers: { 'content-type': 'application/json' } });
  const other = () => new Response(JSON.stringify({ error: { message: 'invalid model' } }), { status: 400 });
  for (const [response, code] of [[tooLong, 'provider_context_exceeded'], [other, 'provider_rejected']]) {
    const result = await run({ ...compatible, fetch: replies(response) });
    assert.equal(result.error.code, code);
  }
  const anthropic = await run({ provider: 'anthropic', model: 'claude-test', apiKey: 'fake',
    fetch: replies(Response.json({ content: [], stop_reason: 'model_context_window_exceeded' })) });
  assert.equal(anthropic.error.code, 'provider_context_exceeded');
});
