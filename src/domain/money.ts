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
 * Đọc chuỗi số tiền người dùng nhập.
 * Chấp nhận: "45000", "45.000", "1,500,000", "50 000", "45.000đ", "45.000₫".
 * DOM-03: Từ chối dấu thập phân ("45,5", "45.5", "1,000,5"), trộn hai loại dấu ("1.500,000"),
 * nhóm không đủ 3 chữ số, và số vượt Number.MAX_SAFE_INTEGER.
 * @returns Số nguyên VND dương hoặc null nếu không hợp lệ.
 */
export function parseVND(input: string): number | null {
  if (!input || typeof input !== 'string') return null;

  // Bỏ khoảng trắng (kể cả NBSP) và ký hiệu tiền tệ
  const compact = input.trim().replace(/[\sđ₫]/g, ''); // \s đã gồm cả NBSP
  if (!compact) return null;

  let digits = compact;
  if (/[.,]/.test(compact)) {
    // Chỉ chấp nhận dấu phân cách hàng nghìn: nhóm đầu 1–3 chữ số, các nhóm sau đúng 3 chữ số,
    // và chỉ dùng một loại dấu.
    const dotGrouped = /^\d{1,3}(\.\d{3})+$/.test(compact);
    const commaGrouped = /^\d{1,3}(,\d{3})+$/.test(compact);
    if (!dotGrouped && !commaGrouped) return null;
    digits = compact.replace(/[.,]/g, '');
  }

  if (!/^\d+$/.test(digits)) return null;

  // Quá 16 chữ số chắc chắn vượt MAX_SAFE_INTEGER (9.007.199.254.740.991)
  if (digits.replace(/^0+/, '').length > 16) return null;
  const value = Number(digits);
  if (!Number.isSafeInteger(value) || value <= 0) return null;

  return value;
}
