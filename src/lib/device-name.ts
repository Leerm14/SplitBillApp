/**
 * Tên thiết bị dễ đọc từ user agent của phiên đăng nhập (auth.sessions.user_agent).
 * App trên Android gửi kiểu "okhttp/4.x", trên iOS kiểu "<app>/1 CFNetwork/… Darwin/…",
 * trình duyệt gửi user agent đầy đủ — chỉ đoán được loại máy, không có tên riêng của máy.
 */
export function describeUserAgent(userAgent: string | null | undefined): string {
  const ua = (userAgent ?? '').trim();
  if (!ua) return 'Thiết bị không rõ';

  const expoGo = /Expo(nent)?(Go)?\//i.test(ua) || /Expo Go/i.test(ua);
  const browser = /Mozilla\//.test(ua);
  let name: string;

  if (/iPad/i.test(ua)) name = 'iPad';
  else if (/iPhone/i.test(ua)) name = 'iPhone';
  else if (/Android/i.test(ua) || /okhttp/i.test(ua)) name = 'Android';
  else if (/CFNetwork|Darwin/i.test(ua)) name = 'iPhone / iPad';
  else if (/Windows/i.test(ua)) name = 'Máy tính Windows';
  else if (/Macintosh|Mac OS X/i.test(ua)) name = 'Máy Mac';
  else if (/Linux/i.test(ua)) name = 'Máy tính Linux';
  else name = 'Thiết bị khác';

  if (expoGo) return `${name} (Expo Go)`;
  if (browser) return `${name} (trình duyệt)`;
  return name;
}
