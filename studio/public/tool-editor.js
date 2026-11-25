const byId = (id) => document.getElementById(id);
const emptySchema = { type: 'object', properties: {}, additionalProperties: false };
const formMethods = ['POST', 'PUT', 'PATCH'];
// Keywords whose values are data, and keywords whose keys are names, as the SDK reads a result schema.
const dataKeywords = new Set(['enum', 'const', 'default', 'examples', 'example']);
const namedSchemas = new Set(['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas', 'dependencies']);

/** Every x-form value of a schema. Where x-form may sit is checked by the SDK when the agent is saved or run. */
function formNames(schema, names = []) {
  if (Array.isArray(schema)) {
    for (const item of schema) formNames(item, names);
  } else if (schema && typeof schema === 'object') {
    for (const [key, value] of Object.entries(schema)) {
      if (key === 'x-form') names.push(value);
      else if (namedSchemas.has(key) && value && typeof value === 'object' && !Array.isArray(value)) {
        for (const child of Object.values(value)) formNames(child, names);
      } else if (!dataKeywords.has(key)) formNames(value, names);
    }
  }
  return names;
}

function httpUrl(input) {
  const url = new URL(input);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) throw new Error();
  return url;
}

function labelled(text, control) {
  const label = document.createElement('label');
  label.append(text, control);
  return label;
}

/** One form of the tool: its name for x-form, its HTML and where its values are sent (none: it only shows the result). */
function formItem({ name = '', html = '', submit } = {}) {
  const item = document.createElement('fieldset');
  item.className = 'form-item';
  const nameInput = Object.assign(document.createElement('input'), {
    className: 'form-name', maxLength: 64, spellcheck: false, placeholder: 'xac_nhan', value: name,
  });
  const remove = Object.assign(document.createElement('button'), { type: 'button', className: 'icon-button remove-form', textContent: '×' });
  const describeRemove = () => remove.setAttribute('aria-label', `Xóa form ${nameInput.value.trim()}`.trim());
  nameInput.addEventListener('input', describeRemove);
  describeRemove();
  const head = document.createElement('div');
  head.className = 'form-item-head';
  head.append(labelled('Tên form (x-form)', nameInput), remove);
  const htmlInput = Object.assign(document.createElement('textarea'), {
    className: 'form-html', rows: 5, spellcheck: false, value: html,
    placeholder: '<form><input name="date"><button>Gửi</button></form>',
  });
  const method = document.createElement('select');
  method.className = 'form-method';
  method.append(...formMethods.map((value) => new Option(value)));
  method.value = submit?.method ?? 'POST';
  const url = Object.assign(document.createElement('input'), {
    className: 'form-url', type: 'url', maxLength: 2000, spellcheck: false, value: submit?.url ?? '',
    placeholder: 'Bỏ trống nếu form chỉ hiển thị kết quả',
  });
  const endpoint = document.createElement('div');
  endpoint.className = 'endpoint-fields';
  endpoint.append(labelled('Gửi bằng', method), labelled('Endpoint nhận form (tùy chọn)', url));
  item.append(head, labelled('HTML', htmlInput), endpoint);
  return item;
}

export function createToolEditor({ onSave, credentialState }) {
  const dialog = byId('tool-dialog');
  let choices = [];
  let existing = [];
  let editedIndex;
  let tokenRemoved = false;

  function showError(message = '') {
    byId('tool-error').hidden = !message;
    byId('tool-error').textContent = message;
  }

  const formList = byId('tool-form-list');

  function showEmptyForms() {
    if (formList.querySelector('.form-item')) return formList.querySelector('.empty-forms')?.remove();
    const empty = document.createElement('p');
    empty.className = 'empty-forms';
    empty.textContent = 'Chưa có form. Kết quả của tool chỉ được gửi cho model.';
    formList.replaceChildren(empty);
  }

  function writeForms(forms = {}) {
    formList.replaceChildren(...Object.entries(forms).map(([name, form]) => formItem({ name, ...form })));
    showEmptyForms();
  }

  formList.addEventListener('click', (event) => {
    const remove = event.target.closest('.remove-form');
    if (!remove) return;
    remove.closest('.form-item').remove();
    showEmptyForms();
    byId('add-tool-form').focus();
  });
  byId('add-tool-form').addEventListener('click', () => {
    const item = formItem();
    formList.append(item);
    showEmptyForms();
    item.querySelector('.form-name').focus();
  });

  /** Reads the result schema and forms of the dialog, or returns the message to show. */
  function readOutput() {
    const output = {};
    const resultText = byId('tool-result').value.trim();
    if (resultText) {
      try {
        output.result = JSON.parse(resultText);
        if (!output.result || typeof output.result !== 'object' || Array.isArray(output.result)) throw new Error();
      } catch {
        return { error: 'Schema kết quả phải là một đối tượng JSON hợp lệ.' };
      }
    }
    const forms = {};
    for (const item of formList.querySelectorAll('.form-item')) {
      const name = item.querySelector('.form-name').value.trim();
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(name)) return { error: 'Tên form chỉ gồm chữ không dấu, số, dấu gạch ngang hoặc gạch dưới.' };
      if (Object.hasOwn(forms, name)) return { error: `Có hai form cùng tên ${name}.` };
      const html = item.querySelector('.form-html').value;
      if (!html.trim()) return { error: `Nhập HTML cho form ${name}.` };
      if (new TextEncoder().encode(html).length > 64_000) return { error: `HTML của form ${name} tối đa 64 KB.` };
      // No endpoint: the form only shows the tool result (a table, a card) and has nothing to send
      const endpoint = item.querySelector('.form-url').value.trim();
      if (!endpoint) {
        forms[name] = { html };
        continue;
      }
      let url;
      try {
        url = httpUrl(endpoint);
      } catch {
        return { error: `Endpoint nhận form ${name} chưa hợp lệ (HTTP(S), không kèm thông tin đăng nhập hoặc dấu #). Bỏ trống nếu form chỉ hiển thị kết quả.` };
      }
      forms[name] = { html, submit: { method: item.querySelector('.form-method').value, url: url.href } };
    }
    const named = formNames(output.result);
    const missing = named.find((name) => typeof name !== 'string' || !Object.hasOwn(forms, name));
    if (missing !== undefined) return { error: `Schema kết quả gọi form ${JSON.stringify(missing)} nhưng chưa có form tên này.` };
    const unused = Object.keys(forms).find((name) => !named.includes(name));
    if (unused) return { error: `Form ${unused} chưa được gọi bằng x-form trong schema kết quả.` };
    if (Object.keys(forms).length) output.forms = forms;
    return { output };
  }

  function writeDetails(entry) {
    byId('tool-name').value = entry?.name ?? '';
    byId('tool-label').value = entry?.label ?? '';
    byId('tool-description').value = entry?.description ?? '';
    byId('tool-timeout').value = entry?.timeoutMs === undefined ? '' : entry.timeoutMs / 1000;
    // A backend tool whose code asks for approval always asks; the box only adds approval to the others.
    const coded = byId('tool-kind').value === 'registered' && selectedSource()?.approval === true;
    byId('tool-approval').checked = coded || entry?.approval === true;
    byId('tool-approval').disabled = coded;
    byId('tool-read-only').checked = entry?.readOnly === true;
    byId('tool-method').value = entry?.method ?? 'GET';
    byId('tool-url').value = entry?.url ?? '';
    byId('tool-token').value = '';
    tokenRemoved = false;
    byId('tool-schema').value = JSON.stringify(entry?.parameters ?? emptySchema, null, 2);
    byId('tool-result').value = entry?.result ? JSON.stringify(entry.result, null, 2) : '';
    writeForms(entry?.kind === 'http' ? entry.forms : undefined);
  }

  function updateMode() {
    const http = byId('tool-kind').value === 'http';
    byId('tool-registered-fields').hidden = http;
    byId('tool-name-row').hidden = !http;
    byId('tool-http-fields').hidden = !http;
    byId('tool-read-only-row').hidden = !http;
    byId('tool-form-fields').hidden = !http;
    byId('tool-schema').readOnly = !http;
  }

  function selectedSource() {
    return choices.find(({ name }) => name === byId('tool-source').value);
  }

  function tokenStatus() {
    const name = byId('tool-name').value.trim();
    let url;
    try { url = new URL(byId('tool-url').value.trim()).href; } catch { return null; }
    return credentialState({ name, url });
  }

  function renderTokenStatus() {
    const status = tokenStatus();
    byId('remove-tool-token').hidden = tokenRemoved || !['studio', 'pending'].includes(status);
    byId('tool-token-hint').textContent = tokenRemoved || status === 'removed' ? 'Token sẽ được xóa khi lưu cấu hình.'
      : byId('tool-token').value ? 'Token mới sẽ được dùng khi thử và lưu agent.'
        : status === 'studio' ? 'Đã lưu token. Nhập token mới để thay thế.'
          : status === 'pending' ? 'Đã nhập token cho bản đang chỉnh.'
            : status === 'environment' ? 'Đang dùng token từ cấu hình máy chủ.'
              : 'Để trống nếu endpoint không yêu cầu token.';
  }

  byId('tool-kind').addEventListener('change', () => {
    updateMode();
    writeDetails(byId('tool-kind').value === 'registered' ? selectedSource() : undefined);
    showError();
  });
  byId('tool-source').addEventListener('change', () => writeDetails(selectedSource()));
  for (const id of ['tool-name', 'tool-url', 'tool-token']) {
    byId(id).addEventListener('input', () => {
      if (id !== 'tool-token') byId('tool-token').value = '';
      tokenRemoved = false;
      renderTokenStatus();
    });
  }
  byId('tool-kind').addEventListener('change', renderTokenStatus);
  byId('remove-tool-token').addEventListener('click', () => {
    byId('tool-token').value = '';
    tokenRemoved = true;
    renderTokenStatus();
  });
  byId('close-tool-dialog').addEventListener('click', () => dialog.close());
  byId('cancel-tool-edit').addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => { byId('tool-token').value = ''; });

  byId('tool-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const kind = byId('tool-kind').value;
    const name = kind === 'registered' ? byId('tool-source').value : byId('tool-name').value.trim();
    const label = byId('tool-label').value.trim();
    const description = byId('tool-description').value.trim();
    if (!/^[a-z_][a-z0-9_-]{0,63}$/i.test(name)) return showError('Mã tool phải bắt đầu bằng chữ hoặc gạch dưới và chỉ gồm chữ, số, dấu gạch.');
    if (existing.some((entry, index) => index !== editedIndex && entry.name === name)) return showError('Mã tool này đã có trong agent.');
    if (!label || !description) return showError('Nhập tên hiển thị và mô tả cho model.');
    const tool = { kind, name, label, description };
    const timeout = byId('tool-timeout');
    if (timeout.value) {
      if (!timeout.validity.valid) return showError('Thời hạn riêng cần nằm trong khoảng 0,001 đến 300 giây.');
      tool.timeoutMs = Math.round(timeout.valueAsNumber * 1000);
    }
    if (byId('tool-approval').checked && !byId('tool-approval').disabled) tool.approval = true;
    if (kind === 'http' && byId('tool-read-only').checked) tool.readOnly = true;
    let token;
    if (kind === 'http') {
      let url;
      let parameters;
      try {
        url = httpUrl(byId('tool-url').value.trim());
      } catch {
        return showError('Nhập endpoint HTTP(S) hợp lệ, không kèm thông tin đăng nhập hoặc dấu #.');
      }
      try {
        parameters = JSON.parse(byId('tool-schema').value);
        if (parameters?.type !== 'object') throw new Error();
      } catch {
        return showError('Schema đầu vào phải là JSON hợp lệ với type là object.');
      }
      const { output, error } = readOutput();
      if (error) return showError(error);
      Object.assign(tool, output);
      token = tokenRemoved ? null : byId('tool-token').value.trim() || undefined;
      const previous = existing[editedIndex];
      const apiKeyEnv = previous?.name === name && previous.url === url.href ? previous.apiKeyEnv : undefined;
      Object.assign(tool, { url: url.href, method: byId('tool-method').value, parameters, ...(apiKeyEnv ? { apiKeyEnv } : {}) });
    }
    onSave(tool, editedIndex, token);
    byId('tool-token').value = '';
    dialog.close();
  });

  return function open({ edited, tools, catalog, index }) {
    existing = tools;
    editedIndex = index;
    const names = new Set(tools.filter((_, position) => position !== index).map(({ name }) => name));
    choices = catalog.filter(({ name }) => !names.has(name));
    const source = byId('tool-source');
    source.replaceChildren(...choices.map(({ name, label }) => new Option(label, name)));
    source.value = edited?.kind === 'registered' ? edited.name : choices[0]?.name ?? '';
    source.disabled = edited?.kind === 'registered';
    const kind = byId('tool-kind');
    kind.options[0].disabled = !choices.length;
    kind.value = edited?.kind ?? (choices.length ? 'registered' : 'http');
    kind.disabled = Boolean(edited);
    byId('tool-dialog-title').textContent = edited ? 'Sửa tool' : 'Thêm tool';
    byId('submit-tool').textContent = edited ? 'Áp dụng thay đổi' : 'Thêm vào agent';
    writeDetails(edited ?? (kind.value === 'registered' ? selectedSource() : undefined));
    updateMode();
    renderTokenStatus();
    showError();
    dialog.showModal();
  };
}
