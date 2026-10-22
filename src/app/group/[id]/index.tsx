import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  RefreshControl,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { cancelExpense, fetchExpenses } from '@/api/expenses';
import { fetchGroup, fetchGroupMembers } from '@/api/groups';
import { fetchPayments, confirmPayment, rejectPayment } from '@/api/payments';
import { formatVND } from '@/domain/money';
import {
  computeBalances,
  simplifyDebts,
  type ExpenseInput,
  type PaymentInput,
  type Transfer,
} from '@/domain/settlement';
import { useAuth } from '@/hooks/use-auth';

const AVATAR_COLORS = ['#007AFF', '#34C759', '#FF9500', '#AF52DE', '#FF2D55', '#5AC8FA', '#FF3B30', '#5856D6'];

type Settlement = {
  officialBal: Map<string, number>;
  projectedBal: Map<string, number>;
  suggestions: Transfer[];
  pendingPayments: any[];
  memberNames: Map<string, string>;
};

export default function GroupDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState<'debts' | 'expenses' | 'payments'>('debts');

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

  // Tính toán số dư và gợi ý
  const settlement = useMemo((): Settlement | null => {
    if (!membersQ.data || !expensesQ.data || !paymentsQ.data) return null;

    const memberIds = membersQ.data.map((m: any) => m.id);
    const memberNames = new Map(membersQ.data.map((m: any) => [m.id, m.displayName || m.id.slice(0, 8)]));

    const expenses: ExpenseInput[] = expensesQ.data.map((e: any) => ({
      paidBy: e.paid_by,
      status: e.status,
      shares: e.expense_shares.map((s: any) => ({
        userId: s.user_id,
        amount: Number(s.amount),
      })),
    }));

    const payments: PaymentInput[] = paymentsQ.data.map((p: any) => ({
      fromId: p.from_id,
      toId: p.to_id,
      amount: Number(p.amount),
      status: p.status,
    }));

    try {
      const officialBal = computeBalances(memberIds, expenses, payments);
      const projectedBal = computeBalances(memberIds, expenses, payments, { includePending: true });
      const suggestions = simplifyDebts(projectedBal);
      const pendingPayments = paymentsQ.data.filter((p: any) => p.status === 'PENDING');

      return { officialBal, projectedBal, suggestions, pendingPayments, memberNames };
    } catch (err) {
      console.error('Settlement error:', err);
      return null;
    }
  }, [membersQ.data, expensesQ.data, paymentsQ.data]);

  const handleShareInvite = async () => {
    if (!groupQ.data) return;
    try {
      await Share.share({
        message: `Tham gia nhóm "${groupQ.data.name}" trên Split Bill!\nMã mời: ${groupQ.data.invite_code}`,
      });
    } catch {}
  };

  const handleCancelExpense = async (expenseId: string) => {
    Alert.alert('Hủy khoản chi', 'Bạn có chắc muốn hủy khoản chi này?', [
      { text: 'Không', style: 'cancel' },
      {
        text: 'Hủy khoản chi',
        style: 'destructive',
        onPress: async () => {
          try {
            await cancelExpense(expenseId);
            queryClient.invalidateQueries({ queryKey: ['expenses', id] });
            queryClient.invalidateQueries({ queryKey: ['groups'] });
          } catch (err: any) {
            Alert.alert('Lỗi', err.message || 'Không thể hủy');
          }
        },
      },
    ]);
  };

  const handleRespondPayment = async (paymentId: string, accept: boolean) => {
    const label = accept ? 'xác nhận' : 'từ chối';
    Alert.alert(
      accept ? 'Xác nhận thanh toán' : 'Từ chối thanh toán',
      `Bạn có chắc muốn ${label} khoản thanh toán này?`,
      [
        { text: 'Không', style: 'cancel' },
        {
          text: accept ? 'Xác nhận' : 'Từ chối',
          style: accept ? 'default' : 'destructive',
          onPress: async () => {
            try {
              await (accept ? confirmPayment(paymentId) : rejectPayment(paymentId));
              queryClient.invalidateQueries({ queryKey: ['payments', id] });
              queryClient.invalidateQueries({ queryKey: ['expenses', id] });
              queryClient.invalidateQueries({ queryKey: ['groups'] });
            } catch (err: any) {
              Alert.alert('Lỗi', err.message || 'Có lỗi xảy ra');
            }
          },
        },
      ],
    );
  };

  if (isLoading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color="#007AFF" />
      </View>
    );
  }

  // APP-19: Hiển thị lỗi thay vì dữ liệu trống
  const queryError = groupQ.error || membersQ.error || expensesQ.error || paymentsQ.error;
  if (queryError) {
    return (
      <View style={styles.center}>
        <Text style={{ fontSize: 16, color: '#FF3B30', textAlign: 'center', marginBottom: 12 }}>
          ⚠️ Không thể tải dữ liệu nhóm
        </Text>
        <Text style={{ fontSize: 14, color: '#8E8E93', textAlign: 'center', marginBottom: 16 }}>
          {(queryError as Error).message || 'Đã xảy ra lỗi'}
        </Text>
        <Pressable
          style={{ backgroundColor: '#007AFF', paddingHorizontal: 24, paddingVertical: 12, borderRadius: 10 }}
          onPress={refetchAll}
        >
          <Text style={{ color: '#fff', fontWeight: '600' }}>Thử lại</Text>
        </Pressable>
      </View>
    );
  }

  const getName = (uid: string) => settlement?.memberNames.get(uid) || uid.slice(0, 8);

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
        {/* Header nhóm */}
        <View style={styles.groupHeader}>
          <Text style={styles.groupName}>{groupQ.data?.name}</Text>
          <Pressable onPress={handleShareInvite}>
            <Text style={styles.inviteCode}>📋 Mã mời: {groupQ.data?.invite_code}</Text>
          </Pressable>

          {/* Member avatars */}
          {membersQ.data && membersQ.data.length > 0 && (
            <View style={styles.memberAvatars}>
              {membersQ.data.map((m: any, index: number) => {
                const name = m.displayName || m.id.slice(0, 8);
                const letter = name[0].toUpperCase();
                const color = AVATAR_COLORS[index % AVATAR_COLORS.length];
                return (
                  <View
                    key={m.id}
                    style={[
                      styles.memberAvatar,
                      { backgroundColor: color, marginLeft: index > 0 ? -8 : 0 },
                    ]}
                  >
                    <Text style={styles.memberAvatarText}>{letter}</Text>
                  </View>
                );
              })}
              <Text style={styles.memberCount}>
                {membersQ.data.length} thành viên
              </Text>
            </View>
          )}

          {/* Quick actions */}
          <View style={styles.quickActions}>
            <Pressable style={styles.quickActionBtn} onPress={() => router.push(`/group/${id}/members` as any)}>
              <Text style={styles.quickActionText}>👤 Thành viên</Text>
            </Pressable>
            <Pressable style={styles.quickActionBtn} onPress={() => router.push(`/group/${id}/invite` as any)}>
              <Text style={styles.quickActionText}>🔗 Mời</Text>
            </Pressable>
            {groupQ.data?.owner_id === user?.id && (
              <Pressable style={styles.quickActionBtn} onPress={() => router.push(`/group/${id}/edit` as any)}>
                <Text style={styles.quickActionText}>⚙️ Cài đặt</Text>
              </Pressable>
            )}
            <Pressable style={styles.quickActionBtn} onPress={() => router.push(`/history?groupId=${id}` as any)}>
              <Text style={styles.quickActionText}>📋 Lịch sử</Text>
            </Pressable>
          </View>
        </View>

        {/* Action buttons */}
        <View style={styles.actions}>
          <Pressable
            style={styles.actionBtn}
            onPress={() => router.push(`/group/${id}/add-expense` as any)}
          >
            <Text style={styles.actionBtnText}>+ Khoản chi</Text>
          </Pressable>
          <Pressable
            style={[styles.actionBtn, styles.actionBtnGreen]}
            onPress={() => router.push(`/group/${id}/pay` as any)}
          >
            <Text style={styles.actionBtnText}>💸 Thanh toán</Text>
          </Pressable>
        </View>

        {/* Tabs */}
        <View style={styles.tabs}>
          {(['debts', 'expenses', 'payments'] as const).map((tab) => (
            <Pressable
              key={tab}
              style={[styles.tab, activeTab === tab && styles.tabActive]}
              onPress={() => setActiveTab(tab)}
            >
              <Text style={[styles.tabText, activeTab === tab && styles.tabTextActive]}>
                {tab === 'debts' ? '⚖️ Công nợ' : tab === 'expenses' ? '🧾 Khoản chi' : '💳 Thanh toán'}
              </Text>
            </Pressable>
          ))}
        </View>

        {/* Tab: Công nợ */}
        {activeTab === 'debts' && settlement && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Số dư chính thức</Text>
            {[...settlement.officialBal.entries()].map(([userId, balance]) => (
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

            <Text style={[styles.sectionTitle, { marginTop: 20 }]}>Gợi ý tất toán</Text>
            {settlement.suggestions.length === 0 ? (
              <View style={styles.settledBox}>
                <Text style={styles.settledText}>✅ Tất cả đã cân bằng!</Text>
              </View>
            ) : (
              settlement.suggestions.map((t, i) => (
                <Pressable
                  key={i}
                  style={styles.suggestionRow}
                  onPress={() => router.push(`/group/${id}/debts/${t.from === user?.id ? t.to : t.from}` as any)}
                >
                  <Text style={styles.suggestionText}>
                    {getName(t.from)} → {getName(t.to)}
                  </Text>
                  <Text style={styles.suggestionAmount}>{formatVND(t.amount)}</Text>
                </Pressable>
              ))
            )}

            {/* Link xem tất cả công nợ */}
            <Pressable
              style={styles.viewAllDebtsBtn}
              onPress={() => router.push(`/group/${id}/debts` as any)}
            >
              <Text style={styles.viewAllDebtsText}>Xem tất cả công nợ →</Text>
            </Pressable>

            {settlement.pendingPayments.length > 0 && (
              <>
                <Text style={[styles.sectionTitle, { marginTop: 20 }]}>⏳ Đang chờ xác nhận</Text>
                {settlement.pendingPayments.map((p: any) => (
                  <View key={p.id} style={styles.pendingRow}>
                    <Text style={styles.pendingText}>
                      {getName(p.from_id)} → {getName(p.to_id)}: {formatVND(Number(p.amount))}
                    </Text>
                    <Text style={styles.pendingStatus}>Chờ {getName(p.to_id)} xác nhận</Text>
                    {/* Action buttons khi user là người nhận */}
                    {p.to_id === user?.id && (
                      <View style={styles.respondActions}>
                        <Pressable
                          style={styles.confirmBtn}
                          onPress={() => handleRespondPayment(p.id, true)}
                        >
                          <Text style={styles.confirmBtnText}>✓ Xác nhận</Text>
                        </Pressable>
                        <Pressable
                          style={styles.rejectBtn}
                          onPress={() => handleRespondPayment(p.id, false)}
                        >
                          <Text style={styles.rejectBtnText}>✗ Từ chối</Text>
                        </Pressable>
                      </View>
                    )}
                  </View>
                ))}
              </>
            )}
          </View>
        )}

        {/* Tab: Khoản chi */}
        {activeTab === 'expenses' && (
          <View style={styles.section}>
            {(expensesQ.data || []).length === 0 ? (
              <View style={styles.emptyState}>
                <Text style={styles.emptyStateIcon}>🧾</Text>
                <Text style={styles.emptyStateText}>Chưa có khoản chi nào</Text>
                <Text style={styles.emptyStateHint}>Nhấn "+ Khoản chi" để thêm chi phí đầu tiên</Text>
              </View>
            ) : (
              (expensesQ.data || []).map((e: any) => (
                <Pressable
                  key={e.id}
                  style={[styles.expenseCard, e.status === 'CANCELLED' && styles.cancelled]}
                  onPress={() => router.push(`/group/${id}/expense/${e.id}` as any)}
                >
                  <View style={styles.expenseHeader}>
                    <Text style={[styles.expenseDesc, e.status === 'CANCELLED' && styles.cancelledText]}>
                      {e.description || 'Không có mô tả'}
                      {e.status === 'CANCELLED' ? ' (đã hủy)' : ''}
                    </Text>
                    <Text style={styles.expenseAmount}>{formatVND(Number(e.amount))}</Text>
                  </View>
                  <Text style={styles.expenseMeta}>
                    {getName(e.paid_by)} trả · {new Date(e.created_at).toLocaleDateString('vi-VN')}
                  </Text>
                  {/* Phần chia */}
                  <View style={styles.sharesContainer}>
                    {e.expense_shares.map((s: any) => (
                      <Text key={s.user_id} style={styles.shareItem}>
                        {getName(s.user_id)}: {formatVND(Number(s.amount))}
                      </Text>
                    ))}
                  </View>
                  {/* Nút hủy */}
                  {e.status === 'ACTIVE' && (e.created_by === user?.id || groupQ.data?.owner_id === user?.id) && (
                    <Pressable
                      style={styles.cancelBtn}
                      onPress={() => handleCancelExpense(e.id)}
                    >
                      <Text style={styles.cancelBtnText}>Hủy khoản chi</Text>
                    </Pressable>
                  )}
                </Pressable>
              ))
            )}
          </View>
        )}

        {/* Tab: Thanh toán */}
        {activeTab === 'payments' && (
          <View style={styles.section}>
            {(paymentsQ.data || []).length === 0 ? (
              <View style={styles.emptyState}>
                <Text style={styles.emptyStateIcon}>💳</Text>
                <Text style={styles.emptyStateText}>Chưa có thanh toán nào</Text>
                <Text style={styles.emptyStateHint}>Nhấn "💸 Thanh toán" để gửi thanh toán</Text>
              </View>
            ) : (
              (paymentsQ.data || []).map((p: any) => (
                <View key={p.id} style={styles.paymentCard}>
                  <View style={styles.paymentHeader}>
                    <Text style={styles.paymentText}>
                      {getName(p.from_id)} → {getName(p.to_id)}
                    </Text>
                    <Text style={styles.paymentAmount}>{formatVND(Number(p.amount))}</Text>
                  </View>
                  <Text style={styles.paymentStatus}>
                    {p.status === 'PENDING' ? '⏳ Chờ xác nhận' :
                     p.status === 'CONFIRMED' ? '✅ Đã xác nhận' : '❌ Từ chối'}
                  </Text>
                  {p.note ? <Text style={styles.paymentNote}>"{p.note}"</Text> : null}
                  <Text style={styles.paymentDate}>
                    {new Date(p.created_at).toLocaleDateString('vi-VN', {
                      day: '2-digit', month: '2-digit', year: 'numeric',
                      hour: '2-digit', minute: '2-digit',
                    })}
                  </Text>

                  {/* Nút xác nhận/từ chối cho người nhận */}
                  {p.status === 'PENDING' && p.to_id === user?.id && (
                    <View style={styles.respondActions}>
                      <Pressable
                        style={styles.confirmBtn}
                        onPress={() => handleRespondPayment(p.id, true)}
                      >
                        <Text style={styles.confirmBtnText}>✓ Xác nhận</Text>
                      </Pressable>
                      <Pressable
                        style={styles.rejectBtn}
                        onPress={() => handleRespondPayment(p.id, false)}
                      >
                        <Text style={styles.rejectBtnText}>✗ Từ chối</Text>
                      </Pressable>
                    </View>
                  )}
                </View>
              ))
            )}
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f2f2f7' },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },

  groupHeader: { padding: 20, backgroundColor: '#fff', alignItems: 'center', gap: 4 },
  groupName: { fontSize: 22, fontWeight: '700', color: '#1a1a1a' },
  inviteCode: { fontSize: 14, color: '#007AFF', fontWeight: '500' },
  memberAvatars: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 8,
    gap: 0,
  },
  memberAvatar: {
    width: 32,
    height: 32,
    borderRadius: 16,
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 2,
    borderColor: '#fff',
  },
  memberAvatarText: { fontSize: 14, fontWeight: '700', color: '#fff' },
  memberCount: { fontSize: 13, color: '#8E8E93', marginLeft: 8 },

  actions: { flexDirection: 'row', gap: 12, padding: 16 },
  actionBtn: {
    flex: 1, backgroundColor: '#007AFF', borderRadius: 12,
    padding: 14, alignItems: 'center',
  },
  actionBtnGreen: { backgroundColor: '#34C759' },
  actionBtnText: { color: '#fff', fontSize: 15, fontWeight: '600' },

  tabs: { flexDirection: 'row', paddingHorizontal: 16, gap: 6, marginBottom: 8 },
  tab: {
    flex: 1, paddingVertical: 10, alignItems: 'center',
    borderRadius: 10, backgroundColor: '#e5e5ea',
  },
  tabActive: { backgroundColor: '#007AFF' },
  tabText: { fontSize: 13, fontWeight: '500', color: '#666' },
  tabTextActive: { color: '#fff' },

  section: { padding: 16, gap: 8 },
  sectionTitle: { fontSize: 17, fontWeight: '600', color: '#1a1a1a', marginBottom: 4 },

  // Empty states
  emptyState: { alignItems: 'center', paddingVertical: 40 },
  emptyStateIcon: { fontSize: 48, marginBottom: 12 },
  emptyStateText: { fontSize: 16, color: '#666', fontWeight: '500' },
  emptyStateHint: { fontSize: 14, color: '#999', marginTop: 4 },

  // Debts
  balanceRow: {
    flexDirection: 'row', justifyContent: 'space-between',
    backgroundColor: '#fff', padding: 14, borderRadius: 10,
  },
  balanceName: { fontSize: 15, color: '#1a1a1a' },
  balanceAmount: { fontSize: 15, fontWeight: '600', color: '#1a1a1a' },
  positive: { color: '#34C759' },
  negative: { color: '#FF3B30' },
  settledBox: { backgroundColor: '#E8F5E9', padding: 20, borderRadius: 12, alignItems: 'center' },
  settledText: { fontSize: 16, color: '#2E7D32', fontWeight: '500' },
  suggestionRow: {
    flexDirection: 'row', justifyContent: 'space-between',
    backgroundColor: '#FFF8E1', padding: 14, borderRadius: 10,
    borderLeftWidth: 4, borderLeftColor: '#FFB300',
  },
  suggestionText: { fontSize: 15, color: '#5D4037', fontWeight: '500' },
  suggestionAmount: { fontSize: 15, fontWeight: '700', color: '#E65100' },
  pendingRow: {
    backgroundColor: '#E3F2FD', padding: 14, borderRadius: 10, gap: 4,
    borderLeftWidth: 4, borderLeftColor: '#42A5F5',
  },
  pendingText: { fontSize: 14, color: '#1565C0', fontWeight: '500' },
  pendingStatus: { fontSize: 13, color: '#42A5F5' },

  // Expenses
  expenseCard: { backgroundColor: '#fff', padding: 14, borderRadius: 10, gap: 6 },
  cancelled: { opacity: 0.5 },
  cancelledText: { textDecorationLine: 'line-through' },
  expenseHeader: { flexDirection: 'row', justifyContent: 'space-between' },
  expenseDesc: { fontSize: 15, fontWeight: '500', color: '#1a1a1a', flex: 1 },
  expenseAmount: { fontSize: 15, fontWeight: '600', color: '#1a1a1a' },
  expenseMeta: { fontSize: 13, color: '#8E8E93' },
  sharesContainer: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 4 },
  shareItem: { fontSize: 12, color: '#666', backgroundColor: '#f2f2f7', paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6 },
  cancelBtn: { alignSelf: 'flex-start', marginTop: 4, paddingVertical: 6, paddingHorizontal: 12, borderRadius: 6, borderWidth: 1, borderColor: '#FF3B30' },
  cancelBtnText: { color: '#FF3B30', fontSize: 13, fontWeight: '500' },

  // Payments
  paymentCard: { backgroundColor: '#fff', padding: 14, borderRadius: 10, gap: 4 },
  paymentHeader: { flexDirection: 'row', justifyContent: 'space-between' },
  paymentText: { fontSize: 15, fontWeight: '500', color: '#1a1a1a', flex: 1 },
  paymentAmount: { fontSize: 15, fontWeight: '600', color: '#1a1a1a' },
  paymentStatus: { fontSize: 13 },
  paymentNote: { fontSize: 13, color: '#8E8E93', fontStyle: 'italic' },
  paymentDate: { fontSize: 12, color: '#C7C7CC' },
  respondActions: { flexDirection: 'row', gap: 12, marginTop: 8 },
  confirmBtn: {
    flex: 1, backgroundColor: '#34C759', borderRadius: 8,
    padding: 10, alignItems: 'center',
  },
  confirmBtnText: { color: '#fff', fontSize: 14, fontWeight: '600' },
  rejectBtn: {
    flex: 1, backgroundColor: '#fff', borderRadius: 8,
    padding: 10, alignItems: 'center', borderWidth: 1, borderColor: '#FF3B30',
  },
  rejectBtnText: { color: '#FF3B30', fontSize: 14, fontWeight: '600' },

  // Quick actions
  quickActions: { flexDirection: 'row', gap: 8, marginTop: 12 },
  quickActionBtn: { backgroundColor: '#f2f2f7', borderRadius: 8, paddingHorizontal: 12, paddingVertical: 6 },
  quickActionText: { fontSize: 13, color: '#007AFF', fontWeight: '500' },

  // View all debts
  viewAllDebtsBtn: {
    backgroundColor: '#fff',
    borderRadius: 10,
    padding: 14,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#007AFF',
    marginTop: 4,
  },
  viewAllDebtsText: { fontSize: 15, color: '#007AFF', fontWeight: '600' },
});
