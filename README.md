# Agent Studio SDK

Phần lõi AI agent viết bằng TypeScript và chạy trên Node.js. Tạo một agent bằng system prompt và danh sách tool, sau đó gọi trực tiếp từ backend Node.js hoặc qua HTTP.

## Chạy giao diện

Yêu cầu Node.js 22.13 trở lên. Trong thư mục dự án, chạy:

```powershell
npm ci
npm start
```

Mở [Agent Studio](http://127.0.0.1:4173) và chọn agent mẫu hoặc bấm **Tạo agent mới**.

Trong **Thiết lập**, nhập tên và system prompt. Trong **Tool**, bấm **Thêm tool**, chọn từ danh mục backend hoặc khai báo **HTTP API** bằng endpoint, phương thức và JSON Schema. Có thể sửa hoặc xóa từng tool khỏi agent đang chọn. Tên hiển thị và mô tả của tool backend có thể tùy chỉnh theo agent. Schema và hàm thực thi của tool backend nằm trong mã đăng ký. Với tool HTTP, `GET` chuyển tham số thành query string và các phương thức còn lại gửi JSON. Nếu cần xác thực, nhập trực tiếp **Bearer token** trong hộp thoại tool.

Cũng trong **Tool**, mục **MCP server** cho agent dùng tool của một [MCP server](https://modelcontextprotocol.io) có sẵn mà không phải khai báo lại từng tool. Bấm **Thêm MCP server**, nhập tiền tố tên tool, endpoint Streamable HTTP và Bearer token nếu server yêu cầu, rồi bấm **Tải danh sách tool** để kết nối thử. Chọn từng tool cho agent hoặc đánh dấu **Dùng tất cả tool của server, kể cả tool thêm sau**. Trong agent, tên tool gồm tiền tố, dấu `_` và tên trên server, ví dụ `jira_search_issues`. Danh sách không hiện tool chỉ dành cho giao diện MCP App, và ghi rõ lý do với tool có schema mà SDK không dùng được. Token được mã hóa như API key của model và chỉ gửi tới đúng endpoint đã nhập, nên khi đổi endpoint cần nhập lại token. Mỗi agent có tối đa 10 MCP server và 128 tool tính cả tool MCP. Nếu tên tool MCP trùng với tool khác của agent, lượt chạy báo lỗi để đổi tiền tố. Khi thử agent, Studio kết nối tới server ở lượt chạy đầu tiên, giữ kết nối cho các lượt sau và thêm hướng dẫn sử dụng mà server cung cấp vào system prompt. Kết nối không dùng trong 10 phút sẽ được đóng.

Trong **Model**, chọn nhà cung cấp, nhập đúng mã model và điền **API key** nếu cần. Studio hỗ trợ **Ollama**, **LM Studio**, **OpenAI**, **Anthropic**, **Google Gemini**, **OpenRouter**, **Groq** và endpoint **OpenAI-compatible**. Có thể thử ngay bằng key vừa nhập. Khi bấm **Lưu cấu hình**, Studio mã hóa key và token ở kho dữ liệu cục bộ. Dùng **Xóa key** hoặc **Xóa token** để gỡ giá trị đã lưu. Với Ollama hoặc LM Studio, chạy máy chủ model trước khi thử. Base URL của Ollama mặc định là `http://127.0.0.1:11434` và của LM Studio là `http://127.0.0.1:1234/v1`.

Chọn **Mức suy nghĩ** cho từng agent. Các mức như Thấp, Trung bình, Cao được chuyển sang tham số tương ứng của nhà cung cấp. Claude cần model hỗ trợ adaptive thinking. Ollama cho phép cấu hình cấp độ với model như GPT-OSS và bật/tắt với model hỗ trợ công tắc. LM Studio dùng mức đã cấu hình trong model. Nếu model từ chối mức đã chọn, đặt lại **Mặc định của model**.

Bấm **Lưu cấu hình** để áp dụng cho các lượt gọi qua HTTP. **Thử agent** dùng bản đang chỉnh sửa. **Nhật ký tool** hiển thị tên tool, bước chạy, thời gian và trạng thái. Profile và hội thoại được lưu trong `.agent-studio/workspace.json`. **Demo** chạy các kịch bản mẫu với đơn `DH123`, `DH456` và chính sách. Để kiểm thử prompt và tool HTTP, chọn một model khác.

Trong hộp thoại tool, đánh dấu **Hỏi người dùng trước khi chạy** cho tool ghi dữ liệu hoặc gửi đi. Khi model gọi tool đó, **Thử agent** hiện thẻ với tham số model đưa ra, ô lý do và hai nút **Duyệt**, **Từ chối**. Gửi tin nhắn mới thay vì trả lời thì lời gọi đó không chạy. Bấm biểu tượng kẹp giấy hoặc dán ảnh vào ô nhập để gửi kèm ảnh hoặc PDF; có thể gửi tệp mà không cần nhập chữ. Model đã chọn phải đọc được loại tệp đó.

Trong **Thực thi**, đặt số lần gọi model, số lần gọi tool và thời hạn cho từng agent. Có thể đặt thời hạn riêng trong hộp thoại tạo hoặc sửa tool. Khi một tool hết thời hạn, model nhận lỗi `tool_timeout` và có thể chọn hướng khác trong ngân sách còn lại. **Thử agent** hiện bước model hoặc tool đang chạy. Bấm **Dừng lượt** để dừng các bước tiếp theo và gửi tín hiệu hủy cho thao tác đang chờ.

## Build app để triển khai

Chọn agent, bấm **Build app** rồi bấm **Build và tải ZIP**. Studio lưu cấu hình đang chỉnh trước khi đóng gói. ZIP chứa app Node.js độc lập, `agent.json`, mẫu `.env`, hướng dẫn triển khai và Dockerfile. Với key và token nhập trong Studio, gói chỉ chứa tên biến tương ứng để đặt trong mục biến môi trường hoặc secrets của nền tảng triển khai. Token của MCP server dùng biến dạng `MCP_<TIỀN_TỐ>_<mã>_TOKEN`, và app không khởi động khi biến này trống. Nếu tool Node.js trong danh mục dùng tệp dữ liệu bên ngoài hoặc thư viện native, mang các thành phần đó theo khi triển khai.

Giải nén gói trên máy có Node.js 22.13 trở lên, cấu hình `.env` theo mẫu trong ZIP và chạy `npm start`. App mặc định nghe tại `127.0.0.1:8080`. Khi mở dịch vụ ngoài localhost, đặt `AGENT_API_KEY` hoặc cấu hình `AGENT_CLIENT_KEYS` để cấp key riêng cho từng ứng dụng. Backend gọi `POST /api/run` với `appId`, `sessionId`, `message` và Bearer token đã cấu hình. `GET /health` kiểm tra app đã khởi động. Mỗi `appId` có lịch sử riêng. Gửi kèm `attachments` là mảng `{ name, mediaType, data }` với `data` dạng base64 để model đọc ảnh hoặc PDF. Khi kết quả có `status: 'interrupted'`, gọi `POST /api/run/resume` với cùng `appId`, `sessionId` và `approvals: [{ id, approved, reason? }]` để tiếp tục lượt chạy; chỉ ứng dụng đã bắt đầu lượt đó tiếp tục được.

App cũng nhận giao thức [AG-UI](https://docs.ag-ui.com) tại `POST /api/ag-ui`, nên giao diện chat dùng AG-UI như CopilotKit kết nối được trực tiếp. App dùng `threadId` làm mã phiên và chỉ đọc tin nhắn cuối của người dùng, vì lịch sử đã lưu trong phiên. `forwardedProps.appId` chọn ứng dụng, mặc định là `ag-ui`, và Bearer token vẫn bắt buộc như `/api/run`. Phản hồi là server-sent events: văn bản stream theo từng lần gọi model, lời gọi tool kèm tham số, còn kết quả tool chỉ báo thành công hay lỗi. Form đến qua sự kiện `CUSTOM` tên `agent-studio-sdk/form`, và các form đang chờ người dùng nằm trong `STATE_SNAPSHOT` ở khóa `forms`. Backend Node.js tự dựng endpoint AG-UI bằng `readAgUiInput`, `createAgUiEncoder` và `agUiServerSentEvent` của SDK.

Để phát hành cấu hình mới, build lại và triển khai ZIP mới. Giữ cùng đường dẫn dữ liệu `AGENT_DATA_PATH` nếu cập nhật một bản triển khai và cần tiếp tục các phiên hiện có. Với Docker, dùng volume `/data` cho dữ liệu phiên.

**Xóa agent** trong Studio sẽ xóa cấu hình và hội thoại gắn với agent đó trong Studio. Gói đã tải chạy như một dịch vụ độc lập.

## Gọi một agent đã lưu qua HTTP

Mở **Tích hợp SDK** để lấy URL theo ID của agent. API Studio phục vụ trên `127.0.0.1`. Ví dụ gọi từ PowerShell:

```powershell
$body = @{
  appId = 'checkout'
  sessionId = 'support-123'
  message = 'Kiểm tra đơn DH123'
} | ConvertTo-Json

Invoke-RestMethod 'http://127.0.0.1:4173/api/agents/order-support/run' `
  -Method Post -ContentType 'application/json; charset=utf-8' `
  -Body ([Text.Encoding]::UTF8.GetBytes($body))
```

API lấy model, mức suy nghĩ và tool từ cấu hình đã lưu của agent. Gửi cùng `appId` và `sessionId` để tiếp tục hội thoại. Khi tool cần duyệt, kết quả có `status: 'interrupted'` và `interruptions`; trả lời qua `POST /api/agents/{id}/resume` với cùng `appId`, `sessionId` và `approvals`. Kết quả thành công gồm `status`, `text`, `trace`, `runId` và `durationMs`. Khi lượt chạy lỗi, `error` chứa mã lỗi và thông báo. Khi lượt chạy chạm giới hạn, `status` là `limit_reached`, `error.code` là `run_limit`, và `text` có câu trả lời từ dữ liệu đã thu được nếu model đưa ra được. Studio là môi trường một người dùng trên máy cục bộ. Nếu triển khai cho nhiều người dùng, tích hợp SDK trong backend của ứng dụng để truyền danh tính đã xác thực và áp dụng quyền của ứng dụng.

Để nhận tiến trình, gửi `Accept: application/x-ndjson` khi gọi agent. Mỗi dòng chứa một sự kiện JSON. `run.finished` mang kết quả cuối giống phản hồi JSON thông thường. Gửi `requestId` duy nhất trong body của lượt chạy để có thể dừng qua `POST /api/run/cancel` với body `{ "requestId": "..." }`. Chờ sự kiện `run.queued` trước khi gửi yêu cầu dừng.

## Nhúng SDK vào backend Node.js

Chạy `npm pack` để tạo gói `.tgz` và cài gói đó trong ứng dụng Node.js. Gói xuất JavaScript và khai báo kiểu TypeScript. Ví dụ:

```ts
import { createSDK, defineTool } from 'agent-studio-sdk';
import { createModel } from 'agent-studio-sdk/models';

const getOrder = defineTool<{ orderId: string }>({
  name: 'get_order_status',
  description: 'Tra trạng thái đơn hàng theo mã đơn.',
  parameters: {
    type: 'object',
    properties: { orderId: { type: 'string' } },
    required: ['orderId'],
    additionalProperties: false,
  },
  authorize: ({ orderId }, { tenantId, userId }) => orders.canRead(orderId, { tenantId, userId }),
  execute: ({ orderId }, { tenantId, signal }) => orders.getStatus(orderId, { tenantId, signal }),
});

const sdk = createSDK({
  model: createModel({ provider: 'openai', apiKey: config.openAIKey, model: config.openAIModel, reasoningEffort: 'low' }),
  tools: [getOrder],
});

const agent = sdk.createAgent({
  id: 'order-support',
  systemPrompt: 'Bạn hỗ trợ đơn hàng. Tra cứu qua tool trước khi trả lời.',
  tools: ['get_order_status'],
});

const result = await agent.run({
  message: 'Kiểm tra đơn DH123',
  sessionId,
  context: { appId: 'checkout', tenantId, userId },
});
```

**Backend biên dịch sang CommonJS.** Gói là ES module nhưng nạp được bằng `require()` trên Node.js 22.13 trở lên. Vì vậy dự án TypeScript dùng `"module": "commonjs"`, như NestJS hoặc ts-node, vẫn viết `import` như ví dụ trên mà không phải chuyển sang ES module. TypeScript với cách tìm module mặc định của `commonjs` tìm được kiểu của cả các đường dẫn con `agent-studio-sdk/models`, `agent-studio-sdk/openai`, `agent-studio-sdk/http-tool` và `agent-studio-sdk/mcp`. `require()` và `import` dùng chung một bản module, nên `ToolError` ném từ code CommonJS vẫn được SDK nhận đúng mã lỗi.

`agent.addTool(tool)`, `agent.updateTool(name, tool)` và `agent.removeTool(name)` thay đổi danh sách của chính agent, có hiệu lực ở lượt chạy tiếp theo. `agent.listTools()` trả mô tả và schema hiện tại. Dùng `defineHttpTool` từ `agent-studio-sdk/http-tool` để tạo tool HTTP. Đặt `model: createModel({ ... })` khi gọi `sdk.createAgent` nếu agent cần cấu hình riêng. Dùng lại `id` và `sessionId` để tiếp tục hội thoại khi tạo lại agent với model khác.

`orders`, `config` và các giá trị định danh đến từ ứng dụng. SDK kiểm tra tool có nằm trong danh sách của agent, xác thực tham số theo JSON Schema và gọi `authorize` nếu tool khai báo hàm này. Chỉ lấy danh tính từ backend đã xác thực. Tool có thao tác ghi nên tự kiểm soát thực thi trùng theo quy tắc nghiệp vụ của ứng dụng.

Schema tham số dùng được `format` chuẩn như `email`, `date-time`, `uri` hoặc `uuid`, và SDK kiểm tra các format này. Các chú thích kiểu OpenAPI như `example`, `externalDocs`, `xml`, `discriminator` và khóa mở rộng `x-*` được chấp nhận nhưng không ảnh hưởng đến việc kiểm tra. Từ khóa viết sai như `requried` vẫn bị từ chối: `defineTool` ném `TypeError` kèm tên tool.

Model thường gửi `null` cho tham số tùy chọn mà nó muốn bỏ trống. Khi tham số không qua schema, SDK bỏ các giá trị `null` của thuộc tính cấp đầu đã khai báo và không nằm trong `required`, rồi kiểm tra lại một lần. Nếu lần này hợp lệ, `beforeTool`, `authorize` và `execute` nhận tham số đã bỏ các khóa đó. `afterTool` vẫn nhận tham số gốc của model. Schema chấp nhận `null`, ví dụ `{ type: ['string', 'null'] }`, giữ nguyên giá trị `null`. `null` của thuộc tính bắt buộc, của thuộc tính lồng bên trong hoặc của khóa không khai báo vẫn trả `invalid_arguments`.

**Schema kết quả và form.** `result` trong `defineTool()` là JSON Schema của giá trị `execute` trả về. Kết quả không khớp trả lỗi `invalid_result` cho model. `forms` khai báo các form theo tên, mỗi form gồm `html`, `submit`, và tùy chọn `schema` cho giá trị gửi lên cùng `timeoutMs`. Khóa `x-form` trong `result` chọn form mà khung chat hiện cho từng kết quả:

```js
const proposeLeave = defineTool({
  name: 'propose_leave',
  description: 'Soạn đơn nghỉ phép để người dùng kiểm tra rồi gửi.',
  parameters: { type: 'object', properties: { date: { type: 'string', format: 'date' } }, required: ['date'] },
  result: {
    type: 'object',
    oneOf: [
      { 'x-form': 'confirm', properties: { kind: { const: 'draft' } }, required: ['kind'] },
      { 'x-form': 'resolve', properties: { kind: { const: 'conflict' } }, required: ['kind'] },
      { properties: { kind: { const: 'info' } }, required: ['kind'] },
    ],
  },
  forms: {
    confirm: { html: confirmHtml, submit: (values, { formId, data }) => leaves.submit(formId, values, data) },
    resolve: { html: conflictHtml, submit: (values, { formId, data }) => leaves.resolve(formId, values, data) },
  },
  execute: ({ date }, context) => leaves.propose(date, context),
});
```

- Schema không có nhánh `oneOf`/`anyOf` trực tiếp: đặt `x-form` ở gốc, mọi kết quả hiện cùng một form.
- Schema có nhánh: đặt `x-form` trên từng nhánh. Kết quả khớp nhánh đầu tiên nào thì hiện form của nhánh đó. Nhánh không có `x-form` không hiện form.
- `defineTool` ném `TypeError` khi `x-form` nằm ở chỗ khác, gọi tên không có trong `forms`, hoặc có form không được `x-form` nào gọi.

Form chỉ hiện ở lượt chạy có lưu lịch sử. Khi đó kết quả tool gửi cho model có thêm `form` là tên form, để model chỉ người dùng tới form thay vì hỏi xác nhận bằng lời. Ứng dụng gửi giá trị người dùng nhập qua `agent.submitForm({ sessionId, context, formId, values })`. SDK gọi `submit` của form đó với `formId`, `form`, `toolCallId` và `data` là kết quả tool lúc hiện form. Với `defineHttpTool`, `submit` là `{ url, method }` và endpoint nhận JSON `{ formId, form, values, data }` kèm header `Idempotency-Key` bằng `formId`.

**Form là MCP App.** Mỗi form trong `RunResult.forms` có `html` là một tài liệu MCP App hoàn chỉnh, kèm `uri` dạng `ui://tool/form` và `mimeType: 'text/html;profile=mcp-app'`. SDK bọc HTML của tool vào tài liệu này cùng một cầu nối nói giao thức JSON-RPC của MCP Apps qua `postMessage`. Vì vậy Studio và mọi khung chat hỗ trợ MCP Apps đều hiện được form trong iframe sandbox. Form nhận kết quả tool từ khung chat. Khi người dùng gửi, form gọi `tools/call` với tên `tool.form` và các giá trị đã nhập, khung chat chuyển lời gọi đó thành `agent.submitForm()`. Mã của form đọc `window.agentForm`, gồm `data`, `arguments`, `status`, `result`, `error`, `submit(values)` và `onChange(listener)`. Form tự xử lý sự kiện submit thì gọi `preventDefault()` rồi `agentForm.submit(values)`. Đặt `mcpApp: true` khi `html` đã là một tài liệu MCP App, ví dụ giao diện của một MCP server. Tài liệu đó được hiện nguyên trạng, tối đa 1 MB, không có `window.agentForm` và không khai báo `submit`.

Để bổ sung tool chạy hàm Node.js vào danh mục của Studio, thêm `{ label: 'Tên hiển thị', tool: getOrder }` vào `userTools` trong `studio/user-tools.js`. Khởi động lại Studio rồi thêm tool đó trong tab **Tool**.

SDK cho phép thay `ModelAdapter` và `SessionStore`. Kho mặc định lưu trong bộ nhớ. Để giữ hội thoại qua lần khởi động hoặc chia sẻ giữa nhiều tiến trình, cung cấp kho của ứng dụng. Backend phải điều phối các lượt đồng thời cùng phiên nếu chạy nhiều tiến trình. Mỗi lượt mặc định giới hạn 6 lần gọi model, 12 lần gọi tool và 45 giây cho phần gọi model và tool, bao gồm thời gian chờ lượt trước cùng phiên. Handler nhận `AbortSignal` để dừng tác vụ đang chờ.

**Lịch sử hội thoại.** Mỗi câu trả lời được lưu kèm các lần gọi tool phía sau nó: tên tool, tham số và kết quả đã rút gọn. Ở lượt sau, model đọc lại phần này nên trả lời được câu hỏi tiếp theo từ dữ liệu đã lấy mà không cần gọi lại tool. Kết quả của một lần gọi giữ tối đa khoảng 4.000 ký tự và cả lượt giữ tối đa 12.000 ký tự; mảng dài bị cắt bớt phần tử kèm ghi chú số phần tử bị bỏ. Đặt `history: false` trong `defineTool()` để không lưu kết quả của tool đó, ví dụ dữ liệu nhạy cảm; lượt sau model chỉ biết tool đã được gọi với tham số nào. `getHistory()` không trả về phần này, và trace vẫn không chứa tham số hay kết quả.

Hai tùy chọn của `createSDK()` giới hạn phần lịch sử model đọc:

| Tùy chọn | Mặc định | Ý nghĩa |
|---|---|---|
| `historyBudget` | 12.000 | Số token ước tính (khoảng 3 ký tự mỗi token) của lịch sử gửi cho model mỗi lần gọi, từ 1.000 đến 1.000.000. Khi vượt, SDK bỏ kết quả tool của các lượt cũ nhất trước. |
| `maxTurns` | 20 | Số lượt cũ tối đa model đọc nguyên văn. |

Khi phiên lưu trong `SessionStore` có nhiều lượt hơn `maxTurns`, hoặc vẫn vượt `historyBudget` sau khi đã bỏ hết kết quả tool, SDK gọi model một lần để tóm tắt các lượt cũ thay vì xóa chúng. Bản tóm tắt giữ mã, tên, ngày, số liệu, quyết định và việc còn dang dở. Nó được lưu thành tin nhắn đầu tiên với `summary: true`, kèm các form của những lượt đó còn đang mở để người dùng vẫn gửi được. Các lượt mới nhất được giữ nguyên văn, tối đa một nửa `maxTurns` và một nửa ngân sách. Lần gọi tóm tắt được tính vào `usage` và phát sự kiện `history.compacted`. Nếu tóm tắt lỗi, lượt chạy vẫn tiếp tục với lịch sử đã cắt theo ngân sách, kho không đổi và lượt sau thử lại. Kho giữ tối đa `maxTurns × 2` lượt để không phình mãi khi tóm tắt lỗi liên tục.

**Khi chạm giới hạn bước hoặc lời gọi tool.** Nếu model vẫn muốn gọi tool khi đã hết lượt, SDK bỏ qua các lời gọi đó và gọi model thêm một lần không cho dùng tool, kèm chỉ dẫn trả lời từ dữ liệu đã có và nói rõ phần chưa kiểm tra được. Lần gọi này được tính vào `usage.modelCalls` và vẫn chịu giới hạn thời gian của lượt. Kết quả giữ `status: 'limit_reached'` và `error.code: 'run_limit'` để ứng dụng biết câu trả lời có thể chưa đầy đủ, kèm `text` là câu trả lời đó; câu hỏi và câu trả lời được lưu vào lịch sử như lượt thường. Nếu lần gọi cuối lỗi, trả về câu trống hoặc vẫn đòi gọi tool, kết quả không có `text` và lịch sử không đổi. Lượt chạy trả lời xong trong giới hạn vẫn là `completed`. `ModelAdapter` tự viết nhận `toolChoice: 'none'` ở lần gọi cuối và nên chuyển thành thiết lập tắt tool của nhà cung cấp; các adapter có sẵn gửi `tool_choice: 'none'` (Chat Completions, OpenAI Responses), `tool_choice: { type: 'none' }` (Anthropic), `toolConfig.functionCallingConfig.mode: 'NONE'` (Gemini), hoặc bỏ danh sách tool (Ollama). Thiết lập này ghi đè `tool_choice` truyền qua `body`.

Truyền `onEvent` vào `agent.run()` để nhận sự kiện chờ, chạy, gọi model, gọi tool, tóm tắt lịch sử và kết thúc. Sự kiện tool chỉ chứa thông tin theo dõi như tên, thời gian và trạng thái. Truyền `beforeTool` khi tạo SDK để áp dụng chính sách của ứng dụng sau xác thực tham số và quyền của tool. Chỉ kết quả `true` mới cho phép gọi handler. Truyền `afterTool` để ghi nhật ký kết quả mỗi lần gọi tool; hook này không đổi được kết quả. Đặt `timeoutMs` trong `defineTool()` hoặc `defineHttpTool()` để giới hạn riêng cho tool. Handler cần truyền tiếp `AbortSignal` cho tác vụ I/O mà nó thực hiện. Việc dừng chỉ tác động lên thao tác còn đang chờ. Các thay đổi đã được hệ thống đích áp dụng cần xử lý theo nghiệp vụ của ứng dụng.

## Nhúng vào backend có sẵn

Các tùy chọn sau dành cho backend tự quản lý danh tính, lịch sử và giao diện của riêng mình.

**Lịch sử do ứng dụng cung cấp.** Truyền `history` vào `agent.run()` để dùng đúng danh sách tin nhắn mà ứng dụng đã chuẩn bị. Khi có `history`, SDK không đọc và không ghi `SessionStore`, nên ứng dụng tự chịu trách nhiệm lưu câu trả lời. Tin nhắn có thể kèm `tools` và `summary` như tin nhắn SDK tự lưu, và được kiểm tra trước khi dùng. SDK lấy tối đa `maxTurns × 2` tin nhắn gần nhất; khi vượt `historyBudget`, SDK bỏ kết quả tool rồi đến các lượt cũ nhất, không tóm tắt.

**Tool theo từng lượt.** Truyền `tools` vào `agent.run()` với danh sách tên hoặc tool để giới hạn lượt chạy đó theo quyền của người dùng đang gọi. Tool ngoài danh sách không xuất hiện trong phần khai báo gửi cho model. Dùng cách này thay cho `addTool`/`removeTool` khi nhiều người dùng chia sẻ một agent.

**Mã lỗi của tool.** Ném `ToolError(code, message)` trong handler để chọn mã lỗi mà model nhận được, ví dụ `not_found`, `forbidden` hoặc `unavailable`. Mã phải là chữ thường, số và dấu gạch dưới. Lỗi khác vẫn trả về `tool_failed` và không tiết lộ chi tiết nội bộ.

**Kết quả tool lớn.** Kết quả lớn hơn 64 KB không bị từ chối. Model nhận bản rút gọn còn khoảng 16.000 ký tự, giữ nguyên cấu trúc: chuỗi dài bị cắt, mảng dài chỉ giữ các phần tử đầu kèm ghi chú số phần tử bị bỏ. Kết quả này có `truncated: true` và không hiện thành form. Nếu một bước vượt cửa sổ context của model, SDK rút gọn mọi kết quả tool của lượt còn 2.000 ký tự, cắt lịch sử còn nửa `historyBudget` rồi gọi lại một lần.

Tool tạo bằng `defineHttpTool` tự đặt mã theo phản hồi của dịch vụ. Thông báo chỉ nêu mã HTTP và ý nghĩa, không chuyển nội dung phản hồi lỗi cho model:

| Mã | Khi nào |
|---|---|
| `invalid_request` | HTTP 400 hoặc 422 |
| `unauthorized` | HTTP 401 |
| `forbidden` | HTTP 403 |
| `not_found` | HTTP 404 hoặc 410 |
| `conflict` | HTTP 409 |
| `rate_limited` | HTTP 429 |
| `unavailable` | HTTP 408 hoặc 5xx, không kết nối được, mất kết nối khi đang đọc phản hồi, hoặc thiếu API key |
| `request_failed` | Các mã lỗi HTTP khác |
| `output_too_large` | Phản hồi lớn hơn 64 KB |
| `invalid_response` | Phản hồi khai báo JSON nhưng không phải JSON hợp lệ |

Hết thời gian hoặc bị hủy vẫn trả về `tool_timeout` hoặc `tool_cancelled`. Tool HTTP không tự thử lại vì request có thể đã thay đổi dữ liệu ở hệ thống đích. Handler tự viết gọi HTTP có thể dùng `httpStatusError(status)` từ `agent-studio-sdk/http-tool` để có cùng bảng mã.

**Tool tự viết câu trả lời.** Gọi `reply(text, data)` trên context của tool để kết thúc lượt bằng câu của ứng dụng, không gọi model thêm lần nữa. Kết quả có `status: 'completed'`, `text` là câu đã viết và `data` là dữ liệu kèm theo, ví dụ mã đề xuất để giao diện hiện nút xác nhận.

**Streaming.** Truyền `onDelta` vào `agent.run()` để nhận từng đoạn văn bản. Sự kiện `model.delta` cũng đi qua `onEvent`. Phần `<think>` của model suy luận bị loại khỏi cả `onDelta` và câu trả lời cuối. Mọi adapter có sẵn đều stream: Chat Completions, OpenAI Responses, Anthropic, Gemini và Ollama. Với `ModelAdapter` tự viết không có hàm `stream`, SDK dùng đường gọi thường và chỉ phát `model.finished`. Nếu nhà cung cấp trả nguyên câu trả lời cho request streaming, câu đó đến `onDelta` thành một đoạn.

**Token usage.** `RunResult.usage` tổng hợp `promptTokens`, `cachedTokens`, `completionTokens` và `modelCalls` của cả lượt.

**Gateway riêng.** `createModel` nhận `headers` và `body` để thêm header và field vào request, ví dụ `headers: { 'x-9router-token-saver': 'off' }` và `body: { temperature: 0.2, max_tokens: 4096 }`. SDK từ chối những tên mà chính nó đặt như `Authorization` hoặc `messages`.

**Lỗi từ nhà cung cấp và thử lại.** SDK tự thử lại khi không kết nối được hoặc khi nhà cung cấp trả HTTP 408, 429 hoặc 5xx. Mặc định có 2 lần thử lại; đặt `maxRetries` từ 0 đến 5 trong `createModel` hoặc `createOpenAIModel` để đổi số lần. Thời gian chờ theo header `Retry-After` nếu có, nếu không thì tăng dần có dao động ngẫu nhiên. Việc chờ dừng ngay khi lượt chạy bị hủy hoặc hết giờ. Nếu nhà cung cấp yêu cầu chờ quá 20 giây, SDK báo lỗi luôn thay vì giữ lượt chạy. Streaming chỉ thử lại trước khi nhận dữ liệu đầu tiên. `RunResult.error.code` cho biết nguyên nhân:

| Mã | Khi nào |
|---|---|
| `provider_unavailable` | Không kết nối được tới endpoint |
| `provider_auth` | HTTP 401 hoặc 403: API key sai hoặc thiếu quyền |
| `provider_not_found` | HTTP 404: sai tên model hoặc Base URL |
| `provider_rate_limited` | HTTP 429 sau khi đã thử lại |
| `provider_server_error` | HTTP 408 hoặc 5xx sau khi đã thử lại |
| `provider_rejected` | Các mã 4xx khác, thường do tham số request |
| `provider_truncated` | Câu trả lời bị cắt vì chạm giới hạn token đầu ra |
| `provider_context_exceeded` | Yêu cầu vượt cửa sổ context của model (HTTP 400/413/422 có thông báo tràn context, hoặc Anthropic `model_context_window_exceeded`). SDK đã thử gọi lại một lần với kết quả tool rút gọn còn 2.000 ký tự và lịch sử cắt còn nửa ngân sách |
| `provider_content_filtered` | Nhà cung cấp chặn câu trả lời theo chính sách nội dung |
| `provider_incomplete` | Luồng hoặc phản hồi kết thúc khi chưa trả lời xong |
| `provider_stream_response` | Nhà cung cấp trả luồng sự kiện cho request không streaming |

`ModelError` mà adapter ném ra có thêm `status` là mã HTTP của nhà cung cấp.

**Câu trả lời bị cắt.** SDK đọc lý do dừng của từng nhà cung cấp và coi câu trả lời là bị cắt khi gặp các giá trị sau:

| Nhà cung cấp | Lý do dừng được coi là bị cắt |
|---|---|
| Chat Completions | `finish_reason: 'length'` |
| Anthropic | `stop_reason: 'max_tokens'` |
| Ollama | `done_reason: 'length'` |
| Gemini | `finishReason: 'MAX_TOKENS'` |
| OpenAI Responses | `incomplete_details.reason: 'max_output_tokens'` |

Khi đó SDK gọi lại model một lần, kèm lời nhắc trả lời ngắn hơn. Nếu lần gọi lại vẫn bị cắt, lượt chạy kết thúc với `provider_truncated`, và phần trả lời dở dang không được lưu vào lịch sử. Để nâng giới hạn, truyền qua `body`, ví dụ `body: { max_tokens: 16384 }` cho Anthropic hoặc Chat Completions, `body: { max_output_tokens: 8000 }` cho OpenAI Responses, `body: { options: { num_predict: 4096 } }` cho Ollama.

**Prompt caching.** Với Anthropic, `createModel` đánh dấu danh sách tool, system prompt và cuối hội thoại làm điểm cache, nên các bước sau của lượt và lượt tiếp theo đọc lại phần đầu từ cache. Đặt `promptCaching: false` để tắt. OpenAI, Gemini và các nhà cung cấp khác tự cache phần đầu prompt. Số token đọc từ cache nằm ở `usage.cachedTokens`.

## Duyệt tool, guardrail, tracing và tệp đính kèm

### Hỏi người dùng trước khi chạy tool

Đặt `approval` trong `defineTool()` hoặc `defineHttpTool()` cho tool ghi dữ liệu hoặc gửi đi. `true` hỏi ở mọi lần gọi. Hàm `(args, context) => boolean` quyết định theo tham số đã xác thực. Hàm ném lỗi cũng được tính là cần hỏi.

```ts
const cancelOrder = defineTool<{ orderId: string }>({
  name: 'cancel_order',
  description: 'Hủy đơn hàng.',
  parameters: { type: 'object', properties: { orderId: { type: 'string' } }, required: ['orderId'] },
  approval: ({ orderId }, { tenantId }) => orders.isPaid(orderId, tenantId),
  execute: ({ orderId }, context) => orders.cancel(orderId, context),
});

const result = await agent.run({ message, sessionId, context });
if (result.status === 'interrupted') {
  // result.interruptions: [{ id, tool, toolCallId, arguments }]
  const next = await agent.resume({
    sessionId, context,
    approvals: [{ id: result.interruptions[0].id, approved: false, reason: 'Khách đổi ý' }],
  });
}
```

1. `authorize` và `beforeTool` chạy trước khi hỏi. Nếu tool cần duyệt, lượt chạy dừng với `status: 'interrupted'`, liệt kê các lời gọi cần duyệt trong `interruptions` và phát sự kiện `tool.approval`.
2. `agent.resume()` trả lời bằng `id` của từng lời gọi. Có thể trả lời một phần; khi đó kết quả vẫn là `interrupted` với các lời gọi còn chờ. Lượt chạy tiếp tục khi mọi lời gọi đã có câu trả lời.
3. Lời gọi được duyệt qua lại `authorize` và `beforeTool` rồi chạy mà không hỏi lại. Lời gọi bị từ chối trả lỗi `tool_rejected` cho model, kèm `reason` nếu có (tối đa 500 ký tự), và model trả lời tiếp.

`resume` chỉ tiếp tục lượt của đúng `appId`, `tenantId`, `userId`, agent và `sessionId` đã bắt đầu nó. Mã lỗi:

| Mã | Khi nào |
|---|---|
| `approval_not_found` | Phiên không có lời gọi đang chờ, hoặc `id` không thuộc phiên này |
| `approval_decided` | Lời gọi đã được trả lời trước đó |
| `invalid_approvals` | Một `id` được trả lời hai lần |
| `approval_unavailable` | Lượt chạy truyền `history` nên không lưu được trạng thái chờ; tool trả lỗi này cho model thay vì hỏi |

Nếu người dùng gửi tin nhắn mới thay vì trả lời, lượt đang chờ được đóng lại và các lời gọi đó không chạy. Trong `getHistory()`, tin nhắn của lượt đang chờ có `approvals` với trạng thái `pending`. Câu trả lời của lượt mang các lời gọi đã chốt với `approved`, `denied` hoặc `expired`. Qua AG-UI, lời gọi cần duyệt đến bằng sự kiện `CUSTOM` tên `agent-studio-sdk/approval`, nằm trong `STATE_SNAPSHOT` ở khóa `approvals`, và `RUN_FINISHED` có `status: 'interrupted'`.

### Chạy song song tool chỉ đọc

Đặt `readOnly: true` cho tool chỉ đọc dữ liệu. Khi model gọi liên tiếp nhiều tool chỉ đọc trong cùng một bước, SDK chạy chúng cùng lúc. Các lời gọi khác chạy lần lượt theo thứ tự model đưa ra. Kết quả gửi lại cho model vẫn giữ đúng thứ tự gọi. Tool của `connectMcp` có `readOnlyHint` được đánh dấu chỉ đọc. Server tự khai báo chú thích này và SDK không kiểm chứng, nên nó chỉ ảnh hưởng thứ tự chạy, không thay cho kiểm soát quyền.

### Guardrail

Guardrail kiểm tra tin nhắn của người dùng trước khi lưu hoặc gửi cho model (`input`), và câu trả lời cuối trước khi lưu và trả về (`output`). Khai báo trong `createSDK({ guardrails })` cho mọi agent hoặc `sdk.createAgent({ guardrails })` cho một agent; guardrail của agent chạy sau guardrail của SDK.

```ts
import { blockPromptInjection, maskPII } from 'agent-studio-sdk';

const sdk = createSDK({
  model, tools,
  guardrails: {
    input: [blockPromptInjection({ reply: 'Mình không thể làm theo yêu cầu đó.' }), maskPII()],
    output: maskPII(),
  },
});
```

Mỗi guardrail nhận `stage`, `text`, `attachments` (chỉ ở `input`, không có nội dung tệp), `agentId`, `sessionId`, `context` và `signal`. Các guardrail chạy theo thứ tự, mỗi cái đọc văn bản mà cái trước để lại:

| Trả về | Kết quả |
|---|---|
| `true` hoặc không trả gì | Cho qua |
| `{ allowed: true, text }` | Thay văn bản, ví dụ đã che dữ liệu cá nhân |
| `false` hoặc `{ allowed: false, reason?, reply? }` | Chặn. `reply` là câu người dùng đọc thay thế |

Khi bị chặn, kết quả có `status: 'blocked'`, `stage`, `text` là `reply` nếu có, và `error.code` là `input_blocked` hoặc `output_blocked`. Tin nhắn bị chặn ở `input` không được lưu. Câu trả lời bị chặn ở `output` được thay bằng `reply` trong lịch sử, hoặc bằng một ghi chú nếu không có `reply`. Guardrail ném lỗi hoặc trả giá trị sai dạng cũng chặn, với mã `guardrail_failed`. Sự kiện `guardrail.triggered` báo guardrail đã chặn hay đã sửa văn bản.

- `maskPII({ email, phone, card })` thay email, số điện thoại và số thẻ hợp lệ theo Luhn bằng `[email]`, `[phone]` và `[card]`. Dùng ở `input` để model và lịch sử không thấy các giá trị này, hoặc ở `output` để che trong câu trả lời. `maskText` dùng cùng quy tắc cho nhật ký.
- `blockPromptInjection({ reply, patterns })` chặn các câu tìm cách ghi đè chỉ dẫn hoặc đọc system prompt, bằng tiếng Anh và tiếng Việt, không phân biệt dấu. Đây chỉ là lớp chặn đầu tiên; quyền truy cập dữ liệu vẫn cần `authorize` và `beforeTool`.

Agent có guardrail `output` không stream: `onDelta` không nhận đoạn văn bản nào, vì câu trả lời phải được kiểm tra trước khi người dùng đọc. Hiện `result.text` khi lượt chạy kết thúc.

### Tracing với OpenTelemetry

Truyền tracer của `@opentelemetry/api` vào `createSDK({ tracer })`. Span theo [quy ước ngữ nghĩa GenAI của OpenTelemetry](https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-spans/) phiên bản `1.41.0` (`genAiSemconvVersion`):

```ts
import { trace } from '@opentelemetry/api';
import { genAiSchemaUrl } from 'agent-studio-sdk';

const sdk = createSDK({ model, tools, tracer: trace.getTracer('order-support', '1.0.0', { schemaUrl: genAiSchemaUrl }) });
```

| Span | Loại | Thuộc tính chính |
|---|---|---|
| `invoke_agent {tên agent}` | internal | `gen_ai.agent.id`, `gen_ai.agent.name`, `gen_ai.conversation.id`, `gen_ai.provider.name`, `gen_ai.request.model`, tổng token của lượt |
| `chat {model}` | client | `gen_ai.provider.name`, `gen_ai.request.model`, `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`, `gen_ai.usage.cache_read.input_tokens` |
| `execute_tool {tên tool}` | internal | `gen_ai.tool.name`, `gen_ai.tool.call.id`, `gen_ai.tool.type`, `gen_ai.tool.description` |

Span lỗi có `error.type` là mã lỗi, ví dụ `tool_timeout` hoặc `provider_rate_limited`. Span không ghi nội dung tin nhắn, tham số hay kết quả tool. Lỗi của tracer không làm hỏng lượt chạy. Quy ước GenAI vẫn đang ở giai đoạn phát triển, nên một số backend cần `OTEL_SEMCONV_STABILITY_OPT_IN=gen_ai_latest_experimental` để đọc đúng các thuộc tính này. `ModelAdapter` tự viết khai báo `provider` và `model` để có tên trong span.

### Gửi ảnh và PDF cùng tin nhắn

Truyền `attachments` vào `agent.run()`, ví dụ ảnh chụp giấy khám bệnh khi xin nghỉ phép. `message` có thể trống khi có tệp:

```ts
await agent.run({
  sessionId, context, message: 'Xin nghỉ ốm hôm nay',
  attachments: [{ name: 'giay-kham.jpg', mediaType: 'image/jpeg', data: base64 }],
});
```

- Nhận PNG, JPEG, GIF, WebP và PDF; tối đa 5 tệp, mỗi tệp 5 MB và tổng 10 MB (`attachmentLimits`, `attachmentTypes`). `data` là base64 hoặc data URL cùng loại. SDK kiểm tra phần đầu tệp có đúng loại đã khai báo không.
- Tệp sai loại, quá lớn hoặc nội dung không khớp trả `status: 'error'` với `invalid_attachment`. Model không đọc được loại tệp đó thì trả `attachments_unsupported`.
- Model chỉ đọc tệp trong lượt gửi nó. Lịch sử chỉ lưu `name`, `mediaType` và `size`, và `getHistory()` trả các thông tin này trong `attachments`. Lượt đang chờ duyệt tool giữ nội dung tệp cho đến khi lượt kết thúc, để model vẫn đọc được khi tiếp tục.

| Nhà cung cấp | Loại tệp model đọc được |
|---|---|
| Anthropic, OpenAI, Google Gemini, OpenRouter | Ảnh và PDF |
| Groq, LM Studio, OpenAI-compatible | Ảnh |
| Ollama | PNG và JPEG |

Model vẫn phải hỗ trợ đọc ảnh hoặc PDF. `ModelAdapter` tự viết khai báo `attachments` là danh sách loại tệp mà nó nhận.

## Dùng tool của MCP server

`connectMcp` từ `agent-studio-sdk/mcp` kết nối tới một [MCP server](https://modelcontextprotocol.io) qua Streamable HTTP và biến các tool của server thành tool của agent. Nhờ vậy agent dùng được các MCP server sẵn có như Jira, Google Drive hay cơ sở dữ liệu mà không cần viết lại từng tool:

```ts
import { connectMcp } from 'agent-studio-sdk/mcp';

const jira = await connectMcp({
  url: 'https://mcp.example.com/mcp',
  headers: async () => ({ Authorization: `Bearer ${await tokens.jira()}` }),
  prefix: 'jira',
  tools: ['search_issues', 'get_issue', 'create_issue'],
  timeoutMs: 20_000,
});

const sdk = createSDK({ model, tools: [...jira.tools] });
const reader = sdk.createAgent({ id: 'jira-reader', systemPrompt, tools: jira.select(['search_issues', 'get_issue']) });
const writer = sdk.createAgent({ id: 'jira-writer', systemPrompt, tools: jira.select((tool) => !tool.annotations?.readOnlyHint) });

// Khi tắt ứng dụng
await jira.close();
```

| Tùy chọn | Ý nghĩa |
|---|---|
| `url` | Endpoint MCP, ví dụ `https://mcp.example.com/mcp`. |
| `headers` | Header gửi kèm mọi request, ví dụ `Authorization`. Truyền hàm để SDK gọi lại mỗi lần và lấy token mới. |
| `prefix` | Tiền tố ghép với tên tool bằng `_`, ví dụ `jira_search_issues`, để tool của hai server không trùng tên. Tối đa 32 ký tự gồm chữ, số, `_` và `-`. |
| `tools` | Danh sách tên tool trên server, hoặc hàm nhận thông tin tool và trả `true` để giữ. Tên mà server không có làm `connectMcp` báo lỗi, để bắt lỗi gõ sai. |
| `timeoutMs` | Thời hạn của mỗi lần gọi tool, tối đa 300.000 ms. Không đặt thì tool dùng thời hạn của lượt chạy. |
| `connectTimeoutMs` | Thời hạn kết nối và lấy danh sách tool, mặc định 30.000 ms. |
| `apps` | `false` để không lấy giao diện MCP App của tool. Mặc định `true`. |
| `fetch` | Hàm `fetch` thay thế, ví dụ để đi qua proxy. |

**Lọc tool theo agent.** `connection.tools` là các tool sau khi lọc bằng tùy chọn `tools`. `connection.select(filter)` trả phần tool cho một agent, nhận tên trên server (không có tiền tố) hoặc hàm lọc. Tên không có trong kết nối làm `select` ném `TypeError`; nếu tool bị bỏ qua, thông báo nêu lý do. Hàm lọc nhận `name`, `title`, `description`, `inputSchema`, `annotations` và `app`. Các chú thích như `readOnlyHint` hay `destructiveHint` do server tự khai báo và SDK không kiểm chứng. Vì vậy quyền ghi vẫn cần kiểm soát bằng `beforeTool`, `authorize` hoặc `tools` theo từng lượt chạy.

**Thông tin kết nối.** `connection.server` gồm `name`, `version`, `title`, `protocolVersion` và `instructions`. Nên thêm `instructions` vào system prompt của agent dùng các tool này, vì server mô tả ở đó cách dùng tool hiệu quả. `connection.skipped` liệt kê tool không dùng được cùng lý do: thiếu tên, tên dài quá 64 ký tự sau khi ghép tiền tố, trùng tên, hoặc schema tham số không hợp lệ. Tool chỉ dành cho giao diện MCP App, tức `_meta.ui.visibility` không có `model`, bị ẩn khỏi model và không nằm trong danh sách này. `connection.refresh()` lấy lại danh sách tool khi server thay đổi; agent đã tạo vẫn giữ tool cũ.

**Kết quả tool.** Model nhận `structuredContent` nếu server có trả về. Nếu không, model nhận phần văn bản nối lại. Nội dung nhị phân như ảnh và âm thanh được thay bằng mô tả loại nội dung, không gửi cho model. Tool có giao diện MCP App trên server (`_meta.ui.resourceUri`) được gắn form `app` với `mcpApp: true`, nên khung chat hiện giao diện đó dưới câu trả lời. Studio hiện được giao diện này nhưng chưa chuyển lời gọi tool từ giao diện về MCP server.

**Mã lỗi.** Lỗi khi gọi tool được chuyển thành `ToolError` để model đọc được mã lỗi:

| Mã | Khi nào |
|---|---|
| `execution_error` | Server trả kết quả `isError`. Model nhận văn bản lỗi của server, tối đa 4.000 ký tự. |
| `invalid_request` | Lỗi JSON-RPC -32600 hoặc -32602, thường do tham số sai |
| `not_supported` | Lỗi JSON-RPC -32601, hoặc server dùng phiên bản giao thức mà SDK không hỗ trợ |
| `not_found` | Lỗi JSON-RPC -32002 |
| `unavailable` | Lỗi JSON-RPC -32603, không kết nối được, hoặc kết nối đã đóng |
| `request_failed` | Các mã lỗi JSON-RPC khác. Model nhận thông báo của server, tối đa 500 ký tự. |
| `output_too_large` | Phản hồi lớn hơn 4 MB |
| `invalid_response` | Phản hồi không đúng giao thức MCP |

Lỗi HTTP dùng cùng bảng mã với `defineHttpTool`, ví dụ `unauthorized` cho HTTP 401. Nếu kết nối ban đầu lỗi, `connectMcp` ném `Error` nêu địa chỉ server, kèm lỗi gốc trong `cause`; tùy chọn sai kiểu ném `TypeError`.

**Phiên và luồng.** SDK yêu cầu giao thức `2025-11-25` và chấp nhận `2025-06-18` hoặc `2025-03-26` nếu server chọn bản cũ hơn. SDK giữ `Mcp-Session-Id` mà server cấp. Nếu server báo phiên không còn (HTTP 404), SDK mở phiên mới và gửi lại request một lần. Phản hồi dạng SSE được đọc đến khi có câu trả lời. Nếu luồng đứt giữa chừng, SDK nối lại bằng `Last-Event-ID`, tối đa 3 lần. Khi lượt chạy bị hủy hoặc tool hết thời hạn, SDK gửi `notifications/cancelled` để server dừng việc đang làm. `close()` kết thúc phiên trên server; sau đó tool của kết nối trả lỗi `unavailable`. SDK chưa hỗ trợ transport stdio, các request server gửi ngược như sampling hoặc elicitation, và luồng OAuth. Với server cần OAuth, ứng dụng tự lấy token rồi truyền qua `headers`.

## Kiểm tra

```powershell
npm test
npm pack --dry-run
```
