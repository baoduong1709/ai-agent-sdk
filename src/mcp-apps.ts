/**
 * Tool forms as MCP Apps (https://modelcontextprotocol.io/extensions/apps, protocol 2026-01-26). The HTML a tool registers
 * is wrapped into a full document of type text/html;profile=mcp-app. A bridge inside that document speaks the MCP Apps
 * JSON-RPC protocol over postMessage with whatever chat shows it (the Studio, or any other MCP Apps host), and gives the
 * form's own code the window.agentForm API.
 */

/** The MIME type of an MCP App document. */
export const mcpAppMimeType = 'text/html;profile=mcp-app';
/** The MCP Apps protocol version the bridge asks for. */
export const mcpAppProtocolVersion = '2026-01-26';
/**
 * The _meta key of a tool result that carries the state of a form: { id, status, result?, error? }. A host that knows
 * the SDK sends it with the tool result and with the result of a submission; without it the form starts open, or shown
 * when it has no submit.
 */
export const formStateKey = 'agent-studio-sdk/form';

/** The ui:// resource URI of a tool form. */
export function formUri(tool: string, form: string) {
  return `ui://${encodeURIComponent(tool)}/${encodeURIComponent(form)}`;
}

/** The name of the tool call a form makes to submit its values: the tool name, a dot, then the form name. */
export function formSubmitName(tool: string, form: string) {
  return `${tool}.${form}`;
}

const baseStyle = `:root { color-scheme: light; font: 13px/1.5 'DM Sans', 'Segoe UI', sans-serif; color: #22243a; background: #fff; }
body { margin: 0; padding: 12px 14px; }
form { display: grid; gap: 10px; }
label { display: grid; gap: 4px; font-size: 12px; font-weight: 650; }
input, select, textarea, button { font: inherit; color: inherit; }
input:not([type=checkbox], [type=radio]), select, textarea { box-sizing: border-box; width: 100%; padding: 6px 9px; border: 1px solid #dce0ed; border-radius: 6px; background: #fff; }
textarea { min-height: 64px; resize: vertical; }
button { justify-self: start; padding: 7px 15px; border: 0; border-radius: 6px; color: #fff; background: #5142dc; cursor: pointer; }
button[type=button], button[type=reset] { color: #22243a; background: #eef0f6; }
:disabled { opacity: .6; cursor: default; }
:focus-visible { outline: 2px solid #7366f7; outline-offset: 2px; }`;

/**
 * Runs inside the form document with its config. Written as plain browser JavaScript: the SDK has no DOM types, and the
 * text is sent to the browser as is.
 */
const bridge = String.raw`(config) => {
  const protocolVersion = ${JSON.stringify(mcpAppProtocolVersion)};
  const stateKey = ${JSON.stringify(formStateKey)};
  const state = { data: undefined, arguments: undefined, status: config.submit ? 'open' : 'shown', result: undefined,
    error: undefined, sending: false };
  const listeners = new Set();
  const pending = new Map();
  const unsafeKeys = new Set(['__proto__', 'constructor', 'prototype']);
  const host = window.parent;
  let rendered = false;
  let nextId = 1;

  // The frame may have an opaque origin, so the host cannot be addressed by origin; only the parent window gets these.
  const post = (message) => host.postMessage({ jsonrpc: '2.0', ...message }, '*');
  const notify = (method, params = {}) => post({ method, params });
  function request(method, params) {
    const id = nextId++;
    post({ id, method, params });
    return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
  }
  const read = (source, path) => path.split('.').reduce((value, key) => (value == null ? undefined : value[key]), source);

  function assign(target, name, value) {
    const list = name.endsWith('[]');
    const keys = (list ? name.slice(0, -2) : name).split('.');
    if (keys.some((key) => !key || unsafeKeys.has(key))) return;
    const last = keys.pop();
    let node = target;
    for (const key of keys) node = node[key] && typeof node[key] === 'object' && !Array.isArray(node[key]) ? node[key] : (node[key] = {});
    if (list) node[last] = [...(Array.isArray(node[last]) ? node[last] : []), value];
    else node[last] = Object.hasOwn(node, last) ? [].concat(node[last], value) : value;
  }

  /** The values of a form, keyed by field name. A dotted name builds a nested object; a name ending in [] a list. */
  function collect(form) {
    const values = {};
    for (const field of form.elements) {
      const { name, type } = field;
      if (!name || field.disabled || !('value' in field) || ['submit', 'button', 'reset', 'file', 'image'].includes(type)) continue;
      if (field.tagName === 'FIELDSET' || field.tagName === 'OUTPUT') continue;
      let value = field.value;
      if (type === 'checkbox') {
        if (!field.hasAttribute('value')) value = field.checked;
        else if (!field.checked) continue;
      } else if (type === 'radio') {
        if (!field.checked) continue;
      } else if (type === 'number' || type === 'range') {
        if (field.value === '') continue;
        value = field.valueAsNumber;
      } else if (field.tagName === 'SELECT' && field.multiple) {
        value = Array.from(field.selectedOptions, (option) => option.value);
      }
      assign(values, name, value);
    }
    return values;
  }

  /** Shows the tool result: fields whose name matches a result field start with its value; [data-field] shows it as text. */
  function fill(root) {
    for (const node of root.querySelectorAll('[data-field]')) {
      const value = read(state.data, node.dataset.field);
      node.textContent = value == null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
    }
    for (const field of root.querySelectorAll('input[name], select[name], textarea[name]')) {
      const value = read(state.data, field.name.replace(/\[\]$/, ''));
      if (value == null) continue;
      const options = [].concat(value).map(String);
      if (field.type === 'checkbox') field.checked = field.hasAttribute('value') ? options.includes(field.value) : Boolean(value);
      else if (field.type === 'radio') field.checked = String(value) === field.value;
      else if (field.tagName === 'SELECT' && field.multiple) for (const option of field.options) option.selected = options.includes(option.value);
      else if (field.type !== 'file' && typeof value !== 'object') field.value = String(value);
    }
  }

  /** Scripts inserted as HTML do not run, so each one is replaced by a copy that does, in document order. */
  function activate(root) {
    for (const original of root.querySelectorAll('script')) {
      const script = document.createElement('script');
      for (const { name, value } of original.attributes) script.setAttribute(name, value);
      script.textContent = original.textContent;
      original.replaceWith(script);
    }
  }

  /** Disables the fields while the form is sent and once it is closed; a rejected submission makes them editable again. */
  function lock() {
    const closed = state.sending || state.status !== 'open';
    document.documentElement.dataset.status = state.sending ? 'sending' : state.status;
    for (const form of document.forms) {
      for (const field of form.elements) {
        if (closed && !field.disabled) {
          field.disabled = true;
          field.dataset.agentLocked = '';
        } else if (!closed && field.hasAttribute('data-agent-locked')) {
          field.disabled = false;
          field.removeAttribute('data-agent-locked');
        }
      }
    }
  }

  const report = () => notify('ui/notifications/size-changed', { height: Math.ceil(document.documentElement.getBoundingClientRect().height) });
  const snapshot = () => structuredClone({ status: state.status, result: state.result, error: state.error, sending: state.sending });

  function changed() {
    lock();
    for (const listener of listeners) {
      try {
        listener(snapshot());
      } catch (failure) {
        console.error(failure);
      }
    }
    // Reading the size lays the form out now, so the host can size the frame without waiting for the observer.
    report();
  }

  /** The text of a tool result, and its value: structuredContent, else the text read as JSON when it is JSON. */
  function resultValue(result) {
    const text = (Array.isArray(result?.content) ? result.content : [])
      .filter((item) => item?.type === 'text' && typeof item.text === 'string').map((item) => item.text).join('\n');
    if (result?.structuredContent !== undefined) return { text, value: result.structuredContent };
    try {
      return { text, value: JSON.parse(text) };
    } catch {
      return { text, value: text || undefined };
    }
  }

  function applyState(form) {
    if (!form || typeof form !== 'object') return false;
    if (['open', 'submitted', 'failed', 'shown'].includes(form.status)) state.status = form.status;
    state.result = form.result;
    state.error = form.error;
    return true;
  }

  function send(values) {
    if (!rendered || state.sending || state.status !== 'open') return false;
    state.sending = true;
    changed();
    request('tools/call', { name: config.tool + '.' + config.form, arguments: values }).then((result) => {
      if (applyState(result?._meta?.[stateKey])) return;
      const { text, value } = resultValue(result);
      if (result?.isError) state.error = { code: 'tool_error', message: text || 'The form could not be submitted.' };
      else Object.assign(state, { status: 'submitted', result: value, error: undefined });
    }, (error) => {
      state.error = { code: 'request_failed', message: error?.message || 'The chat did not accept the form.' };
    }).finally(() => {
      state.sending = false;
      changed();
    });
    return true;
  }

  function render(result) {
    const { value } = resultValue(result);
    state.data = value;
    applyState(result?._meta?.[stateKey]);
    if (!rendered) {
      rendered = true;
      document.body.innerHTML = config.html;
      fill(document.body);
      activate(document.body);
    }
    changed();
  }

  window.agentForm = Object.freeze({
    /** The value the tool returned when the form was shown. */
    get data() { return state.data; },
    /** The arguments of the tool call, once the chat has sent them. */
    get arguments() { return state.arguments; },
    get status() { return state.status; },
    get result() { return state.result; },
    get error() { return state.error; },
    /** Sends values instead of the collected fields. Returns false while a submission is running or the form is closed. */
    submit: (values) => send(values),
    /** Calls listener with { status, result, error, sending } after every change. Returns a function that removes it. */
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  });

  // A form script that handles submit itself calls preventDefault and then agentForm.submit(values).
  window.addEventListener('submit', (event) => {
    if (event.defaultPrevented) return;
    event.preventDefault();
    send(collect(event.target));
  });
  HTMLFormElement.prototype.submit = function submit() { send(collect(this)); };

  window.addEventListener('message', (event) => {
    const message = event.data;
    if (event.source !== host || message?.jsonrpc !== '2.0') return;
    const { id, method, params } = message;
    if (method === undefined) {
      const call = pending.get(id);
      if (!call) return;
      pending.delete(id);
      if (message.error) call.reject(new Error(message.error.message || 'Request failed'));
      else call.resolve(message.result);
      return;
    }
    if (method === 'ui/notifications/tool-input') {
      state.arguments = params?.arguments;
    } else if (method === 'ui/notifications/tool-result') {
      render(params);
    } else if (method === 'ui/resource-teardown' || method === 'ping') {
      post({ id, result: {} });
    } else if (id !== undefined) {
      post({ id, error: { code: -32601, message: 'Method not found' } });
    }
  });

  // The observer waits for the next rendering pass, which a background tab may not get for a while.
  new ResizeObserver(report).observe(document.documentElement);
  request('ui/initialize', {
    protocolVersion, appInfo: { name: config.tool + '.' + config.form, version: '1.0.0' },
    appCapabilities: { availableDisplayModes: ['inline'] },
  }).then(() => notify('ui/notifications/initialized'), (error) => console.error(error));
}`;

/** JSON that can sit inside a script element: < is escaped, so the text cannot close the element or open a comment. */
function scriptJson(value: unknown) {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

/**
 * Wraps the HTML of a tool form into an MCP App document. The document waits for the tool result from the host, then
 * shows the form with it; submitting calls tools/call with the name formSubmitName(tool, form) and the values.
 */
export function formAppHtml(html: string, { tool, form, submit }: { tool: string; form: string; submit: boolean }) {
  const config = scriptJson({ tool, form, submit, html });
  return '<!doctype html>\n<html>\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
    `<style>\n${baseStyle}\n</style>\n<script>\n(${bridge})(${config});\n</script>\n</head>\n<body></body>\n</html>\n`;
}
