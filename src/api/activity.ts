import { throwApiError } from '@/api/errors';
import { supabase } from '@/lib/supabase';

// ============================
// Activity Logs API
// ============================

// APP-18: Kiểu dữ liệu viết tay cho nhật ký hoạt động
export type ActivityActor = { id: string; display_name: string };
export type ActivityGroupRef = { id: string; name: string };

export type ActivityLog = {
  id: string;
  group_id: string;
  actor_id: string | null;
  action: string;
  entity_type: string | null;
  entity_id: string | null;
  /** REV-S2: activity_logs không có cột metadata — dữ liệu nằm trong before / after (jsonb) */
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  created_at: string;
  actor: ActivityActor | null;
  group?: ActivityGroupRef | null;
};

/** PostgREST trả quan hệ nhiều-một dạng object, nhưng kiểu sinh tự động có thể là mảng */
function one<T>(v: T | T[] | null | undefined): T | null {
  if (Array.isArray(v)) return v[0] ?? null;
  return v ?? null;
}

function dedupe(rows: any[]): ActivityLog[] {
  const seen = new Set<string>();
  const out: ActivityLog[] = [];
  for (const a of rows) {
    if (seen.has(a.id)) continue;
    seen.add(a.id);
    out.push({ ...a, actor: one(a.actor), group: one(a.group) });
  }
  return out;
}

/**
 * Fetch activity logs for a specific group
 */
export async function fetchGroupActivities(groupId: string, limit = 50): Promise<ActivityLog[]> {
  const { data, error, status } = await supabase
    .from('activity_logs')
    .select(`
      id, group_id, actor_id, action, entity_type, entity_id, before, after, created_at,
      actor:actor_id(id, display_name)
    `)
    .eq('group_id', groupId)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) throwApiError(error, status);

  // Deduplicate
  return dedupe(data ?? []);
}

/**
 * Fetch all recent activity logs across all groups the user belongs to
 */
export async function fetchRecentActivities(limit = 30): Promise<ActivityLog[]> {
  const userId = (await supabase.auth.getUser()).data.user?.id;
  if (!userId) throw new Error('Chưa đăng nhập');

  // Get user's group IDs first
  const { data: memberships, error: memErr } = await supabase
    .from('group_members')
    .select('group_id')
    .eq('user_id', userId)
    .eq('status', 'ACTIVE');

  if (memErr) throwApiError(memErr);
  if (!memberships || memberships.length === 0) return [];

  const groupIds = memberships.map((m: { group_id: string }) => m.group_id);

  const { data, error, status } = await supabase
    .from('activity_logs')
    .select(`
      id, group_id, actor_id, action, entity_type, entity_id, before, after, created_at,
      actor:actor_id(id, display_name),
      group:group_id(id, name)
    `)
    .in('group_id', groupIds)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) throwApiError(error, status);

  // Deduplicate
  return dedupe(data ?? []);
}
