/**
 * Thành viên nhóm: kết quả vào nhóm (duyệt thành viên mới — migration 0014) và quy tắc xóa thành viên.
 * Thuần TypeScript để kiểm thử được; màn hình chỉ gọi các hàm này rồi hiển thị.
 */

import { getServerErrorCode, toUserMessage } from '@/api/errors';
import { formatVND } from '@/domain/money';

// ============================
// Kết quả vào nhóm
// ============================

/** Vào thẳng, đang chờ chủ nhóm duyệt, hoặc đã là thành viên từ trước. */
export type JoinStatus = 'JOINED' | 'PENDING' | 'ALREADY_MEMBER';

export type JoinResult = {
  status: JoinStatus;
  groupId: string;
  groupName: string;
  /** Có khi status = PENDING (dùng để hủy yêu cầu) */
  requestId: string | null;
};

/** Chuẩn hóa jsonb {status, group_id, group_name, request_id} của join_by_token / join_by_code / accept_invite_by_id_v2. */
export function toJoinResult(data: unknown): JoinResult {
  const raw = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | null | undefined;
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  const status = str(raw?.status);
  return {
    // Giá trị lạ → coi như đã vào (server chỉ trả 3 trạng thái)
    status: status === 'PENDING' || status === 'ALREADY_MEMBER' ? status : 'JOINED',
    groupId: str(raw?.group_id),
    groupName: str(raw?.group_name),
    requestId: str(raw?.request_id) || null,
  };
}

/** Câu báo khi yêu cầu tham gia đang chờ duyệt. */
export function joinPendingMessage(groupName: string | null | undefined): string {
  const name = groupName?.trim();
  return `Đã gửi yêu cầu tham gia nhóm ${name ? name : 'này'}. Chờ chủ nhóm duyệt.`;
}

/** Nhãn đường vào của yêu cầu tham gia (cột via do server đặt). */
export function joinViaLabel(via: string | null | undefined): string {
  const v = (via ?? '').toUpperCase();
  if (v.includes('QR')) return 'Qua mã QR';
  if (v.includes('CODE')) return 'Qua mã nhóm';
  if (v.includes('TOKEN') || v.includes('LINK')) return 'Qua link mời';
  if (v.includes('INVITE')) return 'Qua lời mời';
  return v ? `Qua ${via}` : '';
}

/**
 * Lỗi khi duyệt / từ chối / hủy yêu cầu tham gia. NOT_PENDING dùng chung với thanh toán nên câu dịch
 * mặc định nói về thanh toán — ở đây đổi thành câu về yêu cầu tham gia.
 */
export function joinRequestErrorMessage(err: unknown, fallback = 'Có lỗi xảy ra'): string {
  if (getServerErrorCode(err) === 'NOT_PENDING') return 'Yêu cầu này đã được xử lý hoặc đã bị hủy.';
  return toUserMessage(err, fallback);
}

// ============================
// Xóa thành viên khỏi nhóm
// ============================

/** Số dư chính thức: > 0 được nhận lại, < 0 còn nợ (domain/settlement). */
export function balanceLabel(balance: number | null | undefined): string {
  if (balance === null || balance === undefined || !Number.isFinite(balance)) return '';
  const b = Math.round(balance);
  if (b > 0) return `Được nhận ${formatVND(b)}`;
  if (b < 0) return `Còn nợ ${formatVND(-b)}`;
  return 'Đã cân bằng';
}

export type RemoveCheck = { allowed: boolean; reason: string | null };

/**
 * Chủ nhóm chỉ xóa được thành viên đã tất toán: số dư chính thức = 0 và không còn thanh toán PENDING
 * (server vẫn chặn bằng NONZERO_BALANCE / PENDING_PAYMENTS). Chưa biết số dư → chưa cho xóa.
 */
export function canRemoveMember(balance: number | null | undefined, hasPendingPayments: boolean): RemoveCheck {
  if (balance === null || balance === undefined || !Number.isFinite(balance)) {
    return { allowed: false, reason: 'Chưa tải được số dư' };
  }
  const b = Math.round(balance);
  if (b < 0) return { allowed: false, reason: `Còn nợ ${formatVND(-b)}` };
  if (b > 0) return { allowed: false, reason: `Còn được nhận ${formatVND(b)}` };
  if (hasPendingPayments) return { allowed: false, reason: 'Còn thanh toán chờ xác nhận' };
  return { allowed: true, reason: null };
}

/** Người này còn thanh toán PENDING (gửi hoặc nhận) trong danh sách thanh toán của nhóm. */
export function hasPendingPayment(
  payments: readonly { from_id: string; to_id: string; status: string }[] | null | undefined,
  userId: string,
): boolean {
  return (payments ?? []).some((p) => p.status === 'PENDING' && (p.from_id === userId || p.to_id === userId));
}
