/**
 * Định dạng số tiền VND.
 */

/**
 * Hiển thị số tiền VND theo định dạng Việt Nam.
 * Ví dụ: 45000 → "45.000đ", 1500000 → "1.500.000đ", 0 → "0đ"
 */
export function formatVND(amount: number): string {
  // Supabase trả bigint dưới dạng string, ép kiểu có thể ra float
  const rounded = Math.round(amount);
  const absStr = Math.abs(rounded).toLocaleString('vi-VN');
  const prefix = rounded < 0 ? '-' : '';
  return `${prefix}${absStr}đ`;
}

/**
 * Parse chuỗi số tiền nhập bởi user (bỏ dấu chấm, dấu phẩy, ký tự đ).
 * DOM-03: Reject decimal commas/dots and check MAX_SAFE_INTEGER.
 * @returns Số nguyên VND hoặc null nếu không hợp lệ.
 */
export function parseVND(input: string): number | null {
  if (!input || typeof input !== 'string') return null;

  const trimmed = input.trim();

  // DOM-03: Detect and reject decimal comma/dot (e.g., "45,5" or "45.5" with no grouping)
  // Valid grouping: "100.000" (exactly 3 digits after separator)
  // Invalid decimal: "45,5" or "100.5"
  if (/,\d{1,2}$/.test(trimmed) && !/,\d{3}/.test(trimmed)) {
    return null; // Looks like decimal comma
  }
  if (/\.\d{1,2}$/.test(trimmed) && !/\.\d{3}/.test(trimmed)) {
    return null; // Looks like decimal point
  }

  // Remove thousand separators and currency symbols
  const cleaned = trimmed.replace(/[.,\sđ₫]/g, '');

  if (!/^\d+$/.test(cleaned)) return null;

  const value = parseInt(cleaned, 10);

  // DOM-03: Check MAX_SAFE_INTEGER
  if (isNaN(value) || value <= 0 || value > Number.MAX_SAFE_INTEGER) return null;

  return value;
}

