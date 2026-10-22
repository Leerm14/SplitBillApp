import { pairwiseDebts } from './pairwise';
import type { ExpenseInput, PaymentInput } from './settlement';

describe('pairwiseDebts', () => {
  test('AC-05.1 — Tình huống A, B, C ở mục 2, không bù trừ', () => {
    const members = ['A', 'B', 'C'];
    const expenses: ExpenseInput[] = [
      {
        paidBy: 'A',
        status: 'ACTIVE',
        shares: [
          { userId: 'A', amount: 30_000 },
          { userId: 'B', amount: 30_000 },
          { userId: 'C', amount: 30_000 },
        ],
      },
      {
        paidBy: 'B',
        status: 'ACTIVE',
        shares: [
          { userId: 'A', amount: 15_000 },
          { userId: 'B', amount: 15_000 },
          { userId: 'C', amount: 15_000 },
        ],
      },
    ];

    const transfers = pairwiseDebts(members, expenses, []);
    // Theo AC-05.1: C→A 30.000đ, C→B 15.000đ, B→A 15.000đ
    expect(transfers).toHaveLength(3);
    expect(transfers).toEqual(
      expect.arrayContaining([
        { from: 'C', to: 'A', amount: 30_000 },
        { from: 'C', to: 'B', amount: 15_000 },
        { from: 'B', to: 'A', amount: 15_000 },
      ]),
    );
  });

  test('2 người — nợ đơn giản', () => {
    const members = ['A', 'B'];
    const expenses: ExpenseInput[] = [
      {
        paidBy: 'A',
        status: 'ACTIVE',
        shares: [
          { userId: 'A', amount: 50_000 },
          { userId: 'B', amount: 50_000 },
        ],
      },
    ];
    const transfers = pairwiseDebts(members, expenses, []);
    expect(transfers).toEqual([{ from: 'B', to: 'A', amount: 50_000 }]);
  });

  test('Bù trừ từng cặp: A trả B, B trả A', () => {
    const members = ['A', 'B'];
    const expenses: ExpenseInput[] = [
      {
        paidBy: 'A',
        status: 'ACTIVE',
        shares: [
          { userId: 'A', amount: 30_000 },
          { userId: 'B', amount: 30_000 },
        ],
      },
      {
        paidBy: 'B',
        status: 'ACTIVE',
        shares: [
          { userId: 'A', amount: 10_000 },
          { userId: 'B', amount: 10_000 },
        ],
      },
    ];
    const transfers = pairwiseDebts(members, expenses, []);
    // B nợ A 30k, A nợ B 10k → net: B→A 20k
    expect(transfers).toEqual([{ from: 'B', to: 'A', amount: 20_000 }]);
  });

  test('Đã trả hết — không còn nợ', () => {
    const members = ['A', 'B'];
    const expenses: ExpenseInput[] = [
      {
        paidBy: 'A',
        status: 'ACTIVE',
        shares: [
          { userId: 'A', amount: 50_000 },
          { userId: 'B', amount: 50_000 },
        ],
      },
    ];
    const payments: PaymentInput[] = [
      { fromId: 'B', toId: 'A', amount: 50_000, status: 'CONFIRMED' },
    ];
    const transfers = pairwiseDebts(members, expenses, payments);
    expect(transfers).toHaveLength(0);
  });

  test('Bỏ qua khoản chi CANCELLED', () => {
    const members = ['A', 'B'];
    const expenses: ExpenseInput[] = [
      {
        paidBy: 'A',
        status: 'CANCELLED',
        shares: [
          { userId: 'A', amount: 50_000 },
          { userId: 'B', amount: 50_000 },
        ],
      },
    ];
    const transfers = pairwiseDebts(members, expenses, []);
    expect(transfers).toHaveLength(0);
  });

  test('Bỏ qua thanh toán REJECTED', () => {
    const members = ['A', 'B'];
    const expenses: ExpenseInput[] = [
      {
        paidBy: 'A',
        status: 'ACTIVE',
        shares: [
          { userId: 'A', amount: 50_000 },
          { userId: 'B', amount: 50_000 },
        ],
      },
    ];
    const payments: PaymentInput[] = [
      { fromId: 'B', toId: 'A', amount: 50_000, status: 'REJECTED' },
    ];
    const transfers = pairwiseDebts(members, expenses, payments);
    expect(transfers).toEqual([{ from: 'B', to: 'A', amount: 50_000 }]);
  });

  test('Tính cả PENDING khi includePending=true', () => {
    const members = ['A', 'B'];
    const expenses: ExpenseInput[] = [
      {
        paidBy: 'A',
        status: 'ACTIVE',
        shares: [
          { userId: 'A', amount: 50_000 },
          { userId: 'B', amount: 50_000 },
        ],
      },
    ];
    const payments: PaymentInput[] = [
      { fromId: 'B', toId: 'A', amount: 50_000, status: 'PENDING' },
    ];

    // Không tính PENDING
    const t1 = pairwiseDebts(members, expenses, payments);
    expect(t1).toEqual([{ from: 'B', to: 'A', amount: 50_000 }]);

    // Tính PENDING
    const t2 = pairwiseDebts(members, expenses, payments, { includePending: true });
    expect(t2).toHaveLength(0);
  });

  test('Nhóm rỗng — không có nợ', () => {
    const transfers = pairwiseDebts(['A', 'B'], [], []);
    expect(transfers).toHaveLength(0);
  });
});

