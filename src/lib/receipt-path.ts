/**
 * MVP-01 / C1: Đường dẫn ảnh hóa đơn trong bucket Supabase `receipts`.
 *
 * Policy storage (0010 can_write_receipt) đòi đúng dạng `<group_id>/<uuid>/<file>`:
 * ít nhất 3 đoạn, đoạn 1 là id nhóm, đoạn 2 là UUID (id khoản chi hoặc UUID tạm khi khoản chi
 * chưa tồn tại). RPC create_expense / update_expense chỉ nhận receipt_path bắt đầu bằng `<group_id>/`.
 *
 * File thuần (không import React Native) để test được bằng jest.
 */

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string | null | undefined): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

/**
 * `<groupId>/<folderId>/<fileId>.jpg` — folderId là id khoản chi (màn sửa) hoặc UUID tạm (màn thêm).
 * Ném lỗi nếu một trong ba không phải UUID (đường dẫn sai sẽ bị policy từ chối).
 */
export function buildReceiptPath(groupId: string, folderId: string, fileId: string): string {
  if (!isUuid(groupId) || !isUuid(folderId) || !isUuid(fileId)) {
    throw new Error('INVALID_RECEIPT_PATH: groupId, folderId và fileId phải là UUID');
  }
  return `${groupId}/${folderId}/${fileId}.jpg`;
}

/** Đường dẫn có đúng dạng policy chấp nhận và nằm trong thư mục của nhóm `groupId` không. */
export function isValidReceiptPath(path: string | null | undefined, groupId: string): boolean {
  if (typeof path !== 'string' || !isUuid(groupId)) return false;
  const parts = path.split('/');
  if (parts.length < 3) return false;
  if (parts[0].toLowerCase() !== groupId.toLowerCase()) return false;
  if (!isUuid(parts[1])) return false;
  return parts[parts.length - 1] !== '';
}

/**
 * MVP-01: receipt_path gửi lên update_expense. RPC GHI ĐÈ cột này bằng giá trị nhận được:
 * - có ảnh mới → đường dẫn mới
 * - người dùng xóa ảnh → null
 * - không đổi → đường dẫn hiện có
 */
export function resolveReceiptPathForUpdate(params: {
  existing: string | null;
  uploadedPath: string | null;
  removed: boolean;
}): string | null {
  if (params.uploadedPath) return params.uploadedPath;
  if (params.removed) return null;
  return params.existing;
}
