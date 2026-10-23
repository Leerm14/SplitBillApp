import { describeNotification } from './notification-text';

describe('describeNotification', () => {
  test('khoản chi mới: ai thêm, tên khoản, số tiền', () => {
    const t = describeNotification({
      type: 'EXPENSE_CREATED',
      actorName: 'Bình',
      expense: { description: 'Cà phê sáng', amount: '90000' },
    });
    expect(t.title).toBe('Khoản chi mới');
    expect(t.body).toBe('Bình đã thêm "Cà phê sáng" · 90.000đ');
  });

  test('thông báo cũ chưa có actor → lấy người tạo khoản chi', () => {
    const t = describeNotification({
      type: 'EXPENSE_CREATED',
      expense: { description: 'Lẩu', amount: 800000, creatorName: 'Bình' },
    });
    expect(t.body).toBe('Bình đã thêm "Lẩu" · 800.000đ');
  });

  test('thanh toán chờ xác nhận: lấy người gửi khi thiếu actor', () => {
    const t = describeNotification({ type: 'PAYMENT_CREATED', payment: { amount: 150000, senderName: 'Dũng' } });
    expect(t.title).toBe('Cần bạn xác nhận');
    expect(t.body).toBe('Dũng báo đã chuyển cho bạn 150.000đ');
  });

  test('xác nhận thanh toán: người nhận', () => {
    const t = describeNotification({ type: 'PAYMENT_CONFIRMED', payment: { amount: 150000, receiverName: 'An' } });
    expect(t.body).toBe('An đã xác nhận nhận 150.000đ');
  });

  test('các loại trước đây hiện "Thông báo" giờ có nhãn riêng', () => {
    for (const type of ['MEMBER_LEFT', 'OWNERSHIP_RECEIVED', 'OWNERSHIP_TRANSFERRED', 'FRIEND_REQUEST', 'FRIEND_ACCEPTED', 'FRIEND_DECLINED']) {
      expect(describeNotification({ type, actorName: 'An' }).title).not.toBe('Thông báo');
    }
  });

  test('kết bạn và rời nhóm ghi tên người', () => {
    expect(describeNotification({ type: 'FRIEND_REQUEST', actorName: 'Dũng' }).body).toBe('Dũng muốn kết bạn với bạn');
    expect(describeNotification({ type: 'MEMBER_LEFT', actorName: 'Cường' }).body).toBe('Cường đã rời nhóm');
  });

  test('không rõ người thực hiện → "Một thành viên"', () => {
    expect(describeNotification({ type: 'MEMBER_JOINED' }).body).toBe('Một thành viên đã tham gia nhóm');
  });

  test('loại lạ → mặc định', () => {
    expect(describeNotification({ type: 'XYZ' })).toEqual({ icon: '🔔', title: 'Thông báo', body: null });
  });
});
