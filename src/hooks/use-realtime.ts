/**
 * Realtime: nghe thay đổi trên Supabase và làm mới đúng query key của TanStack Query.
 * - useMyRealtime: gắn một lần ở AuthGate — thông báo mới của mình (kéo theo nhóm, khoản chi, thanh toán liên quan)
 * - useGroupRealtime: gắn ở các màn của một nhóm — thay đổi của mọi thành viên trong nhóm đó
 * Nhiều sự kiện liền nhau (một RPC ghi khoản chi + phần chia + nhật ký + thông báo) được gộp trong 300 ms.
 */

import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';

import { subscribeGroupChanges, subscribeMyNotifications } from '@/api/realtime';
import { dedupeKeys, keysForGroupChange, keysForNotification, type QueryKey } from '@/lib/realtime-keys';

const DEBOUNCE_MS = 300;

function createInvalidator(queryClient: QueryClient) {
  let pending: QueryKey[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  const flush = () => {
    timer = null;
    const keys = dedupeKeys(pending);
    pending = [];
    for (const queryKey of keys) queryClient.invalidateQueries({ queryKey });
  };
  return {
    add(keys: QueryKey[]) {
      pending.push(...keys);
      if (!timer) timer = setTimeout(flush, DEBOUNCE_MS);
    },
    cancel() {
      if (timer) clearTimeout(timer);
      timer = null;
      pending = [];
    },
  };
}

export function useMyRealtime(userId: string | null | undefined) {
  const queryClient = useQueryClient();
  useEffect(() => {
    if (!userId) return;
    const invalidator = createInvalidator(queryClient);
    const unsubscribe = subscribeMyNotifications(userId, (change) => invalidator.add(keysForNotification(change)));
    return () => {
      unsubscribe();
      invalidator.cancel();
    };
  }, [queryClient, userId]);
}

export function useGroupRealtime(groupId: string | null | undefined, enabled = true) {
  const queryClient = useQueryClient();
  useEffect(() => {
    if (!groupId || !enabled) return;
    const invalidator = createInvalidator(queryClient);
    const unsubscribe = subscribeGroupChanges(groupId, (change) => invalidator.add(keysForGroupChange(groupId, change)));
    return () => {
      unsubscribe();
      invalidator.cancel();
    };
  }, [queryClient, groupId, enabled]);
}
