import { supabase } from '@/lib/supabase';

// ============================
// Auth API
// ============================

// APP-13: Centralize Supabase auth calls into the API layer

export async function resetPasswordForEmail(email: string): Promise<void> {
  const { error } = await supabase.auth.resetPasswordForEmail(email);
  if (error) throw error;
}

export async function getSession() {
  const { data, error } = await supabase.auth.getSession();
  if (error) throw error;
  return data.session;
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
    const errorMsg = typeof error === 'object' && 'message' in error
      ? error.message
      : 'Có lỗi xảy ra';
    throw new Error(errorMsg);
  }
}

