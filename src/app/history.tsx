import { useQuery } from '@tanstack/react-query';
import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { fetchGroupActivities, fetchRecentActivities, type ActivityLog } from '@/api/activity';
import { toUserMessage } from '@/api/errors';
import { ErrorState } from '@/components/error-state';
import { formatVND } from '@/domain/money';
import { useAuth } from '@/hooks/use-auth';
import { useGroupsList } from '@/hooks/use-groups';


// ============================
// REV-S2: action / entity_type thật do RPC ghi vào activity_logs → nhãn tiếng Việt
// ============================
const ACTION_LABELS: Record<string, string> = {
  EXPENSE_CREATED: 'đã thêm khoản chi',
  EXPENSE_UPDATED: 'đã sửa khoản chi',
  EXPENSE_CANCELLED: 'đã hủy khoản chi',
  PAYMENT_CREATED: 'đã gửi thanh toán',
  PAYMENT_CONFIRMED: 'đã xác nhận thanh toán',
  PAYMENT_REJECTED: 'đã từ chối thanh toán',
  PAYMENT_DISPUTED: 'đã báo sai lệch thanh toán',
  PAYMENT_CANCELLED: 'đã hủy thanh toán',
  CREATE_GROUP: 'đã tạo nhóm',
  UPDATE_GROUP: 'đã cập nhật nhóm',
  TRANSFER_OWNERSHIP_GROUP: 'đã chuyển quyền chủ nhóm',
  CLOSE_GROUP: 'đã đóng nhóm',
  ROTATE_INVITE_CODE_GROUP: 'đã đổi mã mời',
  JOIN_MEMBER: 'đã tham gia nhóm',
  LEAVE_MEMBER: 'đã rời nhóm',
  REMOVE_MEMBER: 'đã xóa một thành viên',
  CREATE_INVITE: 'đã tạo lời mời',
  ACCEPT_INVITE: 'đã nhận lời mời vào nhóm',
  REVOKE_INVITE: 'đã thu hồi lời mời',
};

const ACTION_ICONS: Record<string, string> = {
  EXPENSE_CREATED: '🧾',
  EXPENSE_UPDATED: '✏️',
  EXPENSE_CANCELLED: '🚫',
  PAYMENT_CREATED: '💸',
  PAYMENT_CONFIRMED: '✅',
  PAYMENT_REJECTED: '❌',
  PAYMENT_DISPUTED: '⚠️',
  PAYMENT_CANCELLED: '🚫',
  CREATE_GROUP: '👥',
  UPDATE_GROUP: '⚙️',
  TRANSFER_OWNERSHIP_GROUP: '👑',
  CLOSE_GROUP: '🔒',
  ROTATE_INVITE_CODE_GROUP: '🔄',
  JOIN_MEMBER: '👋',
  LEAVE_MEMBER: '🚪',
  REMOVE_MEMBER: '🗑️',
  CREATE_INVITE: '🔗',
  ACCEPT_INVITE: '🤝',
  REVOKE_INVITE: '⛔',
};

/**
 * REV-S2: Khóa tra nhãn. Hành động EXPENSE_* / PAYMENT_* đã tự mang loại; hành động chung
 * (CREATE, UPDATE, JOIN…) ghép thêm entity_type viết HOA ('GROUP', 'MEMBER', 'INVITE').
 */
function activityKey(item: Pick<ActivityLog, 'action' | 'entity_type'>): string {
  const action = (item.action ?? '').toUpperCase();
  if (ACTION_LABELS[action]) return action;
  return `${action}_${(item.entity_type ?? '').toUpperCase()}`;
}

// ============================
// Relative time formatting
// ============================
function formatRelativeTime(dateStr: string): string {
  const now = new Date();
  const date = new Date(dateStr);
  const diffMs = now.getTime() - date.getTime();
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHour = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHour / 24);

  if (diffSec < 60) return 'vừa xong';
  if (diffMin < 60) return `${diffMin} phút trước`;
  if (diffHour < 24) {
    // Same day → show time
    const isToday = date.toDateString() === now.toDateString();
    if (isToday) {
      return `Hôm nay ${date.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })}`;
    }
    return `${diffHour} giờ trước`;
  }
  if (diffDay === 1) {
    return `Hôm qua ${date.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })}`;
  }
  if (diffDay < 7) {
    return `${diffDay} ngày trước`;
  }
  return date.toLocaleDateString('vi-VN', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  });
}

export default function HistoryScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ groupId?: string }>();
  const filterGroupId = params.groupId;
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(filterGroupId ?? null);

  // Nhóm cho bộ lọc — gồm cả nhóm "Đã lưu trữ" (REV-S5: người đã rời vẫn xem được lịch sử)
  const groupsQ = useGroupsList();
  const { user } = useAuth();

  // Fetch activities — group-specific or all (REV-A1: chỉ khi đã đăng nhập, key theo người dùng)
  const activitiesQ = useQuery({
    queryKey: ['activities', user?.id ?? null, selectedGroupId ?? 'all'],
    queryFn: () =>
      selectedGroupId
        ? fetchGroupActivities(selectedGroupId)
        : fetchRecentActivities(),
    enabled: !!user,
  });

  // Filter data if needed (already handled by query)
  const activities = activitiesQ.data ?? [];

  // REV-S2: điều hướng theo entity_type viết HOA của activity_logs
  const handleTapActivity = (item: ActivityLog) => {
    const groupId = item.group_id;
    const entityType = (item.entity_type ?? '').toUpperCase();
    if (entityType === 'EXPENSE' && item.entity_id) {
      router.push(`/group/${groupId}/expense/${item.entity_id}` as any);
    } else if (entityType === 'PAYMENT' && item.entity_id) {
      router.push(`/payment/${item.entity_id}` as any);
    } else {
      router.push(`/group/${groupId}` as any);
    }
  };

  const getActorName = (item: ActivityLog): string => item.actor?.display_name || 'Ai đó';

  const getGroupName = (item: ActivityLog): string => {
    if (item.group?.name) return item.group.name;
    // Fallback: find from groupsQ
    if (groupsQ.data) {
      const g = groupsQ.data.find((grp) => grp.id === item.group_id);
      if (g) return g.name;
    }
    return '';
  };

  // REV-S2: số tiền nằm trong after.amount (bigint có thể là chuỗi)
  const getAmount = (item: ActivityLog): number | null => {
    const raw = item.after?.amount;
    if (raw == null || raw === '') return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  };

  const renderItem = ({ item }: { item: ActivityLog }) => {
    const actorName = getActorName(item);
    const key = activityKey(item);
    const actionLabel = ACTION_LABELS[key] || item.action;
    const icon = ACTION_ICONS[key] || '📝';
    const groupName = getGroupName(item);
    const amount = getAmount(item);
    const timeStr = formatRelativeTime(item.created_at);

    return (
      <Pressable style={styles.activityCard} onPress={() => handleTapActivity(item)}>
        <View style={styles.activityIconContainer}>
          <Text style={styles.activityIcon}>{icon}</Text>
        </View>
        <View style={styles.activityContent}>
          <Text style={styles.activityText} numberOfLines={2}>
            <Text style={styles.actorName}>{actorName}</Text>
            {' '}{actionLabel}
            {amount !== null && (
              <Text style={styles.activityAmount}> {formatVND(amount)}</Text>
            )}
          </Text>
          <View style={styles.activityMeta}>
            {groupName ? (
              <Text style={styles.groupTag}>{groupName}</Text>
            ) : null}
            <Text style={styles.timeText}>{timeStr}</Text>
          </View>
        </View>
      </Pressable>
    );
  };

  if (activitiesQ.isLoading) {
    return (
      <SafeAreaView style={styles.container} edges={['bottom']}>
        <View style={styles.center}>
          <ActivityIndicator size="large" color="#007AFF" />
        </View>
      </SafeAreaView>
    );
  }

  // APP-19: lỗi tải lịch sử — không hiện như "Chưa có hoạt động nào"
  if (activitiesQ.error) {
    return (
      <SafeAreaView style={styles.container} edges={['bottom']}>
        <ErrorState
          title="Không thể tải lịch sử"
          message={toUserMessage(activitiesQ.error, 'Đã xảy ra lỗi')}
          onRetry={() => activitiesQ.refetch()}
        />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container} edges={['bottom']}>
      <FlatList
        data={activities}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.list}
        refreshControl={
          <RefreshControl
            refreshing={activitiesQ.isRefetching}
            onRefresh={() => { activitiesQ.refetch(); }}
          />
        }
        ListHeaderComponent={
          <View style={styles.header}>
            <Text style={styles.headerTitle}>📋 Lịch sử hoạt động</Text>

            {/* Group filter chips */}
            {groupsQ.data && groupsQ.data.length > 0 && (
              <View style={styles.filterContainer}>
                <Pressable
                  style={[styles.filterChip, !selectedGroupId && styles.filterChipActive]}
                  onPress={() => setSelectedGroupId(null)}
                >
                  <Text style={[styles.filterChipText, !selectedGroupId && styles.filterChipTextActive]}>
                    Tất cả
                  </Text>
                </Pressable>
                {groupsQ.data.map((g) => (
                  <Pressable
                    key={g.id}
                    style={[styles.filterChip, selectedGroupId === g.id && styles.filterChipActive]}
                    onPress={() => setSelectedGroupId(selectedGroupId === g.id ? null : g.id)}
                  >
                    <Text style={[styles.filterChipText, selectedGroupId === g.id && styles.filterChipTextActive]}>
                      {g.name}
                    </Text>
                  </Pressable>
                ))}
              </View>
            )}
          </View>
        }
        ListEmptyComponent={
          <View style={styles.emptyState}>
            <Text style={styles.emptyIcon}>📭</Text>
            <Text style={styles.emptyText}>Chưa có hoạt động nào</Text>
            <Text style={styles.emptyHint}>
              Hoạt động sẽ xuất hiện khi bạn hoặc thành viên nhóm thêm chi phí, thanh toán, v.v.
            </Text>
          </View>
        }
        renderItem={renderItem}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f2f2f7' },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  list: { padding: 16, gap: 8 },

  // Header
  header: { marginBottom: 8 },
  headerTitle: { fontSize: 22, fontWeight: '700', color: '#1a1a1a' },

  // Filter chips
  filterContainer: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 12,
  },
  filterChip: {
    backgroundColor: '#e5e5ea',
    borderRadius: 16,
    paddingHorizontal: 14,
    paddingVertical: 7,
  },
  filterChipActive: {
    backgroundColor: '#007AFF',
  },
  filterChipText: {
    fontSize: 13,
    fontWeight: '500',
    color: '#666',
  },
  filterChipTextActive: {
    color: '#fff',
  },

  // Activity card
  activityCard: {
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 14,
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.04,
    shadowRadius: 3,
    elevation: 1,
  },
  activityIconContainer: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: '#f2f2f7',
    justifyContent: 'center',
    alignItems: 'center',
  },
  activityIcon: {
    fontSize: 18,
  },
  activityContent: {
    flex: 1,
    gap: 4,
  },
  activityText: {
    fontSize: 14,
    color: '#1a1a1a',
    lineHeight: 20,
  },
  actorName: {
    fontWeight: '600',
    color: '#1a1a1a',
  },
  activityAmount: {
    fontWeight: '600',
    color: '#007AFF',
  },
  activityMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 2,
  },
  groupTag: {
    fontSize: 12,
    color: '#007AFF',
    backgroundColor: '#E8F0FE',
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 6,
    overflow: 'hidden',
    fontWeight: '500',
  },
  timeText: {
    fontSize: 12,
    color: '#8E8E93',
  },

  // Empty state
  emptyState: {
    alignItems: 'center',
    paddingTop: 60,
  },
  emptyIcon: {
    fontSize: 48,
    marginBottom: 12,
  },
  emptyText: {
    fontSize: 16,
    color: '#666',
    fontWeight: '500',
  },
  emptyHint: {
    fontSize: 14,
    color: '#999',
    marginTop: 4,
    textAlign: 'center',
    paddingHorizontal: 32,
  },
});
