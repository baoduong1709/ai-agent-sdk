const byId = (id) => document.getElementById(id);
const maxTools = 128;

function httpUrl(input) {
  const url = new URL(input);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) throw new Error();
  return url;
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * The dialog that declares an MCP server of the agent: its prefix, endpoint, token and which of its tools the agent
 * gets. loadTools asks Studio for the tools the server offers; without it the dialog shows the names already chosen.
 */
export function createMcpEditor({ onSave, credentialState, loadTools }) {
  const dialog = byId('mcp-dialog');
  const allTools = byId('mcp-all-tools');
  const list = byId('mcp-tool-list');
  let existing = [];
  let editedIndex;
  let tokenRemoved = false;
  let selected = new Set();
  let loaded = null;
  let loading = 0;
  let missing = [];

  function showError(message = '') {
    byId('mcp-error').hidden = !message;
    byId('mcp-error').textContent = message;
  }

  function readPrefix() {
    const prefix = byId('mcp-prefix').value.trim();
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(prefix)) {
      throw new Error('Tiền tố chỉ gồm chữ không dấu, số, dấu gạch ngang hoặc gạch dưới, tối đa 32 ký tự.');
    }
    if (existing.some((server, index) => index !== editedIndex && server.prefix.toLowerCase() === prefix.toLowerCase())) {
      throw new Error('Tiền tố này đã dùng cho một MCP server khác của agent.');
    }
    return prefix;
  }

  function readEndpoint() {
    try {
      return httpUrl(byId('mcp-url').value.trim()).href;
    } catch {
      throw new Error('Nhập endpoint HTTP(S) hợp lệ của MCP server, không kèm thông tin đăng nhập hoặc dấu #.');
    }
  }

  function readTimeout() {
    const input = byId('mcp-timeout');
    if (!input.value) return {};
    if (!input.validity.valid) throw new Error('Thời hạn mỗi lần gọi tool cần nằm trong khoảng 0,001 đến 300 giây.');
    return { timeoutMs: Math.round(input.valueAsNumber * 1000) };
  }

  /** The variable a deployed agent reads the token from stays only while the server is the same one. */
  function keptKeyEnvironment(prefix, url) {
    const previous = existing[editedIndex];
    return previous?.prefix === prefix && previous.url === url && previous.apiKeyEnv ? { apiKeyEnv: previous.apiKeyEnv } : {};
  }

  function tokenStatus() {
    const prefix = byId('mcp-prefix').value.trim();
    let url;
    try { url = new URL(byId('mcp-url').value.trim()).href; } catch { return null; }
    return prefix ? credentialState({ prefix, url }) : null;
  }

  function renderTokenStatus() {
    const status = tokenStatus();
    byId('remove-mcp-token').hidden = tokenRemoved || !['studio', 'pending'].includes(status);
    byId('mcp-token-hint').textContent = tokenRemoved || status === 'removed' ? 'Token sẽ được xóa khi lưu cấu hình.'
      : byId('mcp-token').value ? 'Token mới sẽ được dùng khi thử và lưu agent.'
        : status === 'studio' ? 'Đã lưu token. Nhập token mới để thay thế.'
          : status === 'pending' ? 'Đã nhập token cho bản đang chỉnh.'
            : status === 'environment' ? 'Đang dùng token từ cấu hình máy chủ.'
              : 'Studio gửi token qua header Authorization: Bearer. Để trống nếu server không yêu cầu.';
  }

  function toolItem(tool, all) {
    const item = element('label', 'mcp-tool');
    const box = Object.assign(document.createElement('input'), { type: 'checkbox', value: tool.name });
    box.checked = all || selected.has(tool.name);
    box.disabled = all;
    const info = element('span', 'mcp-tool-info');
    const head = element('span', 'mcp-tool-head');
    head.append(element('strong', '', tool.title ?? tool.name));
    if (tool.title) head.append(element('code', '', tool.name));
    if (tool.app) head.append(element('span', 'badge', 'Có giao diện'));
    if (tool.readOnly) head.append(element('span', 'badge', 'Chỉ đọc'));
    info.append(head);
    if (tool.description) info.append(element('span', 'mcp-tool-description', tool.description));
    item.append(box, info);
    return item;
  }

  function renderTools() {
    const all = allTools.checked;
    const entries = loaded ? loaded.tools : [...selected].map((name) => ({ name }));
    list.replaceChildren(...entries.map((tool) => toolItem(tool, all)));
    list.hidden = !entries.length;
    const status = byId('mcp-tools-status');
    if (loading) {
      status.textContent = 'Đang kết nối MCP server…';
    } else if (loaded) {
      const { server, tools, skipped } = loaded;
      const notes = [`${server.title ?? server.name} ${server.version} có ${tools.length} tool cho model.`];
      if (skipped.length) notes.push(`Bỏ qua ${skipped.map(({ name, reason }) => `${name} (${reason})`).join('; ')}.`);
      if (missing.length) notes.push(`Server không còn ${missing.join(', ')}; các tool này sẽ được bỏ khỏi agent.`);
      if (all && tools.length > maxTools) notes.push(`Agent dùng tối đa ${maxTools} tool, hãy chọn bớt.`);
      status.textContent = notes.join(' ');
    } else {
      status.textContent = all ? 'Tải danh sách tool để xem và chọn từng tool.'
        : selected.size ? 'Đang hiện các tool đã chọn. Tải danh sách tool để xem mô tả và chọn thêm.'
          : 'Tải danh sách tool để chọn.';
    }
    byId('load-mcp-tools').disabled = Boolean(loading);
  }

  list.addEventListener('change', (event) => {
    const box = event.target;
    if (box.type !== 'checkbox') return;
    if (box.checked) selected.add(box.value);
    else selected.delete(box.value);
  });
  allTools.addEventListener('change', () => {
    // Choosing tools one by one starts from all those the server offers, so the user only unticks the ones to leave out.
    if (!allTools.checked && !selected.size && loaded) selected = new Set(loaded.tools.map(({ name }) => name));
    renderTools();
  });

  byId('load-mcp-tools').addEventListener('click', async () => {
    let server;
    try {
      const prefix = readPrefix();
      const url = readEndpoint();
      server = { prefix, url, ...keptKeyEnvironment(prefix, url), ...readTimeout() };
    } catch (error) {
      return showError(error.message);
    }
    showError();
    const attempt = ++loading;
    renderTools();
    try {
      const result = await loadTools({ server, token: tokenRemoved ? null : byId('mcp-token').value.trim() || undefined });
      if (attempt !== loading) return;
      const offered = new Set(result.tools.map(({ name }) => name));
      missing = [...selected].filter((name) => !offered.has(name));
      selected = new Set([...selected].filter((name) => offered.has(name)));
      loaded = result;
    } catch (error) {
      if (attempt === loading) showError(error.message);
    } finally {
      if (attempt === loading) {
        loading = 0;
        renderTools();
      }
    }
  });

  for (const id of ['mcp-prefix', 'mcp-url', 'mcp-token']) {
    byId(id).addEventListener('input', () => {
      if (id !== 'mcp-token') byId('mcp-token').value = '';
      if (id === 'mcp-url' && (loaded || loading)) {
        // The list belongs to the old endpoint; the chosen names stay until the new list is loaded.
        loaded = null;
        loading = 0;
        missing = [];
        renderTools();
      }
      tokenRemoved = false;
      renderTokenStatus();
    });
  }
  byId('remove-mcp-token').addEventListener('click', () => {
    byId('mcp-token').value = '';
    tokenRemoved = true;
    renderTokenStatus();
  });
  byId('close-mcp-dialog').addEventListener('click', () => dialog.close());
  byId('cancel-mcp-edit').addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => {
    byId('mcp-token').value = '';
    loading = 0;
  });

  byId('mcp-form').addEventListener('submit', (event) => {
    event.preventDefault();
    let server;
    try {
      const prefix = readPrefix();
      const url = readEndpoint();
      const timeout = readTimeout();
      let tools;
      if (!allTools.checked) {
        tools = loaded ? loaded.tools.map(({ name }) => name).filter((name) => selected.has(name)) : [...selected];
        if (!tools.length) throw new Error('Chọn ít nhất một tool hoặc dùng tất cả tool của server.');
        if (tools.length > maxTools) throw new Error(`Chọn tối đa ${maxTools} tool cho một MCP server.`);
      }
      server = { prefix, url, ...(tools ? { tools } : {}), ...keptKeyEnvironment(prefix, url), ...timeout };
    } catch (error) {
      return showError(error.message);
    }
    onSave(server, editedIndex, tokenRemoved ? null : byId('mcp-token').value.trim() || undefined);
    byId('mcp-token').value = '';
    dialog.close();
  });

  return function open({ edited, servers, index }) {
    existing = servers;
    editedIndex = index;
    tokenRemoved = false;
    loaded = null;
    loading = 0;
    missing = [];
    selected = new Set(edited?.tools ?? []);
    byId('mcp-prefix').value = edited?.prefix ?? '';
    byId('mcp-url').value = edited?.url ?? '';
    byId('mcp-token').value = '';
    byId('mcp-timeout').value = edited?.timeoutMs === undefined ? '' : edited.timeoutMs / 1000;
    allTools.checked = !edited?.tools;
    byId('mcp-dialog-title').textContent = edited ? 'Sửa MCP server' : 'Thêm MCP server';
    byId('submit-mcp').textContent = edited ? 'Áp dụng thay đổi' : 'Thêm vào agent';
    renderTools();
    renderTokenStatus();
    showError();
    dialog.showModal();
  };
}
