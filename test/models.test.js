import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSDK, defineTool } from 'agent-studio-sdk';
import { createModel } from 'agent-studio-sdk/models';

const args = { id: 'DH123' };
const tool = defineTool({
  name: 'lookup', description: 'Find order',
  parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  execute: ({ id }) => ({ id, status: 'shipping' }),
});
const input = { sessionId: '1', message: 'Where is order DH123?' };

test('Anthropic restores thinking and matches tool results to their tool-use IDs', async () => {
  const calls = [];
  const blocks = [{ type: 'thinking', signature: 'mock-signature', thinking: 'internal' },
    { type: 'tool_use', id: 'toolu_1', name: 'lookup', input: args }];
  const model = createModel({ provider: 'anthropic', model: 'claude-test', apiKey: 'fake', reasoningEffort: 'medium',
    fetch: async (url, options) => {
      assert.equal(url, 'https://api.anthropic.com/v1/messages');
      assert.equal(options.headers['x-api-key'], 'fake');
      calls.push(JSON.parse(options.body));
      return Response.json({ content: calls.length === 1 ? blocks : [{ type: 'text', text: 'Done.' }] });
    },
  });
  const result = await createSDK({ model }).createAgent({ systemPrompt: 'Check orders', tools: [tool] }).run(input);
  assert.equal(result.text, 'Done.');
  assert.deepEqual(calls[0].output_config, { effort: 'medium' });
  assert.deepEqual(calls[0].thinking, { type: 'adaptive' });
  assert.equal(calls[0].tools[0].input_schema.type, 'object');
  assert.deepEqual(calls[1].messages.at(-2), { role: 'assistant', content: blocks });
  assert.equal(calls[1].messages.at(-1).content[0].tool_use_id, 'toolu_1');
});

test('Anthropic marks the tools, the system prompt and the conversation end as cache breakpoints', async () => {
  const calls = [];
  const usage = { input_tokens: 5, cache_read_input_tokens: 900, cache_creation_input_tokens: 40, output_tokens: 3 };
  const reply = (body) => Response.json({ content: body, usage });
  const fetch = async (url, options) => {
    calls.push(JSON.parse(options.body));
    return calls.length % 2 ? reply([{ type: 'tool_use', id: 'toolu_1', name: 'lookup', input: args }]) : reply([{ type: 'text', text: 'Done.' }]);
  };
  const extra = defineTool({ name: 'other', description: 'Other', parameters: { type: 'object' }, execute: () => 'x' });
  const cached = createModel({ provider: 'anthropic', model: 'claude-test', apiKey: 'fake', fetch });
  const result = await createSDK({ model: cached }).createAgent({ systemPrompt: 'Check orders', tools: [tool, extra] }).run(input);
  const ephemeral = { type: 'ephemeral' };
  assert.deepEqual(calls[0].system, [{ type: 'text', text: 'Check orders', cache_control: ephemeral }]);
  assert.deepEqual(calls[0].tools.map((entry) => entry.cache_control), [undefined, ephemeral]);
  assert.deepEqual(calls[0].messages, [{ role: 'user', content: [{ type: 'text', text: input.message, cache_control: ephemeral }] }]);
  assert.equal(calls[1].messages[0].content[0].cache_control, undefined, 'only the last message carries a breakpoint');
  assert.deepEqual(calls[1].messages.at(-1).content.at(-1).cache_control, ephemeral);
  assert.equal(JSON.stringify(calls[1]).match(/cache_control/g).length, 3);
  assert.deepEqual([result.usage.promptTokens, result.usage.cachedTokens], [2 * 945, 2 * 900]);

  calls.length = 0;
  const plain = createModel({ provider: 'anthropic', model: 'claude-test', apiKey: 'fake', fetch, promptCaching: false });
  await createSDK({ model: plain }).createAgent({ systemPrompt: 'Check orders', tools: [tool] }).run(input);
  assert.equal(calls[0].system, 'Check orders');
  assert.ok(!JSON.stringify(calls).includes('cache_control'));
  assert.throws(() => createModel({ provider: 'anthropic', model: 'x', apiKey: 'fake', promptCaching: 'yes' }), TypeError);
});

test('Gemini preserves function-call signatures and keeps thought parts out of the reply', async () => {
  const calls = [];
  const first = { role: 'model', parts: [{ functionCall: { name: 'lookup', id: 'fc1', args }, thoughtSignature: 'mock-signature' }] };
  const model = createModel({ provider: 'gemini', model: 'gemini-3.1-pro-preview', apiKey: 'fake', reasoningEffort: 'low',
    fetch: async (url, options) => {
      assert.equal(url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-pro-preview:generateContent');
      assert.equal(options.headers['x-goog-api-key'], 'fake');
      calls.push(JSON.parse(options.body));
      const content = calls.length === 1 ? first : { role: 'model', parts: [{ thought: true, text: 'internal' }, { text: 'Done.' }] };
      return Response.json({ candidates: [{ content }] });
    },
  });
  const result = await createSDK({ model }).createAgent({ systemPrompt: 'Check orders', tools: [tool] }).run(input);
  assert.equal(result.text, 'Done.');
  assert.deepEqual(calls[0].generationConfig, { thinkingConfig: { thinkingLevel: 'LOW' } });
  assert.equal(calls[0].tools[0].functionDeclarations[0].parametersJsonSchema.type, 'object');
  assert.deepEqual(calls[1].contents.at(-2), first);
  assert.deepEqual(calls[1].contents.at(-1).parts[0].functionResponse, {
    name: 'lookup', id: 'fc1', response: { ok: true, value: { id: 'DH123', status: 'shipping' } },
  });
});

for (const [provider, baseUrl, reasoningKey] of [
  ['lmstudio', 'http://127.0.0.1:1234/v1', undefined],
  ['openrouter', 'https://openrouter.ai/api/v1', 'reasoning'],
  ['groq', 'https://api.groq.com/openai/v1', 'reasoning_effort'],
  ['compatible', 'http://127.0.0.1:9000/v1', 'reasoning_effort'],
]) {
  test(`${provider} sends tool outputs using Chat Completions`, async () => {
    const calls = [];
    const initial = { role: 'assistant', content: null, tool_calls: [{
      type: 'function', id: 'call_1', function: { name: 'lookup', arguments: JSON.stringify(args) },
    }], ...(provider === 'openrouter' ? { reasoning_details: [{ id: 'mock-details' }] } : {}) };
    const model = createModel({ provider, model: 'test', apiKey: 'stub', baseUrl,
      reasoningEffort: reasoningKey ? 'high' : 'default', fetch: async (url, options) => {
        assert.equal(url, `${baseUrl}/chat/completions`);
        const body = JSON.parse(options.body);
        calls.push(body);
        if (body.stream !== false) return new Response('data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
        return Response.json({ choices: [{ message: calls.length === 1 ? initial : { role: 'assistant', content: 'Done.' } }] });
      },
    });
    const result = await createSDK({ model }).createAgent({ systemPrompt: 'Check orders', tools: [tool] }).run(input);
    assert.equal(result.text, 'Done.');
    if (reasoningKey) assert.deepEqual(calls[0][reasoningKey], reasoningKey === 'reasoning' ? { effort: 'high' } : 'high');
    else assert.equal(calls[0].reasoning_effort, undefined);
    assert.deepEqual(calls[1].messages.at(-2), initial);
    assert.equal(calls[1].messages.at(-1).tool_call_id, 'call_1');
  });
}

test('reports a specific error when a compatible gateway returns an unexpected response format', async () => {
  for (const [headers, body, code] of [
    [{ 'Content-Type': 'text/event-stream; charset=utf-8' }, 'data: [DONE]\n\n', 'provider_stream_response'],
    [{ 'Content-Type': 'text/html' }, '<html>Not the API</html>', 'provider_invalid_response'],
  ]) {
    const model = createModel({ provider: 'compatible', model: 'test', baseUrl: 'http://127.0.0.1:9000/v1',
      fetch: async () => new Response(body, { headers }),
    });
    const result = await createSDK({ model }).createAgent({ systemPrompt: 'Answer' }).run(input);
    assert.equal(result.status, 'error');
    assert.equal(result.error.code, code);
  }
});

test('each provider sends attached files before the text, in the turn they came with only', async () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]).toString('base64');
  const pdf = Buffer.from('%PDF-1.7\n%%EOF\n').toString('base64');
  const image = { name: 'giay-kham.png', mediaType: 'image/png', data: png };
  const document = { name: 'don.pdf', mediaType: 'application/pdf', data: pdf };
  const url = (type, data) => `data:${type};base64,${data}`;
  const note = (...files) => `Xin nghỉ ốm\n[Attached: ${files.map(({ name, mediaType }) => `${name} (${mediaType})`).join(', ')}]`;
  const chat = { choices: [{ message: { role: 'assistant', content: 'Đã nhận.' }, finish_reason: 'stop' }] };
  const both = note(image, document);
  for (const [options, files, reply, sent, traceName] of [
    [{ provider: 'anthropic', model: 'claude-test', apiKey: 'fake' }, [image, document],
      { content: [{ type: 'text', text: 'Đã nhận.' }], stop_reason: 'end_turn' },
      (body) => body.messages[0].content, 'anthropic'],
    [{ provider: 'gemini', model: 'gemini-test', apiKey: 'fake' }, [image, document],
      { candidates: [{ content: { role: 'model', parts: [{ text: 'Đã nhận.' }] }, finishReason: 'STOP' }] },
      (body) => body.contents[0].parts, 'gcp.gemini'],
    [{ provider: 'openrouter', model: 'test', apiKey: 'fake' }, [image, document], chat, (body) => body.messages[1].content, 'openrouter'],
    [{ provider: 'openai', model: 'gpt-test', apiKey: 'fake' }, [image, document],
      { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'Đã nhận.' }] }] },
      (body) => body.input[0].content, 'openai'],
    [{ provider: 'groq', model: 'test', apiKey: 'fake' }, [image], chat, (body) => body.messages[1].content, 'groq'],
    [{ provider: 'ollama', model: 'qwen3' }, [image],
      { message: { role: 'assistant', content: 'Đã nhận.' }, done_reason: 'stop' }, (body) => body.messages[1], 'ollama'],
  ]) {
    const bodies = [];
    const model = createModel({ ...options, fetch: async (_url, init) => {
      bodies.push(JSON.parse(init.body));
      return Response.json(reply);
    } });
    assert.deepEqual([model.provider, model.model], [traceName, options.model]);
    const agent = createSDK({ model }).createAgent({ systemPrompt: 'Answer' });
    const result = await agent.run({ sessionId: 's1', message: 'Xin nghỉ ốm', attachments: files });
    assert.equal(result.status, 'completed', options.provider);
    const text = note(...files);
    const expected = {
      anthropic: [
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png } },
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdf }, title: 'don.pdf' },
        { type: 'text', text: both, cache_control: { type: 'ephemeral' } }],
      gemini: [{ inlineData: { mimeType: 'image/png', data: png } }, { inlineData: { mimeType: 'application/pdf', data: pdf } }, { text: both }],
      openrouter: [{ type: 'image_url', image_url: { url: url('image/png', png) } },
        { type: 'file', file: { filename: 'don.pdf', file_data: url('application/pdf', pdf) } }, { type: 'text', text: both }],
      openai: [{ type: 'input_image', image_url: url('image/png', png) },
        { type: 'input_file', filename: 'don.pdf', file_data: url('application/pdf', pdf) }, { type: 'input_text', text: both }],
      groq: [{ type: 'image_url', image_url: { url: url('image/png', png) } }, { type: 'text', text }],
      ollama: { role: 'user', content: text, images: [png] },
    }[options.provider];
    assert.deepEqual(sent(bodies[0]), expected, options.provider);
    assert.doesNotMatch(JSON.stringify(bodies[0]), /"attachments"/, `${options.provider} keeps the SDK field out of the request`);

    // The next turn reads the note of the earlier files, not the files.
    await agent.run({ sessionId: 's1', message: 'Còn bao nhiêu ngày phép?' });
    assert.ok(!JSON.stringify(bodies[1]).includes(png), `${options.provider} sends the file in its own turn only`);
    assert.ok(JSON.stringify(bodies[1]).includes(JSON.stringify(text).slice(1, -1)), options.provider);
  }
});

test('a model that cannot read a type of file answers attachments_unsupported without a request', async () => {
  const pdf = Buffer.from('%PDF-1.7\n%%EOF\n').toString('base64');
  const gif = Buffer.from('GIF89a\x01\x00\x01\x00', 'latin1').toString('base64');
  for (const [options, file] of [
    [{ provider: 'groq', model: 'test', apiKey: 'fake' }, { mediaType: 'application/pdf', data: pdf }],
    [{ provider: 'compatible', model: 'test', baseUrl: 'http://127.0.0.1:9000/v1' }, { mediaType: 'application/pdf', data: pdf }],
    [{ provider: 'ollama', model: 'qwen3' }, { mediaType: 'image/gif', data: gif }],
  ]) {
    let requests = 0;
    const model = createModel({ ...options, fetch: async () => {
      requests++;
      return Response.json({});
    } });
    const result = await createSDK({ model }).createAgent({ systemPrompt: 'Answer' })
      .run({ sessionId: 's1', message: 'See file', attachments: [file] });
    assert.equal(result.error?.code, 'attachments_unsupported', options.provider);
    assert.equal(requests, 0, options.provider);
  }
});
