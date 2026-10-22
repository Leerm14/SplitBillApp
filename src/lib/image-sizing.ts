/**
 * M2: Quy tắc nén ảnh dùng chung (ảnh đại diện, ảnh nhóm, ảnh hóa đơn):
 * cạnh dài nhất ≤ 1600 px (chỉ thu nhỏ khi lớn hơn, không phóng to), JPEG chất lượng 0,7.
 * File thuần để test được bằng jest.
 */

export const MAX_IMAGE_EDGE = 1600;
export const JPEG_QUALITY = 0.7;

export type ResizeSpec = { width: number } | { height: number };

/**
 * Kích thước cần resize để cạnh dài nhất không vượt `maxEdge`; null nếu ảnh đã đủ nhỏ.
 * Chỉ trả một chiều — ImageManipulator tự giữ tỉ lệ.
 */
export function fitLongestEdge(width: number, height: number, maxEdge = MAX_IMAGE_EDGE): ResizeSpec | null {
  if (!(width > 0) || !(height > 0) || !(maxEdge > 0)) return null;
  if (Math.max(width, height) <= maxEdge) return null;
  return width >= height ? { width: maxEdge } : { height: maxEdge };
}
