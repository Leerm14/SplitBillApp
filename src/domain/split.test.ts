import { bpToPercentText, FULL_BP, parsePercentToBp, percentInputsToBp, splitEqual, splitPercent, splitPercentEqually, validateShares } from "./split";

// ─── splitEqual ─────────────────────────────────────────────────────────────

describe("splitEqual", () => {
  test("Chia đều không dư", () => {
    const result = splitEqual(90_000, ["A", "B", "C"]);
    expect(result).toEqual([
      { userId: "A", amount: 30_000 },
      { userId: "B", amount: 30_000 },
      { userId: "C", amount: 30_000 },
    ]);
    expect(result.reduce((s, r) => s + r.amount, 0)).toBe(90_000);
  });

  test("Chia đều có dư — phần dư cộng cho người đầu (sắp theo userId)", () => {
    const result = splitEqual(100_000, ["C", "A", "B"]);
    // Sắp theo userId: A, B, C
    // 100_000 / 3 = 33_333 dư 1 → A nhận thêm 1đ
    expect(result).toEqual([
      { userId: "A", amount: 33_334 },
      { userId: "B", amount: 33_333 },
      { userId: "C", amount: 33_333 },
    ]);
    expect(result.reduce((s, r) => s + r.amount, 0)).toBe(100_000);
  });

  test("Chia đều có dư lớn — dư 4 cho 5 người", () => {
    const result = splitEqual(99, ["e", "d", "c", "b", "a"]);
    // 99 / 5 = 19 dư 4 → 4 người đầu (a, b, c, d) nhận 20, người cuối (e) nhận 19
    expect(result).toEqual([
      { userId: "a", amount: 20 },
      { userId: "b", amount: 20 },
      { userId: "c", amount: 20 },
      { userId: "d", amount: 20 },
      { userId: "e", amount: 19 },
    ]);
    expect(result.reduce((s, r) => s + r.amount, 0)).toBe(99);
  });

  test("Một người — nhận tất", () => {
    const result = splitEqual(500_000, ["A"]);
    expect(result).toEqual([{ userId: "A", amount: 500_000 }]);
  });

  test("Hai người — chia đều", () => {
    const result = splitEqual(100_000, ["A", "B"]);
    expect(result).toEqual([
      { userId: "A", amount: 50_000 },
      { userId: "B", amount: 50_000 },
    ]);
  });

  test("Số tiền 1đ chia cho 3 người → 1 người nhận 1đ, 2 người nhận 0đ", () => {
    const result = splitEqual(1, ["A", "B", "C"]);
    expect(result).toEqual([
      { userId: "A", amount: 1 },
      { userId: "B", amount: 0 },
      { userId: "C", amount: 0 },
    ]);
    expect(result.reduce((s, r) => s + r.amount, 0)).toBe(1);
  });

  test("Tổng luôn bằng amount — 100 trường hợp ngẫu nhiên", () => {
    const rng = mulberry32(99);
    for (let t = 0; t < 100; t++) {
      const n = 1 + Math.floor(rng() * 10);
      const amount = 1 + Math.floor(rng() * 10_000_000);
      const ids = Array.from({ length: n }, (_, i) => `u${i}`);
      const result = splitEqual(amount, ids);
      const sum = result.reduce((s, r) => s + r.amount, 0);
      expect(sum).toBe(amount);
      // Mỗi phần không âm
      for (const r of result) {
        expect(r.amount).toBeGreaterThanOrEqual(0);
      }
    }
  });

  test("Throw nếu amount <= 0", () => {
    expect(() => splitEqual(0, ["A"])).toThrow("Số tiền phải là số nguyên dương");
    expect(() => splitEqual(-1, ["A"])).toThrow("Số tiền phải là số nguyên dương");
  });

  test("Throw nếu amount không phải số nguyên", () => {
    expect(() => splitEqual(100.5, ["A"])).toThrow("Số tiền phải là số nguyên dương");
  });

  test("Throw nếu danh sách người rỗng", () => {
    expect(() => splitEqual(100, [])).toThrow("Phải có ít nhất 1 người");
  });

  test("Kết quả sắp theo userId tăng dần", () => {
    const result = splitEqual(100, ["z", "m", "a"]);
    expect(result.map((r) => r.userId)).toEqual(["a", "m", "z"]);
  });
});

// ─── validateShares ─────────────────────────────────────────────────────────

describe("validateShares", () => {
  test("Hợp lệ — tổng khớp", () => {
    expect(
      validateShares(100_000, [
        { userId: "A", amount: 60_000 },
        { userId: "B", amount: 40_000 },
      ]),
    ).toBe(true);
  });

  test("Hợp lệ — một người chịu 0đ", () => {
    expect(
      validateShares(100_000, [
        { userId: "A", amount: 100_000 },
        { userId: "B", amount: 0 },
      ]),
    ).toBe(true);
  });

  test("Throw nếu tổng không khớp", () => {
    expect(() =>
      validateShares(100_000, [
        { userId: "A", amount: 50_000 },
        { userId: "B", amount: 40_000 },
      ]),
    ).toThrow("Tổng phần chia");
  });

  test("Throw nếu phần chia âm", () => {
    expect(() =>
      validateShares(100_000, [
        { userId: "A", amount: 150_000 },
        { userId: "B", amount: -50_000 },
      ]),
    ).toThrow("Phần chia không hợp lệ");
  });

  test("Throw nếu phần chia không phải số nguyên", () => {
    expect(() =>
      validateShares(100_000, [
        { userId: "A", amount: 50_000.5 },
        { userId: "B", amount: 49_999.5 },
      ]),
    ).toThrow("Phần chia không hợp lệ");
  });

  test("Throw nếu có userId trùng", () => {
    expect(() =>
      validateShares(100_000, [
        { userId: "A", amount: 50_000 },
        { userId: "A", amount: 50_000 },
      ]),
    ).toThrow("userId bị trùng");
  });

  test("Throw nếu danh sách phần chia rỗng", () => {
    expect(() => validateShares(100_000, [])).toThrow("Phải có ít nhất 1 phần chia");
  });
});

// ─── PRNG ───────────────────────────────────────────────────────────────────

function mulberry32(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// DOM-04 / APP-09: chia theo phần trăm (phần vạn)
describe("splitPercent", () => {
  const sum = (xs: { amount: number }[]) => xs.reduce((s, x) => s + x.amount, 0);

  test("50/50 chia đúng", () => {
    expect(splitPercent(100_000, [{ userId: "B", bp: 5000 }, { userId: "A", bp: 5000 }])).toEqual([
      { userId: "A", amount: 50_000, percentBp: 5000 },
      { userId: "B", amount: 50_000, percentBp: 5000 },
    ]);
  });

  test("Phần dư cộng 1đ theo user_id tăng dần", () => {
    // 100đ × 33,33% = 33,33 → 33 mỗi người, dư 1đ (100 − 99) → người có mã nhỏ nhất
    const r = splitPercent(100, [
      { userId: "c", bp: 3333 },
      { userId: "a", bp: 3333 },
      { userId: "b", bp: 3334 },
    ]);
    expect(r.map((x) => x.userId)).toEqual(["a", "b", "c"]);
    expect(r.map((x) => x.amount)).toEqual([34, 33, 33]);
    expect(sum(r)).toBe(100);
  });

  test("Tổng phần chia luôn bằng tổng khoản chi", () => {
    for (const amount of [1, 7, 99, 1_001, 45_000, 1_234_567, 999_999_999]) {
      const r = splitPercent(amount, [
        { userId: "u1", bp: 1 },
        { userId: "u2", bp: 2999 },
        { userId: "u3", bp: 3500 },
        { userId: "u4", bp: 3500 },
      ]);
      expect(sum(r)).toBe(amount);
    }
  });

  test("Người 0% không nhận phần dư", () => {
    const r = splitPercent(10, [{ userId: "a", bp: 0 }, { userId: "b", bp: 3333 }, { userId: "c", bp: 6667 }]);
    expect(r.find((x) => x.userId === "a")!.amount).toBe(0);
    expect(sum(r)).toBe(10);
  });

  test("Số tiền lớn không mất chính xác", () => {
    const amount = Number.MAX_SAFE_INTEGER;
    const r = splitPercent(amount, [{ userId: "a", bp: 5000 }, { userId: "b", bp: 5000 }]);
    expect(sum(r)).toBe(amount);
  });

  test("Tổng bp ≠ 10000 → throw", () => {
    expect(() => splitPercent(100, [{ userId: "a", bp: 5000 }, { userId: "b", bp: 4000 }])).toThrow("100%");
    expect(() => splitPercent(100, [{ userId: "a", bp: 6000 }, { userId: "b", bp: 5000 }])).toThrow("100%");
  });

  test("bp không hợp lệ hoặc trùng người → throw", () => {
    expect(() => splitPercent(100, [{ userId: "a", bp: 50.5 }, { userId: "b", bp: 9949.5 }])).toThrow();
    expect(() => splitPercent(100, [{ userId: "a", bp: -100 }, { userId: "b", bp: 10100 }])).toThrow();
    expect(() => splitPercent(100, [{ userId: "a", bp: 5000 }, { userId: "a", bp: 5000 }])).toThrow("trùng");
  });

  test("Số tiền không hợp lệ hoặc danh sách rỗng → throw", () => {
    expect(() => splitPercent(0, [{ userId: "a", bp: 10000 }])).toThrow();
    expect(() => splitPercent(10.5, [{ userId: "a", bp: 10000 }])).toThrow();
    expect(() => splitPercent(100, [])).toThrow();
  });
});

describe("parsePercentToBp", () => {
  test("Số nguyên và thập phân", () => {
    expect(parsePercentToBp("50")).toBe(5000);
    expect(parsePercentToBp("33.33")).toBe(3333);
    expect(parsePercentToBp("33,3")).toBe(3330);
    expect(parsePercentToBp("100")).toBe(10000);
    expect(parsePercentToBp("")).toBe(0);
  });

  test("Không hợp lệ → null", () => {
    expect(parsePercentToBp("100.01")).toBeNull();
    expect(parsePercentToBp("12.345")).toBeNull();
    expect(parsePercentToBp("-5")).toBeNull();
    expect(parsePercentToBp("abc")).toBeNull();
  });
});

describe("percentInputsToBp / bpToPercentText", () => {
  test("Đọc ô nhập và hiển thị lại", () => {
    expect(percentInputsToBp(["a", "b"], { a: "33.33", b: "66,67" })).toEqual([
      { userId: "a", bp: 3333 },
      { userId: "b", bp: 6667 },
    ]);
    expect(percentInputsToBp(["a"], { a: "x" })).toBeNull();
    expect(bpToPercentText(3333)).toBe("33.33");
    expect(bpToPercentText(3330)).toBe("33.3");
    expect(bpToPercentText(5000)).toBe("50");
    expect(bpToPercentText(5)).toBe("0.05");
  });
});

describe("REV-S9: splitPercentEqually (Chia đều %)", () => {
  test("Ba người: phần dư 1bp cho user_id nhỏ nhất, tổng đúng 100%", () => {
    const bp = splitPercentEqually(["c", "a", "b"]);
    expect(bp).toEqual([
      { userId: "a", bp: 3334 },
      { userId: "b", bp: 3333 },
      { userId: "c", bp: 3333 },
    ]);
    expect(bp.reduce((s, x) => s + x.bp, 0)).toBe(FULL_BP);
    expect(bp.map((x) => bpToPercentText(x.bp))).toEqual(["33.34", "33.33", "33.33"]);
  });

  test("Điền lại ô phần trăm rồi chia tiền được ngay (không báo lệch 100%)", () => {
    const ids = ["u3", "u1", "u2"];
    const inputs = Object.fromEntries(splitPercentEqually(ids).map((x) => [x.userId, bpToPercentText(x.bp)]));
    const bpList = percentInputsToBp(ids, inputs);
    expect(bpList).not.toBeNull();
    const shares = splitPercent(100_000, bpList!);
    expect(shares.reduce((s, x) => s + x.amount, 0)).toBe(100_000);
  });

  test("Chia hết và rỗng", () => {
    expect(splitPercentEqually(["a", "b"]).map((x) => x.bp)).toEqual([5000, 5000]);
    expect(splitPercentEqually([])).toEqual([]);
  });

  test("Bảy người: tổng vẫn đúng 100%", () => {
    const bp = splitPercentEqually(["1", "2", "3", "4", "5", "6", "7"]);
    expect(bp.reduce((s, x) => s + x.bp, 0)).toBe(FULL_BP);
    expect(bp[0].bp).toBe(1429);
    expect(bp[6].bp).toBe(1428);
  });
});
