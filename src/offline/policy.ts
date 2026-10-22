/**
 * APP-08: Chính sách gửi lại của hàng đợi offline — hàm thuần, kiểm thử được.
 */

import { isBusinessError, isNetworkError, isRetryableError, toUserMessage } from '@/api/errors';

/** Backoff tối đa giữa hai lần thử */
export const MAX_BACKOFF_MS = 5 * 60_000;

/** Lỗi không phân loại được: thử lại tối đa ngần này lần rồi chuyển FAILED (người dùng thử lại được) */
export const MAX_UNKNOWN_RETRIES = 5;

/** Chờ lâu dần: 2s, 4s, 8s, ... tối đa 5 phút */
export function backoffMs(retries: number): number {
  if (retries <= 0) return 0;
  return Math.min(1000 * 2 ** retries, MAX_BACKOFF_MS);
}

/** APP-08: Backoff tính từ lần thử cuối (last_attempt_at), không phải từ lúc tạo. */
export function isDueForAttempt(item: { retries: number; last_attempt_at: number | null }, now: number): boolean {
  if (item.retries <= 0 || item.last_attempt_at == null) return true;
  return now - item.last_attempt_at >= backoffMs(item.retries);
}

/** REV-A3: Lỗi tạm thời không phải mất mạng (5xx, xác thực…): tối đa ngần này lần gửi rồi FAILED */
export const MAX_RETRYABLE_ATTEMPTS = 8;

/** REV-A3: Mục chờ quá lâu (kể cả vì mất mạng) → FAILED để người dùng tự quyết Thử lại / Bỏ */
export const MAX_PENDING_AGE_MS = 24 * 60 * 60_000;

/**
 * REV-A3: Mục đã chờ bao lâu: tính từ pending_since (epoch ms, đặt lại khi người dùng bấm "Thử lại"),
 * mục cũ chưa có cột này thì từ created_at (SQLite datetime('now'): 'YYYY-MM-DD HH:MM:SS', giờ UTC).
 */
export function queueItemAgeMs(item: { created_at?: string | null; pending_since?: number | null }, now: number): number {
  if (typeof item.pending_since === 'number') return Math.max(0, now - item.pending_since);
  const raw = item.created_at;
  if (!raw) return 0;
  const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(raw) ? `${raw.replace(' ', 'T')}Z` : raw;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? Math.max(0, now - t) : 0;
}

export type FailureDecision =
  | { kind: 'retry'; message: string }
  | { kind: 'fail'; message: string };

/**
 * Phân loại lỗi khi gửi một mục:
 * - mạng → thử lại (có backoff) cho tới khi mục quá MAX_PENDING_AGE_MS (REV-A3)
 * - 5xx / xác thực → thử lại tối đa MAX_RETRYABLE_ATTEMPTS lần hoặc tới MAX_PENDING_AGE_MS (REV-A3)
 * - lỗi nghiệp vụ ('CODE: ...', ràng buộc dữ liệu, 4xx) → FAILED, không tự thử lại
 * - không rõ → thử lại tối đa MAX_UNKNOWN_RETRIES lần rồi FAILED
 */
export function classifyFailure(error: unknown, retriesSoFar: number, ageMs = 0): FailureDecision {
  const tooOld = ageMs >= MAX_PENDING_AGE_MS;
  if (isNetworkError(error)) {
    if (tooOld) return { kind: 'fail', message: 'Không gửi được trong 24 giờ (mất kết nối). Thử lại hoặc bỏ thao tác.' };
    return { kind: 'retry', message: 'Chưa có kết nối mạng' };
  }
  if (isRetryableError(error)) {
    const message = toUserMessage(error, 'Máy chủ tạm thời lỗi');
    if (tooOld || retriesSoFar + 1 >= MAX_RETRYABLE_ATTEMPTS) {
      return { kind: 'fail', message: `Đã thử gửi nhiều lần không thành công: ${message}` };
    }
    return { kind: 'retry', message };
  }
  if (isBusinessError(error)) return { kind: 'fail', message: toUserMessage(error) };
  if (retriesSoFar + 1 >= MAX_UNKNOWN_RETRIES) return { kind: 'fail', message: toUserMessage(error) };
  return { kind: 'retry', message: toUserMessage(error) };
}
