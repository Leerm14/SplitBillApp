import { dedupeKeys, groupScopeKeys, keysForGroupChange, keysForNotification } from './realtime-keys';

const G = 'g-1';
const has = (keys: readonly unknown[][] | unknown[], key: unknown[]) =>
  (keys as unknown[][]).some((k) => JSON.stringify(k) === JSON.stringify(key));

describe('keysForGroupChange', () => {
  test('khoản chi → danh sách khoản chi, chi tiết khoản chi, số dư (tiền tố groups)', () => {
    const keys = keysForGroupChange(G, { table: 'expenses', record: { id: 'e-1', group_id: G } });
    expect(has(keys, ['expenses', G])).toBe(true);
    expect(has(keys, ['expense', 'e-1'])).toBe(true);
    expect(has(keys, ['groups'])).toBe(true);
  });

  test('thanh toán → danh sách, chi tiết thanh toán, số dư', () => {
    const keys = keysForGroupChange(G, { table: 'payments', record: { id: 'p-1', group_id: G } });
    expect(has(keys, ['payments', G])).toBe(true);
    expect(has(keys, ['payment', 'p-1'])).toBe(true);
    expect(has(keys, ['groups'])).toBe(true);
  });

  test('thành viên → danh sách thành viên và thông tin nhóm', () => {
    const keys = keysForGroupChange(G, { table: 'group_members', record: { group_id: G } });
    expect(has(keys, ['group-members', G])).toBe(true);
    expect(has(keys, ['group', G])).toBe(true);
  });

  test('sửa nhóm → thông tin nhóm', () => {
    const keys = keysForGroupChange(G, { table: 'groups', record: { id: G } });
    expect(keys).toEqual([['group', G], ['groups']]);
  });

  test('nối lại kênh → làm mới cả phạm vi nhóm', () => {
    expect(keysForGroupChange(G, { table: '*', record: {} })).toEqual(groupScopeKeys(G));
  });

  test('yêu cầu tham gia (0014) → danh sách yêu cầu chờ duyệt của nhóm', () => {
    const keys = keysForGroupChange(G, { table: 'group_join_requests', record: { id: 'r-1', group_id: G } });
    expect(has(keys, ['join-requests', G])).toBe(true);
    expect(has(keys, ['my-join-request', G])).toBe(true);
  });

  test('phạm vi nhóm gồm cả yêu cầu tham gia', () => {
    expect(has(groupScopeKeys(G), ['join-requests', G])).toBe(true);
  });
});

describe('keysForNotification', () => {
  test('thông báo khoản chi → thông báo, số chưa đọc, nhóm, khoản chi', () => {
    const keys = keysForNotification({
      table: 'notifications',
      record: { type: 'EXPENSE_CREATED', group_id: G, expense_id: 'e-1' },
    });
    expect(has(keys, ['notifications'])).toBe(true);
    expect(has(keys, ['unread-count'])).toBe(true);
    expect(has(keys, ['expenses', G])).toBe(true);
    expect(has(keys, ['expense', 'e-1'])).toBe(true);
  });

  test('thông báo thanh toán → chi tiết thanh toán', () => {
    const keys = keysForNotification({
      table: 'notifications',
      record: { type: 'PAYMENT_CONFIRMED', group_id: G, payment_id: 'p-1' },
    });
    expect(has(keys, ['payment', 'p-1'])).toBe(true);
    expect(has(keys, ['payments', G])).toBe(true);
  });

  test('lời mời kết bạn → danh sách bạn và lời mời đang chờ', () => {
    const keys = keysForNotification({ table: 'notifications', record: { type: 'FRIEND_REQUEST' } });
    expect(has(keys, ['friends'])).toBe(true);
    expect(has(keys, ['pendingRequests'])).toBe(true);
  });

  test('JOIN_REQUESTED (tới chủ nhóm) → yêu cầu chờ duyệt, danh sách nhóm, phạm vi nhóm', () => {
    const keys = keysForNotification({ table: 'notifications', record: { type: 'JOIN_REQUESTED', group_id: G, actor_id: 'u-2' } });
    expect(has(keys, ['join-requests', G])).toBe(true);
    expect(has(keys, ['groups'])).toBe(true);
    expect(has(keys, ['group-members', G])).toBe(true);
    expect(keys).toEqual(dedupeKeys(keys));
  });

  test('JOIN_APPROVED / JOIN_REJECTED (tới người xin) → nhóm và yêu cầu của mình', () => {
    for (const type of ['JOIN_APPROVED', 'JOIN_REJECTED']) {
      const keys = keysForNotification({ table: 'notifications', record: { type, group_id: G } });
      expect(has(keys, ['groups'])).toBe(true);
      expect(has(keys, ['my-join-request', G])).toBe(true);
      expect(has(keys, ['join-requests', G])).toBe(true);
    }
  });

  test('không lặp key', () => {
    const keys = keysForNotification({ table: 'notifications', record: { type: 'MEMBER_JOINED', group_id: G } });
    expect(keys).toEqual(dedupeKeys(keys));
  });

  test('bỏ qua giá trị không phải chuỗi', () => {
    const keys = keysForNotification({ table: 'notifications', record: { type: 'X', group_id: null, expense_id: 5 } });
    expect(keys).toEqual([['notifications'], ['unread-count']]);
  });
});
