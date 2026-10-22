import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { fetchExpenses } from '@/api/expenses';
import { fetchGroup, fetchGroupMembers, updateGroup } from '@/api/groups';
import { fetchPayments } from '@/api/payments';
import { formatVND } from '@/domain/money';
import { computeBalances, simplifyDebts, type ExpenseInput, type PaymentInput } from '@/domain/settlement';
import { pairwiseDebts } from '@/domain/pairwise';
import { useAuth } from '@/hooks/use-auth';

type Transfer = { from: string; to: string; amount: number };

export default function DebtsOverviewScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [togglingSimplify, setTogglingSimplify] = useState(false);

  const groupQ = useQuery({
    queryKey: ['group', id],
    queryFn: () => fetchGroup(id),
  });

  const membersQ = useQuery({
    queryKey: ['group-members', id],
    queryFn: () => fetchGroupMembers(id),
  });

  const expensesQ = useQuery({
    queryKey: ['expenses', id],
    queryFn: () => fetchExpenses(id),
  });

  const paymentsQ = useQuery({
    queryKey: ['payments', id],
    queryFn: () => fetchPayments(id),
  });

  const isLoading = groupQ.isLoading || membersQ.isLoading || expensesQ.isLoading || paymentsQ.isLoading;

  const refetchAll = () => {
    groupQ.refetch();
    membersQ.refetch();
    expensesQ.refetch();
    paymentsQ.refetch();
  };

  const memberNames = useMemo(() => {
    if (!membersQ.data) return new Map<string, string>();
    return new Map(membersQ.data.map((m: any) => [m.id, m.displayName || m.id.slice(0, 8)]));
  }, [membersQ.data]);

  const getName = (uid: string) => memberNames.get(uid) || uid.slice(0, 8);

  // Chuẩn bị dữ liệu cho tính toán
  const expenseInputs = useMemo((): ExpenseInput[] => {
    if (!expensesQ.data) return [];
    return expensesQ.data.map((e: any) => ({
      paidBy: e.paid_by,
      status: e.status,
      shares: e.expense_shares.map((s: any) => ({
        userId: s.user_id,
        amount: Number(s.amount),
      })),
    }));
  }, [expensesQ.data]);

  const paymentInputs = useMemo((): PaymentInput[] => {
    if (!paymentsQ.data) return [];
    return paymentsQ.data.map((p: any) => ({
      fromId: p.from_id,
      toId: p.to_id,
      amount: Number(p.amount),
      status: p.status,
    }));
  }, [paymentsQ.data]);

  // Tính số dư chính thức
  const officialBalances = useMemo(() => {
    if (!membersQ.data) return null;
    const memberIds = membersQ.data.map((m: any) => m.id);
    try {
      return computeBalances(memberIds, expenseInputs, paymentInputs);
    } catch {
      return null;
    }
  }, [membersQ.data, expenseInputs, paymentInputs]);

  // Tính gợi ý tất toán
  const suggestions = useMemo((): Transfer[] => {
    if (!membersQ.data) return [];
    const memberIds = membersQ.data.map((m: any) => m.id);
    const useSimplify = groupQ.data?.simplify_debts !== false;

    try {
      if (useSimplify) {
        const projectedBal = computeBalances(memberIds, expenseInputs, paymentInputs, { includePending: true });
        return simplifyDebts(projectedBal);
      } else {
        return pairwiseDebts(memberIds, expenseInputs, paymentInputs, { includePending: true });
      }
    } catch {
      return [];
    }
  }, [membersQ.data, expenseInputs, paymentInputs, groupQ.data?.simplify_debts]);

  // Thanh toán đang chờ
  const pendingPayments = useMemo(() => {
    if (!paymentsQ.data) return [];
    return paymentsQ.data.filter((p: any) => p.status === 'PENDING');
  }, [paymentsQ.data]);

  // Kiểm tra cân bằng
  const isAllBalanced = useMemo(() => {
    if (!officialBalances) return false;
    return [...officialBalances.values()].every((v) => v === 0);
  }, [officialBalances]);

  const handleToggleSimplify = async (value: boolean) => {
    setTogglingSimplify(true);
    try {
      await updateGroup(id, { simplify_debts: value });
      queryClient.invalidateQueries({ queryKey: ['group', id] });
    } catch (err: any) {
      Alert.alert('Lỗi', err.message || 'Không thể thay đổi chế độ');
    } finally {
      setTogglingSimplify(false);
    }
  };

  if (isLoading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color="#007AFF" />
      </View>
    );
  }

  const simplifyEnabled = groupQ.data?.simplify_debts !== false;

  return (
    <SafeAreaView style={styles.container} edges={['bottom']}>
      <ScrollView
        refreshControl={
          <RefreshControl
            refreshing={groupQ.isRefetching || expensesQ.isRefetching}
            onRefresh={refetchAll}
          />
        }
      >
        {/* Header */}
        <View style={styles.header}>
          <Text style={styles.headerTitle}>⚖️ Tổng quan công nợ</Text>
          <Text style={styles.headerSubtitle}>{groupQ.data?.name}</Text>
        </View>

        {/* Toggle bù trừ nợ */}
        <View style={styles.card}>
          <View style={styles.toggleRow}>
            <View style={styles.toggleInfo}>
              <Text style={styles.toggleLabel}>Bù trừ nợ thông minh</Text>
              <Text style={styles.toggleHint}>
                {simplifyEnabled
                  ? 'Gộp nợ qua trung gian để giảm số lần chuyển'
                  : 'Hiển thị nợ từng cặp, không gộp qua trung gian'}
              </Text>
            </View>
            <Switch
              value={simplifyEnabled}
              onValueChange={handleToggleSimplify}
              disabled={togglingSimplify}
              trackColor={{ false: '#e5e5ea', true: '#34C759' }}
              thumbColor="#fff"
            />
          </View>
        </View>

        {/* Trạng thái cân bằng */}
        {isAllBalanced && suggestions.length === 0 && pendingPayments.length === 0 ? (
          <View style={styles.settledBox}>
            <Text style={styles.settledIcon}>✅</Text>
            <Text style={styles.settledTitle}>Tất cả đã cân bằng!</Text>
            <Text style={styles.settledHint}>Không có khoản nợ nào trong nhóm</Text>
          </View>
        ) : (
          <>
            {/* Số dư chính thức */}
            {officialBalances && (
              <View style={styles.section}>
                <Text style={styles.sectionTitle}>Số dư chính thức</Text>
                {[...officialBalances.entries()].map(([userId, balance]) => (
                  <View key={userId} style={styles.balanceRow}>
                    <Text style={styles.balanceName}>
                      {getName(userId)}
                      {userId === user?.id ? ' (bạn)' : ''}
                    </Text>
                    <Text
                      style={[
                        styles.balanceAmount,
                        balance > 0 && styles.positive,
                        balance < 0 && styles.negative,
                      ]}
                    >
                      {balance > 0 ? '+' : ''}{formatVND(balance)}
                    </Text>
                  </View>
                ))}
              </View>
            )}

            {/* Gợi ý tất toán */}
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>
                {simplifyEnabled ? 'Gợi ý tất toán (bù trừ)' : 'Gợi ý tất toán (từng cặp)'}
              </Text>
              {suggestions.length === 0 ? (
                <View style={styles.emptyHint}>
                  <Text style={styles.emptyHintText}>Không có gợi ý tất toán</Text>
                </View>
              ) : (
                suggestions.map((t, i) => (
                  <Pressable
                    key={i}
                    style={styles.suggestionRow}
                    onPress={() => {
                      // APP-16: Nếu user là 1 trong 2 bên, mở chi tiết đúng
                      // Nếu user không liên quan, mở pay trực tiếp (hoặc chỉ xem)
                      if (t.from === user?.id) {
                        // User nợ → mở chi tiết với người được nợ
                        router.push(`/group/${id}/debts/${t.to}` as any);
                      } else if (t.to === user?.id) {
                        // User được nợ → mở chi tiết với người nợ
                        router.push(`/group/${id}/debts/${t.from}` as any);
                      } else {
                        // Gợi ý giữa 2 người khác → mở chi tiết từ phía người nợ
                        router.push(`/group/${id}/debts/${t.from}` as any);
                      }
                    }}
                  >
                    <View style={styles.suggestionContent}>
                      <Text style={styles.suggestionText}>
                        {getName(t.from)} → {getName(t.to)}
                      </Text>
                      <Text style={styles.suggestionAmount}>{formatVND(t.amount)}</Text>
                    </View>
                    <Text style={styles.chevron}>›</Text>
                  </Pressable>
                ))
              )}
            </View>

            {/* Thanh toán đang chờ */}
            {pendingPayments.length > 0 && (
              <View style={styles.section}>
                <Text style={styles.sectionTitle}>⏳ Thanh toán đang chờ</Text>
                {pendingPayments.map((p: any) => (
                  <View key={p.id} style={styles.pendingRow}>
                    <View style={styles.pendingInfo}>
                      <Text style={styles.pendingText}>
                        {getName(p.from_id)} → {getName(p.to_id)}
                      </Text>
                      <Text style={styles.pendingAmount}>{formatVND(Number(p.amount))}</Text>
                    </View>
                    <Text style={styles.pendingStatus}>
                      Đang chờ {getName(p.to_id)} xác nhận
                    </Text>
                  </View>
                ))}
              </View>
            )}
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f2f2f7' },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },

  header: {
    padding: 20,
    backgroundColor: '#fff',
    alignItems: 'center',
    gap: 4,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#e5e5ea',
  },
  headerTitle: { fontSize: 20, fontWeight: '700', color: '#1a1a1a' },
  headerSubtitle: { fontSize: 14, color: '#8E8E93' },

  card: {
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 16,
    marginHorizontal: 16,
    marginTop: 16,
  },
  toggleRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  toggleInfo: { flex: 1, marginRight: 12 },
  toggleLabel: { fontSize: 15, fontWeight: '600', color: '#1a1a1a' },
  toggleHint: { fontSize: 13, color: '#8E8E93', marginTop: 2 },

  settledBox: {
    backgroundColor: '#E8F5E9',
    borderRadius: 16,
    padding: 32,
    margin: 16,
    alignItems: 'center',
    gap: 8,
  },
  settledIcon: { fontSize: 48 },
  settledTitle: { fontSize: 18, fontWeight: '600', color: '#2E7D32' },
  settledHint: { fontSize: 14, color: '#4CAF50' },

  section: { padding: 16, gap: 8 },
  sectionTitle: { fontSize: 17, fontWeight: '600', color: '#1a1a1a', marginBottom: 4 },

  balanceRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    backgroundColor: '#fff',
    padding: 14,
    borderRadius: 10,
  },
  balanceName: { fontSize: 15, color: '#1a1a1a' },
  balanceAmount: { fontSize: 15, fontWeight: '600', color: '#1a1a1a' },
  positive: { color: '#34C759' },
  negative: { color: '#FF3B30' },

  suggestionRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    backgroundColor: '#FFF8E1',
    padding: 14,
    borderRadius: 10,
    borderLeftWidth: 4,
    borderLeftColor: '#FFB300',
  },
  suggestionContent: {
    flex: 1,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  suggestionText: { fontSize: 15, color: '#5D4037', fontWeight: '500' },
  suggestionAmount: { fontSize: 15, fontWeight: '700', color: '#E65100' },
  chevron: { fontSize: 22, color: '#C7C7CC', marginLeft: 8 },

  emptyHint: {
    backgroundColor: '#fff',
    padding: 20,
    borderRadius: 12,
    alignItems: 'center',
  },
  emptyHintText: { fontSize: 14, color: '#8E8E93' },

  pendingRow: {
    backgroundColor: '#E3F2FD',
    padding: 14,
    borderRadius: 10,
    gap: 4,
    borderLeftWidth: 4,
    borderLeftColor: '#42A5F5',
  },
  pendingInfo: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  pendingText: { fontSize: 14, color: '#1565C0', fontWeight: '500' },
  pendingAmount: { fontSize: 14, fontWeight: '700', color: '#1565C0' },
  pendingStatus: { fontSize: 13, color: '#42A5F5' },
});
