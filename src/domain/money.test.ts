import { formatVND, parseVND } from "./money";

describe("formatVND", () => {
  test("Số chẵn nghìn", () => {
    expect(formatVND(45_000)).toBe("45.000đ");
  });

  test("Số triệu", () => {
    expect(formatVND(1_500_000)).toBe("1.500.000đ");
  });

  test("Số 0", () => {
    expect(formatVND(0)).toBe("0đ");
  });

  test("Số âm", () => {
    expect(formatVND(-30_000)).toBe("-30.000đ");
  });

  test("Số nhỏ (< 1000)", () => {
    expect(formatVND(500)).toBe("500đ");
  });

  test("Số rất lớn", () => {
    expect(formatVND(999_999_999)).toBe("999.999.999đ");
  });
});

describe("parseVND", () => {
  test("Số thuần", () => {
    expect(parseVND("45000")).toBe(45_000);
  });

  test("Có dấu chấm phân cách", () => {
    expect(parseVND("45.000")).toBe(45_000);
  });

  test("Có ký tự đ", () => {
    expect(parseVND("45.000đ")).toBe(45_000);
  });

  test("Có ký tự ₫", () => {
    expect(parseVND("45.000₫")).toBe(45_000);
  });

  test("Có dấu phẩy", () => {
    expect(parseVND("1,500,000")).toBe(1_500_000);
  });

  test("Chuỗi rỗng → null", () => {
    expect(parseVND("")).toBeNull();
  });

  test("Chữ cái → null", () => {
    expect(parseVND("abc")).toBeNull();
  });

  test("Số âm → null (không hỗ trợ)", () => {
    expect(parseVND("-50000")).toBeNull();
  });

  test("Có khoảng trắng", () => {
    expect(parseVND(" 50 000 ")).toBe(50_000);
  });

  // DOM-03: dấu thập phân và giới hạn số
  test("Dấu phẩy thập phân → null", () => {
    expect(parseVND("45,5")).toBeNull();
    expect(parseVND("45,50")).toBeNull();
  });

  test("Dấu chấm thập phân → null", () => {
    expect(parseVND("45.5")).toBeNull();
    expect(parseVND("100.50")).toBeNull();
  });

  test("Nhóm cuối không đủ 3 chữ số → null", () => {
    expect(parseVND("1,000,5")).toBeNull();
    expect(parseVND("1.000.5")).toBeNull();
    expect(parseVND("1.0000")).toBeNull();
  });

  test("Trộn dấu chấm và dấu phẩy → null", () => {
    expect(parseVND("1.500,000")).toBeNull();
    expect(parseVND("1,500.000")).toBeNull();
  });

  test("Số 0 → null", () => {
    expect(parseVND("0")).toBeNull();
    expect(parseVND("0.000")).toBeNull();
  });

  test("MAX_SAFE_INTEGER vẫn hợp lệ", () => {
    expect(parseVND(String(Number.MAX_SAFE_INTEGER))).toBe(Number.MAX_SAFE_INTEGER);
    expect(parseVND("9.007.199.254.740.991")).toBe(Number.MAX_SAFE_INTEGER);
  });

  test("Vượt MAX_SAFE_INTEGER → null", () => {
    expect(parseVND("9007199254740992")).toBeNull();
    expect(parseVND("99999999999999999999")).toBeNull();
  });
});
