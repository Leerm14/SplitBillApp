/**
 * Hàng đợi ghi offline — lưu thao tác khi mất mạng, đồng bộ khi có mạng.
 * Dùng expo-sqlite để lưu trữ bền vững.
 */

import * as SQLite from 'expo-sqlite';

export type QueueItemStatus = 'PENDING' | 'SYNCED' | 'FAILED';

export interface QueueItem {
  id: number;
  action: string;
  payload: string;
  idempotency_key: string;
  status: QueueItemStatus;
  retries: number;
  error_message: string | null;
  created_at: string;
  synced_at: string | null;
  last_attempt_at?: string | null; // APP-08: track last attempt time
  user_id?: string; // APP-02: track which user created this item
}

let db: SQLite.SQLiteDatabase | null = null;

async function getDb(): Promise<SQLite.SQLiteDatabase> {
  if (!db) {
    db = await SQLite.openDatabaseAsync('offline_queue');
    await db.execAsync(`
      CREATE TABLE IF NOT EXISTS queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        action TEXT NOT NULL,
        payload TEXT NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL DEFAULT 'PENDING',
        retries INTEGER NOT NULL DEFAULT 0,
        error_message TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        synced_at TEXT
      );
    `);
  }
  return db;
}

/** Thêm thao tác vào hàng đợi */
export async function enqueue(action: string, payload: any, idempotencyKey: string): Promise<number> {
  const database = await getDb();
  const result = await database.runAsync(
    'INSERT OR IGNORE INTO queue (action, payload, idempotency_key) VALUES (?, ?, ?)',
    [action, JSON.stringify(payload), idempotencyKey],
  );
  return result.lastInsertRowId;
}

/** Lấy tất cả mục đang chờ */
export async function getPendingItems(): Promise<QueueItem[]> {
  const database = await getDb();
  return database.getAllAsync<QueueItem>(
    'SELECT * FROM queue WHERE status = ? ORDER BY created_at ASC',
    ['PENDING'],
  );
}

/** Đánh dấu đã đồng bộ */
export async function markSynced(id: number): Promise<void> {
  const database = await getDb();
  await database.runAsync(
    "UPDATE queue SET status = 'SYNCED', synced_at = datetime('now') WHERE id = ?",
    [id],
  );
}

/** Đánh dấu lỗi */
export async function markFailed(id: number, errorMessage: string): Promise<void> {
  const database = await getDb();
  await database.runAsync(
    "UPDATE queue SET status = 'FAILED', retries = retries + 1, error_message = ? WHERE id = ?",
    [errorMessage, id],
  );
}

/** Thử lại mục đã lỗi */
export async function retryItem(id: number): Promise<void> {
  const database = await getDb();
  await database.runAsync(
    "UPDATE queue SET status = 'PENDING', error_message = NULL WHERE id = ?",
    [id],
  );
}

/** Đếm số mục đang chờ */
export async function getPendingCount(): Promise<number> {
  const database = await getDb();
  const result = await database.getFirstAsync<{ count: number }>(
    'SELECT COUNT(*) as count FROM queue WHERE status = ?',
    ['PENDING'],
  );
  return result?.count ?? 0;
}

/** Lấy tất cả mục (debug/hiển thị) */
export async function getAllItems(limit = 50): Promise<QueueItem[]> {
  const database = await getDb();
  return database.getAllAsync<QueueItem>(
    'SELECT * FROM queue ORDER BY created_at DESC LIMIT ?',
    [limit],
  );
}

/** Xóa mục đã đồng bộ quá 7 ngày */
export async function cleanupOldItems(): Promise<void> {
  const database = await getDb();
  await database.runAsync(
    "DELETE FROM queue WHERE status = 'SYNCED' AND synced_at < datetime('now', '-7 days')",
  );
}

/** APP-02: Clear all queue items (used on sign out) */
export async function clearQueue(): Promise<void> {
  const database = await getDb();
  await database.runAsync('DELETE FROM queue');
}

/** Lấy tất cả mục bị lỗi */
export async function getFailedItems(): Promise<QueueItem[]> {
  const database = await getDb();
  return database.getAllAsync<QueueItem>(
    'SELECT * FROM queue WHERE status = ? ORDER BY created_at DESC',
    ['FAILED'],
  );
}

/** Lấy một mục theo ID */
export async function getQueueItem(id: number): Promise<QueueItem | null> {
  const database = await getDb();
  return database.getFirstAsync<QueueItem>(
    'SELECT * FROM queue WHERE id = ?',
    [id],
  );
}

/** Cập nhật một mục */
export async function updateItem(id: number, updates: Partial<Pick<QueueItem, 'status' | 'error_message'>>): Promise<void> {
  const database = await getDb();
  const parts: string[] = [];
  const values: (string | number)[] = [];

  if (updates.status !== undefined) {
    parts.push('status = ?');
    values.push(updates.status);
  }
  if (updates.error_message !== undefined) {
    parts.push('error_message = ?');
    values.push(updates.error_message ?? '');
  }

  if (parts.length === 0) return;
  values.push(id);
  await database.runAsync(`UPDATE queue SET ${parts.join(', ')} WHERE id = ?`, values);
}

