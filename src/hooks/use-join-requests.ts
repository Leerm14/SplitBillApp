/**
 * Migration 0014: yêu cầu tham gia nhóm đang chờ chủ nhóm duyệt.
 * list_join_requests chỉ cho chủ nhóm → chỉ bật khi người xem là chủ nhóm.
 * Realtime (bảng group_join_requests trên kênh nhóm, thông báo JOIN_*) làm mới key này.
 */

import { useQuery } from '@tanstack/react-query';

import { fetchJoinRequests } from '@/api/groups';
import { useAuth } from '@/hooks/use-auth';
import { joinRequestsKey } from '@/lib/realtime-keys';

export function useJoinRequests(groupId: string | null | undefined, isOwner: boolean) {
  const { user } = useAuth();
  return useQuery({
    queryKey: joinRequestsKey(groupId ?? ''),
    queryFn: () => fetchJoinRequests(groupId!),
    enabled: !!groupId && !!user && isOwner,
  });
}
