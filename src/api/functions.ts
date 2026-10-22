import { throwApiError } from '@/api/errors';
import { supabase } from '@/lib/supabase';

/**
 * L1: Gọi Edge Function và đọc lỗi nghiệp vụ trong body.
 * Edge Function trả lỗi dạng JSON `{ error: 'CODE: message' }` với status non-2xx; supabase-js chỉ báo
 * "non-2xx status code" nên phải đọc body từ `error.context` (Response) — giống deleteAccount.
 */
export async function invokeFunction<T>(name: string, body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke<T>(name, { body });
  if (error) {
    const context = (error as { context?: Response }).context;
    let message = typeof error === 'object' && 'message' in error && error.message ? error.message : 'Có lỗi xảy ra';
    // Không gửi được request (mất mạng) → status 0 để isNetworkError nhận ra
    let status: number | null = (error as { name?: string }).name === 'FunctionsFetchError' ? 0 : null;
    if (context && typeof context.json === 'function') {
      status = typeof context.status === 'number' ? context.status : null;
      try {
        const payload = await context.json();
        if (typeof payload?.error === 'string') message = payload.error;
      } catch {
        // body không phải JSON — giữ message gốc
      }
    }
    throwApiError({ message }, status);
  }
  if (data == null) throwApiError({ message: `Edge Function ${name} không trả dữ liệu` }, null);
  return data;
}
