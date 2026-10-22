/**
 * MVP-04 / MVP-05 / M6: Liên kết trong app (QR mời nhóm, QR mã nhóm, QR kết bạn).
 *
 * App chỉ chấp nhận liên kết do chính nó tạo bằng Linking.createURL:
 *   - bản build: `splitbill:///join/<token>` (scheme trong app.json)
 *   - Expo Go / dev server: `exp://<host>:<port>/--/join/<token>` (đúng tiền tố createURL trả về lúc chạy)
 * và chỉ ba đường dẫn: join/<token>, join-code/<code>, add-friend/<code>. Mọi thứ khác bị từ chối.
 *
 * File thuần (không import React Native) để test được bằng jest; phần lấy tiền tố lúc chạy
 * (Linking.createURL) nằm ở nơi gọi.
 */

export const APP_SCHEME = 'splitbill';

/** Token lời mời: 12 ký tự chữ + số (create_invite); cho phép dài hơn nếu server đổi. */
export const INVITE_TOKEN_RE = /^[A-Za-z0-9]{12,64}$/;
/** Mã mời nhóm và mã người dùng: 8 ký tự A-Z, 0-9 (viết hoa). */
export const SHORT_CODE_RE = /^[A-Z0-9]{8}$/;

export type AppLink =
  | { kind: 'join'; token: string }
  | { kind: 'join-code'; code: string }
  | { kind: 'add-friend'; code: string };

/** Đoạn tiền tố / hậu tố quanh đường dẫn trong một URL do createURL tạo. */
export type LinkFrame = { prefix: string; suffix: string };

export const PROBE_MARKER = '__splitbill_probe__';

/**
 * Tách tiền tố / hậu tố từ URL thăm dò `Linking.createURL('/' + PROBE_MARKER)`.
 * Ví dụ `exp://192.168.1.5:8081/--/__splitbill_probe__` → prefix `exp://192.168.1.5:8081/--/`.
 */
export function frameFromProbe(probeUrl: string, marker = PROBE_MARKER): LinkFrame | null {
  const i = probeUrl.indexOf(marker);
  if (i <= 0) return null;
  return { prefix: probeUrl.slice(0, i), suffix: probeUrl.slice(i + marker.length) };
}

/** Khung cố định của bản build: `splitbill://` (createURL tạo `splitbill:///path`). */
export const BUILD_FRAME: LinkFrame = { prefix: `${APP_SCHEME}://`, suffix: '' };

/**
 * Đường dẫn trong app → AppLink. Cho phép tối đa một dấu `/` ở đầu; không cho query, hash,
 * đoạn thừa, ký tự ngoài regex.
 */
export function parseAppLinkPath(path: string | null | undefined): AppLink | null {
  if (typeof path !== 'string') return null;
  const p = path.startsWith('/') ? path.slice(1) : path;
  const parts = p.split('/');
  if (parts.length !== 2) return null;
  const [head, value] = parts;
  switch (head) {
    case 'join':
      return INVITE_TOKEN_RE.test(value) ? { kind: 'join', token: value } : null;
    case 'join-code':
      return SHORT_CODE_RE.test(value) ? { kind: 'join-code', code: value } : null;
    case 'add-friend':
      return SHORT_CODE_RE.test(value) ? { kind: 'add-friend', code: value } : null;
    default:
      return null;
  }
}

/**
 * M6: Nội dung QR quét được → AppLink, chỉ khi URL nằm đúng trong một khung do app tạo.
 * Không giải mã %xx, không bỏ qua khoảng trắng — QR của app không có các thứ đó.
 */
export function parseScannedLink(data: string, frames: LinkFrame[]): AppLink | null {
  if (typeof data !== 'string' || data.length === 0 || data.length > 512) return null;
  // Thử khung dài trước (exp://host/--/ cụ thể hơn splitbill://)
  const sorted = [...frames].filter((f) => f.prefix.length > 0).sort((a, b) => b.prefix.length - a.prefix.length);
  for (const frame of sorted) {
    if (!data.startsWith(frame.prefix)) continue;
    if (frame.suffix && !data.endsWith(frame.suffix)) continue;
    const middle = data.slice(frame.prefix.length, data.length - frame.suffix.length);
    const link = parseAppLinkPath(middle);
    if (link) return link;
  }
  return null;
}

/** Màn hình trong app tương ứng (đường dẫn expo-router). */
export function appLinkToRoute(link: AppLink): string {
  switch (link.kind) {
    case 'join':
      return `/join/${link.token}`;
    case 'join-code':
      return `/join-code/${link.code}`;
    case 'add-friend':
      return `/add-friend/${link.code}`;
  }
}

/** Đường dẫn trong app (vd. `/join/abc…` khi mở từ liên kết lúc chưa đăng nhập) cần giữ qua bước đăng nhập. */
export function resumableRoute(pathname: string | null | undefined): string | null {
  const link = parseAppLinkPath(pathname);
  return link ? appLinkToRoute(link) : null;
}
