/**
 * Chia tiền khoản chi — hỗ trợ chia đều, theo số tiền cụ thể, và theo phần trăm.
 * Mọi số tiền là số nguyên VND.
 */

export type Share = {
  user_id: string;
  amount: number;
};

/**
 * Chia đều tổng `amount` cho `memberIds`.
 * Mỗi người nhận `floor(amount / n)`. Phần dư `r` được cộng thêm 1đ
 * cho `r` người đầu tiên (sắp theo mã userId tăng dần).
 *
 * @returns Mảng { userId, amount } có tổng === amount.
 */
export function splitEqual(
  amount: number,
  memberIds: string[],
): { userId: string; amount: number }[] {
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new Error(`Số tiền phải là số nguyên dương: ${amount}`);
  }
  if (memberIds.length === 0) {
    throw new Error('Phải có ít nhất 1 người');
  }

  const sorted = [...memberIds].sort();
  const n = sorted.length;
  const base = Math.floor(amount / n);
  const remainder = amount % n;

  return sorted.map((userId, i) => ({
    userId,
    amount: base + (i < remainder ? 1 : 0),
  }));
}

/**
 * Chia đều tổng `totalAmount` cho `memberIds` (trả về Share[]).
 * Fix: properly distribute remainder.
 */
export function splitEvenly(totalAmount: number, memberIds: string[]): Share[] {
  if (memberIds.length === 0) return [];

  const sorted = [...memberIds].sort(); // sort by user_id for deterministic order
  const each = Math.floor(totalAmount / sorted.length);
  const remainder = totalAmount - each * sorted.length;

  return sorted.map((userId, index) => ({
    user_id: userId,
    // Fix: properly distribute remainder
    amount: each + (index < remainder ? 1 : 0),
  }));
}

/**
 * Chia theo phần trăm
 * @param totalAmount - Tổng số tiền (VND, số nguyên)
 * @param shares - Danh sách {userId, bp} trong đó bp là basis points (1% = 100bp)
 * @returns Danh sách Share với phần dư dồn cho user_id nhỏ nhất
 */
export function splitPercent(
  totalAmount: number,
  shares: { userId: string; bp: number }[],
): Share[] {
  if (shares.length === 0) return [];

  // Sort by user_id for deterministic remainder allocation (EXP-02)
  const sorted = [...shares].sort((a, b) => (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0));

  const result: Share[] = sorted.map((s) => ({
    user_id: s.userId,
    amount: Math.floor((totalAmount * s.bp) / 10000),
  }));

  // Distribute remainder to person with smallest user_id
  const totalDistributed = result.reduce((sum, r) => sum + r.amount, 0);
  const remainder = totalAmount - totalDistributed;
  if (remainder > 0 && result.length > 0) {
    result[0].amount += remainder;
  }

  return result;
}

/**
 * Kiểm tra tổng phần chia bằng đúng tổng khoản chi.
 * @returns `true` nếu hợp lệ, throw nếu không.
 */
export function validateShares(
  totalAmount: number,
  shares: { userId: string; amount: number }[],
): boolean {
  if (shares.length === 0) {
    throw new Error('Phải có ít nhất 1 phần chia');
  }

  const sum = shares.reduce((s, sh) => s + sh.amount, 0);
  if (sum !== totalAmount) {
    throw new Error(
      `Tổng phần chia (${sum.toLocaleString('vi-VN')}đ) khác tổng khoản chi (${totalAmount.toLocaleString('vi-VN')}đ)`,
    );
  }

  for (const sh of shares) {
    if (!Number.isInteger(sh.amount) || sh.amount < 0) {
      throw new Error(`Phần chia không hợp lệ cho ${sh.userId}: ${sh.amount}`);
    }
  }

  // Kiểm tra trùng userId
  const ids = new Set(shares.map((s) => s.userId));
  if (ids.size !== shares.length) {
    throw new Error('Có userId bị trùng trong phần chia');
  }

  return true;
}

