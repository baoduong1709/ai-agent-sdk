// Creates (or replaces) the agent "mymadison-assistant" in agent Studio (http://127.0.0.1:4173) from the MyMadison chat
// box's own tools, served by the dev-only tool gateway of the SDK worktree backend (mymadison-sdk-backend, port 4000,
// AI_TOOL_GATEWAY=true). Run again after the backend's tools or prompt change:
//   node .claude/mymadison-studio-profile.mjs
// The model key is read by Studio from AI_CENTER_API_KEY in .env; this script never handles a key.
const GATEWAY = 'http://127.0.0.1:4000/api/v1/ai/tools';
const STUDIO = 'http://127.0.0.1:4173';
const PROFILE_ID = 'mymadison-assistant';
const MAX_TOOLS = 48;
// Studio refuses request bodies over 64,000 bytes, and "Thử agent" sends the whole profile with every message
const MAX_PROFILE_BYTES = 60_000;
// Dropped first when the agent has too many tools or bytes: admin tools rarely needed to try the chat
const DROP_ORDER = [
  'set_role_permission', 'set_user_roles', 'manage_position', 'send_leave_month_reminder', 'send_meal_reminder',
  'manage_assistant_document', 'list_assistant_documents', 'manage_department_member', 'manage_project_member',
  'manage_presale_member', 'delete_presale', 'add_presale_update', 'delete_employee', 'set_holiday', 'manage_department',
];

const PREAMBLE = `CHẠY TRONG AGENT STUDIO (bản thử của khung chat My Madison)
- Tin nhắn người dùng là câu hỏi thuần, không phải JSON: đó là currentMessage. asker, companyRules, today lấy bằng tool get_chat_context: gọi nó trước tiên ở lượt đầu của phiên (cùng lượt với tool khác nếu cần), rồi dùng như mục ĐẦU VÀO bên dưới.
- Giao diện ở đây không có thẻ, bảng hay nút: nêu số liệu cần thiết bằng chữ, ngắn gọn.
- Tool chuẩn bị trả {draft, note}: chỉ là bản nháp, chưa làm gì. Tóm tắt bản nháp và cảnh báo (nếu có), nói rằng muốn thực hiện thì xác nhận trên khung chat My Madison.

`;

const CONTEXT_TOOL = {
  name: 'get_chat_context',
  description: 'Ngữ cảnh khung chat My Madison của người đang đăng nhập: asker (người hỏi, quản lý, team), companyRules '
    + '(cấu hình HR hiện hành) và today (giờ Việt Nam, lịch tuần này và tuần sau). Gọi trước khi trả lời câu đầu tiên.',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
};

async function readJson(response) {
  const text = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status} ${response.url}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

const { instruction, tools: declared } = await readJson(await fetch(GATEWAY));
const httpTool = ({ name, description, parameters }) => ({
  kind: 'http', name, label: name.replaceAll('_', ' ').slice(0, 80), description: description.slice(0, 1500),
  method: 'POST', url: `${GATEWAY}/${name}`, parameters, timeoutMs: 30_000,
});

let tools = [CONTEXT_TOOL, ...declared].map(httpTool);
const profile = () => ({
  id: PROFILE_ID,
  name: 'MyMadison · Trợ lý (SDK)',
  systemPrompt: PREAMBLE + instruction,
  tools,
  model: {
    provider: 'compatible', model: 'claude/claude-sonnet-5-5', baseUrl: 'https://ai-center.madlab.tech/v1',
    apiKeyEnv: 'AI_CENTER_API_KEY', reasoningEffort: 'default',
  },
  execution: { maxSteps: 8, maxToolCalls: 12, timeoutMs: 180_000 },
});
const bytes = () => Buffer.byteLength(JSON.stringify(profile()));
const dropped = [];
for (const name of DROP_ORDER) {
  if (tools.length <= MAX_TOOLS && bytes() <= MAX_PROFILE_BYTES) break;
  if (tools.some((tool) => tool.name === name)) {
    tools = tools.filter((tool) => tool.name !== name);
    dropped.push(name);
  }
}
if (tools.length > MAX_TOOLS || bytes() > MAX_PROFILE_BYTES) {
  throw new Error(`Still too large: ${tools.length} tools, ${bytes()} bytes`);
}
if (profile().systemPrompt.length > 10_000) throw new Error('System prompt over 10,000 characters');

const saved = await readJson(await fetch(`${STUDIO}/api/profiles`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(profile()),
}));
const workspace = await readJson(await fetch(`${STUDIO}/api/workspace`));
console.log(JSON.stringify({
  saved: saved.id, tools: saved.tools.length, profileBytes: bytes(), promptChars: saved.systemPrompt.length, dropped,
  modelKey: workspace.credentials?.[saved.id]?.model ?? null,
}, null, 2));
