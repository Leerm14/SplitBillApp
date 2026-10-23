/**
 * Nội dung hiển thị của một thông báo: biểu tượng, tiêu đề, câu mô tả "ai đã làm gì, bao nhiêu".
 * Thuần TypeScript để kiểm thử. Danh sách loại phải khớp các loại RPC tạo
 * (grep "INSERT INTO public.notifications" trong supabase/migrations).
 */
import { formatVND } from '@/domain/money';

export type NotificationTextInput = {
  type: string;
  /** Người thực hiện (migration 0016 điền cho thông báo mới) */
  actorName?: string | null;
  expense?: { description?: string | null; amount?: number | string | null; creatorName?: string | null } | null;
  payment?: { amount?: number | string | null; senderName?: string | null; receiverName?: string | null } | null;
};

export type NotificationText = { icon: string; title: string; body: string | null };

const SOMEONE = 'Một thành viên';

function money(v: number | string | null | undefined): string | null {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? formatVND(n) : null;
}

function quoted(s: string | null | undefined): string {
  const t = (s ?? '').trim();
  return t ? `"${t}"` : 'một khoản chi';
}

export function describeNotification(n: NotificationTextInput): NotificationText {
  const exp = n.expense ?? null;
  const pay = n.payment ?? null;
  const expAmount = money(exp?.amount);
  const payAmount = money(pay?.amount) ?? 'một khoản';
  // Thông báo cũ (trước 0016) không có actor → suy từ khoản chi / thanh toán
  const actor = (fallback?: string | null) => n.actorName || fallback || SOMEONE;

  switch (n.type) {
    case 'EXPENSE_CREATED':
      return { icon: '🧾', title: 'Khoản chi mới',
        body: `${actor(exp?.creatorName)} đã thêm ${quoted(exp?.description)}${expAmount ? ` · ${expAmount}` : ''}` };
    case 'EXPENSE_UPDATED':
      return { icon: '✏️', title: 'Khoản chi đã sửa',
        body: `${actor()} đã sửa ${quoted(exp?.description)}${expAmount ? ` · ${expAmount}` : ''}` };
    case 'EXPENSE_CANCELLED':
      return { icon: '❌', title: 'Khoản chi đã hủy', body: `${actor()} đã hủy ${quoted(exp?.description)}` };

    case 'PAYMENT_CREATED':
      return { icon: '💳', title: 'Cần bạn xác nhận',
        body: `${actor(pay?.senderName)} báo đã chuyển cho bạn ${payAmount}` };
    case 'PAYMENT_CONFIRMED':
      return { icon: '✅', title: 'Thanh toán đã xác nhận',
        body: `${actor(pay?.receiverName)} đã xác nhận nhận ${payAmount}` };
    case 'PAYMENT_REJECTED':
      return { icon: '❌', title: 'Thanh toán bị từ chối',
        body: `${actor(pay?.receiverName)} chưa nhận được ${payAmount} và đã từ chối` };
    case 'PAYMENT_DISPUTED':
      return { icon: '⚠️', title: 'Thanh toán bị báo sai lệch',
        body: `${actor(pay?.receiverName)} báo khoản ${payAmount} bị sai lệch` };
    case 'PAYMENT_CANCELLED':
      return { icon: '🚫', title: 'Thanh toán đã hủy', body: `${actor(pay?.senderName)} đã hủy khoản ${payAmount}` };

    case 'MEMBER_JOINED':
      return { icon: '👋', title: 'Thành viên mới', body: `${actor()} đã tham gia nhóm` };
    case 'MEMBER_LEFT':
      return { icon: '🚪', title: 'Thành viên rời nhóm', body: `${actor()} đã rời nhóm` };
    case 'MEMBER_REMOVED':
      return { icon: '👤', title: 'Bạn đã bị xóa khỏi nhóm', body: n.actorName ? `${n.actorName} đã xóa bạn khỏi nhóm` : null };
    case 'OWNERSHIP_RECEIVED':
      return { icon: '👑', title: 'Bạn là chủ nhóm mới',
        body: n.actorName ? `${n.actorName} đã chuyển quyền chủ nhóm cho bạn` : null };
    case 'OWNERSHIP_TRANSFERRED':
      return { icon: '👑', title: 'Đã chuyển quyền chủ nhóm', body: null };

    case 'GROUP_INVITED':
      return { icon: '📨', title: 'Lời mời vào nhóm', body: `${actor()} mời bạn tham gia nhóm` };
    case 'JOIN_REQUESTED':
      return { icon: '🙋', title: 'Yêu cầu tham gia nhóm', body: `${actor()} muốn tham gia nhóm` };
    case 'JOIN_APPROVED':
      return { icon: '🎉', title: 'Đã được duyệt vào nhóm', body: 'Bạn đã là thành viên của nhóm' };
    case 'JOIN_REJECTED':
      return { icon: '🚫', title: 'Yêu cầu tham gia bị từ chối', body: null };

    case 'FRIEND_REQUEST':
      return { icon: '🤝', title: 'Lời mời kết bạn', body: `${actor()} muốn kết bạn với bạn` };
    case 'FRIEND_ACCEPTED':
      return { icon: '🤝', title: 'Đã trở thành bạn bè', body: `${actor()} đã chấp nhận lời mời kết bạn` };
    case 'FRIEND_DECLINED':
      return { icon: '🙅', title: 'Lời mời kết bạn bị từ chối', body: `${actor()} đã từ chối lời mời kết bạn` };

    default:
      return { icon: '🔔', title: 'Thông báo', body: null };
  }
}
