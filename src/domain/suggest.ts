/**
 * APP-06: Một hàm dùng chung cho mọi màn hiển thị gợi ý tất toán
 * (chi tiết nhóm, thanh toán, tổng quan công nợ, chi tiết công nợ).
 *
 * - simplify_debts = true hoặc NULL (mặc định bật, BR-09) → simplifyDebts trên số dư dự kiến (BR-04, BR-06).
 * - simplify_debts = false → pairwiseDebts (bù trừ từng cặp), cũng tính thanh toán PENDING.
 * - APP-01 / BR-02: tổng số dư ≠ 0 hoặc dữ liệu tham chiếu người lạ → ném lỗi; màn hình phải
 *   hiện trạng thái lỗi và console.error, không được nuốt lỗi rồi hiện rỗng.
 */

import { pairwiseDebts } from './pairwise';
import {
  computeBalances,
  simplifyDebts,
  type ExpenseInput,
  type PaymentInput,
  type PaymentStatus,
  type Transfer,
} from './settlement';

/** BR-09: NULL/undefined được hiểu là bật. */
export function isSimplifyEnabled(simplify: boolean | null | undefined): boolean {
  return simplify !== false;
}

/** BR-02: Tổng số dư của cả nhóm luôn bằng 0. Ném lỗi nếu không. */
export function assertZeroSum(balances: Map<string, number>, label = 'số dư'): void {
  let sum = 0;
  for (const [id, v] of balances) {
    if (!Number.isSafeInteger(v)) throw new Error(`BR-02: ${label} của ${id} không phải số nguyên VND: ${v}`);
    sum += v;
  }
  if (sum !== 0) throw new Error(`BR-02: Tổng ${label} của nhóm phải bằng 0, đang là ${sum}`);
}

/** Gợi ý tất toán theo cài đặt của nhóm. */
export function suggestTransfers(
  memberIds: string[],
  expenses: ExpenseInput[],
  payments: PaymentInput[],
  simplify: boolean | null | undefined,
): Transfer[] {
  const projected = computeBalances(memberIds, expenses, payments, { includePending: true });
  assertZeroSum(projected, 'số dư dự kiến');
  if (isSimplifyEnabled(simplify)) return simplifyDebts(projected);
  return pairwiseDebts(memberIds, expenses, payments, { includePending: true });
}

export type GroupSettlement = {
  /** Số dư chính thức — chỉ thanh toán CONFIRMED (BR-06) */
  officialBal: Map<string, number>;
  /** Số dư dự kiến — tính cả thanh toán PENDING */
  projectedBal: Map<string, number>;
  /** Gợi ý tất toán theo công tắc của nhóm */
  suggestions: Transfer[];
  simplify: boolean;
};

/** Tính đủ số dư chính thức, dự kiến và gợi ý. Ném lỗi khi vi phạm BR-02. */
export function computeGroupSettlement(
  memberIds: string[],
  expenses: ExpenseInput[],
  payments: PaymentInput[],
  simplify: boolean | null | undefined,
): GroupSettlement {
  const officialBal = computeBalances(memberIds, expenses, payments);
  assertZeroSum(officialBal, 'số dư chính thức');
  const projectedBal = computeBalances(memberIds, expenses, payments, { includePending: true });
  const suggestions = suggestTransfers(memberIds, expenses, payments, simplify);
  return { officialBal, projectedBal, suggestions, simplify: isSimplifyEnabled(simplify) };
}

// ----------------------------
// Chuyển dữ liệu từ API sang đầu vào của domain (không phụ thuộc src/api)
// ----------------------------

type ExpenseRow = {
  id: string;
  paid_by: string;
  status: string;
  description?: string | null;
  expense_shares: { user_id: string; amount: number | string }[];
};

type PaymentRow = {
  from_id: string;
  to_id: string;
  amount: number | string;
  status: string;
};

/** Supabase trả bigint dạng string → ép về số nguyên VND. */
export function toExpenseInputs(rows: ExpenseRow[]): (ExpenseInput & { id: string; description: string })[] {
  return rows.map((e) => ({
    id: e.id,
    paidBy: e.paid_by,
    status: e.status === 'ACTIVE' ? 'ACTIVE' : 'CANCELLED',
    description: e.description || 'Khoản chi',
    shares: (e.expense_shares ?? []).map((s) => ({ userId: s.user_id, amount: Number(s.amount) })),
  }));
}

export function toPaymentInputs(rows: PaymentRow[]): PaymentInput[] {
  return rows.map((p) => ({
    fromId: p.from_id,
    toId: p.to_id,
    amount: Number(p.amount),
    status: p.status as PaymentStatus,
  }));
}

// ----------------------------
// REV-S6: Dòng tình trạng cá nhân (AC-01.1, §6 ví dụ 2)
// ----------------------------

export type MemberPosition = {
  /** Số dư chính thức (chỉ thanh toán CONFIRMED) */
  official: number;
  /** Số dư dự kiến (thêm thanh toán PENDING) */
  projected: number;
  /** Tổng đang chờ người này xác nhận (người khác gửi cho họ) */
  pendingReceived: number;
  /** Tổng người này đã gửi, đang chờ người nhận xác nhận */
  pendingSent: number;
};

/**
 * REV-S6: Câu tình trạng cho người đang xem.
 * - Dự kiến 0 và không có khoản chờ → "Bạn đã cân bằng" (AC-01.1).
 * - Người nhận có khoản chờ mình xác nhận → "Cần thu X, trong đó Y chờ bạn xác nhận" (§6 ví dụ 2),
 *   X = số dư chính thức.
 * - Còn lại → "Cần thu X" / "Cần trả X" theo số dư dự kiến (gợi ý tính trên số dư dự kiến, BR-06).
 */
export function describeMyPosition(p: MemberPosition, formatAmount: (v: number) => string): string {
  if (p.projected === 0 && p.pendingReceived === 0 && p.pendingSent === 0) return 'Bạn đã cân bằng';
  if (p.pendingReceived > 0 && p.official > 0) {
    return `Cần thu ${formatAmount(p.official)}, trong đó ${formatAmount(p.pendingReceived)} chờ bạn xác nhận`;
  }
  if (p.projected > 0) return `Cần thu ${formatAmount(p.projected)}`;
  if (p.projected < 0) return `Cần trả ${formatAmount(-p.projected)}`;
  // Dự kiến 0 nhưng còn khoản đang chờ (ví dụ 2, người C)
  return p.pendingSent > 0
    ? `Đã gửi ${formatAmount(p.pendingSent)}, đang chờ xác nhận`
    : `Có ${formatAmount(p.pendingReceived)} chờ bạn xác nhận`;
}

/** REV-S6: Tổng thanh toán PENDING đã gửi / đang chờ nhận của từng người (dùng khi tự tính offline). */
export function pendingTotals(payments: PaymentInput[]): Map<string, { sent: number; received: number }> {
  const out = new Map<string, { sent: number; received: number }>();
  const get = (id: string) => {
    let v = out.get(id);
    if (!v) {
      v = { sent: 0, received: 0 };
      out.set(id, v);
    }
    return v;
  };
  for (const p of payments) {
    if (p.status !== 'PENDING') continue;
    get(p.fromId).sent += p.amount;
    get(p.toId).received += p.amount;
  }
  return out;
}
