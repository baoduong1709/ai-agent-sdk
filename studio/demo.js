import { defineTool } from 'agent-studio-sdk';

const orders = new Map([
  ['DH123', { status: 'Đang giao', delivery: 'trước 17:00 hôm nay' }],
  ['DH456', { status: 'Đã xác nhận', delivery: 'trong 2 ngày làm việc' }],
]);

const policies = {
  doi_tra: 'Bạn có thể yêu cầu đổi trả trong vòng 7 ngày kể từ khi nhận hàng, với sản phẩm còn nguyên tem và có hóa đơn.',
  nghi_phep: 'Nhân viên gửi yêu cầu nghỉ phép trên cổng nội bộ ít nhất 3 ngày làm việc trước ngày nghỉ.',
};

const orderSchema = {
  type: 'object', properties: { orderId: { type: 'string', pattern: '^DH[0-9]{3,12}$' } },
  required: ['orderId'], additionalProperties: false,
};

export const catalog = [
  {
    label: 'Trạng thái đơn hàng', icon: 'box',
    tool: defineTool({
      name: 'get_order_status', description: 'Tra cứu trạng thái hiện tại của đơn hàng theo mã DH.',
      parameters: orderSchema, readOnly: true,
      execute: ({ orderId }) => ({ orderId, status: orders.get(orderId)?.status ?? null }),
    }),
  },
  {
    label: 'Dự kiến giao hàng', icon: 'truck',
    tool: defineTool({
      name: 'get_delivery_estimate', description: 'Tra cứu thời gian dự kiến giao hàng theo mã DH.',
      parameters: orderSchema, readOnly: true,
      execute: ({ orderId }) => ({ orderId, delivery: orders.get(orderId)?.delivery ?? null }),
    }),
  },
  {
    label: 'Hủy đơn hàng', icon: 'box',
    tool: defineTool({
      name: 'cancel_order', description: 'Hủy đơn hàng theo mã DH. Người dùng duyệt trước khi tool chạy.',
      parameters: orderSchema, approval: true,
      // Sample data: the order is not changed, so the demo can be tried again.
      execute: ({ orderId }) => ({ orderId, cancelled: orders.has(orderId) }),
    }),
  },
  {
    label: 'Tra cứu chính sách', icon: 'book',
    tool: defineTool({
      name: 'find_company_policy', description: 'Lấy chính sách mẫu về đổi trả hoặc nghỉ phép.',
      parameters: {
        type: 'object', properties: { topic: { type: 'string', enum: Object.keys(policies) } },
        required: ['topic'], additionalProperties: false,
      },
      readOnly: true,
      execute: ({ topic }) => ({ topic, policy: policies[topic] }),
    }),
  },
];

export const initialProfiles = [
  {
    id: 'order-support', name: 'Hỗ trợ đơn hàng',
    systemPrompt: 'Bạn là trợ lý hỗ trợ đơn hàng.\n\nDùng tool để tra cứu trạng thái và thời gian giao dự kiến. Hỏi lại mã đơn nếu khách hàng chưa cung cấp. Trả lời ngắn gọn bằng tiếng Việt, dựa trên kết quả tra cứu.',
    tools: ['get_order_status', 'get_delivery_estimate'],
  },
  {
    id: 'company-policy', name: 'Tra cứu chính sách',
    systemPrompt: 'Bạn là trợ lý tra cứu chính sách.\n\nDùng tool để lấy quy định liên quan. Tóm tắt nội dung bằng tiếng Việt và hỏi lại nếu chủ đề chưa rõ.',
    tools: ['find_company_policy'],
  },
];

function normalize(text) {
  return text.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').replaceAll('đ', 'd');
}

export const demoModel = {
  // The demo reads no file, but takes them so the attach button can be tried without a model key.
  attachments: ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/pdf'],
  async generate({ history, tools, steps }) {
    const lastStep = steps.at(-1);
    if (lastStep) {
      const data = lastStep.outputs.map(({ output }) => {
        if (!output.ok && output.error?.code === 'tool_rejected') return 'Bạn đã từ chối thao tác này nên mình chưa thực hiện.';
        if (!output.ok) return 'Tool không tra cứu được dữ liệu.';
        const { orderId, status, delivery, policy, cancelled } = output.value;
        if (policy) return policy;
        if (cancelled !== undefined) {
          return cancelled ? `Đã hủy đơn ${orderId} (dữ liệu mẫu, đơn không thay đổi thật).` : `Không tìm thấy đơn ${orderId} để hủy.`;
        }
        if (status) return `Đơn ${orderId} hiện đang ở trạng thái “${status}”.`;
        if (delivery) return `Đơn ${orderId} dự kiến được giao ${delivery}.`;
        return `Chưa tìm thấy thông tin của đơn ${orderId} trong dữ liệu mẫu.`;
      });
      return { text: [...new Set(data)].join('\n') };
    }

    const { content: message, attachments } = history.at(-1);
    const query = normalize(message);
    const enabled = new Set(tools.map(({ name }) => name));
    const call = (name, args) => ({ id: `demo-${name}`, name, arguments: JSON.stringify(args) });
    const earlierOrder = () => history.map(({ content }) => content).reverse()
      .map((text) => text.match(/\bDH\d{3,12}\b/i)?.[0]).find(Boolean)?.toUpperCase();

    if (attachments?.length) {
      const files = attachments.map(({ name, mediaType }, index) => name ?? `tệp ${index + 1} (${mediaType})`).join(', ');
      return { text: `Chế độ demo đã nhận ${attachments.length} tệp: ${files}. Demo không đọc nội dung tệp; hãy chọn model thật để agent đọc ảnh hoặc PDF.` };
    }

    if (/huy don/.test(query)) {
      if (!enabled.has('cancel_order')) return { text: 'Hãy bật tool Hủy đơn hàng để thử câu hỏi này.' };
      const orderId = earlierOrder();
      return orderId ? { toolCalls: [call('cancel_order', { orderId })] } : { text: 'Bạn muốn hủy đơn nào? Bạn có thể dùng mã mẫu DH123.' };
    }

    if (/doi tra|hoan tra|nghi phep|chinh sach/.test(query)) {
      if (!enabled.has('find_company_policy')) return { text: 'Hãy bật tool Tra cứu chính sách để thử câu hỏi này.' };
      const topic = /nghi phep/.test(query) ? 'nghi_phep' : /doi tra|hoan tra/.test(query) ? 'doi_tra' : null;
      return topic ? { toolCalls: [call('find_company_policy', { topic })] }
        : { text: 'Bạn muốn tra cứu chính sách đổi trả hay nghỉ phép?' };
    }

    if (/\bDH\d+\b/i.test(message) || /don hang|don do|giao hang|khi nao giao|o dau/.test(query)) {
      const orderId = earlierOrder();
      if (!orderId) return { text: 'Bạn cho mình mã đơn hàng nhé. Bạn có thể dùng mã mẫu DH123.' };
      const wantsDelivery = /khi nao|bao gio|du kien|thoi gian giao/.test(query);
      const wantsStatus = !wantsDelivery || /o dau|trang thai|tien do/.test(query);
      const requests = [
        ...(wantsStatus && enabled.has('get_order_status') ? [call('get_order_status', { orderId })] : []),
        ...(wantsDelivery && enabled.has('get_delivery_estimate') ? [call('get_delivery_estimate', { orderId })] : []),
      ];
      return requests.length ? { toolCalls: requests }
        : { text: 'Hãy bật tool tra cứu đơn hàng tương ứng để thử câu hỏi này.' };
    }

    return { text: 'Chế độ demo có dữ liệu đơn DH123, DH456 và chính sách đổi trả, nghỉ phép. Hãy thử một trong các chủ đề này.' };
  },
};
