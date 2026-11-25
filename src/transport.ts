import { setTimeout as delay } from 'node:timers/promises';
import { ModelError } from './index.js';

export interface Transport {
  fetch: typeof fetch;
  /** Provider name used in error messages, such as "OpenAI" or "Ollama". */
  label: string;
  maxRetries: number;
}

export const defaultMaxRetries = 2;
/** A provider asking callers to wait longer than this is reported at once instead of holding the run. */
const longestRetryWaitMs = 20_000;

export function readMaxRetries(value: number | undefined) {
  if (value === undefined) return defaultMaxRetries;
  if (!Number.isSafeInteger(value) || value < 0 || value > 5) throw new TypeError('maxRetries must be an integer between 0 and 5');
  return value;
}

function retryable(status?: number) {
  return status === undefined || status === 408 || status === 429 || status >= 500;
}

function retryWait(response: Response | undefined, attempt: number) {
  const milliseconds = response?.headers.get('retry-after-ms');
  if (milliseconds && Number.isFinite(Number(milliseconds)) && Number(milliseconds) >= 0) return Number(milliseconds);
  const header = response?.headers.get('retry-after');
  if (header) {
    if (Number.isFinite(Number(header)) && Number(header) >= 0) return Number(header) * 1000;
    const date = Date.parse(header);
    if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  }
  return Math.min(8000, 500 * 2 ** attempt) * (0.75 + Math.random() * 0.5);
}

/** Error texts providers send when the request does not fit the model's context window. */
const overflowText = /context.{0,20}(length|window|limit)|prompt is too long|too many (input )?tokens|maximum context|input.{0,20}too long|exceeds? the (max|context)/i;

export function contextExceeded() {
  return new ModelError('provider_context_exceeded', 'The request is larger than the model\'s context window.');
}

export function providerError(label: string, status?: number, body = ''): ModelError {
  const endpoint = `The ${label} endpoint`;
  if ((status === 400 || status === 413 || status === 422) && overflowText.test(body)) return contextExceeded();
  if (status === undefined) {
    return new ModelError('provider_unavailable', `Could not reach the ${label} endpoint. Check the base URL and that the server is running.`);
  }
  if (status === 401 || status === 403) {
    return new ModelError('provider_auth', `${endpoint} rejected the credentials (HTTP ${status}). Check the API key and its permissions.`, status);
  }
  if (status === 404) {
    return new ModelError('provider_not_found', `${endpoint} returned HTTP 404. Check the model name and base URL.`, status);
  }
  if (status === 429) {
    return new ModelError('provider_rate_limited', `${endpoint} is rate limiting requests (HTTP 429). Try again later.`, status);
  }
  if (retryable(status)) {
    return new ModelError('provider_server_error', `${endpoint} is temporarily unavailable (HTTP ${status}). Try again later.`, status);
  }
  return new ModelError('provider_rejected', `${endpoint} rejected the request (HTTP ${status}). Check the model and request options.`, status);
}

/**
 * Sends a provider request, retrying connection failures, 408, 429 and 5xx responses with backoff.
 * Retry-After is honoured; the wait is cut short when the run is cancelled or times out.
 */
export async function sendToProvider({ fetch: request, label, maxRetries }: Transport, url: string,
  init: Omit<RequestInit, 'signal' | 'redirect'>, signal: AbortSignal): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    let response: Response | undefined;
    try {
      response = await request(url, { ...init, signal, redirect: 'error' });
    } catch (error) {
      if (signal.aborted) throw error;
    }
    if (response?.ok) return response;
    const wait = attempt < maxRetries && retryable(response?.status) ? retryWait(response, attempt) : Infinity;
    if (wait > longestRetryWaitMs && response && !retryable(response.status)) {
      // The body tells a request too large for the context window apart from other rejections.
      throw providerError(label, response.status, await errorText(response, signal));
    }
    // Not awaited: cancelling one branch of a cloned (teed) body only settles once every branch is cancelled.
    response?.body?.cancel().catch(() => {});
    if (wait > longestRetryWaitMs) throw providerError(label, response?.status);
    await delay(wait, undefined, { signal });
  }
}

/** The first 4 KB of an error body, or nothing when it cannot be read. */
async function errorText(response: Response, signal: AbortSignal) {
  if (!response.body) return '';
  let text = '';
  try {
    for await (const line of bodyLines(response.body, signal)) {
      text += `${line}\n`;
      if (text.length > 4096) break;
    }
  } catch (error) {
    if (signal.aborted) throw error;
  }
  return text.slice(0, 4096);
}

export function truncatedReply() {
  return new ModelError('provider_truncated',
    'The model reply was cut off at its output token limit. Raise the output token limit or ask for a shorter answer.');
}

export function filteredReply() {
  return new ModelError('provider_content_filtered', 'The model provider stopped the reply because of its content policy.');
}

export function invalidResponse(): never {
  throw new ModelError('provider_invalid_response', 'Model returned an invalid or incomplete response.');
}

export function incompleteStream() {
  return new ModelError('provider_incomplete', 'The model stream ended before the reply was complete.');
}

/** The provider sent an error event after the reply had started. */
export function streamError(label: string) {
  return new ModelError('provider_server_error', `The ${label} endpoint reported an error in the middle of the reply. Try again later.`);
}

/** The lines of a response body, trimmed, as they arrive. */
export async function* bodyLines(body: ReadableStream<Uint8Array>, signal: AbortSignal) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let index: number;
      while ((index = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        yield line;
      }
      if (buffer.length > 1_000_000) throw new ModelError('provider_invalid_response', 'The model stream sent an oversized event.');
    }
    buffer += decoder.decode();
    if (buffer.trim()) yield buffer.trim();
  } finally {
    await reader.cancel().catch(() => {});
  }
}

/** The data of each server-sent event. Providers send each event's JSON on one data line. */
export async function* serverSentEvents(body: ReadableStream<Uint8Array>, signal: AbortSignal) {
  for await (const line of bodyLines(body, signal)) {
    if (line.startsWith('data:')) yield line.slice(5).trim();
  }
}

/** Parses one event of a stream as a JSON object. */
export function streamChunk<Chunk>(text: string): Chunk {
  let chunk: unknown;
  try {
    chunk = JSON.parse(text);
  } catch {
    invalidResponse();
  }
  if (!chunk || typeof chunk !== 'object') invalidResponse();
  return chunk as Chunk;
}

/**
 * Sends a streaming request. A server that ignores the stream setting and answers with one JSON body, as some gateways
 * and local stand-ins do, is read as that body instead.
 */
export async function openStream(transport: Transport, url: string, headers: Record<string, string> | undefined,
  body: unknown, signal: AbortSignal): Promise<{ json: unknown } | { body: ReadableStream<Uint8Array> }> {
  const response = await sendToProvider(transport, url, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', ...headers },
    body: JSON.stringify(body),
  }, signal);
  if (!response.body) invalidResponse();
  if (response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() === 'application/json') {
    try {
      return { json: await response.json() };
    } catch (error) {
      if (signal.aborted) throw error;
      invalidResponse();
    }
  }
  return { body: response.body };
}
