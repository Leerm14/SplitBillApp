/**
 * TanStack Query persister — lưu cache đọc dữ liệu khi mất mạng.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { createAsyncStoragePersister } from '@tanstack/query-async-storage-persister';
import { defaultShouldDehydrateQuery, type Query } from '@tanstack/react-query';

const STORAGE_KEY = 'SPLITBILL_QUERY_CACHE';

// APP-12: Configure gcTime to keep cache for offline use
export const queryClientConfig = {
  defaultOptions: {
    queries: {
      staleTime: 1000 * 60 * 5, // 5 minutes
      gcTime: 1000 * 60 * 60 * 24, // 24 hours — keep in cache for offline
      retry: 2,
    },
  },
};

export const asyncStoragePersister = createAsyncStoragePersister({
  storage: AsyncStorage,
  key: STORAGE_KEY,
  // APP-12: Set maxAge to match gcTime
  serialize: JSON.stringify,
  deserialize: JSON.parse,
});

const NON_PERSISTED_KEYS = new Set(['offline-queue', 'receipt-url']);

// APP-12: Persist options with maxAge
export const persistOptions = {
  persister: asyncStoragePersister,
  maxAge: 1000 * 60 * 60 * 24, // 24 hours
  buster: '1.1.0', // Increment on breaking cache changes (1.1.0: kiểu dữ liệu API mới — APP-18)
  dehydrateOptions: {
    // APP-08: Danh sách hàng đợi offline đọc từ SQLite — không lưu vào cache
    // MVP-01: signed URL ảnh hóa đơn hết hạn sau vài phút — không lưu
    shouldDehydrateQuery: (query: Query) =>
      !NON_PERSISTED_KEYS.has(String(query.queryKey[0])) && defaultShouldDehydrateQuery(query),
  },
};

// APP-02: Clear persisted cache on sign out
export async function clearPersistedCache(): Promise<void> {
  try {
    await AsyncStorage.removeItem(STORAGE_KEY);
  } catch (e) {
    console.warn('[QueryPersister] Failed to clear cache:', e);
  }
}
