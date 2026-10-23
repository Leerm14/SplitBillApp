/**
 * Mã VietQR (chuẩn EMVCo / NAPAS 247) cho phương thức thanh toán loại Ngân hàng.
 *
 * - Dữ liệu vẫn lưu một dòng `display_text` dạng "Vietcombank - 1234567890 - NGUYEN VAN AN";
 *   mã QR được dựng trên máy từ dòng này, không lưu thêm cột.
 * - App ngân hàng quét mã sẽ tự điền ngân hàng + số tài khoản (+ số tiền, nội dung nếu có).
 */

export type VietQRBank = {
  /** Mã BIN NAPAS (6 chữ số) */
  bin: string;
  /** Tên hiển thị, cũng là tên ghi vào display_text */
  name: string;
  /** Tên / mã viết tắt thường gặp (so khớp sau khi bỏ dấu, bỏ khoảng trắng, chữ thường) */
  aliases: string[];
};

export const VIETQR_BANKS: VietQRBank[] = [
  { bin: '970436', name: 'Vietcombank', aliases: ['vcb', 'ngoaithuong'] },
  { bin: '970415', name: 'VietinBank', aliases: ['ctg', 'icb', 'congthuong'] },
  { bin: '970418', name: 'BIDV', aliases: ['dautuphattrien'] },
  { bin: '970405', name: 'Agribank', aliases: ['vba', 'nongnghiep'] },
  { bin: '970407', name: 'Techcombank', aliases: ['tcb'] },
  { bin: '970422', name: 'MB Bank', aliases: ['mb', 'mbb', 'quandoi'] },
  { bin: '970416', name: 'ACB', aliases: ['achau'] },
  { bin: '970432', name: 'VPBank', aliases: ['vpb'] },
  { bin: '970423', name: 'TPBank', aliases: ['tpb', 'tienphong'] },
  { bin: '970403', name: 'Sacombank', aliases: ['stb'] },
  { bin: '970437', name: 'HDBank', aliases: ['hdb'] },
  { bin: '970441', name: 'VIB', aliases: ['quocte'] },
  { bin: '970443', name: 'SHB', aliases: [] },
  { bin: '970431', name: 'Eximbank', aliases: ['eib'] },
  { bin: '970426', name: 'MSB', aliases: ['maritimebank', 'hanghai'] },
  { bin: '970440', name: 'SeABank', aliases: ['seab'] },
  { bin: '970448', name: 'OCB', aliases: ['phuongdong'] },
  { bin: '970449', name: 'LPBank', aliases: ['lpb', 'lienvietpostbank', 'lienviet'] },
  { bin: '970428', name: 'Nam A Bank', aliases: ['nab'] },
  { bin: '970409', name: 'Bac A Bank', aliases: ['bab'] },
  { bin: '970425', name: 'ABBANK', aliases: ['abb', 'anbinh'] },
  { bin: '970433', name: 'VietBank', aliases: ['vbb'] },
  { bin: '970427', name: 'VietABank', aliases: ['vab'] },
  { bin: '970452', name: 'Kienlongbank', aliases: ['klb'] },
  { bin: '970412', name: 'PVcomBank', aliases: ['pvcb'] },
  { bin: '970429', name: 'SCB', aliases: [] },
  { bin: '970438', name: 'BaoViet Bank', aliases: ['baoviet'] },
  { bin: '970419', name: 'NCB', aliases: ['quocdan'] },
  { bin: '970454', name: 'BVBank', aliases: ['vietcapitalbank', 'vietcapital', 'banviet', 'vccb'] },
  { bin: '970430', name: 'PG Bank', aliases: ['pgb'] },
  { bin: '970400', name: 'Saigonbank', aliases: ['sgb'] },
  { bin: '970406', name: 'DongA Bank', aliases: ['dab'] },
  { bin: '970408', name: 'GPBank', aliases: ['gpb'] },
  { bin: '970414', name: 'OceanBank', aliases: [] },
  { bin: '970424', name: 'Shinhan Bank', aliases: ['shinhan'] },
  { bin: '970457', name: 'Woori Bank', aliases: ['woori'] },
  { bin: '970458', name: 'UOB', aliases: [] },
  { bin: '970410', name: 'Standard Chartered', aliases: [] },
  { bin: '970434', name: 'Indovina Bank', aliases: ['ivb', 'indovina'] },
  { bin: '970442', name: 'Hong Leong Bank', aliases: ['hongleong'] },
  { bin: '970439', name: 'Public Bank', aliases: [] },
  { bin: '422589', name: 'CIMB', aliases: [] },
  { bin: '458761', name: 'HSBC', aliases: [] },
  { bin: '668888', name: 'KBank', aliases: ['kasikornbank'] },
  { bin: '546034', name: 'CAKE by VPBank', aliases: ['cake'] },
  { bin: '546035', name: 'Ubank by VPBank', aliases: ['ubank'] },
  { bin: '963388', name: 'Timo', aliases: [] },
];

/** Bỏ dấu tiếng Việt (giữ chữ hoa / thường) */
export function stripVietnamese(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D');
}

/** Khoá so khớp tên ngân hàng: bỏ dấu, bỏ chữ "ngân hàng", bỏ ký tự không phải chữ / số, chữ thường */
function bankKey(text: string): string {
  return stripVietnamese(text)
    .toLowerCase()
    .replace(/ngan\s*hang/g, '')
    .replace(/[^a-z0-9]/g, '');
}

const BANK_KEYS = VIETQR_BANKS.map((bank) => ({
  bank,
  keys: [bankKey(bank.name), ...bank.aliases.map(bankKey)].filter(Boolean),
}));

/** Tìm ngân hàng theo tên / mã viết tắt; khớp đúng trước, rồi tới chứa tên (≥ 4 ký tự, ưu tiên tên dài nhất) */
export function findBank(text: string): VietQRBank | null {
  const key = bankKey(text);
  if (!key) return null;
  const exact = BANK_KEYS.find((b) => b.keys.includes(key));
  if (exact) return exact.bank;
  let best: { bank: VietQRBank; len: number } | null = null;
  for (const b of BANK_KEYS) {
    for (const k of b.keys) {
      if (k.length >= 4 && key.includes(k) && (!best || k.length > best.len)) best = { bank: b.bank, len: k.length };
    }
  }
  return best?.bank ?? null;
}

/** Lọc ngân hàng cho ô tìm kiếm */
export function searchBanks(query: string): VietQRBank[] {
  const key = bankKey(query);
  if (!key) return VIETQR_BANKS;
  return VIETQR_BANKS.filter((b) => [bankKey(b.name), ...b.aliases.map(bankKey)].some((k) => k.includes(key)));
}

/** Số tài khoản hợp lệ cho VietQR: 6–19 chữ số (cho phép khoảng trắng / dấu chấm khi nhập) */
export function normalizeAccountNumber(text: string): string | null {
  const digits = text.replace(/[\s.]/g, '');
  return /^\d{6,19}$/.test(digits) ? digits : null;
}

/** Tên chủ tài khoản như app ngân hàng hiển thị: không dấu, chữ hoa */
export function normalizeAccountName(text: string): string {
  return stripVietnamese(text).toUpperCase().replace(/\s+/g, ' ').trim();
}

export type ParsedBankHandle = {
  bank: VietQRBank | null;
  accountNumber: string | null;
  accountName: string;
};

/**
 * Tách "Vietcombank - 1234567890 - NGUYEN VAN AN" (hoặc "Vietcombank 1234567890 Nguyen Van An")
 * thành ngân hàng / số tài khoản / tên. Phần không nhận ra được trả null.
 */
export function parseBankHandle(text: string): ParsedBankHandle {
  let parts = text
    .split(/\s*(?:[-–—|,;:\n]|\/)\s*/)
    .map((p) => p.trim())
    .filter(Boolean);

  // Một dòng không có dấu ngăn cách → tách theo số tài khoản
  if (parts.length === 1) {
    const m = parts[0].match(/\d[\d .]{4,}\d/);
    if (m) {
      const before = parts[0].slice(0, m.index).trim();
      const after = parts[0].slice(m.index! + m[0].length).trim();
      parts = [before, m[0], after].filter(Boolean);
    }
  }

  let bank: VietQRBank | null = null;
  let accountNumber: string | null = null;
  const rest: string[] = [];
  for (const part of parts) {
    if (!accountNumber) {
      const acc = normalizeAccountNumber(part);
      if (acc) {
        accountNumber = acc;
        continue;
      }
    }
    if (!bank) {
      const found = findBank(part);
      if (found) {
        bank = found;
        continue;
      }
    }
    rest.push(part);
  }
  return { bank, accountNumber, accountName: normalizeAccountName(rest.join(' ')) };
}

/** Ghép lại thành display_text chuẩn */
export function formatBankHandle(bank: VietQRBank, accountNumber: string, accountName: string): string {
  const name = normalizeAccountName(accountName);
  return [bank.name, accountNumber, name].filter(Boolean).join(' - ');
}

/** CRC-16/CCITT-FALSE (poly 0x1021, init 0xFFFF) — trường 63 của EMVCo */
export function crc16(payload: string): string {
  let crc = 0xffff;
  for (let i = 0; i < payload.length; i++) {
    crc ^= payload.charCodeAt(i) << 8;
    for (let j = 0; j < 8; j++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

function tlv(id: string, value: string): string {
  return `${id}${value.length.toString().padStart(2, '0')}${value}`;
}

/** Nội dung chuyển khoản: không dấu, chỉ chữ / số / khoảng trắng, tối đa 25 ký tự (giới hạn chung của các app) */
export function sanitizeTransferMemo(text: string): string {
  return stripVietnamese(text)
    .replace(/[^A-Za-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 25)
    .trim();
}

/** Chuỗi VietQR chuyển khoản tới tài khoản (dịch vụ QRIBFTTA). Có số tiền → mã động (12), không → mã tĩnh (11). */
export function buildVietQR({
  bin,
  accountNumber,
  amount,
  memo,
}: {
  bin: string;
  accountNumber: string;
  amount?: number | null;
  memo?: string | null;
}): string {
  const hasAmount = amount != null && Number.isFinite(amount) && amount > 0;
  const beneficiary = tlv('00', bin) + tlv('01', accountNumber);
  const merchant = tlv('00', 'A000000727') + tlv('01', beneficiary) + tlv('02', 'QRIBFTTA');
  const cleanMemo = memo ? sanitizeTransferMemo(memo) : '';

  let payload = tlv('00', '01') + tlv('01', hasAmount ? '12' : '11') + tlv('38', merchant) + tlv('53', '704');
  if (hasAmount) payload += tlv('54', String(Math.round(amount!)));
  payload += tlv('58', 'VN');
  if (cleanMemo) payload += tlv('62', tlv('08', cleanMemo));
  payload += '6304';
  return payload + crc16(payload);
}

/** Dựng mã QR từ display_text; null nếu chưa nhận ra ngân hàng hoặc số tài khoản */
export function bankHandleQR(
  displayText: string,
  opts?: { amount?: number | null; memo?: string | null },
): { payload: string; parsed: ParsedBankHandle & { bank: VietQRBank; accountNumber: string } } | null {
  const parsed = parseBankHandle(displayText);
  if (!parsed.bank || !parsed.accountNumber) return null;
  return {
    payload: buildVietQR({ bin: parsed.bank.bin, accountNumber: parsed.accountNumber, ...opts }),
    parsed: parsed as ParsedBankHandle & { bank: VietQRBank; accountNumber: string },
  };
}
