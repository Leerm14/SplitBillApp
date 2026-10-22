import { supabase } from '@/lib/supabase';

// ============================
// Contacts API
// ============================

/** Search users by name or user_code */
export async function searchUsers(query: string) {
  const { data, error } = await supabase.rpc('search_users', { _query: query });
  if (error) throw error;
  return data;
}

/** Get friends list (ACCEPTED status) */
export async function fetchFriends() {
  const userId = (await supabase.auth.getUser()).data.user?.id;
  if (!userId) throw new Error('Chưa đăng nhập');

  const { data, error } = await supabase
    .from('friendships')
    .select(`
      requester_id, addressee_id, status, created_at, responded_at,
      requester:requester_id(id, display_name, user_code, avatar_path),
      addressee:addressee_id(id, display_name, user_code, avatar_path)
    `)
    .eq('status', 'ACCEPTED')
    .or(`requester_id.eq.${userId},addressee_id.eq.${userId}`)
    .order('responded_at', { ascending: false });

  if (error) throw error;
  return data;
}

/** Get pending friend requests (received) */
export async function fetchPendingRequests() {
  const userId = (await supabase.auth.getUser()).data.user?.id;
  if (!userId) throw new Error('Chưa đăng nhập');

  const { data, error } = await supabase
    .from('friendships')
    .select(`
      requester_id, addressee_id, status, created_at,
      requester:requester_id(id, display_name, user_code, avatar_path)
    `)
    .eq('addressee_id', userId)
    .eq('status', 'PENDING')
    .order('created_at', { ascending: false });

  if (error) throw error;
  return data;
}

/** Send friend request */
export async function sendFriendRequest(addresseeId: string) {
  const { data, error } = await supabase.rpc('send_friend_request', {
    _addressee_id: addresseeId,
  });
  if (error) throw error;
  return data;
}

/** Respond to friend request */
export async function respondFriendRequest(requesterId: string, accept: boolean) {
  const { data, error } = await supabase.rpc('respond_friend_request', {
    _requester_id: requesterId,
    _accept: accept,
  });
  if (error) throw error;
  return data;
}

/** Unfriend */
export async function unfriend(friendId: string) {
  const { data, error } = await supabase.rpc('unfriend', {
    _friend_id: friendId,
  });
  if (error) throw error;
  return data;
}

/** Fetch payment handles for a user */
export async function fetchPaymentHandles(userId?: string) {
  const uid = userId || (await supabase.auth.getUser()).data.user?.id;
  if (!uid) throw new Error('Chưa đăng nhập');

  const { data, error } = await supabase
    .from('payment_handles')
    .select('*')
    .eq('user_id', uid)
    .order('created_at', { ascending: false });

  if (error) throw error;
  return data;
}

/** Add payment handle */
export async function addPaymentHandle(type: string, displayText: string) {
  const userId = (await supabase.auth.getUser()).data.user?.id;
  if (!userId) throw new Error('Chưa đăng nhập');

  const { data, error } = await supabase
    .from('payment_handles')
    .insert({ user_id: userId, type, display_text: displayText })
    .select()
    .single();

  if (error) throw error;
  return data;
}

/** Delete payment handle */
export async function deletePaymentHandle(handleId: string) {
  const { error } = await supabase
    .from('payment_handles')
    .delete()
    .eq('id', handleId);

  if (error) throw error;
}
