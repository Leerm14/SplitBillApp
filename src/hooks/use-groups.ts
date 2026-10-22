/**
 * REV-A1 / REV-S4: Danh sách nhóm của người đang đăng nhập — dùng chung cho Home, tab Nhóm, Lịch sử.
 *
 * - Key ['groups', 'list', userId]: giữ tiền tố 'groups' để mọi chỗ ghi invalidate ['groups'] vẫn làm mới,
 *   và gắn userId để kết quả của tài khoản này (hoặc [] lúc chưa đăng nhập) không bao giờ hiện cho tài khoản khác.
 * - enabled chỉ khi đã có user: không gọi ẩn danh sau khi đăng xuất rồi cache [] đó.
 */

import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';

import { fetchGroups, isWritableGroup, type GroupWithRole } from '@/api/groups';
import { useAuth } from '@/hooks/use-auth';

export function groupsListKey(userId: string | null | undefined) {
  return ['groups', 'list', userId ?? null] as const;
}

export function useGroupsList() {
  const { user } = useAuth();
  const userId = user?.id ?? null;
  const query = useQuery({
    queryKey: groupsListKey(userId),
    queryFn: () => fetchGroups(userId!),
    enabled: !!userId,
  });

  // REV-S4: nhóm đang hoạt động (mình ACTIVE + nhóm ACTIVE) và nhóm "Đã lưu trữ" (đã rời / bị xóa / đã đóng)
  const { activeGroups, archivedGroups } = useMemo(() => {
    const active: GroupWithRole[] = [];
    const archived: GroupWithRole[] = [];
    for (const g of query.data ?? []) (isWritableGroup(g) ? active : archived).push(g);
    return { activeGroups: active, archivedGroups: archived };
  }, [query.data]);

  return { ...query, userId, activeGroups, archivedGroups };
}
