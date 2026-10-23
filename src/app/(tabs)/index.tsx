import { useQueries, useQuery } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import React, { useCallback, useMemo, useState } from 'react';
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

import { toUserMessage } from '@/api/errors';
import { fetchExpenses } from '@/api/expenses';
import { fetchMyGroupBalances, type GroupWithRole } from '@/api/groups';
import { fetchPayments } from '@/api/payments';
import { ErrorState } from '@/components/error-state';
import { formatVND } from '@/domain/money';
import { DEFAULT_TIME_FILTER, isWithinFilter, TIME_FILTERS, type TimeFilter } from '@/domain/time-filter';
import { useAuth } from '@/hooks/use-auth';
import { useGroupsList } from '@/hooks/use-groups';
import { Colors, Spacing, Radii, FontSizes, FontWeights, Shadows } from '@/lib/theme';

/** Format a date string as relative Vietnamese text */
function formatRelativeDate(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const target = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const diffDays = Math.round((today.getTime() - target.getTime()) / (1000 * 60 * 60 * 24));
  if (diffDays === 0) return 'Hôm nay';
  if (diffDays === 1) return 'Hôm qua';
  return `${date.getDate().toString().padStart(2, '0')}/${(date.getMonth() + 1).toString().padStart(2, '0')}/${date.getFullYear()}`;
}

type RecentTransaction = {
  id: string;
  type: 'expense' | 'payment';
  description: string;
  amount: number;
  groupId: string;
  groupName: string;
  date: string;
};

function getTimeOfDayGreeting(): string {
  const hour = new Date().getHours();
  if (hour < 12) return 'Chào buổi sáng';
  if (hour < 18) return 'Chào buổi chiều';
  return 'Chào buổi tối';
}

export default function HomeScreen() {
  const { user } = useAuth();
  const router = useRouter();

  // REV-A1 / REV-S4: danh sách theo người dùng; Home chỉ hiện nhóm đang hoạt động (mình ACTIVE, nhóm ACTIVE)
  const {
    data: allGroups,
    activeGroups: groups,
    isLoading,
    refetch,
    isRefetching,
    error: groupsError,
  } = useGroupsList();
  const myId = user?.id ?? null;

  // MVP-09: bộ lọc thời gian cho "Giao dịch gần đây" (HOME-01). Mặc định "Tất cả" để không giao dịch
  // nào bị ẩn mà người dùng không biết; tổng cần thu / cần trả không đổi theo bộ lọc (BR-10).
  const [timeFilter, setTimeFilter] = useState<TimeFilter>(DEFAULT_TIME_FILTER);

  // REV-S7: đăng ký theo dõi khoản chi / thanh toán của từng nhóm (useQueries) — danh sách
  // "Giao dịch gần đây" và huy hiệu chờ xác nhận tự cập nhật khi cache đổi (không đọc getQueryData).
  const expensesQs = useQueries({
    queries: groups.map((g) => ({
      queryKey: ['expenses', g.id],
      queryFn: () => fetchExpenses(g.id),
      staleTime: 60_000,
      enabled: !!myId,
    })),
  });
  const paymentsQs = useQueries({
    queries: groups.map((g) => ({
      queryKey: ['payments', g.id],
      queryFn: () => fetchPayments(g.id),
      staleTime: 60_000,
      enabled: !!myId,
    })),
  });

  // APP-04: Fetch all balances from group_balances view for all groups at once.
  // Key bắt đầu bằng 'groups' để các chỗ invalidate ['groups'] sau khi ghi cũng làm mới số dư.
  const { data: allBalances, error: balancesError, refetch: refetchBalances } = useQuery({
    queryKey: ['groups', 'my-balances', user?.id],
    queryFn: () => fetchMyGroupBalances(user!.id),
    enabled: !!user,
  });

  // APP-04: Số dư từng nhóm lấy từ view group_balances (không tự tính từ cache + try/catch)
  const balanceByGroup = useMemo(() => {
    const map = new Map<string, number>();
    for (const b of allBalances ?? []) map.set(b.groupId, b.officialBalance);
    return map;
  }, [allBalances]);

  /** Compute summary totals from group_balances view */
  const summaryTotals = useMemo(() => {
    if (!groups || groups.length === 0 || !allBalances) return null;
    let totalOwed = 0;
    let totalCollect = 0;

    for (const b of allBalances) {
      const bal = b.officialBalance;
      if (bal < 0) totalOwed += bal;
      if (bal > 0) totalCollect += bal;
    }

    return allBalances.length > 0 ? { totalOwed, totalCollect } : null;
  }, [groups, allBalances]);

  /** Tên hiển thị từ quan hệ PostgREST (object hoặc mảng) */
  const displayName = (v: unknown): string | null => {
    const one = Array.isArray(v) ? v[0] : v;
    return (one as { display_name?: string } | null)?.display_name ?? null;
  };

  /** REV-S7: Giao dịch gần đây từ các query đang theo dõi (tự cập nhật khi cache đổi) */
  const allTransactions: RecentTransaction[] = (() => {
    const items: RecentTransaction[] = [];
    groups.forEach((g, i) => {
      for (const e of expensesQs[i]?.data ?? []) {
        items.push({
          id: e.id,
          type: 'expense',
          description: e.description || 'Chi phí',
          amount: Number(e.amount),
          groupId: g.id,
          groupName: g.name,
          date: e.created_at,
        });
      }
      for (const p of paymentsQs[i]?.data ?? []) {
        items.push({
          id: p.id,
          type: 'payment',
          description: `${displayName(p.sender) ?? 'Ai đó'} → ${displayName(p.receiver) ?? 'Ai đó'}`,
          amount: Number(p.amount),
          groupId: g.id,
          groupName: g.name,
          date: p.created_at,
        });
      }
    });
    items.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
    return items;
  })();

  // MVP-09: lọc theo thời gian (chỉ danh sách; tổng cần thu / cần trả giữ nguyên — BR-10)
  const now = new Date();
  const recentTransactions = allTransactions.filter((tx) => isWithinFilter(tx.date, timeFilter, now)).slice(0, 50);

  /** REV-S7: Huy hiệu chỉ đếm thanh toán PENDING mình cần xác nhận (người nhận) hoặc mình đã gửi */
  const pendingCountByGroup: Record<string, number> = {};
  groups.forEach((g, i) => {
    const payments = paymentsQs[i]?.data;
    if (!payments || !myId) return;
    pendingCountByGroup[g.id] = payments.filter(
      (p) => p.status === 'PENDING' && (p.to_id === myId || p.from_id === myId),
    ).length;
  });

  /** REV-S4: FAB / thêm nhanh khoản chi chỉ nhắm nhóm mình còn ACTIVE và nhóm chưa đóng */
  const mostRecentGroupId = groups.length > 0 ? groups[0].id : null;

  const renderFooter = useCallback(() => {
    if (allTransactions.length === 0) return null;
    return (
      <View style={styles.recentSection}>
        <Text style={styles.recentTitle}>Giao dịch gần đây</Text>
        {/* MVP-09: bộ lọc thời gian */}
        <View style={styles.filterRow}>
          {TIME_FILTERS.map((f) => {
            const active = f.key === timeFilter;
            return (
              <Pressable
                key={f.key}
                style={[styles.filterChip, active && styles.filterChipActive]}
                onPress={() => setTimeFilter(f.key)}
                accessibilityRole="button"
                accessibilityState={{ selected: active }}
              >
                <Text style={[styles.filterChipText, active && styles.filterChipTextActive]}>{f.label}</Text>
              </Pressable>
            );
          })}
        </View>
        {recentTransactions.length === 0 ? (
          <View style={styles.recentEmptyContainer}>
            <Text style={styles.recentEmpty}>Không có giao dịch trong khoảng thời gian này</Text>
          </View>
        ) : null}
        {recentTransactions.map((tx) => (
          <Pressable
            key={`${tx.type}-${tx.id}`}
            style={styles.recentItem}
            onPress={() => {
              if (tx.type === 'expense') {
                router.push(`/group/${tx.groupId}/expense/${tx.id}` as any);
              } else {
                router.push(`/payment/${tx.id}` as any);
              }
            }}
          >
            <View style={[styles.recentIconContainer, tx.type === 'expense' ? styles.recentIconExpense : styles.recentIconPayment]}>
              <Text style={styles.recentIcon}>{tx.type === 'expense' ? '🧾' : '💳'}</Text>
            </View>
            <View style={styles.recentInfo}>
              <Text style={styles.recentDesc} numberOfLines={1}>{tx.description}</Text>
              <Text style={styles.recentMeta}>
                {tx.groupName} · {formatRelativeDate(tx.date)}
              </Text>
            </View>
            <Text style={styles.recentAmount}>{formatVND(tx.amount)}</Text>
          </Pressable>
        ))}
      </View>
    );
  }, [allTransactions.length, recentTransactions, router, timeFilter]);

  const renderHeader = useCallback(() => (
    <View>
      {/* Premium gradient-like greeting header */}
      <View style={styles.greetingContainer}>
        <View style={styles.greetingOverlay} />
        <View style={styles.greetingContent}>
          <Text style={styles.greeting}>
            {getTimeOfDayGreeting()}{user?.user_metadata?.display_name ? `, ${user.user_metadata.display_name}` : ''}! 👋
          </Text>
          <Text style={styles.headerSubtitle}>Tổng quan công nợ các nhóm</Text>
        </View>
      </View>
      {summaryTotals && (
        <View style={styles.summaryCard}>
          <View style={styles.summaryHeader}>
            <Text style={styles.summaryTitle}>Tổng hợp</Text>
          </View>
          <View style={styles.summaryTotalsRow}>
            <View style={styles.summaryItem}>
              <Text style={styles.summaryLabel}>Cần trả</Text>
              <Text style={[styles.summaryAmount, styles.negative]}>
                {formatVND(summaryTotals.totalOwed)}
              </Text>
            </View>
            <View style={styles.summaryDivider} />
            <View style={styles.summaryItem}>
              <Text style={styles.summaryLabel}>Cần thu</Text>
              <Text style={[styles.summaryAmount, styles.positive]}>
                {formatVND(summaryTotals.totalCollect)}
              </Text>
            </View>
          </View>
        </View>
      )}
    </View>
  ), [user, summaryTotals]);

  if (isLoading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color={Colors.primary} />
      </View>
    );
  }

  // APP-19: lỗi tải danh sách nhóm — không hiện như "chưa có nhóm"
  if (groupsError && !allGroups) {
    return <ErrorState message={toUserMessage(groupsError, 'Không thể tải danh sách nhóm')} onRetry={() => refetch()} />;
  }

  return (
    <SafeAreaView style={styles.container} edges={['bottom']}>
      <FlatList
        data={groups}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.list}
        refreshControl={
          <RefreshControl
            refreshing={isRefetching}
            onRefresh={() => { refetch(); refetchBalances(); }}
            tintColor={Colors.primary}
            colors={[Colors.primary]}
          />
        }
        ListHeaderComponent={renderHeader}
        ListEmptyComponent={
          <View style={styles.empty}>
            <View style={styles.emptyIconContainer}>
              <Text style={styles.emptyIcon}>📋</Text>
            </View>
            <Text style={styles.emptyText}>Bạn chưa tham gia nhóm nào.</Text>
            <Text style={styles.emptyHint}>Vào tab Nhóm để tạo hoặc tham gia nhóm.</Text>
          </View>
        }
        ListFooterComponent={renderFooter}
        renderItem={({ item }) => (
          <GroupCard
            group={item}
            // APP-04: undefined khi chưa tải được; group_balances không có dòng = số dư 0
            balance={balancesError ? null : allBalances ? (balanceByGroup.get(item.id) ?? 0) : undefined}
            pendingCount={pendingCountByGroup[item.id] ?? 0}
            onPress={() => router.push(`/group/${item.id}` as any)}
          />
        )}
      />
      {mostRecentGroupId && (
        <Pressable
          style={styles.fab}
          // Mặc định nhóm mới nhất, người dùng đổi nhóm ngay trong màn thêm khoản chi
          onPress={() => router.push(`/group/${mostRecentGroupId}/add-expense?pickGroup=1` as any)}
        >
          <Text style={styles.fabText}>+</Text>
        </Pressable>
      )}
    </SafeAreaView>
  );
}

function GroupCard({
  group,
  balance,
  pendingCount,
  onPress,
}: {
  group: GroupWithRole;
  /** Số dư chính thức từ group_balances; null = lỗi tải; undefined = đang tải */
  balance: number | null | undefined;
  pendingCount: number;
  onPress: () => void;
}) {
  // REV-S7: khoản chi / thanh toán được theo dõi ở HomeScreen (useQueries). Số dư lấy từ view (APP-04).
  return (
    <Pressable style={styles.card} onPress={onPress}>
      <View style={styles.cardAccent} />
      <View style={styles.cardBody}>
        <View style={styles.cardLeft}>
          <View style={styles.groupNameRow}>
            <Text style={styles.groupName}>{group.name}</Text>
            {pendingCount > 0 && (
              <View style={styles.pendingBadge}>
                <Text style={styles.pendingBadgeText}>{pendingCount}</Text>
              </View>
            )}
          </View>
          <Text style={styles.groupMeta}>
            {group.role === 'owner' ? 'Chủ nhóm' : 'Thành viên'}
          </Text>
        </View>
        <View style={styles.cardRight}>
          {balance === null ? (
            <Text style={styles.balanceError}>⚠️ Lỗi số dư</Text>
          ) : balance !== undefined && balance !== 0 ? (
            <>
              <Text style={[styles.balanceAmount, balance > 0 ? styles.positive : styles.negative]}>
                {balance > 0 ? '+' : ''}{formatVND(balance)}
              </Text>
              <Text style={styles.balanceLabel}>
                {balance > 0 ? 'Cần thu' : 'Cần trả'}
              </Text>
            </>
          ) : balance === 0 ? (
            <Text style={styles.balanced}>✓ Cân bằng</Text>
          ) : (
            <Text style={styles.arrow}>›</Text>
          )}
        </View>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  balanceError: { fontSize: FontSizes.sm, color: Colors.danger },
  container: { flex: 1, backgroundColor: Colors.background },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: Colors.background },
  list: { padding: Spacing.lg, gap: Spacing.md },

  // Greeting header with gradient-like effect
  greetingContainer: {
    borderRadius: Radii.lg,
    overflow: 'hidden',
    backgroundColor: Colors.primary,
    marginBottom: Spacing.sm,
  },
  greetingOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: Colors.primaryDark,
    opacity: 0.3,
    borderRadius: Radii.lg,
  },
  greetingContent: {
    padding: Spacing.xl,
    paddingVertical: Spacing.xxl,
  },
  greeting: {
    fontSize: FontSizes.xxl,
    fontWeight: FontWeights.bold,
    color: Colors.textInverse,
  },
  headerSubtitle: {
    fontSize: FontSizes.md,
    color: Colors.primaryLight,
    marginTop: Spacing.xs,
    opacity: 0.9,
  },

  // Empty state
  empty: {
    alignItems: 'center',
    paddingTop: 60,
    paddingHorizontal: Spacing.xl,
  },
  emptyIconContainer: {
    width: 80,
    height: 80,
    borderRadius: Radii.full,
    backgroundColor: Colors.primaryLight,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: Spacing.lg,
  },
  emptyIcon: { fontSize: 36 },
  emptyText: {
    fontSize: FontSizes.lg,
    color: Colors.text,
    fontWeight: FontWeights.medium,
    textAlign: 'center',
  },
  emptyHint: {
    fontSize: FontSizes.sm,
    color: Colors.textTertiary,
    marginTop: Spacing.sm,
    textAlign: 'center',
  },

  // Summary card
  summaryCard: {
    backgroundColor: Colors.surface,
    borderRadius: Radii.lg,
    padding: Spacing.lg,
    marginBottom: Spacing.sm,
    ...Shadows.md,
  },
  summaryHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: Spacing.md,
  },
  summaryTitle: {
    fontSize: FontSizes.md,
    fontWeight: FontWeights.semibold,
    color: Colors.text,
  },
  summaryTotalsRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  summaryItem: { flex: 1, alignItems: 'center' },
  summaryLabel: {
    fontSize: FontSizes.sm,
    color: Colors.textSecondary,
    marginBottom: Spacing.xs,
  },
  summaryAmount: { fontSize: FontSizes.xl, fontWeight: FontWeights.bold },
  summaryDivider: {
    width: 1,
    height: 40,
    backgroundColor: Colors.border,
  },

  // Group card with left accent border
  card: {
    backgroundColor: Colors.surface,
    borderRadius: Radii.lg,
    overflow: 'hidden',
    flexDirection: 'row',
    ...Shadows.sm,
  },
  cardAccent: {
    width: 4,
    backgroundColor: Colors.primary,
  },
  cardBody: {
    flex: 1,
    padding: Spacing.lg,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  cardLeft: { flex: 1 },
  cardRight: { alignItems: 'flex-end' },
  groupName: {
    fontSize: FontSizes.lg,
    fontWeight: FontWeights.semibold,
    color: Colors.text,
  },
  groupMeta: {
    fontSize: FontSizes.sm,
    color: Colors.textSecondary,
    marginTop: 2,
  },
  balanceAmount: { fontSize: FontSizes.lg, fontWeight: FontWeights.bold },
  balanceLabel: {
    fontSize: FontSizes.xs,
    color: Colors.textSecondary,
    marginTop: 2,
  },
  positive: { color: Colors.success },
  negative: { color: Colors.danger },
  balanced: {
    fontSize: FontSizes.sm,
    color: Colors.success,
    fontWeight: FontWeights.medium,
  },
  arrow: { fontSize: 22, color: Colors.textTertiary, fontWeight: FontWeights.regular },

  // Group name row with pending badge
  groupNameRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm },
  pendingBadge: {
    backgroundColor: Colors.warning,
    borderRadius: Radii.full,
    minWidth: 20,
    height: 20,
    paddingHorizontal: 6,
    justifyContent: 'center',
    alignItems: 'center',
  },
  pendingBadgeText: {
    fontSize: FontSizes.xs,
    fontWeight: FontWeights.bold,
    color: Colors.textInverse,
  },

  // Recent transactions
  recentSection: { marginTop: Spacing.lg, paddingBottom: 80 },
  recentHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  recentTitle: {
    fontSize: FontSizes.lg,
    fontWeight: FontWeights.bold,
    color: Colors.text,
    marginBottom: Spacing.md,
  },
  filterRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.sm,
    marginBottom: Spacing.md,
  },
  filterChip: {
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
    borderRadius: Radii.full,
    backgroundColor: Colors.borderLight,
  },
  filterChipActive: {
    backgroundColor: Colors.primary,
  },
  filterChipText: {
    fontSize: FontSizes.sm,
    color: Colors.textSecondary,
    fontWeight: FontWeights.medium,
  },
  filterChipTextActive: {
    color: Colors.textInverse,
    fontWeight: FontWeights.semibold,
  },
  recentEmptyContainer: {
    paddingVertical: Spacing.xxl,
    alignItems: 'center',
  },
  recentEmpty: {
    fontSize: FontSizes.sm,
    color: Colors.textTertiary,
    textAlign: 'center',
  },
  recentItem: {
    backgroundColor: Colors.surface,
    borderRadius: Radii.lg,
    padding: Spacing.lg,
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: Spacing.sm,
    ...Shadows.sm,
  },
  recentIconContainer: {
    width: 40,
    height: 40,
    borderRadius: Radii.md,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: Spacing.md,
  },
  recentIconExpense: {
    backgroundColor: Colors.warningLight,
  },
  recentIconPayment: {
    backgroundColor: Colors.primaryLight,
  },
  recentIcon: { fontSize: 20 },
  recentInfo: { flex: 1 },
  recentDesc: {
    fontSize: FontSizes.md,
    fontWeight: FontWeights.medium,
    color: Colors.text,
  },
  recentMeta: {
    fontSize: FontSizes.xs,
    color: Colors.textSecondary,
    marginTop: Spacing.xs,
  },
  recentAmount: {
    fontSize: FontSizes.md,
    fontWeight: FontWeights.semibold,
    color: Colors.text,
    marginLeft: Spacing.sm,
  },

  // FAB
  fab: {
    position: 'absolute',
    bottom: Spacing.xxl,
    right: Spacing.xxl,
    width: 56,
    height: 56,
    borderRadius: Radii.full,
    backgroundColor: Colors.primary,
    justifyContent: 'center',
    alignItems: 'center',
    ...Shadows.colored(Colors.primary),
  },
  fabText: {
    fontSize: 28,
    fontWeight: FontWeights.medium,
    color: Colors.textInverse,
    marginTop: -1,
  },

  // History link
  historyLink: {
    backgroundColor: Colors.surface,
    borderRadius: Radii.lg,
    padding: Spacing.lg,
    alignItems: 'center',
    marginTop: Spacing.xs,
    borderWidth: 1,
    borderColor: Colors.primary,
  },
  historyLinkText: {
    fontSize: FontSizes.md,
    color: Colors.primary,
    fontWeight: FontWeights.semibold,
  },
});
