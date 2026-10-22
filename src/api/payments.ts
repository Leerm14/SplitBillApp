import { throwApiError } from '@/api/errors';
import { supabase } from '@/lib/supabase';

export type Payment = {
  id: string;
  group_id: string;
  from_id: string;
  to_id: string;
  amount: number;
  status: string;
  note?: string;
  reason?: string;
  method?: string;
  created_at: string;
  decided_at?: string;
  sender?: { id: string; display_name: string }[] | { id: string; display_name: string } | null;
  receiver?: { id: string; display_name: string }[] | { id: string; display_name: string } | null;
};

// ============================
// Payments API
// ============================

export async function fetchPayments(groupId: string): Promise<Payment[]> {
  const { data, error, status } = await supabase
    .from('payments')
    .select(`
      id, group_id, from_id, to_id, amount, status, note, created_at, decided_at,
      sender:from_id(id, display_name),
      receiver:to_id(id, display_name)
    `)
    .eq('group_id', groupId)
    .order('created_at', { ascending: false });

  if (error) throwApiError(error, status);

  // Deduplicate — RLS với nhiều SELECT policies có thể trả trùng row qua JOIN
  const seen = new Set<string>();
  return (data ?? []).filter((p) => {
    if (seen.has(p.id)) return false;
    seen.add(p.id);
    return true;
  }) as Payment[];
}

// SEC-01: Call RPC instead of direct insert
export async function createPayment(params: {
  group_id: string;
  to_id: string;
  amount: number;
  note?: string;
  idempotency_key?: string;
}): Promise<Payment> {
  const { data, error, status } = await supabase.rpc('create_payment', {
    _group_id: params.group_id,
    _to_id: params.to_id,
    _amount: params.amount,
    _note: params.note ?? null,
    _idempotency_key: params.idempotency_key ?? null,
  });

  if (error) throwApiError(error, status);
  return data as Payment;
}

export async function confirmPayment(paymentId: string): Promise<void> {
  const { error, status } = await supabase.rpc('confirm_payment', {
    _payment_id: paymentId,
  });
  if (error) throwApiError(error, status);
}

export async function rejectPayment(paymentId: string, reason?: string): Promise<void> {
  const { error, status } = await supabase.rpc('reject_payment', {
    _payment_id: paymentId,
    _reason: reason ?? null,
  });
  if (error) throwApiError(error, status);
}

export async function disputePayment(paymentId: string, reason: string): Promise<void> {
  const { error, status } = await supabase.rpc('dispute_payment', {
    _payment_id: paymentId,
    _reason: reason,
  });
  if (error) throwApiError(error, status);
}

export async function cancelPayment(paymentId: string): Promise<void> {
  const { error, status } = await supabase.rpc('cancel_payment', {
    _payment_id: paymentId,
  });
  if (error) throwApiError(error, status);
}

export async function fetchPayment(paymentId: string): Promise<Payment> {
  const { data, error, status } = await supabase
    .from('payments')
    .select(`
      id, group_id, from_id, to_id, amount, status, note, reason, method,
      created_at, decided_at,
      sender:from_id(id, display_name),
      receiver:to_id(id, display_name)
    `)
    .eq('id', paymentId)
    .single();
  if (error) throwApiError(error, status);
  return data as Payment;
}

