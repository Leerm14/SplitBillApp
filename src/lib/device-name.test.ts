import { describeUserAgent } from './device-name';

describe('describeUserAgent', () => {
  test('app Android (okhttp)', () => {
    expect(describeUserAgent('okhttp/4.12.0')).toBe('Android');
  });

  test('app iOS (CFNetwork / Darwin)', () => {
    expect(describeUserAgent('SplitBill/1 CFNetwork/1568.100.1 Darwin/24.0.0')).toBe('iPhone / iPad');
  });

  test('Expo Go', () => {
    expect(describeUserAgent('Expo/2.32.10 CFNetwork/1568.100.1 Darwin/24.0.0')).toBe('iPhone / iPad (Expo Go)');
  });

  test('trình duyệt trên iPhone, Android, Windows', () => {
    expect(describeUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15')).toBe('iPhone (trình duyệt)');
    expect(describeUserAgent('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/130.0')).toBe('Android (trình duyệt)');
    expect(describeUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0')).toBe('Máy tính Windows (trình duyệt)');
  });

  test('không có user agent', () => {
    expect(describeUserAgent(null)).toBe('Thiết bị không rõ');
    expect(describeUserAgent('  ')).toBe('Thiết bị không rõ');
  });
});
