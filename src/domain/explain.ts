/**
 * Giải thích nguồn gốc gợi ý tất toán (BR-08).
 * Cho một lần chuyển (from → to, amount), liệt kê các khoản chi gốc
 * và giải thích vì sao from phải trả to.
 */

import type { PaymentInput } from './settlement';

// DOM-01: ExpenseInput with description field
export interface ExpenseInput {
  id: string;
  paidBy: string;
  status: 'ACTIVE' | 'CANCELLED';
  description?: string;
  shares: { userId: string; amount: number }[];
}

export type ExpenseContribution = {
  /** Mô tả khoản chi (description) */
  description: string;
  /** Ai trả */
  paidBy: string;
  /** Phần mà from phải chịu trong khoản chi này */
  shareAmount: number;
};

export type DebtExplanation = {
  /** Người trả */
  from: string;
  /** Người nhận */
  to: string;
  /** Số tiền phải chuyển */
  amount: number;
  /** Tổng phần from chịu trong các khoản to trả */
  totalOwedToRecipient: number;
  /** Tổng đã thanh toán confirmed cho to */
  totalPaidToRecipient: number;
  /** Các khoản chi gốc liên quan */
  contributions: ExpenseContribution[];
  /** Câu giải thích tổng hợp */
  summary: string;
};

/**
 * Giải thích vì sao `from` phải trả `to` một khoản tiền.
 * Liệt kê các khoản chi mà `from` có phần chịu và `to` là người trả.
 */
export function explainDebt(
  from: string,
  to: string,
  amount: number,
  expenses: ExpenseInput[],
  payments: PaymentInput[],
  memberNames: Map<string, string>,
): DebtExplanation {
  // Tìm tất cả khoản chi mà `to` trả và `from` có phần chịu
  const contributions: ExpenseContribution[] = [];
  let totalOwedToRecipient = 0;

  for (const e of expenses) {
    if (e.status !== 'ACTIVE') continue;
    if (e.paidBy !== to) continue;
    const share = e.shares.find((s) => s.userId === from);
    if (!share || share.amount === 0) continue;

    contributions.push({
      // DOM-01: Use typed description field instead of (e as any).description
      description: e.description || 'Khoản chi',
      paidBy: to,
      shareAmount: share.amount,
    });
    totalOwedToRecipient += share.amount;
  }

  // Tổng đã thanh toán confirmed từ from → to
  let totalPaidToRecipient = 0;
  for (const p of payments) {
    if (p.fromId === from && p.toId === to && p.status === 'CONFIRMED') {
      totalPaidToRecipient += p.amount;
    }
  }

  const fromName = memberNames.get(from) || from;
  const toName = memberNames.get(to) || to;

  // Tạo câu giải thích
  const parts: string[] = [];
  for (const c of contributions) {
    const payerName = memberNames.get(c.paidBy) || c.paidBy;
    parts.push(`${c.shareAmount.toLocaleString('vi-VN')}đ ${c.description} (${payerName} trả)`);
  }

  let summary = '';
  if (contributions.length === 0) {
    summary = `${fromName} cần trả ${toName} ${amount.toLocaleString('vi-VN')}đ do bù trừ nợ trong nhóm.`;
  } else {
    summary = `Phần ${fromName} chịu: ${parts.join(' + ')}`;
    if (totalPaidToRecipient > 0) {
      summary += `. Đã trả ${totalPaidToRecipient.toLocaleString('vi-VN')}đ`;
    }
    if (totalOwedToRecipient !== amount + totalPaidToRecipient) {
      summary += '. Phần chênh lệch do bù trừ nợ trong nhóm';
    }
    summary += '.';
  }

  return {
    from,
    to,
    amount,
    totalOwedToRecipient,
    totalPaidToRecipient,
    contributions,
    summary,
  };
}

