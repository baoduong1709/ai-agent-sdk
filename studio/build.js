import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { strToU8, zipSync } from 'fflate';
import { RequestError } from './config.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const readme = `# Triển khai Agent App

Gói này chạy độc lập trên Node.js 22.13 trở lên. Nó gồm cấu hình trong \`agent.json\` và dịch vụ \`app.mjs\` đã đóng gói SDK cùng các tool cần thiết.

1. Giải nén ZIP trên máy triển khai.
2. Sao chép \`.env.example\` thành \`.env\` và điền các biến dùng cho model, tool và API của dịch vụ.
3. Chạy \`npm start\`. Địa chỉ mặc định là \`http://127.0.0.1:8080\`. Gọi \`GET /health\` để kiểm tra.

Mỗi backend gọi \`POST /api/run\` với \`appId\`, \`sessionId\`, \`message\` và tùy chọn \`userId\`. Ví dụ dưới đây chạy bằng curl trên Bash.

\`\`\`sh
curl http://127.0.0.1:8080/api/run \\
  -H 'Content-Type: application/json' \\
  -H "Authorization: Bearer $AGENT_API_KEY" \\
  -d '{"appId":"checkout","sessionId":"order-123","message":"Kiểm tra đơn DH123"}'
\`\`\`

Các ứng dụng dùng \`appId\` khác nhau. Giữ cùng \`sessionId\` và \`userId\` (nếu dùng) để tiếp tục hội thoại. Dùng \`AGENT_API_KEY\` cho các backend cùng mức tin cậy hoặc cấu hình riêng bằng \`AGENT_CLIENT_KEYS\` dạng JSON, ví dụ \`{"checkout":"<key-1>","helpdesk":"<key-2>"}\`. Kiểu riêng theo ứng dụng được ưu tiên khi có cả hai biến. Có thể tạo key bằng \`node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"\`.

API cũng nhận \`POST /api/agents/<agentId>/run\`. Gửi \`Accept: application/x-ndjson\` nếu muốn nhận tiến trình. Để dừng lượt chạy, gửi \`requestId\` khi chạy và gọi \`POST /api/run/cancel\` với cùng \`appId\` và \`requestId\`.

Khi kết quả của tool khớp nhánh schema kết quả có \`x-form\`, kết quả lượt chạy kèm \`forms\`: mỗi form có \`id\`, \`tool\`, \`form\` (tên form), \`data\` (kết quả tool), \`status\` và \`html\` để khung chat hiển thị. Khi người dùng gửi form, gọi \`POST /api/forms/submit\` với \`appId\`, \`sessionId\`, \`userId\` (nếu dùng), \`formId\` và \`values\`. Agent chỉ nhận form đã hiển thị trong đúng phiên đó và gửi mỗi form một lần. Kết quả có \`status\` là \`submitted\` hoặc \`error\` cùng trạng thái mới của form.

Để gửi kèm ảnh hoặc PDF, thêm \`attachments\` vào \`POST /api/run\`: mỗi tệp có \`mediaType\` (\`image/png\`, \`image/jpeg\`, \`image/gif\`, \`image/webp\` hoặc \`application/pdf\`), \`data\` (base64) và \`name\` nếu có. Tối đa 5 tệp, mỗi tệp 5 MB, tổng 10 MB. Tệp sai định dạng trả \`error.code\` là \`invalid_attachment\`; model không đọc được loại tệp đó trả \`attachments_unsupported\`.

Khi một tool cần duyệt trước khi chạy, kết quả có \`status: "interrupted"\` và \`interruptions\`: mỗi mục có \`id\`, \`tool\` và \`arguments\`. Hiển thị cho người dùng rồi gọi \`POST /api/run/resume\` (hoặc \`/api/agents/<agentId>/resume\`) với \`appId\`, \`sessionId\`, \`userId\` (nếu dùng) và \`approvals\`, ví dụ \`[{"id":"<id>","approved":true}]\` hoặc \`[{"id":"<id>","approved":false,"reason":"Sai ngày"}]\`. Lượt chạy tiếp tục từ chỗ dừng và trả kết quả giống \`/api/run\`. Chỉ đúng ứng dụng và người dùng đã bắt đầu lượt chạy mới duyệt được.

## Docker

\`\`\`sh
docker build -t agent-app .
docker run --init --env-file .env -e HOST=0.0.0.0 -e PORT=8080 \\
  -p 8080:8080 -v agent-app-data:/data agent-app
\`\`\`

Khi dùng Docker, đặt \`AGENT_DATA_PATH=/data/workspace.json\` hoặc để trống để dùng đường dẫn của image. Khi mở cổng ngoài localhost, dịch vụ yêu cầu cấu hình key. Dùng HTTPS qua reverse proxy cho kết nối bên ngoài.

Nếu model hoặc tool HTTP dùng localhost, địa chỉ đó trỏ vào máy hoặc container chạy app. Đặt \`AGENT_MODEL_BASE_URL\` cho model dùng endpoint tùy chọn hoặc cập nhật địa chỉ tool trong \`agent.json\` để trỏ tới dịch vụ trên môi trường triển khai. Khởi động lại app sau khi chỉnh cấu hình.

## MCP server

Nếu \`agent.json\` có \`mcpServers\`, app kết nối tới từng server ở lượt chạy đầu tiên và giữ kết nối cho các lượt sau. Server có \`apiKeyEnv\` nhận token qua header \`Authorization: Bearer\` từ biến môi trường cùng tên; app không khởi động khi biến này trống. Nếu server chưa sẵn sàng, lượt chạy trả HTTP 502 và lượt sau kết nối lại. Kết nối không dùng trong 10 phút được đóng, nên tool mới trên server có hiệu lực sau đó hoặc sau khi khởi động lại app. Tên tool là tiền tố của server, dấu \`_\` và tên tool trên server.
`;

const dockerfile = `FROM node:22-bookworm-slim
WORKDIR /app
COPY app.mjs agent.json THIRD-PARTY-NOTICES.txt ./
RUN install -d -o node -g node /data
ENV HOST=0.0.0.0 PORT=8080 AGENT_DATA_PATH=/data/workspace.json
USER node
EXPOSE 8080
VOLUME ["/data"]
CMD ["node", "app.mjs"]
`;

async function licenseNotices(inputs) {
  const roots = new Map();
  for (const file of Object.keys(inputs)) {
    const parts = file.replaceAll('\\', '/').split('/');
    const start = parts.lastIndexOf('node_modules') + 1;
    if (!start) continue;
    const end = start + (parts[start].startsWith('@') ? 2 : 1);
    roots.set(resolve(root, parts.slice(0, end).join('/')), parts.slice(start, end).join('/'));
  }
  const notices = await Promise.all([...roots].map(async ([directory, name]) => {
    const names = (await readdir(directory)).filter((filename) => /^(?:licen[sc]e|copying|notice)(?:\.|$)/i.test(filename));
    const texts = await Promise.all(names.map(async (filename) => readFile(resolve(directory, filename), 'utf8')));
    return texts.length ? `${name}\n${texts.join('\n')}` : '';
  }));
  return notices.filter(Boolean).join('\n\n');
}

export async function buildAgentApp(config, { customToolNames }) {
  const usesCustomTools = config.tools.some((tool) => typeof tool === 'string'
    ? customToolNames.has(tool) : tool.kind === 'registered' && customToolNames.has(tool.name));
  let compiled;
  try {
    compiled = await build({
      stdin: {
        contents: `import { launchDeployment } from './studio/deployment.js';\n${usesCustomTools
          ? "import { userTools } from './studio/user-tools.js';\nawait launchDeployment(userTools);"
          : 'await launchDeployment();'}`,
        resolveDir: root,
        sourcefile: 'agent-app-entry.js',
      },
      absWorkingDir: root, outfile: 'app.mjs', write: false, bundle: true, metafile: true,
      platform: 'node', format: 'esm', target: 'node22', logLevel: 'silent', legalComments: 'eof',
      banner: { js: "import { createRequire } from 'node:module';\nconst require = createRequire(import.meta.url);" },
    });
  } catch (error) {
    throw new RequestError(422, `Không thể đóng gói mã của agent. ${error.errors?.[0]?.text ?? error.message}`);
  }

  const credentials = new Set([config.model?.apiKeyEnv, ...config.tools.map((entry) => entry?.apiKeyEnv),
    ...(config.mcpServers ?? []).map((server) => server.apiKeyEnv)].filter(Boolean));
  const env = [
    'HOST=127.0.0.1', 'PORT=8080', 'AGENT_API_KEY=', 'AGENT_CLIENT_KEYS=', 'AGENT_MODEL_BASE_URL=',
  ];
  for (const variable of credentials) if (!env.includes(`${variable}=`)) env.push(`${variable}=`);
  const files = {
    'app.mjs': compiled.outputFiles[0].contents,
    'agent.json': strToU8(`${JSON.stringify(config, null, 2)}\n`),
    'package.json': strToU8(`${JSON.stringify({ name: 'agent-app', private: true, type: 'module',
      engines: { node: '>=22.13.0' }, scripts: { start: 'node --env-file-if-exists=.env app.mjs' },
    }, null, 2)}\n`),
    '.env.example': strToU8(`${env.join('\n')}\n`),
    'Dockerfile': strToU8(dockerfile),
    '.dockerignore': strToU8('*\n!app.mjs\n!agent.json\n!Dockerfile\n!THIRD-PARTY-NOTICES.txt\n'),
    'README.md': strToU8(readme),
  };
  files['THIRD-PARTY-NOTICES.txt'] = strToU8(await licenseNotices(compiled.metafile.inputs));
  return zipSync(files, { level: 6 });
}
