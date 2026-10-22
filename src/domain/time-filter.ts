/**
 * MVP-09 (HOME-01): Bộ lọc thời gian cho "Giao dịch gần đây" trên Home.
 * Chỉ lọc danh sách; tổng cần thu / cần trả vẫn là số dư chính thức hiện tại (BR-10).
 */

export type TimeFilter = '7d' | '30d' | 'month' | 'all';

export const TIME_FILTERS: { key: TimeFilter; label: string }[] = [
  { key: '7d', label: '7 ngày' },
  { key: '30d', label: '30 ngày' },
  { key: 'month', label: 'Tháng này' },
  { key: 'all', label: 'Tất cả' },
];

/** Mặc định "Tất cả" để không giao dịch nào bị ẩn mà người dùng không biết. */
export const DEFAULT_TIME_FILTER: TimeFilter = 'all';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Mốc bắt đầu của bộ lọc (giao dịch có thời điểm >= mốc thì hiện); null = không giới hạn.
 * - 7d / 30d: lùi đúng 7 / 30 ngày tính từ `now`
 * - month: 00:00 ngày 1 của tháng hiện tại (giờ máy)
 */
export function filterCutoff(filter: TimeFilter, now: Date): Date | null {
  switch (filter) {
    case '7d':
      return new Date(now.getTime() - 7 * DAY_MS);
    case '30d':
      return new Date(now.getTime() - 30 * DAY_MS);
    case 'month':
      return new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
    case 'all':
    default:
      return null;
  }
}

/** Thời điểm `dateStr` có nằm trong bộ lọc không. Ngày không đọc được thì vẫn hiện (không ẩn âm thầm). */
export function isWithinFilter(dateStr: string | null | undefined, filter: TimeFilter, now: Date): boolean {
  const cutoff = filterCutoff(filter, now);
  if (!cutoff) return true;
  if (!dateStr) return true;
  const t = new Date(dateStr).getTime();
  if (Number.isNaN(t)) return true;
  return t >= cutoff.getTime();
}
