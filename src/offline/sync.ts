/**
 * Xử lý hàng đợi offline theo DEV mục 6 (APP-08):
 * 1. Ghi vào hàng đợi TRƯỚC (kèm idempotency_key), rồi mới thử gửi ngay.
 * 2. Gửi được → SYNCED. Lỗi mạng / 5xx / xác thực → giữ PENDING ("Chưa đồng bộ"), thử lại có backoff
 *    tính từ lần thử cuối. Lỗi nghiệp vụ → không thử lại, báo người dùng.
 * 3. Mỗi lần gửi lại dùng đúng key cũ nên server trả bản ghi đã có thay vì tạo mới.
 */

import NetInfo from '@react-native-community/netinfo';

import { getSession } from '@/api/auth';
import { getServerErrorCode, isRetryableError } from '@/api/errors';
import { createExpense, uploadReceiptFile, type ExpenseShareInput } from '@/api/expenses';
import {
  cancelPayment,
  confirmPayment,
  createPayment,
  disputePayment,
  fetchPayment,
  rejectPayment,
} from '@/api/payments';
import { formatVND } from '@/domain/money';
import { deleteLocalReceipt, localFileExists } from '@/lib/receipt-files';

import { classifyFailure, isDueForAttempt, queueItemAgeMs } from './policy';
import {
  cleanupOldItems,
  discardForeignItems,
  discardItem,
  enqueue,
  getPendingItems,
  getQueueGeneration,
  getQueueItem,
  markAttemptFailed,
  markFailed,
  markSynced,
  type QueueItem,
} from './queue';

// ----------------------------
// Payload của từng loại thao tác
// ----------------------------

export type CreateExpensePayload = {
  groupId: string;
  paidBy: string;
  amount: number;
  description: string;
  shares: ExpenseShareInput[];
  idempotencyKey: string;
  splitMethod: string;
  note?: string;
  /** MVP-01: `<groupId>/<uuid>/<uuid>.jpg` — tạo một lần cho mỗi form */
  receiptPath?: string;
  /** MVP-01: bản sao ảnh đã nén trong thư mục tài liệu; upload (upsert) trước khi gọi create_expense */
  localReceiptUri?: string;
};

export type CreatePaymentPayload = {
  groupId: string;
  toId: string;
  amount: number;
  note?: string;
  idempotencyKey: string;
};

export type PaymentActionPayload = {
  paymentId: string;
  groupId?: string;
  reason?: string;
};

export type QueueActionMap = {
  create_expense: CreateExpensePayload;
  create_payment: CreatePaymentPayload;
  confirm_payment: PaymentActionPayload;
  reject_payment: PaymentActionPayload;
  dispute_payment: PaymentActionPayload;
  cancel_payment: PaymentActionPayload;
};

export type QueueAction = keyof QueueActionMap;

type ActionHandler = (payload: any) => Promise<unknown>;

/** Trạng thái thanh toán sau khi thao tác đã áp dụng — để nhận ra lần gửi trước đã tới server. */
const PAYMENT_TARGET_STATUS: Partial<Record<QueueAction, string>> = {
  confirm_payment: 'CONFIRMED',
  reject_payment: 'REJECTED',
  dispute_payment: 'DISPUTED',
  cancel_payment: 'CANCELLED',
};

/**
 * MVP-01: Thêm khoản chi kèm ảnh hóa đơn từ hàng đợi.
 * 1. Còn bản sao ảnh trên máy → upload (upsert, cùng đường dẫn nên gửi lại không tạo ảnh mồ côi).
 *    - Lỗi tạm thời (mất mạng…) → ném lỗi để hàng đợi thử lại sau.
 *    - Lỗi khác (không có quyền, file hỏng…) → vẫn lưu khoản chi, không kèm ảnh.
 *    - Không còn bản sao (đã upload + dọn ở lần trước) → giữ receiptPath.
 * 2. create_expense (idempotency key chỉ so nhóm, nên receiptPath khác giữa các lần gửi không gây xung đột).
 * 3. Thành công → xóa bản sao.
 */
async function createExpenseFromQueue(p: CreateExpensePayload): Promise<unknown> {
  const { localReceiptUri, ...params } = p;
  let receiptPath = params.receiptPath;
  if (localReceiptUri && receiptPath && localFileExists(localReceiptUri)) {
    try {
      await uploadReceiptFile(receiptPath, localReceiptUri);
    } catch (error) {
      if (isRetryableError(error)) throw error;
      console.warn('[Queue] Không upload được ảnh hóa đơn, lưu khoản chi không kèm ảnh:', (error as Error)?.message);
      receiptPath = undefined;
    }
  }
  const result = await createExpense({ ...params, receiptPath });
  deleteLocalReceipt(localReceiptUri);
  return result;
}

const ACTION_HANDLERS: Record<QueueAction, ActionHandler> = {
  create_expense: (p: CreateExpensePayload) => createExpenseFromQueue(p),
  // NEW-04: Payload trong hàng đợi dùng camelCase — đổi sang tham số của createPayment
  create_payment: (p: CreatePaymentPayload) =>
    createPayment({
      group_id: p.groupId,
      to_id: p.toId,
      amount: p.amount,
      note: p.note,
      idempotency_key: p.idempotencyKey,
    }),
  confirm_payment: (p: PaymentActionPayload) => confirmPayment(p.paymentId),
  reject_payment: (p: PaymentActionPayload) => rejectPayment(p.paymentId, p.reason),
  dispute_payment: (p: PaymentActionPayload) => disputePayment(p.paymentId, p.reason ?? ''),
  cancel_payment: (p: PaymentActionPayload) => cancelPayment(p.paymentId),
};

/**
 * respond/dispute/cancel không có idempotency key ở server: nếu lần gửi trước đã tới server
 * (request timeout nhưng đã xử lý), lần gửi lại nhận NOT_PENDING/INVALID_STATUS.
 * Khi đó đọc lại thanh toán — đúng trạng thái đích thì coi như đã đồng bộ.
 */
async function alreadyApplied(action: string, payload: any, error: unknown): Promise<boolean> {
  const target = PAYMENT_TARGET_STATUS[action as QueueAction];
  if (!target) return false;
  const code = getServerErrorCode(error);
  if (code !== 'NOT_PENDING' && code !== 'INVALID_STATUS') return false;
  try {
    const p = await fetchPayment(payload.paymentId);
    return p.status === target;
  } catch {
    return false;
  }
}

/** Các mục đang được gửi — lượt đồng bộ nền bỏ qua để không gửi trùng */
const inFlight = new Set<number>();

type SendOutcome =
  | { kind: 'synced'; result: unknown }
  | { kind: 'retry'; error: unknown; message: string }
  | { kind: 'fail'; error: unknown; message: string };

async function sendItem(
  item: Pick<QueueItem, 'id' | 'action' | 'payload' | 'retries'> & Partial<Pick<QueueItem, 'created_at' | 'pending_since'>>,
): Promise<SendOutcome> {
  const handler = ACTION_HANDLERS[item.action as QueueAction];
  if (!handler) {
    const message = `Hành động không xác định: ${item.action}`;
    await markFailed(item.id, message);
    return { kind: 'fail', error: new Error(message), message };
  }

  inFlight.add(item.id);
  try {
    const payload = JSON.parse(item.payload);
    try {
      const result = await handler(payload);
      await markSynced(item.id);
      return { kind: 'synced', result };
    } catch (error) {
      if (await alreadyApplied(item.action, payload, error)) {
        await markSynced(item.id);
        return { kind: 'synced', result: null };
      }
      // REV-A3: lỗi tạm thời cũng có giới hạn số lần / thời gian chờ
      const decision = classifyFailure(error, item.retries, queueItemAgeMs(item, Date.now()));
      if (decision.kind === 'retry') {
        await markAttemptFailed(item.id, decision.message);
        return { kind: 'retry', error, message: decision.message };
      }
      await markFailed(item.id, decision.message);
      return { kind: 'fail', error, message: decision.message };
    }
  } finally {
    inFlight.delete(item.id);
  }
}

export type SubmitResult<T = unknown> =
  | { status: 'synced'; result: T }
  | { status: 'queued' };

/**
 * APP-08: Ghi vào hàng đợi trước, rồi thử gửi ngay.
 * - Gửi được → { status: 'synced', result }
 * - Lỗi mạng/tạm thời → { status: 'queued' }: màn hình báo "Chưa đồng bộ", hàng đợi tự gửi lại
 * - Lỗi nghiệp vụ → bỏ mục khỏi hàng đợi và ném lỗi để màn hình báo người dùng sửa
 */
export async function submitAction<A extends QueueAction>(
  action: A,
  payload: QueueActionMap[A],
  idempotencyKey: string,
  userId: string,
): Promise<SubmitResult> {
  const id = await enqueue(action, payload, idempotencyKey, userId);
  const outcome = await sendItem({ id, action, payload: JSON.stringify(payload), retries: 0 });
  if (outcome.kind === 'synced') return { status: 'synced', result: outcome.result };
  if (outcome.kind === 'retry') return { status: 'queued' };
  // Người dùng đang ở màn hình và thấy lỗi ngay → không để lại mục FAILED trùng thông báo
  await discardItem(id);
  throw outcome.error;
}

// ----------------------------
// Đồng bộ nền
// ----------------------------

export type ProcessResult = { synced: number; failed: number; skipped: number };

/** REV-A2: Phiên hiện tại có đúng là của userId không (đọc phiên đã lưu, không gọi mạng). */
async function isCurrentUser(userId: string): Promise<boolean> {
  try {
    const session = await getSession();
    return session?.user?.id === userId;
  } catch {
    return false;
  }
}

async function runQueue(userId: string, gen: number): Promise<ProcessResult> {
  const result: ProcessResult = { synced: 0, failed: 0, skipped: 0 };
  // REV-A2: hàng đợi bị xóa (đăng xuất) hoặc phiên đã đổi người → dừng ngay
  const stillValid = async () => getQueueGeneration() === gen && (await isCurrentUser(userId));

  const netState = await NetInfo.fetch();
  if (netState.isConnected === false) return result;
  if (!(await stillValid())) return result;

  // APP-02: Không bao giờ gửi thao tác của tài khoản khác bằng phiên hiện tại
  await discardForeignItems(userId);

  const items = await getPendingItems(userId);
  const now = Date.now();

  for (const snapshot of items) {
    if (!(await stillValid())) break;
    // REV-A2: danh sách đọc lúc đầu có thể đã cũ (mục bị bỏ, đã gửi ở màn hình, hàng đợi bị xóa)
    // → đọc lại từng mục ngay trước khi gửi
    const item = await getQueueItem(snapshot.id);
    if (!item || item.status !== 'PENDING' || item.user_id !== userId) {
      result.skipped++;
      continue;
    }
    if (inFlight.has(item.id) || !isDueForAttempt(item, now)) {
      result.skipped++;
      continue;
    }
    const outcome = await sendItem(item);
    if (outcome.kind === 'synced') result.synced++;
    else if (outcome.kind === 'fail') result.failed++;
    else result.skipped++;
  }

  await cleanupOldItems();
  return result;
}

// APP-03: Khóa ở module — mọi nơi gọi processQueue dùng chung một lượt đang chạy.
// REV-A2: chỉ dùng chung khi cùng tài khoản và cùng thế hệ hàng đợi.
type Run = { userId: string; gen: number; promise: Promise<ProcessResult> };
let running: Run | null = null;
// REV-A9: lượt chạy tiếp theo đã hẹn (sau lượt đang chạy) — gộp các yêu cầu trùng
let queuedRun: { userId: string; promise: Promise<ProcessResult> } | null = null;

function startRun(userId: string): Promise<ProcessResult> {
  const gen = getQueueGeneration();
  const promise = runQueue(userId, gen).finally(() => {
    if (running?.promise === promise) running = null;
  });
  running = { userId, gen, promise };
  return promise;
}

/**
 * Xử lý các mục đang chờ của `userId`. Gọi đồng thời sẽ dùng chung một lượt.
 * REV-A9: `followUp` (ví dụ sau khi bấm "Thử lại") — nếu đang có lượt chạy thì hẹn thêm một lượt
 * ngay sau nó, để mục vừa được thử lại chắc chắn được gửi.
 */
export function processQueue(userId: string, opts: { followUp?: boolean } = {}): Promise<ProcessResult> {
  if (!running) return startRun(userId);
  const reusable = running.userId === userId && running.gen === getQueueGeneration() && !opts.followUp;
  if (reusable) return running.promise;
  if (queuedRun && queuedRun.userId === userId) return queuedRun.promise;

  const promise: Promise<ProcessResult> = running.promise
    .catch(() => undefined)
    .then(() => {
      if (queuedRun?.promise === promise) queuedRun = null;
      return processQueue(userId);
    });
  queuedRun = { userId, promise };
  return promise;
}



// ----------------------------
// Hiển thị
// ----------------------------

/** Mô tả ngắn một mục hàng đợi cho người dùng */
export function describeQueueItem(item: Pick<QueueItem, 'action' | 'payload'>): string {
  let p: any = {};
  try {
    p = JSON.parse(item.payload);
  } catch {
    // payload hỏng — vẫn hiện tên thao tác
  }
  const amount = typeof p.amount === 'number' ? ` ${formatVND(p.amount)}` : '';
  switch (item.action) {
    case 'create_expense':
      return `Thêm khoản chi "${p.description ?? ''}"${amount}`;
    case 'create_payment':
      return `Gửi thanh toán${amount}`;
    case 'confirm_payment':
      return 'Xác nhận thanh toán';
    case 'reject_payment':
      return 'Từ chối thanh toán';
    case 'dispute_payment':
      return 'Báo sai lệch thanh toán';
    case 'cancel_payment':
      return 'Hủy thanh toán';
    default:
      return item.action;
  }
}

/** Nhóm của một mục hàng đợi (nếu có) — để màn nhóm hiện "Chưa đồng bộ" */
export function queueItemGroupId(item: Pick<QueueItem, 'payload'>): string | null {
  try {
    const p = JSON.parse(item.payload);
    return typeof p.groupId === 'string' ? p.groupId : null;
  } catch {
    return null;
  }
}
