import { supabase } from '@/lib/supabase';

// ============================
// Notifications API
// ============================

export async function fetchNotifications(limit = 50) {
  const { data, error } = await supabase
    .from('notifications')
    .select(`
      id, user_id, type, group_id, expense_id, payment_id, read_at, created_at,
      group:group_id(id, name)
    `)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) throw error;

  // Deduplicate — phòng trường hợp RLS trả trùng
  const seen = new Set<string>();
  return (data ?? []).filter((n: any) => {
    if (seen.has(n.id)) return false;
    seen.add(n.id);
    return true;
  });
}

export async function fetchUnreadCount() {
  const { count, error } = await supabase
    .from('notifications')
    .select('id', { count: 'exact', head: true })
    .is('read_at', null);

  if (error) throw error;
  return count ?? 0;
}

export async function markAsRead(notificationId: string) {
  const { error } = await supabase
    .from('notifications')
    .update({ read_at: new Date().toISOString() })
    .eq('id', notificationId);

  if (error) throw error;
}

export async function markAllAsRead() {
  const { error } = await supabase
    .from('notifications')
    .update({ read_at: new Date().toISOString() })
    .is('read_at', null);

  if (error) throw error;
}

// Push token management
export async function registerPushToken(expoToken: string, platform: string) {
  const userId = (await supabase.auth.getUser()).data.user?.id;
  if (!userId) throw new Error('Chưa đăng nhập');

  const { error } = await supabase
    .from('push_tokens')
    .upsert({
      user_id: userId,
      expo_token: expoToken,
      platform,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'user_id,expo_token' });

  if (error) throw error;
}

export async function removePushToken(expoToken: string) {
  const { error } = await supabase
    .from('push_tokens')
    .delete()
    .eq('expo_token', expoToken);

  if (error) throw error;
}
