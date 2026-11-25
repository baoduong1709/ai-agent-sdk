import { agUiServerSentEvent, createAgUiEncoder } from 'agent-studio-sdk';
import { RequestError } from './config.js';

export function json(response, data, status = 200) {
  if (response.destroyed) return;
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(data));
}

/**
 * Room a run body needs for its attachments: 10 MB of files in all, base64-encoded, with their names and media types.
 */
export const attachmentBodyLimit = 14_500_000;

/** Reads a JSON object body. Studio routes pass a larger limit: a profile can hold form HTML of several tools. */
export async function readJson(request, limit = 64_000) {
  if (request.headers['content-type']?.split(';')[0].trim() !== 'application/json') {
    throw new RequestError(415, 'Yêu cầu phải dùng định dạng JSON.');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size <= limit) chunks.push(chunk);
  }
  if (size > limit) throw new RequestError(413, 'Dữ liệu gửi lên quá lớn.');
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (body && typeof body === 'object' && !Array.isArray(body)) return body;
  } catch {
    // The same response covers malformed JSON and an unexpected body type.
  }
  throw new RequestError(400, 'Dữ liệu JSON không hợp lệ.');
}

export function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.removeListener('error', reject);
      resolve(server);
    });
  });
}

export function createRunTransport() {
  const activeRuns = new Map();

  function key(scope, requestId) {
    return JSON.stringify([scope, requestId]);
  }

  return {
    /**
     * Runs the agent. It answers with the result as JSON, with the run events as NDJSON when the client accepts
     * application/x-ndjson, or with AG-UI events as server-sent events when agUi (thread, run and state) is given.
     * With approvals instead of a message, it resumes the turn that waits for them.
     */
    async run(request, response, agent, { requestId, scope, agUi, ...input }) {
      const controller = new AbortController();
      const runKey = requestId ? key(scope, requestId) : null;
      if (runKey && activeRuns.has(runKey)) throw new RequestError(409, 'Mã lượt chạy đang được sử dụng.');
      if (runKey) activeRuns.set(runKey, controller);
      const close = () => {
        if (!response.writableFinished) controller.abort();
      };
      response.once('close', close);
      const stream = Boolean(agUi) ||
        request.headers.accept?.split(',').some((value) => value.split(';')[0].trim() === 'application/x-ndjson');
      const encode = agUi ? createAgUiEncoder(agUi) : (event) => [event];
      const format = agUi ? agUiServerSentEvent : (event) => `${JSON.stringify(event)}\n`;
      try {
        if (stream) {
          response.writeHead(200, {
            'Content-Type': agUi ? 'text/event-stream; charset=utf-8' : 'application/x-ndjson; charset=utf-8',
            'Cache-Control': 'no-store', ...(agUi ? { 'X-Accel-Buffering': 'no' } : {}),
          });
          response.flushHeaders();
        }
        const options = { ...input, signal: controller.signal,
          onEvent: stream ? (event) => {
            for (const item of encode(event)) {
              if (!response.destroyed) response.write(format(item));
            }
          } : undefined,
        };
        // Answers to tool calls that wait for approval continue the paused turn instead of starting one.
        const result = await (input.approvals ? agent.resume(options) : agent.run(options));
        if (stream) response.end();
        else json(response, result);
      } finally {
        if (runKey) activeRuns.delete(runKey);
        response.removeListener('close', close);
      }
    },
    cancel(requestId, scope) {
      const run = activeRuns.get(key(scope, requestId));
      if (!run) throw new RequestError(404, 'Lượt chạy đã kết thúc hoặc không tồn tại.');
      run.abort();
      return { status: 'cancelling' };
    },
  };
}
