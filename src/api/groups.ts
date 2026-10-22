import { throwApiError } from '@/api/errors';
import { supabase } from '@/lib/supabase';

// ============================
// Groups API
// ============================

// APP-18: Typed interfaces for API responses
export type Group = {
  id: string;
  name: string;
  description?: string;
  owner_id: string;
  invite_code: string;
  simplify_debts: boolean | null; // APP-06: NULL = bật (BR-09)
  currency: string;
  status: string;
  created_at: string;
};

export type GroupWithRole = Group & {
  role: string;
  /** REV-S4: trạng thái tư cách thành viên của MÌNH trong nhóm (ACTIVE | LEFT | REMOVED) */
  memberStatus: string;
};

/** REV-S4: Nhóm đang dùng được để ghi: mình còn ACTIVE và nhóm chưa đóng. */
export function isWritableGroup(g: Pick<GroupWithRole, 'memberStatus' | 'status'>): boolean {
  return (g.memberStatus ?? 'ACTIVE') === 'ACTIVE' && (g.status ?? 'ACTIVE') === 'ACTIVE';
}

export type GroupMember = {
  id: string;
  displayName: string;
  role: string;
  joinedAt: string;
  status?: string;
};

/**
 * REV-S4: Chỉ dòng tư cách thành viên của CHÍNH MÌNH (RLS cho đọc cả dòng của người khác cùng nhóm,
 * nên không lọc thì role/status bị lẫn). Kèm trạng thái tư cách và trạng thái nhóm để màn hình
 * tách nhóm đang hoạt động và nhóm 'Đã lưu trữ' (đã rời / bị xóa / nhóm đã đóng).
 */
export async function fetchGroups(userId: string): Promise<GroupWithRole[]> {
  const { data, error, status } = await supabase
    .from('group_members')
    .select('group_id, role, status, groups:group_id(id, name, invite_code, created_at, status, owner_id, simplify_debts)')
    .eq('user_id', userId)
    .order('joined_at', { ascending: false });

  if (error) throwApiError(error, status);

  // Deduplicate — phòng RLS/trigger trả trùng dòng
  const seen = new Set<string>();
  const out: GroupWithRole[] = [];
  for (const gm of (data ?? []) as any[]) {
    const g = Array.isArray(gm.groups) ? gm.groups[0] : gm.groups;
    if (!g || seen.has(g.id)) continue;
    seen.add(g.id);
    out.push({ ...g, status: g.status ?? 'ACTIVE', role: gm.role, memberStatus: gm.status ?? 'ACTIVE' });
  }
  return out;
}

export async function fetchGroup(groupId: string): Promise<Group> {
  const { data, error, status } = await supabase
    .from('groups')
    .select('*')
    .eq('id', groupId)
    .single();

  if (error) throwApiError(error, status);
  return data as Group;
}

// APP-01: Fetch ALL members (not just ACTIVE) so computeBalances doesn't throw
// for expenses/payments referencing non-active members.
// NEW-03: Form và danh sách thành viên phải lọc bằng isActiveMember.
export async function fetchGroupMembers(groupId: string): Promise<GroupMember[]> {
  const { data, error, status } = await supabase
    .from('group_members')
    .select('user_id, role, joined_at, status, profiles:user_id(id, display_name)')
    .eq('group_id', groupId)
    .order('joined_at');

  if (error) throwApiError(error, status);

  // Deduplicate — RLS với nhiều SELECT policies có thể trả trùng row qua JOIN
  const seen = new Set<string>();
  return data.map((gm: any) => ({
    // NEW-01: profiles có thể null nếu RLS không cho xem hồ sơ — không để crash
    id: gm.user_id,
    displayName: gm.profiles?.display_name ?? '',
    role: gm.role,
    joinedAt: gm.joined_at,
    status: gm.status,
  })).filter((m: any) => {
    if (seen.has(m.id)) return false;
    seen.add(m.id);
    return true;
  });
}

/** NEW-03: Thành viên đang ở trong nhóm — dùng cho form chọn người và danh sách thành viên. */
export function isActiveMember(member: GroupMember): boolean {
  // Cache cũ (trước khi có cột status) chỉ chứa thành viên ACTIVE
  return (member.status ?? 'ACTIVE') === 'ACTIVE';
}

/** REV-S6 / §7 DEBT-01: Một dòng của view group_balances (chỉ thành viên ACTIVE; bigint → số). */
export type GroupBalanceRow = {
  userId: string;
  paid: number;
  owed: number;
  sentConfirmed: number;
  receivedConfirmed: number;
  pendingSent: number;
  pendingReceived: number;
  officialBalance: number;
  projectedBalance: number;
};

/** REV-S6: Số dư chính thức / dự kiến của cả nhóm từ view group_balances (security_invoker). */
export async function fetchGroupBalances(groupId: string): Promise<GroupBalanceRow[]> {
  const { data, error, status } = await supabase
    .from('group_balances')
    .select(
      'user_id, paid, owed, sent_confirmed, received_confirmed, pending_sent, pending_received, official_balance, projected_balance',
    )
    .eq('group_id', groupId);

  if (error) throwApiError(error, status);
  const seen = new Set<string>();
  const out: GroupBalanceRow[] = [];
  for (const b of (data ?? []) as any[]) {
    if (seen.has(b.user_id)) continue;
    seen.add(b.user_id);
    out.push({
      userId: b.user_id,
      paid: Number(b.paid),
      owed: Number(b.owed),
      sentConfirmed: Number(b.sent_confirmed),
      receivedConfirmed: Number(b.received_confirmed),
      pendingSent: Number(b.pending_sent),
      pendingReceived: Number(b.pending_received),
      officialBalance: Number(b.official_balance),
      projectedBalance: Number(b.projected_balance),
    });
  }
  return out;
}

export type MyGroupBalance = {
  groupId: string;
  officialBalance: number;
};

// APP-04: Số dư chính thức của mình ở mọi nhóm, lấy từ view group_balances (HOME-01, BR-10)
export async function fetchMyGroupBalances(userId: string): Promise<MyGroupBalance[]> {
  const { data, error, status } = await supabase
    .from('group_balances')
    .select('group_id, official_balance')
    .eq('user_id', userId);

  if (error) throwApiError(error, status);
  return (data ?? []).map((b: any) => ({
    groupId: b.group_id,
    // Supabase trả bigint dưới dạng string
    officialBalance: Number(b.official_balance),
  }));
}

export async function createGroup(name: string) {
  const { data, error, status } = await supabase.rpc('create_group', { _name: name });
  if (error) throwApiError(error, status);
  return data;
}

export async function joinGroup(code: string) {
  const { data, error, status } = await supabase.rpc('join_group', { _code: code });
  if (error) throwApiError(error, status);
  return data;
}

/**
 * NEW-08: update_group coi tham số NULL là giữ nguyên. Chỉ truyền trường đã đổi
 * (ví dụ công tắc trên màn công nợ chỉ gửi simplify_debts).
 */
export async function updateGroup(groupId: string, updates: { name?: string; description?: string; simplify_debts?: boolean }) {
  const { data, error, status } = await supabase.rpc('update_group', {
    _group_id: groupId,
    _name: updates.name ?? null,
    _description: updates.description ?? null,
    _simplify_debts: updates.simplify_debts ?? null,
  });
  if (error) throwApiError(error, status);
  return data;
}

export async function createInvite(groupId: string, opts?: { invitedUserId?: string; expiresHours?: number; maxUses?: number }) {
  const { data, error, status } = await supabase.rpc('create_invite', {
    _group_id: groupId,
    _invited_user_id: opts?.invitedUserId ?? null,
    _expires_hours: opts?.expiresHours ?? 72,
    _max_uses: opts?.maxUses ?? 1,
  });
  if (error) throwApiError(error, status);
  return data;
}

// APP-18: Kiểu dữ liệu mã mời
export type GroupInvite = {
  id: string;
  group_id: string;
  token: string;
  created_by: string;
  invited_user_id: string | null;
  max_uses: number;
  used_count: number;
  expires_at: string;
  revoked_at: string | null;
  created_at: string;
};

export async function fetchInvites(groupId: string): Promise<GroupInvite[]> {
  const { data, error, status } = await supabase
    .from('group_invites')
    .select('*')
    .eq('group_id', groupId)
    .is('revoked_at', null)
    .order('created_at', { ascending: false });
  if (error) throwApiError(error, status);
  return (data ?? []) as GroupInvite[];
}

export async function revokeInvite(inviteId: string) {
  const { data, error, status } = await supabase.rpc('revoke_invite', { _invite_id: inviteId });
  if (error) throwApiError(error, status);
  return data;
}

export async function acceptInvite(token: string) {
  const { data, error, status } = await supabase.rpc('accept_invite', { _token: token });
  if (error) throwApiError(error, status);
  return data;
}

export async function removeMember(groupId: string, userId: string) {
  const { data, error, status } = await supabase.rpc('remove_member', { _group_id: groupId, _user_id: userId });
  if (error) throwApiError(error, status);
  return data;
}

export async function transferOwnership(groupId: string, newOwnerId: string) {
  const { data, error, status } = await supabase.rpc('transfer_ownership', { _group_id: groupId, _new_owner_id: newOwnerId });
  if (error) throwApiError(error, status);
  return data;
}

export async function leaveGroup(groupId: string) {
  const { data, error, status } = await supabase.rpc('leave_group', { _group_id: groupId });
  if (error) throwApiError(error, status);
  return data;
}

export async function closeGroup(groupId: string) {
  const { data, error, status } = await supabase.rpc('close_group', { _group_id: groupId });
  if (error) throwApiError(error, status);
  return data;
}

