import { splitEqual, validateShares } from "./split";

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
