/**
 * Chế độ tắt bù trừ (BR-09): nợ ròng giữa từng cặp người.
 * Khi `simplify_debts = false`, không gộp nợ qua trung gian.
 * Mỗi cặp (A, B) có tối đa một chiều chuyển tiền.
 */

import type { ExpenseInput, PaymentInput, Transfer } from './settlement';

/**
 * Tính nợ ròng giữa từng cặp thành viên:
 *   nợ A→B = Σ(phần A chịu trong khoản B trả) − Σ(phần B chịu trong khoản A trả)
 *            − Σ(thanh toán CONFIRMED A→B) + Σ(thanh toán CONFIRMED B→A)
 * Nếu includePending, cộng thêm thanh toán PENDING.
 * Kết quả: danh sách Transfer (from, to, amount) với amount > 0.
 */
export function pairwiseDebts(
  memberIds: string[],
  expenses: ExpenseInput[],
  payments: PaymentInput[],
  opts: { includePending?: boolean } = {},
): Transfer[] {
  // net[A][B] > 0 nghĩa là A nợ B
  const net = new Map<string, Map<string, number>>();
  const getNet = (a: string, b: string): number => net.get(a)?.get(b) ?? 0;
  const addNet = (a: string, b: string, v: number) => {
    if (!net.has(a)) net.set(a, new Map());
    net.get(a)!.set(b, getNet(a, b) + v);
  };

  // Khoản chi: phần share.userId chịu trong expense do paidBy trả
  for (const e of expenses) {
    if (e.status !== 'ACTIVE') continue;
    for (const s of e.shares) {
      if (s.userId === e.paidBy) continue; // không tự nợ mình
      // s.userId nợ e.paidBy khoản s.amount
      addNet(s.userId, e.paidBy, s.amount);
    }
  }

  // Thanh toán: fromId trả cho toId
  for (const p of payments) {
    const counted = p.status === 'CONFIRMED' || (opts.includePending && p.status === 'PENDING');
    if (!counted) continue;
    // fromId giảm nợ với toId
    addNet(p.fromId, p.toId, -p.amount);
  }

  // Bù trừ từng cặp: chỉ giữ chiều dương
  // DOM-02: Use < operator for consistent string comparison
  const sorted = [...memberIds].sort();
  const transfers: Transfer[] = [];

  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      const a = sorted[i];
      const b = sorted[j];
      const aOwesB = getNet(a, b) - getNet(b, a);
      if (aOwesB > 0) {
        transfers.push({ from: a, to: b, amount: aOwesB });
      } else if (aOwesB < 0) {
        transfers.push({ from: b, to: a, amount: -aOwesB });
      }
    }
  }

  // Sắp xếp ổn định: theo amount giảm dần, rồi from, rồi to
  transfers.sort((a, b) => b.amount - a.amount || (a.from < b.from ? -1 : a.from > b.from ? 1 : 0) || (a.to < b.to ? -1 : a.to > b.to ? 1 : 0));
  return transfers;
}
