/**
 * Hook tự động đồng bộ hàng đợi offline.
 * - Đồng bộ khi có mạng trở lại
 * - Đồng bộ khi app quay lại foreground
 * - APP-03: fix stale closure, add module-level lock
 */

import { useEffect, useRef, useState, useCallback } from 'react';
import { AppState } from 'react-native';
import { useQueryClient } from '@tanstack/react-query';

let NetInfo: any = null;
let offlineModule: any = null;

try {
  NetInfo = require('@react-native-community/netinfo').default;
  offlineModule = require('@/offline');
} catch {
  // Không có trên web
}

// APP-03: Module-level lock to prevent concurrent sync
let syncPromise: Promise<void> | null = null;

export function useOfflineSync() {
  const queryClient = useQueryClient();
  const [pendingCount, setPendingCount] = useState(0);
  const [lastSyncAt, setLastSyncAt] = useState<Date | null>(null);
  const [isSyncing, setIsSyncing] = useState(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const refreshCount = useCallback(async () => {
    if (!offlineModule) return;
    try {
      const count = await offlineModule.getPendingCount();
      setPendingCount(count);
    } catch {
      // ignore
    }
  }, []);

  const sync = useCallback(async () => {
    // APP-03: Use module-level lock instead of stale state
    if (syncPromise || !offlineModule) return;
    setIsSyncing(true);
    syncPromise = (async () => {
      try {
        const result = await offlineModule.processQueue();
        if (result.synced > 0) {
          queryClient.invalidateQueries();
          setLastSyncAt(new Date());
        }
        await refreshCount();
      } catch (e) {
        console.error('Sync error:', e);
      }
    })();
    try {
      await syncPromise;
    } finally {
      syncPromise = null;
      setIsSyncing(false);
    }
  }, [queryClient, refreshCount]);

  useEffect(() => {
    if (!offlineModule) return;

    // Đếm ban đầu
    refreshCount();

    // Đồng bộ khi mạng trở lại
    let unsubscribeNet: (() => void) | null = null;
    if (NetInfo) {
      unsubscribeNet = NetInfo.addEventListener((state: any) => {
        if (state.isConnected) sync();
      });
    }

    // Đồng bộ khi app quay lại foreground
    const appStateSub = AppState.addEventListener('change', (nextState) => {
      if (nextState === 'active') sync();
    });

    // Đồng bộ định kỳ mỗi 30 giây
    intervalRef.current = setInterval(sync, 30_000);

    // Đồng bộ ban đầu sau delay ngắn
    const timer = setTimeout(() => sync(), 1000);

    return () => {
      if (unsubscribeNet) unsubscribeNet();
      appStateSub.remove();
      if (intervalRef.current) clearInterval(intervalRef.current);
      clearTimeout(timer);
    };
  }, [sync, refreshCount]);

  return { pendingCount, lastSyncAt, isSyncing, sync };
}

/**
 * Hook đơn giản hóa cho các màn hình — ghi vào hàng đợi trước, gửi sau
 */
export function useOfflineAction(
  action: string,
  handler: (params: any) => Promise<any>,
) {
  const enqueue = async (params: any) => {
    try {
      return await handler(params);
    } catch (err: any) {
      const msg = err?.message ?? '';
      // APP-08: Queue on any network/transient error, not just specific strings
      if (isNetworkError(msg)) {
        const { enqueue: addToQueue } = await import('../offline/queue');
        await addToQueue(action, params, params.idempotencyKey ?? `${action}-${Date.now()}`);
        return null;
      }
      throw err;
    }
  };

  return { enqueue };
}

function isNetworkError(message: string): boolean {
  const patterns = ['network', 'fetch', 'timeout', 'abort', 'ECONNREFUSED', 'ETIMEDOUT'];
  return patterns.some(p => message.toLowerCase().includes(p.toLowerCase()));
}
