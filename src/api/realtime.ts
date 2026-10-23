/**
 * Supabase Realtime (postgres_changes) — chỉ tầng API được gọi Supabase (DEV §1.5).
 *
 * Mỗi chủ đề (một nhóm, thông báo của một người) chỉ mở MỘT kênh dù nhiều màn hình cùng nghe:
 * màn nhóm → công nợ → thanh toán xếp chồng trong Stack đều gọi subscribe, kênh được đếm tham chiếu
 * và đóng khi màn cuối cùng thôi nghe.
 *
 * Realtime áp RLS SELECT cho từng người nghe (bảng bật trong migration 0013), nên lọc theo group_id /
 * user_id chỉ để giảm lưu lượng, không phải lớp bảo mật.
 */

import type { RealtimeChannel } from '@supabase/supabase-js';

import type { RealtimeChange } from '@/lib/realtime-keys';
import { supabase } from '@/lib/supabase';

type Listener = (change: RealtimeChange) => void;

type Entry = {
  channel: RealtimeChannel;
  listeners: Set<Listener>;
};

const topics = new Map<string, Entry>();

// Migration 0014: group_join_requests (RLS: chủ nhóm thấy mọi yêu cầu, người xin thấy yêu cầu của mình)
const GROUP_TABLES = ['expenses', 'payments', 'group_members', 'group_join_requests'] as const;

function emit(entry: Entry, change: RealtimeChange) {
  for (const l of entry.listeners) {
    try {
      l(change);
    } catch (e) {
      console.error('Realtime listener error:', e);
    }
  }
}

function subscribeTopic(topic: string, build: (channel: RealtimeChannel, entry: Entry) => RealtimeChannel, listener: Listener) {
  let entry = topics.get(topic);
  if (!entry) {
    const created: Entry = { channel: supabase.channel(topic), listeners: new Set() };
    let wasSubscribed = false;
    build(created.channel, created).subscribe((status) => {
      if (status === 'SUBSCRIBED') {
        // Nối lại sau khi rớt mạng / app ngủ: có thể đã lỡ sự kiện → báo làm mới cả phạm vi
        if (wasSubscribed) emit(created, { table: '*', record: {} });
        wasSubscribed = true;
      }
    });
    topics.set(topic, created);
    entry = created;
  }
  entry.listeners.add(listener);

  return () => {
    const current = topics.get(topic);
    if (!current) return;
    current.listeners.delete(listener);
    if (current.listeners.size === 0) {
      topics.delete(topic);
      supabase.removeChannel(current.channel);
    }
  };
}

/** Thay đổi khoản chi, thanh toán, thành viên, yêu cầu tham gia và thông tin của một nhóm. */
export function subscribeGroupChanges(groupId: string, listener: Listener): () => void {
  return subscribeTopic(
    `group:${groupId}`,
    (channel, entry) => {
      for (const table of GROUP_TABLES) {
        channel.on('postgres_changes', { event: '*', schema: 'public', table, filter: `group_id=eq.${groupId}` }, (payload) =>
          emit(entry, { table, record: (payload.new ?? payload.old ?? {}) as Record<string, unknown> }),
        );
      }
      channel.on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'groups', filter: `id=eq.${groupId}` }, (payload) =>
        emit(entry, { table: 'groups', record: (payload.new ?? {}) as Record<string, unknown> }),
      );
      return channel;
    },
    listener,
  );
}

/** Thông báo mới của chính người dùng (mọi RPC ghi đều tạo thông báo cho người liên quan). */
export function subscribeMyNotifications(userId: string, listener: Listener): () => void {
  return subscribeTopic(
    `notifications:${userId}`,
    (channel, entry) =>
      channel.on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'notifications', filter: `user_id=eq.${userId}` }, (payload) =>
        emit(entry, { table: 'notifications', record: (payload.new ?? {}) as Record<string, unknown> }),
      ),
    listener,
  );
}
