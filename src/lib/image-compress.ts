/**
 * M2: Nén ảnh trước khi upload — dùng chung cho ảnh đại diện, ảnh nhóm, ảnh hóa đơn.
 * Dùng API theo ngữ cảnh của expo-image-manipulator (SDK 58: manipulateAsync đã deprecated):
 * ImageManipulator.manipulate(uri) → renderAsync() → ImageRef.saveAsync().
 */
import { ImageManipulator, SaveFormat, type ImageRef } from 'expo-image-manipulator';

import { fitLongestEdge, JPEG_QUALITY, MAX_IMAGE_EDGE } from '@/lib/image-sizing';

export type CompressedImage = { uri: string; width: number; height: number; mimeType: 'image/jpeg' };

function release(obj: { release?: () => void } | null | undefined): void {
  try {
    obj?.release?.();
  } catch {
    // đã giải phóng
  }
}

/** Cạnh dài nhất ≤ maxEdge (chỉ thu nhỏ khi lớn hơn), JPEG 0,7. Trả file mới trong thư mục cache. */
export async function compressImage(uri: string, maxEdge = MAX_IMAGE_EDGE): Promise<CompressedImage> {
  const original = ImageManipulator.manipulate(uri);
  let source: ImageRef | null = null;
  let resizedCtx: ReturnType<typeof ImageManipulator.manipulate> | null = null;
  let output: ImageRef | null = null;
  try {
    source = await original.renderAsync();
    const resize = fitLongestEdge(source.width, source.height, maxEdge);
    if (resize) {
      resizedCtx = ImageManipulator.manipulate(source).resize(resize);
      output = await resizedCtx.renderAsync();
    }
    const finalRef = output ?? source;
    const saved = await finalRef.saveAsync({ compress: JPEG_QUALITY, format: SaveFormat.JPEG });
    return { uri: saved.uri, width: saved.width, height: saved.height, mimeType: 'image/jpeg' };
  } finally {
    release(output);
    release(resizedCtx);
    release(source);
    release(original);
  }
}
