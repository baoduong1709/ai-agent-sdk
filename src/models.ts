import { ModelError } from './index.js';
import { parseHttpUrl } from './http-tool.js';
import { createOpenAIModel } from './openai.js';
import {
  bodyLines, filteredReply, incompleteStream, invalidResponse, openStream, readMaxRetries, sendToProvider, serverSentEvents,
  contextExceeded, streamChunk, streamError, truncatedReply, type Transport,
} from './transport.js';
import { attachmentTypes, dataUrl, fileName, imageTypes } from './attachments.js';
import type { AttachmentType, ModelAdapter, ModelInput, ModelMessage, ModelReply, ModelUsage, ToolCall, ToolDescription } from './types.js';

export type ReasoningEffort = 'default' | 'off' | 'on' | 'none' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
type Provider = {
  label: string;
  endpoint: string;
  customEndpoint?: boolean;
  apiKeyEnv?: string;
  efforts: readonly ReasoningEffort[];
};

const levels = ['default', 'low', 'medium', 'high'] as const;

export const modelProviders = {
  ollama: { label: 'Ollama', endpoint: 'http://127.0.0.1:11434', customEndpoint: true, efforts: [...levels, 'on', 'off'] },
  lmstudio: { label: 'LM Studio', endpoint: 'http://127.0.0.1:1234/v1', customEndpoint: true, efforts: ['default'] },
  openai: { label: 'OpenAI', endpoint: 'https://api.openai.com/v1', apiKeyEnv: 'OPENAI_API_KEY', efforts: [...levels, 'none', 'xhigh', 'max'] },
  anthropic: { label: 'Anthropic', endpoint: 'https://api.anthropic.com/v1', apiKeyEnv: 'ANTHROPIC_API_KEY', efforts: levels },
  gemini: { label: 'Google Gemini', endpoint: 'https://generativelanguage.googleapis.com/v1beta', apiKeyEnv: 'GEMINI_API_KEY', efforts: levels },
  openrouter: { label: 'OpenRouter', endpoint: 'https://openrouter.ai/api/v1', apiKeyEnv: 'OPENROUTER_API_KEY', efforts: [...levels, 'none', 'xhigh'] },
  groq: { label: 'Groq', endpoint: 'https://api.groq.com/openai/v1', apiKeyEnv: 'GROQ_API_KEY', efforts: [...levels, 'none'] },
  compatible: { label: 'OpenAI-compatible', endpoint: '', customEndpoint: true, efforts: [...levels, 'none'] },
} satisfies Record<string, Provider>;

export type ModelProvider = keyof typeof modelProviders;

export interface ModelOptions {
  provider: ModelProvider;
  model: string;
  baseUrl?: string;
  apiKey?: string;
  reasoningEffort?: ReasoningEffort;
  fetch?: typeof fetch;
  /** Extra request headers, for gateways that need their own switches. */
  headers?: Record<string, string>;
  /** Extra top-level request body fields, merged last. */
  body?: Record<string, unknown>;
  /** Retries for connection failures, 408, 429 and 5xx responses (0..5, default 2). */
  maxRetries?: number;
  /**
   * Anthropic only: marks the tools, the system prompt and the end of the conversation as prompt-cache breakpoints
   * (default true). Other providers cache prompt prefixes on their own.
   */
  promptCaching?: boolean;
}

function functionTools(tools: ToolDescription[]) {
  return tools.length ? { tools: tools.map((tool) => ({ type: 'function', function: tool })) } : {};
}

/** True when the run asks for a text answer and there are tools to switch off. Merged after body extras so it wins. */
function toolsWithdrawn({ tools, toolChoice }: ModelInput) {
  return toolChoice === 'none' && tools.length > 0;
}

/** A reply a server sent whole to a streaming request reaches the caller as one delta. */
function sentWhole(reply: ModelReply, onDelta: (text: string) => void) {
  if (reply.text) onDelta(reply.text);
  return reply;
}

function bearer(apiKey?: string) {
  return apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined;
}

async function post<Data>(transport: Transport, url: string, headers: Record<string, string> | undefined,
  body: unknown, signal: AbortSignal): Promise<Data> {
  const response = await sendToProvider(transport, url, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
  }, signal);
  if (response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() === 'text/event-stream') {
    await response.body?.cancel();
    throw new ModelError('provider_stream_response', 'The model provider returned an event stream for a non-streaming request.');
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch (error) {
    if (signal.aborted) throw error;
    invalidResponse();
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) invalidResponse();
  return payload as Data;
}

interface Connection extends Transport {
  model: string;
  baseUrl: string;
  apiKey?: string;
  effort?: ReasoningEffort;
  headers?: Record<string, string>;
  body?: Record<string, unknown>;
  caching?: boolean;
}

/** Chat Completions stop reasons that mean the reply is not whole. */
function checkFinishReason(reason?: string | null) {
  if (reason === 'length') throw truncatedReply();
  if (reason === 'content_filter') throw filteredReply();
}

/**
 * Chat Completions messages. Files come before the text: images as image_url data URLs and, where the gateway takes
 * them (OpenRouter), PDF documents as file parts.
 */
function chatMessages({ systemPrompt, history }: ModelInput): unknown[] {
  return [{ role: 'system', content: systemPrompt }, ...history.map(({ role, content, attachments }) => attachments?.length
    ? { role, content: [
      ...attachments.map((file, index) => file.mediaType === 'application/pdf'
        ? { type: 'file', file: { filename: fileName(file, index), file_data: dataUrl(file) } }
        : { type: 'image_url', image_url: { url: dataUrl(file) } }),
      { type: 'text', text: content },
    ] }
    : { role, content })];
}

/** Ollama messages, with images as plain base64 next to the text. */
function ollamaMessages({ systemPrompt, history }: ModelInput): unknown[] {
  return [{ role: 'system', content: systemPrompt }, ...history.map(({ role, content, attachments }) => attachments?.length
    ? { role, content, images: attachments.map(({ data }) => data) }
    : { role, content })];
}

/** Reasoning models that leak their scratchpad wrap it in a think tag the caller must not see. */
export function stripThinking(text?: string | null) {
  return text?.replace(/<think>[\s\S]*?(?:<\/think>|$)/g, '').trim() || undefined;
}

/** The part of a partial stream that is safe to show: no scratchpad and no half-written tag. */
function visibleText(content: string) {
  return content.replace(/<think>[\s\S]*?(?:<\/think>|$)/g, '').replace(/<\/?t(?:h(?:i(?:n(?:k>?)?)?)?)?$/, '').trimStart();
}

type OpenAIUsage = { prompt_tokens?: number; completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number } };

function chatUsage(usage?: OpenAIUsage): ModelUsage | undefined {
  if (!usage) return undefined;
  return { promptTokens: usage.prompt_tokens, completionTokens: usage.completion_tokens,
    cachedTokens: usage.prompt_tokens_details?.cached_tokens };
}

type ChatMessage = {
  content?: string | null; refusal?: string;
  tool_calls?: { id: string; function: { name: string; arguments: string } }[];
};

function chatReply(message: ChatMessage, usage?: OpenAIUsage) {
  // A call without arguments can come back with an empty arguments string (Claude behind an OpenAI-compatible
  // gateway does this), and the same gateway rejects that call with HTTP 400 when it is sent back: send it as '{}'
  const calls = message.tool_calls?.map((call) => ({ ...call, function: { ...call.function, arguments: call.function.arguments || '{}' } }));
  const toolCalls = (calls ?? []).map(({ id, function: fn }) => ({ id, name: fn.name, arguments: fn.arguments }));
  return { text: stripThinking(message.content ?? message.refusal), toolCalls,
    continuation: { ...message, ...(calls ? { tool_calls: calls } : {}), role: 'assistant' }, usage: chatUsage(usage) };
}

function createCompatible(connection: Connection, openRouter: boolean): ModelAdapter {
  const { model, baseUrl, apiKey, effort, headers, body: extra } = connection;

  function payload(input: ModelInput, stream: boolean) {
    const messages = chatMessages(input);
    for (const step of input.steps) {
      messages.push(step.continuation, ...step.outputs.map(({ callId, output }) => ({
        role: 'tool', tool_call_id: callId, content: JSON.stringify(output),
      })));
    }
    const reasoning = !effort ? {} : openRouter ? { reasoning: { effort } } : { reasoning_effort: effort };
    return {
      model, messages, stream, ...(stream ? { stream_options: { include_usage: true } } : {}),
      ...functionTools(input.tools), ...reasoning, ...extra,
      ...(toolsWithdrawn(input) ? { tool_choice: 'none' } : {}),
    };
  }

  const url = `${baseUrl}/chat/completions`;
  const auth = { ...bearer(apiKey), ...headers };
  type Completion = { choices?: { message?: ChatMessage; finish_reason?: string | null }[]; usage?: OpenAIUsage };

  function completion({ choices, usage }: Completion) {
    checkFinishReason(choices?.[0]?.finish_reason);
    const message = choices?.[0]?.message;
    if (!message) invalidResponse();
    return chatReply(message, usage);
  }

  return {
    async generate(input) {
      return completion(await post<Completion>(connection, url, auth, payload(input, false), input.signal));
    },

    async stream(input, onDelta) {
      const opened = await openStream(connection, url, auth, payload(input, true), input.signal);
      if ('json' in opened) return sentWhole(completion(wholeReply<Completion>(opened.json)), onDelta);
      const message = await streamChat(connection.label, opened.body, input.signal, onDelta);
      return chatReply(message.message, message.usage);
    },
  };
}

/** A reply a server sent as one JSON body. */
function wholeReply<Data>(value: unknown): Data {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalidResponse();
  return value as Data;
}

type StreamChoice = {
  delta?: { content?: string | null; refusal?: string;
    tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[] };
  finish_reason?: string | null;
};

async function streamChat(label: string, body: ReadableStream<Uint8Array>, signal: AbortSignal, onDelta: (text: string) => void) {
  let content = '';
  let refusal = '';
  const calls = new Map<number, { id: string; function: { name: string; arguments: string } }>();
  let usage: OpenAIUsage | undefined;
  let finishReason: string | undefined;
  let shown = '';

  for await (const event of serverSentEvents(body, signal)) {
    if (event === '[DONE]') break;
    const chunk = streamChunk<{ choices?: StreamChoice[]; usage?: OpenAIUsage; error?: unknown }>(event);
    if (chunk.error) throw streamError(label);
    if (chunk.usage) usage = chunk.usage;
    const choice = chunk.choices?.[0];
    if (!choice) continue;
    if (choice.finish_reason) finishReason = choice.finish_reason;
    const delta = choice.delta;
    if (delta?.refusal) refusal += delta.refusal;
    if (typeof delta?.content === 'string' && delta.content) {
      content += delta.content;
      const visible = visibleText(content);
      if (visible.startsWith(shown) && visible.length > shown.length) {
        onDelta(visible.slice(shown.length));
        shown = visible;
      }
    }
    for (const [index, call] of (delta?.tool_calls ?? []).entries()) {
      const slot = Number.isSafeInteger(call.index) ? call.index! : index;
      if (slot < 0 || slot > 63) invalidResponse();
      const existing = calls.get(slot) ?? { id: '', function: { name: '', arguments: '' } };
      if (call.id) existing.id = call.id;
      if (call.function?.name) existing.function.name = call.function.name;
      if (call.function?.arguments) existing.function.arguments += call.function.arguments;
      calls.set(slot, existing);
    }
  }
  if (!finishReason) throw incompleteStream();
  checkFinishReason(finishReason);

  const tool_calls = [...calls.keys()].sort((first, second) => first - second)
    .map((slot) => ({ type: 'function', ...calls.get(slot)! }));
  for (const call of tool_calls) {
    if (!call.id || !call.function.name) invalidResponse();
  }
  return { message: { content: content || null, ...(refusal ? { refusal } : {}),
    ...(tool_calls.length ? { tool_calls } : {}) } satisfies ChatMessage, usage };
}

/** Sends the part of the streamed text that became visible and returns all that is shown so far. */
function showDelta(content: string, shown: string, onDelta: (text: string) => void) {
  const visible = visibleText(content);
  if (!visible.startsWith(shown) || visible.length <= shown.length) return shown;
  onDelta(visible.slice(shown.length));
  return visible;
}

type NamedCall = { function: { name: string; arguments: Record<string, unknown> | string } };
type OllamaMessage = { role?: string; content?: string; thinking?: string; tool_calls?: NamedCall[] };
type OllamaChunk = {
  message?: OllamaMessage; done?: boolean; done_reason?: string; prompt_eval_count?: number; eval_count?: number; error?: unknown;
};

function createOllama(connection: Connection): ModelAdapter {
  const { model, baseUrl, apiKey, effort, headers, body: extra } = connection;
  const url = `${baseUrl}/api/chat`;
  const auth = { ...bearer(apiKey), ...headers };

  function payload(input: ModelInput, stream: boolean) {
    const messages = ollamaMessages(input);
    for (const step of input.steps) {
      const previous = step.continuation as { tool_calls: NamedCall[] };
      messages.push(previous, ...step.outputs.map(({ output }, index) => ({
        role: 'tool', tool_name: previous.tool_calls[index].function.name, content: JSON.stringify(output),
      })));
    }
    const think = effort === 'on' ? true : effort === 'off' ? false : effort;
    return {
      // Ollama has no tool choice setting, so a closing call leaves the tool list out instead.
      model, messages, stream, ...(toolsWithdrawn(input) ? {} : functionTools(input.tools)),
      ...(think !== undefined ? { think } : {}), ...extra,
    };
  }

  function reply(input: ModelInput, { message, done_reason, prompt_eval_count, eval_count }: OllamaChunk): ModelReply {
    if (done_reason === 'length') throw truncatedReply();
    if (!message) invalidResponse();
    const toolCalls = (message.tool_calls ?? []).map(({ function: fn }, index) => ({
      id: `ollama-${input.steps.length}-${index}`, name: fn.name,
      arguments: typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments),
    }));
    const counted = prompt_eval_count !== undefined || eval_count !== undefined;
    return { text: stripThinking(message.content), toolCalls, continuation: { ...message, role: 'assistant' },
      ...(counted ? { usage: { promptTokens: prompt_eval_count, completionTokens: eval_count } } : {}) };
  }

  return {
    async generate(input) {
      return reply(input, await post<OllamaChunk>(connection, url, auth, payload(input, false), input.signal));
    },

    async stream(input, onDelta) {
      const opened = await openStream(connection, url, auth, payload(input, true), input.signal);
      if ('json' in opened) return sentWhole(reply(input, wholeReply<OllamaChunk>(opened.json)), onDelta);
      let content = '';
      let thinking = '';
      let shown = '';
      const calls: NamedCall[] = [];
      let last: OllamaChunk | undefined;
      // One JSON object per line; the last one has done set, with the stop reason and token counts.
      for await (const line of bodyLines(opened.body, input.signal)) {
        if (!line) continue;
        const chunk = streamChunk<OllamaChunk>(line);
        if (chunk.error) throw streamError(connection.label);
        const message = chunk.message;
        if (typeof message?.thinking === 'string') thinking += message.thinking;
        if (Array.isArray(message?.tool_calls)) calls.push(...message.tool_calls);
        if (typeof message?.content === 'string' && message.content) {
          content += message.content;
          shown = showDelta(content, shown, onDelta);
        }
        if (chunk.done) {
          last = chunk;
          break;
        }
      }
      if (!last) throw incompleteStream();
      return reply(input, { ...last, message: {
        role: 'assistant', content, ...(thinking ? { thinking } : {}), ...(calls.length ? { tool_calls: calls } : {}),
      } });
    },
  };
}

type AnthropicBlock = {
  type: string; text?: string; thinking?: string; signature?: string; id?: string; name?: string; input?: unknown;
  citations?: unknown[]; [key: string]: unknown;
};
type AnthropicUsage = {
  input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number;
};
type AnthropicMessage = { content?: AnthropicBlock[]; stop_reason?: string | null; usage?: AnthropicUsage };
type AnthropicEvent = {
  type?: string; index?: number; message?: AnthropicMessage; content_block?: AnthropicBlock; usage?: AnthropicUsage;
  delta?: {
    type?: string; text?: string; partial_json?: string; thinking?: string; signature?: string; citation?: unknown;
    stop_reason?: string | null;
  };
};

/** Anthropic counts cache reads and writes apart from input_tokens; promptTokens is the whole prompt, as other providers report it. */
function anthropicUsage(usage?: AnthropicUsage): ModelUsage {
  const counts = [usage?.input_tokens, usage?.cache_read_input_tokens, usage?.cache_creation_input_tokens];
  const promptTokens = counts.some((count) => count !== undefined)
    ? counts.reduce<number>((sum, count) => sum + (count ?? 0), 0) : undefined;
  return { promptTokens, completionTokens: usage?.output_tokens, cachedTokens: usage?.cache_read_input_tokens };
}

const ephemeral = { cache_control: { type: 'ephemeral' } } as const;
type AnthropicTurn = { role: string; content: unknown };

/** Makes the end of the conversation a cache breakpoint, so the next step and the next turn read what came before from the cache. */
function cachedTail(messages: AnthropicTurn[]) {
  const last = messages.at(-1);
  if (!last) return messages;
  const blocks = typeof last.content === 'string' ? [{ type: 'text', text: last.content }] : [...last.content as object[]];
  if (!blocks.length) return messages;
  blocks[blocks.length - 1] = { ...blocks.at(-1), ...ephemeral };
  return [...messages.slice(0, -1), { ...last, content: blocks }];
}

/** A history message for the Messages API; files come before the text, as image and document blocks. */
function anthropicTurn({ role, content, attachments }: ModelMessage): AnthropicTurn {
  if (!attachments?.length) return { role, content };
  return { role, content: [
    ...attachments.map((file) => file.mediaType === 'application/pdf'
      ? { type: 'document', source: { type: 'base64', media_type: file.mediaType, data: file.data },
        ...(file.name ? { title: file.name } : {}) }
      : { type: 'image', source: { type: 'base64', media_type: file.mediaType, data: file.data } }),
    { type: 'text', text: content },
  ] };
}

function createAnthropic(connection: Connection): ModelAdapter {
  const { model, baseUrl, apiKey, effort, headers, body: extra, caching = true } = connection;
  const url = `${baseUrl}/messages`;
  const auth = { 'x-api-key': apiKey!, 'anthropic-version': '2023-06-01', ...headers };

  function payload(input: ModelInput, stream: boolean) {
    const messages: AnthropicTurn[] = input.history.map(anthropicTurn);
    for (const step of input.steps) {
      messages.push({ role: 'assistant', content: step.continuation }, {
        role: 'user', content: step.outputs.map(({ callId, output }) => ({
          type: 'tool_result', tool_use_id: callId, content: JSON.stringify(output), ...(!output.ok ? { is_error: true } : {}),
        })),
      });
    }
    const thinking = effort ? { thinking: { type: 'adaptive' }, output_config: { effort } } : {};
    // The cache prefix runs tools, then system, then messages; one breakpoint closes each part.
    const tools = input.tools.map(({ name, description, parameters }, index, all) => ({
      name, description, input_schema: parameters, ...(caching && index === all.length - 1 ? ephemeral : {}),
    }));
    const system = !input.systemPrompt ? {} : caching
      ? { system: [{ type: 'text', text: input.systemPrompt, ...ephemeral }] } : { system: input.systemPrompt };
    return {
      model, ...system, messages: caching ? cachedTail(messages) : messages,
      max_tokens: effort === 'high' ? 16_384 : 8192, ...thinking,
      ...(tools.length ? { tools } : {}), ...(stream ? { stream } : {}), ...extra,
      ...(toolsWithdrawn(input) ? { tool_choice: { type: 'none' } } : {}),
    };
  }

  function reply({ content, stop_reason, usage }: AnthropicMessage): ModelReply {
    if (stop_reason === 'max_tokens') throw truncatedReply();
    if (stop_reason === 'model_context_window_exceeded') throw contextExceeded();
    if (stop_reason === 'refusal') throw filteredReply();
    if (!Array.isArray(content)) invalidResponse();
    const toolCalls = content.filter(({ type }) => type === 'tool_use').map((part) => ({
      id: part.id!, name: part.name!, arguments: JSON.stringify(part.input),
    }));
    const text = content.filter(({ type }) => type === 'text').map(({ text }) => text).join('\n');
    return { text, toolCalls, continuation: content, usage: anthropicUsage(usage) };
  }

  return {
    async generate(input) {
      return reply(await post<AnthropicMessage>(connection, url, auth, payload(input, false), input.signal));
    },

    async stream(input, onDelta) {
      const opened = await openStream(connection, url, auth, payload(input, true), input.signal);
      if ('json' in opened) return sentWhole(reply(wholeReply<AnthropicMessage>(opened.json)), onDelta);
      // The blocks are rebuilt from their deltas, so thinking signatures and tool inputs go back as Anthropic sent them.
      const blocks: AnthropicBlock[] = [];
      const inputs = new Map<number, string>();
      let usage: AnthropicUsage = {};
      let stopReason: string | null | undefined;
      let stopped = false;
      let textShown = false;
      for await (const data of serverSentEvents(opened.body, input.signal)) {
        const event = streamChunk<AnthropicEvent>(data);
        if (event.type === 'error') throw streamError(connection.label);
        if (event.type === 'message_start') {
          usage = { ...event.message?.usage };
          continue;
        }
        if (event.type === 'message_delta') {
          stopReason = event.delta?.stop_reason ?? stopReason;
          usage = { ...usage, ...event.usage };
          continue;
        }
        if (event.type === 'message_stop') {
          stopped = true;
          break;
        }
        if (!event.type?.startsWith('content_block_')) continue;
        const index = event.index!;
        if (!Number.isSafeInteger(index) || index < 0 || index > 255) invalidResponse();
        if (event.type === 'content_block_start') {
          if (!event.content_block || typeof event.content_block.type !== 'string') invalidResponse();
          blocks[index] = { ...event.content_block };
          continue;
        }
        const block = blocks[index];
        if (!block) invalidResponse();
        if (event.type === 'content_block_stop') {
          const json = inputs.get(index);
          if (json) {
            try {
              block.input = JSON.parse(json);
            } catch {
              invalidResponse();
            }
          }
          continue;
        }
        const delta = event.delta;
        if (event.type !== 'content_block_delta' || !delta) continue;
        if (delta.type === 'text_delta' && typeof delta.text === 'string') {
          if (delta.text) {
            // The reply joins text blocks with a line break.
            if (!block.text && textShown) onDelta('\n');
            textShown = true;
            onDelta(delta.text);
          }
          block.text = (block.text ?? '') + delta.text;
        } else if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
          inputs.set(index, (inputs.get(index) ?? '') + delta.partial_json);
        } else if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') {
          block.thinking = (block.thinking ?? '') + delta.thinking;
        } else if (delta.type === 'signature_delta' && typeof delta.signature === 'string') {
          block.signature = delta.signature;
        } else if (delta.type === 'citations_delta' && delta.citation !== undefined) {
          (block.citations ??= []).push(delta.citation);
        }
      }
      if (!stopped) throw incompleteStream();
      return reply({ content: blocks.filter(Boolean), stop_reason: stopReason, usage });
    },
  };
}

type GeminiPart = {
  text?: string; thought?: boolean; thoughtSignature?: string; functionCall?: { name: string; id?: string; args?: object };
};
type GeminiContent = { role: string; parts: GeminiPart[] };
type GeminiResponse = {
  candidates?: { content?: GeminiContent; finishReason?: string }[]; promptFeedback?: { blockReason?: string };
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; cachedContentTokenCount?: number };
  error?: unknown;
};

function geminiThinking(model: string, effort?: ReasoningEffort) {
  if (!effort) return {};
  if (model.startsWith('gemini-2.5-')) {
    const budgets = { low: 1024, medium: 4096, high: 8192 };
    return { generationConfig: { thinkingConfig: { thinkingBudget: budgets[effort as keyof typeof budgets] } } };
  }
  return { generationConfig: { thinkingConfig: { thinkingLevel: effort.toUpperCase() } } };
}

function geminiCalls(content: GeminiContent) {
  return content.parts.flatMap(({ functionCall }) => functionCall ? [functionCall] : []);
}

/** Gemini finish reasons that mean the provider withheld the reply on policy grounds. */
const geminiBlocked = new Set(['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'IMAGE_SAFETY']);

function createGemini(connection: Connection): ModelAdapter {
  const { model, baseUrl, apiKey, effort, headers, body: extra } = connection;
  const name = model.replace(/^models\//, '');
  const key = encodeURIComponent(name);
  const auth = { 'x-goog-api-key': apiKey!, ...headers };

  function payload(input: ModelInput) {
    const contents: unknown[] = input.history.map(({ role, content, attachments = [] }) => ({
      role: role === 'assistant' ? 'model' : 'user',
      parts: [...attachments.map(({ mediaType, data }) => ({ inlineData: { mimeType: mediaType, data } })), { text: content }],
    }));
    for (const step of input.steps) {
      const previous = step.continuation as GeminiContent;
      const calls = geminiCalls(previous);
      contents.push(previous, { role: 'user', parts: step.outputs.map(({ output }, index) => ({
        functionResponse: { name: calls[index].name, id: calls[index].id, response: output },
      })) });
    }
    return {
      systemInstruction: { parts: [{ text: input.systemPrompt }] }, contents, ...geminiThinking(name, effort),
      ...(input.tools.length ? { tools: [{ functionDeclarations: input.tools.map(({ name, description, parameters }) => ({
        name, description, parametersJsonSchema: parameters,
      })) }] } : {}), ...extra,
      ...(toolsWithdrawn(input) ? { toolConfig: { functionCallingConfig: { mode: 'NONE' } } } : {}),
    };
  }

  function reply(input: ModelInput, { candidates, promptFeedback, usageMetadata }: GeminiResponse): ModelReply {
    const finishReason = candidates?.[0]?.finishReason;
    if (promptFeedback?.blockReason || (finishReason && geminiBlocked.has(finishReason))) throw filteredReply();
    if (finishReason === 'MAX_TOKENS') throw truncatedReply();
    const content = candidates?.[0]?.content;
    if (!content || !Array.isArray(content.parts)) invalidResponse();
    const toolCalls: ToolCall[] = geminiCalls(content).map((call, index) => ({
      id: call.id ?? `gemini-${input.steps.length}-${index}`, name: call.name, arguments: JSON.stringify(call.args ?? {}),
    }));
    const text = content.parts.filter(({ thought }) => !thought).map(({ text }) => text).filter(Boolean).join('\n');
    return { text, toolCalls, continuation: { ...content, role: 'model' }, usage: {
      promptTokens: usageMetadata?.promptTokenCount, completionTokens: usageMetadata?.candidatesTokenCount,
      cachedTokens: usageMetadata?.cachedContentTokenCount,
    } };
  }

  return {
    async generate(input) {
      return reply(input, await post<GeminiResponse>(connection, `${baseUrl}/models/${key}:generateContent`, auth,
        payload(input), input.signal));
    },

    async stream(input, onDelta) {
      const opened = await openStream(connection, `${baseUrl}/models/${key}:streamGenerateContent?alt=sse`, auth,
        payload(input), input.signal);
      const parts: GeminiPart[] = [];
      let finishReason: string | undefined;
      let blockReason: string | undefined;
      let usageMetadata: GeminiResponse['usageMetadata'];
      let shownPart = -1;

      function add(chunk: GeminiResponse) {
        if (chunk.error) throw streamError(connection.label);
        if (chunk.promptFeedback?.blockReason) blockReason = chunk.promptFeedback.blockReason;
        if (chunk.usageMetadata) usageMetadata = chunk.usageMetadata;
        const candidate = chunk.candidates?.[0];
        if (candidate?.finishReason) finishReason = candidate.finishReason;
        const received = candidate?.content?.parts ?? [];
        if (!Array.isArray(received)) invalidResponse();
        for (const part of received) {
          if (!part || typeof part !== 'object') invalidResponse();
          const previous = parts.at(-1);
          // Text arrives in pieces. Pieces of one kind join into one part; a signature stays on the last piece.
          if (typeof part.text === 'string' && !part.functionCall && previous && typeof previous.text === 'string' &&
              !previous.functionCall && !previous.thoughtSignature && Boolean(previous.thought) === Boolean(part.thought)) {
            Object.assign(previous, part, { text: previous.text + part.text });
          } else {
            parts.push({ ...part });
          }
          if (part.text && !part.thought && !part.functionCall) {
            // The reply joins separate text parts with a line break.
            if (shownPart !== -1 && shownPart !== parts.length - 1) onDelta('\n');
            shownPart = parts.length - 1;
            onDelta(part.text);
          }
        }
      }

      if ('json' in opened) {
        // Without alt=sse, Gemini answers with the list of chunks.
        for (const chunk of Array.isArray(opened.json) ? opened.json : [opened.json]) add(wholeReply<GeminiResponse>(chunk));
      } else {
        for await (const data of serverSentEvents(opened.body, input.signal)) add(streamChunk<GeminiResponse>(data));
      }
      if (!finishReason && !blockReason) throw incompleteStream();
      return reply(input, { candidates: [{ content: { role: 'model', parts }, finishReason }], usageMetadata,
        ...(blockReason ? { promptFeedback: { blockReason } } : {}) });
    },
  };
}


const reservedHeaders = new Set(['authorization', 'content-type', 'x-api-key', 'x-goog-api-key', 'accept', 'host']);
const reservedBody = new Set(['model', 'messages', 'input', 'contents', 'tools', 'stream', 'system', 'systeminstruction']);

function readPassthrough(headers?: Record<string, string>, body?: Record<string, unknown>) {
  for (const [name, value] of Object.entries(headers ?? {})) {
    if (reservedHeaders.has(name.toLowerCase())) throw new TypeError(`Header ${name} is set by the SDK.`);
    if (typeof value !== 'string') throw new TypeError(`Header ${name} must be a string.`);
  }
  for (const name of Object.keys(body ?? {})) {
    if (reservedBody.has(name.toLowerCase())) throw new TypeError(`Request field ${name} is set by the SDK.`);
  }
  return { headers, body };
}

export function createModel({
  provider, model, baseUrl, apiKey, reasoningEffort = 'default', fetch: request = globalThis.fetch,
  headers, body, maxRetries, promptCaching,
}: ModelOptions): ModelAdapter {
  if (!Object.hasOwn(modelProviders, provider)) throw new TypeError('Nhà cung cấp model không hợp lệ.');
  const config: Provider = modelProviders[provider];
  if (typeof model !== 'string' || !model.trim()) throw new TypeError('Nhập mã model.');
  if (!config.efforts.includes(reasoningEffort)) throw new TypeError(`Mức suy nghĩ không được hỗ trợ cho ${config.label}.`);
  if (config.apiKeyEnv && !apiKey?.trim()) throw new TypeError(`${config.label} cần API key.`);
  const endpoint = parseHttpUrl(config.customEndpoint ? baseUrl || config.endpoint : config.endpoint);
  if (endpoint.search) throw new TypeError('Base URL của model không được chứa query string.');
  if (promptCaching !== undefined && typeof promptCaching !== 'boolean') throw new TypeError('promptCaching phải là true hoặc false.');
  const connection: Connection = {
    model: model.trim(), baseUrl: endpoint.href.replace(/\/+$/, ''), apiKey: apiKey?.trim(),
    effort: reasoningEffort === 'default' ? undefined : reasoningEffort, fetch: request,
    label: config.label, maxRetries: readMaxRetries(maxRetries), caching: promptCaching,
    ...readPassthrough(headers, body),
  };

  switch (provider) {
    case 'openai': return createOpenAIModel({
      model: connection.model, apiKey: connection.apiKey!, fetch: request,
      reasoningEffort: connection.effort as Parameters<typeof createOpenAIModel>[0]['reasoningEffort'],
      headers: connection.headers, body: connection.body, maxRetries: connection.maxRetries,
    });
    case 'ollama': return described(createOllama(connection), provider, connection.model);
    case 'anthropic': return described(createAnthropic(connection), provider, connection.model);
    case 'gemini': return described(createGemini(connection), provider, connection.model);
    default: return described(createCompatible(connection, provider === 'openrouter'), provider, connection.model);
  }
}

/** The OpenTelemetry provider names that differ from the SDK's: gen_ai.provider.name lists Gemini as gcp.gemini. */
const traceNames: Partial<Record<ModelProvider, string>> = { gemini: 'gcp.gemini' };

/**
 * The files each API takes inline. Whether a model reads them depends on the model: a model without vision answers a
 * file with a provider error. Ollama decodes PNG and JPEG; Chat Completions takes PDF files only through OpenRouter.
 */
const providerAttachments: Record<Exclude<ModelProvider, 'openai'>, readonly AttachmentType[]> = {
  anthropic: attachmentTypes, gemini: attachmentTypes, openrouter: attachmentTypes,
  groq: imageTypes, lmstudio: imageTypes, compatible: imageTypes, ollama: ['image/png', 'image/jpeg'],
};

function described(adapter: ModelAdapter, provider: Exclude<ModelProvider, 'openai'>, model: string): ModelAdapter {
  return { ...adapter, provider: traceNames[provider] ?? provider, model, attachments: providerAttachments[provider] };
}
