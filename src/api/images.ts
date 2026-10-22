/**
 * MVP-00: Ảnh đại diện + ảnh nhóm trên Cloudinary (phương án A — ảnh hóa đơn ở Supabase Storage).
 *
 *   App → Edge Function cloudinary-sign {action:'sign'} (kiểm tra quyền, đặt public_id, ký)
 *   App → Cloudinary upload_url (multipart: file + đúng các tham số đã ký)
 *   App → RPC update_profile / update_group (lưu public_id)
 *
 * API secret chỉ nằm trong Edge Function. Xóa ảnh cũ cũng qua Edge Function {action:'destroy'}.
 */

import { ApiError } from '@/api/errors';
import { invokeFunction } from '@/api/functions';
import { compressImage } from '@/lib/image-compress';

export type ImageKind = 'avatar' | 'group';

type SignResponse = {
  cloud_name: string;
  api_key: string;
  timestamp: number | string;
  signature: string;
  public_id: string;
  asset_folder: string;
  allowed_formats: string;
  upload_url: string;
};

type CloudinaryUploadResponse = {
  public_id?: string;
  error?: { message?: string };
};

/**
 * Upload ảnh (đã nén) lên Cloudinary.
 * @returns public_id do server đặt (`<uid>/avatar_<ts>` hoặc `<group_id>/group_<ts>`)
 */
export async function uploadImage(kind: ImageKind, localUri: string, ids?: { groupId?: string }): Promise<string> {
  if (kind === 'group' && !ids?.groupId) throw new Error('Thiếu groupId khi upload ảnh nhóm');

  const compressed = await compressImage(localUri);

  const sign = await invokeFunction<SignResponse>('cloudinary-sign', {
    action: 'sign',
    kind,
    ...(kind === 'group' ? { group_id: ids!.groupId } : {}),
  });

  // Chỉ gửi đúng các tham số đã ký (thêm tham số khác → Cloudinary báo sai chữ ký)
  const form = new FormData();
  form.append('file', { uri: compressed.uri, name: 'upload.jpg', type: compressed.mimeType } as unknown as Blob);
  form.append('api_key', sign.api_key);
  form.append('timestamp', String(sign.timestamp));
  form.append('signature', sign.signature);
  form.append('public_id', sign.public_id);
  form.append('asset_folder', sign.asset_folder);
  form.append('allowed_formats', sign.allowed_formats);

  const response = await fetch(sign.upload_url, { method: 'POST', body: form });
  let body: CloudinaryUploadResponse | null = null;
  try {
    body = (await response.json()) as CloudinaryUploadResponse;
  } catch {
    body = null;
  }
  if (!response.ok || !body?.public_id) {
    const detail = body?.error?.message ?? `HTTP ${response.status}`;
    console.warn('[Cloudinary] upload failed:', detail);
    throw new ApiError(`UPLOAD_FAILED: Không upload được ảnh (${detail})`, { status: response.status });
  }
  return body.public_id;
}

/**
 * Xóa ảnh trên Cloudinary (qua Edge Function, có kiểm tra quyền). Best-effort: lỗi chỉ ghi log,
 * không làm hỏng thao tác chính (ảnh mồ côi được dọn định kỳ).
 */
export async function destroyImage(kind: ImageKind, publicId: string | null | undefined, ids?: { groupId?: string }): Promise<void> {
  if (!publicId) return;
  try {
    await invokeFunction<{ result: string }>('cloudinary-sign', {
      action: 'destroy',
      kind,
      public_id: publicId,
      ...(kind === 'group' && ids?.groupId ? { group_id: ids.groupId } : {}),
    });
  } catch (e) {
    console.warn('[Cloudinary] destroy failed:', (e as Error)?.message ?? e);
  }
}

/**
 * URL hiển thị ảnh Cloudinary: `c_fill,w_<n>,h_<n>,f_auto,q_auto` (ảnh vuông, đúng định dạng máy).
 * Trả null nếu chưa có ảnh hoặc chưa cấu hình EXPO_PUBLIC_CLOUDINARY_CLOUD_NAME → hiện chữ cái đầu.
 */
export function imageUrl(publicId: string | null | undefined, opts?: { width?: number }): string | null {
  if (!publicId) return null;
  const cloudName = process.env.EXPO_PUBLIC_CLOUDINARY_CLOUD_NAME;
  if (!cloudName) return null;
  const transforms: string[] = [];
  if (opts?.width) {
    const w = Math.round(opts.width);
    transforms.push('c_fill', `w_${w}`, `h_${w}`);
  }
  transforms.push('f_auto', 'q_auto');
  const path = publicId.split('/').map(encodeURIComponent).join('/');
  return `https://res.cloudinary.com/${cloudName}/image/upload/${transforms.join(',')}/${path}`;
}
