import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ModelError, agUiApprovalEvent, agUiFormEvent, createAgUiEncoder, createSDK, defineTool, formAppHtml, readAgUiInput } from 'agent-studio-sdk';
import { createModel } from 'agent-studio-sdk/models';

/** A response whose body arrives in 5-byte pieces, so events and multi-byte characters are split across reads. */
function pieces(text, contentType) {
  const bytes = new TextEncoder().encode(text);
  let offset = 0;
  return new Response(new ReadableStream({
    pull(controller) {
      if (offset >= bytes.length) return controller.close();
      controller.enqueue(bytes.slice(offset, offset += 5));
    },
  }), { headers: { 'Content-Type': contentType } });
}

/** Server-sent events, with an event line for events that have a type, as Anthropic and OpenAI send them. */
function sse(...events) {
  return pieces(events.map((event) => `${event.type ? `event: ${event.type}\n` : ''}data: ${JSON.stringify(event)}\n\n`).join(''),
    'text/event-stream');
}

function ndjson(...chunks) {
  return pieces(chunks.map((chunk) => JSON.stringify(chunk)).join('\n'), 'application/x-ndjson');
}

function whole(body) {
  return new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
}

/** A fake fetch that answers with the responses in turn and records each request. */
function provider(responses) {
  const requests = [];
  const fetch = async (url, init) => {
    requests.push({ url: String(url), headers: new Headers(init.headers), body: JSON.parse(init.body) });
    return responses[Math.min(requests.length - 1, responses.length - 1)]();
  };
  return { fetch, requests };
}

const lookup = defineTool({
  name: 'lookup', description: 'Look up an order',
  parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  execute: ({ id }) => ({ id, status: 'ready' }),
});

async function streamed(options, responses, { message = 'Where is A1?', observe = true } = {}) {
  const { fetch, requests } = provider(responses);
  const events = [];
  const deltas = [];
  const agent = createSDK({ model: createModel({ ...options, fetch, maxRetries: 0 }) })
    .createAgent({ systemPrompt: 'Answer', tools: [lookup] });
  const result = await agent.run({ sessionId: 's', message,
    ...(observe ? { onDelta: (text) => deltas.push(text), onEvent: (event) => events.push(event) } : {}) });
  const stepText = (step) => events.filter((event) => event.type === 'model.delta' && event.step === step).map(({ text }) => text).join('');
  return { result, requests, deltas, events, stepText };
}

test('Ollama streams NDJSON, hides the scratchpad and sends thinking and tool calls back', async () => {
  const { result, requests, deltas, stepText } = await streamed({ provider: 'ollama', model: 'qwen3' }, [
    () => ndjson(
      { message: { role: 'assistant', content: '', thinking: 'Need the ' } },
      { message: { role: 'assistant', content: '', thinking: 'order.' } },
      { message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'lookup', arguments: { id: 'A1' } } }] } },
      { message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop', prompt_eval_count: 10, eval_count: 4 }),
    () => ndjson(
      { message: { role: 'assistant', content: '<thi' } },
      { message: { role: 'assistant', content: 'nk>scratch</think>Đơn ' } },
      { message: { role: 'assistant', content: 'A1 đã sẵn sàng.' } },
      { message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop', prompt_eval_count: 20, eval_count: 6 }),
  ]);
  assert.equal(result.status, 'completed');
  assert.equal(result.text, 'Đơn A1 đã sẵn sàng.');
  assert.deepEqual(deltas, ['Đơn ', 'A1 đã sẵn sàng.']);
  assert.equal(stepText(2), result.text);
  assert.deepEqual([result.usage.promptTokens, result.usage.completionTokens, result.usage.modelCalls], [30, 10, 2]);
  assert.deepEqual(requests.map(({ body }) => body.stream), [true, true]);
  assert.equal(requests[0].headers.get('accept'), 'text/event-stream');
  const [assistant, tool] = requests[1].body.messages.slice(-2);
  assert.deepEqual(assistant, { role: 'assistant', content: '', thinking: 'Need the order.',
    tool_calls: [{ function: { name: 'lookup', arguments: { id: 'A1' } } }] });
  assert.deepEqual([tool.role, tool.tool_name, JSON.parse(tool.content).value], ['tool', 'lookup', { id: 'A1', status: 'ready' }]);
});

test('a run streams only while someone observes it', async () => {
  const { result, requests } = await streamed({ provider: 'ollama', model: 'qwen3' },
    [() => whole({ message: { role: 'assistant', content: 'Xin chào' }, done: true })], { observe: false });
  assert.deepEqual([result.text, requests[0].body.stream, requests[0].headers.get('accept')], ['Xin chào', false, null]);
});

test('a streaming request still works when the server answers with JSON', async () => {
  const ollama = await streamed({ provider: 'ollama', model: 'qwen3' },
    [() => whole({ message: { role: 'assistant', content: 'Xin chào' }, done: true })]);
  assert.deepEqual([ollama.result.text, ollama.deltas], ['Xin chào', ['Xin chào']]);
  const anthropic = await streamed({ provider: 'anthropic', model: 'claude-x', apiKey: 'test-key' },
    [() => whole({ content: [{ type: 'text', text: 'Hello' }], stop_reason: 'end_turn' })]);
  assert.deepEqual([anthropic.result.text, anthropic.deltas], ['Hello', ['Hello']]);
});

test('a stream cut short or reporting an error fails the run instead of keeping a partial reply', async () => {
  const cut = await streamed({ provider: 'ollama', model: 'qwen3' }, [() => ndjson({ message: { role: 'assistant', content: 'Xin' } })]);
  assert.deepEqual([cut.result.status, cut.result.error.code, cut.deltas], ['error', 'provider_incomplete', ['Xin']]);
  const anthropic = await streamed({ provider: 'anthropic', model: 'claude-x', apiKey: 'test-key' }, [() => sse(
    { type: 'message_start', message: { usage: {} } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Partial' } },
    { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } })]);
  assert.deepEqual([anthropic.result.status, anthropic.result.error.code], ['error', 'provider_server_error']);
  const openai = await streamed({ provider: 'openai', model: 'gpt-x', apiKey: 'test-key' }, [() => sse(
    { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'Partial' },
    { type: 'response.failed', response: { status: 'failed' } })]);
  assert.deepEqual([openai.result.status, openai.result.error.code], ['error', 'provider_server_error']);
  const compatible = await streamed({ provider: 'compatible', model: 'test', baseUrl: 'http://127.0.0.1:9000/v1' }, [() => sse(
    { choices: [{ delta: { content: 'Partial' } }] })]);
  assert.deepEqual([compatible.result.status, compatible.result.error.code], ['error', 'provider_incomplete']);
});

test('Anthropic rebuilds thinking, text and tool blocks from the stream', async () => {
  const { result, requests, stepText } = await streamed({ provider: 'anthropic', model: 'claude-x', apiKey: 'test-key' }, [
    () => sse(
      { type: 'message_start', message: { usage: { input_tokens: 12, cache_read_input_tokens: 8 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Need the order.' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig-1' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Checking.' } },
      { type: 'content_block_stop', index: 1 },
      { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'toolu_1', name: 'lookup', input: {} } },
      { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"id":' } },
      { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '"A1"}' } },
      { type: 'content_block_stop', index: 2 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 9 } },
      { type: 'message_stop' }),
    () => sse(
      { type: 'message_start', message: { usage: { input_tokens: 30 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'A1 is ' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ready.' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Anything else?' } },
      { type: 'content_block_stop', index: 1 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } },
      { type: 'message_stop' }),
  ]);
  assert.equal(result.text, 'A1 is ready.\nAnything else?');
  assert.deepEqual([stepText(1), stepText(2)], ['Checking.', result.text]);
  // Anthropic counts cache reads apart from input_tokens; promptTokens is the whole prompt: 12 + 8 + 30.
  assert.deepEqual([result.usage.promptTokens, result.usage.cachedTokens, result.usage.completionTokens], [50, 8, 14]);
  assert.equal(requests[0].body.stream, true);
  assert.deepEqual(requests[1].body.messages.at(-2), { role: 'assistant', content: [
    { type: 'thinking', thinking: 'Need the order.', signature: 'sig-1' },
    { type: 'text', text: 'Checking.' },
    { type: 'tool_use', id: 'toolu_1', name: 'lookup', input: { id: 'A1' } },
  ] });
});

test('Gemini streams over SSE and keeps thought signatures on the parts it sends back', async () => {
  const { result, requests, stepText } = await streamed({ provider: 'gemini', model: 'gemini-3-pro', apiKey: 'test-key' }, [
    () => sse(
      { candidates: [{ content: { role: 'model', parts: [{ text: 'Planning', thought: true }] } }] },
      { candidates: [{ content: { role: 'model', parts: [{ text: 'Let me ' }] } }] },
      { candidates: [{ content: { role: 'model', parts: [{ text: 'check.' }] } }] },
      { candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: 'lookup', args: { id: 'A1' } }, thoughtSignature: 'sig-1' }] },
        finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 11, candidatesTokenCount: 3 } }),
    () => sse(
      { candidates: [{ content: { role: 'model', parts: [{ text: 'A1 is ' }] } }] },
      { candidates: [{ content: { role: 'model', parts: [{ text: 'ready.', thoughtSignature: 'sig-2' }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 4 } }),
  ]);
  assert.equal(requests[0].url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro:streamGenerateContent?alt=sse');
  assert.equal(result.text, 'A1 is ready.');
  assert.deepEqual([stepText(1), stepText(2)], ['Let me check.', 'A1 is ready.']);
  assert.deepEqual([result.usage.promptTokens, result.usage.completionTokens], [31, 7]);
  assert.deepEqual(requests[1].body.contents.at(-2), { role: 'model', parts: [
    { text: 'Planning', thought: true }, { text: 'Let me check.' },
    { functionCall: { name: 'lookup', args: { id: 'A1' } }, thoughtSignature: 'sig-1' },
  ] });
  assert.equal(requests[1].body.contents.at(-1).parts[0].functionResponse.name, 'lookup');
});

test('OpenAI streams the Responses API text and reads the finished response', async () => {
  const output = [
    { type: 'reasoning', id: 'rs_1', encrypted_content: 'enc' },
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'A1 is ready.' }, { type: 'output_text', text: 'Anything else?' }] },
  ];
  const { result, requests, deltas } = await streamed({ provider: 'openai', model: 'gpt-x', apiKey: 'test-key' }, [() => sse(
    { type: 'response.created', response: { status: 'in_progress' } },
    { type: 'response.output_text.delta', output_index: 1, content_index: 0, delta: 'A1 is ' },
    { type: 'response.output_text.delta', output_index: 1, content_index: 0, delta: 'ready.' },
    { type: 'response.output_text.delta', output_index: 1, content_index: 1, delta: 'Anything else?' },
    { type: 'response.completed', response: { status: 'completed', output,
      usage: { input_tokens: 9, output_tokens: 5, input_tokens_details: { cached_tokens: 2 } } } })]);
  assert.equal(result.text, 'A1 is ready.\nAnything else?');
  assert.equal(deltas.join(''), result.text);
  assert.deepEqual([result.usage.promptTokens, result.usage.cachedTokens, result.usage.completionTokens], [9, 2, 5]);
  assert.deepEqual([requests[0].url, requests[0].body.stream, requests[0].headers.get('authorization')],
    ['https://api.openai.com/v1/responses', true, 'Bearer test-key']);
});

/** A model that streams the given deltas, then returns the given reply, one entry per call. */
function streamingModel(calls) {
  let call = 0;
  return {
    async generate() {
      throw new Error('The run should stream.');
    },
    async stream(_input, onDelta) {
      const { deltas = [], reply } = calls[call++];
      for (const text of deltas) onDelta(text);
      return reply;
    },
  };
}

async function agUi(agentOptions, model, encoder = {}) {
  const encode = createAgUiEncoder({ threadId: 't1', runId: 'client-run', ...encoder });
  const events = [];
  const agent = createSDK({ model }).createAgent({ systemPrompt: 'Answer', ...agentOptions });
  const result = await agent.run({ sessionId: 't1', message: 'Where is A1?', onEvent: (event) => events.push(...encode(event)) });
  return { result, events, types: events.map(({ type }) => type) };
}

test('AG-UI events follow the run: a text message per model call, tool calls without their data, then the finish', async () => {
  const owner = defineTool({ ...lookup, execute: () => ({ owner: 'secret-owner' }) });
  const { events, types } = await agUi({ tools: [owner] }, streamingModel([
    { deltas: ['Checking', '.'], reply: { text: 'Checking.', toolCalls: [{ id: 'call-1', name: 'lookup', arguments: '{"id":"A1"}' }] } },
    { deltas: ['A1 is ready.'], reply: { text: 'A1 is ready.' } },
  ]));
  assert.deepEqual(types, ['RUN_STARTED', 'STEP_STARTED', 'TEXT_MESSAGE_START', 'TEXT_MESSAGE_CONTENT', 'TEXT_MESSAGE_CONTENT',
    'TEXT_MESSAGE_END', 'STEP_FINISHED', 'TOOL_CALL_START', 'TOOL_CALL_ARGS', 'TOOL_CALL_END', 'TOOL_CALL_RESULT',
    'STEP_STARTED', 'TEXT_MESSAGE_START', 'TEXT_MESSAGE_CONTENT', 'TEXT_MESSAGE_END', 'STEP_FINISHED', 'RUN_FINISHED']);
  assert.deepEqual(events[0], { type: 'RUN_STARTED', threadId: 't1', runId: 'client-run' });
  const [first, second] = events.filter(({ type }) => type === 'TEXT_MESSAGE_START');
  assert.notEqual(first.messageId, second.messageId);
  assert.deepEqual(events.find(({ type }) => type === 'TOOL_CALL_START'),
    { type: 'TOOL_CALL_START', toolCallId: 'call-1', toolCallName: 'lookup', parentMessageId: first.messageId });
  assert.equal(events.find(({ type }) => type === 'TOOL_CALL_ARGS').delta, '{"id":"A1"}');
  assert.deepEqual(JSON.parse(events.find(({ type }) => type === 'TOOL_CALL_RESULT').content), { status: 'completed' });
  assert.doesNotMatch(JSON.stringify(events), /secret-owner/);
  assert.deepEqual(events.at(-1), { type: 'RUN_FINISHED', threadId: 't1', runId: 'client-run', result: { status: 'completed' } });
});

test('AG-UI sends a reply the run did not stream as one text message, and a failed run as RUN_ERROR', async () => {
  const propose = defineTool({
    name: 'propose', description: 'Propose', parameters: { type: 'object', properties: {} },
    execute: (_args, { reply }) => reply('Đã tạo đề xuất.', { actionId: 'act-1' }),
  });
  const replied = await agUi({ tools: [propose] }, {
    async generate() {
      return { toolCalls: [{ id: 'c1', name: 'propose', arguments: '{}' }] };
    },
  });
  assert.deepEqual(replied.types.slice(-4), ['TEXT_MESSAGE_START', 'TEXT_MESSAGE_CONTENT', 'TEXT_MESSAGE_END', 'RUN_FINISHED']);
  assert.equal(replied.events.at(-3).delta, 'Đã tạo đề xuất.');
  assert.deepEqual(replied.events.at(-1).result, { status: 'completed', data: { actionId: 'act-1' } });

  const failed = await agUi({}, {
    async generate() {
      throw new ModelError('provider_unavailable', 'The model is down.');
    },
  });
  assert.deepEqual(failed.types, ['RUN_STARTED', 'STEP_STARTED', 'STEP_FINISHED', 'RUN_ERROR']);
  assert.deepEqual(failed.events.at(-1), { type: 'RUN_ERROR', message: 'The model is down.', code: 'provider_unavailable' });
});

test('AG-UI carries forms as custom events and lists the open ones in a state snapshot', async () => {
  const propose = defineTool({
    name: 'propose', description: 'Propose', parameters: { type: 'object', properties: {} },
    result: { type: 'object', 'x-form': 'confirm' },
    forms: { confirm: { html: '<form><button>Send</button></form>', submit: () => ({ sent: true }) } },
    execute: () => ({ draftId: 'd1' }),
  });
  const model = {
    async generate({ steps }) {
      return steps.length ? { text: 'Check the form.' } : { toolCalls: [{ id: 'c1', name: 'propose', arguments: '{}' }] };
    },
  };
  const { events, types } = await agUi({ tools: [propose] }, model, { state: { theme: 'dark' } });
  assert.deepEqual(types.slice(-4), ['TEXT_MESSAGE_END', 'CUSTOM', 'STATE_SNAPSHOT', 'RUN_FINISHED']);
  const { name, value } = events.find(({ type }) => type === 'CUSTOM');
  assert.deepEqual([name, value.tool, value.form, value.status, value.data, value.mimeType],
    [agUiFormEvent, 'propose', 'confirm', 'open', { draftId: 'd1' }, 'text/html;profile=mcp-app']);
  assert.equal(value.html, formAppHtml('<form><button>Send</button></form>', { tool: 'propose', form: 'confirm', submit: true }));
  assert.deepEqual(events.find(({ type }) => type === 'STATE_SNAPSHOT').snapshot,
    { theme: 'dark', forms: [{ id: value.id, tool: 'propose', form: 'confirm', toolCallId: 'c1' }] });
});

test('readAgUiInput takes the last user message and rejects input that is not an AG-UI run', () => {
  assert.deepEqual(readAgUiInput({
    threadId: 't1', runId: 'r1', state: { theme: 'dark' }, forwardedProps: { appId: 'app' }, tools: [], context: [],
    messages: [
      { id: '1', role: 'user', content: 'First' }, { id: '2', role: 'assistant', content: 'Hi' },
      { id: '3', role: 'user', content: [{ type: 'text', text: 'Look up' }, { type: 'binary', mimeType: 'image/png' }, { type: 'text', text: 'A1' }] },
      { id: '4', role: 'tool', toolCallId: 'c1', content: 'ignored' },
    ],
  }), { threadId: 't1', runId: 'r1', message: 'Look up\nA1', state: { theme: 'dark' }, forwardedProps: { appId: 'app' } });
  for (const [body, pattern] of [
    [null, /JSON object/], [{ messages: [] }, /threadId/], [{ threadId: 't', runId: 5, messages: [] }, /runId/],
    [{ threadId: 't' }, /messages/], [{ threadId: 't', messages: [{ role: 'assistant', content: 'Hi' }] }, /no user message/],
  ]) {
    assert.throws(() => readAgUiInput(body), (error) => error instanceof TypeError && pattern.test(error.message));
  }
});

test('AG-UI sends a call waiting for approval as a custom event and finishes the run as interrupted', async () => {
  const submit = defineTool({
    name: 'request_leave', description: 'Request leave', parameters: { type: 'object', properties: { days: { type: 'number' } } },
    approval: true, execute: () => ({ requestId: 'L1' }),
  });
  const model = {
    async generate({ steps }) {
      return steps.length ? { text: 'Submitted.' } : { toolCalls: [{ id: 'c1', name: 'request_leave', arguments: '{"days":2}' }] };
    },
  };
  const { result, events, types } = await agUi({ tools: [submit] }, model, { state: { theme: 'dark' } });
  assert.equal(result.status, 'interrupted');
  assert.deepEqual(types, ['RUN_STARTED', 'STEP_STARTED', 'STEP_FINISHED', 'TOOL_CALL_START', 'TOOL_CALL_ARGS', 'TOOL_CALL_END',
    'CUSTOM', 'STATE_SNAPSHOT', 'RUN_FINISHED']);
  const [approval] = result.interruptions;
  assert.deepEqual(events[6], { type: 'CUSTOM', name: agUiApprovalEvent, value: approval });
  assert.deepEqual([approval.tool, approval.toolCallId, approval.arguments], ['request_leave', 'c1', { days: 2 }]);
  assert.deepEqual(events[7].snapshot, { theme: 'dark', approvals: [approval] });
  assert.deepEqual(events.at(-1), { type: 'RUN_FINISHED', threadId: 't1', runId: 'client-run',
    result: { status: 'interrupted', interruptions: [approval] } });
});

test('AG-UI sends the reply of a guardrail that blocked the message, and finishes the run as blocked', async () => {
  const input = () => ({ allowed: false, reason: 'off topic', reply: 'Mình chỉ hỗ trợ việc nghỉ phép.' });
  const model = {
    async generate() {
      throw new Error('A blocked message does not reach the model.');
    },
  };
  const blocked = await agUi({ guardrails: { input } }, model);
  assert.equal(blocked.result.status, 'blocked');
  assert.deepEqual(blocked.types, ['RUN_STARTED', 'TEXT_MESSAGE_START', 'TEXT_MESSAGE_CONTENT', 'TEXT_MESSAGE_END', 'RUN_FINISHED']);
  assert.equal(blocked.events[2].delta, 'Mình chỉ hỗ trợ việc nghỉ phép.');
  assert.deepEqual(blocked.events.at(-1).result, { status: 'blocked', stage: 'input', error: blocked.result.error });
  assert.equal(blocked.result.error.code, 'input_blocked');

  // An output guardrail reads the whole reply first, so nothing of the withheld reply was streamed.
  const output = (text) => !text.includes('secret');
  const withheld = await agUi({ guardrails: { output } }, {
    async generate() {
      return { text: 'The secret is 42.' };
    },
    async stream() {
      throw new Error('A reply an output guardrail checks is not streamed.');
    },
  });
  assert.equal(withheld.result.status, 'blocked');
  assert.doesNotMatch(JSON.stringify(withheld.events), /secret is 42/);
  assert.deepEqual(withheld.events.at(-1).result, { status: 'blocked', stage: 'output', error: withheld.result.error });
});
