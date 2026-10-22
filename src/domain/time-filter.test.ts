import { DEFAULT_TIME_FILTER, filterCutoff, isWithinFilter, TIME_FILTERS } from './time-filter';

// 15/03/2026 10:30 giờ máy
const NOW = new Date(2026, 2, 15, 10, 30, 0, 0);
const DAY = 24 * 60 * 60 * 1000;

describe('filterCutoff (MVP-09)', () => {
  test('7 ngày / 30 ngày lùi đúng từ thời điểm hiện tại', () => {
    expect(filterCutoff('7d', NOW)!.getTime()).toBe(NOW.getTime() - 7 * DAY);
    expect(filterCutoff('30d', NOW)!.getTime()).toBe(NOW.getTime() - 30 * DAY);
  });

  test('Tháng này = 00:00 ngày 1 của tháng hiện tại', () => {
    expect(filterCutoff('month', NOW)).toEqual(new Date(2026, 2, 1, 0, 0, 0, 0));
  });

  test('Tất cả = không giới hạn', () => {
    expect(filterCutoff('all', NOW)).toBeNull();
  });
});

describe('isWithinFilter', () => {
  const iso = (d: Date) => d.toISOString();

  test('7 ngày', () => {
    expect(isWithinFilter(iso(new Date(NOW.getTime() - 6 * DAY)), '7d', NOW)).toBe(true);
    expect(isWithinFilter(iso(new Date(NOW.getTime() - 8 * DAY)), '7d', NOW)).toBe(false);
  });

  test('Tháng này: cuối tháng trước bị loại, ngày 1 được giữ', () => {
    expect(isWithinFilter(iso(new Date(2026, 1, 28, 23, 59)), 'month', NOW)).toBe(false);
    expect(isWithinFilter(iso(new Date(2026, 2, 1, 0, 0)), 'month', NOW)).toBe(true);
  });

  test('Tất cả giữ mọi giao dịch; ngày không đọc được không bị ẩn', () => {
    expect(isWithinFilter('2001-01-01T00:00:00Z', 'all', NOW)).toBe(true);
    expect(isWithinFilter('not-a-date', '7d', NOW)).toBe(true);
    expect(isWithinFilter(null, '30d', NOW)).toBe(true);
  });

  test('mặc định "Tất cả" và đủ 4 lựa chọn theo spec', () => {
    expect(DEFAULT_TIME_FILTER).toBe('all');
    expect(TIME_FILTERS.map((f) => f.label)).toEqual(['7 ngày', '30 ngày', 'Tháng này', 'Tất cả']);
  });
});
