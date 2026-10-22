import { ApiError } from '@/api/errors';
import {
  backoffMs,
  classifyFailure,
  isDueForAttempt,
  MAX_BACKOFF_MS,
  MAX_PENDING_AGE_MS,
  MAX_RETRYABLE_ATTEMPTS,
  MAX_UNKNOWN_RETRIES,
  queueItemAgeMs,
} from './policy';

describe('APP-08: backoff tính từ lần thử cuối', () => {
  test('Mục mới hoặc chưa thử → gửi ngay', () => {
    expect(isDueForAttempt({ retries: 0, last_attempt_at: null }, 1_000)).toBe(true);
  });

  test('Chưa đủ thời gian chờ → bỏ qua', () => {
    const last = 1_000_000;
    expect(isDueForAttempt({ retries: 3, last_attempt_at: last }, last + backoffMs(3) - 1)).toBe(false);
    expect(isDueForAttempt({ retries: 3, last_attempt_at: last }, last + backoffMs(3))).toBe(true);
  });

  test('Backoff tăng dần và có trần', () => {
    expect(backoffMs(1)).toBeLessThan(backoffMs(2));
    expect(backoffMs(50)).toBe(MAX_BACKOFF_MS);
  });
});

describe('APP-08: phân loại lỗi khi gửi lại', () => {
  test('Mất mạng → thử lại, không giới hạn số lần', () => {
    expect(classifyFailure(new TypeError('Network request failed'), 100).kind).toBe('retry');
    expect(classifyFailure(new ApiError('TypeError: Network request failed'), 0).kind).toBe('retry');
  });

  test('5xx và lỗi xác thực → thử lại', () => {
    expect(classifyFailure(new ApiError('upstream error', { status: 503 }), 0).kind).toBe('retry');
    expect(classifyFailure(new ApiError('JWT expired', { code: 'PGRST301', status: 401 }), 0).kind).toBe('retry');
  });

  test('Lỗi nghiệp vụ "CODE: ..." → FAILED, báo tiếng Việt', () => {
    const d = classifyFailure(new ApiError('GROUP_CLOSED: Group is closed.', { code: 'P0001', status: 400 }), 0);
    expect(d).toEqual({ kind: 'fail', message: 'Nhóm đã đóng, không thể thay đổi dữ liệu.' });
  });

  test('Lỗi không rõ → thử lại có giới hạn rồi FAILED (người dùng thử lại được)', () => {
    const err = new Error('???');
    expect(classifyFailure(err, 0).kind).toBe('retry');
    expect(classifyFailure(err, MAX_UNKNOWN_RETRIES - 1).kind).toBe('fail');
  });
});

describe('REV-A3: lỗi tạm thời không được thử lại mãi', () => {
  test('5xx: sau MAX_RETRYABLE_ATTEMPTS lần → FAILED', () => {
    const err = new ApiError('upstream error', { status: 503 });
    expect(classifyFailure(err, MAX_RETRYABLE_ATTEMPTS - 2).kind).toBe('retry');
    expect(classifyFailure(err, MAX_RETRYABLE_ATTEMPTS - 1).kind).toBe('fail');
  });

  test('Mục chờ quá 24 giờ → FAILED (kể cả mất mạng)', () => {
    expect(classifyFailure(new TypeError('Network request failed'), 0, MAX_PENDING_AGE_MS).kind).toBe('fail');
    expect(classifyFailure(new ApiError('upstream error', { status: 503 }), 0, MAX_PENDING_AGE_MS).kind).toBe('fail');
    expect(classifyFailure(new TypeError('Network request failed'), 0, MAX_PENDING_AGE_MS - 1).kind).toBe('retry');
  });

  test('Tuổi mục: ưu tiên pending_since, mục cũ dùng created_at (UTC của SQLite)', () => {
    const now = Date.parse('2026-10-22T12:00:00Z');
    expect(queueItemAgeMs({ pending_since: now - 5_000, created_at: '2020-01-01 00:00:00' }, now)).toBe(5_000);
    expect(queueItemAgeMs({ pending_since: null, created_at: '2026-10-22 11:00:00' }, now)).toBe(3_600_000);
    expect(queueItemAgeMs({ created_at: 'không hợp lệ' }, now)).toBe(0);
  });
});
