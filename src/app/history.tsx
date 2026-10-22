import { useQuery } from '@tanstack/react-query';
import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useMemo, useState } from 'react';
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

import { fetchGroupActivities, fetchRecentActivities } from '@/api/activity';
import { fetchGroups } from '@/api/groups';
import { formatVND } from '@/domain/money';

// ============================
// Action type → Vietnamese label
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
  MEMBER_JOINED: 'đã tham gia nhóm',
  MEMBER_LEFT: 'đã rời nhóm',
  MEMBER_REMOVED: 'đã xóa thành viên',
  GROUP_UPDATED: 'đã cập nhật nhóm',
  INVITE_CREATED: 'đã tạo lời mời',
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
  MEMBER_JOINED: '👋',
  MEMBER_LEFT: '🚪',
  MEMBER_REMOVED: '🗑️',
  GROUP_UPDATED: '⚙️',
  INVITE_CREATED: '🔗',
};

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

  // Fetch groups for filter chips
  const groupsQ = useQuery({
    queryKey: ['groups'],
    queryFn: fetchGroups,
  });

  // Fetch activities — group-specific or all
  const activitiesQ = useQuery({
    queryKey: ['activities', selectedGroupId ?? 'all'],
    queryFn: () =>
      selectedGroupId
        ? fetchGroupActivities(selectedGroupId)
        : fetchRecentActivities(),
  });

  // Filter data if needed (already handled by query)
  const activities = activitiesQ.data ?? [];

  const handleTapActivity = (item: any) => {
    if (!item.entity_type || !item.entity_id) return;
    const groupId = item.group_id;
    switch (item.entity_type) {
      case 'expense':
        router.push(`/group/${groupId}/expense/${item.entity_id}` as any);
        break;
      case 'payment':
        // Navigate to group payments tab
        router.push(`/group/${groupId}` as any);
        break;
      case 'group':
        router.push(`/group/${groupId}` as any);
        break;
      case 'member':
        router.push(`/group/${groupId}/members` as any);
        break;
      default:
        router.push(`/group/${groupId}` as any);
        break;
    }
  };

  const getActorName = (item: any): string => {
    if (item.actor && typeof item.actor === 'object') {
      return (item.actor as any).display_name || 'Ai đó';
    }
    return 'Ai đó';
  };

  const getGroupName = (item: any): string => {
    if (item.group && typeof item.group === 'object') {
      return (item.group as any).name || '';
    }
    // Fallback: find from groupsQ
    if (groupsQ.data) {
      const g = groupsQ.data.find((g: any) => g.id === item.group_id);
      if (g) return g.name;
    }
    return '';
  };

  const getAmount = (item: any): number | null => {
    if (item.metadata && typeof item.metadata === 'object' && item.metadata.amount) {
      return Number(item.metadata.amount);
    }
    return null;
  };

  const renderItem = ({ item }: { item: any }) => {
    const actorName = getActorName(item);
    const actionLabel = ACTION_LABELS[item.action] || item.action;
    const icon = ACTION_ICONS[item.action] || '📝';
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
                {groupsQ.data.map((g: any) => (
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
