import { throwApiError } from '@/api/errors';
import { compressImage } from '@/lib/image-compress';
import { readFileBytes } from '@/lib/receipt-files';
import { supabase } from '@/lib/supabase';

// ============================
// Ảnh hóa đơn (MVP-01, phương án A: Supabase Storage bucket riêng tư `receipts`)
// ============================

const RECEIPT_BUCKET = 'receipts';
/** Signed URL ngắn hạn — chỉ thành viên nhóm lấy được (policy can_read_receipt). */
export const RECEIPT_URL_TTL_SECONDS = 300;

/** Nén ảnh hóa đơn (cạnh dài ≤ 1600 px, JPEG 0,7). Trả uri file đã nén (thư mục cache). */
export async function compressReceipt(uri: string): Promise<string> {
  return (await compressImage(uri)).uri;
}

/**
 * MVP-01 / L7: Upload ảnh (đã nén) tới đúng `receiptPath` (`<groupId>/<uuid>/<uuid>.jpg`, tạo một lần
 * cho mỗi form). upsert = true để lần thử lại ghi đè cùng đường dẫn thay vì tạo ảnh mồ côi.
 * L8: đọc byte bằng expo-file-system (File.bytes()) thay vì fetch → Blob → Response.arrayBuffer().
 */
export async function uploadReceiptFile(receiptPath: string, localUri: string): Promise<string> {
  const bytes = await readFileBytes(localUri);
  const { error } = await supabase.storage.from(RECEIPT_BUCKET).upload(receiptPath, bytes, {
    contentType: 'image/jpeg',
    upsert: true,
  });
  if (error) {
    const e = error as { message?: string; status?: unknown; statusCode?: unknown };
    const status = typeof e.status === 'number' ? e.status : Number(e.statusCode) || null;
    throwApiError({ message: e.message || 'Không upload được ảnh hóa đơn' }, status);
  }
  return receiptPath;
}

/** MVP-01: Signed URL có hạn cho ảnh hóa đơn (bucket riêng tư). */
export async function getReceiptUrl(receiptPath: string, expiresIn = RECEIPT_URL_TTL_SECONDS): Promise<string> {
  const { data, error } = await supabase.storage.from(RECEIPT_BUCKET).createSignedUrl(receiptPath, expiresIn);
  if (error || !data?.signedUrl) {
    const e = (error ?? {}) as { message?: string; status?: unknown };
    throwApiError({ message: e.message || 'Không lấy được ảnh hóa đơn' }, typeof e.status === 'number' ? e.status : null);
  }
  return data.signedUrl;
}

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
  const { data, error, status } = await supabase
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

  if (error) throwApiError(error, status);

  // Deduplicate — RLS với nhiều SELECT policies có thể trả trùng row qua JOIN
  const seen = new Set<string>();
  return (data ?? []).filter((e) => {
    if (seen.has(e.id)) return false;
    seen.add(e.id);
    return true;
  }) as Expense[];
}

export async function fetchExpense(expenseId: string): Promise<Expense> {
  const { data, error, status } = await supabase
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
  if (error) throwApiError(error, status);
  return data as Expense;
}

/**
 * APP-09: Phần chia gửi lên RPC. Với PERCENT phải gửi kèm percentBp (phần vạn) —
 * RPC đọc `_share->>'percentBp'` để lưu expense_shares.percent_bp.
 */
export type ExpenseShareInput = {
  userId: string;
  amount: number;
  percentBp?: number | null;
};

export async function createExpense(params: {
  groupId: string;
  paidBy: string;
  amount: number;
  description: string;
  shares: ExpenseShareInput[];
  idempotencyKey: string;
  splitMethod?: string;
  note?: string;
  receiptPath?: string;
}) {
  const { data, error, status } = await supabase.rpc('create_expense', {
    _group_id: params.groupId,
    _paid_by: params.paidBy,
    _amount: params.amount,
    _description: params.description,
    _shares: params.shares,
    _idempotency_key: params.idempotencyKey,
    _split_method: params.splitMethod ?? 'EQUAL',
    _note: params.note ?? '',
    _receipt_path: params.receiptPath ?? null,
  });
  if (error) throwApiError(error, status);
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
  shares: ExpenseShareInput[];
  /**
   * MVP-01: update_expense GHI ĐÈ receipt_path bằng giá trị này — bắt buộc truyền rõ:
   * đường dẫn hiện có để giữ, đường dẫn mới để thay, null để xóa ảnh.
   */
  receiptPath: string | null;
}) {
  const { data, error, status } = await supabase.rpc('update_expense', {
    _expense_id: params.expenseId,
    _expected_version: params.expectedVersion,
    _paid_by: params.paidBy,
    _amount: params.amount,
    _description: params.description,
    _split_method: params.splitMethod,
    _note: params.note,
    _shares: params.shares,
    _receipt_path: params.receiptPath,
  });
  if (error) throwApiError(error, status);
  return data;
}

export async function cancelExpense(expenseId: string) {
  const { data, error, status } = await supabase.rpc('cancel_expense', {
    _expense_id: expenseId,
  });
  if (error) throwApiError(error, status);
  return data;
}
