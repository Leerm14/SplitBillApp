// ============================
// Phân loại lỗi từ server (APP-03, APP-05, APP-08)
// ============================
//
// Hợp đồng với backend: lỗi nghiệp vụ có dạng 'CODE: message' (ví dụ
// 'GROUP_CLOSED: Group is closed...'). Mã viết HOA, phân biệt hoa thường.
// Xung đột phiên bản khi sửa khoản chi: code 'PT409', message bắt đầu bằng 'VERSION_CONFLICT'.

/** Lỗi đã chuẩn hóa từ Supabase — giữ nguyên `message`, thêm `code`, `status`. */
export class ApiError extends Error {
  code: string;
  status: number | null;
  details: string | null;
  hint: string | null;

  constructor(message: string, opts: { code?: string; status?: number | null; details?: string | null; hint?: string | null } = {}) {
    super(message);
    this.name = 'ApiError';
    this.code = opts.code ?? '';
    this.status = opts.status ?? null;
    this.details = opts.details ?? null;
    this.hint = opts.hint ?? null;
  }
}

type RawError = { message?: string; code?: string; details?: string | null; hint?: string | null } | null | undefined;

/** Đổi lỗi PostgREST/Storage/Auth thành ApiError (kèm HTTP status nếu có) rồi ném ra. */
export function throwApiError(error: RawError, status?: number | null): never {
  throw new ApiError(error?.message || 'Lỗi không xác định', {
    code: error?.code,
    status: status ?? null,
    details: error?.details ?? null,
    hint: error?.hint ?? null,
  });
}

const SERVER_CODE_RE = /^([A-Z][A-Z0-9_]+):/;

/** APP-03: Mã lỗi nghiệp vụ do RPC raise ('GROUP_CLOSED: ...' → 'GROUP_CLOSED'). Phân biệt hoa thường. */
export function getServerErrorCode(err: unknown): string | null {
  const msg = (err as { message?: unknown })?.message;
  if (typeof msg !== 'string') return null;
  const m = SERVER_CODE_RE.exec(msg.trim());
  return m ? m[1] : null;
}

/** APP-05: Xung đột phiên bản khi sửa khoản chi (BE-02). */
export function isVersionConflict(err: unknown): boolean {
  const e = err as { code?: unknown; message?: unknown } | null;
  return e?.code === 'PT409' || (typeof e?.message === 'string' && e.message.startsWith('VERSION_CONFLICT'));
}

/** Lỗi kết nối: không tới được server (mất mạng, timeout, request bị hủy). */
export function isNetworkError(err: unknown): boolean {
  const e = err as { message?: unknown; name?: unknown; status?: unknown } | null;
  if (!e) return false;
  if (e.status === 0) return true;
  if (e.name === 'AbortError' || e.name === 'TimeoutError') return true;
  const msg = typeof e.message === 'string' ? e.message : '';
  return (
    msg.includes('Network request failed') ||
    msg.includes('Failed to fetch') ||
    msg.includes('fetch failed') ||
    msg.includes('FetchError') ||
    msg.includes('Network Error') ||
    msg.includes('NetworkError') ||
    msg.includes('AbortError') ||
    msg.includes('timed out') ||
    msg.includes('ECONNREFUSED') ||
    msg.includes('ETIMEDOUT')
  );
}

/** Mã nghiệp vụ nhưng nên thử lại (phiên đăng nhập chưa kịp làm mới). */
const RETRYABLE_SERVER_CODES = new Set(['NOT_AUTHENTICATED']);

/**
 * APP-08: Lỗi tạm thời — nên tự thử lại: mất mạng, 5xx, 408/429, lỗi xác thực (JWT hết hạn).
 */
export function isRetryableError(err: unknown): boolean {
  if (isNetworkError(err)) return true;
  const code = getServerErrorCode(err);
  if (code) return RETRYABLE_SERVER_CODES.has(code);

  const e = err as { status?: unknown; code?: unknown; message?: unknown } | null;
  const status = typeof e?.status === 'number' ? e.status : null;
  if (status !== null && (status >= 500 || status === 401 || status === 408 || status === 429)) return true;

  const pgCode = typeof e?.code === 'string' ? e.code : '';
  // PGRST301: JWT hết hạn/không hợp lệ; PGRST303: JWT claims; 57014: statement timeout; 08xxx: lỗi kết nối DB
  if (pgCode === 'PGRST301' || pgCode === 'PGRST303' || pgCode === '57014' || pgCode.startsWith('08')) return true;

  const msg = typeof e?.message === 'string' ? e.message : '';
  return msg.includes('JWT expired') || msg.includes('Invalid Refresh Token');
}

/**
 * APP-08: Lỗi nghiệp vụ — không thử lại tự động, báo người dùng sửa (DEV mục 6.4).
 * Gồm mã 'CODE:' của RPC, lỗi ràng buộc dữ liệu Postgres và HTTP 4xx (trừ 401/408/429).
 */
export function isBusinessError(err: unknown): boolean {
  if (isRetryableError(err)) return false;
  if (getServerErrorCode(err)) return true;
  const e = err as { status?: unknown; code?: unknown } | null;
  const status = typeof e?.status === 'number' ? e.status : null;
  if (status !== null && status >= 400 && status < 500) return true;
  const pgCode = typeof e?.code === 'string' ? e.code : '';
  // P0001: RAISE EXCEPTION; 22xxx: dữ liệu sai; 23xxx: vi phạm ràng buộc; 42501: không có quyền; PT409: xung đột
  return pgCode === 'P0001' || pgCode === 'PT409' || pgCode === '42501' || pgCode.startsWith('22') || pgCode.startsWith('23');
}

/** Thông báo tiếng Việt cho các mã lỗi người dùng hay gặp (hợp đồng mục 4). */
const CODE_MESSAGES: Record<string, string> = {
  NOT_AUTHENTICATED: 'Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.',
  GROUP_NOT_FOUND: 'Không tìm thấy nhóm.',
  GROUP_CLOSED: 'Nhóm đã đóng, không thể thay đổi dữ liệu.',
  NOT_MEMBER: 'Bạn không còn là thành viên của nhóm này.',
  NOT_OWNER: 'Chỉ chủ nhóm mới thực hiện được thao tác này.',
  NOT_AUTHORIZED: 'Bạn không có quyền thực hiện thao tác này.',
  INVALID_NAME: 'Tên nhóm không được để trống.',
  INVALID_AMOUNT: 'Số tiền không hợp lệ.',
  INVALID_SPLIT_METHOD: 'Cách chia không hợp lệ.',
  SHARE_MISMATCH: 'Tổng phần chia không khớp với số tiền khoản chi.',
  SHARE_USER_NOT_MEMBER: 'Có người được chia không còn là thành viên nhóm.',
  PAYER_NOT_MEMBER: 'Người trả không còn là thành viên nhóm.',
  EXPENSE_NOT_FOUND: 'Không tìm thấy khoản chi.',
  EXPENSE_CANCELLED: 'Khoản chi đã bị hủy, không thể sửa.',
  VERSION_CONFLICT: 'Khoản chi vừa được người khác sửa. Vui lòng tải lại.',
  SELF_PAYMENT: 'Không thể tự thanh toán cho chính mình.',
  RECEIVER_NOT_MEMBER: 'Người nhận không còn là thành viên nhóm.',
  PAYMENT_NOT_FOUND: 'Không tìm thấy thanh toán.',
  NOT_RECEIVER: 'Chỉ người nhận mới thực hiện được thao tác này.',
  NOT_SENDER: 'Chỉ người gửi mới hủy được thanh toán này.',
  NOT_PENDING: 'Thanh toán không còn ở trạng thái chờ xác nhận.',
  INVALID_STATUS: 'Trạng thái thanh toán không cho phép thao tác này.',
  REASON_REQUIRED: 'Vui lòng nhập lý do.',
  NONZERO_BALANCE: 'Số dư chưa về 0, cần tất toán trước.',
  PENDING_PAYMENTS: 'Còn thanh toán đang chờ xác nhận.',
  UNSETTLED_BALANCES: 'Còn thành viên chưa tất toán công nợ.',
  OWNER_CANNOT_LEAVE: 'Chủ nhóm cần chuyển quyền trước khi rời nhóm.',
  CANNOT_REMOVE_SELF: 'Chủ nhóm không thể tự xóa mình.',
  TARGET_NOT_MEMBER: 'Người này không còn là thành viên nhóm.',
  ALREADY_OWNER: 'Bạn đã là chủ nhóm.',
  MEMBER_REMOVED: 'Bạn đã bị xóa khỏi nhóm này và không thể tự tham gia lại.',
  INVITE_NOT_FOUND: 'Lời mời không tồn tại.',
  INVITE_CODE_NOT_FOUND: 'Mã mời không đúng.',
  INVITE_REVOKED: 'Lời mời đã bị thu hồi.',
  INVITE_EXPIRED: 'Lời mời đã hết hạn.',
  INVITE_EXHAUSTED: 'Lời mời đã được dùng hết lượt.',
  INVITE_NOT_FOR_YOU: 'Lời mời này không dành cho bạn.',
  QUERY_TOO_SHORT: 'Nhập ít nhất 2 ký tự để tìm.',
  USER_NOT_FOUND: 'Không tìm thấy người dùng.',
  PROFILE_NOT_FOUND: 'Không tìm thấy hồ sơ.',
  ALREADY_FRIENDS: 'Hai bạn đã là bạn bè.',
  ALREADY_PENDING: 'Đã gửi lời mời kết bạn trước đó.',
  SELF_REQUEST: 'Không thể kết bạn với chính mình.',
  // Mã mới từ migration 0010
  INVALID_IDEMPOTENCY_KEY: 'Yêu cầu không hợp lệ. Vui lòng thử lại.',
  IDEMPOTENCY_KEY_REUSED: 'Yêu cầu bị trùng với một thao tác khác. Vui lòng mở lại màn hình và thử lại.',
  IDEMPOTENCY_CONFLICT: 'Yêu cầu bị trùng với một thao tác khác. Vui lòng mở lại màn hình và thử lại.',
  INVALID_SHARES: 'Phần chia không hợp lệ.',
  INVALID_SHARE_AMOUNT: 'Số tiền của một phần chia không hợp lệ.',
  DUPLICATE_SHARE_USER: 'Một người bị chia hai lần trong cùng khoản chi.',
  INVALID_RECEIPT_PATH: 'Ảnh hóa đơn không hợp lệ.',
  PARTICIPANT_NOT_ACTIVE: 'Khoản chi có người đã rời nhóm nên không thể sửa hoặc hủy.',
  INVALID_DISPLAY_NAME: 'Tên hiển thị phải từ 1 đến 100 ký tự.',
  INVALID_AVATAR_PATH: 'Ảnh đại diện không hợp lệ.',
  ACCOUNT_DELETED: 'Tài khoản này đã bị xóa.',
  OWNER_OF_ACTIVE_GROUP: 'Bạn đang là chủ một nhóm. Hãy chuyển quyền chủ nhóm trước khi xóa tài khoản.',
};

/** Câu báo lỗi cho người dùng: ưu tiên mã server → tiếng Việt; lỗi mạng; cuối cùng là message gốc. */
export function toUserMessage(err: unknown, fallback = 'Có lỗi xảy ra'): string {
  const code = getServerErrorCode(err);
  if (code && CODE_MESSAGES[code]) return CODE_MESSAGES[code];
  if (isVersionConflict(err)) return CODE_MESSAGES.VERSION_CONFLICT;
  if (isNetworkError(err)) return 'Không kết nối được máy chủ. Kiểm tra mạng rồi thử lại.';
  const msg = (err as { message?: unknown })?.message;
  if (typeof msg === 'string' && msg.trim()) {
    // Bỏ tiền tố 'CODE: ' của mã chưa có bản dịch
    return code ? msg.trim().slice(code.length + 1).trim() || fallback : msg;
  }
  return fallback;
}
