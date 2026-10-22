/**
 * MVP-01: Bản sao ảnh hóa đơn đã nén trong thư mục tài liệu của app — để hàng đợi offline
 * upload sau khi có mạng (thư mục cache có thể bị hệ điều hành xóa bất kỳ lúc nào).
 * Dùng API File / Directory / Paths của expo-file-system SDK 58.
 */
import * as Crypto from 'expo-crypto';
import { Directory, File, Paths } from 'expo-file-system';

const DIR_NAME = 'pending-receipts';

function pendingDir(): Directory {
  return new Directory(Paths.document, DIR_NAME);
}

/** Chép ảnh (đã nén) vào thư mục tài liệu; trả URI bản sao. */
export async function persistReceiptCopy(sourceUri: string): Promise<string> {
  const dir = pendingDir();
  if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
  const target = new File(dir, `${Crypto.randomUUID()}.jpg`);
  await new File(sourceUri).copy(target);
  return target.uri;
}

/** Bản sao còn trên máy không. */
export function localFileExists(uri: string): boolean {
  try {
    return new File(uri).exists;
  } catch {
    return false;
  }
}

/** Đọc toàn bộ byte của file cục bộ (thay cho fetch(uri).blob() → Response.arrayBuffer() không chạy ổn trên RN). */
export async function readFileBytes(uri: string): Promise<Uint8Array> {
  return new File(uri).bytes();
}

/** Xóa bản sao (best-effort). Chỉ xóa file nằm trong thư mục pending-receipts. */
export function deleteLocalReceipt(uri: string | null | undefined): void {
  if (!uri) return;
  try {
    const dirUri = pendingDir().uri;
    if (!uri.startsWith(dirUri)) return;
    const file = new File(uri);
    if (file.exists) file.delete();
  } catch (e) {
    console.warn('[Receipt] Không xóa được ảnh tạm:', e);
  }
}

/** Đăng xuất: xóa mọi ảnh hóa đơn đang chờ upload. */
export function clearLocalReceipts(): void {
  try {
    const dir = pendingDir();
    if (dir.exists) dir.delete();
  } catch (e) {
    console.warn('[Receipt] Không dọn được thư mục ảnh tạm:', e);
  }
}
