import {
  bankHandleQR,
  buildVietQR,
  crc16,
  findBank,
  formatBankHandle,
  parseBankHandle,
  sanitizeTransferMemo,
} from "./vietqr";

describe("crc16", () => {
  test("Giá trị kiểm tra chuẩn CRC-16/CCITT-FALSE", () => {
    expect(crc16("123456789")).toBe("29B1");
  });
});

describe("findBank", () => {
  test("Tên, mã viết tắt, có dấu / không dấu", () => {
    expect(findBank("Vietcombank")?.bin).toBe("970436");
    expect(findBank("VCB")?.bin).toBe("970436");
    expect(findBank("MB")?.bin).toBe("970422");
    expect(findBank("mb bank")?.bin).toBe("970422");
    expect(findBank("Ngân hàng Techcombank")?.bin).toBe("970407");
    expect(findBank("Ngân hàng TMCP Ngoại thương")?.bin).toBe("970436");
  });

  test("Không nhận ra → null", () => {
    expect(findBank("NGUYEN VAN AN")).toBeNull();
    expect(findBank("")).toBeNull();
  });
});

describe("parseBankHandle", () => {
  test("Dạng chuẩn có gạch ngang", () => {
    const p = parseBankHandle("Vietcombank - 1234567890 - NGUYEN VAN AN");
    expect(p.bank?.name).toBe("Vietcombank");
    expect(p.accountNumber).toBe("1234567890");
    expect(p.accountName).toBe("NGUYEN VAN AN");
  });

  test("Một dòng, tên có dấu, số có khoảng trắng", () => {
    const p = parseBankHandle("Techcombank 1903 4567 8901 Nguyễn Văn Ân");
    expect(p.bank?.name).toBe("Techcombank");
    expect(p.accountNumber).toBe("190345678901");
    expect(p.accountName).toBe("NGUYEN VAN AN");
  });

  test("Thiếu ngân hàng → bank null", () => {
    const p = parseBankHandle("1234567890 - NGUYEN VAN AN");
    expect(p.bank).toBeNull();
    expect(p.accountNumber).toBe("1234567890");
  });

  test("format rồi parse lại giữ nguyên", () => {
    const text = formatBankHandle(findBank("MB")!, "0901234567", "Trần Thị Bình");
    expect(text).toBe("MB Bank - 0901234567 - TRAN THI BINH");
    const p = parseBankHandle(text);
    expect(p.bank?.bin).toBe("970422");
    expect(p.accountNumber).toBe("0901234567");
    expect(p.accountName).toBe("TRAN THI BINH");
  });
});

describe("buildVietQR", () => {
  test("Mã tĩnh (không số tiền)", () => {
    const qr = buildVietQR({ bin: "970436", accountNumber: "1234567890" });
    expect(qr.startsWith("000201010211")).toBe(true);
    expect(qr).toContain("38540010A00000072701240006970436011012345678900208QRIBFTTA");
    expect(qr).toContain("5303704");
    expect(qr).toContain("5802VN");
    expect(qr).not.toContain("5406");
    expect(qr.slice(-8, -4)).toBe("6304");
    expect(qr.slice(-4)).toBe(crc16(qr.slice(0, -4)));
  });

  test("Mã động có số tiền và nội dung", () => {
    const qr = buildVietQR({ bin: "970422", accountNumber: "0901234567", amount: 125000, memo: "Trả tiền ăn trưa!" });
    expect(qr.startsWith("000201010212")).toBe(true);
    expect(qr).toContain("5406125000");
    expect(qr).toContain("62200816Tra tien an trua");
    expect(qr.slice(-4)).toBe(crc16(qr.slice(0, -4)));
  });

  test("Số tiền 0 → mã tĩnh", () => {
    expect(buildVietQR({ bin: "970436", accountNumber: "123456", amount: 0 }).startsWith("000201010211")).toBe(true);
  });
});

describe("sanitizeTransferMemo", () => {
  test("Bỏ dấu, bỏ ký tự đặc biệt, tối đa 25 ký tự", () => {
    expect(sanitizeTransferMemo("Đi Đà Lạt 🏔️ - nhóm #1")).toBe("Di Da Lat nhom 1");
    expect(sanitizeTransferMemo("a".repeat(40)).length).toBe(25);
  });
});

describe("bankHandleQR", () => {
  test("Đủ thông tin → có payload", () => {
    const r = bankHandleQR("Vietcombank - 1234567890 - NGUYEN VAN AN", { amount: 50000 });
    expect(r?.parsed.bank.bin).toBe("970436");
    expect(r?.payload).toContain("540550000");
  });

  test("Ví điện tử / thiếu ngân hàng → null", () => {
    expect(bankHandleQR("MoMo - 0901234567")).toBeNull();
  });
});
