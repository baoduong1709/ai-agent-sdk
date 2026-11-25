import { randomUUID } from 'node:crypto';
import { Ajv, type ValidateFunction } from 'ajv';
import ajvFormats from 'ajv-formats';
import type {
  AgentError, AgentOptions, ApprovalDecision, ApprovalState, AttachmentInfo, FormContext, FormState, FormSubmitOptions,
  FormSubmitResult, FormView, HistoryOptions, Message, ModelInput, ModelMessage, ModelReply, ModelStep, ModelUsage,
  ResumeOptions, RunContext, RunEvent, RunOptions, RunOutcome, RunResult, SDKOptions, SessionStore, ToolApproval, ToolCall,
  ToolContext, ToolDefinition, ToolForm, ToolOutput, ToolRecord, TraceEntry,
} from './types.js';
import { formAppHtml, mcpAppMimeType, formUri } from './mcp-apps.js';
import { failSpan, inSpan, setAttributes, spanKind } from './tracing.js';
import { guardrailLists, readVerdict, type GuardrailDecision } from './guardrails.js';
import { attachmentNote, readAttachmentInfo, readAttachments } from './attachments.js';

export type * from './types.js';
export { formAppHtml, formStateKey, formSubmitName, formUri, mcpAppMimeType, mcpAppProtocolVersion } from './mcp-apps.js';
export { agUiApprovalEvent, agUiFormEvent, agUiServerSentEvent, createAgUiEncoder, readAgUiInput, type AgUiEvent, type AgUiRun } from './ag-ui.js';
export { genAiSchemaUrl, genAiSemconvVersion } from './tracing.js';
export { blockPromptInjection, maskPII, maskText, type InjectionOptions, type MaskOptions } from './guardrails.js';
export { attachmentLimits, attachmentTypes } from './attachments.js';

const schemas = new Ajv({ addUsedSchema: false });
ajvFormats.default(schemas);
// OpenAPI annotations that do not change validation. Strict mode still rejects misspelled keywords.
schemas.addVocabulary(['example', 'externalDocs', 'xml', 'discriminator']);
const extensionKeyword = /^x-[a-z0-9_$:-]*$/i;
const toolValidators = new WeakMap<ToolDefinition, ValidateFunction<object>>();
const formValidators = new WeakMap<ToolForm, ValidateFunction<object>>();
/** How a tool with a result schema checks a result and picks its form. */
interface ResultCheck {
  validate: ValidateFunction;
  /** The form of every result, for a schema without direct oneOf or anyOf branches. */
  form?: string;
  /** The direct oneOf branches, then the anyOf branches, in order; the first one a result matches decides its form. */
  branches: { validate: ValidateFunction; form?: string }[];
}
const resultChecks = new WeakMap<ToolDefinition, ResultCheck>();
const validToolName = /^[A-Za-z0-9_-]{1,64}$/;
const maxFormBytes = 64_000;
/** A form that is already an MCP App carries its own bundled code, so it may be larger. */
const maxAppBytes = 1_000_000;
const maxForms = 20;
/** The MCP App document of each form, by tool and form name. */
const appDocuments = new WeakMap<ToolForm, Map<string, string>>();
/** Added to the description the model reads for a tool with forms, when the turn can show them. */
const formToolNote = '\n\nSome results of this tool show the user a form in the chat to review and submit; ' +
  'the result then has a form field naming it. When it does, do not ask the user to confirm in text: ' +
  'summarize the result and point to the form.';
/** Added to the description of a tool with forms that only show the result. */
const viewToolNote = '\n\nSome results of this tool are also shown to the user in the chat (for example as a table); ' +
  'the result then has a form field naming the view. When it does, do not repeat all of the shown data: ' +
  'answer briefly and point to it.';
export const defaultRunLimits = Object.freeze({ maxSteps: 6, maxToolCalls: 12, timeoutMs: 45_000 });
/** Added to the system prompt for the closing call a run makes once its limit is reached. */
const toolsWithdrawnNote = '\n\nTools are no longer available for this request because it reached its step or tool call limit. ' +
  'Answer the user now using only the information already gathered, and say briefly what you could not check.';
/** Rough characters per token, for the history budget. */
const charsPerToken = 3;
/** Sizes of a stored tool call, in characters: its arguments, its result, and the results of one turn together. */
const maxRecordArguments = 500;
const maxRecordResult = 4_000;
const maxTurnResults = 12_000;
/** A tool result over this many bytes reaches the model cut to maxCutResult characters, marked truncated. */
const maxResultBytes = 64_000;
const maxCutResult = 16_000;
/** Each tool result of the turn is cut to this many characters when the request outgrew the model's context window. */
const overflowResult = 2_000;
/** Added to the system prompt when the model's last reply was cut off at its output token limit. */
const briefNote = '\n\nYour previous reply was cut off at the output token limit. Answer again, much more briefly; ' +
  'if a tool call needs long arguments, split the work into smaller calls.';
/** A result shorter than this is left out rather than cut to a fragment. */
const minRecordResult = 200;
/** Starts the block of tool calls the model reads under a stored reply. */
const toolBlockHeader = '[Tool calls behind this reply. Answer follow-up questions about these results from them; call a tool again when ' +
  'the user needs current data or a result was cut short.';
const summaryLabel = '[Summary of the earlier conversation, which was shortened to save space]';

function summaryPrompt(limit: number) {
  return 'You shorten the earlier part of a conversation between a user and an AI assistant, so the assistant can continue it ' +
    'without the full text. Write the summary in the language of the conversation. Keep everything later turns may need: ' +
    'what the user wants, their preferences and decisions, questions still open, actions and forms still pending, and every ' +
    'identifier, name, date, time, number and amount, including the data that tool calls returned. Leave out greetings and ' +
    `small talk. Reply with the summary only, as plain text of at most ${limit} characters.`;
}

export function defineTool<Arguments extends object>(definition: ToolDefinition<Arguments>): Readonly<ToolDefinition<Arguments>> {
  if (toolValidators.has(definition)) return definition;
  const { name, description, parameters, authorize, execute, timeoutMs, result, forms, history, readOnly, approval } = definition;
  if (typeof name !== 'string' || !validToolName.test(name) || typeof description !== 'string' || !description.trim() ||
      parameters?.type !== 'object' || typeof execute !== 'function' || (authorize !== undefined && typeof authorize !== 'function')) {
    throw new TypeError('Tool requires a valid name, description, object schema and execute function');
  }
  if ('form' in definition) throw new TypeError(`Tool ${name}: form was replaced by forms, named by x-form in the result schema`);
  if (timeoutMs !== undefined) positiveInteger(timeoutMs, 'tool timeoutMs', 300_000);
  if (result !== undefined && !plainObject(result)) throw new TypeError(`Tool ${name} result must be a JSON schema object`);
  if (history !== undefined && typeof history !== 'boolean') throw new TypeError(`Tool ${name} history must be true or false`);
  if (readOnly !== undefined && typeof readOnly !== 'boolean') throw new TypeError(`Tool ${name} readOnly must be true or false`);
  if (approval !== undefined && typeof approval !== 'boolean' && typeof approval !== 'function') {
    throw new TypeError(`Tool ${name} approval must be true, false or a function`);
  }
  const tool = Object.freeze({
    name, description, parameters: freezeSchema(structuredClone(parameters)), authorize, execute, timeoutMs,
    ...(result === undefined ? {} : { result: freezeSchema(structuredClone(result)) }),
    ...(forms === undefined ? {} : { forms: defineForms(name, forms) }),
    ...(history === undefined ? {} : { history }),
    ...(readOnly === undefined ? {} : { readOnly }),
    ...(approval === undefined || approval === false ? {} : { approval }),
  });
  allowExtensions(tool.parameters);
  try {
    toolValidators.set(tool, schemas.compile<object>(tool.parameters));
  } catch (error) {
    throw new TypeError(`Tool ${name} has an invalid parameters schema: ${(error as Error).message}`);
  }
  const check = tool.result && resultCheck(name, tool.result, tool.forms ?? {});
  if (check) resultChecks.set(tool, check);
  const named = new Set(check ? [check.form, ...check.branches.map(({ form }) => form)] : []);
  const unused = Object.keys(tool.forms ?? {}).filter((form) => !named.has(form));
  if (unused.length) throw new TypeError(`Tool ${name} has forms that no x-form in its result schema names: ${unused.join(', ')}`);
  return tool;
}

function defineForms(toolName: string, forms: Record<string, ToolForm>): Readonly<Record<string, ToolForm>> {
  if (!plainObject(forms)) throw new TypeError(`Tool ${toolName} forms must be an object of forms by name`);
  const entries = Object.entries(forms);
  if (entries.length > maxForms) throw new TypeError(`Tool ${toolName} can have at most ${maxForms} forms`);
  return Object.freeze(Object.fromEntries(entries.map(([formName, form]) => {
    if (!validToolName.test(formName)) throw new TypeError(`Tool ${toolName} has an invalid form name: ${formName}`);
    return [formName, defineForm(`Tool ${toolName} form ${formName}`, form)];
  })));
}

function defineForm(label: string, form: ToolForm): Readonly<ToolForm> {
  const { html, schema, submit, timeoutMs, mcpApp } = form ?? {} as ToolForm;
  if (mcpApp !== undefined && typeof mcpApp !== 'boolean') throw new TypeError(`${label} mcpApp must be true or false`);
  const limit = mcpApp ? maxAppBytes : maxFormBytes;
  if (typeof html !== 'string' || !html.trim() || Buffer.byteLength(html) > limit) {
    throw new TypeError(`${label} requires HTML of at most ${limit} bytes`);
  }
  if (submit !== undefined && typeof submit !== 'function') throw new TypeError(`${label} submit must be a function`);
  // An MCP App submits through its own server's tools, not through the SDK.
  if (mcpApp && submit !== undefined) throw new TypeError(`${label} is an MCP App, so it cannot have submit`);
  // A form without submit only shows the result, so values and a submit time limit would never be used
  if (submit === undefined && (schema !== undefined || timeoutMs !== undefined)) {
    throw new TypeError(`${label} has no submit function, so it cannot have a schema or timeoutMs`);
  }
  if (schema !== undefined && schema?.type !== 'object') throw new TypeError(`${label} schema must be an object schema`);
  if (timeoutMs !== undefined) positiveInteger(timeoutMs, `${label} timeoutMs`, 300_000);
  const defined = Object.freeze({
    html, ...(mcpApp ? { mcpApp: true } : {}), ...(submit === undefined ? {} : { submit }), ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(schema === undefined ? {} : { schema: freezeSchema(structuredClone(schema)) }),
  });
  if (defined.schema) {
    allowExtensions(defined.schema);
    try {
      formValidators.set(defined, schemas.compile<object>(defined.schema));
    } catch (error) {
      throw new TypeError(`${label} has an invalid schema: ${(error as Error).message}`);
    }
  }
  return defined;
}

/** Keywords whose values are data, and keywords whose keys are names rather than keywords. */
const dataKeywords = new Set(['enum', 'const', 'default', 'examples', 'example']);
const namedSchemas = new Set(['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas', 'dependencies']);

/** How many x-form keywords a schema holds anywhere. */
function countFormKeywords(schema: unknown): number {
  if (Array.isArray(schema)) return schema.reduce((total: number, item) => total + countFormKeywords(item), 0);
  if (!schema || typeof schema !== 'object') return 0;
  let total = 0;
  for (const [key, value] of Object.entries(schema)) {
    if (key === 'x-form') total += 1;
    else if (namedSchemas.has(key) && plainObject(value)) total += Object.values(value).reduce((sum: number, child) => sum + countFormKeywords(child), 0);
    else if (!dataKeywords.has(key)) total += countFormKeywords(value);
  }
  return total;
}

/**
 * Compiles a result schema and reads its x-form keywords. x-form is read on the schema itself when it has no direct
 * oneOf or anyOf branches, and otherwise on those branches only; anywhere else it would be ignored, so it is rejected.
 */
function resultCheck(toolName: string, result: Record<string, unknown>, forms: Readonly<Record<string, ToolForm>>): ResultCheck {
  const label = `Tool ${toolName} result schema`;
  allowExtensions(result);
  const compile = (schema: object, part: string) => {
    try {
      return schemas.compile(schema);
    } catch (error) {
      throw new TypeError(`${label} is invalid${part}: ${(error as Error).message}`);
    }
  };
  const formName = (value: unknown, part: string) => {
    if (value === undefined) return undefined;
    if (typeof value !== 'string' || !Object.hasOwn(forms, value)) {
      throw new TypeError(`${label}${part} names a form the tool does not have: ${JSON.stringify(value)}`);
    }
    return value;
  };
  const validate = compile(result, '');
  const groups = (['oneOf', 'anyOf'] as const).filter((keyword) => Array.isArray(result[keyword]));
  let form: string | undefined;
  const branches: ResultCheck['branches'] = [];
  let read = 0;
  if (!groups.length) {
    form = formName(result['x-form'], '');
    read = form === undefined ? 0 : 1;
  } else {
    if (result['x-form'] !== undefined) {
      throw new TypeError(`${label} has oneOf or anyOf branches, so x-form belongs on the branches`);
    }
    const named = groups.some((keyword) => (result[keyword] as unknown[]).some((branch) => plainObject(branch) && branch['x-form'] !== undefined));
    for (const keyword of groups) {
      // A branch is checked together with the rest of the schema, so its $ref and shared keywords still apply.
      const { [keyword]: _branches, ...rest } = result;
      (result[keyword] as unknown[]).forEach((branch, index) => {
        const part = ` ${keyword}[${index}]`;
        const branchForm = plainObject(branch) ? formName(branch['x-form'], part) : undefined;
        if (branchForm !== undefined) read += 1;
        // Only a schema with named branches needs to know which branch a result matches.
        if (!named) return;
        const allOf = Array.isArray(rest.allOf) ? [...rest.allOf, branch] : [branch];
        branches.push({ validate: compile({ ...rest, allOf }, part), ...(branchForm === undefined ? {} : { form: branchForm }) });
      });
    }
  }
  if (countFormKeywords(result) !== read) {
    throw new TypeError(`${label} has x-form in a place that is not read: use it on the schema or on its direct oneOf or anyOf branches`);
  }
  return { validate, ...(form === undefined ? {} : { form }), branches };
}

/** The form a tool shows for a result that matched its result schema, if any. */
function resultForm(tool: ToolDefinition, value: unknown) {
  const check = resultChecks.get(tool);
  if (!check) return undefined;
  if (!check.branches.length) return check.form;
  return check.branches.find(({ validate }) => validate(value))?.form;
}

/** A form of a tool by name; forms is a plain object, so inherited keys are not forms. */
function toolForm(tool: ToolDefinition | undefined, name: unknown) {
  return tool?.forms && typeof name === 'string' && Object.hasOwn(tool.forms, name) ? tool.forms[name] : undefined;
}

/** A stored form with what the chat needs to show it as an MCP App, or as stored when its tool no longer has the form. */
function formView<State extends FormState>(state: State, form: ToolForm | undefined): State & Partial<FormView> {
  if (!form) return state;
  let documents = appDocuments.get(form);
  if (!documents) appDocuments.set(form, documents = new Map());
  const key = JSON.stringify([state.tool, state.form]);
  let html = documents.get(key);
  if (html === undefined) {
    html = form.mcpApp ? form.html : formAppHtml(form.html, { tool: state.tool, form: state.form, submit: Boolean(form.submit) });
    documents.set(key, html);
  }
  return { ...state, html, uri: formUri(state.tool, state.form), mimeType: mcpAppMimeType };
}

/** The arguments of a tool call as an object, for the form it shows; absent when they are not a JSON object. */
function callArguments(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return plainObject(value) ? value as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Vendor extensions (x-*) are annotations, so they are registered instead of failing strict mode. Ajv's getKeyword
 * does not report a keyword added without a definition, so the registered ones are tracked here.
 */
const extensions = new Set<string>();
function allowExtensions(schema: unknown) {
  if (!schema || typeof schema !== 'object') return;
  for (const [key, value] of Object.entries(schema)) {
    if (extensionKeyword.test(key) && !extensions.has(key)) {
      if (!schemas.getKeyword(key)) schemas.addKeyword(key);
      extensions.add(key);
    }
    allowExtensions(value);
  }
}

function freezeSchema<Value>(value: Value): Value {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freezeSchema(child);
    Object.freeze(value);
  }
  return value;
}

export class MemorySessionStore implements SessionStore {
  #sessions = new Map<string, Message[]>();

  async get(key: string) {
    return structuredClone(this.#sessions.get(key) ?? []);
  }

  async set(key: string, messages: Message[]) {
    this.#sessions.set(key, structuredClone(messages));
  }
}

function positiveInteger(value: number, label: string, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new TypeError(`${label} must be an integer between 1 and ${maximum}`);
  }
  return value;
}

function nonEmptyString(value: string, label: string) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${label} is required`);
  return value.trim();
}

function toolDescription({ name, description, parameters }: ToolDefinition) {
  return { name, description, parameters };
}

/**
 * What the model reads about a tool: a tool with forms says, when the turn can show them, that the chat asks the user
 * to confirm (forms with submit) or shows the result itself (forms without).
 */
function modelToolDescription(tool: ToolDefinition, showsForms: boolean) {
  if (!showsForms || !tool.forms) return toolDescription(tool);
  const forms = Object.values(tool.forms);
  const notes = (forms.some(({ submit }) => submit) ? formToolNote : '') + (forms.some(({ submit }) => !submit) ? viewToolNote : '');
  return { ...toolDescription(tool), description: tool.description + notes };
}

function shortJson(value: unknown, limit = 2_000) {
  const text = JSON.stringify(value ?? null);
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

/** One line per form, added to the reply the model reads, so it knows what the user did with each form. */
function formNote({ tool, form, status, result, error }: FormState) {
  const label = typeof form === 'string' ? `Form "${form}" of ${tool}` : `Form of ${tool}`;
  if (status === 'shown') return `[${label}: the result was shown to the user in the chat; there is nothing to submit]`;
  if (status === 'submitted') return `[${label}: the user submitted it. Result: ${shortJson(result)}]`;
  if (status === 'failed') return `[${label}: the submission did not complete (${error?.message ?? 'unknown error'}). It is closed.]`;
  return error
    ? `[${label}: waiting for the user; the last submission was rejected: ${error.message}]`
    : `[${label}: shown to the user, not submitted yet]`;
}

/** A copy with strings and arrays cut to the given sizes; a cut array ends with a note of how many items it left out. */
function shrink(value: unknown, items: number, chars: number): unknown {
  if (typeof value === 'string') return value.length > chars ? `${value.slice(0, chars)}…` : value;
  if (Array.isArray(value)) {
    const kept = value.slice(0, items).map((item) => shrink(item, items, chars));
    return value.length > items ? [...kept, `…(${value.length - items} more items)`] : kept;
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, shrink(item, items, chars)]));
  }
  return value;
}

/** JSON of at most limit characters. Long strings and arrays are cut first, so the shape of the value stays readable. */
function compactJson(value: unknown, limit: number) {
  let text = JSON.stringify(value ?? null);
  for (let items = 50, chars = 500; text.length > limit && items >= 1; items = Math.floor(items / 2), chars = Math.max(40, Math.floor(chars / 2))) {
    text = JSON.stringify(shrink(value ?? null, items, chars));
  }
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

/** value cut like compactJson, still a JSON value: the cut text itself when it no longer parses. */
function cutValue(value: unknown, limit: number): unknown {
  const text = compactJson(value, limit);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** What the session keeps of a tool call: the arguments, and the result within room characters unless the tool opts out. */
function toolRecord(call: ToolCall, tool: ToolDefinition | undefined, output: ToolOutput, room: number): ToolRecord {
  let args: unknown = call.arguments;
  try {
    args = JSON.parse(call.arguments);
  } catch {
    // Kept as the text the model sent.
  }
  const record: ToolRecord = { name: String(call.name).slice(0, 64), arguments: compactJson(args, maxRecordArguments), ok: output.ok };
  const limit = Math.min(maxRecordResult, room);
  if (tool?.history === false || limit < minRecordResult) return record;
  return { ...record, result: compactJson(output.ok ? output.value : output.error, limit) };
}

function toolBlock(tools: ToolRecord[], withResults: boolean) {
  const lines = tools.map(({ name, arguments: args, ok, result }) => {
    const call = `- ${name}(${args})`;
    if (!withResults || result === undefined) return `${call} ${ok ? 'completed' : 'failed'}; result not kept`;
    return ok ? `${call} returned ${result}` : `${call} failed: ${result}`;
  });
  return `${toolBlockHeader}\n${lines.join('\n')}]`;
}

/**
 * The text the model reads for a stored message: the text, then the files sent with it, the tool calls behind it and its
 * forms. A message of files only has no text of its own.
 */
function messageText({ content, attachments, tools, forms }: Message, withResults: boolean) {
  return [
    ...(content ? [content] : []), ...(attachments?.length ? [attachmentNote(attachments)] : []),
    ...(tools?.length ? [toolBlock(tools, withResults)] : []), ...(forms ?? []).map(formNote),
  ].join('\n');
}

function hasResults(message: Message) {
  return message.tools?.some(({ result }) => result !== undefined) ?? false;
}

function turnCount(messages: Message[]) {
  return messages.filter(({ role, summary }) => role === 'user' && !summary).length;
}

/**
 * How the model's view of a history fits in budget characters: tool results are left out first, oldest message first,
 * and only then, when trim allows it, whole turns from the start. start is the first message kept; the results of
 * the first dropped of the kept messages are left out.
 */
function historyPlan(messages: Message[], budget: number, trim: boolean) {
  const full = messages.map((message) => messageText(message, true).length);
  const bare = messages.map((message, index) => hasResults(message) ? messageText(message, false).length : full[index]);
  for (let start = 0; start < (trim ? messages.length : 1); start++) {
    if (start > 0 && messages[start].role !== 'user') continue;
    let size = full.slice(start).reduce((sum, length) => sum + length, 0);
    if (size <= budget) return { start, dropped: 0, fits: true };
    for (let index = start; index < messages.length; index++) {
      if (bare[index] === full[index]) continue;
      size -= full[index] - bare[index];
      if (size <= budget) return { start, dropped: index + 1 - start, fits: true };
    }
  }
  return { start: trim ? Math.max(0, messages.length - 1) : 0, dropped: messages.length, fits: false };
}

/** The history the model reads. A summary is joined to the message after it when both have the same role. */
function modelHistory(messages: Message[], dropped = 0) {
  const history: ModelMessage[] = [];
  let joinNext = false;
  messages.forEach((message, index) => {
    const text = messageText(message, index >= dropped);
    const content = message.summary ? `${summaryLabel}\n${text}` : text;
    const previous = history.at(-1);
    if (joinNext && previous?.role === message.role) previous.content += `\n\n${content}`;
    else history.push({ role: message.role, content });
    joinNext = message.summary === true;
  });
  return history;
}

/** The history the model reads within budget characters, leaving out tool results and then the oldest turns. */
function fittedHistory(messages: Message[], budget: number) {
  const { start, dropped } = historyPlan(messages, budget, true);
  return modelHistory(messages.slice(start), dropped);
}

/** The older turns as one text for the model that summarizes them, within twice the budget. */
function transcript(messages: Message[], budget: number) {
  const { start, dropped } = historyPlan(messages, budget * 2, true);
  return messages.slice(start).map((message, index) => {
    const label = message.summary ? 'Earlier summary' : message.role === 'user' ? 'User' : 'Assistant';
    return `${label}:\n${messageText(message, index >= dropped)}`;
  }).join('\n\n');
}

function plainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function readHistory(messages: Message[]): Message[] {
  if (!Array.isArray(messages)) throw new TypeError('history must be an array of messages');
  return messages.map(({ role, content, tools, summary, attachments }) => {
    if (role !== 'user' && role !== 'assistant') throw new TypeError('A history role must be user or assistant');
    const files = attachments === undefined ? [] : readAttachmentInfo(attachments);
    return {
      // A user message of files only, as stored, has empty content.
      role, content: files.length && role === 'user' && content === '' ? '' : nonEmptyString(content, 'history content'),
      ...(files.length ? { attachments: files } : {}),
      ...(tools === undefined ? {} : { tools: readToolRecords(tools) }),
      ...(summary === true ? { summary } : {}),
    };
  });
}

function readToolRecords(tools: unknown): ToolRecord[] {
  if (!Array.isArray(tools)) throw new TypeError('history tools must be an array of tool records');
  return tools.map((record: Partial<ToolRecord> | null) => {
    const { name, arguments: args, ok, result } = record ?? {};
    if (typeof name !== 'string' || typeof args !== 'string' || typeof ok !== 'boolean' ||
        (result !== undefined && typeof result !== 'string')) {
      throw new TypeError('A history tool record needs a name, arguments and result as strings and ok as a boolean');
    }
    return { name, arguments: args, ok, ...(result === undefined ? {} : { result }) };
  });
}

function addUsage(total: Required<ModelUsage> & { modelCalls: number }, reported?: ModelUsage) {
  for (const field of ['promptTokens', 'cachedTokens', 'completionTokens'] as const) {
    const value = reported?.[field];
    if (Number.isSafeInteger(value) && value! >= 0) total[field] += value!;
  }
}

async function abortable<Result>(signal: AbortSignal, operation: () => Result | Promise<Result>): Promise<Result> {
  signal.throwIfAborted();
  let rejectAbort!: (reason: unknown) => void;
  const aborted = new Promise<never>((_, reject) => { rejectAbort = reject; });
  const onAbort = () => rejectAbort(signal.reason);
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    return await Promise.race([aborted, Promise.resolve().then(() => {
      signal.throwIfAborted();
      return operation();
    })]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

function failedTool(code: string, message: string): ToolOutput {
  return { ok: false, error: { code, message } };
}

export class ToolError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'ToolError';
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(code)) throw new TypeError('ToolError code must be a lower-case identifier');
    this.code = code;
  }
}

/** What a tool call came to: its output, or a question for the user about these validated arguments. */
type CallOutcome = ToolOutput | { approval: Record<string, unknown> };

function needsApproval(outcome: CallOutcome): outcome is { approval: Record<string, unknown> } {
  return 'approval' in outcome;
}

/**
 * How a call of a tool with approval goes: ask the user, skip the question because the user already approved the call,
 * or fail because the run cannot wait for an answer.
 */
type ApprovalMode = 'ask' | 'skip' | 'unavailable';

interface CallHooks {
  beforeTool: SDKOptions['beforeTool'];
  afterTool: SDKOptions['afterTool'];
  available: string[];
  approval: ApprovalMode;
}

async function executeTool(call: ToolCall, tool: ToolDefinition | undefined, runContext: ToolContext,
  { beforeTool, afterTool, available, approval }: CallHooks): Promise<CallOutcome> {
  const started = performance.now();
  const output = await toolOutput(call, tool, runContext, beforeTool, available, approval);
  // The call has not run yet; afterTool sees it once it does.
  if (needsApproval(output)) return output;
  if (afterTool) {
    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(call.arguments) as Record<string, unknown>;
    } catch {
      // The policy hook still reports the call that failed to parse.
    }
    try {
      await afterTool({ name: call.name, arguments: args, context: { ...runContext },
        output, durationMs: Math.round(performance.now() - started) });
    } catch {
      // An observer cannot change the outcome of a tool call.
    }
  }
  return output;
}

/**
 * Models often send null for an optional argument they mean to leave out. Arguments that fail the schema are
 * checked once more without those nulls. Only declared top-level properties that are not required are dropped,
 * and a schema that accepts null never reaches this step, so its nulls are kept.
 */
function withoutOptionalNulls(args: unknown, parameters: ToolDefinition['parameters']) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return undefined;
  const properties = parameters.properties && typeof parameters.properties === 'object' ? parameters.properties : {};
  const required = new Set(Array.isArray(parameters.required) ? parameters.required : []);
  const entries = Object.entries(args);
  const kept = entries.filter(([key, value]) => value !== null || required.has(key) || !Object.hasOwn(properties, key));
  return kept.length === entries.length ? undefined : Object.fromEntries(kept);
}

async function toolOutput(call: ToolCall, tool: ToolDefinition | undefined, runContext: ToolContext,
  beforeTool: SDKOptions['beforeTool'], available: string[], approval: ApprovalMode): Promise<CallOutcome> {
  if (!tool) {
    return failedTool('unknown_tool', `This tool is unavailable for the current agent. Available tools: ${available.join(', ') || 'none'}.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(call.arguments);
  } catch {
    return failedTool('invalid_arguments', 'Tool arguments must be a JSON object.');
  }

  const validate = toolValidators.get(tool)!;
  let args: object;
  if (validate(parsed)) {
    args = parsed;
  } else {
    const cleaned = withoutOptionalNulls(parsed, tool.parameters);
    if (!cleaned || !validate(cleaned)) {
      return failedTool('invalid_arguments', schemas.errorsText(validate.errors, { dataVar: 'arguments' }));
    }
    args = cleaned;
  }

  const runSignal = runContext.signal;
  const deadline = tool.timeoutMs === undefined ? undefined : AbortSignal.timeout(tool.timeoutMs);
  const signal = deadline ? AbortSignal.any([runSignal, deadline]) : runSignal;
  const context = { ...runContext, signal };
  let policyPending = false;
  try {
    if (tool.authorize && await abortable(signal, () => tool.authorize!(args, context)) !== true) {
      return failedTool('tool_forbidden', 'The caller is not authorized to use this tool for the requested resource.');
    }
    if (beforeTool) {
      policyPending = true;
      const policyArguments = structuredClone(args) as Record<string, unknown>;
      if (await abortable(signal, () => beforeTool({ name: call.name, arguments: policyArguments, context: { ...context } })) !== true) {
        return failedTool('tool_forbidden', 'The application policy denied this tool call.');
      }
      policyPending = false;
    }
    if (tool.approval && approval !== 'skip') {
      let asks = tool.approval === true;
      if (typeof tool.approval === 'function') {
        const check = tool.approval;
        try {
          asks = await abortable(signal, () => check(structuredClone(args), { ...context })) !== false;
        } catch (error) {
          if (signal.aborted) throw error;
          // A check that fails asks the user rather than letting the call through.
          asks = true;
        }
      }
      if (asks && approval === 'unavailable') {
        return failedTool('approval_unavailable', 'This tool call needs the user\'s approval, which this conversation cannot ask for.');
      }
      if (asks) return { approval: structuredClone(args) as Record<string, unknown> };
    }
    const value = await abortable(signal, () => tool.execute(args, context));
    const text = JSON.stringify({ ok: true, value: value ?? null });
    // An oversized result reaches the model cut, so it still reads what it can instead of an error.
    if (Buffer.byteLength(text) > maxResultBytes) return { ok: true, value: cutValue(JSON.parse(text).value, maxCutResult), truncated: true };
    const output = JSON.parse(text);
    const check = resultChecks.get(tool);
    if (check && !check.validate(output.value)) {
      return failedTool('invalid_result',
        `The tool returned a result that does not match its result schema: ${schemas.errorsText(check.validate.errors, { dataVar: 'result' })}`);
    }
    return output;
  } catch (error) {
    if (runSignal.aborted) return failedTool('tool_cancelled', 'The run ended while this tool call was pending.');
    if (deadline?.aborted) return failedTool('tool_timeout', `The tool exceeded its ${tool.timeoutMs} ms time limit.`);
    if (policyPending) return failedTool('tool_policy_failed', 'The application policy could not evaluate the tool call.');
    if (error instanceof ToolError) return failedTool(error.code, error.message);
    return failedTool('tool_failed', 'The tool could not complete the request.');
  }
}

/** What the session keeps of a reply an output guardrail blocked without a reply of its own. */
const withheldReply = '[The reply was withheld by an output guardrail.]';
const maxApprovalReason = 500;

/** Token counts for a span, leaving out the ones the model did not report. */
function usageAttributes(usage?: ModelUsage) {
  const count = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : undefined;
  return {
    'gen_ai.usage.input_tokens': count(usage?.promptTokens),
    'gen_ai.usage.output_tokens': count(usage?.completionTokens),
    'gen_ai.usage.cache_read.input_tokens': count(usage?.cachedTokens),
  };
}

/** A form as the session stores it, without the document the chat shows. */
function withoutHtml(view: FormState & Partial<FormView>): FormState {
  const { html: _html, uri: _uri, mimeType: _mimeType, ...form } = view;
  return form;
}

/** What the model reads about the tools of a turn. Forms are offered only when the turn is stored, because submitting one needs its stored record. */
function describeTools(tools: Map<string, ToolDefinition>, stored: boolean) {
  return Array.from(tools.values(), (tool) => modelToolDescription(tool, stored));
}

function readDecisions(value: unknown): ApprovalDecision[] {
  if (!Array.isArray(value) || !value.length) throw new TypeError('approvals must be a non-empty array of decisions');
  return value.map((item: Partial<ApprovalDecision> | null) => {
    const { id, approved, reason } = item ?? {};
    if (typeof id !== 'string' || !id || typeof approved !== 'boolean' || (reason !== undefined && typeof reason !== 'string')) {
      throw new TypeError('Each approval decision needs an id, approved as true or false and, when given, reason as a string');
    }
    const text = reason?.trim();
    return { id, approved, ...(text ? { reason: text.slice(0, maxApprovalReason) } : {}) };
  });
}

/** What a run or resume shares with the steps of its turn. */
interface Runtime {
  runId: string;
  signal: AbortSignal;
  trace: TraceEntry[];
  usage: Required<ModelUsage> & { modelCalls: number };
  emit(event: RunEvent): void;
  result(fields: RunOutcome): RunResult;
  /** The model streams its text, because the caller observes the run. */
  streaming: boolean;
  onDelta?: (text: string) => void;
}

interface CallOptions {
  signal?: AbortSignal;
  onEvent?: RunOptions['onEvent'];
  onDelta?: RunOptions['onDelta'];
}

/** The state of a turn while the model and its tools work on it. */
interface Turn {
  key: string;
  sessionId: string;
  context: RunContext;
  /** The turn is saved in the session store, rather than run on history the caller gave. */
  stored: boolean;
  /** The session with the user message of this turn last. */
  messages: Message[];
  history: ModelMessage[];
  steps: ModelStep[];
  callIds: Set<string>;
  /** Forms chosen by the results of this turn, when the turn is stored. */
  shown: FormView[];
  /** The tool calls of this turn, kept with the reply for later turns. */
  records: ToolRecord[];
  recordRoom: number;
  tools: Map<string, ToolDefinition>;
  descriptions: ReturnType<typeof modelToolDescription>[];
  /** Approvals of this turn that were already answered or expired. */
  approvals: ApprovalState[];
}

/** A turn that waits for approvals, as its user message stores it. */
interface PendingTurn {
  version: 1;
  step: number;
  continuation: unknown;
  calls: ToolCall[];
  /** null for the calls that have not run. */
  outputs: (ToolOutput | null)[];
  history: ModelMessage[];
  steps: ModelStep[];
  callIds: string[];
  trace: TraceEntry[];
  records: ToolRecord[];
  recordRoom: number;
  forms: FormState[];
  /** The tools the turn started with, by name. */
  tools: string[];
}

export function createSDK({
  model, tools = [], sessionStore = new MemorySessionStore(), maxTurns = 20, historyBudget = 12_000, beforeTool, afterTool,
  guardrails, tracer,
}: SDKOptions) {
  if (typeof model?.generate !== 'function') throw new TypeError('A model adapter is required');
  for (const [hook, name] of [[beforeTool, 'beforeTool'], [afterTool, 'afterTool']] as const) {
    if (hook !== undefined && typeof hook !== 'function') throw new TypeError(`${name} must be a function`);
  }
  if (tracer !== undefined && typeof tracer?.startActiveSpan !== 'function') {
    throw new TypeError('tracer must be an OpenTelemetry tracer with startActiveSpan');
  }
  const sdkGuardrails = guardrailLists(guardrails, 'guardrails');
  positiveInteger(maxTurns, 'maxTurns', 50);
  if (positiveInteger(historyBudget, 'historyBudget', 1_000_000) < 1_000) {
    throw new TypeError('historyBudget must be an integer between 1000 and 1000000');
  }
  /** The history budget in characters. */
  const budget = historyBudget * charsPerToken;
  const registry = new Map<string, ToolDefinition>();
  const activeSessions = new Map<string, Promise<void>>();

  function registerTool<Arguments extends object>(definition: ToolDefinition<Arguments>) {
    const tool = defineTool(definition);
    if (registry.has(tool.name)) throw new TypeError(`Tool already registered: ${tool.name}`);
    registry.set(tool.name, tool);
    return tool;
  }

  for (const tool of tools) registerTool(tool);

  async function withSession<Result>(key: string, signal: AbortSignal, operation: () => Promise<Result>) {
    const prior = activeSessions.get(key) ?? Promise.resolve();
    let release!: () => void;
    const done = new Promise<void>((resolve) => { release = resolve; });
    const tail = prior.then(() => done);
    activeSessions.set(key, tail);
    try {
      await abortable(signal, () => prior);
      return await operation();
    } finally {
      release();
      void tail.then(() => {
        if (activeSessions.get(key) === tail) activeSessions.delete(key);
      });
    }
  }

  function createAgent({
    id = randomUUID(), systemPrompt, tools: selected = [], maxSteps = defaultRunLimits.maxSteps,
    maxToolCalls = defaultRunLimits.maxToolCalls, timeoutMs = defaultRunLimits.timeoutMs, model: agentModel = model,
    name, guardrails: own,
  }: AgentOptions) {
    const agentId = nonEmptyString(id, 'id');
    const prompt = nonEmptyString(systemPrompt, 'systemPrompt');
    const agentName = name === undefined ? agentId : nonEmptyString(name, 'name');
    positiveInteger(maxSteps, 'maxSteps', 50);
    positiveInteger(maxToolCalls, 'maxToolCalls', 100);
    positiveInteger(timeoutMs, 'timeoutMs', 300_000);
    if (typeof agentModel?.generate !== 'function') throw new TypeError('Invalid model adapter');
    const agentGuardrails = guardrailLists(own, 'agent guardrails');
    const inputGuardrails = [...sdkGuardrails.input, ...agentGuardrails.input];
    const outputGuardrails = [...sdkGuardrails.output, ...agentGuardrails.output];

    const configuredTools = new Map<string, ToolDefinition>();

    function resolveTool(entry: string | ToolDefinition) {
      const tool = typeof entry === 'string' ? registry.get(entry) : defineTool(entry);
      if (!tool) throw new TypeError(`Tool not registered: ${entry}`);
      return tool;
    }

    function addTool(entry: string | ToolDefinition) {
      const tool = resolveTool(entry);
      if (configuredTools.has(tool.name)) throw new TypeError(`Tool selected twice: ${tool.name}`);
      configuredTools.set(tool.name, tool);
    }

    function selectTools(entries: (string | ToolDefinition)[]) {
      if (!Array.isArray(entries)) throw new TypeError('tools must be an array');
      const selection = new Map<string, ToolDefinition>();
      for (const entry of entries) {
        const tool = resolveTool(entry);
        if (selection.has(tool.name)) throw new TypeError(`Tool selected twice: ${tool.name}`);
        selection.set(tool.name, tool);
      }
      return selection;
    }

    for (const entry of selected) addTool(entry);

    function sessionKey(sessionId: string, context: RunContext) {
      return JSON.stringify([context.appId ?? '', context.tenantId ?? '', context.userId ?? '', agentId,
        nonEmptyString(sessionId, 'sessionId')]);
    }

    const chatSpan = agentModel.model ? `chat ${agentModel.model}` : 'chat';
    const chatAttributes = {
      'gen_ai.operation.name': 'chat', 'gen_ai.provider.name': agentModel.provider, 'gen_ai.request.model': agentModel.model,
    };

    /** Calls the model in a chat span that records the tokens it reports. */
    function traceModel(operation: () => Promise<ModelReply>) {
      return inSpan(tracer, chatSpan, spanKind.client, chatAttributes, async (span) => {
        const reply = await operation();
        setAttributes(span, usageAttributes(reply.usage));
        return reply;
      });
    }

    /** Runs a tool call in an execute_tool span; a call that fails marks the span with its error code. */
    function traceTool(call: ToolCall, tool: ToolDefinition | undefined, operation: () => Promise<CallOutcome>) {
      const name = String(call.name).slice(0, 64);
      return inSpan(tracer, `execute_tool ${name}`, spanKind.internal, {
        'gen_ai.operation.name': 'execute_tool', 'gen_ai.tool.name': name, 'gen_ai.tool.call.id': call.id,
        'gen_ai.tool.type': 'function', 'gen_ai.tool.description': tool?.description,
      }, async (span) => {
        const outcome = await operation();
        if (!needsApproval(outcome) && !outcome.ok) failSpan(span, outcome.error.code, outcome.error.message);
        return outcome;
      });
    }

    /**
     * Runs one call of run or resume: it waits for the session, keeps the time limit, reports events and the
     * invoke_agent span, and turns an exception into the run's status.
     */
    async function execute(key: string, sessionId: string, { signal: callerSignal, onEvent, onDelta }: CallOptions,
      body: (runtime: Runtime) => Promise<RunResult>): Promise<RunResult> {
      const timeout = AbortSignal.timeout(timeoutMs);
      const signal = callerSignal ? AbortSignal.any([callerSignal, timeout]) : timeout;
      const runId = randomUUID();
      const trace: TraceEntry[] = [];
      const usage = { promptTokens: 0, cachedTokens: 0, completionTokens: 0, modelCalls: 0 };
      const start = performance.now();
      const result = (fields: RunOutcome): RunResult => ({
        runId, trace, usage, durationMs: Math.round(performance.now() - start), ...fields,
      });
      function emit(event: RunEvent) {
        if (!onEvent) return;
        try {
          void Promise.resolve(onEvent(structuredClone(event))).catch(() => {});
        } catch {
          // An observer cannot change the outcome of the run.
        }
      }
      const runtime: Runtime = {
        runId, signal, trace, usage, emit, result, onDelta,
        // Output guardrails read the whole reply before the user does, so a reply they check is not streamed.
        streaming: (onDelta !== undefined || onEvent !== undefined) && !outputGuardrails.length,
      };

      emit({ type: 'run.queued', runId });
      return inSpan(tracer, `invoke_agent ${agentName}`, spanKind.internal, {
        'gen_ai.operation.name': 'invoke_agent', 'gen_ai.provider.name': agentModel.provider, 'gen_ai.agent.id': agentId,
        'gen_ai.agent.name': agentName, 'gen_ai.conversation.id': sessionId, 'gen_ai.request.model': agentModel.model,
      }, async (span) => {
        let outcome: RunResult;
        try {
          outcome = await withSession(key, signal, async () => {
            signal.throwIfAborted();
            emit({ type: 'run.started', runId });
            return body(runtime);
          });
        } catch (error) {
          if (signal.aborted) {
            outcome = callerSignal?.aborted && signal.reason === callerSignal.reason
              ? result({ status: 'cancelled', error: { code: 'cancelled', message: 'The run was cancelled.' } })
              : result({ status: 'timed_out', error: { code: 'timeout', message: 'The run exceeded its time limit.' } });
          } else {
            outcome = result({ status: 'error', error: {
              code: error instanceof ModelError ? error.code : 'run_failed',
              message: error instanceof ModelError ? error.message : 'The agent could not complete the run.',
            } });
          }
        }
        if (usage.modelCalls) setAttributes(span, usageAttributes(usage));
        if (outcome.status === 'error' || outcome.status === 'cancelled' || outcome.status === 'timed_out') {
          failSpan(span, outcome.error.code, outcome.error.message);
        }
        emit({ type: 'run.finished', runId, result: outcome });
        return outcome;
      });
    }

    /**
     * Runs the guardrails of a stage over a text, in order: each reads the text as the ones before it left it. The
     * first that blocks, fails or answers in an unknown shape stops the text.
     */
    async function checkText(runtime: Runtime, stage: 'input' | 'output', text: string, sessionId: string, context: RunContext,
      attachments?: AttachmentInfo[]): Promise<GuardrailDecision> {
      const list = stage === 'input' ? inputGuardrails : outputGuardrails;
      const { runId, signal, emit } = runtime;
      const subject = stage === 'input' ? 'message' : 'reply';
      let current = text;
      for (const guardrail of list) {
        let verdict: ReturnType<typeof readVerdict>;
        try {
          verdict = readVerdict(await abortable(signal, () => guardrail({
            stage, text: current, ...(attachments?.length ? { attachments: structuredClone(attachments) } : {}),
            agentId, sessionId, context: { ...context }, signal,
          })));
        } catch (error) {
          if (signal.aborted) throw error;
          verdict = undefined;
        }
        if (!verdict?.allowed) {
          emit({ type: 'guardrail.triggered', runId, stage, action: 'blocked' });
          if (!verdict) return { allowed: false, code: 'guardrail_failed', message: `A guardrail could not check the ${subject}.` };
          return {
            allowed: false, code: stage === 'input' ? 'input_blocked' : 'output_blocked',
            message: `A guardrail blocked the ${subject}${verdict.reason ? `: ${verdict.reason}` : '.'}`,
            ...(verdict.reply ? { reply: verdict.reply } : {}),
          };
        }
        if (verdict.text !== undefined) current = verdict.text.trim();
      }
      if (current !== text) emit({ type: 'guardrail.triggered', runId, stage, action: 'rewritten' });
      return { allowed: true, text: current, rewritten: current !== text };
    }

    /**
     * Folds the older turns into one summary the model writes, keeping in full the newest turns that fit in half
     * the budget, up to half of maxTurns. Forms of those turns that are still open move to the summary, so they
     * can still be submitted. The summary is saved with the turn; if it cannot be written, this run reads a
     * trimmed history and the next one tries again.
     */
    async function compactHistory({ runId, signal, usage, emit }: Runtime, messages: Message[]): Promise<Message[]> {
      let cut = messages.length;
      let size = 0;
      for (let index = messages.length - 1, turns = 0; index >= 0 && !messages[index].summary; index--) {
        size += messageText(messages[index], true).length;
        if (messages[index].role !== 'user') continue;
        turns += 1;
        if (size > budget / 2 || turns > Math.max(1, Math.floor(maxTurns / 2))) break;
        cut = index;
      }
      const older = messages.slice(0, cut);
      // A summary that already fits is not written again just because the new message is long.
      if (!older.length || (older.length === 1 && older[0].summary && messageText(older[0], true).length <= budget / 2)) {
        return messages;
      }
      const started = performance.now();
      let text: string | undefined;
      try {
        const reply = await traceModel(() => abortable(signal, () => agentModel.generate({
          systemPrompt: summaryPrompt(Math.floor(budget / 4)), history: [{ role: 'user', content: transcript(older, budget) }],
          steps: [], tools: [], toolChoice: 'none', signal,
        })));
        usage.modelCalls += 1;
        addUsage(usage, reply.usage);
        if (!reply.toolCalls?.length && typeof reply.text === 'string' && reply.text.trim()) text = reply.text.trim();
      } catch (error) {
        if (signal.aborted) throw error;
      }
      emit({ type: 'history.compacted', runId, status: text ? 'completed' : 'error', turns: turnCount(older),
        durationMs: Math.round(performance.now() - started) });
      if (!text) return messages;
      const limit = Math.floor(budget / 2);
      const open = older.flatMap(({ forms }) => forms ?? []).filter(({ status }) => status === 'open');
      return [{
        role: 'user', content: text.length > limit ? `${text.slice(0, limit)}…` : text, summary: true,
        ...(open.length ? { forms: open } : {}),
      }, ...messages.slice(cut)];
    }

    /**
     * Saves the turn and returns the answer after the output guardrails; a limit marks an answer given after tools
     * were withdrawn. A blocked answer is saved as the guardrail's reply, without the forms of the turn.
     */
    async function finish(runtime: Runtime, turn: Turn, text: string, data?: unknown, limit?: AgentError): Promise<RunResult> {
      const { signal, result, trace } = runtime;
      signal.throwIfAborted();
      const checked = await checkText(runtime, 'output', text, turn.sessionId, turn.context);
      const answer = checked.allowed ? checked.text : checked.reply ?? withheldReply;
      const shown = checked.allowed ? turn.shown : [];
      signal.throwIfAborted();
      if (turn.stored) {
        const saved: Message[] = [...turn.messages, {
          role: 'assistant', content: answer, trace, ...(turn.records.length ? { tools: turn.records } : {}),
          ...(shown.length ? { forms: shown.map(withoutHtml) } : {}),
          ...(turn.approvals.length ? { approvals: turn.approvals } : {}),
        }];
        // Older turns are summarized at the start of a run. Should that keep failing, the oldest turns go here instead.
        await sessionStore.set(turn.key, turnCount(saved) > maxTurns * 2 ? saved.slice(-maxTurns * 4) : saved);
      }
      if (!checked.allowed) {
        return result({ status: 'blocked', stage: 'output', text: answer, error: { code: checked.code, message: checked.message } });
      }
      const forms = turn.stored && shown.length ? { forms: shown } : {};
      if (limit) return result({ status: 'limit_reached', text: answer, error: limit, ...forms });
      return result({ status: 'completed', text: answer, ...(data === undefined ? {} : { data }), ...forms });
    }

    async function callModel(runtime: Runtime, step: number, input: ModelInput): Promise<ModelReply> {
      const { runId, signal, emit, usage, streaming, onDelta } = runtime;
      emit({ type: 'model.started', runId, step });
      const modelStarted = performance.now();
      let modelStatus: 'completed' | 'error' = 'error';
      const reply = await traceModel(() => abortable(signal, () => streaming && agentModel.stream
        ? agentModel.stream(input, (text) => {
          if (typeof text !== 'string' || !text) return;
          emit({ type: 'model.delta', runId, step, text });
          if (onDelta) {
            try {
              onDelta(text);
            } catch {
              // An observer cannot change the outcome of the run.
            }
          }
        })
        : agentModel.generate(input))).then((value) => {
        modelStatus = 'completed';
        return value;
      }).finally(() => {
        emit({ type: 'model.finished', runId, step, durationMs: Math.round(performance.now() - modelStarted), status: modelStatus });
      });
      usage.modelCalls += 1;
      addUsage(usage, reply.usage);
      return reply;
    }

    /**
     * Calls the model for a step of the turn and recovers once from each of two failures: a request larger than the
     * context window is sent again with the turn's tool results and history cut, and a reply cut off at the output
     * token limit is asked for again, more briefly.
     */
    async function stepModel(runtime: Runtime, turn: Turn, step: number, input: ModelInput): Promise<ModelReply> {
      let shrunk = false;
      let brief = false;
      for (;;) {
        try {
          return await callModel(runtime, step, input);
        } catch (error) {
          if (runtime.signal.aborted || !(error instanceof ModelError)) throw error;
          if (error.code === 'provider_context_exceeded' && !shrunk) {
            shrunk = true;
            shrinkTurn(turn);
            input = { ...input, history: turn.history, steps: turn.steps };
          } else if (error.code === 'provider_truncated' && !brief) {
            brief = true;
            input = { ...input, systemPrompt: input.systemPrompt + briefNote };
          } else {
            throw error;
          }
        }
      }
    }

    /** Cuts the turn to fit a smaller context: each tool result to a short preview, the history to half its budget. */
    function shrinkTurn(turn: Turn) {
      for (const done of turn.steps) {
        for (const entry of done.outputs) {
          const { output } = entry;
          if (output.ok && JSON.stringify(output.value ?? null).length > overflowResult) {
            entry.output = { ...output, value: cutValue(output.value, overflowResult), truncated: true };
          }
        }
      }
      // Only the message of this turn carries its files, so they stay.
      const attachments = turn.history.at(-1)?.attachments;
      turn.history = fittedHistory(turn.messages, Math.floor(budget / 2));
      if (attachments) turn.history[turn.history.length - 1] = { ...turn.history.at(-1)!, attachments };
    }

    /** Calls the model step by step from firstStep, running the tools it asks for, until it answers. */
    async function drive(runtime: Runtime, turn: Turn, firstStep: number): Promise<RunResult> {
      const { signal, result } = runtime;
      let limitStep = Math.max(maxSteps, firstStep - 1);
      for (let step = firstStep; step <= maxSteps; step++) {
        const reply = await stepModel(runtime, turn, step, {
          systemPrompt: prompt, history: turn.history, steps: turn.steps, tools: turn.descriptions, signal,
        });
        const toolCalls = reply.toolCalls ?? [];
        if (!toolCalls.length) {
          if (typeof reply.text !== 'string' || !reply.text.trim()) {
            return result({ status: 'error', error: { code: 'empty_reply', message: 'The model returned an empty reply.' } });
          }
          return finish(runtime, turn, reply.text);
        }

        if (step === maxSteps || turn.callIds.size + toolCalls.length > maxToolCalls) {
          limitStep = step;
          break;
        }
        const requestedIds = toolCalls.map((call) => call.id);
        if (requestedIds.some((id) => typeof id !== 'string' || !id || turn.callIds.has(id)) ||
            new Set(requestedIds).size !== requestedIds.length) {
          return result({ status: 'error', error: { code: 'duplicate_call', message: 'The model returned invalid or repeated tool call IDs.' } });
        }
        const ended = await runStep(runtime, turn, step, reply.continuation, toolCalls, toolCalls.map(() => null));
        if (ended) return ended;
      }

      // The model still wanted tools. Those calls are skipped, and one closing call without tools
      // asks for an answer from what the run has gathered, so the user is not left without a reply.
      const limit = { code: 'run_limit', message: 'The run reached its model or tool call limit.' };
      let closing: ModelReply;
      try {
        closing = await stepModel(runtime, turn, limitStep + 1, {
          systemPrompt: prompt + toolsWithdrawnNote, history: turn.history, steps: turn.steps, tools: turn.descriptions,
          toolChoice: 'none', signal,
        });
      } catch (error) {
        if (signal.aborted) throw error;
        return result({ status: 'limit_reached', error: limit });
      }
      // A reply that still calls tools is a preamble to work that will not happen, not an answer.
      if (closing.toolCalls?.length || typeof closing.text !== 'string' || !closing.text.trim()) {
        return result({ status: 'limit_reached', error: limit });
      }
      return finish(runtime, turn, closing.text, undefined, limit);
    }

    /**
     * Runs the calls of a step that have no output yet, then continues the turn (undefined), ends it with the reply a
     * tool wrote, or pauses it while calls wait for approval. Calls of read-only tools that follow one another run at
     * the same time; results are applied in the order the model made the calls either way. decisions holds the
     * answers to approvals when a turn resumes: an approved call runs without asking again, a denied one fails.
     */
    async function runStep(runtime: Runtime, turn: Turn, step: number, continuation: unknown, calls: ToolCall[],
      outputs: (ToolOutput | null)[], decisions?: Map<string, ApprovalState>): Promise<RunResult | undefined> {
      const { runId, signal, emit, trace } = runtime;
      const todo = calls.map((_, index) => index).filter((index) => outputs[index] === null);
      const written: ({ text: string; data?: unknown } | undefined)[] = [];
      const entries: TraceEntry[] = [];
      const outcomes: CallOutcome[] = [];
      const available = [...turn.tools.keys()];
      const parallel = (index: number) => turn.tools.get(calls[index].name)?.readOnly === true;

      async function launch(index: number): Promise<CallOutcome> {
        const call = calls[index];
        const tool = turn.tools.get(call.name);
        const decision = decisions?.get(call.id);
        const started = performance.now();
        const context: ToolContext = {
          ...turn.context, agentId, sessionId: turn.sessionId, runId, toolCallId: call.id, signal,
          reply(text: string, data?: unknown) {
            written[index] ??= { text: nonEmptyString(text, 'reply text'), data };
          },
        };
        const outcome: CallOutcome = decision?.status === 'denied'
          ? failedTool('tool_rejected', decision.reason
            ? `The user did not approve this tool call. Their reason: ${decision.reason}`
            : 'The user did not approve this tool call.')
          : await traceTool(call, tool, () => executeTool(call, tool, context, {
            beforeTool, afterTool, available, approval: decision ? 'skip' : turn.stored ? 'ask' : 'unavailable',
          }));
        if (!needsApproval(outcome)) {
          const entry: TraceEntry = {
            name: call.name, status: outcome.ok ? 'completed' : 'error', step, durationMs: Math.round(performance.now() - started),
            ...(outcome.ok ? {} : { error: outcome.error }),
          };
          entries[index] = entry;
          emit({ type: 'tool.finished', runId, toolCallId: call.id, tool: entry });
        }
        return outcome;
      }

      for (let position = 0; position < todo.length;) {
        signal.throwIfAborted();
        let size = 1;
        if (parallel(todo[position])) while (position + size < todo.length && parallel(todo[position + size])) size += 1;
        const group = todo.slice(position, position + size);
        position += size;
        for (const index of group) {
          const call = calls[index];
          turn.callIds.add(call.id);
          // A resumed call already reported its start in the run that asked for approval.
          if (!decisions) {
            emit({ type: 'tool.started', runId, step, name: call.name, toolCallId: call.id,
              arguments: typeof call.arguments === 'string' ? call.arguments : '' });
          }
        }
        const settled = await Promise.all(group.map(launch));
        group.forEach((index, position) => { outcomes[index] = settled[position]; });
        if (signal.aborted) {
          // The run ends here; its trace still shows the calls that ran, the cancelled ones among them.
          for (const index of todo) if (entries[index]) trace.push(entries[index]);
          signal.throwIfAborted();
        }
      }

      const interruptions: ToolApproval[] = [];
      for (const index of todo) {
        const call = calls[index];
        const tool = turn.tools.get(call.name);
        const outcome = outcomes[index];
        if (needsApproval(outcome)) {
          const approval: ToolApproval = { id: randomUUID(), tool: call.name, toolCallId: call.id, arguments: outcome.approval };
          interruptions.push(approval);
          emit({ type: 'tool.approval', runId, step, name: call.name, toolCallId: call.id, approval });
          continue;
        }
        let output = outcome;
        // A cut result is not shown in a form: the user would read part of it as the whole.
        const formName = output.ok && !output.truncated && tool && turn.stored ? resultForm(tool, output.value) : undefined;
        const form = toolForm(tool, formName);
        if (output.ok && form) {
          // The model reads which form the user sees, so it can point to it instead of asking in text.
          output = { ...output, form: formName };
          // A form without submit only shows the result: it is never open for the user to send
          const args = callArguments(call.arguments);
          turn.shown.push(formView({ id: randomUUID(), tool: tool!.name, form: formName!, toolCallId: call.id,
            ...(args ? { arguments: args } : {}), data: output.value, status: form.submit ? 'open' : 'shown' }, form) as FormView);
        }
        outputs[index] = output;
        if (turn.stored) {
          const record = toolRecord(call, tool, output, turn.recordRoom);
          turn.recordRoom -= record.result?.length ?? 0;
          turn.records.push(record);
        }
        trace.push(entries[index]);
      }

      const reply = written.find(Boolean);
      if (reply) {
        // The tool answered the user, so the calls still waiting for approval will not run.
        turn.approvals.push(...interruptions.map((approval) => ({ ...approval, status: 'expired' as const })));
        return finish(runtime, turn, reply.text, reply.data);
      }
      if (interruptions.length) return pause(runtime, turn, { step, continuation, calls, outputs }, interruptions);
      turn.steps.push({ continuation, outputs: calls.map((call, index) => ({ callId: call.id, output: outputs[index]! })) });
      return undefined;
    }

    /** Saves the turn with the calls that wait for approval, for resume to continue it. */
    async function pause(runtime: Runtime, turn: Turn, at: Pick<PendingTurn, 'step' | 'continuation' | 'calls' | 'outputs'>,
      interruptions: ToolApproval[]): Promise<RunResult> {
      runtime.signal.throwIfAborted();
      const pending: PendingTurn = {
        version: 1, ...at, history: turn.history, steps: turn.steps, callIds: [...turn.callIds], trace: runtime.trace,
        records: turn.records, recordRoom: turn.recordRoom, forms: turn.shown.map(withoutHtml), tools: [...turn.tools.keys()],
      };
      const user: Message = {
        ...turn.messages.at(-1)!, pending,
        approvals: [...turn.approvals, ...interruptions.map((approval) => ({ ...approval, status: 'pending' as const }))],
      };
      await sessionStore.set(turn.key, [...turn.messages.slice(0, -1), user]);
      return runtime.result({ status: 'interrupted', interruptions });
    }

    /** Ends a turn that waited for approvals, because the user sent a new message instead of answering. */
    function closePending(messages: Message[]): Message[] {
      const { pending, approvals = [], ...user } = messages.at(-1)!;
      const state = (plainObject(pending) ? pending : {}) as Partial<PendingTurn>;
      const waiting = [...new Set(approvals.filter(({ status }) => status === 'pending').map(({ tool }) => tool))];
      const closed = approvals.map((approval) => approval.status === 'pending' ? { ...approval, status: 'expired' as const } : approval);
      return [...messages.slice(0, -1), user, {
        role: 'assistant',
        content: `[Not answered: the reply waited for the user to approve ${waiting.join(', ') || 'a tool call'}, ` +
          'and the user sent a new message instead.]',
        trace: Array.isArray(state.trace) ? state.trace : [],
        ...(Array.isArray(state.records) && state.records.length ? { tools: state.records } : {}),
        ...(Array.isArray(state.forms) && state.forms.length ? { forms: state.forms } : {}),
        ...(closed.length ? { approvals: closed } : {}),
      }];
    }

    async function run({ message, sessionId, context = {}, signal, onEvent, history: given, tools: requested, onDelta,
      attachments }: RunOptions): Promise<RunResult> {
      const read = readAttachments(attachments);
      // A message may be only files, like a photo sent without a caption.
      const filesOnly = Array.isArray(attachments) && attachments.length > 0 && (message === undefined ||
        (typeof message === 'string' && !message.trim()));
      const content = filesOnly ? '' : nonEmptyString(message, 'message');
      const key = sessionKey(sessionId, context);
      const tools = requested === undefined ? new Map(configuredTools) : selectTools(requested);
      const stored = given === undefined;
      return execute(key, sessionId, { signal, onEvent, onDelta }, async (runtime) => {
        const { result } = runtime;
        if ('error' in read) return result({ status: 'error', error: { code: 'invalid_attachment', message: read.error } });
        const unsupported = read.files.find(({ mediaType }) => !agentModel.attachments?.includes(mediaType));
        if (unsupported) {
          return result({ status: 'error', error: { code: 'attachments_unsupported',
            message: `The model of this agent cannot read ${unsupported.mediaType} files.` } });
        }
        // The input guardrails run before anything is stored or read, so a blocked message leaves no trace in the session.
        const input = await checkText(runtime, 'input', content, sessionId, context, read.info);
        if (!input.allowed) {
          return result({ status: 'blocked', stage: 'input', ...(input.reply ? { text: input.reply } : {}),
            error: { code: input.code, message: input.message } });
        }
        const userMessage: Message = { role: 'user', content: input.text, ...(read.info.length ? { attachments: read.info } : {}) };
        let past = stored
          ? await abortable(runtime.signal, () => sessionStore.get(key))
          : readHistory(given).slice(-maxTurns * 2);
        if (stored && past.at(-1)?.pending !== undefined) past = closePending(past);
        if (stored && (turnCount(past) > maxTurns || !historyPlan([...past, userMessage], budget, false).fits)) {
          past = await compactHistory(runtime, past);
        }
        const messages = [...past, userMessage];
        const history = fittedHistory(messages, budget);
        // Only the message of this turn carries its files; later turns read the note of what was attached.
        if (read.files.length) history[history.length - 1] = { ...history.at(-1)!, attachments: read.files };
        return drive(runtime, {
          key, sessionId, context, stored, messages, history, steps: [], callIds: new Set(), shown: [], records: [],
          recordRoom: maxTurnResults, tools, descriptions: describeTools(tools, stored), approvals: [],
        }, 1);
      });
    }

    /**
     * Answers tool calls that wait for approval. Once every call of the paused step has an answer, the approved ones
     * run (after authorize and beforeTool again) and the turn continues where it stopped; until then, the answers are
     * saved and the result is interrupted again.
     */
    async function resume({ sessionId, context = {}, approvals, signal, onEvent, onDelta, tools: requested }: ResumeOptions):
      Promise<RunResult> {
      const key = sessionKey(sessionId, context);
      const answers = readDecisions(approvals);
      const restricted = requested === undefined ? undefined : selectTools(requested);
      return execute(key, sessionId, { signal, onEvent, onDelta }, async (runtime) => {
        const { result } = runtime;
        const fail = (code: string, message: string) => result({ status: 'error', error: { code, message } });
        const messages = await abortable(runtime.signal, () => sessionStore.get(key));
        const last = messages.at(-1);
        const pending = last?.pending as PendingTurn | undefined;
        if (!last || !plainObject(pending) || pending.version !== 1) {
          return fail('approval_not_found', 'No tool call of this session is waiting for approval.');
        }
        const states = (last.approvals ?? []).map((approval) => ({ ...approval }));
        const answered = new Set<string>();
        for (const { id } of answers) {
          const state = states.find((approval) => approval.id === id);
          if (answered.has(id)) return fail('invalid_approvals', `Approval ${id} is answered twice.`);
          answered.add(id);
          if (!state) return fail('approval_not_found', `Approval ${id} is not waiting in this session.`);
          if (state.status !== 'pending') return fail('approval_decided', `Approval ${id} was already answered.`);
        }
        for (const { id, approved, reason } of answers) {
          const state = states.find((approval) => approval.id === id)!;
          state.status = approved ? 'approved' : 'denied';
          if (!approved && reason) state.reason = reason;
        }
        runtime.signal.throwIfAborted();
        const waiting = states.filter(({ status }) => status === 'pending');
        if (waiting.length) {
          await sessionStore.set(key, [...messages.slice(0, -1), { ...last, approvals: states }]);
          return result({ status: 'interrupted', interruptions: waiting.map(({ status: _status, reason: _reason, ...approval }) => approval) });
        }

        const { pending: _pending, approvals: _approvals, ...user } = last;
        const tools = new Map([...(restricted ?? configuredTools)].filter(([name]) => pending.tools.includes(name)));
        const turn: Turn = {
          key, sessionId, context, stored: true, messages: [...messages.slice(0, -1), user], history: pending.history,
          steps: pending.steps, callIds: new Set(pending.callIds), shown: pending.forms.map(withHtml) as FormView[],
          records: pending.records, recordRoom: pending.recordRoom, tools, descriptions: describeTools(tools, true), approvals: states,
        };
        runtime.trace.push(...pending.trace);
        const decisions = new Map(states.map((state) => [state.toolCallId, state]));
        const ended = await runStep(runtime, turn, pending.step, pending.continuation, pending.calls, pending.outputs, decisions);
        return ended ?? drive(runtime, turn, pending.step + 1);
      });
    }

    function withHtml(form: FormState) {
      return formView(form, toolForm(configuredTools.get(form.tool), form.form));
    }

    /**
     * Sends the values of a form shown in this session to its tool's submit, once. Values that are rejected leave the
     * form open. Once submit has started, a timeout, cancellation or unexpected error closes the form as failed,
     * because whether the action happened is unknown and sending it again could repeat it.
     */
    async function submitForm({ sessionId, context = {}, formId, values, signal: callerSignal }: FormSubmitOptions):
      Promise<FormSubmitResult> {
      const key = sessionKey(sessionId, context);
      const id = nonEmptyString(formId, 'formId');
      const rejected = (code: string, message: string, form?: FormState): FormSubmitResult =>
        ({ status: 'error', formId: id, error: { code, message }, ...(form ? { form } : {}) });
      let queued = true;
      try {
        return await withSession(key, callerSignal ?? new AbortController().signal, async () => {
          queued = false;
          const messages = await sessionStore.get(key);
          const record = messages.flatMap((message) => message.forms ?? []).find((form) => form.id === id);
          if (!record) return rejected('form_not_found', 'This form is not part of the session.');
          if (record.status === 'shown') return rejected('form_closed', 'This form only shows a result; there is nothing to submit.', record);
          if (record.status !== 'open') return rejected('form_closed', 'This form was already submitted.', record);
          const tool = configuredTools.get(record.tool);
          if (!tool) return rejected('unknown_tool', 'The tool of this form is not available for the agent.', record);
          const form = toolForm(tool, record.form);
          if (!form) return rejected('unknown_form', 'The tool of this form no longer has it.', record);
          const { submit } = form;
          if (!submit) return rejected('unknown_form', 'The form of this tool no longer accepts submissions.', record);

          let copy: Record<string, unknown>;
          try {
            const text = JSON.stringify(values);
            if (!plainObject(values) || Buffer.byteLength(text) > maxFormBytes) throw new TypeError();
            copy = JSON.parse(text);
          } catch {
            return rejected('invalid_values', `Form values must be a JSON object of at most ${maxFormBytes} bytes.`, record);
          }
          const validate = formValidators.get(form);
          if (validate && !validate(copy)) {
            return rejected('invalid_values', schemas.errorsText(validate.errors, { dataVar: 'values' }), record);
          }
          if (callerSignal?.aborted) return rejected('cancelled', 'The submission was cancelled before it started.', record);

          const limit = form.timeoutMs ?? tool.timeoutMs ?? timeoutMs;
          const deadline = AbortSignal.timeout(limit);
          const signal = callerSignal ? AbortSignal.any([callerSignal, deadline]) : deadline;
          const formContext: FormContext = {
            ...context, agentId, sessionId, formId: id, form: record.form, toolCallId: record.toolCallId,
            data: structuredClone(record.data), signal,
          };
          let output: ToolOutput;
          try {
            const value = await abortable(signal, () => submit(copy, formContext));
            const text = JSON.stringify({ ok: true, value: value ?? null });
            output = Buffer.byteLength(text) > 64_000 ? failedTool('output_too_large', 'The submit result exceeds 64 KB.') : JSON.parse(text);
          } catch (error) {
            const failure = callerSignal?.aborted ? { code: 'tool_cancelled', message: 'The submission was cancelled while it was running.' }
              : deadline.aborted ? { code: 'tool_timeout', message: `The submission exceeded its ${limit} ms time limit.` }
              : error instanceof ToolError ? { code: error.code, message: error.message }
              : { code: 'tool_failed', message: 'The form could not be submitted.' };
            output = { ok: false, error: failure };
            // Only a ToolError says what went wrong; the form then stays open to be corrected and sent again.
            Object.assign(record, { status: error instanceof ToolError && !signal.aborted ? 'open' : 'failed', error: failure });
          }
          if (output.ok) {
            delete record.error;
            Object.assign(record, { status: 'submitted', result: output.value });
          } else if (output.error.code === 'output_too_large') {
            Object.assign(record, { status: 'failed', error: output.error });
          }
          await sessionStore.set(key, messages);
          return output.ok
            ? { status: 'submitted', formId: id, value: output.value, form: record }
            : rejected(output.error.code, output.error.message, record);
        });
      } catch (error) {
        // Cancelled while another run or submission of the session was still going.
        if (queued && callerSignal?.aborted) return rejected('cancelled', 'The submission was cancelled before it started.');
        throw error;
      }
    }

    return Object.freeze({
      id: agentId,
      run,
      resume,
      submitForm,
      addTool,
      listTools: () => Array.from(configuredTools.values(), toolDescription),
      removeTool: (name: string) => configuredTools.delete(name),
      updateTool(name: string, entry: string | ToolDefinition) {
        if (!configuredTools.has(name)) throw new TypeError(`Tool not configured: ${name}`);
        const tool = resolveTool(entry);
        if (tool.name !== name && configuredTools.has(tool.name)) {
          throw new TypeError(`Tool selected twice: ${tool.name}`);
        }
        configuredTools.delete(name);
        configuredTools.set(tool.name, tool);
      },
      async getHistory({ sessionId, context = {} }: HistoryOptions): Promise<Message[]> {
        const messages = await sessionStore.get(sessionKey(sessionId, context));
        // Tool records are for the model, like the results the trace leaves out; a waiting turn's state is the SDK's own.
        return messages.map(({ tools: _tools, pending: _pending, ...message }) =>
          message.forms?.length ? { ...message, forms: message.forms.map(withHtml) } : message);
      },
    });
  }

  return Object.freeze({
    createAgent,
    registerTool,
    listTools: () => Array.from(registry.values(), toolDescription),
  });
}

export class ModelError extends Error {
  readonly code: string;
  /** HTTP status returned by the provider, when the error came from one. */
  readonly status?: number;

  constructor(code: string, message: string, status?: number) {
    super(message);
    this.name = 'ModelError';
    this.code = code;
    if (status !== undefined) this.status = status;
  }
}
