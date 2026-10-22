/**
 * Split Bill — tính số dư ròng và gợi ý tất toán với số lần chuyển ít nhất.
 * Mọi số tiền là số nguyên VND. Số dư > 0: được nhận lại; < 0: phải trả.
 */

export type ExpenseInput = {
  paidBy: string;
  status: 'ACTIVE' | 'CANCELLED';
  shares: { userId: string; amount: number }[]; // tổng shares === tổng hóa đơn (đã làm tròn ở bước chia)
};

export type PaymentStatus = 'PENDING' | 'CONFIRMED' | 'REJECTED' | 'DISPUTED' | 'CANCELLED';

export type PaymentInput = {
  fromId: string;
  toId: string;
  amount: number;
  status: PaymentStatus;
};

export type Transfer = { from: string; to: string; amount: number };

/** Nhóm có tối đa ngần này người còn số dư khác 0 thì dùng thuật toán chính xác (2^n). */
const EXACT_LIMIT = 20;

/**
 * Số dư ròng của từng thành viên trong MỘT nhóm:
 *   số dư = Σ đã trả hộ − Σ phần phải chịu + Σ thanh toán đã gửi − Σ thanh toán đã nhận
 * Mặc định chỉ tính thanh toán CONFIRMED. includePending = true dùng cho "số dư dự kiến",
 * để gợi ý tất toán không bảo người ta chuyển lại khoản đang chờ xác nhận.
 */
export function computeBalances(
  memberIds: string[],
  expenses: ExpenseInput[],
  payments: PaymentInput[],
  opts: { includePending?: boolean } = {},
): Map<string, number> {
  const bal = new Map<string, number>(memberIds.map((id) => [id, 0]));
  const add = (id: string, v: number) => {
    if (!bal.has(id)) throw new Error(`Không phải thành viên nhóm: ${id}`);
    bal.set(id, bal.get(id)! + v);
  };

  for (const e of expenses) {
    if (e.status !== 'ACTIVE') continue;
    let total = 0;
    for (const s of e.shares) {
      add(s.userId, -s.amount);
      total += s.amount;
    }
    add(e.paidBy, total);
  }

  for (const p of payments) {
    const counted = p.status === 'CONFIRMED' || (opts.includePending && p.status === 'PENDING');
    if (!counted) continue;
    add(p.fromId, p.amount);
    add(p.toId, -p.amount);
  }
  return bal;
}

/**
 * Gợi ý danh sách chuyển tiền để mọi số dư về 0 với số lần chuyển ít nhất.
 *
 * Số lần chuyển tối thiểu = (số người có số dư ≠ 0) − (số nhóm con tổng bằng 0 nhiều nhất có thể tách ra).
 * Bài toán tổng quát là NP-khó, nên:
 *   - n ≤ EXACT_LIMIT: quy hoạch động trên bitmask, cho kết quả tối ưu.
 *   - n lớn hơn: ghép các cặp bằng nhau trước rồi tham lam (≤ n − 1 lần chuyển, gần tối ưu).
 * Kết quả xác định (deterministic): cùng số dư luôn ra cùng gợi ý.
 */
export function simplifyDebts(balances: Map<string, number>): Transfer[] {
  const people = [...balances.entries()]
    .filter(([, v]) => v !== 0)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  let sum = 0;
  for (const [id, v] of people) {
    if (!Number.isSafeInteger(v)) throw new Error(`Số dư không phải số nguyên VND: ${id}`);
    sum += v;
  }
  if (sum !== 0) throw new Error(`Tổng số dư phải bằng 0, đang là ${sum}`);
  if (people.length === 0) return [];

  if (people.length > EXACT_LIMIT) return pairEqualsFirst(people);
  return splitZeroSumGroups(people).flatMap(greedySettle);
}

/** Tách tập người thành nhiều nhóm con tổng bằng 0 nhất có thể (tối ưu). */
function splitZeroSumGroups(people: [string, number][]): [string, number][][] {
  const n = people.length;
  const full = (1 << n) - 1;
  const total = new Float64Array(1 << n);
  const dp = new Int32Array(1 << n); // số tập tổng-0 nhiều nhất trên một chuỗi bỏ dần từng người

  for (let mask = 1; mask <= full; mask++) {
    const low = 31 - Math.clz32(mask & -mask);
    total[mask] = total[mask & (mask - 1)] + people[low][1];
    let best = 0;
    for (let i = 0; i < n; i++) {
      if (mask & (1 << i)) best = Math.max(best, dp[mask ^ (1 << i)]);
    }
    dp[mask] = best + (total[mask] === 0 ? 1 : 0);
  }

  // Lần ngược đường đi; hai mask tổng-0 liên tiếp trên đường đi chênh nhau đúng một nhóm tổng-0.
  const groups: [string, number][][] = [];
  let mask = full;
  let groupStart = full;
  while (mask) {
    const need = dp[mask] - (total[mask] === 0 ? 1 : 0);
    let next = -1;
    for (let i = 0; i < n; i++) {
      if (mask & (1 << i) && dp[mask ^ (1 << i)] === need) {
        next = mask ^ (1 << i);
        break;
      }
    }
    mask = next;
    if (total[mask] === 0) {
      const diff = groupStart ^ mask;
      groups.push(people.filter((_, i) => diff & (1 << i)));
      groupStart = mask;
    }
  }
  return groups;
}

/** Trong một nhóm tổng-0: người nợ nhiều nhất trả người được nhận nhiều nhất, lặp lại. ≤ k − 1 lần chuyển. */
function greedySettle(group: [string, number][]): Transfer[] {
  const creditors = group.filter(([, v]) => v > 0).map(([id, v]) => ({ id, v }));
  const debtors = group.filter(([, v]) => v < 0).map(([id, v]) => ({ id, v: -v }));
  const byAmountThenId = (a: { id: string; v: number }, b: { id: string; v: number }) =>
    b.v - a.v || (a.id < b.id ? -1 : 1);
  const out: Transfer[] = [];

  while (creditors.length && debtors.length) {
    creditors.sort(byAmountThenId);
    debtors.sort(byAmountThenId);
    const c = creditors[0];
    const d = debtors[0];
    const amount = Math.min(c.v, d.v);
    out.push({ from: d.id, to: c.id, amount });
    c.v -= amount;
    d.v -= amount;
    if (c.v === 0) creditors.shift();
    if (d.v === 0) debtors.shift();
  }
  return out;
}

/** Nhóm lớn: ghép trước các cặp nợ/có bằng nhau (1 lần chuyển xoá 2 người), phần còn lại chạy tham lam. */
function pairEqualsFirst(people: [string, number][]): Transfer[] {
  const out: Transfer[] = [];
  const rest = new Map(people);
  const creditorsByAmount = new Map<number, string[]>();
  for (const [id, v] of people) {
    if (v > 0) creditorsByAmount.set(v, [...(creditorsByAmount.get(v) ?? []), id]);
  }
  for (const [id, v] of people) {
    if (v >= 0) continue;
    const match = creditorsByAmount.get(-v);
    if (match?.length) {
      const to = match.shift()!;
      out.push({ from: id, to, amount: -v });
      rest.delete(id);
      rest.delete(to);
    }
  }
  return [...out, ...greedySettle([...rest.entries()])];
}
