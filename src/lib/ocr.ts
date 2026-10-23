/**
 * OCR-02: Đọc chữ trên ảnh hóa đơn bằng Google ML Kit, chạy hoàn toàn trên máy
 * (@react-native-ml-kit/text-recognition) — ảnh và chữ không gửi đi đâu.
 *
 * Thư viện có mã native: chạy trên development build / APK, KHÔNG có trong Expo Go.
 * Thiếu module thì isOcrAvailable() = false và màn thêm khoản chi ẩn nút đọc hóa đơn.
 */
import { NativeModules } from 'react-native';

import { parseReceiptLines, type OcrLine, type ParsedReceipt } from '@/domain/receipt';

export function isOcrAvailable(): boolean {
  return !!NativeModules.TextRecognition;
}

/** Đọc ảnh (file:// hoặc content://) → các dòng chữ kèm toạ độ */
export async function recognizeLines(imageUri: string): Promise<OcrLine[]> {
  // Nạp muộn: trong Expo Go module native không có, import sớm sẽ ném lỗi khi gọi
  const { default: TextRecognition } = await import('@react-native-ml-kit/text-recognition');
  const result = await TextRecognition.recognize(imageUri);
  const lines: OcrLine[] = [];
  for (const block of result.blocks) {
    for (const line of block.lines) {
      lines.push({ text: line.text, frame: line.frame });
    }
  }
  return lines;
}

/** Ảnh hóa đơn → món, phí, thuế, giảm giá, tổng (gợi ý để người dùng sửa — BR-12) */
export async function readReceipt(imageUri: string): Promise<ParsedReceipt> {
  return parseReceiptLines(await recognizeLines(imageUri));
}
