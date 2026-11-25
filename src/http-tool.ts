import { defineTool, ToolError } from './index.js';
import type { ToolDefinition, ToolForm } from './types.js';

export const httpMethods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
export const httpFormMethods = ['POST', 'PUT', 'PATCH'] as const;

export interface HttpFormOptions extends Omit<ToolForm, 'submit'> {
  /**
   * Where the submitted form goes, as JSON { formId, form, values, data }: form is its name, data is what the tool
   * returned when the form was shown. formId is also sent as the Idempotency-Key header. Without it the form only
   * shows the tool result (a table, a card) and cannot be submitted.
   */
  submit?: { url: string; method?: typeof httpFormMethods[number] };
}

export interface HttpToolOptions extends Omit<ToolDefinition, 'execute' | 'authorize' | 'forms'> {
  url: string;
  method: typeof httpMethods[number];
  apiKey?: () => string | undefined;
  fetch?: typeof fetch;
  /** Forms named by x-form in the result schema. */
  forms?: Record<string, HttpFormOptions>;
}

export function parseHttpUrl(input: string) {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new TypeError('URL không hợp lệ.');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) {
    throw new TypeError('URL phải dùng HTTP(S) và không chứa thông tin đăng nhập hoặc dấu #.');
  }
  return url;
}

/**
 * The tool error the model receives for an HTTP status, so it can tell a wrong argument from a missing
 * record or an outage. The response body is not passed on: it may hold details meant for developers.
 */
export function httpStatusError(status: number) {
  const error = (code: string, meaning: string) => new ToolError(code, `The service returned HTTP ${status}: ${meaning}.`);
  if (status === 400 || status === 422) return error('invalid_request', 'it rejected the arguments');
  if (status === 401) return error('unauthorized', 'it did not accept the tool credentials');
  if (status === 403) return error('forbidden', 'the request is not allowed');
  if (status === 404 || status === 410) return error('not_found', 'nothing matches the request');
  if (status === 409) return error('conflict', 'the request conflicts with the current state of the data');
  if (status === 429) return error('rate_limited', 'it is receiving too many requests right now');
  if (status === 408 || status >= 500) return error('unavailable', 'the service is temporarily unavailable');
  return error('request_failed', 'the request could not be completed');
}

/** Sends one request and reads a response of at most 64 KB, parsed as JSON when the service says it is JSON. */
async function send(request: typeof fetch, endpoint: URL, init: RequestInit & { signal: AbortSignal },
  { unreachable }: { unreachable: () => Error }) {
  const { signal } = init;
  let response: Response;
  try {
    response = await request(endpoint, { ...init, redirect: 'error' });
  } catch (error) {
    // A cancelled or timed-out run is reported by the runtime as tool_cancelled or tool_timeout.
    if (signal.aborted) throw error;
    throw unreachable();
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw httpStatusError(response.status);
  }
  if (!response.body) return null;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let bytes = 0;
  while (true) {
    let chunk: ReadableStreamReadResult<Uint8Array>;
    try {
      chunk = await reader.read();
    } catch (error) {
      if (signal.aborted) throw error;
      throw new ToolError('unavailable', 'The connection to the service broke while reading its response.');
    }
    if (chunk.done) break;
    bytes += chunk.value.byteLength;
    if (bytes > 64_000) {
      await reader.cancel().catch(() => {});
      throw new ToolError('output_too_large', 'The service response exceeds 64 KB.');
    }
    text += decoder.decode(chunk.value, { stream: true });
  }
  text += decoder.decode();
  if (!text) return null;
  const contentType = response.headers.get('content-type')?.split(';')[0].trim();
  if (contentType !== 'application/json' && !contentType?.endsWith('+json')) return text;
  try {
    return JSON.parse(text);
  } catch {
    throw new ToolError('invalid_response', 'The service returned invalid JSON.');
  }
}

export function defineHttpTool({
  url, method, apiKey, fetch: request = globalThis.fetch, forms, ...definition
}: HttpToolOptions) {
  const target = parseHttpUrl(url);
  if (!httpMethods.includes(method)) throw new TypeError('Phương thức HTTP không hợp lệ.');

  function authorization(headers: Headers) {
    if (!apiKey) return;
    const key = apiKey()?.trim();
    if (!key) throw new ToolError('unavailable', 'The tool is missing its API key.');
    headers.set('Authorization', `Bearer ${key}`);
  }

  function submittingForm({ submit: destination, ...view }: HttpFormOptions): ToolForm<Record<string, unknown>> {
    // No destination: a form that only shows the result; defineTool rejects a schema or timeoutMs on it
    if (destination === undefined) return view;
    const submitTarget = parseHttpUrl(destination?.url);
    const submitMethod = destination.method ?? 'POST';
    if (!httpFormMethods.includes(submitMethod)) throw new TypeError('Phương thức gửi form phải là POST, PUT hoặc PATCH.');
    return {
      ...view,
      async submit(values, { formId, form, data, signal }) {
        const headers = new Headers({
          Accept: 'application/json, text/plain', 'Content-Type': 'application/json', 'Idempotency-Key': formId,
        });
        // The tool key is only sent back to the service it was saved for.
        if (submitTarget.origin === target.origin) authorization(headers);
        return send(request, new URL(submitTarget), {
          method: submitMethod, headers, body: JSON.stringify({ formId, form, values, data }), signal,
        }, { unreachable: () => new ToolError('unavailable', 'Could not reach the service that receives the form.') });
      },
    };
  }

  let submitForms: Record<string, ToolForm<Record<string, unknown>>> | undefined;
  if (forms !== undefined) {
    if (!forms || typeof forms !== 'object' || Array.isArray(forms)) throw new TypeError('Danh sách form của tool không hợp lệ.');
    submitForms = Object.fromEntries(Object.entries(forms).map(([name, form]) => [name, submittingForm(form ?? {} as HttpFormOptions)]));
  }

  return defineTool<Record<string, unknown>>({
    ...definition,
    ...(submitForms ? { forms: submitForms } : {}),
    async execute(parameters, { signal }) {
      const endpoint = new URL(target);
      const headers = new Headers({ Accept: 'application/json, text/plain' });
      authorization(headers);
      let body: string | undefined;
      if (method === 'GET') {
        for (const [name, value] of Object.entries(parameters)) {
          endpoint.searchParams.set(name, typeof value === 'string' ? value : JSON.stringify(value));
        }
      } else {
        headers.set('Content-Type', 'application/json');
        body = JSON.stringify(parameters);
      }
      return send(request, endpoint, { method, headers, body, signal },
        { unreachable: () => new ToolError('unavailable', 'Could not reach the service.') });
    },
  });
}
