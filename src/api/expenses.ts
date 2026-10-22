import { supabase } from '@/lib/supabase';

// ============================
// Expenses API
// ============================

// APP-18: Typed interfaces for API responses
export type ExpenseShare = {
  user_id: string;
  amount: number;
  percent_bp?: number;
};

export type ExpenseProfile = {
  id: string;
  display_name: string;
};

export type Expense = {
  id: string;
  group_id: string;
  paid_by: string;
  amount: number;
  description: string;
  status: string;
  split_method: string;
  note: string | null;
  receipt_path: string | null;
  version: number;
  created_by: string;
  created_at: string;
  updated_at: string;
  cancelled_at: string | null;
  expense_shares: ExpenseShare[];
  payer: ExpenseProfile[] | ExpenseProfile | null;
  creator: ExpenseProfile[] | ExpenseProfile | null;
  idempotency_key?: string;
};

export async function fetchExpenses(groupId: string): Promise<Expense[]> {
  const { data, error } = await supabase
    .from('expenses')
    .select(`
      id, group_id, paid_by, amount, description, status, split_method, note,
      receipt_path, version, created_by, created_at, updated_at, cancelled_at,
      expense_shares(user_id, amount, percent_bp),
      payer:paid_by(id, display_name),
      creator:created_by(id, display_name)
    `)
    .eq('group_id', groupId)
    .order('created_at', { ascending: false });

  if (error) throw error;

  // Deduplicate — RLS với nhiều SELECT policies có thể trả trùng row qua JOIN
  const seen = new Set<string>();
  return (data ?? []).filter((e) => {
    if (seen.has(e.id)) return false;
    seen.add(e.id);
    return true;
  }) as Expense[];
}

export async function fetchExpense(expenseId: string): Promise<Expense> {
  const { data, error } = await supabase
    .from('expenses')
    .select(`
      id, group_id, paid_by, amount, description, status, split_method, note,
      receipt_path, version, created_by, idempotency_key, created_at, updated_at, cancelled_at,
      expense_shares(user_id, amount, percent_bp),
      payer:paid_by(id, display_name),
      creator:created_by(id, display_name)
    `)
    .eq('id', expenseId)
    .single();
  if (error) throw error;
  return data as Expense;
}

export async function createExpense(params: {
  groupId: string;
  paidBy: string;
  amount: number;
  description: string;
  shares: { userId: string; amount: number }[];
  idempotencyKey: string;
  splitMethod?: string;
  note?: string;
}) {
  const { data, error } = await supabase.rpc('create_expense', {
    _group_id: params.groupId,
    _paid_by: params.paidBy,
    _amount: params.amount,
    _description: params.description,
    _shares: params.shares,
    _idempotency_key: params.idempotencyKey,
    _split_method: params.splitMethod ?? 'EQUAL',
    _note: params.note ?? '',
  });
  if (error) throw error;
  return data;
}

export async function updateExpense(params: {
  expenseId: string;
  expectedVersion: number;
  paidBy: string;
  amount: number;
  description: string;
  splitMethod: string;
  note: string;
  shares: { userId: string; amount: number }[];
  receiptPath?: string;
}) {
  const { data, error } = await supabase.rpc('update_expense', {
    _expense_id: params.expenseId,
    _expected_version: params.expectedVersion,
    _paid_by: params.paidBy,
    _amount: params.amount,
    _description: params.description,
    _split_method: params.splitMethod,
    _note: params.note,
    _shares: params.shares,
    _receipt_path: params.receiptPath ?? null,
  });
  if (error) throw error;
  return data;
}

export async function cancelExpense(expenseId: string) {
  const { data, error } = await supabase.rpc('cancel_expense', {
    _expense_id: expenseId,
  });
  if (error) throw error;
  return data;
}
