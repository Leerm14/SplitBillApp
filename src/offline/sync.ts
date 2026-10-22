/**
 * Xử lý hàng đợi offline — gửi lại khi có mạng, exponential backoff.
 */

import NetInfo from '@react-native-community/netinfo';
import { getPendingItems, markSynced, markFailed, retryItem, getQueueItem } from './queue';
import { createExpense } from '@/api/expenses';
import { createPayment, confirmPayment, rejectPayment, disputePayment, cancelPayment } from '@/api/payments';
import { supabase } from '@/lib/supabase';

type ActionHandler = (payload: any) => Promise<any>;

const ACTION_HANDLERS: Record<string, ActionHandler> = {
  create_expense: (p) => createExpense(p),
  // SEC-01: Use RPC for create_payment
  create_payment: async (params) => {
    const { data, error } = await supabase.rpc('create_payment', params);
    if (error) throw error;
    return data;
  },
  confirm_payment: (p) => confirmPayment(p.paymentId),
  reject_payment: (p) => rejectPayment(p.paymentId, p.reason),
  dispute_payment: (p) => disputePayment(p.paymentId, p.reason),
  cancel_payment: (p) => cancelPayment(p.paymentId),
};

/** Lỗi nghiệp vụ (không retry) vs lỗi mạng (retry) */
function isNetworkError(error: any): boolean {
  const msg = String(error?.message || '').toLowerCase();
  return (
    msg.includes('network') ||
    msg.includes('timeout') ||
    msg.includes('fetch') ||
    msg.includes('failed to fetch') ||
    msg.includes('aborted') ||
    msg.includes('econnrefused')
  );
}

/**
 * APP-03: Determine if error is a business error (should not be retried).
 * 5xx and auth errors are retryable, not business errors.
 */
function isBusinessError(message: string): boolean {
  // 5xx and auth errors are retryable
  const retryablePatterns = ['500', '502', '503', '504', 'jwt', 'token', 'refresh'];
  if (retryablePatterns.some(p => message.toLowerCase().includes(p))) {
    return false;
  }

  const businessPatterns = [
    'not a member',
    'permission denied',
    'already exists',
    'invalid',
    'không phải thành viên',
    'không có quyền',
    'version_conflict',
    'CLOSED',
  ];
  return businessPatterns.some((p) => message.toLowerCase().includes(p));
}

/**
 * APP-03: Safe markFailed that doesn't overwrite SYNCED status.
 */
async function safeMarkFailed(id: number, message: string): Promise<void> {
  // APP-03: Don't overwrite SYNCED status
  const current = await getQueueItem(id);
  if (current?.status === 'SYNCED') return;

  await markFailed(id, message);
}

/** Xử lý tất cả mục đang chờ */
export async function processQueue(): Promise<{ synced: number; failed: number; skipped: number }> {
  const netState = await NetInfo.fetch();
  if (!netState.isConnected) {
    return { synced: 0, failed: 0, skipped: 0 };
  }

  const items = await getPendingItems();
  let synced = 0;
  let failed = 0;
  let skipped = 0;

  for (const item of items) {
    const handler = ACTION_HANDLERS[item.action];
    if (!handler) {
      await safeMarkFailed(item.id, `Hành động không xác định: ${item.action}`);
      failed++;
      continue;
    }

    // Exponential backoff: bỏ qua nếu retry quá sớm
    if (item.retries > 0) {
      const backoffMs = Math.min(1000 * Math.pow(2, item.retries), 300_000); // max 5 phút
      const createdMs = new Date(item.created_at).getTime();
      if (Date.now() - createdMs < backoffMs) {
        skipped++;
        continue;
      }
    }

    try {
      const payload = JSON.parse(item.payload);
      await handler(payload);
      await markSynced(item.id);
      synced++;
    } catch (error: any) {
      const errorMsg = error.message || 'Lỗi không xác định';
      if (isNetworkError(error)) {
        // Lỗi mạng — tăng retry count nhưng giữ PENDING
        await safeMarkFailed(item.id, 'Lỗi kết nối mạng');
        if (item.retries < 10) {
          await retryItem(item.id);
        }
        skipped++;
      } else if (isBusinessError(errorMsg)) {
        // Lỗi nghiệp vụ — đánh dấu FAILED, không thử lại
        await safeMarkFailed(item.id, errorMsg);
        failed++;
      } else {
        // Unknown error — retry
        await safeMarkFailed(item.id, errorMsg);
        if (item.retries < 10) {
          await retryItem(item.id);
        }
        skipped++;
      }
    }
  }

  return { synced, failed, skipped };
}
