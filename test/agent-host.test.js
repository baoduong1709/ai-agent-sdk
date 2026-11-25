import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ToolError, createSDK, defineTool } from 'agent-studio-sdk';
import { createModel } from 'agent-studio-sdk/models';

const parameters = { type: 'object', properties: { id: { type: 'string' } }, additionalProperties: false };
const input = { sessionId: '1', message: 'Nghỉ phép ngày mai' };

test('a tool error code, a tool-written reply and its data reach the caller without another model call', async () => {
  const propose = defineTool({
    name: 'propose_leave', description: 'Đề xuất đơn nghỉ', parameters,
    execute(_args, { reply }) {
      reply('Đã tạo đề xuất. Bấm xác nhận để gửi.', { actionId: 'act-1' });
      return { proposed: true };
    },
  });
  const forbidden = defineTool({
    name: 'read_salary', description: 'Xem lương', parameters,
    execute() {
      throw new ToolError('forbidden', 'Người dùng không có quyền xem lương.');
    },
  });
  let calls = 0;
  const sdk = createSDK({ model: { async generate() {
    calls += 1;
    return { toolCalls: [{ id: `c${calls}`, name: calls === 1 ? 'read_salary' : 'propose_leave', arguments: '{}' }] };
  } }, tools: [propose, forbidden] });
  const agent = sdk.createAgent({ systemPrompt: 'Hỗ trợ nhân sự', tools: ['propose_leave', 'read_salary'] });

  const result = await agent.run(input);
  assert.equal(result.status, 'completed');
  assert.equal(result.text, 'Đã tạo đề xuất. Bấm xác nhận để gửi.');
  assert.deepEqual(result.data, { actionId: 'act-1' });
  assert.equal(calls, 2, 'the written reply ends the run instead of asking the model again');
  assert.equal(result.trace[0].error.code, 'forbidden');
  assert.deepEqual((await agent.getHistory(input)).at(-1).content, 'Đã tạo đề xuất. Bấm xác nhận để gửi.');
});

test('a run restricts tools per request, names the allowed ones and leaves caller history unsaved', async () => {
  const tool = defineTool({ name: 'read_docs', description: 'Tra tài liệu', parameters, execute: () => ({ found: 0 }) });
  const other = defineTool({ name: 'read_assets', description: 'Tra thiết bị', parameters, execute: () => ({ found: 0 }) });
  const seen = [];
  const sdk = createSDK({ model: { async generate({ history, tools, steps }) {
    seen.push({ history, tools: tools.map(({ name }) => name) });
    if (!steps.length) return { toolCalls: [{ id: 'c1', name: 'read_assets', arguments: '{}' }] };
    return { text: steps[0].outputs[0].output.error.message };
  } }, tools: [tool, other] });
  const agent = sdk.createAgent({ systemPrompt: 'Trợ lý', tools: ['read_docs', 'read_assets'] });

  const result = await agent.run({ ...input, tools: ['read_docs'], history: [{ role: 'user', content: 'Xin chào' }] });
  assert.deepEqual(seen[0].tools, ['read_docs']);
  assert.deepEqual(seen[0].history.map(({ content }) => content), ['Xin chào', 'Nghỉ phép ngày mai']);
  assert.match(result.text, /Available tools: read_docs\./);
  assert.deepEqual(await agent.getHistory(input), [], 'a caller-supplied history is never written back');
  assert.deepEqual(agent.listTools().map(({ name }) => name), ['read_docs', 'read_assets']);
});

test('a chat gateway streams text, hides thinking, reports usage and passes custom headers and fields', async () => {
  const requests = [];
  const chunks = [
    { choices: [{ delta: { content: '<think>cân nhắc' } }] },
    { choices: [{ delta: { content: '</think>Mai anh nghỉ' } }] },
    { choices: [{ delta: { content: ' được nhé.' } }] },
    { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 120, completion_tokens: 9, prompt_tokens_details: { cached_tokens: 100 } } },
  ];
  const model = createModel({
    provider: 'compatible', model: 'madison-chat-v1', baseUrl: 'http://127.0.0.1:9000/v1', apiKey: 'stub',
    headers: { 'x-9router-token-saver': 'off' }, body: { temperature: 0.2, chat_template_kwargs: { enable_thinking: false } },
    fetch: async (url, options) => {
      requests.push({ url, headers: options.headers, body: JSON.parse(options.body) });
      const body = `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}`).join('\n\n')}\n\ndata: [DONE]\n\n`;
      return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } });
    },
  });

  const deltas = [];
  const events = [];
  const result = await createSDK({ model }).createAgent({ systemPrompt: 'Trợ lý' })
    .run({ ...input, onDelta: (text) => deltas.push(text), onEvent: (event) => events.push(event.type) });

  assert.equal(result.text, 'Mai anh nghỉ được nhé.');
  assert.equal(deltas.join(''), 'Mai anh nghỉ được nhé.', 'scratchpad text never reaches the caller');
  assert.deepEqual(result.usage, { promptTokens: 120, cachedTokens: 100, completionTokens: 9, modelCalls: 1 });
  assert.equal(requests[0].headers['x-9router-token-saver'], 'off');
  assert.deepEqual(requests[0].body.chat_template_kwargs, { enable_thinking: false });
  assert.equal(requests[0].body.temperature, 0.2);
  assert.equal(requests[0].body.stream, true);
  assert.deepEqual(requests[0].body.stream_options, { include_usage: true });
  assert.ok(events.includes('model.delta'));

  assert.throws(() => createModel({ provider: 'compatible', model: 'm', baseUrl: 'http://127.0.0.1:9000/v1',
    headers: { Authorization: 'Bearer leak' } }), /Authorization is set by the SDK/);
  assert.throws(() => createModel({ provider: 'compatible', model: 'm', baseUrl: 'http://127.0.0.1:9000/v1',
    body: { messages: [] } }), /messages is set by the SDK/);
});

test('streamed tool calls are reassembled by index and observed by afterTool', async () => {
  const tool = defineTool({ name: 'read_docs', description: 'Tra tài liệu', parameters, execute: () => ({ found: 2 }) });
  const observed = [];
  const chunks = [
    [{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'read_docs', arguments: '{"id":' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"kb"}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] }],
    [{ choices: [{ delta: { content: 'Có 2 tài liệu.' } }] }, { choices: [{ delta: {}, finish_reason: 'stop' }] }],
  ];
  let round = 0;
  const bodies = [];
  const model = createModel({
    provider: 'compatible', model: 'madison-chat-v1', baseUrl: 'http://127.0.0.1:9000/v1', apiKey: 'stub',
    fetch: async (_url, options) => {
      bodies.push(JSON.parse(options.body));
      const body = `${chunks[round++].map((chunk) => `data: ${JSON.stringify(chunk)}`).join('\n\n')}\n\ndata: [DONE]\n\n`;
      return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } });
    },
  });
  const sdk = createSDK({ model, tools: [tool], afterTool: (entry) => observed.push(entry) });

  const result = await sdk.createAgent({ systemPrompt: 'Trợ lý', tools: ['read_docs'] })
    .run({ ...input, onDelta: () => {} });

  assert.equal(result.text, 'Có 2 tài liệu.');
  assert.equal(result.usage.modelCalls, 2);
  assert.deepEqual(observed.map(({ name, arguments: args, output }) => [name, args.id, output.value.found]),
    [['read_docs', 'kb', 2]]);
  assert.ok(observed[0].durationMs >= 0);
  assert.equal(bodies[1].messages.at(-2).tool_calls[0].function.arguments, '{"id":"kb"}');
  assert.equal(bodies[1].messages.at(-1).role, 'tool');
});

test('a stream that ends without a finish reason fails instead of truncating the reply', async () => {
  const model = createModel({
    provider: 'compatible', model: 'm', baseUrl: 'http://127.0.0.1:9000/v1', apiKey: 'stub',
    fetch: async () => new Response('data: {"choices":[{"delta":{"content":"Mai"}}]}\n\n',
      { headers: { 'Content-Type': 'text/event-stream' } }),
  });
  const result = await createSDK({ model }).createAgent({ systemPrompt: 'Trợ lý' }).run({ ...input, onDelta: () => {} });
  assert.equal(result.status, 'error');
  assert.equal(result.error.code, 'provider_incomplete');
});
