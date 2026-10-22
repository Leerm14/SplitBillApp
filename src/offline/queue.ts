/**
 * Hàng đợi ghi offline — lưu thao tác trước khi gửi, đồng bộ khi có mạng (DEV mục 6).
 * Dùng expo-sqlite để lưu trữ bền vững.
 *
 * APP-02: mỗi mục gắn user_id; mục của người khác bị bỏ.
 * APP-08: thêm last_attempt_at (epoch ms) để tính backoff từ lần thử cuối; sắp theo (created_at, id).
 */

import * as SQLite from 'expo-sqlite';

import { clearLocalReceipts, deleteLocalReceipt } from '@/lib/receipt-files';

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
  /** APP-08: thời điểm thử gửi gần nhất (epoch ms) */
  last_attempt_at: number | null;
  /** APP-02: người tạo thao tác */
  user_id: string | null;
  /** REV-A3: bắt đầu chờ gửi từ lúc nào (epoch ms) — đặt lại khi "Thử lại"; NULL ở mục cũ */
  pending_since: number | null;
}

let dbPromise: Promise<SQLite.SQLiteDatabase> | null = null;

/** APP-02 / APP-08: Thêm cột cho bản cài cũ (bảng tạo trước khi có user_id, last_attempt_at). */
async function migrate(db: SQLite.SQLiteDatabase): Promise<void> {
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
  const columns = await db.getAllAsync<{ name: string }>('PRAGMA table_info(queue)');
  const names = new Set(columns.map((c) => c.name));
  if (!names.has('user_id')) {
    await db.execAsync('ALTER TABLE queue ADD COLUMN user_id TEXT');
  }
  if (!names.has('last_attempt_at')) {
    await db.execAsync('ALTER TABLE queue ADD COLUMN last_attempt_at INTEGER');
  }
  if (!names.has('pending_since')) {
    await db.execAsync('ALTER TABLE queue ADD COLUMN pending_since INTEGER');
  }
  await db.execAsync('CREATE INDEX IF NOT EXISTS queue_user_status ON queue (user_id, status, created_at, id)');
}

function getDb(): Promise<SQLite.SQLiteDatabase> {
  if (!dbPromise) {
    dbPromise = (async () => {
      const db = await SQLite.openDatabaseAsync('offline_queue');
      await migrate(db);
      return db;
    })();
    // Lần mở lỗi thì cho phép thử lại ở lần gọi sau
    dbPromise.catch(() => {
      dbPromise = null;
    });
  }
  return dbPromise;
}

// ----------------------------
// Thông báo thay đổi (để UI làm mới danh sách "Chưa đồng bộ")
// ----------------------------

type Listener = () => void;
const listeners = new Set<Listener>();

export function onQueueChange(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function emitChange(): void {
  for (const l of listeners) {
    try {
      l();
    } catch (e) {
      console.warn('[Queue] listener error:', e);
    }
  }
}

// ----------------------------
// Ghi
// ----------------------------

/**
 * Thêm thao tác vào hàng đợi (trạng thái PENDING). Trùng idempotency_key thì giữ mục cũ.
 * @returns id của mục trong hàng đợi
 */
export async function enqueue(action: string, payload: unknown, idempotencyKey: string, userId: string): Promise<number> {
  const database = await getDb();
  await database.runAsync(
    'INSERT OR IGNORE INTO queue (action, payload, idempotency_key, user_id, pending_since) VALUES (?, ?, ?, ?, ?)',
    [action, JSON.stringify(payload), idempotencyKey, userId, Date.now()],
  );
  const row = await database.getFirstAsync<{ id: number }>(
    'SELECT id FROM queue WHERE idempotency_key = ?',
    [idempotencyKey],
  );
  emitChange();
  if (!row) throw new Error('Không ghi được vào hàng đợi');
  return row.id;
}

/** Đánh dấu đã đồng bộ */
export async function markSynced(id: number): Promise<void> {
  const database = await getDb();
  await database.runAsync(
    "UPDATE queue SET status = 'SYNCED', synced_at = datetime('now'), error_message = NULL WHERE id = ?",
    [id],
  );
  emitChange();
}

/** APP-08: Lần gửi lỗi tạm thời — giữ PENDING, tăng retries, ghi thời điểm thử. */
export async function markAttemptFailed(id: number, errorMessage: string): Promise<void> {
  const database = await getDb();
  await database.runAsync(
    "UPDATE queue SET retries = retries + 1, last_attempt_at = ?, error_message = ? WHERE id = ? AND status = 'PENDING'",
    [Date.now(), errorMessage, id],
  );
  emitChange();
}

/** Lỗi nghiệp vụ — FAILED, hiện cho người dùng. APP-03: không đè mục đã SYNCED. */
export async function markFailed(id: number, errorMessage: string): Promise<void> {
  const database = await getDb();
  await database.runAsync(
    "UPDATE queue SET status = 'FAILED', retries = retries + 1, last_attempt_at = ?, error_message = ? WHERE id = ? AND status <> 'SYNCED'",
    [Date.now(), errorMessage, id],
  );
  emitChange();
}

/** APP-08: Người dùng bấm "Thử lại" một mục FAILED — gửi lại ngay ở lượt đồng bộ sau. */
export async function retryItem(id: number): Promise<void> {
  const database = await getDb();
  await database.runAsync(
    "UPDATE queue SET status = 'PENDING', retries = 0, last_attempt_at = NULL, error_message = NULL, pending_since = ? WHERE id = ? AND status = 'FAILED'",
    [Date.now(), id],
  );
  emitChange();
}

/** APP-08: Người dùng bỏ một thao tác chưa đồng bộ / bị lỗi. */
export async function discardItem(id: number): Promise<void> {
  const database = await getDb();
  const row = await database.getFirstAsync<{ payload: string }>(
    "SELECT payload FROM queue WHERE id = ? AND status <> 'SYNCED'",
    [id],
  );
  await database.runAsync("DELETE FROM queue WHERE id = ? AND status <> 'SYNCED'", [id]);
  // MVP-01: bỏ thao tác thì xóa luôn ảnh hóa đơn tạm đi kèm
  if (row) deleteLocalReceipt(localReceiptUriOf(row.payload));
  emitChange();
}

/** MVP-01: uri ảnh hóa đơn tạm trong payload create_expense (nếu có). */
function localReceiptUriOf(payload: string): string | null {
  try {
    const p = JSON.parse(payload);
    return typeof p?.localReceiptUri === 'string' ? p.localReceiptUri : null;
  } catch {
    return null;
  }
}

/**
 * APP-02: Bỏ mục không thuộc người đang đăng nhập.
 * REV-A7: mục cũ chưa có user_id (tạo trước khi có cột) được gán cho người đang đăng nhập thay vì bị xóa;
 * chỉ xóa mục đã biết là của tài khoản KHÁC.
 */
export async function discardForeignItems(userId: string): Promise<number> {
  const database = await getDb();
  const claimed = await database.runAsync("UPDATE queue SET user_id = ? WHERE user_id IS NULL", [userId]);
  if (claimed.changes > 0) emitChange();
  const foreign = await database.getAllAsync<{ payload: string }>(
    "SELECT payload FROM queue WHERE status <> 'SYNCED' AND user_id <> ?",
    [userId],
  );
  const result = await database.runAsync(
    "DELETE FROM queue WHERE status <> 'SYNCED' AND user_id <> ?",
    [userId],
  );
  for (const row of foreign) deleteLocalReceipt(localReceiptUriOf(row.payload));
  if (result.changes > 0) {
    console.warn(`[Queue] Đã bỏ ${result.changes} thao tác không thuộc tài khoản hiện tại`);
    emitChange();
  }
  return result.changes;
}

/** Xóa mục đã đồng bộ quá 7 ngày */
export async function cleanupOldItems(): Promise<void> {
  const database = await getDb();
  await database.runAsync(
    "DELETE FROM queue WHERE status = 'SYNCED' AND synced_at < datetime('now', '-7 days')",
  );
}

// REV-A2: thế hệ hàng đợi — clearQueue tăng lên để lượt đồng bộ đang chạy dừng ngay
let generation = 0;

/** REV-A2: Lượt đồng bộ ghi lại thế hệ lúc bắt đầu; khác đi nghĩa là hàng đợi đã bị xóa (đăng xuất). */
export function getQueueGeneration(): number {
  return generation;
}

/** APP-02: Xóa toàn bộ hàng đợi (khi đăng xuất) */
export async function clearQueue(): Promise<void> {
  generation++;
  const database = await getDb();
  await database.runAsync('DELETE FROM queue');
  // MVP-01: ảnh hóa đơn đang chờ upload của tài khoản vừa đăng xuất
  clearLocalReceipts();
  emitChange();
}

// ----------------------------
// Đọc
// ----------------------------

/** Mục PENDING của người dùng, theo thứ tự tạo (created_at chỉ đến giây → thêm id) */
export async function getPendingItems(userId: string): Promise<QueueItem[]> {
  const database = await getDb();
  return database.getAllAsync<QueueItem>(
    "SELECT * FROM queue WHERE status = 'PENDING' AND user_id = ? ORDER BY created_at ASC, id ASC",
    [userId],
  );
}

/** Mục chưa đồng bộ (PENDING) và lỗi (FAILED) của người dùng — để hiện trên UI */
export async function getUnsyncedItems(userId: string): Promise<QueueItem[]> {
  const database = await getDb();
  return database.getAllAsync<QueueItem>(
    "SELECT * FROM queue WHERE status IN ('PENDING', 'FAILED') AND user_id = ? ORDER BY created_at ASC, id ASC",
    [userId],
  );
}

/** Đếm số mục đang chờ */
export async function getPendingCount(userId: string): Promise<number> {
  const database = await getDb();
  const result = await database.getFirstAsync<{ count: number }>(
    "SELECT COUNT(*) as count FROM queue WHERE status = 'PENDING' AND user_id = ?",
    [userId],
  );
  return result?.count ?? 0;
}

/** Lấy một mục theo ID */
export async function getQueueItem(id: number): Promise<QueueItem | null> {
  const database = await getDb();
  return database.getFirstAsync<QueueItem>('SELECT * FROM queue WHERE id = ?', [id]);
}
