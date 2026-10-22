import { useQuery } from '@tanstack/react-query';
import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useMemo } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { fetchExpenses } from '@/api/expenses';
import { fetchGroupMembers } from '@/api/groups';
import { fetchPayments } from '@/api/payments';
import { formatVND } from '@/domain/money';
import {
  explainDebt,
  type DebtExplanation,
  type ExpenseContribution,
} from '@/domain/explain';
import {
  computeBalances,
  simplifyDebts,
  type PaymentInput,
} from '@/domain/settlement';
import type { ExpenseInput } from '@/domain/explain';
import { useAuth } from '@/hooks/use-auth';

export default function DebtDetailScreen() {
  const { id: groupId, userId: targetUserId } = useLocalSearchParams<{ id: string; userId: string }>();
  const router = useRouter();
  const { user } = useAuth();

  const membersQ = useQuery({
    queryKey: ['group-members', groupId],
    queryFn: () => fetchGroupMembers(groupId),
  });

  const expensesQ = useQuery({
    queryKey: ['expenses', groupId],
    queryFn: () => fetchExpenses(groupId),
  });

  const paymentsQ = useQuery({
    queryKey: ['payments', groupId],
    queryFn: () => fetchPayments(groupId),
  });

  const isLoading = membersQ.isLoading || expensesQ.isLoading || paymentsQ.isLoading;

  const memberNames = useMemo(() => {
    if (!membersQ.data) return new Map<string, string>();
    return new Map(membersQ.data.map((m: any) => [m.id, m.displayName || m.id.slice(0, 8)]));
  }, [membersQ.data]);

  const getName = (uid: string) => memberNames.get(uid) || uid.slice(0, 8);

  // Chuẩn bị dữ liệu
  const expenseInputs = useMemo(() => {
    if (!expensesQ.data) return [];
    return expensesQ.data.map((e: any) => ({
      id: e.id as string,
      paidBy: e.paid_by,
      status: e.status,
      description: e.description || 'Khoản chi',
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

  // Tính nợ giữa user hiện tại và target user
  const debtInfo = useMemo((): { explanation: DebtExplanation; direction: 'owe' | 'owed' | 'settled' } | null => {
    if (!membersQ.data || !user) return null;
    const memberIds = membersQ.data.map((m: any) => m.id);

    try {
      const projected = computeBalances(memberIds, expenseInputs, paymentInputs, { includePending: true });
      const suggestions = simplifyDebts(projected);

      // Tìm transfer liên quan đến cả hai
      const myDebt = suggestions.find((t) => t.from === user.id && t.to === targetUserId);
      const theirDebt = suggestions.find((t) => t.from === targetUserId && t.to === user.id);

      if (myDebt) {
        const explanation = explainDebt(user.id, targetUserId, myDebt.amount, expenseInputs, paymentInputs, memberNames);
        return { explanation, direction: 'owe' };
      } else if (theirDebt) {
        const explanation = explainDebt(targetUserId, user.id, theirDebt.amount, expenseInputs, paymentInputs, memberNames);
        return { explanation, direction: 'owed' };
      } else {
        // Không có nợ trực tiếp — hiển thị giải thích rỗng
        const explanation = explainDebt(user.id, targetUserId, 0, expenseInputs, paymentInputs, memberNames);
        return { explanation, direction: 'settled' };
      }
    } catch {
      return null;
    }
  }, [membersQ.data, expenseInputs, paymentInputs, user, targetUserId, memberNames]);

  // Thanh toán liên quan giữa hai người
  const relatedPayments = useMemo(() => {
    if (!paymentsQ.data || !user) return [];
    return paymentsQ.data.filter(
      (p: any) =>
        (p.from_id === user.id && p.to_id === targetUserId) ||
        (p.from_id === targetUserId && p.to_id === user.id)
    );
  }, [paymentsQ.data, user, targetUserId]);

  if (isLoading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color="#007AFF" />
      </View>
    );
  }

  // APP-19: Hiển thị lỗi thay vì dữ liệu trống
  const queryError = membersQ.error || expensesQ.error || paymentsQ.error;
  if (queryError) {
    return (
      <View style={styles.center}>
        <Text style={styles.errorText}>⚠️ {(queryError as Error).message || 'Không thể tải dữ liệu'}</Text>
      </View>
    );
  }

  if (!debtInfo) {
    return (
      <View style={styles.center}>
        <Text style={styles.errorText}>Không thể tải thông tin công nợ</Text>
      </View>
    );
  }

  const { explanation, direction } = debtInfo;

  return (
    <SafeAreaView style={styles.container} edges={['bottom']}>
      <ScrollView contentContainerStyle={styles.content}>
        {/* Header */}
        <View style={styles.card}>
          <Text style={styles.pairTitle}>
            {getName(user!.id)} ↔ {getName(targetUserId)}
          </Text>
          {direction === 'owe' ? (
            <View style={styles.debtSummary}>
              <Text style={styles.debtDirection}>Bạn nợ {getName(targetUserId)}</Text>
              <Text style={[styles.debtAmount, styles.negative]}>{formatVND(explanation.amount)}</Text>
            </View>
          ) : direction === 'owed' ? (
            <View style={styles.debtSummary}>
              <Text style={styles.debtDirection}>{getName(targetUserId)} nợ bạn</Text>
              <Text style={[styles.debtAmount, styles.positive]}>{formatVND(explanation.amount)}</Text>
            </View>
          ) : (
            <View style={styles.settledBox}>
              <Text style={styles.settledText}>✅ Đã cân bằng</Text>
            </View>
          )}
        </View>

        {/* Giải thích */}
        {explanation.summary && (
          <View style={styles.card}>
            <Text style={styles.cardLabel}>Giải thích</Text>
            <Text style={styles.summaryText}>{explanation.summary}</Text>
          </View>
        )}

        {/* Chi tiết khoản chi */}
        {explanation.contributions.length > 0 && (
          <View style={styles.card}>
            <Text style={styles.cardLabel}>Khoản chi liên quan</Text>
            {explanation.contributions.map((c: ExpenseContribution, i: number) => (
              <View key={i} style={styles.contributionRow}>
                <View style={styles.contributionInfo}>
                  <Text style={styles.contributionDesc}>{c.description}</Text>
                  <Text style={styles.contributionPayer}>{getName(c.paidBy)} trả</Text>
                </View>
                <Text style={styles.contributionAmount}>{formatVND(c.shareAmount)}</Text>
              </View>
            ))}
            <View style={styles.totalRow}>
              <Text style={styles.totalLabel}>Tổng phần chịu</Text>
              <Text style={styles.totalAmount}>{formatVND(explanation.totalOwedToRecipient)}</Text>
            </View>
            {explanation.totalPaidToRecipient > 0 && (
              <View style={styles.totalRow}>
                <Text style={styles.totalLabel}>Đã thanh toán</Text>
                <Text style={[styles.totalAmount, styles.positive]}>
                  -{formatVND(explanation.totalPaidToRecipient)}
                </Text>
              </View>
            )}
          </View>
        )}

        {/* Lịch sử thanh toán */}
        {relatedPayments.length > 0 && (
          <View style={styles.card}>
            <Text style={styles.cardLabel}>Lịch sử thanh toán</Text>
            {relatedPayments.map((p: any) => {
              const statusLabel =
                p.status === 'PENDING' ? '⏳ Chờ xác nhận' :
                p.status === 'CONFIRMED' ? '✅ Đã xác nhận' :
                p.status === 'REJECTED' ? '❌ Từ chối' :
                p.status === 'DISPUTED' ? '⚠️ Tranh chấp' :
                p.status === 'CANCELLED' ? '🚫 Đã hủy' : p.status;
              return (
                <View key={p.id} style={styles.paymentRow}>
                  <View style={styles.paymentInfo}>
                    <Text style={styles.paymentText}>
                      {getName(p.from_id)} → {getName(p.to_id)}
                    </Text>
                    <Text style={styles.paymentDate}>
                      {new Date(p.created_at).toLocaleDateString('vi-VN')}
                    </Text>
                  </View>
                  <View style={styles.paymentRight}>
                    <Text style={styles.paymentAmount}>{formatVND(Number(p.amount))}</Text>
                    <Text style={styles.paymentStatus}>{statusLabel}</Text>
                  </View>
                </View>
              );
            })}
          </View>
        )}

        {/* Nút thanh toán */}
        {direction === 'owe' && explanation.amount > 0 && (
          <Pressable
            style={styles.payBtn}
            onPress={() => router.push(`/group/${groupId}/pay` as any)}
          >
            <Text style={styles.payBtnText}>💸 Thanh toán cho {getName(targetUserId)}</Text>
          </Pressable>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f2f2f7' },
  content: { padding: 16, gap: 12, paddingBottom: 40 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  errorText: { fontSize: 16, color: '#666' },

  card: {
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 16,
    gap: 8,
  },

  pairTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: '#1a1a1a',
    textAlign: 'center',
  },
  debtSummary: { alignItems: 'center', gap: 4, marginTop: 4 },
  debtDirection: { fontSize: 14, color: '#8E8E93' },
  debtAmount: { fontSize: 28, fontWeight: '700', color: '#1a1a1a' },
  positive: { color: '#34C759' },
  negative: { color: '#FF3B30' },

  settledBox: {
    backgroundColor: '#E8F5E9',
    borderRadius: 10,
    padding: 16,
    alignItems: 'center',
    marginTop: 4,
  },
  settledText: { fontSize: 16, fontWeight: '500', color: '#2E7D32' },

  cardLabel: {
    fontSize: 13,
    fontWeight: '600',
    color: '#8E8E93',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  summaryText: { fontSize: 15, color: '#1a1a1a', lineHeight: 22 },

  contributionRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 6,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#f2f2f7',
  },
  contributionInfo: { flex: 1, gap: 2 },
  contributionDesc: { fontSize: 15, color: '#1a1a1a', fontWeight: '500' },
  contributionPayer: { fontSize: 12, color: '#8E8E93' },
  contributionAmount: { fontSize: 15, fontWeight: '600', color: '#1a1a1a' },

  totalRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingTop: 8,
  },
  totalLabel: { fontSize: 14, fontWeight: '600', color: '#1a1a1a' },
  totalAmount: { fontSize: 15, fontWeight: '700', color: '#1a1a1a' },

  paymentRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#f2f2f7',
  },
  paymentInfo: { flex: 1, gap: 2 },
  paymentText: { fontSize: 14, color: '#1a1a1a', fontWeight: '500' },
  paymentDate: { fontSize: 12, color: '#C7C7CC' },
  paymentRight: { alignItems: 'flex-end', gap: 2 },
  paymentAmount: { fontSize: 14, fontWeight: '600', color: '#1a1a1a' },
  paymentStatus: { fontSize: 12 },

  payBtn: {
    backgroundColor: '#34C759',
    borderRadius: 12,
    padding: 16,
    alignItems: 'center',
    marginTop: 4,
  },
  payBtnText: { color: '#fff', fontSize: 16, fontWeight: '600' },
});
