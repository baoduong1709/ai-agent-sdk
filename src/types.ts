export interface RunContext {
  appId?: string;
  tenantId?: string;
  userId?: string;
  [key: string]: unknown;
}

export interface ToolContext extends RunContext {
  agentId: string;
  sessionId: string;
  runId: string;
  toolCallId: string;
  signal: AbortSignal;
  /** Ends the run with a reply written by the application instead of the model. */
  reply(text: string, data?: unknown): void;
}

export interface ToolDescription {
  name: string;
  description: string;
  parameters: { type: 'object'; [keyword: string]: unknown };
}

export interface ToolDefinition<Arguments extends object = object> extends ToolDescription {
  timeoutMs?: number;
  authorize?(parameters: Arguments, context: ToolContext): boolean | Promise<boolean>;
  execute(parameters: Arguments, context: ToolContext): unknown;
  /**
   * JSON schema of the value execute returns. A value that does not match fails the call with invalid_result.
   * x-form names the form of forms the chat shows for a result. Without direct oneOf or anyOf branches, x-form sits on
   * the schema itself and applies to every result. With them, x-form sits on the branches: the first branch the result
   * matches decides, and a branch without x-form shows no form.
   */
  result?: { [keyword: string]: unknown };
  /**
   * Forms the result schema names with x-form, keyed by name, shown in place of a built-in UI. A form with submit
   * replaces a confirmation UI: the model only proposes, the user reviews the tool result in the form and submits it,
   * and the SDK then calls submit directly. A form without submit only shows the result (a table, a card).
   */
  forms?: Record<string, ToolForm>;
  /**
   * false keeps this tool's results out of the session history: later turns only read that it was called and with which
   * arguments. Defaults to true, so the model can answer follow-up questions from data it already fetched.
   */
  history?: boolean;
  /**
   * true: the tool only reads data and changes nothing. Calls of such tools that the model makes one after another in
   * the same step run at the same time; every other call runs on its own, in the order the model made them.
   */
  readOnly?: boolean;
  /**
   * Asks the user before the tool runs. true asks for every call; a function decides per call from the validated
   * arguments (true asks, and so does a function that throws). The run then ends with status interrupted, listing the
   * calls to approve, and agent.resume() continues it once each call has an answer. authorize and beforeTool run before
   * the question, and again before an approved call runs. A run given its history cannot wait, so there such a call
   * fails with approval_unavailable.
   */
  approval?: boolean | ApprovalCheck<Arguments>;
}

/** Method syntax keeps the check assignable to a tool of any argument type, like authorize. */
type ApprovalCheck<Arguments> = {
  check(parameters: Arguments, context: ToolContext): boolean | Promise<boolean>;
}['check'];

export interface ToolForm<Values extends object = Record<string, unknown>> {
  /**
   * HTML shown in a sandboxed frame below the reply, at most 64 KB. The chat receives it wrapped into an MCP App document
   * (text/html;profile=mcp-app) that gets the tool result from the chat and gives the form window.agentForm.
   */
  html: string;
  /**
   * true: html is already a whole MCP App document, such as the UI resource of an MCP server, that talks to the chat over
   * the MCP Apps protocol itself. It is shown as is, up to 1 MB, without window.agentForm, and cannot have submit.
   */
  mcpApp?: boolean;
  /** JSON schema the submitted values must match. Without one, any JSON object up to 64 KB is accepted. Needs submit. */
  schema?: { type: 'object'; [keyword: string]: unknown };
  /** Time limit for submit. Defaults to the tool timeout, then to the agent run timeout. Needs submit. */
  timeoutMs?: number;
  /**
   * Runs once per shown form, when the user submits it. Throw ToolError to reject the values and keep the form open.
   * Without submit the form only shows the tool result: it is shown with status shown and cannot be submitted.
   */
  submit?(values: Values, context: FormContext): unknown;
}

export interface FormContext extends RunContext {
  agentId: string;
  sessionId: string;
  formId: string;
  /** The name of the form in the tool's forms. */
  form: string;
  /** The tool call whose result the form shows. */
  toolCallId: string;
  /** The value the tool returned when the form was shown. */
  data: unknown;
  signal: AbortSignal;
}

/**
 * A form shown in a stored reply. open: waiting for the user; submitted and failed are final. shown: a form without
 * submit that only shows the result; it never changes.
 */
export interface FormState {
  id: string;
  tool: string;
  /** The name of the form in the tool's forms, chosen by x-form in its result schema. */
  form: string;
  toolCallId: string;
  /** The arguments of that tool call, which the chat sends to the form as its tool input. */
  arguments?: Record<string, unknown>;
  data: unknown;
  status: 'open' | 'submitted' | 'failed' | 'shown';
  /** The value submit returned. */
  result?: unknown;
  /** Why the last submission failed. An open form with an error can be submitted again. */
  error?: AgentError;
}

/**
 * A form as the chat renders it: an MCP App. html comes from the tool, so it is not stored with the session. The chat
 * shows it in a sandboxed frame, then sends it the tool input and the tool result (data, with the form state under the
 * _meta key formStateKey). The form submits with tools/call named "<tool>.<form>".
 */
export interface FormView extends FormState {
  /** The MCP App document. */
  html: string;
  /** Its ui:// resource URI. */
  uri: string;
  mimeType: 'text/html;profile=mcp-app';
}

export interface AgentError {
  code: string;
  message: string;
}

export interface TraceEntry {
  name: string;
  status: 'completed' | 'error';
  step: number;
  durationMs: number;
  error?: AgentError;
}

/** A tool call behind a stored reply, kept so later turns can read the data it returned. */
export interface ToolRecord {
  name: string;
  /** The arguments as JSON, shortened. */
  arguments: string;
  ok: boolean;
  /** The value (ok) or the error (not ok) as JSON, shortened. Absent when the tool keeps its results out of the history. */
  result?: string;
}

export interface Message {
  role: 'user' | 'assistant';
  content: string;
  trace?: TraceEntry[];
  /** Forms shown with this reply. getHistory adds html, uri and mimeType while the tool still has the named form. */
  forms?: (FormState & Partial<Pick<FormView, 'html' | 'uri' | 'mimeType'>>)[];
  /** Tool calls behind this reply, for the model's later turns. getHistory leaves them out. */
  tools?: ToolRecord[];
  /**
   * Marks the summary that replaced the older turns of a session. It comes first, with role user, and keeps the forms
   * of those turns that were still open, so they can still be submitted.
   */
  summary?: true;
  /** The files sent with this user message. Only their names, types and sizes are stored. */
  attachments?: AttachmentInfo[];
  /**
   * Tool calls of this turn that asked the user for approval: on the reply, and on the user message while the turn
   * waits for answers.
   */
  approvals?: ApprovalState[];
  /** The state of a turn waiting for approvals, on its user message. Internal to the SDK; getHistory leaves it out. */
  pending?: unknown;
}

/** The file types a run accepts as attachments. */
export type AttachmentType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp' | 'application/pdf';

/** A file the user sends with a message, such as a photo of a document. */
export interface Attachment {
  /** The file name, which the model reads. */
  name?: string;
  mediaType: AttachmentType;
  /** The content in base64, or as a data URL of the same media type. Adapters receive plain base64. */
  data: string;
}

/** What a session keeps of an attachment; the file itself is not stored. */
export interface AttachmentInfo {
  name?: string;
  mediaType: AttachmentType;
  /** Size in bytes. */
  size: number;
}

/** A tool call that waits for the user's approval. */
export interface ToolApproval {
  /** The ID to answer with in agent.resume(). */
  id: string;
  tool: string;
  toolCallId: string;
  /** The validated arguments of the call. */
  arguments: Record<string, unknown>;
}

/** expired: the user sent a new message instead of answering, so the call never ran. */
export interface ApprovalState extends ToolApproval {
  status: 'pending' | 'approved' | 'denied' | 'expired';
  /** Why the user denied the call. */
  reason?: string;
}

export interface ApprovalDecision {
  id: string;
  approved: boolean;
  /** Why the user denies the call, which the model reads; at most 500 characters. */
  reason?: string;
}

export interface GuardrailCheck {
  stage: 'input' | 'output';
  /** The user message (input) or the reply (output), as earlier guardrails rewrote it. */
  text: string;
  /** The files sent with the user message (input only). */
  attachments?: AttachmentInfo[];
  agentId: string;
  sessionId: string;
  context: Readonly<RunContext>;
  signal: AbortSignal;
}

/**
 * true or nothing lets the text through. false or { allowed: false } blocks it, and reply is what the user reads
 * instead. { allowed: true, text } replaces the text, for example with personal data masked.
 */
export type GuardrailVerdict = boolean | void | { allowed: true; text?: string } | { allowed: false; reason?: string; reply?: string };

export type Guardrail = (check: GuardrailCheck) => GuardrailVerdict | Promise<GuardrailVerdict>;

export interface Guardrails {
  /** Check each user message, in order, before anything is stored or sent to the model. */
  input?: Guardrail | Guardrail[];
  /**
   * Check each final reply, in order, before it is stored and returned. Streamed text has already been sent by then,
   * so a chat that streams shows result.text in its place once the run ends.
   */
  output?: Guardrail | Guardrail[];
}

/** The parts of an OpenTelemetry tracer (trace.getTracer() of @opentelemetry/api) the SDK uses. */
export interface Tracer {
  startActiveSpan(name: string, options: SpanOptions, fn: (span: Span) => unknown): unknown;
}

export interface SpanOptions {
  /** OpenTelemetry SpanKind: 0 internal, 2 client. */
  kind?: number;
  attributes?: Record<string, string | number | boolean>;
}

export interface Span {
  setAttribute(key: string, value: string | number | boolean): unknown;
  /** OpenTelemetry SpanStatusCode: 2 is error. */
  setStatus(status: { code: number; message?: string }): unknown;
  end(): unknown;
}

export interface SessionStore {
  get(key: string): Promise<Message[]>;
  set(key: string, messages: Message[]): Promise<void>;
}

/** form names the form the chat shows the user for this result, so the model can point to it. */
export type ToolOutput = {
  ok: true; value: unknown; form?: string;
  /** The result was larger than 64 KB, so value is cut: long strings and arrays shortened. */
  truncated?: true;
} | { ok: false; error: AgentError };

export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface ModelStep {
  continuation?: unknown;
  outputs: { callId: string; output: ToolOutput }[];
}

export interface ModelMessage {
  role: Message['role'];
  content: string;
  /** Files sent with this message, with data in plain base64. Only the user message of the current turn has them. */
  attachments?: Attachment[];
}

export interface ModelInput {
  systemPrompt: string;
  history: ModelMessage[];
  steps: ModelStep[];
  tools: ToolDescription[];
  /**
   * "none" asks for a text answer without tool calls. The run sends it once its limit is reached;
   * adapters should pass it on as the provider's tool choice setting.
   */
  toolChoice?: 'auto' | 'none';
  signal: AbortSignal;
}

export interface ModelUsage {
  promptTokens?: number;
  cachedTokens?: number;
  completionTokens?: number;
}

export interface ModelReply {
  text?: string;
  toolCalls?: ToolCall[];
  continuation?: unknown;
  usage?: ModelUsage;
}

export interface ModelAdapter {
  generate(input: ModelInput): Promise<ModelReply>;
  /** Optional streaming path. Called instead of generate when the run observes events. */
  stream?(input: ModelInput, onDelta: (text: string) => void): Promise<ModelReply>;
  /** The attachment types the model reads. A run with another type, or with none listed, ends with attachments_unsupported. */
  attachments?: readonly AttachmentType[];
  /** The provider, reported as gen_ai.provider.name in traces (anthropic, openai, gcp.gemini, ...). */
  provider?: string;
  /** The model name, reported as gen_ai.request.model in traces. */
  model?: string;
}

export interface SDKOptions {
  model: ModelAdapter;
  tools?: ToolDefinition[];
  sessionStore?: SessionStore;
  /**
   * The most past turns the model reads in full. Older turns of a stored session are summarized into one message
   * instead of dropped. Defaults to 20.
   */
  maxTurns?: number;
  /**
   * Estimated tokens (about 3 characters each) of history the model reads per call. Over it, tool results of the oldest
   * turns are left out first; if that is not enough, the older turns of a stored session are summarized by the model.
   * History passed to run() is never summarized: its oldest turns are left out instead. Defaults to 12,000.
   */
  historyBudget?: number;
  beforeTool?: (invocation: ToolInvocation) => boolean | Promise<boolean>;
  afterTool?: (result: ToolResult) => void | Promise<void>;
  /** Guardrails for every agent; an agent's own guardrails run after these. */
  guardrails?: Guardrails;
  /**
   * Records each run as OpenTelemetry spans following the GenAI semantic conventions (genAiSemconvVersion): invoke_agent,
   * with a chat span per model call and an execute_tool span per tool call. No message text or tool data is recorded.
   */
  tracer?: Tracer;
}

export interface ToolInvocation {
  name: string;
  arguments: Readonly<Record<string, unknown>>;
  context: Readonly<ToolContext>;
}

export interface ToolResult extends ToolInvocation {
  output: ToolOutput;
  durationMs: number;
}

export interface AgentOptions {
  id?: string;
  systemPrompt: string;
  tools?: (ToolDefinition | string)[];
  maxSteps?: number;
  maxToolCalls?: number;
  timeoutMs?: number;
  model?: ModelAdapter;
  /** The name in traces (gen_ai.agent.name). Defaults to the id. */
  name?: string;
  /** Run after the guardrails of the SDK. */
  guardrails?: Guardrails;
}

export interface HistoryOptions {
  sessionId: string;
  context?: RunContext;
}

export interface RunOptions extends HistoryOptions {
  message: string;
  signal?: AbortSignal;
  onEvent?: (event: RunEvent) => void | Promise<void>;
  /**
   * Replaces the stored history for this run. The session store is left untouched. Messages may carry tools and summary,
   * as stored ones do. Over historyBudget, tool results and then the oldest turns are left out; nothing is summarized.
   */
  history?: Message[];
  /** Restricts this run to a subset of the agent tools, for per-request permissions. */
  tools?: (ToolDefinition | string)[];
  /** Streams model text as it arrives. Requires a model adapter with stream support. */
  onDelta?: (text: string) => void;
  /**
   * Images (PNG, JPEG, GIF, WebP) and PDF documents sent with the message: at most 5 files, 5 MB each and 10 MB in all.
   * The model reads them in this turn only; the session keeps their names, types and sizes.
   */
  attachments?: Attachment[];
}

export interface ResumeOptions extends HistoryOptions {
  /** Answers to some or all of the calls waiting for approval. The turn continues once every call has one. */
  approvals: ApprovalDecision[];
  signal?: AbortSignal;
  onEvent?: RunOptions['onEvent'];
  onDelta?: RunOptions['onDelta'];
  /** Restricts the rest of the turn to these of the tools it started with. */
  tools?: RunOptions['tools'];
}

interface RunMetadata {
  runId: string;
  trace: TraceEntry[];
  durationMs: number;
  usage: Required<ModelUsage> & { modelCalls: number };
}

export type RunOutcome =
  /** forms lists the forms of tools that succeeded in this turn; present only when the turn was stored. */
  { status: 'completed'; text: string; data?: unknown; forms?: FormView[] } |
  /** text is the answer the model gave from what it had, once tools were withdrawn; absent when it gave none. */
  { status: 'limit_reached'; text?: string; error: AgentError; forms?: FormView[] } |
  /** Tool calls wait for the user's approval. Answer them with agent.resume() to continue the turn. */
  { status: 'interrupted'; interruptions: ToolApproval[] } |
  /**
   * A guardrail blocked the user message (input; nothing was stored) or the reply (output; text replaced it in the
   * session). text is the reply for the user, when there is one.
   */
  { status: 'blocked'; stage: 'input' | 'output'; text?: string; error: AgentError } |
  { status: 'error' | 'cancelled' | 'timed_out'; error: AgentError };

export interface FormSubmitOptions extends HistoryOptions {
  formId: string;
  values: Record<string, unknown>;
  signal?: AbortSignal;
}

/**
 * submitted: submit ran and returned value. error: nothing was submitted when form is absent or still open (fix the
 * values and send again); a failed form ran submit without a known outcome and cannot be sent again.
 */
export type FormSubmitResult = { formId: string; form?: FormState } & (
  { status: 'submitted'; value: unknown } |
  { status: 'error'; error: AgentError }
);

export type RunResult = RunMetadata & RunOutcome;

export type RunEvent = { runId: string } & (
  { type: 'run.queued' | 'run.started' }
  | { type: 'model.started'; step: number }
  | { type: 'model.delta'; step: number; text: string }
  | { type: 'model.finished'; step: number; durationMs: number; status: 'completed' | 'error' }
  /** arguments is the JSON the model sent. The tool's result is not part of any event. */
  | { type: 'tool.started'; step: number; name: string; toolCallId: string; arguments: string }
  | { type: 'tool.finished'; toolCallId: string; tool: TraceEntry }
  /** The call waits for the user's approval. Its tool.finished comes in the run that resumes the turn. */
  | { type: 'tool.approval'; step: number; name: string; toolCallId: string; approval: ToolApproval }
  | { type: 'guardrail.triggered'; stage: 'input' | 'output'; action: 'blocked' | 'rewritten' }
  /** The older turns of the session were summarized (completed) or could not be, so they were left out for this run (error). */
  | { type: 'history.compacted'; status: 'completed' | 'error'; turns: number; durationMs: number }
  | { type: 'run.finished'; result: RunResult }
);
