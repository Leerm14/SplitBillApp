import {
  ApiError,
  getServerErrorCode,
  isBusinessError,
  isRetryableError,
  isVersionConflict,
  toUserMessage,
} from './errors';

describe('APP-03: mã lỗi server dạng "CODE: message"', () => {
  test('Đọc đúng mã, phân biệt hoa thường', () => {
    expect(getServerErrorCode(new Error('GROUP_CLOSED: Group is closed.'))).toBe('GROUP_CLOSED');
    expect(getServerErrorCode(new Error('NOT_MEMBER: You are not an active member.'))).toBe('NOT_MEMBER');
    expect(getServerErrorCode(new Error('group_closed: lower case'))).toBeNull();
    expect(getServerErrorCode(new Error('Group is CLOSED'))).toBeNull();
    expect(getServerErrorCode(null)).toBeNull();
  });

  test('Lỗi nghiệp vụ không thử lại; NOT_AUTHENTICATED thử lại', () => {
    expect(isBusinessError(new Error('SHARE_MISMATCH: Total shares (1) does not equal expense amount (2)'))).toBe(true);
    expect(isRetryableError(new Error('NOT_AUTHENTICATED: You must be logged in.'))).toBe(true);
    expect(isBusinessError(new Error('NOT_AUTHENTICATED: You must be logged in.'))).toBe(false);
  });

  test('Thông báo tiếng Việt theo mã', () => {
    expect(toUserMessage(new Error('NOT_PENDING: Payment is not in PENDING status'))).toBe(
      'Thanh toán không còn ở trạng thái chờ xác nhận.',
    );
    expect(toUserMessage(new Error('SOME_NEW_CODE: Something'), 'x')).toBe('Something');
    expect(toUserMessage({}, 'Mặc định')).toBe('Mặc định');
  });
});

describe('APP-05: xung đột phiên bản', () => {
  test('Theo mã PT409 hoặc tiền tố VERSION_CONFLICT', () => {
    expect(isVersionConflict(new ApiError('whatever', { code: 'PT409' }))).toBe(true);
    expect(isVersionConflict(new ApiError('VERSION_CONFLICT: Expense was modified concurrently.', { code: 'P0001' }))).toBe(true);
    expect(isVersionConflict(new Error('version conflict'))).toBe(false);
    expect(isVersionConflict(new Error('NOT_MEMBER: x'))).toBe(false);
  });
});

describe('Migration 0014: duyệt thành viên mới', () => {
  test('JOIN_APPROVAL_REQUIRED có câu tiếng Việt', () => {
    expect(toUserMessage(new Error('JOIN_APPROVAL_REQUIRED: This group requires owner approval'))).toBe(
      'Nhóm này cần chủ nhóm duyệt thành viên mới. Vui lòng cập nhật ứng dụng rồi thử lại.',
    );
    expect(isBusinessError(new Error('JOIN_APPROVAL_REQUIRED: x'))).toBe(true);
  });
});
