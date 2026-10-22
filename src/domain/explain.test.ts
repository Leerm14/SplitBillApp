import { explainDebt, type ExpenseInput } from './explain';
import { pairwiseDebts } from './pairwise';
import { computeBalances, simplifyDebts, type PaymentInput } from './settlement';

describe('explainDebt', () => {
  const memberNames = new Map([
    ['A', 'Alice'],
    ['B', 'Bob'],
    ['C', 'Charlie'],
  ]);

  test('AC-02.1 — C trả A 45.000đ, giải thích nguồn gốc', () => {
    const expenses: ExpenseInput[] = [
      {
        id: 'e1',
        paidBy: 'A',
        status: 'ACTIVE',
        shares: [
          { userId: 'A', amount: 30_000 },
          { userId: 'B', amount: 30_000 },
          { userId: 'C', amount: 30_000 },
        ],
        description: 'Bữa trưa',
      },
      {
        id: 'e2',
        paidBy: 'B',
        status: 'ACTIVE',
        shares: [
          { userId: 'A', amount: 15_000 },
          { userId: 'B', amount: 15_000 },
          { userId: 'C', amount: 15_000 },
        ],
        description: 'Cà phê',
      },
    ];

    const result = explainDebt('C', 'A', 45_000, expenses, [], memberNames);
    expect(result.from).toBe('C');
    expect(result.to).toBe('A');
    expect(result.amount).toBe(45_000);
    // DOM-01: liệt kê MỌI khoản C có phần chịu: 30.000đ (A trả) + 15.000đ (B trả)
    expect(result.totalShare).toBe(45_000);
    expect(result.totalOwedToRecipient).toBe(30_000);
    expect(result.contributions).toEqual([
      { expenseId: 'e1', description: 'Bữa trưa', paidBy: 'A', shareAmount: 30_000 },
      { expenseId: 'e2', description: 'Cà phê', paidBy: 'B', shareAmount: 15_000 },
    ]);
    expect(result.nettedVia).toEqual(['B']);
    // Câu mẫu AC-02.1 / BR-08
    expect(result.summary).toBe(
      'Phần Charlie chịu: 30.000đ Bữa trưa (Alice trả) + 15.000đ Cà phê (Bob trả), ' +
        'phần Bob ứng đã được bù trừ qua Alice.',
    );
  });

  test('AC-02.1 — B (số dư 0) không cần giải thích chuyển khoản', () => {
    // B ứng 30.000đ cho A, C trong bữa B trả; phần B chịu 30.000đ ở bữa A trả → cân bằng
    const expenses: ExpenseInput[] = [
      { id: 'e1', paidBy: 'A', status: 'ACTIVE', shares: [
        { userId: 'A', amount: 30_000 }, { userId: 'B', amount: 30_000 }, { userId: 'C', amount: 30_000 },
      ], description: 'Bữa trưa' },
      { id: 'e2', paidBy: 'B', status: 'ACTIVE', shares: [
        { userId: 'A', amount: 15_000 }, { userId: 'B', amount: 15_000 }, { userId: 'C', amount: 15_000 },
      ], description: 'Cà phê' },
    ];
    const result = explainDebt('B', 'A', 0, expenses, [], memberNames);
    expect(result.totalShare).toBe(30_000);
    expect(result.totalAdvanced).toBe(30_000);
  });

  test('BR-09 tắt bù trừ — chỉ tính khoản do người nhận trả', () => {
    const expenses: ExpenseInput[] = [
      { id: 'e1', paidBy: 'A', status: 'ACTIVE', shares: [
        { userId: 'A', amount: 30_000 }, { userId: 'B', amount: 30_000 }, { userId: 'C', amount: 30_000 },
      ], description: 'Bữa trưa' },
      { id: 'e2', paidBy: 'B', status: 'ACTIVE', shares: [
        { userId: 'A', amount: 15_000 }, { userId: 'B', amount: 15_000 }, { userId: 'C', amount: 15_000 },
      ], description: 'Cà phê' },
    ];
    // AC-05.1: B→A 15.000đ = 30.000đ (B chịu, A trả) − 15.000đ (A chịu, B trả)
    const result = explainDebt('B', 'A', 15_000, expenses, [], memberNames, { simplify: false });
    expect(result.contributions).toEqual([
      { expenseId: 'e1', description: 'Bữa trưa', paidBy: 'A', shareAmount: 30_000 },
    ]);
    expect(result.totalAdvanced).toBe(15_000);
    expect(result.nettedVia).toEqual([]);
    expect(result.summary).not.toContain('bù trừ qua');
  });

  test('Nợ trực tiếp — không bù trừ', () => {
    const expenses: ExpenseInput[] = [
      {
        id: 'e3',
        paidBy: 'A',
        status: 'ACTIVE',
        shares: [
          { userId: 'A', amount: 50_000 },
          { userId: 'B', amount: 50_000 },
        ],
        description: 'Ăn tối',
      },
    ];

    const result = explainDebt('B', 'A', 50_000, expenses, [], memberNames);
    expect(result.contributions).toHaveLength(1);
    expect(result.totalOwedToRecipient).toBe(50_000);
    expect(result.nettedVia).toEqual([]);
    expect(result.summary).not.toContain('bù trừ');
    expect(result.totalPaidToRecipient).toBe(0);
    // Tổng = amount + paid, nên không có bù trừ
    expect(result.summary).toContain('50.000');
  });

  test('Đã thanh toán một phần', () => {
    const expenses: ExpenseInput[] = [
      {
        id: 'e3',
        paidBy: 'A',
        status: 'ACTIVE',
        shares: [
          { userId: 'A', amount: 50_000 },
          { userId: 'B', amount: 50_000 },
        ],
        description: 'Ăn tối',
      },
    ];
    const payments: PaymentInput[] = [
      { fromId: 'B', toId: 'A', amount: 20_000, status: 'CONFIRMED' },
    ];

    const result = explainDebt('B', 'A', 30_000, expenses, payments, memberNames);
    expect(result.totalPaidToRecipient).toBe(20_000);
    expect(result.summary).toContain('20.000');
  });

  test('Bỏ qua khoản chi đã hủy', () => {
    const expenses: ExpenseInput[] = [
      {
        id: 'e5',
        paidBy: 'A',
        status: 'CANCELLED',
        shares: [
          { userId: 'A', amount: 50_000 },
          { userId: 'B', amount: 50_000 },
        ],
        description: 'Đã hủy',
      },
    ];

    const result = explainDebt('B', 'A', 0, expenses, [], memberNames);
    expect(result.contributions).toHaveLength(0);
  });

  test('Không có khoản liên quan — giải thích bù trừ nhóm', () => {
    const result = explainDebt('C', 'A', 45_000, [], [], memberNames);
    expect(result.contributions).toHaveLength(0);
    expect(result.summary).toContain('bù trừ nợ trong nhóm');
  });
});


describe('REV-S1: giải thích không mâu thuẫn với số tiền chuyển', () => {
  const names = new Map([
    ['A', 'Alice'],
    ['B', 'Bob'],
    ['C', 'Charlie'],
  ]);
  const ids = ['A', 'B', 'C'];
  const lunchAndCoffee: ExpenseInput[] = [
    { id: 'e1', paidBy: 'A', status: 'ACTIVE', description: 'Bữa trưa', shares: [
      { userId: 'A', amount: 30_000 }, { userId: 'B', amount: 30_000 }, { userId: 'C', amount: 30_000 },
    ] },
    { id: 'e2', paidBy: 'B', status: 'ACTIVE', description: 'Cà phê', shares: [
      { userId: 'A', amount: 15_000 }, { userId: 'B', amount: 15_000 }, { userId: 'C', amount: 15_000 },
    ] },
  ];
  const suggest = (expenses: ExpenseInput[], payments: PaymentInput[]) =>
    simplifyDebts(computeBalances(ids, expenses, payments, { includePending: true }));

  test('Hai chủ nợ: A trả 60.000đ cho C, B trả 40.000đ cho C → không nói bù trừ, tách tổng', () => {
    const expenses: ExpenseInput[] = [
      { id: 'x1', paidBy: 'A', status: 'ACTIVE', description: 'Ăn trưa', shares: [{ userId: 'C', amount: 60_000 }] },
      { id: 'x2', paidBy: 'B', status: 'ACTIVE', description: 'Taxi', shares: [{ userId: 'C', amount: 40_000 }] },
    ];
    const transfers = suggest(expenses, []);
    expect(transfers).toEqual(
      expect.arrayContaining([
        { from: 'C', to: 'A', amount: 60_000 },
        { from: 'C', to: 'B', amount: 40_000 },
      ]),
    );
    const r = explainDebt('C', 'A', 60_000, expenses, [], names, { transfers });
    expect(r.nettedVia).toEqual([]);
    expect(r.summary).not.toContain('bù trừ');
    expect(r.expectedTotal).toBe(100_000);
    expect(r.itemsTotal).toBe(100_000);
    expect(r.mismatch).toBe(0);
    expect(r.summary).toContain('Tổng Charlie cần trả 100.000đ = Alice 60.000đ + Bob 40.000đ.');
  });

  test('Thanh toán cho người thứ ba: C đã trả B 15.000đ → B không bị nói là bù trừ qua A', () => {
    const payments: PaymentInput[] = [{ fromId: 'C', toId: 'B', amount: 15_000, status: 'CONFIRMED' }];
    const transfers = suggest(lunchAndCoffee, payments);
    const cToA = transfers.find((t) => t.from === 'C' && t.to === 'A')!;
    expect(cToA.amount).toBe(30_000);
    const r = explainDebt('C', 'A', cToA.amount, lunchAndCoffee, payments, names, { transfers });
    expect(r.nettedVia).toEqual([]);
    expect(r.paymentLines).toEqual([{ direction: 'sent', counterparty: 'B', amount: 15_000, status: 'CONFIRMED' }]);
    expect(r.itemsTotal).toBe(30_000);
    expect(r.mismatch).toBe(0);
    expect(r.summary).toContain('Đã trả Bob 15.000đ.');
    expect(r.summary).not.toContain('bù trừ');
  });

  test('Thanh toán PENDING được tính và ghi "chờ xác nhận"', () => {
    const expenses: ExpenseInput[] = [
      { id: 'big', paidBy: 'A', status: 'ACTIVE', description: 'Khách sạn', shares: [
        { userId: 'A', amount: 300_000 }, { userId: 'B', amount: 300_000 }, { userId: 'C', amount: 300_000 },
      ] },
    ];
    const payments: PaymentInput[] = [
      { fromId: 'B', toId: 'A', amount: 200_000, status: 'CONFIRMED' },
      { fromId: 'C', toId: 'A', amount: 100_000, status: 'PENDING' },
    ];
    const transfers = suggest(expenses, payments);
    const cToA = transfers.find((t) => t.from === 'C')!;
    expect(cToA).toEqual({ from: 'C', to: 'A', amount: 200_000 });
    const r = explainDebt('C', 'A', cToA.amount, expenses, payments, names, { transfers });
    expect(r.totalPendingToRecipient).toBe(100_000);
    expect(r.totalPaidToRecipient).toBe(0);
    expect(r.mismatch).toBe(0);
    expect(r.summary).toContain('Đã gửi Alice 100.000đ (chờ xác nhận)');
  });

  test('Từng cặp: thanh toán chiều to → from được cộng vào', () => {
    const expenses: ExpenseInput[] = [
      { id: 'd1', paidBy: 'A', status: 'ACTIVE', description: 'Ăn tối', shares: [
        { userId: 'A', amount: 25_000 }, { userId: 'B', amount: 25_000 },
      ] },
    ];
    const payments: PaymentInput[] = [{ fromId: 'A', toId: 'B', amount: 10_000, status: 'CONFIRMED' }];
    const transfers = pairwiseDebts(ids, expenses, payments, { includePending: true });
    expect(transfers).toEqual([{ from: 'B', to: 'A', amount: 35_000 }]);
    const r = explainDebt('B', 'A', 35_000, expenses, payments, names, { simplify: false, transfers });
    expect(r.paymentLines).toEqual([{ direction: 'received', counterparty: 'A', amount: 10_000, status: 'CONFIRMED' }]);
    expect(r.itemsTotal).toBe(35_000);
    expect(r.mismatch).toBe(0);
    expect(r.summary).toContain('Đã nhận từ Alice 10.000đ, được cộng vào.');
    expect(r.summary).not.toContain('bù trừ qua');
  });

  test('Cặp đã cân bằng: không "Phần X chịu", không câu bù trừ', () => {
    const transfers = suggest(lunchAndCoffee, []);
    expect(transfers).toEqual([{ from: 'C', to: 'A', amount: 45_000 }]);
    const r = explainDebt('B', 'A', 0, lunchAndCoffee, [], names, { transfers });
    expect(r.balanced).toBe(true);
    expect(r.summary).not.toContain('Phần');
    expect(r.summary).not.toContain('bù trừ');
    expect(r.summary).toContain('đã cân bằng');
  });

  test('AC-02.1 vẫn đúng khi truyền đủ bộ gợi ý', () => {
    const transfers = suggest(lunchAndCoffee, []);
    const r = explainDebt('C', 'A', 45_000, lunchAndCoffee, [], names, { transfers });
    expect(r.summary).toBe(
      'Phần Charlie chịu: 30.000đ Bữa trưa (Alice trả) + 15.000đ Cà phê (Bob trả), ' +
        'phần Bob ứng đã được bù trừ qua Alice.',
    );
  });

  test('Mục liệt kê không khớp số tiền → luôn có ghi chú chênh lệch', () => {
    const r = explainDebt('C', 'A', 50_000, lunchAndCoffee, [], names);
    expect(r.mismatch).toBe(5_000);
    expect(r.summary).toContain('chênh 5.000đ');
  });
});
