import {
  balanceLabel,
  canRemoveMember,
  hasPendingPayment,
  joinPendingMessage,
  joinRequestErrorMessage,
  joinViaLabel,
  toJoinResult,
} from './membership';

// formatVND dùng toLocaleString('vi-VN'): chỉ so phần chữ số, bỏ dấu phân cách
const digits = (s: string | null) => (s ?? '').replace(/[^\d]/g, '');

describe('toJoinResult', () => {
  test('đọc đủ trường của jsonb', () => {
    expect(toJoinResult({ status: 'PENDING', group_id: 'g', group_name: 'Đà Lạt', request_id: 'r' })).toEqual({
      status: 'PENDING',
      groupId: 'g',
      groupName: 'Đà Lạt',
      requestId: 'r',
    });
  });

  test('ALREADY_MEMBER, request_id null', () => {
    const r = toJoinResult({ status: 'ALREADY_MEMBER', group_id: 'g', group_name: 'A', request_id: null });
    expect(r.status).toBe('ALREADY_MEMBER');
    expect(r.requestId).toBeNull();
  });

  test('mảng một phần tử và giá trị lạ', () => {
    expect(toJoinResult([{ status: 'JOINED', group_id: 'g' }]).groupId).toBe('g');
    expect(toJoinResult({ status: 'WHAT' }).status).toBe('JOINED');
    expect(toJoinResult(null)).toEqual({ status: 'JOINED', groupId: '', groupName: '', requestId: null });
  });
});

describe('joinPendingMessage / joinViaLabel', () => {
  test('câu chờ duyệt có tên nhóm', () => {
    expect(joinPendingMessage('Đà Lạt')).toBe('Đã gửi yêu cầu tham gia nhóm Đà Lạt. Chờ chủ nhóm duyệt.');
    expect(joinPendingMessage('  ')).toBe('Đã gửi yêu cầu tham gia nhóm này. Chờ chủ nhóm duyệt.');
  });

  test('nhãn đường vào', () => {
    expect(joinViaLabel('TOKEN')).toBe('Qua link mời');
    expect(joinViaLabel('code')).toBe('Qua mã nhóm');
    expect(joinViaLabel('QR')).toBe('Qua mã QR');
    expect(joinViaLabel(null)).toBe('');
  });
});

describe('joinRequestErrorMessage', () => {
  test('NOT_PENDING → câu về yêu cầu tham gia, không phải thanh toán', () => {
    expect(joinRequestErrorMessage(new Error('NOT_PENDING: Request is not pending'))).toBe(
      'Yêu cầu này đã được xử lý hoặc đã bị hủy.',
    );
  });

  test('mã khác dùng bản dịch chung', () => {
    expect(joinRequestErrorMessage(new Error('NOT_OWNER: x'))).toBe('Chỉ chủ nhóm mới thực hiện được thao tác này.');
  });
});

describe('canRemoveMember', () => {
  test('số dư 0, không có thanh toán chờ → được xóa', () => {
    expect(canRemoveMember(0, false)).toEqual({ allowed: true, reason: null });
  });

  test('còn nợ', () => {
    const r = canRemoveMember(-50000, false);
    expect(r.allowed).toBe(false);
    expect(r.reason?.startsWith('Còn nợ ')).toBe(true);
    expect(digits(r.reason)).toBe('50000');
  });

  test('còn được nhận', () => {
    const r = canRemoveMember(50000, true);
    expect(r.allowed).toBe(false);
    expect(r.reason?.startsWith('Còn được nhận ')).toBe(true);
    expect(digits(r.reason)).toBe('50000');
  });

  test('số dư 0 nhưng còn thanh toán chờ xác nhận', () => {
    expect(canRemoveMember(0, true)).toEqual({ allowed: false, reason: 'Còn thanh toán chờ xác nhận' });
  });

  test('chưa biết số dư → chưa cho xóa', () => {
    expect(canRemoveMember(undefined, false).allowed).toBe(false);
    expect(canRemoveMember(null, false).allowed).toBe(false);
    expect(canRemoveMember(Number.NaN, false).allowed).toBe(false);
  });

  test('-0 coi như 0', () => {
    expect(canRemoveMember(-0, false).allowed).toBe(true);
  });
});

describe('balanceLabel / hasPendingPayment', () => {
  test('nhãn số dư', () => {
    expect(balanceLabel(0)).toBe('Đã cân bằng');
    expect(balanceLabel(1000).startsWith('Được nhận ')).toBe(true);
    expect(balanceLabel(-1000).startsWith('Còn nợ ')).toBe(true);
    expect(balanceLabel(undefined)).toBe('');
  });

  test('chỉ thanh toán PENDING có người này', () => {
    const payments = [
      { from_id: 'a', to_id: 'b', status: 'CONFIRMED' },
      { from_id: 'c', to_id: 'b', status: 'PENDING' },
    ];
    expect(hasPendingPayment(payments, 'a')).toBe(false);
    expect(hasPendingPayment(payments, 'b')).toBe(true);
    expect(hasPendingPayment(payments, 'c')).toBe(true);
    expect(hasPendingPayment(undefined, 'a')).toBe(false);
  });
});
