/**
 * OCR-02 / OCR-07: Đọc chữ hóa đơn (ML Kit trên máy) thành danh sách món, phí, thuế, giảm giá
 * và tổng in trên hóa đơn — bằng quy tắc, không gửi đi đâu.
 *
 * Kết quả chỉ là gợi ý điền sẵn (BR-12): người dùng sửa được mọi trường trước khi lưu.
 * Tiền là số nguyên VND.
 */

import { stripVietnamese } from './vietqr';

export type ReceiptItemKind = 'ITEM' | 'FEE' | 'TAX' | 'DISCOUNT';

export type ReceiptItem = {
  name: string;
  quantity: number;
  /** Thành tiền của dòng (đã nhân số lượng). Giảm giá lưu số dương, trừ khi tính tổng. */
  amount: number;
  kind: ReceiptItemKind;
};

export type ParsedReceipt = {
  storeName: string;
  items: ReceiptItem[];
  /** Tổng in trên hóa đơn (dòng "Tổng thanh toán", "Total"...); null nếu không thấy */
  printedTotal: number | null;
};

/** Khung chữ ML Kit trả về (px trên ảnh) */
export type OcrFrame = { top: number; left: number; width: number; height: number };
export type OcrLine = { text: string; frame?: OcrFrame };

export const RECEIPT_ITEM_NAME_MAX = 200;
export const RECEIPT_ITEMS_MAX = 200;
export const RECEIPT_QUANTITY_MAX = 999;

export const RECEIPT_KIND_LABEL: Record<ReceiptItemKind, string> = {
  ITEM: 'Món',
  FEE: 'Phí dịch vụ',
  TAX: 'Thuế',
  DISCOUNT: 'Giảm giá',
};

// ------------------------------------------------------------
// Ghép dòng theo toạ độ
// ------------------------------------------------------------

/**
 * ML Kit hay tách tên món và giá thành hai khối riêng dù cùng một hàng.
 * Ghép các dòng có tâm dọc gần nhau thành một hàng, xếp trái → phải.
 * Thiếu toạ độ → giữ nguyên thứ tự.
 */
export function linesToRows(lines: OcrLine[]): string[] {
  const clean = lines.filter((l) => l.text.trim());
  if (clean.some((l) => !l.frame)) return clean.map((l) => l.text.trim());

  const sorted = [...clean].sort((a, b) => centerY(a.frame!) - centerY(b.frame!));
  const rows: { cy: number; h: number; lines: OcrLine[] }[] = [];
  for (const line of sorted) {
    const f = line.frame!;
    const cy = centerY(f);
    const row = rows[rows.length - 1];
    if (row && Math.abs(cy - row.cy) <= 0.6 * Math.min(row.h, f.height)) {
      row.lines.push(line);
      row.cy = (row.cy * (row.lines.length - 1) + cy) / row.lines.length;
      row.h = Math.max(row.h, f.height);
    } else {
      rows.push({ cy, h: f.height, lines: [line] });
    }
  }
  return rows.map((r) =>
    [...r.lines]
      .sort((a, b) => a.frame!.left - b.frame!.left)
      .map((l) => l.text.trim())
      .join('   '),
  );
}

function centerY(f: OcrFrame): number {
  return f.top + f.height / 2;
}

// ------------------------------------------------------------
// Số tiền
// ------------------------------------------------------------

/**
 * Một cụm chữ là số tiền VND? "60.000", "60,000", "60.000đ", "126,000.00", "60k", "45000".
 * Số nhỏ không có dấu ngăn (vd "2") là số lượng, không phải tiền; "0901234567" là số điện thoại.
 */
export function parseMoneyToken(token: string): number | null {
  let t = token.trim().replace(/^[:=]+/, '').replace(/(?:vnđ|vnd|đ|₫)$/i, '');
  const k = /^(\d{1,4})k$/i.exec(t);
  if (k) return Number(k[1]) * 1000;
  if (/^0\d{8,}$/.test(t)) return null; // số điện thoại
  if (/^\d{1,3}(?:[.,]\d{3})+(?:[.,]\d{2})?$/.test(t)) {
    // bỏ phần thập phân ",00" / ".00" ở cuối nếu có
    t = t.replace(/[.,]\d{2}$/, '');
    return Number(t.replace(/[.,]/g, ''));
  }
  if (/^\d+[.,]\d{2}$/.test(t)) {
    const n = Number(t.replace(/[.,]\d{2}$/, ''));
    return n >= 1000 ? n : null;
  }
  if (/^\d+$/.test(t)) {
    const n = Number(t);
    return n >= 1000 && n <= 10_000_000_000 ? n : null;
  }
  return null;
}

type ParsedRow = { label: string; amounts: number[]; quantity: number | null };

/** Tách cuối hàng: các cụm số (tiền, số lượng, "2x30.000") → phần còn lại là nhãn */
export function parseRow(text: string): ParsedRow {
  const tokens = text.trim().split(/\s+/).filter(Boolean);
  const amounts: number[] = [];
  let quantity: number | null = null;
  let i = tokens.length - 1;
  for (; i >= 0; i--) {
    const tok = tokens[i];
    const money = parseMoneyToken(tok);
    if (money !== null) {
      amounts.unshift(money);
      continue;
    }
    const mult = /^(\d{1,3})[x×*](.+)$/i.exec(tok);
    if (mult && parseMoneyToken(mult[2]) !== null) {
      quantity = Number(mult[1]);
      amounts.unshift(parseMoneyToken(mult[2])!);
      continue;
    }
    const qty = /^[x×]?(\d{1,3})[x×]?$/i.exec(tok);
    if (qty && amounts.length > 0) {
      quantity = Number(qty[1]);
      continue;
    }
    break;
  }
  let label = tokens.slice(0, i + 1).join(' ');
  // Số lượng đứng đầu: "2 x Phở bò", "2 Phở bò"
  const lead = /^(\d{1,2})\s*[x×]?\s+(?=\D)/i.exec(label);
  if (lead && quantity === null) {
    quantity = Number(lead[1]);
    label = label.slice(lead[0].length);
  }
  return { label: label.replace(/[\s:.\-–|]+$/, '').trim(), amounts, quantity };
}

// ------------------------------------------------------------
// Phân loại dòng
// ------------------------------------------------------------

function key(text: string): string {
  return stripVietnamese(text).toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Tiền khách đưa / trả lại — không phải món, không phải tổng */
const EXCLUDE_RE = /(khach dua|tien khach|tien mat|tien thua|tra lai|tien du|\bcash\b|\bchange\b|chuyen khoan)/;
const DISCOUNT_RE = /(giam gia|khuyen mai|chiet khau|discount|voucher|\bkm\b|\bgiam\b)/;
const TAX_RE = /(\bvat\b|\bthue\b|\btax\b|gtgt)/;
const FEE_RE = /(^phi\b|phi dich vu|phi phuc vu|phu thu|service|\bsvc\b)/;
const TOTAL_RE = /(tong|total|thanh toan|can tra|phai tra|tam tinh|cong tien|amount due)/;
/** Thông tin cửa hàng / hóa đơn — bỏ qua */
const META_RE =
  /(dia chi|\bdc\b|\bdt\b|sdt|\btel\b|hotline|dien thoai|ngay|gio vao|gio ra|thoi gian|\btime\b|\bdate\b|so hd|so hoa don|hoa don|\bban\b|ban so|thu ngan|nhan vien|cashier|\bmst\b|ma so thue|wifi|\bpass\b|cam on|thank|www\.|http|khach hang|ma don|order|so luong mon|ten mon|don gia|thanh tien|\bsl\b)/;

function hasLetters(text: string, min = 2): boolean {
  return (stripVietnamese(text).match(/[a-z]/gi) ?? []).length >= min;
}

function cleanName(name: string): string {
  return name.replace(/\s+/g, ' ').trim().slice(0, RECEIPT_ITEM_NAME_MAX);
}

/** Đọc các hàng chữ (đã ghép theo toạ độ) thành hóa đơn */
export function parseReceiptRows(rows: string[]): ParsedReceipt {
  const items: ReceiptItem[] = [];
  const totals: number[] = [];
  let storeName = '';
  let pendingName: string | null = null;

  rows.forEach((raw, index) => {
    const row = parseRow(raw);
    const k = key(row.label);

    // Tên cửa hàng: hàng chữ đầu tiên (trong 4 hàng đầu) không có tiền, không phải thông tin phụ
    if (!storeName && index < 4 && row.amounts.length === 0 && hasLetters(row.label, 3) && !META_RE.test(k)) {
      storeName = cleanName(row.label);
      return;
    }

    if (row.amounts.length === 0) {
      // Tên món một hàng, giá ở hàng sau
      pendingName = hasLetters(row.label) && !META_RE.test(k) && !TOTAL_RE.test(k) ? row.label : null;
      return;
    }

    let label = row.label;
    let lk = k;
    if (!hasLetters(label) && pendingName) {
      label = pendingName;
      lk = key(label);
    }
    pendingName = null;

    const amount = row.amounts[row.amounts.length - 1];
    if (!hasLetters(label) || EXCLUDE_RE.test(lk)) return;

    if (DISCOUNT_RE.test(lk)) {
      items.push({ name: cleanName(label), quantity: 1, amount, kind: 'DISCOUNT' });
    } else if (TAX_RE.test(lk)) {
      items.push({ name: cleanName(label), quantity: 1, amount, kind: 'TAX' });
    } else if (FEE_RE.test(lk)) {
      items.push({ name: cleanName(label), quantity: 1, amount, kind: 'FEE' });
    } else if (TOTAL_RE.test(lk)) {
      totals.push(amount);
    } else if (!META_RE.test(lk)) {
      const quantity = row.quantity && row.quantity > 0 && row.quantity <= RECEIPT_QUANTITY_MAX ? row.quantity : 1;
      items.push({ name: cleanName(label), quantity, amount, kind: 'ITEM' });
    }
  });

  // Tổng thanh toán là số lớn nhất trong các dòng tổng (tạm tính ≤ tổng sau phí)
  const printedTotal = totals.length > 0 ? Math.max(...totals) : null;
  return { storeName, items: items.slice(0, RECEIPT_ITEMS_MAX), printedTotal };
}

/** Chữ thuần (mỗi dòng một hàng) → hóa đơn */
export function parseReceiptText(text: string): ParsedReceipt {
  return parseReceiptRows(text.split(/\r?\n/));
}

/** Kết quả ML Kit (các dòng có toạ độ) → hóa đơn */
export function parseReceiptLines(lines: OcrLine[]): ParsedReceipt {
  return parseReceiptRows(linesToRows(lines));
}

// ------------------------------------------------------------
// Tổng và kiểm tra (BR-13)
// ------------------------------------------------------------

/** Tổng món + phí + thuế − giảm giá */
export function receiptSum(items: ReceiptItem[]): number {
  return items.reduce((sum, it) => sum + (it.kind === 'DISCOUNT' ? -it.amount : it.amount), 0);
}

/** Dòng hợp lệ để lưu: tên 1..200 ký tự, số lượng 1..999, tiền nguyên ≥ 0 */
export function normalizeReceiptItems(items: ReceiptItem[]): ReceiptItem[] {
  return items
    .map((it) => ({
      name: cleanName(it.name),
      quantity: Math.min(Math.max(Math.round(it.quantity) || 1, 1), RECEIPT_QUANTITY_MAX),
      amount: Math.max(Math.round(it.amount) || 0, 0),
      kind: it.kind,
    }))
    .filter((it) => it.name.length > 0)
    .slice(0, RECEIPT_ITEMS_MAX);
}
