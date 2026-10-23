/**
 * Realtime → query key cần làm mới. Thuần TypeScript để kiểm thử được.
 * Query key phải khớp các màn hình (group/[id], debts, pay, expense, payment, notifications, Home).
 * Mọi key bắt đầu bằng 'groups' (danh sách nhóm, số dư view group_balances, số dư Home) được làm mới
 * qua tiền tố ['groups'].
 */

export type QueryKey = readonly unknown[];

export type RealtimeRecord = Record<string, unknown>;

export type RealtimeChange =
  | { table: 'expenses' | 'payments' | 'group_members' | 'groups' | 'group_join_requests'; record: RealtimeRecord }
  | { table: 'notifications'; record: RealtimeRecord }
  /** Kênh vừa nối lại sau khi mất kết nối: có thể đã lỡ sự kiện → làm mới cả phạm vi */
  | { table: '*'; record: RealtimeRecord };

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

/** Mọi dữ liệu của một nhóm mà các màn hình đang đọc. */
export function groupScopeKeys(groupId: string): QueryKey[] {
  return [
    ['groups'],
    ['group', groupId],
    ['group-members', groupId],
    ['expenses', groupId],
    ['payments', groupId],
    ['activities'],
    // Migration 0014: yêu cầu tham gia đang chờ (chủ nhóm) và yêu cầu của chính mình
    ['join-requests', groupId],
    ['my-join-request', groupId],
  ];
}

/** Migration 0014: danh sách yêu cầu tham gia của nhóm (màn thành viên, huy hiệu ở màn nhóm). */
export function joinRequestsKey(groupId: string) {
  return ['join-requests', groupId] as const;
}

/** Migration 0014: yêu cầu tham gia của chính mình ở một nhóm (my_join_request). */
export function myJoinRequestKey(groupId: string) {
  return ['my-join-request', groupId] as const;
}

/** Thay đổi trên kênh của một nhóm. */
export function keysForGroupChange(groupId: string, change: RealtimeChange): QueryKey[] {
  const id = str(change.record.id);
  switch (change.table) {
    case 'expenses':
      return [['expenses', groupId], ...(id ? [['expense', id]] : []), ['groups'], ['activities']];
    case 'payments':
      return [['payments', groupId], ['payments'], ...(id ? [['payment', id]] : []), ['groups'], ['activities']];
    case 'group_members':
      return [['group-members', groupId], ['group', groupId], ['groups'], ['activities']];
    case 'groups':
      return [['group', groupId], ['groups']];
    case 'group_join_requests':
      // Duyệt xong thì group_members cũng đổi (có sự kiện riêng) — ở đây chỉ cần danh sách chờ
      return [[...joinRequestsKey(groupId)], [...myJoinRequestKey(groupId)]];
    default:
      return groupScopeKeys(groupId);
  }
}

/** Thông báo mới của chính mình → làm mới danh sách thông báo và đối tượng liên quan. */
export function keysForNotification(change: RealtimeChange): QueryKey[] {
  if (change.table === '*') {
    return [['notifications'], ['unread-count'], ['groups'], ['friends'], ['pendingRequests'], ['activities']];
  }
  const n = change.record;
  const keys: QueryKey[] = [['notifications'], ['unread-count']];
  const groupId = str(n.group_id);
  const expenseId = str(n.expense_id);
  const paymentId = str(n.payment_id);
  const type = str(n.type) ?? '';

  if (groupId) keys.push(...groupScopeKeys(groupId));
  if (expenseId) keys.push(['expense', expenseId]);
  if (paymentId) keys.push(['payment', paymentId], ['payments']);
  if (type.startsWith('FRIEND')) keys.push(['friends'], ['pendingRequests']);
  if (type === 'GROUP_INVITED' || type.startsWith('MEMBER_') || type.startsWith('OWNERSHIP_')) keys.push(['groups']);
  // Migration 0014: JOIN_REQUESTED (tới chủ nhóm), JOIN_APPROVED / JOIN_REJECTED (tới người xin)
  if (type.startsWith('JOIN_')) {
    keys.push(['groups']);
    if (groupId) keys.push([...joinRequestsKey(groupId)], [...myJoinRequestKey(groupId)]);
  }
  return dedupeKeys(keys);
}

export function dedupeKeys(keys: QueryKey[]): QueryKey[] {
  const seen = new Set<string>();
  return keys.filter((k) => {
    const s = JSON.stringify(k);
    if (seen.has(s)) return false;
    seen.add(s);
    return true;
  });
}
