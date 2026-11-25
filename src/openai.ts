import { ModelError } from './index.js';
import {
  filteredReply, incompleteStream, openStream, readMaxRetries, sendToProvider, serverSentEvents, streamChunk, streamError,
  truncatedReply,
} from './transport.js';
import { attachmentTypes, dataUrl, fileName } from './attachments.js';
import type { ModelAdapter, ModelInput, ModelMessage, ModelReply, ToolCall } from './types.js';

/** A history message as a Responses API input item; files come before the text, as images and PDF files. */
function inputMessage({ role, content, attachments }: ModelMessage) {
  if (!attachments?.length) return { role, content };
  return { role, content: [
    ...attachments.map((file, index) => file.mediaType === 'application/pdf'
      ? { type: 'input_file', filename: fileName(file, index), file_data: dataUrl(file) }
      : { type: 'input_image', image_url: dataUrl(file) }),
    { type: 'input_text', text: content },
  ] };
}

interface OpenAIOptions {
  apiKey: string;
  model: string;
  fetch?: typeof fetch;
  reasoningEffort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  headers?: Record<string, string>;
  body?: Record<string, unknown>;
  /** Retries for connection failures, 408, 429 and 5xx responses (0..5, default 2). */
  maxRetries?: number;
}

interface ResponsePart {
  type: string;
  text?: string;
  refusal?: string;
}

interface ResponseItem {
  type: string;
  content?: ResponsePart[];
  call_id?: string;
  name?: string;
  arguments?: string;
  created_by?: unknown;
}

type ResponseData = {
  status?: string; output?: ResponseItem[]; incomplete_details?: { reason?: string } | null;
  usage?: { input_tokens?: number; output_tokens?: number; input_tokens_details?: { cached_tokens?: number } };
};

type ResponseEvent = {
  type?: string; output_index?: number; content_index?: number; delta?: string; response?: ResponseData;
};

const url = 'https://api.openai.com/v1/responses';

function readResponse(data: ResponseData | undefined): ModelReply {
  if (data?.status === 'incomplete') {
    if (data.incomplete_details?.reason === 'max_output_tokens') throw truncatedReply();
    if (data.incomplete_details?.reason === 'content_filter') throw filteredReply();
  }
  if (data?.status !== 'completed' || !Array.isArray(data.output)) {
    throw new ModelError('provider_incomplete', 'The OpenAI response was incomplete.');
  }

  const text = data.output.filter((item) => item.type === 'message')
    .flatMap((item) => item.content ?? [])
    .map((item) => item.type === 'refusal' ? item.refusal : item.text)
    .filter(Boolean).join('\n');
  const toolCalls: ToolCall[] = [];
  for (const item of data.output) {
    if (item.type !== 'function_call') continue;
    if (typeof item.call_id !== 'string' || typeof item.name !== 'string' || typeof item.arguments !== 'string') {
      throw new ModelError('provider_invalid_tool', 'OpenAI returned an invalid function call.');
    }
    toolCalls.push({ id: item.call_id, name: item.name, arguments: item.arguments });
  }
  const continuation = data.output.map(({ created_by: _createdBy, ...item }) => item);
  return { text, toolCalls, continuation, usage: {
    promptTokens: data.usage?.input_tokens, completionTokens: data.usage?.output_tokens,
    cachedTokens: data.usage?.input_tokens_details?.cached_tokens,
  } };
}

export function createOpenAIModel({ apiKey, model, reasoningEffort, fetch: request = globalThis.fetch,
  headers, body: extra, maxRetries }: OpenAIOptions): ModelAdapter {
  if (typeof apiKey !== 'string' || !apiKey.trim() || typeof model !== 'string' || !model.trim()) {
    throw new TypeError('An OpenAI API key and model are required');
  }
  const transport = { fetch: request, label: 'OpenAI', maxRetries: readMaxRetries(maxRetries) };
  const auth = { Authorization: `Bearer ${apiKey.trim()}`, ...headers };

  function payload({ systemPrompt, history, steps, tools, toolChoice }: ModelInput, stream: boolean) {
    const input: unknown[] = history.map(inputMessage);
    for (const step of steps) {
      if (Array.isArray(step.continuation)) input.push(...step.continuation);
      for (const { callId, output } of step.outputs) {
        input.push({ type: 'function_call_output', call_id: callId, output: JSON.stringify(output) });
      }
    }
    return {
      model: model.trim(), instructions: systemPrompt, input, store: false,
      ...(reasoningEffort ? { reasoning: { effort: reasoningEffort } } : {}),
      include: ['reasoning.encrypted_content'],
      tools: tools.map((tool) => ({ type: 'function', strict: false, ...tool })),
      ...(stream ? { stream } : {}), ...extra,
      ...(toolChoice === 'none' && tools.length ? { tool_choice: 'none' } : {}),
    };
  }

  return {
    provider: 'openai',
    model: model.trim(),
    attachments: attachmentTypes,

    async generate(input) {
      const response = await sendToProvider(transport, url, {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...auth }, body: JSON.stringify(payload(input, false)),
      }, input.signal);
      let data: ResponseData;
      try {
        data = await response.json();
      } catch (error) {
        if (input.signal.aborted) throw error;
        throw new ModelError('provider_invalid_response', 'OpenAI returned a response that is not valid JSON.');
      }
      return readResponse(data);
    },

    async stream(input, onDelta) {
      const opened = await openStream(transport, url, auth, payload(input, true), input.signal);
      if ('json' in opened) {
        const reply = readResponse(opened.json as ResponseData);
        if (reply.text) onDelta(reply.text);
        return reply;
      }
      // The finished response repeats the whole output, so only the text deltas are read along the way.
      let shownPart: string | undefined;
      for await (const data of serverSentEvents(opened.body, input.signal)) {
        const event = streamChunk<ResponseEvent>(data);
        if (event.type === 'error' || event.type === 'response.failed') throw streamError(transport.label);
        if (event.type === 'response.completed' || event.type === 'response.incomplete') return readResponse(event.response);
        if ((event.type === 'response.output_text.delta' || event.type === 'response.refusal.delta') &&
            typeof event.delta === 'string' && event.delta) {
          // The reply joins separate text parts with a line break.
          const part = `${event.output_index}:${event.content_index}`;
          if (shownPart !== undefined && shownPart !== part) onDelta('\n');
          shownPart = part;
          onDelta(event.delta);
        }
      }
      throw incompleteStream();
    },
  };
}
