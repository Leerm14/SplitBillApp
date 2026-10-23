import {
  linesToRows,
  normalizeReceiptItems,
  parseMoneyToken,
  parseReceiptLines,
  parseReceiptText,
  parseRow,
  receiptSum,
  type OcrLine,
} from "./receipt";

const SAMPLE = `QUÁN PHỞ HÀ NỘI
123 Lê Lợi, Q1
ĐT: 0901234567
Ngày: 23/10/2026 12:30
Tên món   SL   Đ.Giá   T.Tiền
Phở bò   1   60.000   60.000
Bún chả  1   50.000   50.000
Trà đá   2   5.000   10.000
Tổng tiền hàng   120.000
Phí dịch vụ 5%   6.000
Tổng thanh toán   126.000
Tiền khách đưa   200.000
Tiền thừa   74.000
Cảm ơn quý khách!`;

describe("parseMoneyToken", () => {
  test("Các dạng số tiền VND", () => {
    expect(parseMoneyToken("60.000")).toBe(60000);
    expect(parseMoneyToken("60,000")).toBe(60000);
    expect(parseMoneyToken("60.000đ")).toBe(60000);
    expect(parseMoneyToken("1.250.000VND")).toBe(1250000);
    expect(parseMoneyToken("126,000.00")).toBe(126000);
    expect(parseMoneyToken("45000")).toBe(45000);
    expect(parseMoneyToken("60k")).toBe(60000);
  });

  test("Không phải tiền: số lượng, số điện thoại, chữ", () => {
    expect(parseMoneyToken("2")).toBeNull();
    expect(parseMoneyToken("0901234567")).toBeNull();
    expect(parseMoneyToken("5%")).toBeNull();
    expect(parseMoneyToken("Q1")).toBeNull();
  });
});

describe("parseRow", () => {
  test("Tên, số lượng, đơn giá, thành tiền", () => {
    expect(parseRow("Trà đá   2   5.000   10.000")).toEqual({ label: "Trà đá", amounts: [5000, 10000], quantity: 2 });
  });

  test("Dạng 2x30.000 và số lượng đứng đầu", () => {
    expect(parseRow("Cà phê 2x30.000")).toEqual({ label: "Cà phê", amounts: [30000], quantity: 2 });
    expect(parseRow("2 x Bánh mì 40.000")).toEqual({ label: "Bánh mì", amounts: [40000], quantity: 2 });
  });
});

describe("parseReceiptText", () => {
  const r = parseReceiptText(SAMPLE);

  test("Tên cửa hàng", () => {
    expect(r.storeName).toBe("QUÁN PHỞ HÀ NỘI");
  });

  test("Món, phí; bỏ địa chỉ, điện thoại, tiền khách đưa, tiền thừa", () => {
    expect(r.items).toEqual([
      { name: "Phở bò", quantity: 1, amount: 60000, kind: "ITEM" },
      { name: "Bún chả", quantity: 1, amount: 50000, kind: "ITEM" },
      { name: "Trà đá", quantity: 2, amount: 10000, kind: "ITEM" },
      { name: "Phí dịch vụ 5%", quantity: 1, amount: 6000, kind: "FEE" },
    ]);
  });

  test("Tổng in trên hóa đơn = dòng tổng lớn nhất, khớp tổng các dòng", () => {
    expect(r.printedTotal).toBe(126000);
    expect(receiptSum(r.items)).toBe(126000);
  });

  test("Giảm giá và thuế", () => {
    const p = parseReceiptText("Cà phê sữa 30.000\nVAT 8% 2.400\nGiảm giá 5.000\nTOTAL 27.400");
    expect(p.items.map((i) => i.kind)).toEqual(["ITEM", "TAX", "DISCOUNT"]);
    expect(receiptSum(p.items)).toBe(27400);
    expect(p.printedTotal).toBe(27400);
  });

  test("Tên món một hàng, giá ở hàng sau", () => {
    const p = parseReceiptText("Highlands Coffee\nPhin sữa đá\n29.000\nTổng cộng 29.000");
    expect(p.storeName).toBe("Highlands Coffee");
    expect(p.items).toEqual([{ name: "Phin sữa đá", quantity: 1, amount: 29000, kind: "ITEM" }]);
  });

  test("Không có dòng tổng → printedTotal null", () => {
    expect(parseReceiptText("Bánh mì 20.000").printedTotal).toBeNull();
  });

  test("Giò lụa không bị coi là giờ", () => {
    expect(parseReceiptText("Quán ăn\nGiò lụa 45.000").items[0]?.name).toBe("Giò lụa");
  });
});

describe("linesToRows / parseReceiptLines", () => {
  // ML Kit tách tên món (cột trái) và giá (cột phải) thành khối riêng
  const f = (top: number, left: number, width = 100, height = 20) => ({ top, left, width, height });
  const lines: OcrLine[] = [
    { text: "60.000", frame: f(103, 400) },
    { text: "Phở bò", frame: f(100, 10) },
    { text: "Bún chả", frame: f(140, 12) },
    { text: "50.000", frame: f(138, 402) },
    { text: "QUÁN PHỞ", frame: f(40, 100) },
    { text: "Tổng", frame: f(180, 10) },
    { text: "110.000", frame: f(182, 400) },
  ];

  test("Ghép theo hàng, trái → phải", () => {
    expect(linesToRows(lines)).toEqual(["QUÁN PHỞ", "Phở bò   60.000", "Bún chả   50.000", "Tổng   110.000"]);
  });

  test("Đọc ra món và tổng", () => {
    const r = parseReceiptLines(lines);
    expect(r.storeName).toBe("QUÁN PHỞ");
    expect(r.items.map((i) => [i.name, i.amount])).toEqual([
      ["Phở bò", 60000],
      ["Bún chả", 50000],
    ]);
    expect(r.printedTotal).toBe(110000);
  });

  test("Thiếu toạ độ → giữ thứ tự", () => {
    expect(linesToRows([{ text: "a" }, { text: " " }, { text: "b" }])).toEqual(["a", "b"]);
  });
});

describe("normalizeReceiptItems", () => {
  test("Bỏ dòng không tên, làm tròn, giới hạn số lượng", () => {
    expect(
      normalizeReceiptItems([
        { name: "  Phở  bò ", quantity: 0, amount: 60000.4, kind: "ITEM" },
        { name: "   ", quantity: 1, amount: 1000, kind: "ITEM" },
        { name: "Trà", quantity: 5000, amount: -5, kind: "ITEM" },
      ]),
    ).toEqual([
      { name: "Phở bò", quantity: 1, amount: 60000, kind: "ITEM" },
      { name: "Trà", quantity: 999, amount: 0, kind: "ITEM" },
    ]);
  });
});
