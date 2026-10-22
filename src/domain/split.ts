/**
 * Chia tiền khoản chi (EXP-02): chia đều (splitEqual), theo phần trăm (splitPercent,
 * tính bằng phần vạn) và kiểm tra phần chia theo số tiền (validateShares).
 * Mọi số tiền là số nguyên VND; tổng phần chia luôn bằng tổng khoản chi.
 */

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

/** Tổng phần vạn của chia theo phần trăm phải đúng bằng 100% */
export const FULL_BP = 10_000;

/**
 * Đọc phần trăm người dùng nhập ("33", "33.33", "33,33") thành phần vạn (bp, 1% = 100bp)
 * mà không dùng số thực. Tối đa 2 chữ số thập phân, 0–100%.
 * @returns số nguyên bp hoặc null nếu không hợp lệ. Chuỗi rỗng → 0.
 */
export function parsePercentToBp(input: string): number | null {
  const t = (input ?? '').trim();
  if (t === '') return 0;
  const m = /^(\d{1,3})(?:[.,](\d{1,2}))?$/.exec(t);
  if (!m) return null;
  const whole = parseInt(m[1], 10);
  const frac = m[2] ? parseInt(m[2].padEnd(2, '0'), 10) : 0;
  const bp = whole * 100 + frac;
  return bp > FULL_BP ? null : bp;
}

/**
 * DOM-04 / APP-09: Chia theo phần trăm (EXP-02).
 * Mỗi người nhận floor(amount × bp / 10000); phần dư sau làm tròn cộng từng 1đ
 * cho người có user_id nhỏ nhất trở đi (theo mã tăng dần), giống splitEqual.
 * @throws nếu bp không phải số nguyên ≥ 0, trùng user, hoặc tổng bp ≠ 10000.
 * @returns Mảng { userId, amount, percentBp } có tổng === amount, sắp theo userId.
 */
export function splitPercent(
  amount: number,
  shares: { userId: string; bp: number }[],
): { userId: string; amount: number; percentBp: number }[] {
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    throw new Error(`Số tiền phải là số nguyên dương: ${amount}`);
  }
  if (shares.length === 0) {
    throw new Error('Phải có ít nhất 1 người');
  }
  let totalBp = 0;
  const ids = new Set<string>();
  for (const s of shares) {
    if (!Number.isInteger(s.bp) || s.bp < 0) {
      throw new Error(`Phần trăm không hợp lệ cho ${s.userId}: ${s.bp}`);
    }
    if (ids.has(s.userId)) throw new Error('Có userId bị trùng trong phần chia');
    ids.add(s.userId);
    totalBp += s.bp;
  }
  if (totalBp !== FULL_BP) {
    throw new Error(`Tổng phần trăm phải bằng 100% (hiện tại: ${totalBp / 100}%)`);
  }

  // Sắp theo user_id tăng dần để phần dư phân bổ xác định (EXP-02)
  const sorted = [...shares].sort((a, b) => (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0));

  // amount × bp có thể vượt 2^53 với số tiền rất lớn → dùng BigInt
  const result = sorted.map((s) => ({
    userId: s.userId,
    amount: Number((BigInt(amount) * BigInt(s.bp)) / BigInt(FULL_BP)),
    percentBp: s.bp,
  }));

  // Phần dư < số người: cộng 1đ lần lượt từ user_id nhỏ nhất (bỏ qua người 0%)
  let remainder = amount - result.reduce((sum, r) => sum + r.amount, 0);
  for (let i = 0; remainder > 0; i = (i + 1) % result.length) {
    if (result[i].percentBp > 0) {
      result[i].amount += 1;
      remainder -= 1;
    }
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


/**
 * APP-09: Đọc ô phần trăm của từng người (màn thêm / sửa khoản chi) thành danh sách bp.
 * @returns null nếu có ô không hợp lệ.
 */
export function percentInputsToBp(
  memberIds: string[],
  inputs: Record<string, string>,
): { userId: string; bp: number }[] | null {
  const out: { userId: string; bp: number }[] = [];
  for (const userId of memberIds) {
    const bp = parsePercentToBp(inputs[userId] ?? '');
    if (bp === null) return null;
    out.push({ userId, bp });
  }
  return out;
}

/** Hiển thị phần vạn thành chuỗi phần trăm để điền lại form: 3333 → "33.33", 5000 → "50" */
export function bpToPercentText(bp: number): string {
  const whole = Math.floor(bp / 100);
  const frac = bp % 100;
  return frac === 0 ? String(whole) : `${whole}.${String(frac).padStart(2, '0').replace(/0$/, '')}`;
}

/**
 * REV-S9: "Chia đều %" — chia 100% (10.000 phần vạn) đều cho `memberIds`.
 * Mỗi người floor(10000 / n) bp; phần dư cộng 1bp lần lượt cho user_id nhỏ nhất trở đi
 * (cùng quy tắc với splitEqual / splitPercent), nên chia 3 người ra 33,34% + 33,33% + 33,33%.
 * @returns danh sách { userId, bp } sắp theo userId, tổng đúng FULL_BP; rỗng nếu không có ai.
 */
export function splitPercentEqually(memberIds: string[]): { userId: string; bp: number }[] {
  const sorted = [...new Set(memberIds)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const n = sorted.length;
  if (n === 0) return [];
  const base = Math.floor(FULL_BP / n);
  const remainder = FULL_BP - base * n;
  return sorted.map((userId, i) => ({ userId, bp: base + (i < remainder ? 1 : 0) }));
}
