/**
 * APP-11 / REV-A8: Đường dẫn trong app cần mở SAU khi đăng nhập xong
 * (liên kết mời mở khi chưa đăng nhập, hoặc thông báo được bấm lúc app đang tắt / chưa đăng nhập).
 * Lưu ở module để AuthGate (_layout) và useNotifications dùng chung; chỉ giữ đích gần nhất.
 */

type Listener = () => void;

let pendingPath: string | null = null;
const listeners = new Set<Listener>();

export function setPendingLink(path: string | null): void {
  pendingPath = path;
  for (const l of listeners) l();
}

export function peekPendingLink(): string | null {
  return pendingPath;
}

/** Lấy đích đang chờ và xóa luôn (mỗi đích chỉ điều hướng một lần). */
export function takePendingLink(): string | null {
  const p = pendingPath;
  pendingPath = null;
  return p;
}

/** Báo cho AuthGate biết vừa có đích mới (ví dụ thông báo cold start sau khi đã đăng nhập). */
export function onPendingLinkChange(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
