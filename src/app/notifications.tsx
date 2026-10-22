import React, { useCallback, useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  SectionList,
  RefreshControl,
  ActivityIndicator,
  SafeAreaView,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';

import { useAuth } from '@/hooks/use-auth';
import {
  fetchNotifications,
  markAsRead,
  markAllAsRead,
  fetchUnreadCount,
  type NotificationItem,
} from '@/api/notifications';

// ============================
// Type → Display mapping
// ============================
const NOTIFICATION_MAP: Record<string, { icon: string; title: string }> = {
  EXPENSE_CREATED: { icon: '🧾', title: 'Khoản chi mới' },
  EXPENSE_UPDATED: { icon: '✏️', title: 'Khoản chi đã sửa' },
  EXPENSE_CANCELLED: { icon: '❌', title: 'Khoản chi đã hủy' },
  PAYMENT_CREATED: { icon: '💳', title: 'Yêu cầu thanh toán' },
  PAYMENT_CONFIRMED: { icon: '✅', title: 'Thanh toán đã xác nhận' },
  PAYMENT_REJECTED: { icon: '❌', title: 'Thanh toán bị từ chối' },
  PAYMENT_DISPUTED: { icon: '⚠️', title: 'Thanh toán bị báo sai lệch' },
  PAYMENT_CANCELLED: { icon: '🚫', title: 'Thanh toán đã hủy' },
  MEMBER_JOINED: { icon: '👋', title: 'Thành viên mới' },
  MEMBER_REMOVED: { icon: '👤', title: 'Thành viên bị xóa' },
  INVITE_CREATED: { icon: '🔗', title: 'Lời mời tham gia nhóm' },
  INVITE_ACCEPTED: { icon: '✅', title: 'Lời mời đã chấp nhận' },
  GROUP_UPDATED: { icon: '⚙️', title: 'Nhóm đã cập nhật' },
  SUGGESTION_CHANGED: { icon: '💡', title: 'Gợi ý tất toán thay đổi' },
};

const DEFAULT_DISPLAY = { icon: '🔔', title: 'Thông báo' };

function getNotificationDisplay(type: string) {
  return NOTIFICATION_MAP[type] ?? DEFAULT_DISPLAY;
}

// ============================
// Date grouping helpers
// ============================
function getDateGroup(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const weekAgo = new Date(today);
  weekAgo.setDate(weekAgo.getDate() - 7);

  if (date >= today) return 'Hôm nay';
  if (date >= yesterday) return 'Hôm qua';
  if (date >= weekAgo) return 'Tuần này';
  return 'Trước đó';
}

function getRelativeTime(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  const diffHour = Math.floor(diffMs / 3600000);
  const diffDay = Math.floor(diffMs / 86400000);

  if (diffMin < 1) return 'Vừa xong';
  if (diffMin < 60) return `${diffMin} phút trước`;
  if (diffHour < 24) return `${diffHour} giờ trước`;
  if (diffDay < 7) return `${diffDay} ngày trước`;
  return date.toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit' });
}

// ============================
// Main component
// ============================
export default function NotificationsScreen() {
  const router = useRouter();
  const queryClient = useQueryClient();

  // REV-A1: chỉ tải khi đã đăng nhập (không cache kết quả ẩn danh)
  const { user } = useAuth();

  const { data: notifications, isLoading, isError, error, refetch, isRefetching } = useQuery({
    queryKey: ['notifications'],
    queryFn: () => fetchNotifications(),
    enabled: !!user,
  });

  const { data: unreadCount } = useQuery({
    queryKey: ['unread-count'],
    queryFn: fetchUnreadCount,
    enabled: !!user,
  });

  const markReadMutation = useMutation({
    mutationFn: markAsRead,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['notifications'] });
      queryClient.invalidateQueries({ queryKey: ['unread-count'] });
    },
  });

  const markAllReadMutation = useMutation({
    mutationFn: markAllAsRead,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['notifications'] });
      queryClient.invalidateQueries({ queryKey: ['unread-count'] });
    },
  });

  const sections = useMemo(() => {
    if (!notifications) return [];
    const groups: Record<string, NotificationItem[]> = {};
    const order = ['Hôm nay', 'Hôm qua', 'Tuần này', 'Trước đó'];

    for (const n of notifications) {
      const group = getDateGroup(n.created_at);
      if (!groups[group]) groups[group] = [];
      groups[group].push(n);
    }

    return order
      .filter((key) => groups[key]?.length)
      .map((key) => ({ title: key, data: groups[key] }));
  }, [notifications]);

  const handlePress = useCallback(
    (item: NotificationItem) => {
      if (!item.read_at) {
        markReadMutation.mutate(item.id);
      }
      if (item.expense_id && item.group_id) {
        router.push(`/group/${item.group_id}/expense/${item.expense_id}` as any);
      } else if (item.payment_id) {
        router.push(`/payment/${item.payment_id}` as any);
      } else if (item.group_id) {
        router.push(`/group/${item.group_id}` as any);
      }
    },
    [markReadMutation, router],
  );

  const renderItem = useCallback(
    ({ item }: { item: NotificationItem }) => {
      const display = getNotificationDisplay(item.type);
      const isUnread = item.read_at === null;

      return (
        <TouchableOpacity
          style={styles.notificationCard}
          activeOpacity={0.7}
          onPress={() => handlePress(item)}
        >
          {/* Unread indicator */}
          <View style={styles.unreadColumn}>
            {isUnread && <View style={styles.unreadDot} />}
          </View>

          {/* Icon */}
          <View style={styles.iconContainer}>
            <Text style={styles.iconText}>{display.icon}</Text>
          </View>

          {/* Content */}
          <View style={styles.contentContainer}>
            <Text
              style={[styles.notificationTitle, isUnread && styles.unreadTitle]}
              numberOfLines={1}
            >
              {display.title}
            </Text>

            {item.group?.name && (
              <View style={styles.groupTag}>
                <Text style={styles.groupTagText} numberOfLines={1}>
                  {item.group.name}
                </Text>
              </View>
            )}

            <Text style={styles.timestamp}>
              {getRelativeTime(item.created_at)}
            </Text>
          </View>
        </TouchableOpacity>
      );
    },
    [handlePress],
  );

  const renderSectionHeader = useCallback(
    ({ section }: { section: { title: string } }) => (
      <View style={styles.sectionHeader}>
        <Text style={styles.sectionHeaderText}>{section.title}</Text>
      </View>
    ),
    [],
  );

  if (isLoading) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.centered}>
          <ActivityIndicator size="large" color="#007AFF" />
        </View>
      </SafeAreaView>
    );
  }

  // APP-19: Hiển thị lỗi thay vì dữ liệu trống
  if (isError) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.centered}>
          <Text style={{ fontSize: 16, color: '#FF3B30', textAlign: 'center', marginBottom: 12 }}>
            ⚠️ Không thể tải thông báo
          </Text>
          <Text style={{ fontSize: 14, color: '#8E8E93', textAlign: 'center', marginBottom: 16 }}>
            {(error as Error)?.message || 'Đã xảy ra lỗi'}
          </Text>
          <TouchableOpacity
            style={{ backgroundColor: '#007AFF', paddingHorizontal: 24, paddingVertical: 12, borderRadius: 10 }}
            onPress={() => refetch()}
          >
            <Text style={{ color: '#fff', fontWeight: '600' }}>Thử lại</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backButton}>
          <Text style={{ fontSize: 22, color: '#007AFF' }}>←</Text>
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Thông báo</Text>
        {(unreadCount ?? 0) > 0 ? (
          <TouchableOpacity
            onPress={() => markAllReadMutation.mutate()}
            disabled={markAllReadMutation.isPending}
            style={styles.markAllButton}
          >
            <Text style={styles.markAllText}>
              {markAllReadMutation.isPending ? 'Đang xử lý...' : 'Đã đọc tất cả'}
            </Text>
          </TouchableOpacity>
        ) : (
          <View style={styles.markAllButton} />
        )}
      </View>

      {/* List */}
      {sections.length === 0 ? (
        <View style={styles.centered}>
          <Text style={styles.emptyIcon}>🔔</Text>
          <Text style={styles.emptyTitle}>Không có thông báo</Text>
          <Text style={styles.emptySubtitle}>
            Bạn sẽ nhận thông báo khi có hoạt động mới trong các nhóm.
          </Text>
        </View>
      ) : (
        <SectionList
          sections={sections}
          keyExtractor={(item) => item.id}
          renderItem={renderItem}
          renderSectionHeader={renderSectionHeader}
          refreshControl={
            <RefreshControl refreshing={isRefetching} onRefresh={() => { refetch(); }} />
          }
          contentContainerStyle={styles.listContent}
          stickySectionHeadersEnabled={false}
        />
      )}
    </SafeAreaView>
  );
}

// ============================
// Styles
// ============================
const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f2f2f7',
  },
  centered: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 32,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: '#fff',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#e0e0e0',
  },
  backButton: {
    width: 80,
  },
  headerTitle: {
    fontSize: 17,
    fontWeight: '600',
    color: '#000',
  },
  markAllButton: {
    width: 80,
    alignItems: 'flex-end',
  },
  markAllText: {
    fontSize: 13,
    color: '#007AFF',
    fontWeight: '500',
  },
  listContent: {
    paddingBottom: 32,
  },
  sectionHeader: {
    paddingHorizontal: 16,
    paddingTop: 20,
    paddingBottom: 8,
  },
  sectionHeaderText: {
    fontSize: 13,
    fontWeight: '600',
    color: '#8e8e93',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  notificationCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#fff',
    marginHorizontal: 16,
    marginBottom: 1,
    paddingVertical: 14,
    paddingRight: 16,
    borderRadius: 12,
    marginTop: 1,
  },
  unreadColumn: {
    width: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  unreadDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#007AFF',
  },
  iconContainer: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: '#f2f2f7',
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 12,
  },
  iconText: {
    fontSize: 20,
  },
  contentContainer: {
    flex: 1,
  },
  notificationTitle: {
    fontSize: 15,
    color: '#333',
    fontWeight: '400',
  },
  unreadTitle: {
    fontWeight: '600',
    color: '#000',
  },
  groupTag: {
    backgroundColor: '#e8f0fe',
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 6,
    alignSelf: 'flex-start',
    marginTop: 4,
  },
  groupTagText: {
    fontSize: 12,
    color: '#1a73e8',
    fontWeight: '500',
  },
  timestamp: {
    fontSize: 12,
    color: '#8e8e93',
    marginTop: 4,
  },
  emptyIcon: {
    fontSize: 48,
    marginBottom: 16,
  },
  emptyTitle: {
    fontSize: 18,
    fontWeight: '600',
    color: '#333',
    marginBottom: 8,
  },
  emptySubtitle: {
    fontSize: 14,
    color: '#8e8e93',
    textAlign: 'center',
    lineHeight: 20,
  },
});
