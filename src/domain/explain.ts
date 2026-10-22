/**
 * Giải thích nguồn gốc gợi ý tất toán (BR-08, AC-02.1).
 *
 * Chế độ bù trừ (mặc định): số tiền `from` chuyển đi đến từ số dư DỰ KIẾN của `from` trong cả nhóm
 * (BR-06), nên phải liệt kê MỌI khoản chi mà `from` có phần chịu (do bất kỳ ai trả), phần `from`
 * đã ứng cho người khác và MỌI thanh toán CONFIRMED / PENDING của `from` (kể cả với người thứ ba).
 * Ví dụ AC-02.1: "Phần C chịu: 30.000đ Bữa trưa (A trả) + 15.000đ Cà phê (B trả),
 * phần B ứng đã được bù trừ qua A."
 *
 * Chế độ từng cặp (BR-09 tắt): chỉ liệt kê khoản do `to` trả, trừ phần `to` chịu trong khoản `from` trả,
 * cộng/trừ thanh toán CONFIRMED / PENDING giữa đúng hai người (cả chiều to → from).
 *
 * REV-S1: lời giải thích không bao giờ mâu thuẫn với số tiền chuyển:
 * - Người ứng P chỉ được nói "bù trừ qua <to>" khi `from` không có lần chuyển trực tiếp cho P
 *   và `from` vẫn còn nợ riêng P (chưa trả thẳng cho P).
 * - `from` có nhiều lần chuyển → nói rõ tổng được tách ra sao ("Tổng ... = A 60.000đ + B 40.000đ").
 * - Các mục liệt kê cộng lại không khớp số cần trả → luôn ghi chú phần chênh lệch.
 * - Cặp "Đã cân bằng" (amount = 0) không có câu "Phần X chịu" hay câu bù trừ nào.
 */

import { formatVND } from './money';
import type { PaymentInput, Transfer } from './settlement';

// DOM-01: ExpenseInput có description
export interface ExpenseInput {
  id: string;
  paidBy: string;
  status: 'ACTIVE' | 'CANCELLED';
  description?: string;
  shares: { userId: string; amount: number }[];
}

export type ExpenseContribution = {
  /** Mã khoản chi */
  expenseId: string;
  /** Mô tả khoản chi (description) */
  description: string;
  /** Ai trả */
  paidBy: string;
  /** Phần mà from phải chịu trong khoản chi này */
  shareAmount: number;
};

/** REV-S1: Một dòng thanh toán ảnh hưởng tới số `from` cần trả (gộp theo người + chiều + trạng thái). */
export type PaymentLine = {
  /** 'sent': from đã gửi cho counterparty (làm giảm nợ); 'received': counterparty đã gửi cho from (làm tăng nợ) */
  direction: 'sent' | 'received';
  counterparty: string;
  amount: number;
  /** PENDING được tính vào số dư dự kiến nhưng hiển thị là "chờ xác nhận" */
  status: 'CONFIRMED' | 'PENDING';
};

export type DebtExplanation = {
  /** Người trả */
  from: string;
  /** Người nhận */
  to: string;
  /** Số tiền phải chuyển */
  amount: number;
  /** REV-S1: true khi cặp này không có lần chuyển nào (amount = 0) — không giải thích phần chịu */
  balanced: boolean;
  /** Tổng phần from chịu trong các khoản được liệt kê */
  totalShare: number;
  /** Tổng phần from chịu trong các khoản do chính `to` trả */
  totalOwedToRecipient: number;
  /** Tổng from đã ứng cho người khác (chế độ bù trừ) hoặc cho `to` (chế độ từng cặp) */
  totalAdvanced: number;
  /** Tổng đã thanh toán CONFIRMED từ from → to */
  totalPaidToRecipient: number;
  /** REV-S1: Tổng đang chờ xác nhận từ from → to */
  totalPendingToRecipient: number;
  /** REV-S1: Thanh toán được tính (CONFIRMED + PENDING; chế độ bù trừ gồm cả người thứ ba) */
  paymentLines: PaymentLine[];
  /** REV-S1: Ảnh hưởng ròng của thanh toán: + làm tăng số phải trả, − làm giảm */
  paymentsNet: number;
  /** REV-S1: Các mục liệt kê cộng lại = totalShare − totalAdvanced + paymentsNet */
  itemsTotal: number;
  /** REV-S1: Số mà các mục liệt kê phải khớp: tổng mọi lần chuyển của from (bù trừ) hoặc amount (từng cặp) */
  expectedTotal: number;
  /** REV-S1: Các lần chuyển của from trong gợi ý (bù trừ) — để tách tổng theo người nhận */
  outgoing: Transfer[];
  /** REV-S1: expectedTotal − itemsTotal (≠ 0 → luôn có ghi chú chênh lệch) */
  mismatch: number;
  /** Các khoản chi gốc liên quan */
  contributions: ExpenseContribution[];
  /** Những người ứng tiền (≠ to) mà phần của họ được bù trừ qua `to` */
  nettedVia: string[];
  /** Câu giải thích tổng hợp */
  summary: string;
};

export type ExplainOptions = {
  /** BR-09: mặc định bật */
  simplify?: boolean;
  /**
   * REV-S1: Toàn bộ gợi ý tất toán đang hiển thị (cùng chế độ simplify). Thiếu → coi như chỉ có
   * một lần chuyển from → to bằng `amount`.
   */
  transfers?: Transfer[];
};

/** Thanh toán được tính vào số dư dự kiến (BR-06): CONFIRMED và PENDING. */
function countedStatus(p: PaymentInput): 'CONFIRMED' | 'PENDING' | null {
  if (p.status === 'CONFIRMED' || p.status === 'PENDING') return p.status;
  return null;
}

/**
 * Giải thích vì sao `from` phải trả `to` một khoản tiền.
 */
export function explainDebt(
  from: string,
  to: string,
  amount: number,
  expenses: ExpenseInput[],
  payments: PaymentInput[],
  memberNames: Map<string, string>,
  opts: ExplainOptions = {},
): DebtExplanation {
  const simplify = opts.simplify !== false;
  const nameOf = (id: string) => memberNames.get(id) || id;

  // REV-S1: các lần chuyển của from trong gợi ý; luôn có from → to khi amount > 0
  const outgoing: Transfer[] = (opts.transfers ?? []).filter((t) => t.from === from && t.amount > 0);
  if (amount > 0 && !outgoing.some((t) => t.to === to)) outgoing.push({ from, to, amount });
  const directTo = new Set(outgoing.map((t) => t.to));

  const contributions: ExpenseContribution[] = [];
  let totalShare = 0;
  let totalOwedToRecipient = 0;
  let totalAdvanced = 0;
  // REV-S1: nợ riêng của from với từng người (phần chịu − phần người đó chịu − thanh toán ròng)
  const pairOwed = new Map<string, number>();
  const addPair = (id: string, v: number) => pairOwed.set(id, (pairOwed.get(id) ?? 0) + v);

  for (const e of expenses) {
    if (e.status !== 'ACTIVE') continue;

    if (e.paidBy === from) {
      // from đã ứng tiền: phần người khác chịu làm giảm nợ của from
      for (const s of e.shares) {
        if (s.userId === from || s.amount === 0) continue;
        addPair(s.userId, -s.amount);
        if (simplify || s.userId === to) totalAdvanced += s.amount;
      }
      continue;
    }

    const share = e.shares.find((s) => s.userId === from);
    if (!share || share.amount === 0) continue;
    addPair(e.paidBy, share.amount);
    if (!simplify && e.paidBy !== to) continue;

    contributions.push({
      expenseId: e.id,
      description: e.description || 'Khoản chi',
      paidBy: e.paidBy,
      shareAmount: share.amount,
    });
    totalShare += share.amount;
    if (e.paidBy === to) totalOwedToRecipient += share.amount;
  }

  // REV-S1: thanh toán CONFIRMED + PENDING (bù trừ: với mọi người; từng cặp: chỉ giữa from và to)
  const lineMap = new Map<string, PaymentLine>();
  let totalPaidToRecipient = 0;
  let totalPendingToRecipient = 0;
  let paymentsNet = 0;
  for (const p of payments) {
    const status = countedStatus(p);
    if (!status) continue;
    let direction: PaymentLine['direction'];
    let counterparty: string;
    if (p.fromId === from) {
      direction = 'sent';
      counterparty = p.toId;
    } else if (p.toId === from) {
      direction = 'received';
      counterparty = p.fromId;
    } else {
      continue;
    }
    addPair(counterparty, direction === 'sent' ? -p.amount : p.amount);
    if (direction === 'sent' && counterparty === to) {
      if (status === 'CONFIRMED') totalPaidToRecipient += p.amount;
      else totalPendingToRecipient += p.amount;
    }
    if (!simplify && counterparty !== to) continue;

    paymentsNet += direction === 'sent' ? -p.amount : p.amount;
    const key = `${direction}|${counterparty}|${status}`;
    const line = lineMap.get(key);
    if (line) line.amount += p.amount;
    else lineMap.set(key, { direction, counterparty, amount: p.amount, status });
  }
  const paymentLines = [...lineMap.values()];

  // Người ứng tiền khác `to` — phần của họ đã được bù trừ qua `to` (REV-S1: chỉ khi from không
  // chuyển thẳng cho họ và from còn nợ riêng họ)
  const nettedVia: string[] = [];
  if (simplify) {
    for (const c of contributions) {
      if (c.paidBy === to || directTo.has(c.paidBy) || nettedVia.includes(c.paidBy)) continue;
      if ((pairOwed.get(c.paidBy) ?? 0) > 0) nettedVia.push(c.paidBy);
    }
  }

  const itemsTotal = totalShare - totalAdvanced + paymentsNet;
  const expectedTotal = simplify ? outgoing.reduce((s, t) => s + t.amount, 0) : amount;
  const mismatch = expectedTotal - itemsTotal;
  const balanced = amount <= 0;

  const fromName = nameOf(from);
  const toName = nameOf(to);

  let summary: string;
  if (balanced) {
    // REV-S1: cặp đã cân bằng — không nói "Phần X chịu" hay bù trừ
    summary = `${fromName} và ${toName} đã cân bằng: theo gợi ý hiện tại không ai cần chuyển cho ai.`;
  } else {
    const sentences: string[] = [];
    if (contributions.length > 0) {
      const parts = contributions.map((c) => `${formatVND(c.shareAmount)} ${c.description} (${nameOf(c.paidBy)} trả)`);
      let s = `Phần ${fromName} chịu: ${parts.join(' + ')}`;
      if (nettedVia.length > 0) {
        const via = outgoing.length === 1 ? `qua ${toName}` : 'vào các lần chuyển bên dưới';
        s += `, phần ${nettedVia.map(nameOf).join(', ')} ứng đã được bù trừ ${via}`;
      }
      sentences.push(`${s}.`);
    } else {
      sentences.push(`${fromName} cần trả ${toName} ${formatVND(amount)}.`);
    }
    if (totalAdvanced > 0) {
      sentences.push(
        simplify
          ? `${fromName} đã ứng cho người khác ${formatVND(totalAdvanced)}, được trừ vào.`
          : `Trừ phần ${toName} chịu trong khoản ${fromName} trả: ${formatVND(totalAdvanced)}.`,
      );
    }
    for (const l of paymentLines) {
      const who = nameOf(l.counterparty);
      if (l.direction === 'sent') {
        sentences.push(
          l.status === 'CONFIRMED'
            ? `Đã trả ${who} ${formatVND(l.amount)}.`
            : `Đã gửi ${who} ${formatVND(l.amount)} (chờ xác nhận), được trừ trước.`,
        );
      } else {
        sentences.push(
          l.status === 'CONFIRMED'
            ? `Đã nhận từ ${who} ${formatVND(l.amount)}, được cộng vào.`
            : `${who} đã gửi ${fromName} ${formatVND(l.amount)} (chờ xác nhận), được cộng vào.`,
        );
      }
    }
    if (simplify && outgoing.length > 1) {
      const split = outgoing.map((t) => `${nameOf(t.to)} ${formatVND(t.amount)}`).join(' + ');
      sentences.push(`Tổng ${fromName} cần trả ${formatVND(expectedTotal)} = ${split}.`);
    }
    if (mismatch !== 0) {
      sentences.push(
        `Các mục trên cộng lại ${formatVND(itemsTotal)}, chênh ${formatVND(Math.abs(mismatch))} so với ` +
          `${formatVND(expectedTotal)} cần trả: phần chênh lệch do bù trừ nợ trong nhóm hoặc dữ liệu chưa đồng bộ.`,
      );
    }
    summary = sentences.join(' ');
  }

  return {
    from,
    to,
    amount,
    balanced,
    totalShare,
    totalOwedToRecipient,
    totalAdvanced,
    totalPaidToRecipient,
    totalPendingToRecipient,
    paymentLines,
    paymentsNet,
    itemsTotal,
    expectedTotal,
    outgoing,
    mismatch,
    contributions,
    nettedVia,
    summary,
  };
}
