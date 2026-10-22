import { explainDebt, type ExpenseInput } from './explain';
import type { PaymentInput } from './settlement';

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
    expect(result.totalOwedToRecipient).toBe(30_000); // C chỉ nợ A trong khoản A trả
    expect(result.contributions).toHaveLength(1);
    expect(result.contributions[0]).toEqual({
      description: 'Bữa trưa',
      paidBy: 'A',
      shareAmount: 30_000,
    });
    // Tổng hợp phải nói về bù trừ
    expect(result.summary).toContain('30.000');
    expect(result.summary).toContain('bù trừ');
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

