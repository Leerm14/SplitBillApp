import AsyncStorage from '@react-native-async-storage/async-storage';

import { throwApiError } from '@/api/errors';
import { supabase } from '@/lib/supabase';

// ============================
// Notifications API
// ============================

// APP-18: Kiểu dữ liệu viết tay
export type NotificationItem = {
  id: string;
  user_id: string;
  type: string;
  group_id: string | null;
  expense_id: string | null;
  payment_id: string | null;
  /** MVP-06: lời mời đích danh (thông báo GROUP_INVITED) */
  invite_id: string | null;
  read_at: string | null;
  created_at: string;
  group: { id: string; name: string } | null;
  /** Người thực hiện (migration 0016 điền cho mọi thông báo mới) */
  actor: { id: string; display_name: string } | null;
  /** Khoản chi / thanh toán liên quan — để ghi rõ "ai đã làm gì, bao nhiêu" */
  expense: { description: string | null; amount: number | null; creator: { display_name: string } | null } | null;
  payment: {
    amount: number | null;
    sender: { display_name: string } | null;
    receiver: { display_name: string } | null;
  } | null;
};

/** PostgREST trả quan hệ một-một dạng object hoặc mảng tùy cách suy luận khóa ngoại */
function one<T>(v: T | T[] | null | undefined): T | null {
  return Array.isArray(v) ? (v[0] ?? null) : (v ?? null);
}

export async function fetchNotifications(limit = 50): Promise<NotificationItem[]> {
  const { data, error, status } = await supabase
    .from('notifications')
    .select(`
      id, user_id, type, group_id, expense_id, payment_id, invite_id, read_at, created_at,
      group:group_id(id, name),
      actor:actor_id(id, display_name),
      expense:expense_id(description, amount, creator:created_by(display_name)),
      payment:payment_id(amount, sender:from_id(display_name), receiver:to_id(display_name))
    `)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) throwApiError(error, status);

  // Deduplicate — phòng trường hợp RLS trả trùng
  const seen = new Set<string>();
  const out: NotificationItem[] = [];
  for (const n of (data ?? []) as any[]) {
    if (seen.has(n.id)) continue;
    seen.add(n.id);
    const expense = one<any>(n.expense);
    const payment = one<any>(n.payment);
    out.push({
      ...n,
      group: one(n.group),
      actor: one(n.actor),
      expense: expense
        ? { description: expense.description ?? null, amount: expense.amount == null ? null : Number(expense.amount), creator: one(expense.creator) }
        : null,
      payment: payment
        ? { amount: payment.amount == null ? null : Number(payment.amount), sender: one(payment.sender), receiver: one(payment.receiver) }
        : null,
    });
  }
  return out;
}

export async function fetchUnreadCount(): Promise<number> {
  const { count, error, status } = await supabase
    .from('notifications')
    .select('id', { count: 'exact', head: true })
    .is('read_at', null);

  if (error) throwApiError(error, status);
  return count ?? 0;
}

export async function markAsRead(notificationId: string) {
  const { error, status } = await supabase
    .from('notifications')
    .update({ read_at: new Date().toISOString() })
    .eq('id', notificationId);

  if (error) throwApiError(error, status);
}

export async function markAllAsRead() {
  const { error, status } = await supabase
    .from('notifications')
    .update({ read_at: new Date().toISOString() })
    .is('read_at', null);

  if (error) throwApiError(error, status);
}

// Push token management

/**
 * REV-A4: Token Expo của máy này lưu bền (AsyncStorage) để gỡ được sau khi khởi động lại app.
 * Đăng ký / gỡ đi qua RPC (migration 0011): register_push_token xóa token này khỏi tài khoản khác
 * rồi upsert cho người gọi, nên mỗi lần đăng nhập đăng ký lại sẽ dọn dòng cũ (kể cả khi phiên trước
 * bị thu hồi từ xa và không kịp gỡ).
 */
const PUSH_TOKEN_STORAGE_KEY = 'SPLITBILL_PUSH_TOKEN';
let currentPushToken: string | null = null;

async function readStoredPushToken(): Promise<string | null> {
  if (currentPushToken) return currentPushToken;
  try {
    currentPushToken = await AsyncStorage.getItem(PUSH_TOKEN_STORAGE_KEY);
  } catch (e) {
    console.warn('[Push] Không đọc được push token đã lưu:', e);
  }
  return currentPushToken;
}

export async function registerPushToken(expoToken: string, platform: string): Promise<void> {
  const { error, status } = await supabase.rpc('register_push_token', {
    _expo_token: expoToken,
    _platform: platform,
  });
  if (error) throwApiError(error, status);
  currentPushToken = expoToken;
  try {
    await AsyncStorage.setItem(PUSH_TOKEN_STORAGE_KEY, expoToken);
  } catch (e) {
    console.warn('[Push] Không lưu được push token:', e);
  }
}

export async function removePushToken(expoToken: string): Promise<void> {
  const { error, status } = await supabase.rpc('unregister_push_token', { _expo_token: expoToken });
  if (error) throwApiError(error, status);
}

/**
 * APP-02 / REV-A4: Gỡ push token của máy này khỏi tài khoản hiện tại — gọi TRƯỚC khi đăng xuất
 * (cần phiên còn hiệu lực). Không ném lỗi: đăng xuất không được bị chặn vì mất mạng; dòng sót lại
 * sẽ bị register_push_token của lần đăng nhập sau dọn.
 */
export async function unregisterCurrentPushToken(): Promise<void> {
  const token = await readStoredPushToken();
  if (!token) return;
  try {
    await removePushToken(token);
    currentPushToken = null;
    await AsyncStorage.removeItem(PUSH_TOKEN_STORAGE_KEY);
  } catch (e) {
    console.warn('[Push] Không gỡ được push token khi đăng xuất:', e);
  }
}
