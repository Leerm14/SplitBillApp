import {
  computeBalances,
  simplifyDebts,
  ExpenseInput,
  PaymentInput,
  Transfer,
} from './settlement';

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Tổng các số dư phải bằng 0. */
function assertZeroSum(balances: Map<string, number>) {
  let sum = 0;
  for (const v of balances.values()) sum += v;
  expect(sum).toBe(0);
}

/** Sau khi thực hiện tất cả lần chuyển, mọi số dư phải về 0. */
function assertSettlesAll(balances: Map<string, number>, transfers: Transfer[]) {
  // Clone balances — chú ý transfer.from là người trả nợ (số dư âm → chuyển tiền → số dư tăng)
  // transfer.to là người được nhận (số dư dương → nhận tiền → số dư giảm)
  const bal = new Map(balances);
  for (const t of transfers) {
    bal.set(t.from, bal.get(t.from)! + t.amount); // người trả nợ: số dư tăng (bớt nợ)
    bal.set(t.to, bal.get(t.to)! - t.amount);     // người được nhận: số dư giảm (đã thu)
  }
  for (const [, v] of bal) {
    expect(v).toBe(0);
  }
}

/** Đếm số lần chuyển tối thiểu theo brute-force (dùng cho kiểm chứng nhóm nhỏ). */
function bruteForceMinTransfers(balances: Map<string, number>): number {
  const nonZero = [...balances.values()].filter((v) => v !== 0);
  if (nonZero.length === 0) return 0;

  // Với nhóm nhỏ, dùng bitmask DP như thuật toán chính
  const n = nonZero.length;
  const full = (1 << n) - 1;
  const total = new Float64Array(1 << n);
  const dp = new Int32Array(1 << n);

  for (let mask = 1; mask <= full; mask++) {
    const low = 31 - Math.clz32(mask & -mask);
    total[mask] = total[mask & (mask - 1)] + nonZero[low];
    let best = 0;
    for (let i = 0; i < n; i++) {
      if (mask & (1 << i)) best = Math.max(best, dp[mask ^ (1 << i)]);
    }
    dp[mask] = best + (total[mask] === 0 ? 1 : 0);
  }
  // Số lần chuyển tối thiểu = số người còn số dư − số nhóm con tổng-0 nhiều nhất
  return n - dp[full];
}

// ─── Ví dụ từ tài liệu BA ─────────────────────────────────────────────────

describe('computeBalances', () => {
  test('Ví dụ 1 — A, B, C ăn 2 bữa (BA mục 2)', () => {
    const members = ['A', 'B', 'C'];
    const expenses: ExpenseInput[] = [
      {
        paidBy: 'A',
        status: 'ACTIVE',
        shares: [
          { userId: 'A', amount: 30_000 },
          { userId: 'B', amount: 30_000 },
          { userId: 'C', amount: 30_000 },
        ],
      },
      {
        paidBy: 'B',
        status: 'ACTIVE',
        shares: [
          { userId: 'A', amount: 15_000 },
          { userId: 'B', amount: 15_000 },
          { userId: 'C', amount: 15_000 },
        ],
      },
    ];

    const bal = computeBalances(members, expenses, []);
    expect(bal.get('A')).toBe(45_000);
    expect(bal.get('B')).toBe(0);
    expect(bal.get('C')).toBe(-45_000);
    assertZeroSum(bal);
  });

  test('Ví dụ 2 — Thanh toán một phần và đang chờ xác nhận (BA mục 6)', () => {
    const members = ['A', 'B', 'C'];
    const expenses: ExpenseInput[] = [
      {
        paidBy: 'A',
        status: 'ACTIVE',
        shares: [
          { userId: 'A', amount: 300_000 },
          { userId: 'B', amount: 300_000 },
          { userId: 'C', amount: 300_000 },
        ],
      },
    ];
    const payments: PaymentInput[] = [
      { fromId: 'B', toId: 'A', amount: 200_000, status: 'CONFIRMED' },
      { fromId: 'C', toId: 'A', amount: 300_000, status: 'PENDING' },
    ];

    // Số dư chính thức (không tính PENDING)
    const official = computeBalances(members, expenses, payments);
    expect(official.get('A')).toBe(400_000);
    expect(official.get('B')).toBe(-100_000);
    expect(official.get('C')).toBe(-300_000);
    assertZeroSum(official);

    // Số dư dự kiến (tính cả PENDING)
    const projected = computeBalances(members, expenses, payments, { includePending: true });
    expect(projected.get('A')).toBe(100_000);
    expect(projected.get('B')).toBe(-100_000);
    expect(projected.get('C')).toBe(0);
    assertZeroSum(projected);
  });

  test('Bỏ qua khoản chi đã hủy', () => {
    const members = ['A', 'B'];
    const expenses: ExpenseInput[] = [
      {
        paidBy: 'A',
        status: 'CANCELLED',
        shares: [
          { userId: 'A', amount: 50_000 },
          { userId: 'B', amount: 50_000 },
        ],
      },
    ];
    const bal = computeBalances(members, expenses, []);
    expect(bal.get('A')).toBe(0);
    expect(bal.get('B')).toBe(0);
  });

  test('Bỏ qua thanh toán REJECTED, DISPUTED, CANCELLED', () => {
    const members = ['A', 'B'];
    const expenses: ExpenseInput[] = [
      {
        paidBy: 'A',
        status: 'ACTIVE',
        shares: [
          { userId: 'A', amount: 50_000 },
          { userId: 'B', amount: 50_000 },
        ],
      },
    ];
    const payments: PaymentInput[] = [
      { fromId: 'B', toId: 'A', amount: 50_000, status: 'REJECTED' },
      { fromId: 'B', toId: 'A', amount: 50_000, status: 'DISPUTED' },
      { fromId: 'B', toId: 'A', amount: 50_000, status: 'CANCELLED' },
    ];
    const bal = computeBalances(members, expenses, payments);
    // Thanh toán bị từ chối/tranh chấp/hủy → không tính
    expect(bal.get('A')).toBe(50_000);
    expect(bal.get('B')).toBe(-50_000);
  });

  test('Nhóm trống — tất cả số dư bằng 0', () => {
    const bal = computeBalances(['A', 'B'], [], []);
    expect(bal.get('A')).toBe(0);
    expect(bal.get('B')).toBe(0);
  });

  test('Throw nếu userId không phải thành viên', () => {
    const expenses: ExpenseInput[] = [
      {
        paidBy: 'X',
        status: 'ACTIVE',
        shares: [{ userId: 'X', amount: 100 }],
      },
    ];
    expect(() => computeBalances(['A'], expenses, [])).toThrow('Không phải thành viên nhóm');
  });
});

// ─── simplifyDebts ──────────────────────────────────────────────────────────

describe('simplifyDebts', () => {
  test('Ví dụ 1 — C→A 45.000đ (BA mục 6.1)', () => {
    const bal = new Map([
      ['A', 45_000],
      ['B', 0],
      ['C', -45_000],
    ]);
    const transfers = simplifyDebts(bal);
    expect(transfers).toHaveLength(1);
    expect(transfers[0]).toEqual({ from: 'C', to: 'A', amount: 45_000 });
    assertSettlesAll(bal, transfers);
  });

  test('Ví dụ 3 — Tách nhóm con {A,C,D} và {B,E}: 3 lần chuyển (BA mục 6.3)', () => {
    const bal = new Map([
      ['A', 40_000],
      ['B', 30_000],
      ['C', -20_000],
      ['D', -20_000],
      ['E', -30_000],
    ]);
    const transfers = simplifyDebts(bal);
    expect(transfers).toHaveLength(3);
    assertSettlesAll(bal, transfers);
    // Kiểm tra đúng tối ưu
    expect(transfers.length).toBe(bruteForceMinTransfers(bal));
  });

  test('AC-01.2 — Số dư +40k, +30k, −20k, −20k, −30k → đúng 3 lần chuyển', () => {
    const bal = new Map([
      ['u1', 40_000],
      ['u2', 30_000],
      ['u3', -20_000],
      ['u4', -20_000],
      ['u5', -30_000],
    ]);
    const transfers = simplifyDebts(bal);
    expect(transfers).toHaveLength(3);
    assertSettlesAll(bal, transfers);
  });

  test('Mọi số dư bằng 0 → không có gợi ý', () => {
    const bal = new Map([
      ['A', 0],
      ['B', 0],
    ]);
    const transfers = simplifyDebts(bal);
    expect(transfers).toHaveLength(0);
  });

  test('Tập rỗng → không có gợi ý', () => {
    const transfers = simplifyDebts(new Map());
    expect(transfers).toHaveLength(0);
  });

  test('2 người — 1 lần chuyển', () => {
    const bal = new Map([
      ['A', 100_000],
      ['B', -100_000],
    ]);
    const transfers = simplifyDebts(bal);
    expect(transfers).toHaveLength(1);
    expect(transfers[0]).toEqual({ from: 'B', to: 'A', amount: 100_000 });
    assertSettlesAll(bal, transfers);
  });

  test('3 người, tất cả nợ lẫn nhau — 2 lần chuyển', () => {
    const bal = new Map([
      ['A', 50_000],
      ['B', -20_000],
      ['C', -30_000],
    ]);
    const transfers = simplifyDebts(bal);
    expect(transfers).toHaveLength(2);
    assertSettlesAll(bal, transfers);
    expect(transfers.length).toBe(bruteForceMinTransfers(bal));
  });

  test('Throw nếu tổng khác 0', () => {
    const bal = new Map([
      ['A', 100],
      ['B', -50],
    ]);
    expect(() => simplifyDebts(bal)).toThrow('Tổng số dư phải bằng 0');
  });

  test('Throw nếu số dư không phải số nguyên', () => {
    const bal = new Map([
      ['A', 100.5],
      ['B', -100.5],
    ]);
    expect(() => simplifyDebts(bal)).toThrow('Số dư không phải số nguyên VND');
  });

  // ─── BR-05: Determinism ────────────────────────────────────────────────

  test('BR-05 — Cùng dữ liệu luôn cho cùng gợi ý', () => {
    const bal = new Map([
      ['A', 40_000],
      ['B', 30_000],
      ['C', -20_000],
      ['D', -20_000],
      ['E', -30_000],
    ]);
    const first = simplifyDebts(bal);
    for (let i = 0; i < 20; i++) {
      const again = simplifyDebts(new Map(bal));
      expect(again).toEqual(first);
    }
  });

  // ─── Kiểm thử ngẫu nhiên ─────────────────────────────────────────────

  test('100 bộ số dư ngẫu nhiên (2–8 người) — luôn tối ưu', () => {
    const rng = mulberry32(42); // PRNG cố định cho test lặp lại được
    let optimalCount = 0;

    for (let t = 0; t < 100; t++) {
      const n = 2 + Math.floor(rng() * 7); // 2–8 người
      const ids = Array.from({ length: n }, (_, i) => `p${i}`);
      const amounts = ids.map(() => Math.floor(rng() * 200_000) - 100_000);
      // Điều chỉnh để tổng bằng 0
      amounts[0] -= amounts.reduce((a, b) => a + b, 0);

      const bal = new Map(ids.map((id, i) => [id, amounts[i]]));
      const transfers = simplifyDebts(bal);
      assertSettlesAll(bal, transfers);

      const optimal = bruteForceMinTransfers(bal);
      expect(transfers.length).toBe(optimal);
      optimalCount++;
    }
    expect(optimalCount).toBe(100);
  });

  // ─── Tích hợp: computeBalances → simplifyDebts ───────────────────────

  test('AC-01.3 — Mọi lần chuyển được thực hiện → số dư mọi thành viên bằng 0', () => {
    const members = ['A', 'B', 'C'];
    const expenses: ExpenseInput[] = [
      {
        paidBy: 'A',
        status: 'ACTIVE',
        shares: [
          { userId: 'A', amount: 30_000 },
          { userId: 'B', amount: 30_000 },
          { userId: 'C', amount: 30_000 },
        ],
      },
      {
        paidBy: 'B',
        status: 'ACTIVE',
        shares: [
          { userId: 'A', amount: 15_000 },
          { userId: 'B', amount: 15_000 },
          { userId: 'C', amount: 15_000 },
        ],
      },
    ];
    const bal = computeBalances(members, expenses, []);
    const transfers = simplifyDebts(bal);
    assertSettlesAll(bal, transfers);
  });

  test('Gợi ý cập nhật khi khoản chi thay đổi (AC-06.1)', () => {
    const members = ['A', 'B', 'C'];
    // Trước khi hủy: A trả 90k, B trả 45k
    const expenses: ExpenseInput[] = [
      {
        paidBy: 'A',
        status: 'ACTIVE',
        shares: [
          { userId: 'A', amount: 30_000 },
          { userId: 'B', amount: 30_000 },
          { userId: 'C', amount: 30_000 },
        ],
      },
      {
        paidBy: 'B',
        status: 'ACTIVE',
        shares: [
          { userId: 'A', amount: 15_000 },
          { userId: 'B', amount: 15_000 },
          { userId: 'C', amount: 15_000 },
        ],
      },
    ];

    const bal1 = computeBalances(members, expenses, []);
    const t1 = simplifyDebts(bal1);
    expect(t1).toHaveLength(1);
    expect(t1[0]).toEqual({ from: 'C', to: 'A', amount: 45_000 });

    // Sau khi hủy khoản chi của B
    expenses[1].status = 'CANCELLED';
    const bal2 = computeBalances(members, expenses, []);
    const t2 = simplifyDebts(bal2);
    // Giờ chỉ còn A trả 90k chia đều: B→A 30k, C→A 30k
    expect(t2).toHaveLength(2);
    assertSettlesAll(bal2, t2);
    expect(t2).toEqual(
      expect.arrayContaining([
        { from: 'B', to: 'A', amount: 30_000 },
        { from: 'C', to: 'A', amount: 30_000 },
      ]),
    );
  });
});

// ─── Deterministic PRNG (Mulberry32) ────────────────────────────────────────

function mulberry32(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
