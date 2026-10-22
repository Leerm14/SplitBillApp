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
  simplify_debts: boolean;
  currency: string;
  status: string;
  created_at: string;
};

export type GroupWithRole = Group & {
  role: string;
};

export type GroupMember = {
  id: string;
  displayName: string;
  role: string;
  joinedAt: string;
  status?: string;
};

export async function fetchGroups(): Promise<GroupWithRole[]> {
  const { data, error } = await supabase
    .from('group_members')
    .select('group_id, role, groups:group_id(id, name, invite_code, created_at)')
    .order('joined_at', { ascending: false });

  if (error) throw error;

  // Deduplicate — Supabase có thể trả trùng nếu RLS/trigger tạo nhiều row
  const seen = new Set<string>();
  return data
    .map((gm: any) => ({
      ...gm.groups,
      role: gm.role,
    }))
    .filter((g: any) => {
      if (seen.has(g.id)) return false;
      seen.add(g.id);
      return true;
    });
}

export async function fetchGroup(groupId: string): Promise<Group> {
  const { data, error } = await supabase
    .from('groups')
    .select('*')
    .eq('id', groupId)
    .single();

  if (error) throw error;
  return data as Group;
}

// APP-01: Fetch ALL members (not just ACTIVE) so computeBalances doesn't throw
// for expenses/payments referencing non-active members
export async function fetchGroupMembers(groupId: string): Promise<GroupMember[]> {
  const { data, error } = await supabase
    .from('group_members')
    .select('user_id, role, joined_at, status, profiles:user_id(id, display_name)')
    .eq('group_id', groupId)
    .order('joined_at');

  if (error) throw error;

  // Deduplicate — RLS với nhiều SELECT policies có thể trả trùng row qua JOIN
  const seen = new Set<string>();
  return data.map((gm: any) => ({
    id: gm.profiles.id,
    displayName: gm.profiles.display_name,
    role: gm.role,
    joinedAt: gm.joined_at,
    status: gm.status,
  })).filter((m: any) => {
    if (seen.has(m.id)) return false;
    seen.add(m.id);
    return true;
  });
}

// APP-01: Fetch only ACTIVE members (for UI display like member pickers)
export async function fetchActiveGroupMembers(groupId: string): Promise<GroupMember[]> {
  const { data, error } = await supabase
    .from('group_members')
    .select('user_id, role, joined_at, profiles:user_id(id, display_name)')
    .eq('group_id', groupId)
    .eq('status', 'ACTIVE')
    .order('joined_at');

  if (error) throw error;

  const seen = new Set<string>();
  return data.map((gm: any) => ({
    id: gm.profiles.id,
    displayName: gm.profiles.display_name,
    role: gm.role,
    joinedAt: gm.joined_at,
  })).filter((m: any) => {
    if (seen.has(m.id)) return false;
    seen.add(m.id);
    return true;
  });
}

export async function createGroup(name: string) {
  const { data, error } = await supabase.rpc('create_group', { _name: name });
  if (error) throw error;
  return data;
}

export async function joinGroup(code: string) {
  const { data, error } = await supabase.rpc('join_group', { _code: code });
  if (error) throw error;
  return data;
}

export async function updateGroup(groupId: string, updates: { name?: string; description?: string; simplify_debts?: boolean }) {
  const { data, error } = await supabase.rpc('update_group', {
    _group_id: groupId,
    _name: updates.name ?? null,
    _description: updates.description ?? null,
    _simplify_debts: updates.simplify_debts ?? null,
  });
  if (error) throw error;
  return data;
}

export async function createInvite(groupId: string, opts?: { invitedUserId?: string; expiresHours?: number; maxUses?: number }) {
  const { data, error } = await supabase.rpc('create_invite', {
    _group_id: groupId,
    _invited_user_id: opts?.invitedUserId ?? null,
    _expires_hours: opts?.expiresHours ?? 72,
    _max_uses: opts?.maxUses ?? 1,
  });
  if (error) throw error;
  return data;
}

export async function fetchInvites(groupId: string) {
  const { data, error } = await supabase
    .from('group_invites')
    .select('*')
    .eq('group_id', groupId)
    .is('revoked_at', null)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data;
}

export async function revokeInvite(inviteId: string) {
  const { data, error } = await supabase.rpc('revoke_invite', { _invite_id: inviteId });
  if (error) throw error;
  return data;
}

export async function acceptInvite(token: string) {
  const { data, error } = await supabase.rpc('accept_invite', { _token: token });
  if (error) throw error;
  return data;
}

export async function removeMember(groupId: string, userId: string) {
  const { data, error } = await supabase.rpc('remove_member', { _group_id: groupId, _user_id: userId });
  if (error) throw error;
  return data;
}

export async function transferOwnership(groupId: string, newOwnerId: string) {
  const { data, error } = await supabase.rpc('transfer_ownership', { _group_id: groupId, _new_owner_id: newOwnerId });
  if (error) throw error;
  return data;
}

export async function leaveGroup(groupId: string) {
  const { data, error } = await supabase.rpc('leave_group', { _group_id: groupId });
  if (error) throw error;
  return data;
}

export async function closeGroup(groupId: string) {
  const { data, error } = await supabase.rpc('close_group', { _group_id: groupId });
  if (error) throw error;
  return data;
}

