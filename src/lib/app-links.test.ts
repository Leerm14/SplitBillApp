import {
  appLinkToRoute,
  BUILD_FRAME,
  frameFromProbe,
  parseAppLinkPath,
  parseScannedLink,
  PROBE_MARKER,
  resumableRoute,
  type LinkFrame,
} from './app-links';

const TOKEN = 'aB3dE5gH7jK9';
const CODE = 'AB12CD34';

const EXPO_GO_FRAME = frameFromProbe(`exp://192.168.1.5:8081/--/${PROBE_MARKER}`)!;
const FRAMES: LinkFrame[] = [BUILD_FRAME, EXPO_GO_FRAME];

describe('frameFromProbe', () => {
  test('tách tiền tố của createURL khi chạy Expo Go', () => {
    expect(EXPO_GO_FRAME).toEqual({ prefix: 'exp://192.168.1.5:8081/--/', suffix: '' });
  });

  test('bản build (splitbill:///probe)', () => {
    expect(frameFromProbe(`splitbill:///${PROBE_MARKER}`)).toEqual({ prefix: 'splitbill:///', suffix: '' });
  });

  test('giữ hậu tố query nếu createURL thêm vào', () => {
    expect(frameFromProbe(`exp://h/--/${PROBE_MARKER}?x=1`)).toEqual({ prefix: 'exp://h/--/', suffix: '?x=1' });
  });

  test('không có marker → null', () => {
    expect(frameFromProbe('exp://h/--/other')).toBeNull();
  });
});

describe('parseAppLinkPath', () => {
  test('ba đường dẫn hợp lệ', () => {
    expect(parseAppLinkPath(`join/${TOKEN}`)).toEqual({ kind: 'join', token: TOKEN });
    expect(parseAppLinkPath(`/join-code/${CODE}`)).toEqual({ kind: 'join-code', code: CODE });
    expect(parseAppLinkPath(`add-friend/${CODE}`)).toEqual({ kind: 'add-friend', code: CODE });
  });

  test('từ chối giá trị sai định dạng, đoạn thừa, đường dẫn lạ', () => {
    expect(parseAppLinkPath('join/short')).toBeNull();
    expect(parseAppLinkPath(`join/${TOKEN}/x`)).toBeNull();
    expect(parseAppLinkPath('join-code/ab12cd34')).toBeNull(); // phải viết hoa
    expect(parseAppLinkPath('add-friend/AB12CD3')).toBeNull();
    expect(parseAppLinkPath(`add-friend/${CODE}?x=1`)).toBeNull();
    expect(parseAppLinkPath(`//join/${TOKEN}`)).toBeNull();
    expect(parseAppLinkPath(`settings/${CODE}`)).toBeNull();
    expect(parseAppLinkPath(null)).toBeNull();
  });
});

describe('parseScannedLink (M6)', () => {
  test('nhận liên kết bản build: splitbill:///path và splitbill://path', () => {
    expect(parseScannedLink(`splitbill:///join/${TOKEN}`, FRAMES)).toEqual({ kind: 'join', token: TOKEN });
    expect(parseScannedLink(`splitbill://add-friend/${CODE}`, FRAMES)).toEqual({ kind: 'add-friend', code: CODE });
  });

  test('nhận đúng dạng exp:// của dev server đang chạy', () => {
    expect(parseScannedLink(`exp://192.168.1.5:8081/--/join-code/${CODE}`, FRAMES)).toEqual({
      kind: 'join-code',
      code: CODE,
    });
  });

  test('từ chối web, scheme khác, dev server khác, host lạ', () => {
    expect(parseScannedLink(`https://evil.example/join/${TOKEN}`, FRAMES)).toBeNull();
    expect(parseScannedLink(`https://evil.example/--/join/${TOKEN}`, FRAMES)).toBeNull();
    expect(parseScannedLink(`otherapp://join/${TOKEN}`, FRAMES)).toBeNull();
    expect(parseScannedLink(`exp://10.0.0.9:8081/--/join/${TOKEN}`, FRAMES)).toBeNull();
    expect(parseScannedLink(`splitbill://evil.example/join/${TOKEN}`, FRAMES)).toBeNull();
    expect(parseScannedLink(CODE, FRAMES)).toBeNull();
    expect(parseScannedLink('', FRAMES)).toBeNull();
  });

  test('từ chối token / mã sai định dạng hoặc có thêm query', () => {
    expect(parseScannedLink('splitbill:///join/abc', FRAMES)).toBeNull();
    expect(parseScannedLink(`splitbill:///join/${TOKEN}?next=https://x`, FRAMES)).toBeNull();
    expect(parseScannedLink('splitbill:///join-code/abc%2F..', FRAMES)).toBeNull();
  });
});

describe('route helpers', () => {
  test('appLinkToRoute', () => {
    expect(appLinkToRoute({ kind: 'join', token: TOKEN })).toBe(`/join/${TOKEN}`);
    expect(appLinkToRoute({ kind: 'join-code', code: CODE })).toBe(`/join-code/${CODE}`);
    expect(appLinkToRoute({ kind: 'add-friend', code: CODE })).toBe(`/add-friend/${CODE}`);
  });

  test('resumableRoute giữ lại các màn mở từ liên kết khi chưa đăng nhập', () => {
    expect(resumableRoute(`/join/${TOKEN}`)).toBe(`/join/${TOKEN}`);
    expect(resumableRoute(`/join-code/${CODE}`)).toBe(`/join-code/${CODE}`);
    expect(resumableRoute(`/add-friend/${CODE}`)).toBe(`/add-friend/${CODE}`);
    expect(resumableRoute('/group/123')).toBeNull();
    expect(resumableRoute('/')).toBeNull();
  });
});
