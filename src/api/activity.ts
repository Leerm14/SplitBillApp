import { supabase } from '@/lib/supabase';

// ============================
// Activity Logs API
// ============================

/**
 * Fetch activity logs for a specific group
 */
export async function fetchGroupActivities(groupId: string, limit = 50) {
  const { data, error } = await supabase
    .from('activity_logs')
    .select(`
      id, group_id, actor_id, action, entity_type, entity_id, metadata, created_at,
      actor:actor_id(id, display_name)
    `)
    .eq('group_id', groupId)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) throw error;

  // Deduplicate
  const seen = new Set<string>();
  return (data ?? []).filter((a: any) => {
    if (seen.has(a.id)) return false;
    seen.add(a.id);
    return true;
  });
}

/**
 * Fetch all recent activity logs across all groups the user belongs to
 */
export async function fetchRecentActivities(limit = 30) {
  const userId = (await supabase.auth.getUser()).data.user?.id;
  if (!userId) throw new Error('Chưa đăng nhập');

  // Get user's group IDs first
  const { data: memberships, error: memErr } = await supabase
    .from('group_members')
    .select('group_id')
    .eq('user_id', userId)
    .eq('status', 'ACTIVE');

  if (memErr) throw memErr;
  if (!memberships || memberships.length === 0) return [];

  const groupIds = memberships.map((m: any) => m.group_id);

  const { data, error } = await supabase
    .from('activity_logs')
    .select(`
      id, group_id, actor_id, action, entity_type, entity_id, metadata, created_at,
      actor:actor_id(id, display_name),
      group:group_id(id, name)
    `)
    .in('group_id', groupIds)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) throw error;

  // Deduplicate
  const seen = new Set<string>();
  return (data ?? []).filter((a: any) => {
    if (seen.has(a.id)) return false;
    seen.add(a.id);
    return true;
  });
}
