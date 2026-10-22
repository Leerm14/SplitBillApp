import type { AuthChangeEvent, Session } from '@supabase/supabase-js';

import { throwApiError } from '@/api/errors';
import { supabase } from '@/lib/supabase';

// ============================
// Auth API
// ============================

// APP-13: Mọi lệnh gọi Supabase Auth nằm ở đây — màn hình và hook không import supabase

export async function resetPasswordForEmail(email: string): Promise<void> {
  const { error } = await supabase.auth.resetPasswordForEmail(email);
  if (error) throw error;
}

export async function getSession(): Promise<Session | null> {
  const { data, error } = await supabase.auth.getSession();
  if (error) throw error;
  return data.session;
}

/** Lắng nghe thay đổi phiên. Trả về hàm hủy đăng ký. */
export function onAuthStateChange(
  callback: (event: AuthChangeEvent, session: Session | null) => void,
): () => void {
  const {
    data: { subscription },
  } = supabase.auth.onAuthStateChange(callback);
  return () => subscription.unsubscribe();
}

export async function signUpWithEmail(email: string, password: string, displayName: string): Promise<void> {
  const { error } = await supabase.auth.signUp({
    email,
    password,
    options: { data: { display_name: displayName } },
  });
  if (error) throw error;
}

export async function signInWithEmail(email: string, password: string): Promise<void> {
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw error;
}

/** scope 'local': chỉ máy này; 'global': mọi thiết bị */
export async function signOutSession(scope: 'local' | 'global' = 'local'): Promise<void> {
  const { error } = await supabase.auth.signOut({ scope });
  if (error) throw error;
}

export async function updatePassword(newPassword: string): Promise<void> {
  const { error } = await supabase.auth.updateUser({ password: newPassword });
  if (error) throw error;
}

export async function deleteAccount(): Promise<void> {
  const session = await getSession();
  if (!session?.access_token) {
    throw new Error('Vui lòng đăng nhập lại');
  }

  const { error } = await supabase.functions.invoke('delete-account', {
    headers: {
      Authorization: `Bearer ${session.access_token}`,
    },
  });

  if (error) {
    // Edge Function trả lỗi nghiệp vụ trong body: { error: 'CODE: message' } (ví dụ OWNER_OF_ACTIVE_GROUP).
    // supabase-js chỉ báo "non-2xx status code", nên đọc body từ error.context (Response).
    const context = (error as { context?: Response }).context;
    let errorMsg = typeof error === 'object' && 'message' in error ? error.message : 'Có lỗi xảy ra';
    let status: number | null = null;
    if (context && typeof context.json === 'function') {
      status = context.status;
      try {
        const body = await context.json();
        if (typeof body?.error === 'string') errorMsg = body.error;
      } catch {
        // body không phải JSON — giữ message gốc
      }
    }
    throwApiError({ message: errorMsg }, status);
  }
}
