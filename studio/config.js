import { defaultRunLimits, defineTool } from 'agent-studio-sdk';
import { defineHttpTool, parseHttpUrl } from 'agent-studio-sdk/http-tool';
import { createModel, modelProviders } from 'agent-studio-sdk/models';
import { demoModel } from './demo.js';

export class RequestError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function readText(value, limit, label) {
  if (typeof value !== 'string' || !value.trim() || value.length > limit) {
    throw new RequestError(400, `${label} cần từ 1 đến ${limit} ký tự.`);
  }
  return value.trim();
}

export function readId(value, label) {
  const id = readText(value, 100, label);
  if (!/^[a-z0-9-]+$/i.test(id)) throw new RequestError(400, `${label} không hợp lệ.`);
  return id;
}

/**
 * The files sent with a chat message, checked only for shape: the SDK checks their type, content and size and answers
 * invalid_attachment, so the chat can show why a file was refused.
 */
export function readAttachmentList(value) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => !item || typeof item !== 'object' || Array.isArray(item) ||
      typeof item.mediaType !== 'string' || typeof item.data !== 'string' || (item.name !== undefined && typeof item.name !== 'string'))) {
    throw new RequestError(400, 'Tệp đính kèm phải là danh sách gồm mediaType, data (base64) và name nếu có.');
  }
  return value.length ? value.map(({ name, mediaType, data }) => ({ ...(name === undefined ? {} : { name }), mediaType, data })) : undefined;
}

/** The message and files of a run. A message may be files only, like a photo sent without a caption. */
export function readRunInput(body) {
  const attachments = readAttachmentList(body.attachments);
  const filesOnly = attachments && (body.message === undefined || (typeof body.message === 'string' && !body.message.trim()));
  return { message: filesOnly ? '' : readText(body.message, 4000, 'Tin nhắn'), ...(attachments ? { attachments } : {}) };
}

/** The answers to tool calls that wait for approval: each names the approval and says whether it is allowed. */
export function readApprovals(value) {
  if (!Array.isArray(value) || !value.length || value.length > 20) {
    throw new RequestError(400, 'Cần từ 1 đến 20 quyết định duyệt tool.');
  }
  return value.map((item) => {
    if (!item || typeof item !== 'object' || typeof item.approved !== 'boolean') {
      throw new RequestError(400, 'Mỗi quyết định cần id và approved là true hoặc false.');
    }
    const id = readId(item.id, 'Mã yêu cầu duyệt');
    if (item.reason !== undefined && (typeof item.reason !== 'string' || item.reason.length > 500)) {
      throw new RequestError(400, 'Lý do duyệt tool tối đa 500 ký tự.');
    }
    const reason = item.reason?.trim();
    return { id, approved: item.approved, ...(reason ? { reason } : {}) };
  });
}

function readLimit(value, maximum, label) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new RequestError(400, `${label} phải là số nguyên từ 1 đến ${maximum}.`);
  }
  return value;
}

function readToolTimeout(value) {
  if (value === undefined) return {};
  return { timeoutMs: readLimit(value, 300_000, 'Thời hạn của tool (ms)') };
}

function readExecution(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new RequestError(400, 'Giới hạn chạy không hợp lệ.');
  return {
    maxSteps: readLimit(input.maxSteps === undefined ? defaultRunLimits.maxSteps : input.maxSteps, 50, 'Số lần gọi model'),
    maxToolCalls: readLimit(input.maxToolCalls === undefined ? defaultRunLimits.maxToolCalls : input.maxToolCalls, 100, 'Số lần gọi tool'),
    timeoutMs: readLimit(input.timeoutMs === undefined ? defaultRunLimits.timeoutMs : input.timeoutMs, 300_000, 'Thời hạn lượt chạy (ms)'),
  };
}

function keyEnvironment(value) {
  if (value === undefined || value === '') return undefined;
  const name = readText(value, 100, 'Tên biến môi trường');
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new RequestError(400, 'Tên biến môi trường chỉ chứa chữ, số và dấu gạch dưới.');
  return name;
}

function readUrl(value) {
  try {
    return parseHttpUrl(readText(value, 2000, 'URL'));
  } catch (error) {
    throw new RequestError(400, error.message);
  }
}

const formMethods = ['POST', 'PUT', 'PATCH'];
const maxForms = 20;

function plainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** JSON schema of what an HTTP tool returns. Its x-form keywords pick which form the chat shows for a result. */
function readResultSchema(input) {
  if (input === undefined || input === null) return undefined;
  if (!plainObject(input)) throw new RequestError(400, 'Schema kết quả phải là một đối tượng JSON.');
  return input;
}

/**
 * The forms of an HTTP tool by name: HTML for the chat, and where the submitted values are sent. A form without
 * submit (or with an empty URL) only shows the tool result, as a table or a card.
 */
function readForms(input) {
  if (input === undefined || input === null) return undefined;
  if (!plainObject(input)) throw new RequestError(400, 'Danh sách form của tool không hợp lệ.');
  const entries = Object.entries(input);
  if (entries.length > maxForms) throw new RequestError(400, `Mỗi tool có tối đa ${maxForms} form.`);
  if (!entries.length) return undefined;
  return Object.fromEntries(entries.map(([name, form]) => {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(name)) {
      throw new RequestError(400, 'Tên form chỉ gồm chữ không dấu, số, dấu gạch ngang hoặc gạch dưới, tối đa 64 ký tự.');
    }
    if (!plainObject(form)) throw new RequestError(400, `Form ${name} không hợp lệ.`);
    if (typeof form.html !== 'string' || !form.html.trim() || Buffer.byteLength(form.html) > 64_000) {
      throw new RequestError(400, `HTML của form ${name} cần có nội dung và tối đa 64 KB.`);
    }
    if (form.submit !== undefined && form.submit !== null && !plainObject(form.submit)) {
      throw new RequestError(400, `Nơi nhận form ${name} không hợp lệ.`);
    }
    const url = typeof form.submit?.url === 'string' ? form.submit.url.trim() : form.submit?.url;
    if (url === undefined || url === null || url === '') return [name, { html: form.html }];
    const method = form.submit.method ?? 'POST';
    if (!formMethods.includes(method)) throw new RequestError(400, `Form ${name} chỉ gửi được bằng POST, PUT hoặc PATCH.`);
    return [name, { html: form.html, submit: { method, url: readUrl(url).href } }];
  }));
}

/** The SDK reports result schema mistakes in English; Studio shows the ones about forms in Vietnamese. */
const toolErrors = [
  [/has forms that no x-form in its result schema names: (.+)$/, (names) => `Schema kết quả chưa có x-form nào gọi form ${names}.`],
  [/result schema( \S+)? names a form the tool does not have: (.+)$/,
    (part = '', name) => `Schema kết quả${part} gọi form ${name} nhưng tool chưa có form tên này.`],
  [/result schema has oneOf or anyOf branches/, () => 'Schema kết quả có nhánh oneOf/anyOf nên x-form phải đặt trên từng nhánh, không đặt ở gốc.'],
  [/has x-form in a place that is not read/,
    () => 'x-form chỉ được đặt ở gốc schema kết quả hoặc trên các nhánh oneOf/anyOf trực tiếp của nó.'],
  [/result schema is invalid( \S+)?: (.+)$/, (part = '', detail) => `Schema kết quả không hợp lệ${part}: ${detail}`],
];

function toolErrorText(message) {
  for (const [pattern, text] of toolErrors) {
    const match = pattern.exec(message);
    if (match) return text(...match.slice(1));
  }
  return message;
}

/**
 * Whether a tool asks the user before it runs and, for an HTTP tool, whether it only reads data so calls can run together.
 * Each is kept only when true: a registered tool keeps the approval its code asks for.
 */
function readToolFlags(entry, keys) {
  const flags = {};
  for (const key of keys) {
    if (entry[key] !== undefined && typeof entry[key] !== 'boolean') throw new RequestError(400, `Tùy chọn ${key} của tool phải là true hoặc false.`);
    if (entry[key]) flags[key] = true;
  }
  return flags;
}

function createTools(entries, toolCatalog, environment, credentialValues) {
  if (!Array.isArray(entries) || entries.length > 48) throw new RequestError(400, 'Mỗi agent có thể có tối đa 48 tool.');
  const names = new Set();
  return entries.map((entry) => {
    const source = typeof entry === 'string' ? entry : entry?.kind === 'registered' ? entry.name : null;
    if (source) {
      const existing = toolCatalog.get(source);
      if (!existing) throw new RequestError(400, `Tool ${source} chưa được đăng ký.`);
      if (names.has(source)) throw new RequestError(400, `Tool ${source} đã có trong agent.`);
      names.add(source);
      if (typeof entry === 'string') return { config: entry, tool: existing.tool };
      const label = readText(entry.label, 80, 'Tên hiển thị');
      const description = readText(entry.description, 1500, 'Mô tả tool');
      const timeout = readToolTimeout(entry.timeoutMs);
      const flags = readToolFlags(entry, ['approval']);
      return { config: { kind: 'registered', name: source, label, description, ...timeout, ...flags },
        tool: defineTool({ ...existing.tool, description, ...timeout, ...(existing.tool.approval ? {} : flags) }) };
    }

    if (entry?.kind !== 'http') throw new RequestError(400, 'Loại tool không hợp lệ.');
    const name = readText(entry.name, 64, 'Mã tool');
    if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(name)) throw new RequestError(400, 'Mã tool phải bắt đầu bằng chữ hoặc gạch dưới.');
    if (names.has(name)) throw new RequestError(400, `Tool ${name} đã có trong agent.`);
    names.add(name);
    const label = readText(entry.label, 80, 'Tên hiển thị');
    const description = readText(entry.description, 1500, 'Mô tả tool');
    const url = readUrl(entry.url).href;
    const apiKeyEnv = keyEnvironment(entry.apiKeyEnv);
    const storedKey = credentialValues.get(`tool:${name}`);
    const { method, parameters } = entry;
    const timeout = readToolTimeout(entry.timeoutMs);
    const flags = readToolFlags(entry, ['approval', 'readOnly']);
    if (entry.form !== undefined) {
      throw new RequestError(400, `Tool ${name} còn dùng một form cố định. Thêm form vào danh sách form và gọi form bằng x-form trong schema kết quả.`);
    }
    const result = readResultSchema(entry.result);
    const forms = readForms(entry.forms);
    const output = { ...(result ? { result } : {}), ...(forms ? { forms } : {}) };
    try {
      const tool = defineHttpTool({ name, description, parameters, method, url, ...timeout, ...flags, ...output,
        ...(storedKey || apiKeyEnv ? { apiKey: () => storedKey ?? environment[apiKeyEnv] } : {}),
      });
      return { config: { kind: 'http', name, label, description, parameters, method, url, apiKeyEnv, ...timeout, ...flags, ...output }, tool };
    } catch (error) {
      throw new RequestError(400, `Tool ${name} có cấu hình không hợp lệ. ${toolErrorText(error.message)}`);
    }
  });
}

export const maxMcpServers = 10;
const maxMcpToolNames = 128;

/**
 * The MCP servers of an agent. Studio connects to them when the agent runs, not when the profile is saved, so a server
 * that is down or whose token is missing does not block editing. The prefix names the server and its credential.
 */
export function readMcpServers(input) {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input) || input.length > maxMcpServers) {
    throw new RequestError(400, `Mỗi agent có tối đa ${maxMcpServers} MCP server.`);
  }
  const prefixes = new Set();
  return input.map((entry) => {
    if (!plainObject(entry)) throw new RequestError(400, 'Cấu hình MCP server không hợp lệ.');
    const prefix = typeof entry.prefix === 'string' ? entry.prefix.trim() : '';
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(prefix)) {
      throw new RequestError(400, 'Tiền tố MCP server chỉ gồm chữ không dấu, số, dấu gạch ngang hoặc gạch dưới, tối đa 32 ký tự.');
    }
    // Credentials and environment variable names ignore case, so two prefixes that differ only in case would clash.
    if (prefixes.has(prefix.toLowerCase())) throw new RequestError(400, `Tiền tố MCP server ${prefix} bị trùng.`);
    prefixes.add(prefix.toLowerCase());
    const url = readUrl(entry.url).href;
    const apiKeyEnv = keyEnvironment(entry.apiKeyEnv);
    const timeout = readToolTimeout(entry.timeoutMs);
    let tools;
    if (entry.tools !== undefined && entry.tools !== null) {
      if (!Array.isArray(entry.tools) || !entry.tools.length || entry.tools.length > maxMcpToolNames) {
        throw new RequestError(400, `MCP server ${prefix} cần chọn từ 1 đến ${maxMcpToolNames} tool, hoặc dùng tất cả tool.`);
      }
      tools = [...new Set(entry.tools.map((name) => readText(name, 128, `Tên tool của MCP server ${prefix}`)))];
    }
    return { prefix, url, ...(tools ? { tools } : {}), ...(apiKeyEnv ? { apiKeyEnv } : {}), ...timeout };
  });
}

export function readModel(config) {
  if (config?.provider === 'demo') return { provider: 'demo', reasoningEffort: 'default' };
  if (!config || !Object.hasOwn(modelProviders, config.provider)) throw new RequestError(400, 'Chọn nhà cung cấp model hợp lệ.');

  const { provider } = config;
  const settings = modelProviders[provider];
  const model = readText(config.model, 200, 'Mã model');
  const reasoningEffort = config.reasoningEffort ?? 'default';
  if (!settings.efforts.includes(reasoningEffort)) throw new RequestError(400, 'Mức suy nghĩ không hợp lệ cho nhà cung cấp này.');
  const apiKeyEnv = keyEnvironment(config.apiKeyEnv) ?? settings.apiKeyEnv;
  let baseUrl;
  if (settings.customEndpoint) {
    const url = readUrl(config.baseUrl || settings.endpoint);
    if (url.search) throw new RequestError(400, 'Base URL của model không được chứa query string.');
    baseUrl = url.href.replace(/\/+$/, '');
  }
  return { provider, model, baseUrl, apiKeyEnv, reasoningEffort };
}

export function readProfile(profile, toolCatalog, environment, credentialValues = new Map()) {
  if (!profile || typeof profile !== 'object') throw new RequestError(400, 'Cấu hình agent không hợp lệ.');
  const id = readId(profile.id, 'Mã agent');
  const name = readText(profile.name, 80, 'Tên agent');
  const systemPrompt = readText(profile.systemPrompt, 10_000, 'System prompt');
  const entries = createTools(profile.tools, toolCatalog, environment, credentialValues);
  const mcpServers = readMcpServers(profile.mcpServers);
  return {
    config: { id, name, systemPrompt, tools: entries.map(({ config }) => config),
      ...(mcpServers.length ? { mcpServers } : {}),
      ...(profile.model ? { model: readModel(profile.model) } : {}),
      ...(profile.execution !== undefined ? { execution: readExecution(profile.execution) } : {}),
    },
    tools: entries.map(({ tool }) => tool),
  };
}

export function modelAdapter(settings, environment, legacyOpenAI, storedKey) {
  if (settings.provider === 'demo') return demoModel;
  const apiKey = storedKey ?? (settings.apiKeyEnv ? environment[settings.apiKeyEnv]
    : settings.provider === 'openai' ? legacyOpenAI : undefined);
  if (settings.apiKeyEnv && !apiKey?.trim()) {
    throw new RequestError(400, `Chưa có API key. Nhập key trong tab Model hoặc đặt biến ${settings.apiKeyEnv} cho dịch vụ đã triển khai.`);
  }
  try {
    return createModel({ ...settings, apiKey });
  } catch (error) {
    throw new RequestError(400, error.message);
  }
}
