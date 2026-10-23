/**
 * OCR-02 / OCR-06: Món trên hóa đơn đã được người dùng kiểm tra — lưu qua RPC
 * set_expense_receipt_items (migration 0017), đọc qua bảng receipt_items (RLS theo khoản chi).
 */
import { throwApiError } from '@/api/errors';
import type { ReceiptItem, ReceiptItemKind } from '@/domain/receipt';
import { supabase } from '@/lib/supabase';

export type ExpenseSource = 'MANUAL' | 'OCR' | 'OCR_AI';

export type ReceiptItemRow = ReceiptItem & { id: string; position: number };

/** Ghi lại toàn bộ danh sách dòng của khoản chi (thay thế) và đánh dấu nguồn; gọi lại được nhiều lần */
export async function saveReceiptItems(
  expenseId: string,
  items: ReceiptItem[],
  source: ExpenseSource = 'OCR',
): Promise<number> {
  const { data, error, status } = await supabase.rpc('set_expense_receipt_items', {
    _expense_id: expenseId,
    _items: items.map((it) => ({ name: it.name, quantity: it.quantity, amount: it.amount, kind: it.kind })),
    _source: source,
  });
  if (error) throwApiError(error, status);
  return data as number;
}

export async function fetchReceiptItems(expenseId: string): Promise<ReceiptItemRow[]> {
  const { data, error, status } = await supabase
    .from('receipt_items')
    .select('id, position, kind, name, quantity, amount')
    .eq('expense_id', expenseId)
    .order('position', { ascending: true });
  if (error) throwApiError(error, status);
  return (data ?? []).map((r) => ({
    id: r.id as string,
    position: r.position as number,
    kind: r.kind as ReceiptItemKind,
    name: r.name as string,
    quantity: Number(r.quantity),
    amount: Number(r.amount),
  }));
}
