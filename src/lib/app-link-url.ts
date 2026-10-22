/**
 * MVP-04 / MVP-05: Tạo và nhận dạng liên kết của app lúc chạy (dùng Linking.createURL theo scheme
 * trong app.json). Phần thuần (regex, phân tích) nằm ở app-links.ts.
 */
import * as Linking from 'expo-linking';

import {
  appLinkToRoute,
  BUILD_FRAME,
  frameFromProbe,
  parseScannedLink,
  PROBE_MARKER,
  type AppLink,
  type LinkFrame,
} from '@/lib/app-links';

/** URL đầy đủ để đưa vào QR / chia sẻ. */
export function createAppLink(link: AppLink): string {
  return Linking.createURL(appLinkToRoute(link));
}

/** Các khung URL app chấp nhận: bản build (`splitbill://`) và dạng createURL trả về lúc chạy (exp:// khi dev). */
export function appLinkFrames(): LinkFrame[] {
  const frames: LinkFrame[] = [BUILD_FRAME];
  try {
    const runtime = frameFromProbe(Linking.createURL(`/${PROBE_MARKER}`));
    if (runtime && runtime.prefix !== BUILD_FRAME.prefix) frames.push(runtime);
  } catch {
    // createURL lỗi (thiếu scheme) — vẫn nhận dạng được bản build
  }
  return frames;
}

/** M6: Nội dung QR → AppLink (null nếu không phải QR của Split Bill). */
export function parseScannedAppLink(data: string): AppLink | null {
  return parseScannedLink(data, appLinkFrames());
}
