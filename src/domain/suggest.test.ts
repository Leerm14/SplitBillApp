import type { ExpenseInput } from './settlement';
import { assertZeroSum, computeGroupSettlement, describeMyPosition, isSimplifyEnabled, pendingTotals, suggestTransfers } from './suggest';
import { formatVND } from './money';

// Tình huống mục 2 tài liệu BA: A trả 90.000đ, B trả 45.000đ, chia đều 3 người
const expenses: ExpenseInput[] = [
  { paidBy: 'A', status: 'ACTIVE', shares: [{ userId: 'A', amount: 30_000 }, { userId: 'B', amount: 30_000 }, { userId: 'C', amount: 30_000 }] },
  { paidBy: 'B', status: 'ACTIVE', shares: [{ userId: 'A', amount: 15_000 }, { userId: 'B', amount: 15_000 }, { userId: 'C', amount: 15_000 }] },
];
const members = ['A', 'B', 'C'];

describe('suggestTransfers (APP-06)', () => {
  test('simplify_debts NULL được hiểu là bật (BR-09)', () => {
    expect(isSimplifyEnabled(null)).toBe(true);
    expect(isSimplifyEnabled(undefined)).toBe(true);
    expect(suggestTransfers(members, expenses, [], null)).toEqual([{ from: 'C', to: 'A', amount: 45_000 }]);
  });

  test('simplify_debts = true → AC-01.1', () => {
    expect(suggestTransfers(members, expenses, [], true)).toEqual([{ from: 'C', to: 'A', amount: 45_000 }]);
  });

  test('simplify_debts = false → từng cặp, AC-05.1', () => {
    const t = suggestTransfers(members, expenses, [], false);
    expect(t).toHaveLength(3);
    expect(t).toEqual(
      expect.arrayContaining([
        { from: 'C', to: 'A', amount: 30_000 },
        { from: 'C', to: 'B', amount: 15_000 },
        { from: 'B', to: 'A', amount: 15_000 },
      ]),
    );
  });

  test('Thanh toán PENDING làm gợi ý biến mất (BR-06, AC-03.1)', () => {
    const t = suggestTransfers(members, expenses, [{ fromId: 'C', toId: 'A', amount: 45_000, status: 'PENDING' }], true);
    expect(t).toEqual([]);
    const s = computeGroupSettlement(members, expenses, [{ fromId: 'C', toId: 'A', amount: 45_000, status: 'PENDING' }], true);
    expect(s.officialBal.get('C')).toBe(-45_000);
  });

  test('Người không có trong danh sách → ném lỗi, không nuốt (APP-01)', () => {
    expect(() => suggestTransfers(['A', 'B'], expenses, [], true)).toThrow();
  });
});

describe('assertZeroSum (BR-02)', () => {
  test('Tổng ≠ 0 → ném lỗi', () => {
    expect(() => assertZeroSum(new Map([['A', 10], ['B', -9]]))).toThrow('BR-02');
  });
  test('Tổng = 0 → không lỗi', () => {
    expect(() => assertZeroSum(new Map([['A', 10], ['B', -10]]))).not.toThrow();
  });
});

describe('REV-S6: describeMyPosition (AC-01.1, §6 ví dụ 2)', () => {
  test('AC-01.1: B có số dư 0, không có khoản chờ → "Bạn đã cân bằng"', () => {
    expect(describeMyPosition({ official: 0, projected: 0, pendingReceived: 0, pendingSent: 0 }, formatVND)).toBe(
      'Bạn đã cân bằng',
    );
  });

  test('Ví dụ 2 — người nhận A: "Cần thu 400.000đ, trong đó 300.000đ chờ bạn xác nhận"', () => {
    const pending = pendingTotals([
      { fromId: 'B', toId: 'A', amount: 200_000, status: 'CONFIRMED' },
      { fromId: 'C', toId: 'A', amount: 300_000, status: 'PENDING' },
    ]);
    expect(pending.get('A')).toEqual({ sent: 0, received: 300_000 });
    expect(
      describeMyPosition(
        { official: 400_000, projected: 100_000, pendingReceived: 300_000, pendingSent: 0 },
        formatVND,
      ),
    ).toBe('Cần thu 400.000đ, trong đó 300.000đ chờ bạn xác nhận');
  });

  test('Ví dụ 2 — người gửi C (dự kiến 0, còn khoản chờ) không bị nói là cân bằng', () => {
    const text = describeMyPosition({ official: -300_000, projected: 0, pendingReceived: 0, pendingSent: 300_000 }, formatVND);
    expect(text).not.toContain('cân bằng');
    expect(text).toContain('300.000đ');
  });

  test('Người nợ: "Cần trả" theo số dư dự kiến', () => {
    expect(describeMyPosition({ official: -100_000, projected: -100_000, pendingReceived: 0, pendingSent: 0 }, formatVND)).toBe(
      'Cần trả 100.000đ',
    );
  });
});
