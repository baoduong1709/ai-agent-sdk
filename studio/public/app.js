import { createToolEditor } from './tool-editor.js';
import { createMcpEditor } from './mcp-editor.js';

const byId = (id) => document.getElementById(id);
const state = {
  profiles: [], drafts: new Map(), tools: [], providers: [], activeId: null,
  sessionId: null, messages: [], pending: false, activeRun: null, saving: false, loadingHistory: false,
  ready: false, building: false, deleting: false,
  credentials: {}, pendingCredentials: new Map(),
  // Files picked for the next message: { name, mediaType, size, data (base64) }.
  attachments: [],
};
// The SDK's limits on files sent with one message.
const attachmentTypes = new Map([
  ['image/png', 'PNG'], ['image/jpeg', 'JPEG'], ['image/gif', 'GIF'], ['image/webp', 'WebP'], ['application/pdf', 'PDF'],
]);
const maxAttachments = 5;
const maxAttachmentSize = 5 * 1024 * 1024;
const maxAttachmentTotal = 10 * 1024 * 1024;
const runFields = [['max-steps', 'maxSteps', 1], ['max-tool-calls', 'maxToolCalls', 1], ['run-timeout', 'timeoutMs', 1000]];
// The parts of a profile Studio edits. A draft compares and saves them one by one, so their order in the object does not matter.
const editableFields = ['name', 'systemPrompt', 'tools', 'model', 'execution', 'mcpServers'];
const demoProvider = { id: 'demo', label: 'Demo', efforts: ['default'] };
const effortLabels = {
  default: 'Mặc định của model', none: 'Không suy nghĩ', off: 'Tắt', on: 'Bật',
  low: 'Thấp', medium: 'Trung bình', high: 'Cao', xhigh: 'Rất cao', max: 'Tối đa',
};

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function icon(name, className = '') {
  const node = element('span', `icon ${className}`);
  node.dataset.icon = name;
  node.setAttribute('aria-hidden', 'true');
  return node;
}

async function request(path, body) {
  const response = await fetch(path, body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? 'Không thể gửi yêu cầu.');
  return data;
}

/** Runs a turn (/api/run) or continues one that waited for approvals (/api/run/resume), with progress as NDJSON. */
async function streamRun(path, body) {
  const response = await fetch(path, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson' },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const data = await response.json();
    throw new Error(data.error ?? 'Không thể chạy agent.');
  }
  let pending = '';
  for await (const chunk of response.body.pipeThrough(new TextDecoderStream())) {
    const lines = (pending + chunk).split('\n');
    pending = lines.pop();
    for (const line of lines) {
      if (!line) continue;
      const event = JSON.parse(line);
      if (event.type === 'run.finished') return event.result;
      handleRunEvent(event);
    }
  }
  throw new Error('Kết nối kết thúc trước khi nhận được kết quả lượt chạy.');
}

function handleRunEvent(event) {
  const run = state.activeRun;
  switch (event.type) {
    case 'run.queued':
      run.registered = true;
      byId('stop-run').disabled = run.stopping;
      break;
    case 'model.started':
      if (!run.stopping) byId('run-progress').textContent = `Đang gọi model, bước ${event.step}…`;
      break;
    case 'tool.started':
      if (!run.stopping) byId('run-progress').textContent = `Đang xử lý tool ${event.name}…`;
      break;
    case 'tool.finished':
      run.trace.push(event.tool);
      renderTrace();
      break;
  }
}

function setAlert(id, message = '') {
  byId(id).textContent = message;
  byId(id).hidden = !message;
}

function profile() {
  return state.drafts.get(state.activeId);
}

function editableProfile(saved) {
  const draft = structuredClone(saved);
  draft.model ??= { provider: 'demo', reasoningEffort: 'default' };
  draft.execution ??= { ...state.defaultRunLimits };
  draft.mcpServers ??= [];
  return draft;
}

function isDirty(draft = profile()) {
  const saved = state.profiles.find(({ id }) => id === draft?.id);
  if (!draft) return false;
  if (!saved) return true;
  const original = editableProfile(saved);
  return editableFields.some((field) => JSON.stringify(original[field]) !== JSON.stringify(draft[field]))
    || Object.keys(credentialChanges(draft)).length > 0;
}

function credentialTarget(draft, slot) {
  if (!draft) return null;
  if (slot === 'model') {
    const model = draft.model;
    if (!model || model.provider === 'demo') return null;
    const provider = state.providers.find(({ id }) => id === model.provider);
    if (!provider?.customEndpoint) return JSON.stringify([model.provider, null]);
    try {
      const base = new URL(model.baseUrl?.trim() || provider.endpoint).href.replace(/\/+$/, '');
      return JSON.stringify([model.provider, base]);
    } catch { return null; }
  }
  if (slot.startsWith('mcp:')) return draft.mcpServers?.find((server) => `mcp:${server.prefix}` === slot)?.url ?? null;
  return draft.tools.find((tool) => tool?.kind === 'http' && `tool:${tool.name}` === slot)?.url ?? null;
}

function credentialChanges(draft) {
  const staged = state.pendingCredentials.get(draft.id) ?? new Map();
  return Object.fromEntries([...staged].filter(([slot, entry]) => credentialTarget(draft, slot) === entry.target)
    .map(([slot, { value }]) => [slot, value]));
}

function stageCredential(slot, value) {
  const current = profile();
  const staged = state.pendingCredentials.get(current.id) ?? new Map();
  const target = credentialTarget(current, slot);
  if (value === undefined) staged.delete(slot);
  else staged.set(slot, { target, value });
  if (staged.size) state.pendingCredentials.set(current.id, staged);
  else state.pendingCredentials.delete(current.id);
}

function credentialState(draft, slot, target = credentialTarget(draft, slot)) {
  const staged = state.pendingCredentials.get(draft.id)?.get(slot);
  if (staged?.target === target) return staged.value === null ? 'removed' : 'pending';
  if (!target || target !== credentialTarget(state.profiles.find(({ id }) => id === draft.id), slot)) return null;
  const status = Object.hasOwn(state.credentials, draft.id) ? state.credentials[draft.id] : null;
  if (slot === 'model') return status?.model;
  if (slot.startsWith('mcp:')) {
    const prefix = slot.slice('mcp:'.length);
    return status?.mcpServers && Object.hasOwn(status.mcpServers, prefix) ? status.mcpServers[prefix] : null;
  }
  const name = slot.slice('tool:'.length);
  return status?.tools && Object.hasOwn(status.tools, name) ? status.tools[name] : null;
}

function currentProvider() {
  return state.providers.find(({ id }) => id === profile()?.model.provider) ?? demoProvider;
}

function toolView(entry) {
  const name = typeof entry === 'string' ? entry : entry.name;
  const source = state.tools.find((candidate) => candidate.name === name);
  return { kind: 'registered', name, label: name, icon: 'agent', ...source, ...(typeof entry === 'string' ? {} : entry) };
}

function selectConfigTab(name, focus = false) {
  for (const tab of document.querySelectorAll('[data-config]')) {
    const selected = tab.dataset.config === name;
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
    byId(tab.getAttribute('aria-controls')).hidden = !selected;
    if (selected && focus) tab.focus();
  }
}

function renderControls() {
  const current = profile();
  const busy = state.pending || state.loadingHistory || state.deleting || state.building;
  byId('add-agent').disabled = !state.ready || busy;
  byId('create-first-agent').disabled = !state.ready || busy;
  byId('agent-actions').hidden = !current;
  byId('agent-panels').hidden = state.ready && !current;
  byId('empty-workspace').hidden = !state.ready || Boolean(current);
  byId('build-agent').disabled = !current || busy || state.saving;
  byId('delete-agent').disabled = !current || busy || state.saving;
  for (const id of ['confirm-delete', 'cancel-delete', 'close-delete']) byId(id).disabled = state.deleting;
  byId('download-build').disabled = state.building;
  byId('close-build').disabled = state.building;
  byId('download-build').textContent = state.building ? 'Đang build…' : 'Build và tải ZIP';
  byId('show-sdk').disabled = !current;
  byId('save-profile').disabled = !current || state.saving || state.deleting || state.building || !isDirty();
  byId('save-profile').textContent = state.saving ? 'Đang lưu…' : 'Lưu cấu hình';
  byId('agent-name').disabled = !current;
  byId('system-prompt').disabled = !current;
  byId('add-tool').disabled = !current;
  byId('add-mcp-server').disabled = !current;
  byId('provider').disabled = !current || busy;
  byId('reasoning').disabled = !current || currentProvider().efforts.length === 1;
  byId('run-model').disabled = !current;
  byId('new-session').disabled = !current || busy;
  byId('chat-message').disabled = !current || busy;
  byId('attach-file').disabled = !current || busy || state.attachments.length >= maxAttachments;
  for (const button of byId('attachment-chips').querySelectorAll('button')) button.disabled = busy;
  for (const update of approvalViews.values()) update();
  byId('send-message').disabled = !current || busy;
  byId('send-message').hidden = state.pending;
  byId('stop-run').hidden = !state.pending;
  byId('stop-run').disabled = !state.activeRun?.registered || state.activeRun.stopping;
  byId('stop-run').textContent = state.activeRun?.stopping ? 'Đang dừng…' : 'Dừng lượt';
  for (const button of byId('profiles').children) button.disabled = busy;
  for (const button of byId('suggestions').children) button.disabled = busy;
}

function renderProfiles() {
  const ids = new Set([...state.profiles.map(({ id }) => id), ...state.drafts.keys()]);
  const buttons = [...ids].map((id) => {
    const entry = state.drafts.get(id) ?? state.profiles.find((candidate) => candidate.id === id);
    const button = element('button', 'profile-button');
    button.type = 'button';
    button.dataset.profileId = id;
    if (id === state.activeId) button.setAttribute('aria-current', 'true');
    const symbol = entry.tools.length ? toolView(entry.tools[0]).icon : 'agent';
    button.append(icon(symbol), element('span', 'profile-label', entry.name.trim() || 'Agent mới'));
    button.addEventListener('click', () => void selectProfile(id));
    return button;
  });
  byId('profiles').replaceChildren(...buttons);
}

function renderTools() {
  const tools = profile().tools.map(toolView);
  byId('tool-count').textContent = String(tools.length + profile().mcpServers.length);
  renderMcpServers();
  const rows = tools.map((tool, index) => {
    const row = element('div', 'tool-row');
    const info = element('div', 'tool-info');
    const formCount = tool.forms ? Object.keys(tool.forms).length : tool.formCount ?? 0;
    info.append(element('strong', '', tool.label), element('code', '', formCount ? `${tool.name} · ${formCount} form` : tool.name));

    const details = element('button', 'text-button', 'Sửa');
    details.type = 'button';
    details.setAttribute('aria-label', `Sửa ${tool.label}`);
    details.addEventListener('click', () => openToolEditor({ edited: tool, index, tools, catalog: state.tools }));

    const remove = element('button', 'icon-button remove-tool', '×');
    remove.type = 'button';
    remove.title = `Xóa ${tool.label}`;
    remove.setAttribute('aria-label', remove.title);
    remove.addEventListener('click', () => {
      stageCredential(`tool:${tool.name}`, undefined);
      profile().tools.splice(index, 1);
      updateTools();
      byId('add-tool').focus();
    });
    row.append(icon(tool.icon, 'tool-icon'), info, details, remove);
    return row;
  });
  byId('tool-list').replaceChildren(...(rows.length ? rows : [element('p', 'empty-tools', 'Agent này chưa có tool.')]));
}

function renderMcpServers() {
  const servers = profile().mcpServers;
  const rows = servers.map((server, index) => {
    const row = element('div', 'tool-row');
    const info = element('div', 'tool-info');
    const scope = server.tools ? `${server.tools.length} tool` : 'Tất cả tool';
    info.append(element('strong', '', server.prefix), element('code', '', `${server.url} · ${scope}`));

    const details = element('button', 'text-button', 'Sửa');
    details.type = 'button';
    details.setAttribute('aria-label', `Sửa MCP server ${server.prefix}`);
    details.addEventListener('click', () => openMcpEditor({ edited: server, index, servers }));

    const remove = element('button', 'icon-button remove-tool', '×');
    remove.type = 'button';
    remove.title = `Xóa MCP server ${server.prefix}`;
    remove.setAttribute('aria-label', remove.title);
    remove.addEventListener('click', () => {
      stageCredential(`mcp:${server.prefix}`, undefined);
      profile().mcpServers.splice(index, 1);
      updateTools();
      byId('add-mcp-server').focus();
    });
    row.append(icon('box', 'tool-icon'), info, details, remove);
    return row;
  });
  byId('mcp-list').replaceChildren(...(rows.length ? rows : [element('p', 'empty-tools', 'Agent này chưa kết nối MCP server.')]));
}

function updateTools() {
  renderTools();
  renderSuggestions();
  showDraftStatus();
}

const openToolEditor = createToolEditor({
  credentialState: ({ name, url }) => credentialState(profile(), `tool:${name}`, url),
  onSave(tool, index, token) {
    const current = profile();
    const previous = current.tools[index];
    if (previous?.kind === 'http' && (previous.name !== tool.name || previous.url !== tool.url)) stageCredential(`tool:${previous.name}`, undefined);
    if (index === undefined) current.tools.push(tool);
    else current.tools[index] = tool;
    if (token !== undefined) stageCredential(`tool:${tool.name}`, token);
    updateTools();
  },
});

const openMcpEditor = createMcpEditor({
  credentialState: ({ prefix, url }) => credentialState(profile(), `mcp:${prefix}`, url),
  onSave(server, index, token) {
    const current = profile();
    const previous = current.mcpServers[index];
    if (previous && (previous.prefix !== server.prefix || previous.url !== server.url)) stageCredential(`mcp:${previous.prefix}`, undefined);
    if (index === undefined) current.mcpServers.push(server);
    else current.mcpServers[index] = server;
    if (token !== undefined) stageCredential(`mcp:${server.prefix}`, token);
    updateTools();
  },
  loadTools({ server, token }) {
    const current = profile();
    let value = token;
    if (value === undefined) {
      // A token entered earlier for this draft, but not saved yet, is the one the agent would use.
      const staged = state.pendingCredentials.get(current.id)?.get(`mcp:${server.prefix}`);
      if (staged?.target === server.url) value = staged.value;
    }
    return request('/api/mcp/tools', { profileId: current.id, server, ...(value === undefined ? {} : { token: value }) });
  },
});

function showDraftStatus() {
  const current = profile();
  const name = current.name.trim() || 'Agent mới';
  byId('agent-heading').textContent = name;
  byId('prompt-count').textContent = `${current.systemPrompt.length.toLocaleString('vi-VN')}/10.000`;
  byId('save-status').textContent = isDirty(current) ? 'Chưa lưu' : '';
  const activeLabel = byId('profiles').querySelector('[aria-current="true"] .profile-label');
  if (activeLabel) activeLabel.textContent = name;
  renderControls();
}

function renderSuggestions() {
  const selected = profile()?.tools.map((entry) => toolView(entry).name) ?? [];
  const prompts = [];
  if (selected.includes('get_order_status')) prompts.push('Đơn DH123 đang ở đâu?');
  if (selected.includes('get_delivery_estimate')) prompts.push('Khi nào giao đơn DH123?');
  if (selected.includes('find_company_policy')) prompts.push('Chính sách đổi trả thế nào?', 'Xin nghỉ phép thế nào?');

  byId('suggestions').replaceChildren(...prompts.slice(0, 3).map((prompt) => {
    const button = element('button', 'suggestion', prompt);
    button.type = 'button';
    button.addEventListener('click', () => {
      byId('chat-message').value = prompt;
      byId('chat-form').requestSubmit();
    });
    return button;
  }));
  renderControls();
}

function switchTab(name, focus = false) {
  for (const type of ['chat', 'trace']) {
    const selected = type === name;
    const tab = byId(`${type}-tab`);
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
    byId(`${type}-view`).hidden = !selected;
    if (selected && focus) tab.focus();
  }
  if (name === 'chat') {
    const history = byId('chat-history');
    history.scrollTop = history.scrollHeight;
  }
}

function renderTrace(messages = state.messages) {
  const replies = messages.filter(({ role }) => role !== 'user');
  const withTrace = replies.map(({ trace }, index) => ({ trace, title: `Lượt ${index + 1}` })).filter(({ trace }) => trace?.length);
  withTrace.reverse();
  if (messages === state.messages && state.activeRun?.trace.length) {
    withTrace.unshift({ trace: state.activeRun.trace, title: 'Lượt đang chạy' });
  }
  const sections = withTrace.map(({ trace, title }) => {
    const section = element('section', 'trace-section');
    const rows = trace.map(({ name, status, durationMs, error, step }) => {
      const item = element('li');
      item.append(element('code', '', name), element('span', '', `Bước ${step} · ${durationMs} ms · ${status === 'completed' ? 'Xong' : 'Lỗi'}`));
      if (error) item.append(element('p', '', error.message));
      return item;
    });
    const list = element('ol', 'trace-list');
    list.append(...rows);
    section.append(element('h3', '', title), list);
    return section;
  });
  const content = byId('trace-content');
  content.replaceChildren(...(sections.length ? sections : [element('p', 'trace-empty', 'Chưa có lời gọi tool nào trong phiên này.')]));
}

// The node of each message, kept between renders: moving or re-inserting an iframe reloads it and loses what the user typed.
const messageNodes = new WeakMap();
// The forms shown in the chat, by form id.
const formViews = new Map();
const formErrors = {
  form_not_found: 'phiên này không có form này. Hãy tải lại hội thoại.',
  form_closed: 'form đã được gửi trước đó.',
  unknown_tool: 'agent không còn tool của form này.',
  unknown_form: 'tool không còn form này trong cấu hình.',
  cancelled: 'lượt gửi đã bị hủy.',
  tool_timeout: 'tool xử lý quá thời gian chờ',
  tool_cancelled: 'lượt gửi đã bị hủy',
  tool_failed: 'tool gặp lỗi khi xử lý',
  output_too_large: 'kết quả của tool vượt quá 64 KB',
};

function describeFormError({ code, message }) {
  if (code === 'invalid_values') return `giá trị chưa hợp lệ (${message}).`;
  return formErrors[code] ?? message;
}

function formStatusText(view) {
  const { form } = view;
  // A form without an endpoint only shows the tool result: there is nothing to tell the user under it
  if (form.status === 'shown') return '';
  if (view.sending) return 'Đang gửi form…';
  if (form.status === 'submitted') return 'Đã gửi form.';
  if (form.status === 'failed') {
    return `Không rõ form đã được xử lý hay chưa: ${describeFormError(form.error ?? { code: 'tool_failed' })}. Form đã đóng để tránh gửi lặp.`;
  }
  const error = view.error ?? form.error;
  return error ? `Chưa gửi được: ${describeFormError(error)}` : 'Kiểm tra thông tin rồi gửi form.';
}

// The chat is an MCP Apps host (https://modelcontextprotocol.io/extensions/apps): each form is an app document that talks
// to it over JSON-RPC through postMessage.
const appProtocolVersion = '2026-01-26';
// The _meta key of a tool result that carries the form state, as the SDK names it.
const formStateKey = 'agent-studio-sdk/form';
const maxFormHeight = 900;

function updateFormStatus(view) {
  const { form } = view;
  view.status.textContent = formStatusText(view);
  view.status.classList.toggle('error', form.status === 'failed' || Boolean(form.status === 'open' && (view.error ?? form.error)));
}

function formState(view) {
  const { form } = view;
  const error = view.error ?? form.error;
  return { id: form.id, status: form.status, ...(form.result === undefined ? {} : { result: form.result }), ...(error ? { error } : {}) };
}

/** A tool result as MCP sends one: the value as JSON text, and as structuredContent when it is an object, with the form state. */
function toolResult(view, value, errorText) {
  return {
    content: [{ type: 'text', text: errorText ?? JSON.stringify(value ?? null) }],
    ...(errorText === undefined && value && typeof value === 'object' && !Array.isArray(value) ? { structuredContent: value } : {}),
    ...(errorText === undefined ? {} : { isError: true }),
    _meta: { [formStateKey]: formState(view) },
  };
}

function postToApp(view, message) {
  // The frame has an opaque origin, so it cannot be addressed by origin; only that frame's window receives the message.
  view.frame.contentWindow?.postMessage({ jsonrpc: '2.0', ...message }, '*');
}

/** Forms stored before tools had named forms carry no form name. */
function formLabel({ tool, form }) {
  return form ? `Form ${form} của tool ${tool}` : `Form của tool ${tool}`;
}

function renderForm(form) {
  const section = element('section', 'message-form');
  if (!form.html) {
    section.append(element('p', 'message-note', `${formLabel(form)} không còn trong cấu hình agent đã lưu nên không hiển thị được.`));
    return section;
  }
  const frame = element('iframe', 'form-frame');
  // The frame's own policy sandboxes it (allow-scripts allow-forms, opaque origin), so the form cannot read Studio data or
  // call its API and every request is blocked. No sandbox attribute here: some embedded browsers block such frames.
  frame.title = formLabel(form);
  frame.src = '/form-frame.html';
  const status = element('p', 'form-status');
  status.setAttribute('role', 'status');
  const view = { form, frame, status, sessionId: state.sessionId, sending: false, error: undefined };
  formViews.set(form.id, view);
  updateFormStatus(view);
  section.append(frame, status);
  return section;
}

async function submitFormValues(view, values) {
  if (view.sending || view.form.status !== 'open') return;
  view.sending = true;
  view.error = undefined;
  updateFormStatus(view);
  const current = profile();
  try {
    const result = await request('/api/forms/submit', {
      profile: structuredClone(current), credentialChanges: credentialChanges(current),
      sessionId: view.sessionId, formId: view.form.id, values,
    });
    if (result.form) {
      // The stored form has no app document; it stays the one the chat already shows.
      const kept = new Set(['html', 'uri', 'mimeType']);
      for (const key of Object.keys(view.form)) if (!kept.has(key) && !Object.hasOwn(result.form, key)) delete view.form[key];
      Object.assign(view.form, result.form);
    }
    view.error = result.status === 'error' ? result.error : undefined;
  } catch (error) {
    view.error = { code: 'request_failed', message: error.message };
  } finally {
    view.sending = false;
    updateFormStatus(view);
  }
}

function resizeForm(view, height) {
  if (!Number.isFinite(height)) return;
  const history = byId('chat-history');
  const atBottom = history.scrollHeight - history.scrollTop - history.clientHeight < 40;
  // The frame is border-box, so its borders add to the height the form reports.
  const border = view.frame.offsetHeight - view.frame.clientHeight;
  view.frame.style.height = `${Math.min(maxFormHeight, Math.max(48, Math.ceil(height)) + border)}px`;
  if (atBottom) history.scrollTop = history.scrollHeight;
}

/** Answers one JSON-RPC message from a form. Requests carry an id and get a result or an error; notifications do not. */
async function handleAppMessage(view, { id, method, params }) {
  const reply = (result) => id !== undefined && postToApp(view, { id, result });
  const fail = (code, message) => id !== undefined && postToApp(view, { id, error: { code, message } });
  const { form } = view;
  switch (method) {
    case 'ui/notifications/sandbox-proxy-ready':
      // The frame loaded (again): the proxy shows the app document, which then starts the protocol from the beginning.
      return postToApp(view, { method: 'ui/notifications/sandbox-resource-ready', params: { html: form.html } });
    case 'ui/initialize':
      return reply({
        protocolVersion: appProtocolVersion,
        hostInfo: { name: 'agent-studio', version: '0.1.0' },
        hostCapabilities: { openLinks: {}, logging: {} },
        hostContext: {
          theme: 'light', displayMode: 'inline', availableDisplayModes: ['inline'], locale: 'vi-VN', platform: 'web',
          containerDimensions: { maxHeight: maxFormHeight },
        },
      });
    case 'ui/notifications/initialized':
      postToApp(view, { method: 'ui/notifications/tool-input', params: { arguments: form.arguments ?? {} } });
      return postToApp(view, { method: 'ui/notifications/tool-result', params: toolResult(view, form.data) });
    case 'ui/notifications/size-changed':
      return resizeForm(view, Number(params?.height));
    case 'tools/call': {
      // A form can call one tool: its own submission. Apps of MCP servers are shown, but cannot call their tools here yet.
      if (params?.name !== `${form.tool}.${form.form}`) return fail(-32602, `Unknown tool: ${params?.name}`);
      if (form.status === 'shown') return fail(-32602, 'This form only shows a result; there is nothing to submit.');
      await submitFormValues(view, params.arguments ?? {});
      const error = view.error ?? form.error;
      return reply(error && form.status !== 'submitted' ? toolResult(view, undefined, describeFormError(error)) : toolResult(view, form.result));
    }
    case 'ui/open-link': {
      let url;
      try {
        url = new URL(params?.url);
      } catch {
        return fail(-32602, 'Invalid URL');
      }
      if (url.protocol !== 'https:' && url.protocol !== 'http:') return fail(-32602, 'Only http and https links can be opened.');
      window.open(url.href, '_blank', 'noopener,noreferrer');
      return reply({});
    }
    case 'ui/message': {
      const text = (Array.isArray(params?.content) ? params.content : [])
        .filter((item) => item?.type === 'text' && typeof item.text === 'string').map((item) => item.text).join('\n').trim();
      if (!text) return fail(-32602, 'The message has no text.');
      // The message goes to the chat box for the user to read and send: a form cannot speak for the user.
      const input = byId('chat-message');
      input.value = text;
      input.focus();
      return reply({});
    }
    case 'ui/request-display-mode':
      return reply({ mode: 'inline' });
    case 'notifications/message':
      return console.info(`[${form.tool}.${form.form}]`, params?.data);
    case 'ping':
      return reply({});
    default:
      return fail(-32601, `Method not found: ${method}`);
  }
}

window.addEventListener('message', (event) => {
  const message = event.data;
  if (message?.jsonrpc !== '2.0' || typeof message.method !== 'string') return;
  const view = [...formViews.values()].find(({ frame }) => frame.contentWindow === event.source);
  if (view) handleAppMessage(view, message).catch((error) => console.error(error));
});

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  return bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** A file as a chip: its type, name and size, and a remove button for files not sent yet. */
function attachmentChip({ name, mediaType, size }, onRemove) {
  const item = element('li', 'attachment-chip');
  item.append(element('span', 'attachment-type', attachmentTypes.get(mediaType) ?? mediaType),
    element('span', 'attachment-name', name || 'Tệp không tên'));
  if (Number.isFinite(size)) item.append(element('span', 'attachment-size', formatSize(size)));
  if (onRemove) {
    const remove = element('button', 'icon-button attachment-remove', '×');
    remove.type = 'button';
    remove.setAttribute('aria-label', `Bỏ tệp ${name}`);
    remove.addEventListener('click', onRemove);
    item.append(remove);
  }
  return item;
}

function traceButton(role, trace) {
  const details = element('button', 'text-button view-message-trace', `Xem ${trace.length} lần gọi tool`);
  details.type = 'button';
  details.addEventListener('click', () => {
    renderTrace([{ role, trace }]);
    byId('trace-content').querySelector('h3').textContent = 'Lượt đã chọn';
    switchTab('trace', true);
  });
  return details;
}

const approvalLabels = { approved: 'Đã duyệt', denied: 'Đã từ chối', expired: 'Không chạy: bạn đã gửi tin nhắn mới thay vì duyệt' };

/** The tool calls a reply waited for, with the user's answers, as the session stored them. */
function renderApprovalSummary(approvals) {
  const list = element('ul', 'approval-summary');
  list.setAttribute('aria-label', 'Tool cần duyệt trong lượt này');
  list.append(...approvals.map(({ tool, status, reason }) => {
    const item = element('li', `approval-summary-${status}`);
    item.append(element('code', '', tool), ` · ${approvalLabels[status] ?? 'Đang chờ duyệt'}${reason ? `: ${reason}` : ''}`);
    return item;
  }));
  return list;
}

// The cards of tool calls waiting for approval, by message, so renderControls can update their buttons.
const approvalViews = new Map();

function approvalStatusText(message, approval) {
  if (approval.status !== 'pending') {
    return `${approvalLabels[approval.status]}${approval.reason ? `: ${approval.reason}` : ''}.`;
  }
  const decision = message.decisions.get(approval.id);
  if (decision) {
    const answer = decision.approved ? 'duyệt' : 'từ chối';
    return message.sending ? `Đang gửi quyết định ${answer}…` : `Sẽ ${answer} khi bạn trả lời các lời gọi còn lại.`;
  }
  return message.interactive ? '' : 'Lượt chờ duyệt đã kết thúc nên không thể trả lời lời gọi này.';
}

/** A card per tool call that waits for the user: the tool, its arguments, and Approve / Deny with an optional reason. */
function renderApprovalMessage(message) {
  message.decisions ??= new Map();
  const article = element('article', 'message assistant approval');
  const many = message.approvals.length > 1;
  article.append(element('span', 'message-label', 'Agent'), element('p', 'message-body', many
    ? 'Agent muốn chạy các tool dưới đây. Hãy duyệt hoặc từ chối từng lời gọi; lượt chạy tiếp tục khi bạn trả lời hết.'
    : 'Agent muốn chạy tool dưới đây. Tool chỉ chạy khi bạn duyệt.'));
  const views = message.approvals.map((approval) => {
    const item = element('section', 'approval-item');
    item.setAttribute('aria-label', `Duyệt tool ${approval.tool}`);
    const title = element('p', 'approval-title');
    title.append('Tool ', element('code', '', approval.tool));
    const args = element('pre', 'approval-arguments', JSON.stringify(approval.arguments ?? {}, null, 2));
    const actions = element('div', 'approval-actions');
    const reason = element('input', 'approval-reason');
    reason.type = 'text';
    reason.maxLength = 500;
    reason.placeholder = 'Lý do nếu từ chối (không bắt buộc)';
    reason.setAttribute('aria-label', `Lý do từ chối tool ${approval.tool}`);
    const deny = element('button', 'button secondary', 'Từ chối');
    const approve = element('button', 'button primary', 'Duyệt');
    deny.type = approve.type = 'button';
    deny.addEventListener('click', () => decideApproval(message, { id: approval.id, approved: false,
      ...(reason.value.trim() ? { reason: reason.value.trim() } : {}) }));
    approve.addEventListener('click', () => decideApproval(message, { id: approval.id, approved: true }));
    reason.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.isComposing) {
        event.preventDefault();
        deny.click();
      }
    });
    actions.append(reason, deny, approve);
    const status = element('p', 'approval-status');
    status.setAttribute('role', 'status');
    item.append(title, args, actions, status);
    return { approval, item, actions, controls: [reason, deny, approve], status };
  });
  article.append(...views.map(({ item }) => item));
  if (message.trace?.length) article.append(traceButton(message.role, message.trace));
  const update = () => {
    for (const { approval, item, actions, controls, status } of views) {
      const open = message.interactive && approval.status === 'pending' && !message.decisions.has(approval.id);
      actions.hidden = !open;
      for (const control of controls) control.disabled = !open || state.pending || state.loadingHistory;
      item.dataset.status = message.decisions.has(approval.id) && approval.status === 'pending'
        ? (message.decisions.get(approval.id).approved ? 'approved' : 'denied') : approval.status;
      status.textContent = approvalStatusText(message, approval);
    }
  };
  approvalViews.set(message, update);
  update();
  return article;
}

/** Records the user's answer; once every waiting call has one, the turn continues with all of them. */
async function decideApproval(message, decision) {
  if (state.pending || state.loadingHistory || !message.interactive || message.decisions.has(decision.id)) return;
  message.decisions.set(decision.id, decision);
  const unanswered = message.approvals.some(({ id, status }) => status === 'pending' && !message.decisions.has(id));
  if (unanswered) return approvalViews.get(message)?.();
  const current = profile();
  message.sending = true;
  const result = await runTurn('/api/run/resume', {
    profile: structuredClone(current), credentialChanges: credentialChanges(current),
    sessionId: message.sessionId, requestId: crypto.randomUUID(), approvals: [...message.decisions.values()],
  });
  message.sending = false;
  const code = result?.error?.code;
  if (!result || code === 'invalid_approvals') {
    // The answers did not reach the turn, which still waits: the user can answer again.
    message.decisions.clear();
  } else {
    message.interactive = false;
    // approval_not_found and approval_decided: the turn no longer waited for these answers, so they changed nothing.
    if (code !== 'approval_not_found' && code !== 'approval_decided') {
      for (const approval of message.approvals) {
        const answer = message.decisions.get(approval.id);
        if (answer) Object.assign(approval, { status: answer.approved ? 'approved' : 'denied' }, answer.reason ? { reason: answer.reason } : {});
      }
    }
  }
  approvalViews.get(message)?.();
}

/** The reply the SDK stores for a turn the user left waiting, written for the model; the chat explains it instead. */
function shownContent({ role, content, approvals }) {
  if (role === 'assistant' && approvals?.some(({ status }) => status === 'expired') && content.startsWith('[Not answered')) {
    return 'Agent không trả lời lượt này vì bạn đã gửi tin nhắn mới thay vì duyệt tool.';
  }
  return content;
}

function renderMessage(message) {
  const { role, trace, note, forms, summary, attachments, approvals } = message;
  if (role === 'approval') return renderApprovalMessage(message);
  // The SDK replaced the older turns with this summary: it is context for the model, not something the user typed.
  const kind = summary ? 'summary' : role === 'user' ? 'user' : `assistant ${role}`;
  const label = summary ? 'Tóm tắt hội thoại trước' : role === 'user' ? 'Bạn' : 'Agent';
  const article = element('article', `message ${kind}`);
  article.append(element('span', 'message-label', label));
  const content = shownContent(message);
  // A message of files only, like a photo sent without a caption, has no text to show.
  if (content || !attachments?.length) article.append(element('p', 'message-body', content));
  if (attachments?.length) {
    const list = element('ul', 'message-attachments');
    list.setAttribute('aria-label', 'Tệp đính kèm');
    list.append(...attachments.map((file) => attachmentChip(file)));
    article.append(list);
  }
  if (approvals?.length && role !== 'user') article.append(renderApprovalSummary(approvals));
  if (forms?.length) {
    article.classList.add('with-form');
    article.append(...forms.map(renderForm));
  }
  if (note) article.append(element('p', 'message-note', note));
  if (trace?.length) article.append(traceButton(role, trace));
  return article;
}

function renderChat() {
  const history = byId('chat-history');
  const empty = state.messages.length === 0 && !state.loadingHistory;
  byId('chat-empty').hidden = !empty;
  history.hidden = empty;
  const entries = state.messages.map((message) => {
    let node = messageNodes.get(message);
    if (!node) messageNodes.set(message, node = renderMessage(message));
    return node;
  });
  if (state.pending || state.loadingHistory) {
    const progress = element('p', 'run-progress', state.pending ? 'Đang chờ lượt chạy…' : 'Đang tải hội thoại…');
    progress.id = 'run-progress';
    entries.push(progress);
  }
  // Messages are only appended, so the nodes already shown stay in place and keep their forms as the user left them.
  const shown = new Set(entries);
  for (const child of [...history.children]) if (!shown.has(child)) child.remove();
  let cursor = history.firstElementChild;
  for (const entry of entries) {
    if (entry === cursor) cursor = cursor.nextElementSibling;
    else history.insertBefore(entry, cursor);
  }
  const live = new Set(state.messages.flatMap(({ forms }) => forms ?? []).map(({ id }) => id));
  for (const id of formViews.keys()) if (!live.has(id)) formViews.delete(id);
  const shownMessages = new Set(state.messages);
  for (const message of approvalViews.keys()) if (!shownMessages.has(message)) approvalViews.delete(message);
  history.scrollTop = history.scrollHeight;
  renderTrace();
}

function sessionStorageKey() {
  return `agent-studio.session.${state.activeId}.${profile().model.provider}`;
}

async function loadSession(fresh = false) {
  const key = sessionStorageKey();
  const stored = sessionStorage.getItem(key);
  state.sessionId = !fresh && stored ? stored : crypto.randomUUID();
  sessionStorage.setItem(key, state.sessionId);
  state.messages = [];
  state.attachments = [];
  renderAttachments();
  byId('chat-message').value = '';
  setAlert('chat-error');
  switchTab('chat');

  if (fresh || !stored) {
    renderChat();
    renderControls();
    return;
  }

  state.loadingHistory = true;
  renderChat();
  renderControls();
  try {
    const query = new URLSearchParams({ agentId: state.activeId, mode: profile().model.provider, sessionId: state.sessionId });
    const { messages } = await request(`/api/history?${query}`);
    // A turn that waits for approvals keeps them on its user message: the chat shows them as a card to answer.
    const sessionId = state.sessionId;
    state.messages = messages.flatMap(({ approvals, ...message }) => message.role === 'user' && approvals?.length
      ? [message, { role: 'approval', approvals, sessionId, interactive: approvals.some(({ status }) => status === 'pending') }]
      : [{ ...message, ...(approvals ? { approvals } : {}) }]);
  } catch (error) {
    setAlert('chat-error', error.message);
  } finally {
    state.loadingHistory = false;
    renderChat();
    renderControls();
  }
}

async function selectProfile(id, fresh = false) {
  if (state.pending || state.loadingHistory || id === state.activeId) return;
  const saved = state.profiles.find((candidate) => candidate.id === id);
  if (!state.drafts.has(id)) state.drafts.set(id, editableProfile(saved));
  state.activeId = id;
  byId('agent-intro').textContent = 'Chỉnh hành vi, chọn tool và thử agent trong cùng một màn hình.';
  if (saved) sessionStorage.setItem('agent-studio.active', id);
  byId('agent-name').value = profile().name;
  byId('system-prompt').value = profile().systemPrompt;
  setAlert('workspace-error');
  renderProfiles();
  renderModelForm();
  renderRunLimits();
  renderTools();
  renderSuggestions();
  showDraftStatus();
  await loadSession(fresh);
}

function showEmptyWorkspace() {
  state.activeId = null;
  state.sessionId = null;
  state.messages = [];
  byId('agent-heading').textContent = 'Agent Studio';
  byId('agent-intro').textContent = 'Quản lý và build agent cho ứng dụng của bạn.';
  byId('save-status').textContent = '';
  renderProfiles();
  renderControls();
}

async function createProfile() {
  const id = crypto.randomUUID();
  state.drafts.set(id, editableProfile({ id, name: '', systemPrompt: '', tools: [] }));
  await selectProfile(id, true);
  selectConfigTab('settings');
  byId('agent-name').focus();
}

async function saveActiveProfile() {
  const current = profile();
  if (!isDirty(current)) return current;
  const draft = structuredClone(current);
  const changes = credentialChanges(current);
  state.saving = true;
  setAlert('workspace-error');
  renderControls();
  try {
    const { profile: saved, credentialStatus } = await request('/api/profiles', { ...draft, credentialChanges: changes });
    state.credentials = { ...state.credentials, [saved.id]: credentialStatus };
    const staged = state.pendingCredentials.get(saved.id);
    for (const [slot, value] of Object.entries(changes)) {
      const currentChange = staged?.get(slot);
      if (currentChange?.value === value && currentChange.target === credentialTarget(draft, slot)) staged.delete(slot);
    }
    if (staged && !staged.size) state.pendingCredentials.delete(saved.id);
    const existing = state.profiles.findIndex(({ id }) => id === saved.id);
    if (existing === -1) state.profiles.push(saved);
    else state.profiles[existing] = saved;
    const stored = editableProfile(saved);
    for (const field of editableFields) {
      if (JSON.stringify(current[field]) === JSON.stringify(draft[field])) current[field] = stored[field];
    }
    if (state.activeId === saved.id) {
      sessionStorage.setItem('agent-studio.active', saved.id);
      byId('agent-name').value = current.name;
      byId('system-prompt').value = current.systemPrompt;
      renderModelForm();
      renderRunLimits();
      showDraftStatus();
      byId('save-status').textContent = isDirty() ? 'Chưa lưu' : 'Đã lưu';
    }
    return saved;
  } finally {
    state.saving = false;
    renderControls();
  }
}

async function deleteActiveProfile() {
  const id = state.activeId;
  state.deleting = true;
  setAlert('delete-error');
  renderControls();
  try {
    const response = await fetch(`/api/profiles/${id}`, { method: 'DELETE' });
    if (!response.ok && response.status !== 404) throw new Error((await response.json()).error);
    state.profiles = state.profiles.filter((entry) => entry.id !== id);
    state.drafts.delete(id);
    state.pendingCredentials.delete(id);
    delete state.credentials[id];
    if (sessionStorage.getItem('agent-studio.active') === id) sessionStorage.removeItem('agent-studio.active');
    for (const provider of state.providers) sessionStorage.removeItem(`agent-studio.session.${id}.${provider.id}`);
    byId('delete-dialog').close();
    setAlert('workspace-error');
    const next = state.profiles[0]?.id ?? state.drafts.keys().next().value;
    if (next) await selectProfile(next);
    else showEmptyWorkspace();
  } catch (error) {
    setAlert('delete-error', error.message);
  } finally {
    state.deleting = false;
    renderControls();
  }
}

async function downloadAgent() {
  state.building = true;
  setAlert('build-error');
  byId('build-status').textContent = '';
  renderControls();
  try {
    const saved = await saveActiveProfile();
    const response = await fetch(`/api/agents/${saved.id}/build`, { method: 'POST' });
    if (!response.ok) throw new Error((await response.json()).error);
    const url = URL.createObjectURL(await response.blob());
    const link = document.createElement('a');
    link.href = url;
    link.download = `agent-${saved.id}.zip`;
    link.hidden = true;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    byId('build-status').textContent = `Đã tạo ${link.download}.`;
  } catch (error) {
    setAlert('build-error', error.message);
  } finally {
    state.building = false;
    renderControls();
  }
}

function renderRunLimits() {
  for (const [id, field, unit] of runFields) byId(id).value = profile().execution[field] / unit;
}

function renderModelForm() {
  const provider = currentProvider();
  const config = profile().model;
  byId('provider').value = provider.id;
  byId('model-options').hidden = provider.id === 'demo';
  byId('model-base-row').hidden = !provider.customEndpoint;
  byId('model-id').value = config.model ?? '';
  byId('model-base').value = config.baseUrl ?? '';
  byId('model-base').placeholder = provider.endpoint || 'https://api.example.com/v1';
  const staged = state.pendingCredentials.get(profile().id)?.get('model');
  byId('model-key').value = staged?.target === credentialTarget(profile(), 'model') ? staged.value ?? '' : '';
  byId('reasoning').replaceChildren(...provider.efforts.map((level) => new Option(effortLabels[level], level)));
  byId('reasoning').value = config.reasoningEffort;
  byId('reasoning-hint').textContent = {
    demo: 'Demo chạy các kịch bản mẫu.',
    ollama: 'Dùng Thấp, Trung bình hoặc Cao cho model hỗ trợ cấp độ như GPT-OSS. Chọn Bật hoặc Tắt cho model hỗ trợ công tắc.',
    lmstudio: 'Giao diện dùng mức mặc định của model đã tải trong LM Studio.',
    anthropic: 'Chọn dòng Claude hỗ trợ adaptive thinking để dùng mức Thấp, Trung bình hoặc Cao.',
  }[provider.id] ?? 'Các mức được hỗ trợ tùy model. Dùng Mặc định nếu model không nhận mức suy nghĩ.';
  renderModelStatus();
}

function renderModelStatus() {
  const provider = currentProvider();
  const current = profile();
  const { model, reasoningEffort } = current.model;
  const status = credentialState(current, 'model');
  const keyHint = byId('model-key-hint');
  byId('remove-model-key').hidden = !['studio', 'pending'].includes(status);
  keyHint.textContent = status === 'studio' ? 'Đã lưu API key. Nhập key mới để thay thế.'
    : status === 'pending' ? 'Key mới sẽ được dùng khi thử và lưu agent.'
      : status === 'removed' ? 'Key lưu trong Studio sẽ được xóa khi lưu cấu hình.'
        : status === 'environment' || (provider.keyConfigured && (!current.model.apiKeyEnv || current.model.apiKeyEnv === provider.apiKeyEnv)) ? 'Đang dùng API key từ cấu hình máy chủ.'
          : provider.apiKeyEnv ? 'Nhập API key để kết nối với nhà cung cấp.' : 'Để trống nếu máy chủ không yêu cầu API key.';
  const modelLabel = model?.trim() || provider.label;
  const badge = byId('run-model');
  badge.textContent = modelLabel;
  badge.title = `Cấu hình model ${modelLabel}`;
  badge.setAttribute('aria-label', badge.title);
  byId('model-banner').querySelector('p').textContent = provider.id === 'demo'
    ? 'Demo dùng dữ liệu mẫu. Đổi model để thử system prompt và tool HTTP.'
    : `${provider.label} · Suy nghĩ ${effortLabels[reasoningEffort].toLowerCase()}`;
}

function attachEvents() {
  byId('add-agent').addEventListener('click', createProfile);
  byId('create-first-agent').addEventListener('click', createProfile);
  byId('delete-agent').addEventListener('click', () => {
    const current = profile();
    const saved = state.profiles.some(({ id }) => id === current.id);
    const name = current.name.trim() || 'Agent mới';
    byId('delete-description').textContent = saved
      ? `Xóa “${name}” và các hội thoại của agent này trong Studio?`
      : `Bỏ bản nháp “${name}” cùng các hội thoại thử nghiệm?`;
    setAlert('delete-error');
    byId('delete-dialog').showModal();
  });
  byId('confirm-delete').addEventListener('click', deleteActiveProfile);
  byId('delete-dialog').addEventListener('cancel', (event) => { if (state.deleting) event.preventDefault(); });
  byId('build-agent').addEventListener('click', () => {
    const current = profile();
    const summary = isDirty() ? 'Studio sẽ lưu cấu hình đang chỉnh rồi đóng gói app.' : 'Studio sẽ đóng gói cấu hình agent đã lưu.';
    byId('build-description').textContent = `${summary}${current.model.provider === 'demo' ? ' Agent này đang dùng dữ liệu Demo.' : ''}`;
    setAlert('build-error');
    byId('build-status').textContent = '';
    byId('build-dialog').showModal();
  });
  byId('download-build').addEventListener('click', downloadAgent);
  byId('build-dialog').addEventListener('cancel', (event) => { if (state.building) event.preventDefault(); });
  byId('add-tool').addEventListener('click', () => openToolEditor({ tools: profile().tools.map(toolView), catalog: state.tools }));
  byId('add-mcp-server').addEventListener('click', () => openMcpEditor({ servers: profile().mcpServers }));
  byId('run-model').addEventListener('click', () => selectConfigTab('model', true));
  const configTabs = Array.from(document.querySelectorAll('[data-config]'));
  configTabs.forEach((tab, index) => {
    tab.addEventListener('click', () => selectConfigTab(tab.dataset.config));
    tab.addEventListener('keydown', (event) => {
      let next;
      if (event.key === 'ArrowLeft') next = (index + configTabs.length - 1) % configTabs.length;
      else if (event.key === 'ArrowRight') next = (index + 1) % configTabs.length;
      else if (event.key === 'Home') next = 0;
      else if (event.key === 'End') next = configTabs.length - 1;
      else return;
      event.preventDefault();
      selectConfigTab(configTabs[next].dataset.config, true);
    });
  });
  byId('agent-name').addEventListener('input', (event) => {
    profile().name = event.target.value;
    showDraftStatus();
  });
  byId('system-prompt').addEventListener('input', (event) => {
    profile().systemPrompt = event.target.value;
    showDraftStatus();
  });
  for (const [id, field, unit] of runFields) {
    byId(id).addEventListener('input', (event) => {
      const { valueAsNumber, validity } = event.target;
      profile().execution[field] = validity.valid && Number.isFinite(valueAsNumber) ? Math.round(valueAsNumber * unit) : null;
      showDraftStatus();
    });
  }
  byId('profile-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (state.saving || state.building || state.deleting || !isDirty()) return;
    const id = state.activeId;
    try {
      await saveActiveProfile();
    } catch (error) {
      if (state.activeId === id) setAlert('workspace-error', error.message);
    }
  });
  byId('provider').addEventListener('change', async (event) => {
    const provider = state.providers.find(({ id }) => id === event.target.value);
    stageCredential('model', undefined);
    profile().model = { provider: provider.id, ...(provider.defaultModel ? { model: provider.defaultModel } : {}), reasoningEffort: 'default' };
    renderModelForm();
    showDraftStatus();
    await loadSession();
  });
  for (const [input, field] of [['model-id', 'model'], ['model-base', 'baseUrl'], ['reasoning', 'reasoningEffort']]) {
    byId(input).addEventListener('input', (event) => {
      const current = profile();
      const previousTarget = credentialTarget(current, 'model');
      current.model[field] = event.target.value;
      const target = credentialTarget(current, 'model');
      if (field === 'baseUrl' && previousTarget !== target) {
        const enteredKey = previousTarget === null && target ? state.pendingCredentials.get(current.id)?.get('model')?.value : undefined;
        stageCredential('model', enteredKey ?? undefined);
        if (current.model.apiKeyEnv && !currentProvider().apiKeyEnv) delete current.model.apiKeyEnv;
        byId('model-key').value = enteredKey ?? '';
      }
      renderModelStatus();
      showDraftStatus();
    });
  }
  byId('model-key').addEventListener('input', (event) => {
    stageCredential('model', event.target.value.trim() || undefined);
    renderModelStatus();
    showDraftStatus();
  });
  byId('remove-model-key').addEventListener('click', () => {
    stageCredential('model', null);
    byId('model-key').value = '';
    renderModelStatus();
    showDraftStatus();
  });
  byId('new-session').addEventListener('click', async () => {
    await loadSession(true);
    byId('chat-message').focus();
  });
  byId('chat-tab').addEventListener('click', () => switchTab('chat'));
  byId('trace-tab').addEventListener('click', () => {
    renderTrace();
    switchTab('trace');
  });
  document.querySelector('.test-toolbar .view-tabs').addEventListener('keydown', (event) => {
    const { key } = event;
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(key)) return;
    event.preventDefault();
    const active = byId('trace-tab').getAttribute('aria-selected') === 'true';
    const next = key === 'Home' ? 'chat' : key === 'End' ? 'trace' : active ? 'chat' : 'trace';
    if (next === 'trace') renderTrace();
    switchTab(next, true);
  });
  byId('chat-message').addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      byId('chat-form').requestSubmit();
    }
  });
  byId('stop-run').addEventListener('click', async () => {
    const run = state.activeRun;
    if (!run?.registered || run.stopping) return;
    run.stopping = true;
    byId('run-progress').textContent = 'Đang dừng lượt chạy…';
    renderControls();
    try {
      await request('/api/run/cancel', { requestId: run.requestId });
    } catch (error) {
      if (state.activeRun !== run) return;
      run.stopping = false;
      setAlert('chat-error', error.message);
      renderControls();
    }
  });
  byId('attach-file').addEventListener('click', () => byId('attachment-input').click());
  byId('attachment-input').addEventListener('change', async (event) => {
    const files = [...event.target.files];
    event.target.value = '';
    await addAttachments(files);
    byId('chat-message').focus();
  });
  byId('chat-message').addEventListener('paste', (event) => {
    const files = [...(event.clipboardData?.files ?? [])];
    if (!files.length || byId('attach-file').disabled) return;
    event.preventDefault();
    addAttachments(files);
  });
  byId('chat-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (state.pending || state.loadingHistory) return;
    const current = profile();
    const input = byId('chat-message');
    const message = input.value.trim();
    const files = state.attachments;
    if (!message && !files.length) return;
    if (!current.name.trim() || !current.systemPrompt.trim()) {
      setAlert('chat-error', 'Nhập tên agent và system prompt trước khi chạy.');
      byId(current.name.trim() ? 'system-prompt' : 'agent-name').focus();
      return;
    }
    const body = {
      profile: structuredClone(current), credentialChanges: credentialChanges(current), message, sessionId: state.sessionId,
      requestId: crypto.randomUUID(), ...(files.length ? { attachments: files.map(({ name, mediaType, data }) => ({ name, mediaType, data })) } : {}),
    };
    input.value = '';
    state.attachments = [];
    renderAttachments();
    // A new message ends a turn that waited for approvals: the SDK closes it and its tool calls never run.
    for (const shown of state.messages) {
      if (shown.role !== 'approval' || !shown.interactive) continue;
      shown.interactive = false;
      for (const approval of shown.approvals) if (approval.status === 'pending') approval.status = 'expired';
    }
    state.messages.push({ role: 'user', content: message,
      ...(files.length ? { attachments: files.map(({ name, mediaType, size }) => ({ name, mediaType, size })) } : {}) });
    await runTurn('/api/run', body, () => {
      // The turn did not go through: the message and its files come back to the composer to send again.
      if (!input.value) input.value = message;
      if (!state.attachments.length && files.length) {
        state.attachments = files;
        renderAttachments();
      }
    });
  });
  byId('show-sdk').addEventListener('click', () => {
    const config = structuredClone(profile());
    const toolEntries = config.tools.map(toolView);
    const runUrl = `${location.origin}/api/agents/${config.id}/run`;
    const names = toolEntries.map(({ name }) => name);
    const servers = config.mcpServers ?? [];
    // Each MCP server is one connectMcp call; its token comes from the variable a deployed agent reads too.
    const connections = servers.map((server, index) => {
      const options = JSON.stringify({ url: server.url, prefix: server.prefix, ...(server.tools ? { tools: server.tools } : {}),
        ...(server.timeoutMs ? { timeoutMs: server.timeoutMs } : {}) }, null, 2);
      const variable = server.apiKeyEnv ?? `MCP_${server.prefix.toUpperCase().replaceAll('-', '_')}_TOKEN`;
      const headers = `  headers: { Authorization: \`Bearer \${process.env.${variable}}\` },\n}`;
      return `const mcp${index + 1} = await connectMcp(${options.replace(/\n}$/, `,\n${headers}`)});`;
    });
    const tools = servers.length
      ? `[${[...names.map((name) => JSON.stringify(name)), ...servers.map((_, index) => `...mcp${index + 1}.tools`)].join(', ')}]` : null;
    const sdkConfig = { id: config.id, systemPrompt: config.systemPrompt, tools: names, ...config.execution };
    const agentOptions = `{\n${Object.entries(sdkConfig).map(([key, value]) =>
      `  ${key}: ${key === 'tools' && tools ? tools : JSON.stringify(value)}`).join(',\n')}\n}`;
    const mcpCode = connections.length
      ? `// Kết nối MCP server; tool có tên tiền tố_tên trên server\nimport { connectMcp } from 'agent-studio-sdk/mcp';\n${connections.join('\n')}\n\n` : '';
    byId('sdk-code').textContent = `// Gọi agent đã lưu qua HTTP\nconst response = await fetch(${JSON.stringify(runUrl)}, {\n  method: 'POST',\n  headers: { 'Content-Type': 'application/json' },\n  body: JSON.stringify({ appId, sessionId, message }),\n});\n\n${mcpCode}// Nhúng SDK sau khi đăng ký model và các tool tương ứng\nconst agent = sdk.createAgent(${agentOptions});\nconst result = await agent.run({ message, sessionId, context });`;
    byId('copy-status').textContent = '';
    byId('sdk-dialog').showModal();
  });
  byId('copy-sdk').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(byId('sdk-code').textContent);
      byId('copy-status').textContent = 'Đã sao chép';
    } catch {
      byId('copy-status').textContent = 'Hãy chọn mã để sao chép thủ công.';
    }
  });
}

function renderAttachments() {
  const list = byId('attachment-chips');
  list.hidden = !state.attachments.length;
  // Files alone are a message: text is required only when nothing is attached.
  byId('chat-message').required = !state.attachments.length;
  list.replaceChildren(...state.attachments.map((file) => attachmentChip(file, () => {
    state.attachments = state.attachments.filter((candidate) => candidate !== file);
    renderAttachments();
    renderControls();
    byId('chat-message').focus();
  })));
}

function readFileData(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    // A data URL: the base64 data comes after the comma.
    reader.onload = () => resolve(String(reader.result).slice(String(reader.result).indexOf(',') + 1));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

/** Adds files for the next message within the SDK's limits, and says which ones were left out and why. */
async function addAttachments(files) {
  setAlert('chat-error');
  const problems = [];
  for (const file of files) {
    const total = state.attachments.reduce((sum, { size }) => sum + size, 0);
    if (state.attachments.length >= maxAttachments) {
      problems.push(`Mỗi tin nhắn gửi kèm tối đa ${maxAttachments} tệp.`);
      break;
    }
    if (!attachmentTypes.has(file.type)) problems.push(`${file.name}: chỉ nhận ảnh PNG, JPEG, GIF, WebP hoặc tệp PDF.`);
    else if (!file.size) problems.push(`${file.name}: tệp trống.`);
    else if (file.size > maxAttachmentSize) problems.push(`${file.name}: tệp lớn hơn 5 MB.`);
    else if (total + file.size > maxAttachmentTotal) problems.push(`${file.name}: tổng dung lượng các tệp vượt 10 MB.`);
    else {
      try {
        state.attachments.push({ name: file.name, mediaType: file.type, size: file.size, data: await readFileData(file) });
      } catch {
        problems.push(`${file.name}: không đọc được tệp.`);
      }
    }
  }
  renderAttachments();
  renderControls();
  if (problems.length) setAlert('chat-error', problems.join(' '));
}

const blockedNotes = {
  input: 'Bộ lọc đầu vào đã chặn tin nhắn này nên agent không xử lý nó.',
  output: 'Bộ lọc đầu ra đã thay câu trả lời của agent.',
};

/** Shows the result of a turn. retry hands the user's message back when the turn did not go through. */
function showRunResult(result, retry) {
  const { trace, forms } = result;
  switch (result.status) {
    case 'completed':
      return state.messages.push({ role: 'assistant', content: result.text, trace, forms });
    case 'cancelled':
      return state.messages.push({ role: 'stopped', content: 'Đã dừng lượt chạy.', trace });
    case 'interrupted':
      return state.messages.push({ role: 'approval', trace, sessionId: state.sessionId, interactive: true,
        approvals: result.interruptions.map((approval) => ({ ...approval, status: 'pending' })) });
    case 'blocked':
      // A blocked message was not stored, so the user can change it and send it again.
      if (result.stage === 'input') retry?.();
      if (result.text) return state.messages.push({ role: 'assistant', content: result.text, trace, note: blockedNotes[result.stage] });
      return state.messages.push({ role: 'failed', content: describeRunFailure(result), trace });
    case 'limit_reached':
      if (result.text) {
        return state.messages.push({ role: 'assistant', content: result.text, trace, forms,
          note: 'Agent đã đạt giới hạn bước hoặc lời gọi tool nên trả lời từ dữ liệu đã có.' });
      }
  }
  state.messages.push({ role: 'failed', content: describeRunFailure(result), trace });
  retry?.();
}

/** Runs a turn, or continues one that waited for approvals, and shows its result. Undefined when the request failed. */
async function runTurn(path, body, retry) {
  setAlert('chat-error');
  state.pending = true;
  state.activeRun = { requestId: body.requestId, registered: false, stopping: false, trace: [] };
  switchTab('chat');
  renderChat();
  renderControls();
  let result;
  try {
    result = await streamRun(path, body);
    showRunResult(result, retry);
  } catch (error) {
    state.messages.push({ role: 'failed', content: error.message });
    retry?.();
  } finally {
    state.pending = false;
    state.activeRun = null;
    renderChat();
    renderControls();
    if (document.activeElement === document.body) byId('chat-message').focus({ preventScroll: true });
  }
  return result;
}

function describeRunFailure(result) {
  const code = result.error?.code;
  if (code === 'invalid_attachment') return `Tệp đính kèm không hợp lệ. ${result.error.message}`;
  if (code === 'attachments_unsupported') return 'Model đang chọn không đọc được loại tệp này. Hãy chọn model hỗ trợ ảnh hoặc PDF, hoặc gửi tin nhắn không kèm tệp.';
  if (code === 'approval_not_found' || code === 'approval_decided') return 'Lượt chạy này không còn chờ duyệt, có thể đã được trả lời ở nơi khác. Hãy tải lại hội thoại.';
  if (code === 'invalid_approvals') return 'Quyết định duyệt chưa hợp lệ. Hãy trả lời lại các lời gọi tool.';
  if (code === 'approval_unavailable') return 'Agent không kiểm tra được quyền duyệt tool nên chưa chạy tool. Hãy thử lại.';
  if (code === 'guardrail_failed') return 'Bộ lọc nội dung gặp lỗi nên lượt chạy đã dừng để an toàn. Hãy thử lại.';
  if (code === 'input_blocked') return 'Bộ lọc đầu vào đã chặn tin nhắn này. Hãy sửa nội dung rồi gửi lại.';
  if (code === 'output_blocked') return 'Bộ lọc đầu ra đã chặn câu trả lời của agent.';
  if (code === 'timeout') return 'Agent xử lý quá lâu. Hãy thử lại với một yêu cầu ngắn hơn.';
  if (code === 'run_limit') return 'Agent đã đạt giới hạn bước hoặc lời gọi tool và không đưa ra được câu trả lời. Hãy tăng giới hạn hoặc chia nhỏ yêu cầu.';
  if (code === 'provider_rejected') return `Nhà cung cấp từ chối yêu cầu. ${result.error.message} Kiểm tra model, mức suy nghĩ và các tham số gửi kèm.`;
  if (code === 'provider_auth') return 'Nhà cung cấp không chấp nhận API key. Hãy kiểm tra key và quyền truy cập model.';
  if (code === 'provider_not_found') return 'Không tìm thấy model hoặc đường dẫn API. Hãy kiểm tra mã model và Base URL.';
  if (code === 'provider_rate_limited') return 'Nhà cung cấp đang giới hạn tần suất hoặc hết hạn mức. Hãy chờ một lúc rồi thử lại.';
  if (code === 'provider_server_error') return 'Máy chủ của nhà cung cấp đang lỗi tạm thời. Studio đã thử lại nhưng chưa được, hãy thử lại sau.';
  if (code === 'provider_context_exceeded') return 'Yêu cầu vượt quá cửa sổ context của model, kể cả sau khi đã rút gọn kết quả tool và lịch sử. Hãy dùng model có context lớn hơn hoặc giảm historyBudget.';
  if (code === 'provider_truncated') return 'Câu trả lời bị cắt vì chạm giới hạn token đầu ra. Hãy tăng giới hạn token hoặc yêu cầu câu trả lời ngắn hơn.';
  if (code === 'provider_content_filtered') return 'Nhà cung cấp đã chặn câu trả lời theo chính sách nội dung.';
  if (code === 'provider_incomplete') return 'Model dừng giữa chừng và chưa trả lời xong. Hãy thử lại.';
  if (code === 'provider_unavailable') return 'Không kết nối được với model. Hãy kiểm tra Base URL và máy chủ rồi thử lại.';
  if (code === 'provider_stream_response') return 'Máy chủ model trả về luồng SSE khi Studio yêu cầu JSON. Hãy kiểm tra chế độ phản hồi của gateway.';
  if (code === 'provider_invalid_response') return 'Studio không đọc được phản hồi của máy chủ model. Hãy kiểm tra Base URL và giao thức của gateway.';
  if (code === 'empty_reply') return 'Model trả về phản hồi trống. Hãy thử lại hoặc xem nhật ký tool để kiểm tra lượt chạy.';
  return 'Agent chưa thể trả lời. Hãy thử lại.';
}

attachEvents();
try {
  const workspace = await request('/api/workspace');
  Object.assign(state, workspace);
  state.providers = [demoProvider, ...workspace.providers];
  byId('provider').replaceChildren(...state.providers.map(({ id, label }) => new Option(label, id)));
  const active = sessionStorage.getItem('agent-studio.active');
  const first = workspace.profiles.find(({ id }) => id === active) ?? workspace.profiles[0];
  state.ready = true;
  if (first) await selectProfile(first.id);
  else showEmptyWorkspace();
} catch (error) {
  setAlert('workspace-error', `Không tải được workspace. ${error.message} Tải lại trang để thử lại.`);
}
