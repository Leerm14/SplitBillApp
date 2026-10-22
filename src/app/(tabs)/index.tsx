import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import React, { useCallback, useMemo } from 'react';
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

import { fetchExpenses } from '@/api/expenses';
import { fetchGroups, fetchGroupMembers } from '@/api/groups';
import { fetchPayments } from '@/api/payments';
import { formatVND } from '@/domain/money';
import {
  computeBalances,
  type ExpenseInput,
  type PaymentInput,
} from '@/domain/settlement';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/hooks/use-auth';

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

/** Compute balance for a single group given data already fetched */
function computeGroupBalance(
  members: any[] | undefined,
  expenses: any[] | undefined,
  payments: any[] | undefined,
  userId: string,
): number | null {
  if (!members || !expenses || !payments) return null;
  try {
    const memberIds = members.map((m: any) => m.id);
    const expInput: ExpenseInput[] = expenses.map((e: any) => ({
      paidBy: e.paid_by,
      status: e.status,
      shares: e.expense_shares.map((s: any) => ({
        userId: s.user_id,
        amount: Number(s.amount),
      })),
    }));
    const payInput: PaymentInput[] = payments.map((p: any) => ({
      fromId: p.from_id,
      toId: p.to_id,
      amount: Number(p.amount),
      status: p.status,
    }));
    const bal = computeBalances(memberIds, expInput, payInput);
    return bal.get(userId) ?? 0;
  } catch {
    return null;
  }
}

export default function HomeScreen() {
  const { user } = useAuth();
  const router = useRouter();
  const queryClient = useQueryClient();

  const { data: groups, isLoading, refetch, isRefetching } = useQuery({
    queryKey: ['groups'],
    queryFn: fetchGroups,
  });

  // APP-04: Fetch all balances from group_balances view for all groups at once
  const { data: allBalances } = useQuery({
    queryKey: ['all-group-balances', user?.id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('group_balances')
        .select('group_id, user_id, balance')
        .eq('user_id', user?.id ?? '');
      if (error) throw error;
      return data ?? [];
    },
    enabled: !!user,
  });

  /** Compute summary totals from group_balances view */
  const summaryTotals = useMemo(() => {
    if (!groups || groups.length === 0 || !allBalances) return null;
    let totalOwed = 0;
    let totalCollect = 0;

    for (const b of allBalances) {
      const bal = Number(b.balance);
      if (bal < 0) totalOwed += bal;
      if (bal > 0) totalCollect += bal;
    }

    return allBalances.length > 0 ? { totalOwed, totalCollect } : null;
  }, [groups, allBalances]);

  /** Build list of recent transactions from cached data */
  const recentTransactions = useMemo(() => {
    if (!groups || groups.length === 0) return [];
    const items: RecentTransaction[] = [];

    for (const g of groups) {
      const expenses = queryClient.getQueryData<any[]>(['expenses', g.id]);
      const payments = queryClient.getQueryData<any[]>(['payments', g.id]);

      if (expenses) {
        for (const e of expenses) {
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
      }
      if (payments) {
        for (const p of payments) {
          const senderName = p.sender?.display_name ?? 'Ai đó';
          const receiverName = p.receiver?.display_name ?? 'Ai đó';
          items.push({
            id: p.id,
            type: 'payment',
            description: `${senderName} → ${receiverName}`,
            amount: Number(p.amount),
            groupId: g.id,
            groupName: g.name,
            date: p.created_at,
          });
        }
      }
    }

    items.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
    return items.slice(0, 5);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groups, isRefetching]);

  /** Count pending payments per group from cache */
  const pendingCountByGroup = useMemo(() => {
    const map: Record<string, number> = {};
    if (!groups) return map;
    for (const g of groups) {
      const payments = queryClient.getQueryData<any[]>(['payments', g.id]);
      if (payments) {
        map[g.id] = payments.filter((p: any) => p.status === 'PENDING').length;
      }
    }
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groups, isRefetching]);

  /** Most recent group for FAB */
  const mostRecentGroupId = groups && groups.length > 0 ? groups[0].id : null;

  const renderFooter = useCallback(() => {
    if (recentTransactions.length === 0) return null;
    return (
      <View style={styles.recentSection}>
        <Text style={styles.recentTitle}>🕐 Giao dịch gần đây</Text>
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
            <Text style={styles.recentIcon}>{tx.type === 'expense' ? '🧾' : '💳'}</Text>
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
  }, [recentTransactions, router]);

  const renderHeader = useCallback(() => (
    <View style={styles.header}>
      <Text style={styles.greeting}>
        {getTimeOfDayGreeting()}{user?.user_metadata?.display_name ? `, ${user.user_metadata.display_name}` : ''}! 👋
      </Text>
      <Text style={styles.headerSubtitle}>Tổng quan công nợ các nhóm</Text>
      {summaryTotals && (
        <View style={styles.summaryCard}>
          <Text style={styles.summaryTitle}>📊 Tổng hợp</Text>
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
        <ActivityIndicator size="large" color="#007AFF" />
      </View>
    );
  }

  return (
    <SafeAreaView style={styles.container} edges={['bottom']}>
      <FlatList
        data={groups ?? []}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.list}
        refreshControl={
          <RefreshControl refreshing={isRefetching} onRefresh={() => { refetch(); }} />
        }
        ListHeaderComponent={renderHeader}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={styles.emptyIcon}>📋</Text>
            <Text style={styles.emptyText}>Bạn chưa tham gia nhóm nào.</Text>
            <Text style={styles.emptyHint}>Vào tab Nhóm để tạo hoặc tham gia nhóm.</Text>
          </View>
        }
        ListFooterComponent={renderFooter}
        renderItem={({ item }) => (
          <GroupCard
            group={item}
            userId={user?.id || ''}
            pendingCount={pendingCountByGroup[item.id] ?? 0}
            onPress={() => router.push(`/group/${item.id}` as any)}
          />
        )}
      />
      {mostRecentGroupId && (
        <Pressable
          style={styles.fab}
          onPress={() => router.push(`/group/${mostRecentGroupId}/add-expense` as any)}
        >
          <Text style={styles.fabText}>+</Text>
        </Pressable>
      )}
    </SafeAreaView>
  );
}

function GroupCard({
  group,
  userId,
  pendingCount,
  onPress,
}: {
  group: any;
  userId: string;
  pendingCount: number;
  onPress: () => void;
}) {
  const membersQ = useQuery({
    queryKey: ['group-members', group.id],
    queryFn: () => fetchGroupMembers(group.id),
    staleTime: 60_000,
  });

  const expensesQ = useQuery({
    queryKey: ['expenses', group.id],
    queryFn: () => fetchExpenses(group.id),
    staleTime: 60_000,
  });

  const paymentsQ = useQuery({
    queryKey: ['payments', group.id],
    queryFn: () => fetchPayments(group.id),
    staleTime: 60_000,
  });

  const balance = useMemo(
    () => computeGroupBalance(membersQ.data, expensesQ.data, paymentsQ.data, userId),
    [membersQ.data, expensesQ.data, paymentsQ.data, userId],
  );

  return (
    <Pressable style={styles.card} onPress={onPress}>
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
        {balance !== null && balance !== 0 ? (
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
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f2f2f7' },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  list: { padding: 16, gap: 12 },
  header: { marginBottom: 8 },
  greeting: { fontSize: 24, fontWeight: '700', color: '#1a1a1a' },
  headerSubtitle: { fontSize: 14, color: '#666', marginTop: 4 },
  empty: { alignItems: 'center', paddingTop: 60 },
  emptyIcon: { fontSize: 48, marginBottom: 12 },
  emptyText: { fontSize: 16, color: '#666' },
  emptyHint: { fontSize: 14, color: '#999', marginTop: 4 },

  // Summary card
  summaryCard: {
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 16,
    marginTop: 12,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 4,
    elevation: 2,
  },
  summaryTitle: { fontSize: 15, fontWeight: '600', color: '#1a1a1a', marginBottom: 12 },
  summaryTotalsRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  summaryItem: { flex: 1, alignItems: 'center' },
  summaryLabel: { fontSize: 13, color: '#8E8E93', marginBottom: 4 },
  summaryAmount: { fontSize: 20, fontWeight: '700' },
  summaryDivider: { width: 1, height: 40, backgroundColor: '#E5E5EA' },

  card: {
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 16,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 4,
    elevation: 2,
  },
  cardLeft: { flex: 1 },
  cardRight: { alignItems: 'flex-end' },
  groupName: { fontSize: 16, fontWeight: '600', color: '#1a1a1a' },
  groupMeta: { fontSize: 13, color: '#8E8E93', marginTop: 2 },
  balanceAmount: { fontSize: 16, fontWeight: '700' },
  balanceLabel: { fontSize: 12, color: '#8E8E93', marginTop: 2 },
  positive: { color: '#34C759' },
  negative: { color: '#FF3B30' },
  balanced: { fontSize: 14, color: '#34C759', fontWeight: '500' },
  arrow: { fontSize: 22, color: '#C7C7CC', fontWeight: '300' },

  // Group name row with pending badge
  groupNameRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  pendingBadge: {
    backgroundColor: '#FF9500',
    borderRadius: 10,
    minWidth: 20,
    height: 20,
    paddingHorizontal: 6,
    justifyContent: 'center',
    alignItems: 'center',
  },
  pendingBadgeText: { fontSize: 11, fontWeight: '700', color: '#fff' },

  // Recent transactions
  recentSection: { marginTop: 8, paddingBottom: 80 },
  recentTitle: { fontSize: 17, fontWeight: '700', color: '#1a1a1a', marginBottom: 12 },
  recentItem: {
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 14,
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 8,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.04,
    shadowRadius: 3,
    elevation: 1,
  },
  recentIcon: { fontSize: 24, marginRight: 12 },
  recentInfo: { flex: 1 },
  recentDesc: { fontSize: 15, fontWeight: '500', color: '#1a1a1a' },
  recentMeta: { fontSize: 12, color: '#8E8E93', marginTop: 2 },
  recentAmount: { fontSize: 15, fontWeight: '600', color: '#1a1a1a', marginLeft: 8 },

  // FAB
  fab: {
    position: 'absolute',
    bottom: 24,
    right: 24,
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: '#007AFF',
    justifyContent: 'center',
    alignItems: 'center',
    shadowColor: '#007AFF',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 6,
  },
  fabText: { fontSize: 28, fontWeight: '500', color: '#fff', marginTop: -1 },

  // History link
  historyLink: {
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 14,
    alignItems: 'center',
    marginTop: 4,
    borderWidth: 1,
    borderColor: '#007AFF',
  },
  historyLinkText: {
    fontSize: 15,
    color: '#007AFF',
    fontWeight: '600',
  },
});
