import { throwApiError } from '@/api/errors';
import { toJoinResult, type JoinResult } from '@/lib/membership';
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
  /** MVP-03: public_id Cloudinary của ảnh nhóm (`<group_id>/group_<ts>`) */
  avatar_path?: string | null;
  currency: string;
  status: string;
  /** Migration 0014: bật thì người vào bằng link / mã nhóm / QR phải chờ chủ nhóm duyệt (NULL/thiếu = tắt) */
  require_approval?: boolean | null;
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
  /** MVP-02: public_id Cloudinary ảnh đại diện */
  avatarPath?: string | null;
};

/**
 * REV-S4: Chỉ dòng tư cách thành viên của CHÍNH MÌNH (RLS cho đọc cả dòng của người khác cùng nhóm,
 * nên không lọc thì role/status bị lẫn). Kèm trạng thái tư cách và trạng thái nhóm để màn hình
 * tách nhóm đang hoạt động và nhóm 'Đã lưu trữ' (đã rời / bị xóa / nhóm đã đóng).
 */
export async function fetchGroups(userId: string): Promise<GroupWithRole[]> {
  const { data, error, status } = await supabase
    .from('group_members')
    .select('group_id, role, status, groups:group_id(id, name, invite_code, created_at, status, owner_id, simplify_debts, avatar_path)')
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
    .select('user_id, role, joined_at, status, profiles:user_id(id, display_name, avatar_path)')
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
    avatarPath: gm.profiles?.avatar_path ?? null,
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

/**
 * MVP-03: Tạo nhóm trong MỘT lần gọi RPC (atomic): tên, mô tả, công tắc đơn giản hóa công nợ
 * (mặc định bật — BR-09). Ảnh nhóm upload sau khi đã có id nhóm rồi lưu bằng updateGroup.
 */
export async function createGroup(
  name: string,
  opts: { description?: string; simplifyDebts?: boolean } = {},
): Promise<Group> {
  const { data, error, status } = await supabase.rpc('create_group', {
    _name: name,
    _description: opts.description ?? '',
    _simplify_debts: opts.simplifyDebts ?? true,
  });
  if (error) throwApiError(error, status);
  return (Array.isArray(data) ? data[0] : data) as Group;
}

// ============================
// Duyệt thành viên mới (migration 0014)
// ============================

export type { JoinResult, JoinStatus } from '@/lib/membership';

/** Vào nhóm bằng link mời (token). Nhóm bật duyệt → PENDING. */
export async function joinByToken(token: string): Promise<JoinResult> {
  const { data, error, status } = await supabase.rpc('join_by_token', { _token: token });
  if (error) throwApiError(error, status);
  return toJoinResult(data);
}

/** Vào nhóm bằng mã nhóm (nhập tay hoặc QR). Nhóm bật duyệt → PENDING. */
export async function joinByCode(code: string): Promise<JoinResult> {
  const { data, error, status } = await supabase.rpc('join_by_code', { _code: code });
  if (error) throwApiError(error, status);
  return toJoinResult(data);
}

/** Chủ nhóm bật / tắt duyệt thành viên mới. Trả dòng nhóm. */
export async function setJoinApproval(groupId: string, required: boolean): Promise<Group> {
  const { data, error, status } = await supabase.rpc('set_join_approval', { _group_id: groupId, _required: required });
  if (error) throwApiError(error, status);
  return (Array.isArray(data) ? data[0] : data) as Group;
}

/** Yêu cầu tham gia đang chờ duyệt (chỉ chủ nhóm đọc được). */
export type JoinRequest = {
  id: string;
  userId: string;
  displayName: string;
  userCode: string | null;
  avatarPath: string | null;
  /** Đường vào: link / mã nhóm / QR (giá trị do server đặt, ví dụ 'TOKEN' | 'CODE') */
  via: string | null;
  createdAt: string;
};

export async function fetchJoinRequests(groupId: string): Promise<JoinRequest[]> {
  const { data, error, status } = await supabase.rpc('list_join_requests', { _group_id: groupId });
  if (error) throwApiError(error, status);
  const seen = new Set<string>();
  const out: JoinRequest[] = [];
  for (const r of (data ?? []) as any[]) {
    if (!r?.id || seen.has(r.id)) continue;
    seen.add(r.id);
    out.push({
      id: r.id,
      userId: r.user_id,
      displayName: r.display_name ?? '',
      userCode: r.user_code ?? null,
      avatarPath: r.avatar_path ?? null,
      via: r.via ?? null,
      createdAt: r.created_at,
    });
  }
  return out;
}

/** Chủ nhóm duyệt yêu cầu → người xin trở thành thành viên ACTIVE. Trả dòng nhóm. */
export async function approveJoinRequest(requestId: string): Promise<Group> {
  const { data, error, status } = await supabase.rpc('approve_join_request', { _request_id: requestId });
  if (error) throwApiError(error, status);
  return (Array.isArray(data) ? data[0] : data) as Group;
}

export async function rejectJoinRequest(requestId: string, reason?: string | null) {
  const { data, error, status } = await supabase.rpc('reject_join_request', {
    _request_id: requestId,
    _reason: reason?.trim() ? reason.trim() : null,
  });
  if (error) throwApiError(error, status);
  return data;
}

/** Người xin tự hủy yêu cầu đang chờ. */
export async function cancelJoinRequest(requestId: string) {
  const { data, error, status } = await supabase.rpc('cancel_join_request', { _request_id: requestId });
  if (error) throwApiError(error, status);
  return data;
}

export type MyJoinRequest = { status: string; requestId: string };

/** Yêu cầu tham gia gần nhất của mình ở nhóm (null = chưa có). */
export async function fetchMyJoinRequest(groupId: string): Promise<MyJoinRequest | null> {
  const { data, error, status } = await supabase.rpc('my_join_request', { _group_id: groupId });
  if (error) throwApiError(error, status);
  const raw = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | null;
  if (!raw || typeof raw.request_id !== 'string') return null;
  return { status: typeof raw.status === 'string' ? raw.status : '', requestId: raw.request_id };
}

/**
 * NEW-08: update_group coi tham số NULL là giữ nguyên. Chỉ truyền trường đã đổi
 * (ví dụ công tắc trên màn công nợ chỉ gửi simplify_debts).
 * MVP-03: avatar_path phải bắt đầu bằng `<group_id>/`; clear_avatar = xóa ảnh nhóm.
 */
export async function updateGroup(
  groupId: string,
  updates: { name?: string; description?: string; simplify_debts?: boolean; avatar_path?: string; clear_avatar?: boolean },
): Promise<Group> {
  const { data, error, status } = await supabase.rpc('update_group', {
    _group_id: groupId,
    _name: updates.name ?? null,
    _description: updates.description ?? null,
    _simplify_debts: updates.simplify_debts ?? null,
    _avatar_path: updates.avatar_path ?? null,
    _clear_avatar: updates.clear_avatar ?? false,
  });
  if (error) throwApiError(error, status);
  return (Array.isArray(data) ? data[0] : data) as Group;
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

/**
 * MVP-06: Chấp nhận lời mời đích danh (thông báo GROUP_INVITED) — chỉ người được mời.
 * Migration 0014: dùng accept_invite_by_id_v2 (accept_invite / join_group / accept_invite_by_id cũ báo
 * JOIN_APPROVAL_REQUIRED khi nhóm bật duyệt). Lời mời đích danh thường vào thẳng, nhưng vẫn xử lý PENDING.
 */
export async function acceptInviteById(inviteId: string): Promise<JoinResult> {
  const { data, error, status } = await supabase.rpc('accept_invite_by_id_v2', { _invite_id: inviteId });
  if (error) throwApiError(error, status);
  return toJoinResult(data);
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

export async function rotateInviteCode(groupId: string) {
  const { data, error, status } = await supabase.rpc('rotate_invite_code', { _group_id: groupId });
  if (error) throwApiError(error, status);
  return data;
}

