import { throwApiError } from '@/api/errors';
import { supabase } from '@/lib/supabase';

// ============================
// Contacts API
// ============================

// APP-18: Kiểu dữ liệu viết tay
export type ContactProfile = {
  id: string;
  display_name: string;
  user_code: string;
  avatar_path: string | null;
};

export type UserSearchResult = ContactProfile & {
  friendship_status: string | null; // 'ACCEPTED' | 'PENDING' | null
};

export type Friendship = {
  requester_id: string;
  addressee_id: string;
  status: string;
  created_at: string;
  responded_at?: string | null;
  requester: ContactProfile | null;
  addressee?: ContactProfile | null;
};

export type PaymentHandle = {
  id: string;
  user_id: string;
  type: string;
  display_text: string;
  created_at: string;
};

function one<T>(v: T | T[] | null | undefined): T | null {
  if (Array.isArray(v)) return v[0] ?? null;
  return v ?? null;
}

function toFriendship(row: any): Friendship {
  return { ...row, requester: one(row.requester), addressee: one(row.addressee) };
}

/** Search users by name or user_code */
export async function searchUsers(query: string): Promise<UserSearchResult[]> {
  const { data, error, status } = await supabase.rpc('search_users', { _query: query });
  if (error) throwApiError(error, status);
  return (data ?? []) as UserSearchResult[];
}

/** Get friends list (ACCEPTED status) */
export async function fetchFriends(): Promise<Friendship[]> {
  const userId = (await supabase.auth.getUser()).data.user?.id;
  if (!userId) throw new Error('Chưa đăng nhập');

  const { data, error, status } = await supabase
    .from('friendships')
    .select(`
      requester_id, addressee_id, status, created_at, responded_at,
      requester:requester_id(id, display_name, user_code, avatar_path),
      addressee:addressee_id(id, display_name, user_code, avatar_path)
    `)
    .eq('status', 'ACCEPTED')
    .or(`requester_id.eq.${userId},addressee_id.eq.${userId}`)
    .order('responded_at', { ascending: false });

  if (error) throwApiError(error, status);
  return (data ?? []).map(toFriendship);
}

/** Get pending friend requests (received) */
export async function fetchPendingRequests(): Promise<Friendship[]> {
  const userId = (await supabase.auth.getUser()).data.user?.id;
  if (!userId) throw new Error('Chưa đăng nhập');

  const { data, error, status } = await supabase
    .from('friendships')
    .select(`
      requester_id, addressee_id, status, created_at,
      requester:requester_id(id, display_name, user_code, avatar_path)
    `)
    .eq('addressee_id', userId)
    .eq('status', 'PENDING')
    .order('created_at', { ascending: false });

  if (error) throwApiError(error, status);
  return (data ?? []).map(toFriendship);
}

/** Send friend request */
export async function sendFriendRequest(addresseeId: string): Promise<unknown> {
  const { data, error, status } = await supabase.rpc('send_friend_request', {
    _addressee_id: addresseeId,
  });
  if (error) throwApiError(error, status);
  return data;
}

/** Respond to friend request */
export async function respondFriendRequest(requesterId: string, accept: boolean): Promise<unknown> {
  const { data, error, status } = await supabase.rpc('respond_friend_request', {
    _requester_id: requesterId,
    _accept: accept,
  });
  if (error) throwApiError(error, status);
  return data;
}

/** Unfriend */
export async function unfriend(friendId: string): Promise<unknown> {
  const { data, error, status } = await supabase.rpc('unfriend', {
    _friend_id: friendId,
  });
  if (error) throwApiError(error, status);
  return data;
}

/** Fetch payment handles for a user */
export async function fetchPaymentHandles(userId?: string): Promise<PaymentHandle[]> {
  const uid = userId || (await supabase.auth.getUser()).data.user?.id;
  if (!uid) throw new Error('Chưa đăng nhập');

  const { data, error, status } = await supabase
    .from('payment_handles')
    .select('*')
    .eq('user_id', uid)
    .order('created_at', { ascending: false });

  if (error) throwApiError(error, status);
  return (data ?? []) as PaymentHandle[];
}

/** Add payment handle */
export async function addPaymentHandle(type: string, displayText: string): Promise<PaymentHandle> {
  const userId = (await supabase.auth.getUser()).data.user?.id;
  if (!userId) throw new Error('Chưa đăng nhập');

  const { data, error, status } = await supabase
    .from('payment_handles')
    .insert({ user_id: userId, type, display_text: displayText })
    .select()
    .single();

  if (error) throwApiError(error, status);
  return data as PaymentHandle;
}

/** Delete payment handle */
export async function deletePaymentHandle(handleId: string): Promise<void> {
  const { error, status } = await supabase
    .from('payment_handles')
    .delete()
    .eq('id', handleId);

  if (error) throwApiError(error, status);
}
