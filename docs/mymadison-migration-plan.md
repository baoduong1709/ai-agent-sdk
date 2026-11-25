# Kế hoạch: thay agent của MyMadison bằng agent-studio-sdk

Ngày lập: 2026-11-17. SDK: `agent-studio-sdk` 0.1.0 (`D:\MADISON\ai-agent-sdk`). Đích: `D:\MADISON\MyMadison\backend\src\ai`.

Kế hoạch này chưa sửa gì trong MyMadison. Mỗi giai đoạn chạm vào MyMadison cần đại nhân đồng ý trước.

## Tóm tắt

- **Thay hai phần:**
  - vòng lặp model/tool trong `AiOrchestratorService.processUserMessage`;
  - `InternalAiProvider`, thay bằng `createSDK` cùng `createModel({ provider: 'compatible' })`.
- **Giữ nguyên:**
  - API `POST /ai/chat`, gồm luồng NDJSON `delta`, `tool`, `done` và `error`;
  - tool registry, các handler và kiểm tra quyền;
  - form đề xuất (`aiAction` propose/confirm);
  - prompt, `compactHistory`, hàng đợi model và chat log;
  - eval và frontend.
- **Hai engine chạy song song** qua cờ `AI_ENGINE=legacy|sdk`. Mặc định vẫn là `legacy` cho tới khi eval của engine SDK đạt (giai đoạn 7). Code legacy chỉ được gỡ ở giai đoạn 8.
- **SDK cần sửa một chỗ bắt buộc (S1):** bỏ qua `null` ở tham số tùy chọn. Chỗ thứ hai (S2) chỉ làm nếu smoke test cho thấy cần.

## 1. Hiện trạng và đích

| Phần | Legacy (hiện tại) | Engine SDK |
|---|---|---|
| Vòng lặp | `ai-orchestrator.service.ts`: tối đa `maxRounds` 4 vòng, `maxCalls` 6 call | `createAgent({ maxSteps: 4, maxToolCalls: 6, timeoutMs: requestTimeoutMs })` |
| Provider | `providers/internal-ai.provider.ts` (openai 7.45.1, `maxRetries` 1, timeout 90 s mỗi lần gọi) | `createModel` compatible, bọc trong `instrumentedModel` (timeout 90 s mỗi lần gọi, thống kê, log) |
| Tool | `ToolRegistryService.executeTool`: quyền, class-validator, timeout 15 s, giới hạn 16000 ký tự | `defineTool` bọc quanh chính `registry.executeTool`; Ajv kiểm schema trước |
| Lỗi tool | `runTool` đổi lỗi thành `{error:'forbidden'}`…; lỗi lập trình ném ra ngoài | `ToolError` với cùng mã; lỗi lập trình dừng run và ném lại (D3) |
| Hết lượt | `stuckReply(voice)` | SDK gọi model thêm một lần không kèm tool; không có chữ thì `stuckReply` (D4) |
| Form / câu hỏi làm rõ | Xử lý trong vòng lặp | Trạng thái riêng của request truyền qua `context` và `ctx.reply` (D6, D7) |
| Lịch sử | Gói trong JSON đầu vào, không dùng history của provider | Như cũ: `history: []`, `sessionId = requestId` |

## 2. Quyết định thiết kế

### D1. Đóng gói SDK cho MyMadison

- **Đóng gói:**
  - Dùng tarball: `npm pack` trong `ai-agent-sdk`, chép file vào `MyMadison/backend/vendor/agent-studio-sdk-0.1.0.tgz`.
  - Khai báo `"agent-studio-sdk": "file:vendor/agent-studio-sdk-0.1.0.tgz"`.
  - Không dùng `file:../../ai-agent-sdk`: symlink trỏ ra ngoài repo nên hỏng khi build trong CI/Docker, và còn phụ thuộc vào `dist` đang có trên máy.
- **Nạp module:**
  - MyMadison là CommonJS. SDK đã hỗ trợ `require()` qua điều kiện `default` và `typesVersions` (đã kiểm bằng `test/commonjs.test.cjs`).
  - Điều kiện là Node ≥ 22.13 (`engines` của SDK, cần `require(esm)`). Máy dev đang chạy Node 26; phải kiểm Node trên môi trường chạy thật trước giai đoạn 8.

### D2. Tham số `null` (sửa SDK: S1)

- **Vấn đề:**
  - Model kiểu OpenAI hay gửi `null` cho tham số không bắt buộc.
  - Legacy bỏ các giá trị này trước khi kiểm tra.
  - Ajv của SDK lại từ chối, nên model sẽ nhận `invalid_arguments` ở những câu hiện đang chạy tốt.
- **Sửa ở SDK (đã làm ở giai đoạn 0):** khi tham số không qua Ajv, SDK xóa các khóa cấp một của object thỏa đủ ba điều kiện rồi kiểm tra lại một lần:
  - giá trị là `null`;
  - khóa không nằm trong `required`;
  - khóa được khai báo trong `properties`.
- Schema cho phép `null` thì đã qua lần kiểm tra đầu nên giữ nguyên `null`. Ajv quyết định, nên `anyOf`, `$ref` hay `nullable` đều đúng.
- **Không đụng tới:**
  - object lồng bên trong;
  - khóa bắt buộc: gửi `null` vẫn là `invalid_arguments`.

### D3. Lỗi tool nghiêm trọng

- **Khác biệt:**
  - Legacy ném lại lỗi lập trình, request nhận 500. Spec có ca `programming errors stay fatal`.
  - SDK đổi mọi lỗi lạ thành `tool_failed` rồi chạy tiếp.
- **Cách giữ hành vi cũ mà không sửa SDK:**
  1. Runner tạo `stop = new AbortController()` và chạy run với `signal: AbortSignal.any([requestSignal, stop.signal])`.
  2. `execute` gặp lỗi mà `toolFailure(error)` không nhận ra thì lưu `chat.fatal = error`, gọi `stop.abort()` rồi ném lỗi.
  3. SDK trả `cancelled`. Runner thấy `chat.fatal`:
     - nếu đã có form: trả form một mình, như `withProposal` của legacy;
     - nếu chưa: ném lại `chat.fatal`.

### D4. Hết lượt hoặc hết call

- **Khác biệt:** khi chạm giới hạn, SDK gọi model thêm một lần với `toolChoice: 'none'`, còn legacy trả ngay `stuckReply`.
- **Chọn:** giữ cơ chế của SDK, vì người dùng nhận câu trả lời dựng từ dữ liệu đã có.
  - `limit_reached` có `text` thì dùng text đó.
  - Không có text thì dùng `stuckReply(voice)`, như legacy.
- **Giám sát ở giai đoạn 7:** số lần gọi model và độ trễ. Nếu xấu đi rõ thì thêm tùy chọn vào SDK để bỏ lần gọi kết thúc. Đây là việc phát sinh, không làm trước.

### D5. Mã lỗi gửi cho model

- **Mã lỗi giữ như legacy:** `forbidden`, `not_found`, `invalid_arguments` (kèm message), `unavailable`, `too_large`, `one_form_per_message`.
- **Cách làm:**
  - Tách bảng đổi lỗi của `runTool` thành `toolFailure(error): { code, message } | undefined`, dùng chung cho cả hai engine.
  - Adapter ném `new ToolError(code, message)`.
- **Không dùng** `authorize`, `timeoutMs` hay `beforeTool` của SDK cho quyền và timeout. Registry đã làm việc này, và nếu dùng SDK thì mã sẽ đổi thành `tool_forbidden` hoặc `tool_timeout`.
- **Hệ quả cần đo:** kết quả tool gửi cho model đổi vỏ thành `{"ok":true,"value":…}` hoặc `{"ok":false,"error":{"code","message"}}`. Prompt (`prompts/assistant.prompt.ts:30` nhắc mã `forbidden`) vẫn đúng, nhưng phải kiểm bằng eval.

### D6. Trạng thái riêng của mỗi request

- **SDK, agent và tool chỉ tạo một lần khi khởi động.**
- **Mỗi request có một đối tượng `ChatRunState`:**
  - đầu vào: `user`, `voice`, `prompt`, `emit`, `stop`;
  - dữ liệu gom trong run: `proposal`, `final`, `links`, `sources`, `fullOutputs`;
  - cờ: `fatal`, `done`, `draftHasProposal`.
- **Truyền vào run:** `run({ context: { userId, chat: state } })`. SDK sao chép nông context vào `ToolContext`, nên `execute` và `afterTool` cùng thấy một đối tượng `chat`.
- **Quyền theo vai trò:** `run({ tools: registry.getToolDeclarations(user).map(t => t.name) })`.
  - `AiToolSchema` là `{ name, description, parameters }`.
  - SDK giữ đúng thứ tự tên truyền vào, nên tiền tố prompt vẫn cache được cho từng vai trò.

### D7. Form đề xuất, câu hỏi làm rõ và streaming

SDK chạy các call trong một batch lần lượt. `ctx.reply` kết thúc run sau batch, và lần gọi `ctx.reply` đầu tiên được giữ. Nội dung trả cho người dùng luôn do runner dựng từ `chat.final` hoặc `chat.proposal`, không lấy `result.text` khi hai giá trị này tồn tại.

- **Tool đọc có câu cố định** (`registry.reply` trả câu, tool không phải propose):
  - `chat.final = { message: proposal ? `${proposal.message}\n\n${fixed}` : fixed, choices, action: proposal?.action }`;
  - đặt `chat.done = true`, gọi `ctx.reply(...)`;
  - các call còn lại trong batch trả `{ skipped: true }` mà không chạy, giống legacy dừng giữa batch.
- **Tool propose có câu cố định:**
  - Đã có form: ném `ToolError('one_form_per_message')`.
  - Chưa có: gọi `actions.propose`, lưu `chat.proposal`, emit `delta` bằng `proposal.message`.
  - Nếu `!asksMore(prompt)`: đặt `chat.final = proposal` và gọi `ctx.reply`.
  - Trả `FORM_SHOWN` cho model.
- **Có form và tin nhắn còn hỏi thêm** (`asksMore`): run chạy tiếp.
  - Frontend xóa bản nháp mỗi khi nhận event `tool` (`frontend/src/features/assistant/hooks/use-assistant-chat.ts:50`). Vì vậy legacy emit lại form sau các event tool (`ai-orchestrator.service.ts:221-222`).
  - Trước delta đầu tiên của model sau một event `tool`, runner emit `proposal.message + '\n\n'` nếu bản nháp chưa có.
  - Kết quả cuối: `proposal.message + '\n\n' + text`.
  - Run lỗi, hết lượt không có chữ, hoặc trả lời rỗng: trả form một mình.
- **Trả lời do runner tự dựng** (form hoặc câu hỏi làm rõ): emit đúng một `delta` chứa toàn văn, như legacy.
- **Eval trace:**
  - `execute` lưu output đầy đủ vào `chat.fullOutputs[toolCallId]`.
  - Hook `afterTool` (khai báo ở `createSDK`) emit `{type:'trace', tool, arguments, result: traceOf(name, full ?? output)}` khi `evalTrace` bật. Nhờ vậy lỗi Ajv và `unknown_tool` cũng có trace.
- **`forModel`** chạy trong `execute`: model nhận `registry.forModel(name, output)`, còn link, câu cố định, trace và form dùng output đầy đủ.

### D8. Timeout model, thống kê và mã HTTP

- **`instrumentedModel(inner, cfg)`** bọc cả `generate` và `stream`:
  - Tín hiệu: `AbortSignal.any([input.signal, AbortSignal.timeout(cfg.modelTimeoutMs)])`.
  - Khi timeout của chính nó bắn (và tín hiệu của request chưa abort): ném `new ModelError('provider_timeout', …)`.
  - Gọi `addStats` (`modelCalls`, `modelMs`, `promptTokens`, `cachedTokens` hoặc `unreported`) và ghi log kèm `requestTag()` và ttft lấy từ delta đầu tiên.
  - Thống kê truyền qua AsyncLocalStorage như hiện nay.
- **Đổi kết quả run ra HTTP:**
  - 503: `provider_unavailable`, `provider_timeout`, `provider_rate_limited`.
  - 502: các mã `provider_*` khác, `empty_reply`, `duplicate_call`, và câu trả lời dài hơn `maxResultChars`.
  - 504: `timed_out`.
  - `cancelled` do request: ném lý do abort; controller xử lý như hiện tại.

## 3. Các giai đoạn

Lệnh chạy trong `MyMadison/backend`, trừ khi ghi khác. Mỗi giai đoạn kết thúc bằng `npm run build` và bộ spec AI đều xanh. **Không chạy `npm run lint`**: lệnh này có `--fix`.

```bash
TS_NODE_TRANSPILE_ONLY=1 node --test -r ts-node/register test/ai-*.spec.ts test/kb-seed.spec.ts
```

### Giai đoạn 0: chuẩn bị SDK (repo `ai-agent-sdk`)

- **File:**
  - `src/index.ts` (bước chuẩn bị tham số tool trước Ajv);
  - `test/sdk.test.js` (cạnh các ca `invalid_arguments` hiện có);
  - `README.md` (mục tham số tool);
  - thẻ requirement của module `agent-runtime`.
- **Bước:**
  1. Làm S1 như mô tả ở D2.
  2. Thêm bốn test:
     - `null` ở khóa tùy chọn bị bỏ và tool chạy;
     - `null` ở khóa bắt buộc vẫn ra `invalid_arguments`;
     - khóa có `type: ['string','null']` giữ nguyên `null`;
     - object lồng không bị đổi.
  3. Ghi hành vi mới vào README và cập nhật thẻ.
  4. `npm run build`, rồi `npm pack` để có `agent-studio-sdk-0.1.0.tgz`.
- **Lệnh:** `npm test` (hiện 45 test), `npm run build`, `npm pack`.
- **Xong khi:** toàn bộ test xanh kể cả 4 test mới; tarball cài được vào một dự án CommonJS trống và `require('agent-studio-sdk')` chạy.

### Giai đoạn 1: nạp SDK và cờ engine

- **File:**
  - `backend/package.json`, `backend/package-lock.json`, `backend/vendor/agent-studio-sdk-0.1.0.tgz`;
  - `backend/src/config/ai.config.ts`;
  - `backend/src/ai/agent/ai-agent.ts` (mới).
- **Bước:**
  1. `npm install ./vendor/agent-studio-sdk-0.1.0.tgz`. `frontend/package-lock.json` đang có thay đổi không thuộc việc này: không đụng vào.
  2. Thêm `engine` vào `getAiConfig()`: trống là `legacy`, nhận `legacy` hoặc `sdk`, giá trị khác thì ném lỗi như các biến AI khác.
  3. Tạo lớp trừu tượng `AiAgent` (dùng làm token của Nest), chỉ có `processUserMessage(prompt, user, history, signal, emit): Promise<ChatResponse>`. `AiOrchestratorService` khai báo `implements AiAgent` và không đổi gì khác.
- **Xong khi:** build xanh, spec AI xanh, hành vi không đổi.

### Giai đoạn 2: model adapter

- **File:** `backend/src/ai/sdk/sdk-model.ts` (mới), `backend/test/ai-sdk-model.spec.ts` (mới).
- **Bước:**
  1. Viết `createInternalModel(cfg)`. Khi gọi `createModel` với `provider: 'compatible'`:
     - lấy `model`, `baseUrl` và `apiKey` từ `cfg.internal`;
     - `headers: { 'x-9router-token-saver': 'off' }`, `maxRetries: 1`;
     - `body: { temperature: 0.2, max_tokens: 4096 }`;
     - với Qwen (`/qwen/i`), thêm vào `body` thêm `reasoning_effort: 'none'` và `chat_template_kwargs: { enable_thinking: false }`;
     - với model khác, thêm `reasoning_effort` từ cấu hình vào `body` (không dùng tùy chọn `reasoningEffort` của SDK: provider `compatible` không nhận `minimal`, trong khi `AI_REASONING_EFFORT` cho phép).
     - **Không** đưa `tool_choice` vào `body`: `body` được ghép sau cùng nên sẽ đè `'none'` ở lần gọi kết thúc.
  2. Viết `instrumentedModel` theo D8.
  3. Spec dùng tùy chọn `fetch` của `createModel` để trả các frame SSE giả, như `ai-providers.spec.ts` đang làm. Phủ:
     - header, body, Qwen và reasoning effort;
     - timeout ra `provider_timeout`;
     - `addStats` ghi đủ số liệu;
     - `finish_reason: length` ra `provider_truncated`;
     - lỗi 401 và 500 ra đúng mã;
     - abort từ request không bị đổi thành timeout.
- **Xong khi:** spec mới xanh; các trường hợp trong `ai-providers.spec.ts` (10 test) đều có ca tương ứng.

### Giai đoạn 3: tool adapter

- **File:**
  - `backend/src/ai/tools/tool-failure.ts` (mới, tách từ `runTool`);
  - `backend/src/ai/orchestrator/ai-orchestrator.service.ts` (`runTool` gọi `toolFailure`);
  - `backend/src/ai/sdk/sdk-tools.ts` (mới);
  - `backend/test/ai-sdk-tools.spec.ts` (mới).
- **Bước:**
  1. Tách bảng đổi lỗi:
     - `BadRequest` → `invalid_arguments` kèm message;
     - `Forbidden` → `forbidden`;
     - `NotFound` → `not_found`;
     - `AiToolError` timeout → `unavailable`, too_large → `too_large`;
     - lỗi tạm thời → `unavailable` (503, 409, lỗi khởi tạo Prisma, `P1001`, `P1002`, `P1008`, `P1017`, `P2024`);
     - lỗi khác → `undefined`, tức lỗi nghiêm trọng.
  2. Viết `toSdkTools(registry, actions)`: với mỗi tool, gọi `defineTool({ name, description, parameters, execute })`. `execute` làm theo D3, D5 và D7, và gọi `registry.executeTool(name, args, chat.user, ctx.signal)`.
  3. Spec:
     - đăng ký **cả 15 tool thật** qua `defineTool`, để bắt keyword mà Ajv strict từ chối;
     - mỗi mã lỗi đến model đúng như legacy;
     - lỗi lập trình đi qua đường `fatal`;
     - output đầy đủ được giữ cho link, trace và form.
- **Xong khi:** spec mới xanh; spec legacy vẫn xanh sau khi tách `toolFailure`.
- **Nếu Ajv từ chối schema:** sửa schema cho đúng chuẩn. Không tắt strict.

### Giai đoạn 4: SdkAgentService và chọn engine

- **File:**
  - `backend/src/ai/sdk/sdk-agent.service.ts` (mới);
  - `backend/src/ai/orchestrator/ai-orchestrator.service.ts` (đổi phần dựng đầu vào thành `buildInput(prompt, user, history)` public);
  - `backend/src/ai/ai.module.ts`;
  - `backend/src/ai/chat/ai-chat.controller.ts`.
- **Bước:**
  1. `buildInput` gom `compactHistory`, `companyRules()`, `asker(user)`, `officeCalendar()` và `currentMessage`, theo đúng thứ tự khóa JSON hiện tại.
  2. `SdkAgentService implements AiAgent`:
     - Nhận qua constructor: token `AI_MODEL` (một `ModelAdapter`), `ToolRegistryService`, `AiActionsService` và `AiOrchestratorService` (chỉ để gọi `buildInput` trong thời gian chuyển đổi).
     - Tạo SDK và agent một lần với `systemPrompt: ASSISTANT_INSTRUCTION`, các giới hạn ở mục 1, và `afterTool` cho trace.
     - Tự quản lý `ModelSlots` của mình.
  3. `processUserMessage`:
     1. Dựng đầu vào bằng `buildInput`.
     2. Lấy slot (`acquire`).
     3. Gọi `agent.run({ sessionId: requestId, history: [], message: input, context, tools, signal, onEvent, onDelta })`.
     4. Đổi kết quả theo D4, D7 và D8.
     5. Kiểm `maxResultChars`, ghi log `unknownCitations`, gắn `links`.
     6. Trả slot (`release`) trong `finally`.
  4. Đổi `onEvent` sang luồng của controller:
     - `tool.started` → `emit({ type: 'tool', name })`;
     - delta đi qua quy tắc tiền tố form ở D7.
  5. Cập nhật module và controller:
     - `ai.module.ts`: provider `AI_MODEL` dùng `createInternalModel(instrumented)`; provider `AiAgent` dùng `useFactory` và chọn theo `getAiConfig().engine`.
     - Controller inject `AiAgent` thay cho `AiOrchestratorService`.
  6. **Smoke test:** chạy backend dev với `AI_ENGINE=sdk AI_EVAL_TRACE=true`, rồi chạy `npm run eval:ai -- --email <tài khoản> --only 1,5,M1`.
- **Điều kiện cho S2:** nếu trace cho thấy model không gọi tool nào khi không có `tool_choice`, sửa SDK để gửi `tool_choice: 'auto'` khi có tool và `toolChoice` khác `'none'`. Sau đó đóng gói lại tarball.
- **Xong khi:** build và spec xanh với cả hai giá trị cờ; smoke test có event `tool`, `trace` và `done`.

### Giai đoạn 5: form, câu hỏi làm rõ và streaming (spec hành vi)

- **File:** `backend/test/ai-sdk-agent.spec.ts` (mới), dùng một `ModelAdapter` theo kịch bản thay cho `ScriptedProvider`.
- **Bước:** viết lại 23 ca của `ai-orchestrator.spec.ts` theo bảng ở mục 4. Mỗi ca giữ tên cũ, hoặc đánh dấu là khác biệt chấp nhận.
- **Xong khi:**
  - 23 ca xanh;
  - ca có khác biệt khẳng định hành vi mới, không bỏ trống;
  - riêng D7 có thêm các ca:
    - form cùng tool đọc khi tin nhắn không hỏi thêm;
    - form rồi lỗi provider;
    - form rồi chạm giới hạn;
    - thứ tự delta khi có event `tool` xen giữa.

### Giai đoạn 6: spec HTTP cho cả hai engine

- **File:** `backend/test/ai-chat-http.spec.ts`.
- **Bước:**
  1. Đổi `{ provide: AiOrchestratorService, … }` thành `{ provide: AiAgent, useValue: service }`.
  2. Chạy toàn bộ 15 ca hai lần:
     - legacy dùng `TestProvider` như cũ;
     - sdk dùng `SdkAgentService` với adapter giả có cùng chế độ.
     - Ở chế độ `error` và `late-error`, adapter ném `ModelError('provider_unavailable', 'test-private-provider-message')`.
  3. Kiểm thông điệp nội bộ không lọt ra client, và mã 429, 503, 504, abort giữ nguyên.
- **Xong khi:** 30 ca xanh (15 ca × 2 engine).

### Giai đoạn 7: so sánh bằng eval

- **Chạy:** dùng DB dev/test. Chạy hai lượt, mỗi lượt khởi động backend dev với một engine.

  ```bash
  AI_ENGINE=legacy AI_EVAL_TRACE=true npm run start:dev
  ```

  ```bash
  npm run eval:ai -- --email <tài khoản> --repeat 3 --out eval-legacy.json
  ```

  ```bash
  AI_ENGINE=sdk AI_EVAL_TRACE=true npm run start:dev
  ```

  ```bash
  npm run eval:ai -- --email <tài khoản> --repeat 3 --out eval-sdk.json
  ```

- **So sánh:**
  - từng trục: câu trả lời, Tool, Nguồn, trích dẫn và số liệu;
  - từ log thống kê: `modelCalls`, `modelMs` và `queueMs`.
- **Xong khi:**
  - Không trục nào của sdk thấp hơn legacy quá 1 câu trên bộ 33 câu (lấy trung bình 3 lần chạy).
  - Câu nào legacy đạt cả 3 lần thì sdk đạt ít nhất 2 lần.
  - `modelCalls` trung bình không tăng quá 10%.
- **Nếu không đạt:**
  - Xem các câu tụt hạng.
  - Ưu tiên chỉnh adapter: vỏ lỗi, `forModel`, quy tắc form.
  - Chỉ đổi prompt khi đại nhân đồng ý.

### Giai đoạn 8: bật mặc định và gỡ legacy

- **Bước:**
  1. Kiểm Node ≥ 22.13 trên môi trường chạy thật, và kiểm bước build/deploy cài được tarball trong `vendor/`.
  2. Bật `AI_ENGINE=sdk` trên môi trường thử. Theo dõi một tuần: tỉ lệ 5xx, `unreported`, `modelMs`, và phản hồi trong chat log.
  3. Đổi mặc định của cờ sang `sdk`.
  4. Gỡ legacy trong một thay đổi riêng:
     - chuyển `buildInput` và các hàm phụ (`asksMore`, `stuckReply`, `traceOf`, `unknownCitations`) sang `ai/sdk/`;
     - xóa vòng lặp legacy, `InternalAiProvider`, `ai-providers.spec.ts` và phần legacy của `ai-orchestrator.spec.ts`;
     - **giữ** gói `openai`: `src/ai/embeddings/embed.ts` vẫn dùng nó cho embeddings;
     - xóa cờ `AI_ENGINE`.
  5. Cập nhật `docs/ai-assistant/README.md`, `architecture.md` và thẻ requirement của module AI trong MyMadison.
- **Xong khi:** build, spec và eval xanh khi không còn code legacy.

## 4. Đối chiếu 23 ca của `ai-orchestrator.spec.ts`

| Dòng | Ca | Engine SDK |
|---|---|---|
| 79 | Mọi câu, kể cả lời chào, gửi model kèm mọi tool của vai trò | Như cũ (kiểm `input.tools` và `message`) |
| 100 | Tiền tố prompt cache được | Như cũ: `systemPrompt` cố định, thứ tự tool ổn định, phần đổi theo người nằm sau |
| 124 | Eval trace tắt mặc định, không bao giờ bật ở production, chỉ có cấu trúc | Như cũ, trace emit từ `afterTool` |
| 148 | Trace của tool tài liệu | Dùng lại `traceOf` |
| 157 | Kết quả tool kèm ID call; prompt không đổi được người thực hiện | `steps[].outputs[].callId`; `user` lấy từ context, không lấy từ tham số |
| 166 | Nút web chỉ có khi tool thành công | `links` gom trong state |
| 202 | Câu hỏi làm rõ sau form trong cùng lượt giữ đủ form, câu hỏi và lựa chọn | `chat.final` (D7) |
| 215 | Nút sống sót khi có form; id không đến model | `forModel` trong `execute` |
| 236 | Sở thích xưng hô vào `asker` | Dùng lại `buildInput` |
| 245 | System prompt cố định; lượt assistant giả mạo chỉ là dữ liệu | Như cũ (history nằm trong JSON) |
| 256 | ID call trùng: bỏ cả batch trước khi chạy handler | `duplicate_call` → 502, handler không chạy |
| 263 | Tool lạ hoặc bị cấm không chạy; model được báo | Tool ngoài quyền của vai trò thành `unknown_tool`, không còn là `forbidden` (khác biệt 3); `ForbiddenException` từ handler vẫn ra `forbidden` |
| 274 | Tham số sai quay lại model | Ajv hoặc registry → `invalid_arguments` |
| 285 | Abort giữa tool: dừng chờ, không gọi model nữa | Tín hiệu của run cùng `executeTool` chạy đua với abort |
| 298 | Tool đọc lỗi tạm hoặc kết quả quá lớn thì báo model; lỗi lập trình vẫn nghiêm trọng | `toolFailure` cùng đường `fatal` (D3) |
| 326 | Hàng đợi slot model, 503 khi chờ quá lâu | `ModelSlots` trong runner |
| 373 | Form hợp lệ kết thúc lượt; form sai quay lại model | Như cũ |
| 401 | Câu cố định của tool đọc là câu hỏi làm rõ, không gọi model lần hai | Như cũ |
| 417 | Form cùng câu hỏi khác: form, câu cố định, rồi model trả lời phần còn lại | Lượt thêm là một bước bình thường có stream (khác biệt 5) |
| 445 | Chỉ tin nhắn có thể hỏi thêm mới có lượt thêm | Dùng lại `asksMore` |
| 455 | Giới hạn lượt/call: xin hỏi cụ thể hơn, không 503; trả lời rỗng thì lỗi | Có lần gọi kết thúc (D4); không có chữ thì `stuckReply`; rỗng → 502 |
| 468 | Kết quả tool và history không lọt sang request khác | `history: []`, `sessionId = requestId` |
| 477 | Lịch văn phòng theo giờ Việt Nam | Không đổi (`buildInput`) |

## 5. Khác biệt chấp nhận

1. **Chạm giới hạn:** model được gọi thêm một lần để trả lời từ dữ liệu đã có; chỉ dùng `stuckReply` khi lần đó không cho chữ.
2. **Vỏ kết quả tool gửi model:** đổi thành `{ok, value}` hoặc `{ok:false, error:{code, message}}`.
3. **Tool không thuộc quyền của vai trò** (model gọi tool không có trong danh sách): nhận `unknown_tool` thay cho `forbidden`.
4. **Form cùng tool đọc trong một batch, khi tin nhắn không hỏi thêm:** chỉ trả form. Legacy trả thêm câu trả lời cho tool đọc.
5. **Lượt thêm sau form có stream.** Chữ mở đầu trước khi model gọi tool có thể hiện thoáng qua trên bản nháp, cho tới khi event `tool` xóa nó.
6. **Timeout 90 s mỗi lần gọi model** tính cả retry. Legacy tính riêng từng lần thử.
7. **Phản hồi không phải SSE** ra `provider_incomplete` (vẫn 502). Index tool call được tới 63 thay vì 15.

## 6. Rủi ro

| Rủi ro | Cách giảm |
|---|---|
| Node trên môi trường chạy thật dưới 22.13, `require(esm)` không chạy | Kiểm ở bước 1 của giai đoạn 8 trước khi bật |
| Build/deploy không thấy tarball trong `vendor/` | Commit tarball cùng lockfile; kiểm bằng một lần build sạch |
| Ajv strict từ chối schema tool | Khả năng thấp: `AiToolParameterProperty` chỉ cho `type`, `description`, `enum`, `maxLength`. Spec ở giai đoạn 3 vẫn đăng ký cả 15 tool để chắc chắn |
| Chất lượng trả lời lệch do vỏ lỗi và lần gọi kết thúc | Eval ở giai đoạn 7 với `--repeat 3` |
| Đường `fatal` dựa vào việc SDK trả `cancelled` khi tín hiệu run bị abort | Có ca riêng trong spec ở giai đoạn 5 |
| Lần gọi kết thúc giữ slot model lâu hơn khi `maxConcurrent` là 1 | Theo dõi `queueMs` ở giai đoạn 7 và giai đoạn 8 |
| SDK 0.x còn đổi API | Ghim tarball theo phiên bản; nâng cấp SDK là một thay đổi riêng, chạy lại bước 5 đến 7 |
| Thống kê qua AsyncLocalStorage bị mất | Spec ở giai đoạn 2 kiểm `addStats` bên trong `runWithRequestId` |

## 7. Ngoài phạm vi

- Không dùng session store hay history của SDK. Lịch sử vẫn đi trong JSON đầu vào.
- Không dùng Agent Studio để cấu hình agent của MyMadison.
- Không đổi frontend, API `/ai/chat`, prompt (trừ khi eval cần và đại nhân đồng ý), hay luồng confirm của `aiAction`.
- Không dùng `authorize`, `timeoutMs` hay `beforeTool` của SDK cho quyền và timeout.
