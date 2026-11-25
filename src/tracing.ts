import type { Span, Tracer } from './types.js';

/**
 * The version of the OpenTelemetry semantic conventions for generative AI that the spans follow. Those conventions
 * are still in development: a backend that reads them may need OTEL_SEMCONV_STABILITY_OPT_IN=gen_ai_latest_experimental.
 */
export const genAiSemconvVersion = '1.41.0';
/** The schema URL of that version, for the tracer: trace.getTracer(name, version, { schemaUrl: genAiSchemaUrl }). */
export const genAiSchemaUrl = `https://opentelemetry.io/schemas/${genAiSemconvVersion}`;

/** OpenTelemetry SpanKind values. */
export const spanKind = Object.freeze({ internal: 0, client: 2 });
const errorStatus = 2;

export type SpanAttributes = Record<string, string | number | boolean | undefined>;

const noSpan: Span = { setAttribute() {}, setStatus() {}, end() {} };

/** A span whose calls cannot throw, because tracing never changes the outcome of a run. */
function safeSpan(span: Span): Span {
  const attempt = (call: () => unknown) => {
    try {
      call();
    } catch {
      // A failing tracer only loses telemetry.
    }
  };
  return {
    setAttribute: (key, value) => attempt(() => span.setAttribute(key, value)),
    setStatus: (status) => attempt(() => span.setStatus(status)),
    end: () => attempt(() => span.end()),
  };
}

function defined(attributes: SpanAttributes) {
  return Object.fromEntries(Object.entries(attributes).filter(([, value]) => value !== undefined)) as
    Record<string, string | number | boolean>;
}

/** Sets attributes that are known, leaving out the ones that are not. */
export function setAttributes(span: Span, attributes: SpanAttributes) {
  for (const [key, value] of Object.entries(defined(attributes))) span.setAttribute(key, value);
}

/** Marks a span as failed. type is low-cardinality: an error code or class name, as error.type asks. */
export function failSpan(span: Span, type: string, message?: string) {
  span.setAttribute('error.type', type || '_OTHER');
  span.setStatus({ code: errorStatus, ...(message ? { message } : {}) });
}

function errorType(error: unknown) {
  if (error && typeof error === 'object') {
    const { code, name } = error as { code?: unknown; name?: unknown };
    if (typeof code === 'string' && code) return code;
    if (typeof name === 'string' && name) return name;
  }
  return '_OTHER';
}

/**
 * Runs operation in a span that is the parent of spans started inside it, and ends the span when the operation
 * settles. An operation that throws marks its span as failed. Without a tracer, or with one that fails to start a
 * span, the operation runs on its own.
 */
export async function inSpan<Result>(tracer: Tracer | undefined, name: string, kind: number, attributes: SpanAttributes,
  operation: (span: Span) => Promise<Result>): Promise<Result> {
  if (!tracer) return operation(noSpan);
  let running: Promise<Result> | undefined;
  // Set once the operation runs untraced, so a tracer that calls back late does not run it twice.
  let untraced = false;
  try {
    tracer.startActiveSpan(name, { kind, attributes: defined(attributes) }, (started) => {
      const span = safeSpan(started);
      if (untraced) {
        span.end();
        return undefined;
      }
      running = (async () => {
        try {
          return await operation(span);
        } catch (error) {
          failSpan(span, errorType(error));
          throw error;
        } finally {
          span.end();
        }
      })();
      return running;
    });
  } catch {
    // The tracer failed; the operation runs untraced below unless it already started.
  }
  if (running) return running;
  untraced = true;
  return operation(noSpan);
}
