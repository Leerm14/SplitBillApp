/**
 * Hook tự động đồng bộ hàng đợi offline (DEV mục 6).
 * - Đồng bộ khi có mạng trở lại, khi app quay lại foreground và định kỳ 30 giây
 * - APP-03: khóa ở module nằm trong offline/sync.ts (processQueue)
 * - APP-08: trả về danh sách mục "Chưa đồng bộ" và mục lỗi để người dùng thử lại / bỏ
 * - APP-12: thời điểm đồng bộ gần nhất lấy từ cache TanStack Query (dataUpdatedAt)
 */

import { notifyManager, useQuery, useQueryClient, type QueryCache } from '@tanstack/react-query';
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { AppState } from 'react-native';

import { useAuth } from '@/hooks/use-auth';
import type { QueueItem } from '@/offline/queue';

type OfflineModule = typeof import('@/offline');

let NetInfo: typeof import('@react-native-community/netinfo').default | null = null;
let offlineModule: OfflineModule | null = null;

// require trong try: expo-sqlite / NetInfo không chạy trên web
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  NetInfo = require('@react-native-community/netinfo').default;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  offlineModule = require('@/offline');
} catch {
  // Không có trên web
}

/** Query key của danh sách hàng đợi — không lưu vào persister (query-persister.ts) */
export const OFFLINE_QUEUE_KEY = 'offline-queue';

/** APP-12: Lần tải dữ liệu thành công gần nhất trong cache (bỏ qua query cục bộ của hàng đợi). */
function latestDataUpdatedAt(cache: QueryCache): number {
  let latest = 0;
  for (const q of cache.getAll()) {
    if (q.queryKey[0] === OFFLINE_QUEUE_KEY) continue;
    if (q.state.dataUpdatedAt > latest) latest = q.state.dataUpdatedAt;
  }
  return latest;
}

export function useLastSyncedAt(): Date | null {
  const cache = useQueryClient().getQueryCache();
  const subscribe = useCallback(
    (cb: () => void) => {
      // QueryCache báo đồng bộ ngay cả khi một useQuery tạo query trong lúc render → gọi cb lúc đó
      // làm React cập nhật AuthGate giữa render ("Cannot update a component while rendering").
      // batchCalls hoãn sang lượt sau, giống useIsFetching của TanStack.
      const notify = notifyManager.batchCalls(cb);
      return cache.subscribe((event) => {
        // Chỉ các sự kiện có thể đổi dataUpdatedAt: tải xong, xóa query, khôi phục từ cache đã lưu
        if (
          (event.type === 'updated' && event.action.type === 'success') ||
          event.type === 'removed' ||
          (event.type === 'added' && event.query.state.dataUpdatedAt > 0)
        ) {
          notify();
        }
      });
    },
    [cache],
  );
  const ts = useSyncExternalStore(subscribe, () => latestDataUpdatedAt(cache), () => 0);
  return ts > 0 ? new Date(ts) : null;
}

export function useOfflineSync() {
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const userId = user?.id ?? null;
  const [isSyncing, setIsSyncing] = useState(false);
  const [isOnline, setIsOnline] = useState(true);
  const lastSyncAt = useLastSyncedAt();

  // APP-08: Mục PENDING ("Chưa đồng bộ") và FAILED của người đang đăng nhập.
  // networkMode 'always': đọc SQLite không cần mạng.
  const itemsQ = useQuery({
    queryKey: [OFFLINE_QUEUE_KEY, userId],
    queryFn: () => offlineModule!.getUnsyncedItems(userId!),
    enabled: !!offlineModule && !!userId,
    networkMode: 'always',
    staleTime: 0,
  });

  const items: QueueItem[] = itemsQ.data ?? [];
  const pendingItems = items.filter((i) => i.status === 'PENDING');
  const failedItems = items.filter((i) => i.status === 'FAILED');

  const runSync = useCallback(async (followUp: boolean) => {
    if (!offlineModule || !userId) return;
    setIsSyncing(true);
    try {
      // REV-A9: followUp → nếu đang có lượt chạy thì hẹn thêm một lượt ngay sau (gồm mục vừa thử lại)
      const result = await offlineModule.processQueue(userId, { followUp });
      if (result.synced > 0) {
        queryClient.invalidateQueries();
      }
    } catch (e) {
      console.error('Sync error:', e);
    } finally {
      setIsSyncing(false);
    }
  }, [queryClient, userId]);

  const sync = useCallback(() => runSync(false), [runSync]);

  const retry = useCallback(
    async (id: number) => {
      if (!offlineModule) return;
      await offlineModule.retryItem(id);
      await runSync(true);
    },
    [runSync],
  );

  const discard = useCallback(async (id: number) => {
    if (!offlineModule) return;
    await offlineModule.discardItem(id);
  }, []);

  // Hàng đợi thay đổi → làm mới danh sách
  useEffect(() => {
    if (!offlineModule) return;
    return offlineModule.onQueueChange(() => {
      queryClient.invalidateQueries({ queryKey: [OFFLINE_QUEUE_KEY] });
    });
  }, [queryClient]);

  useEffect(() => {
    if (!offlineModule || !userId) return;

    // Đồng bộ khi mạng trở lại
    let unsubscribeNet: (() => void) | null = null;
    if (NetInfo) {
      unsubscribeNet = NetInfo.addEventListener((state) => {
        setIsOnline(state.isConnected !== false);
        if (state.isConnected) sync();
      });
    }

    // Đồng bộ khi app quay lại foreground
    const appStateSub = AppState.addEventListener('change', (nextState) => {
      if (nextState === 'active') sync();
    });

    // Đồng bộ định kỳ mỗi 30 giây
    const interval = setInterval(sync, 30_000);

    // Đồng bộ ban đầu sau delay ngắn
    const timer = setTimeout(sync, 1000);

    return () => {
      if (unsubscribeNet) unsubscribeNet();
      appStateSub.remove();
      clearInterval(interval);
      clearTimeout(timer);
    };
  }, [sync, userId]);

  return {
    pendingCount: pendingItems.length,
    pendingItems,
    failedItems,
    lastSyncAt,
    isSyncing,
    isOnline,
    sync,
    retry,
    discard,
  };
}

/** Mục chưa đồng bộ của một nhóm — để màn nhóm hiện nhãn "Chưa đồng bộ" (APP-08). */
export function useGroupUnsyncedItems(groupId: string | undefined): QueueItem[] {
  const { user } = useAuth();
  const userId = user?.id ?? null;
  const itemsQ = useQuery({
    queryKey: [OFFLINE_QUEUE_KEY, userId],
    queryFn: () => offlineModule!.getUnsyncedItems(userId!),
    enabled: !!offlineModule && !!userId,
    networkMode: 'always',
    staleTime: 0,
  });
  if (!groupId || !offlineModule) return [];
  const mod = offlineModule;
  return (itemsQ.data ?? []).filter((i) => mod.queueItemGroupId(i) === groupId);
}
