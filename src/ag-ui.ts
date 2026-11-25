import { randomUUID } from 'node:crypto';
import type { RunEvent } from './types.js';

/** One event of the AG-UI protocol (https://docs.ag-ui.com), as AG-UI clients such as CopilotKit read it. */
export type AgUiEvent = { type: string; [field: string]: unknown };

/** The name of the CUSTOM event that carries a form the chat shows, with its HTML, as FormView. */
export const agUiFormEvent = 'agent-studio-sdk/form';
/** The name of the CUSTOM event that carries a tool call waiting for the user's approval, as ToolApproval. */
export const agUiApprovalEvent = 'agent-studio-sdk/approval';

export interface AgUiRun {
  threadId: string;
  /** The run ID the client chose. Without it, the SDK run ID is used. */
  runId?: string;
  /** The text of the last user message. */
  message: string;
  /** The shared state the client sent. Snapshots keep its other keys. */
  state?: Record<string, unknown>;
  forwardedProps?: Record<string, unknown>;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function messageText(content: unknown) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.flatMap((part) => record(part)?.type === 'text' && typeof part.text === 'string' ? [part.text] : []).join('\n');
}

/**
 * Reads the RunAgentInput an AG-UI client posts. The agent keeps the conversation in its session store, so only the last
 * user message is taken from the message list the client sends.
 */
export function readAgUiInput(body: unknown): AgUiRun {
  const input = record(body);
  if (!input) throw new TypeError('The AG-UI input must be a JSON object.');
  const { threadId, runId, messages } = input;
  if (typeof threadId !== 'string' || !threadId.trim()) throw new TypeError('The AG-UI input needs a threadId.');
  if (runId !== undefined && (typeof runId !== 'string' || !runId.trim())) throw new TypeError('The AG-UI runId must be a string.');
  if (!Array.isArray(messages)) throw new TypeError('The AG-UI input needs a messages list.');
  const last = [...messages].reverse().find((message) => record(message)?.role === 'user');
  const message = messageText(record(last)?.content).trim();
  if (!message) throw new TypeError('The AG-UI input has no user message.');
  const state = record(input.state);
  const forwardedProps = record(input.forwardedProps);
  return { threadId, ...(runId ? { runId } : {}), message, ...(state ? { state } : {}), ...(forwardedProps ? { forwardedProps } : {}) };
}

/**
 * Turns the events of one run into AG-UI events. Model text becomes text messages, one per model call; tool calls carry
 * their arguments, and their results only say whether the tool succeeded, since tool data is not meant for the client.
 * Forms the run shows come as CUSTOM events named agUiFormEvent, and the forms still waiting for the user are listed in a
 * STATE_SNAPSHOT under forms: the run pauses there until the user submits one. Tool calls that wait for the user's
 * approval come as CUSTOM events named agUiApprovalEvent and are listed under approvals; the run finishes with the
 * result status interrupted, and agent.resume() continues it.
 */
export function createAgUiEncoder({ threadId, runId: clientRunId, state }: Pick<AgUiRun, 'threadId' | 'runId' | 'state'>) {
  let started = false;
  let finished = false;
  let runId = clientRunId;
  let open: string | undefined;
  const stepMessages = new Map<number, string>();
  let lastStep = 0;
  let lastStepText = '';

  function messageId(step: number) {
    let id = stepMessages.get(step);
    if (!id) stepMessages.set(step, id = randomUUID());
    return id;
  }

  return function encode(event: RunEvent): AgUiEvent[] {
    if (finished) return [];
    const out: AgUiEvent[] = [];
    if (!started) {
      started = true;
      runId ??= event.runId;
      out.push({ type: 'RUN_STARTED', threadId, runId });
    }
    const close = () => {
      if (open) out.push({ type: 'TEXT_MESSAGE_END', messageId: open });
      open = undefined;
    };
    const pushText = (text: string) => {
      const id = randomUUID();
      out.push({ type: 'TEXT_MESSAGE_START', messageId: id, role: 'assistant' },
        { type: 'TEXT_MESSAGE_CONTENT', messageId: id, delta: text }, { type: 'TEXT_MESSAGE_END', messageId: id });
    };

    switch (event.type) {
      case 'model.started':
        close();
        lastStep = event.step;
        lastStepText = '';
        out.push({ type: 'STEP_STARTED', stepName: `model-${event.step}` });
        break;
      case 'model.delta':
        if (!open) {
          open = messageId(event.step);
          out.push({ type: 'TEXT_MESSAGE_START', messageId: open, role: 'assistant' });
        }
        out.push({ type: 'TEXT_MESSAGE_CONTENT', messageId: open, delta: event.text });
        if (event.step === lastStep) lastStepText += event.text;
        break;
      case 'model.finished':
        close();
        out.push({ type: 'STEP_FINISHED', stepName: `model-${event.step}` });
        break;
      case 'tool.started':
        close();
        out.push({ type: 'TOOL_CALL_START', toolCallId: event.toolCallId, toolCallName: event.name,
          parentMessageId: messageId(event.step) });
        if (event.arguments) out.push({ type: 'TOOL_CALL_ARGS', toolCallId: event.toolCallId, delta: event.arguments });
        out.push({ type: 'TOOL_CALL_END', toolCallId: event.toolCallId });
        break;
      case 'tool.finished':
        out.push({ type: 'TOOL_CALL_RESULT', messageId: randomUUID(), toolCallId: event.toolCallId, role: 'tool',
          content: JSON.stringify({ status: event.tool.status, ...(event.tool.error ? { error: event.tool.error } : {}) }) });
        break;
      case 'tool.approval':
        close();
        out.push({ type: 'CUSTOM', name: agUiApprovalEvent, value: event.approval });
        break;
      case 'run.finished': {
        close();
        finished = true;
        const { result } = event;
        if (result.status === 'interrupted') {
          out.push({ type: 'STATE_SNAPSHOT', snapshot: { ...state, approvals: result.interruptions } });
          out.push({ type: 'RUN_FINISHED', threadId, runId, result: { status: 'interrupted', interruptions: result.interruptions } });
          break;
        }
        if (result.status === 'blocked') {
          // The guardrail's reply is the answer the user reads; a blocked message is not an error of the run.
          if (result.text) pushText(result.text);
          out.push({ type: 'RUN_FINISHED', threadId, runId, result: { status: 'blocked', stage: result.stage, error: result.error } });
          break;
        }
        if (result.status !== 'completed' && result.status !== 'limit_reached') {
          out.push({ type: 'RUN_ERROR', message: result.error.message, code: result.error.code });
          break;
        }
        // A reply a tool wrote, or one from a model without streaming, was not sent as it arrived.
        if (result.text && result.text.trim() !== lastStepText.trim()) pushText(result.text);
        for (const form of result.forms ?? []) out.push({ type: 'CUSTOM', name: agUiFormEvent, value: form });
        const waiting = (result.forms ?? []).filter(({ status }) => status === 'open')
          .map(({ id, tool, form, toolCallId }) => ({ id, tool, form, toolCallId }));
        if (waiting.length || state?.forms !== undefined) {
          out.push({ type: 'STATE_SNAPSHOT', snapshot: { ...state, forms: waiting } });
        }
        out.push({ type: 'RUN_FINISHED', threadId, runId, result: {
          status: result.status, ...(result.status === 'completed' && result.data !== undefined ? { data: result.data } : {}),
          ...(result.status === 'limit_reached' ? { error: result.error } : {}),
        } });
        break;
      }
    }
    return out;
  };
}

/** An AG-UI event in the server-sent events framing AG-UI clients read. */
export function agUiServerSentEvent(event: AgUiEvent) {
  return `data: ${JSON.stringify(event)}\n\n`;
}
