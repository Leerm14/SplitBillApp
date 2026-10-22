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

import { toUserMessage } from '@/api/errors';
import { ErrorState } from '@/components/error-state';
import { explainDebt, type ExpenseContribution } from '@/domain/explain';
import { formatVND } from '@/domain/money';
import { useAuth } from '@/hooks/use-auth';
import { useGroupSettlement } from '@/hooks/use-group-settlement';

export default function DebtDetailScreen() {
  // APP-16: `from` (tùy chọn) cho phép mở cặp giữa hai người khác: from ↔ userId
  const { id: groupId, userId: targetUserId, from } = useLocalSearchParams<{
    id: string;
    userId: string;
    from?: string;
  }>();
  const router = useRouter();
  const { user } = useAuth();

  const {
    paymentsQ,
    memberNames,
    getName,
    expenseInputs,
    paymentInputs,
    settlement,
    settlementError,
    isUnsynced,
    isViewerActive,
    canWrite,
    isLoading,
    queryError,
    refetchAll,
  } = useGroupSettlement(groupId);

  // Bên "chủ thể" của cặp: người được truyền qua `from`, mặc định là chính mình
  const subjectId = from || user?.id || '';
  const isSelf = subjectId === user?.id;

  // APP-06: gợi ý lấy từ suggestTransfers (theo công tắc của nhóm) qua useGroupSettlement
  const debtInfo = useMemo(() => {
    if (!settlement || !subjectId) return null;
    const subjectOwes = settlement.suggestions.find((t) => t.from === subjectId && t.to === targetUserId);
    const targetOwes = settlement.suggestions.find((t) => t.from === targetUserId && t.to === subjectId);
    // REV-S1: truyền đủ bộ gợi ý để lời giải thích không mâu thuẫn với số tiền chuyển
    const opts = { simplify: settlement.simplify, transfers: settlement.suggestions };

    if (subjectOwes) {
      return {
        direction: 'owe' as const,
        debtor: subjectId,
        creditor: targetUserId,
        explanation: explainDebt(subjectId, targetUserId, subjectOwes.amount, expenseInputs, paymentInputs, memberNames, opts),
      };
    }
    if (targetOwes) {
      return {
        direction: 'owed' as const,
        debtor: targetUserId,
        creditor: subjectId,
        explanation: explainDebt(targetUserId, subjectId, targetOwes.amount, expenseInputs, paymentInputs, memberNames, opts),
      };
    }
    return {
      direction: 'settled' as const,
      debtor: subjectId,
      creditor: targetUserId,
      explanation: explainDebt(subjectId, targetUserId, 0, expenseInputs, paymentInputs, memberNames, opts),
    };
  }, [settlement, subjectId, targetUserId, expenseInputs, paymentInputs, memberNames]);

  // Thanh toán liên quan giữa hai người
  const relatedPayments = useMemo(() => {
    if (!paymentsQ.data || !subjectId) return [];
    return paymentsQ.data.filter(
      (p) =>
        (p.from_id === subjectId && p.to_id === targetUserId) ||
        (p.from_id === targetUserId && p.to_id === subjectId)
    );
  }, [paymentsQ.data, subjectId, targetUserId]);

  if (isLoading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color="#007AFF" />
      </View>
    );
  }

  // APP-19: Hiển thị lỗi thay vì dữ liệu trống
  if (queryError) {
    return <ErrorState message={toUserMessage(queryError, 'Không thể tải dữ liệu')} onRetry={refetchAll} />;
  }

  // REV-S5: người đã rời nhóm không xem công nợ
  if (!isViewerActive) {
    return (
      <ErrorState
        title="Bạn đã rời nhóm"
        message="Công nợ chỉ hiển thị cho thành viên đang ở trong nhóm. Bạn vẫn xem được lịch sử của nhóm."
      />
    );
  }

  // APP-01: lỗi tính công nợ (BR-02) — báo lỗi, không hiện gợi ý
  if (settlementError || !debtInfo) {
    return (
      <ErrorState
        title="Không tính được công nợ"
        message={settlementError ? 'Số liệu của nhóm không khớp. Lỗi đã được ghi lại.' : null}
        onRetry={refetchAll}
      />
    );
  }

  const { explanation, direction, debtor, creditor } = debtInfo;
  const subjectLabel = isSelf ? 'Bạn' : getName(subjectId);

  return (
    <SafeAreaView style={styles.container} edges={['bottom']}>
      <ScrollView contentContainerStyle={styles.content}>
        {/* Header */}
        <View style={styles.card}>
          <Text style={styles.pairTitle}>
            {getName(subjectId)} ↔ {getName(targetUserId)}
          </Text>
          {direction === 'owe' ? (
            <View style={styles.debtSummary}>
              <Text style={styles.debtDirection}>{subjectLabel} nợ {getName(targetUserId)}</Text>
              <Text style={[styles.debtAmount, styles.negative]}>{formatVND(explanation.amount)}</Text>
            </View>
          ) : direction === 'owed' ? (
            <View style={styles.debtSummary}>
              <Text style={styles.debtDirection}>
                {getName(targetUserId)} nợ {isSelf ? 'bạn' : getName(subjectId)}
              </Text>
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
            {isUnsynced && (
              <Text style={styles.unsyncedLabel}>⚠️ Chưa đồng bộ — tính trên dữ liệu đã lưu trên máy</Text>
            )}
          </View>
        )}

        {/* Chi tiết khoản chi — REV-S1: cặp đã cân bằng không liệt kê phần chịu */}
        {!explanation.balanced && (explanation.contributions.length > 0 || explanation.paymentLines.length > 0) && (
          <View style={styles.card}>
            <Text style={styles.cardLabel}>Phần {getName(debtor)} chịu trong các khoản chi</Text>
            {explanation.contributions.map((c: ExpenseContribution) => (
              <View key={c.expenseId} style={styles.contributionRow}>
                <View style={styles.contributionInfo}>
                  <Text style={styles.contributionDesc}>{c.description}</Text>
                  <Text style={styles.contributionPayer}>{getName(c.paidBy)} trả</Text>
                </View>
                <Text style={styles.contributionAmount}>{formatVND(c.shareAmount)}</Text>
              </View>
            ))}
            <View style={styles.totalRow}>
              <Text style={styles.totalLabel}>Tổng phần chịu</Text>
              <Text style={styles.totalAmount}>{formatVND(explanation.totalShare)}</Text>
            </View>
            {explanation.totalAdvanced > 0 && (
              <View style={styles.totalRow}>
                <Text style={styles.totalLabel}>
                  {getName(debtor)} đã ứng {settlement?.simplify ? 'cho người khác' : `cho ${getName(creditor)}`}
                </Text>
                <Text style={[styles.totalAmount, styles.positive]}>
                  -{formatVND(explanation.totalAdvanced)}
                </Text>
              </View>
            )}
            {/* REV-S1: mọi thanh toán CONFIRMED / PENDING được tính (kể cả với người thứ ba) */}
            {explanation.paymentLines.map((l) => (
              <View key={`${l.direction}-${l.counterparty}-${l.status}`} style={styles.totalRow}>
                <Text style={styles.totalLabel}>
                  {l.direction === 'sent'
                    ? `Đã ${l.status === 'PENDING' ? 'gửi' : 'trả'} ${getName(l.counterparty)}`
                    : `${getName(l.counterparty)} đã gửi ${getName(debtor)}`}
                  {l.status === 'PENDING' ? ' (chờ xác nhận)' : ''}
                </Text>
                <Text style={[styles.totalAmount, l.direction === 'sent' ? styles.positive : styles.negative]}>
                  {l.direction === 'sent' ? '-' : '+'}
                  {formatVND(l.amount)}
                </Text>
              </View>
            ))}
            <View style={styles.totalRow}>
              <Text style={styles.totalLabel}>Còn phải trả</Text>
              <Text style={styles.totalAmount}>{formatVND(explanation.itemsTotal)}</Text>
            </View>
            {/* REV-S1: nhiều lần chuyển → tách tổng theo người nhận */}
            {settlement?.simplify && explanation.outgoing.length > 1 &&
              explanation.outgoing.map((t) => (
                <View key={t.to} style={styles.totalRow}>
                  <Text style={styles.contributionPayer}>→ Chuyển {getName(t.to)}</Text>
                  <Text style={styles.contributionAmount}>{formatVND(t.amount)}</Text>
                </View>
              ))}
            {explanation.mismatch !== 0 && (
              <Text style={styles.unsyncedLabel}>
                ⚠️ Chênh {formatVND(Math.abs(explanation.mismatch))} so với {formatVND(explanation.expectedTotal)} cần
                trả — do bù trừ nợ trong nhóm hoặc dữ liệu chưa đồng bộ.
              </Text>
            )}
          </View>
        )}

        {/* Lịch sử thanh toán */}
        {relatedPayments.length > 0 && (
          <View style={styles.card}>
            <Text style={styles.cardLabel}>Lịch sử thanh toán</Text>
            {relatedPayments.map((p) => {
              const statusLabel =
                p.status === 'PENDING' ? '⏳ Chờ xác nhận' :
                p.status === 'CONFIRMED' ? '✅ Đã xác nhận' :
                p.status === 'REJECTED' ? '❌ Từ chối' :
                p.status === 'DISPUTED' ? '⚠️ Báo sai lệch' :
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
        {canWrite && direction !== 'settled' && debtor === user?.id && explanation.amount > 0 && (
          <Pressable
            style={styles.payBtn}
            onPress={() => router.push(`/group/${groupId}/pay?to=${creditor}` as any)}
          >
            <Text style={styles.payBtnText}>💸 Thanh toán cho {getName(creditor)}</Text>
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
  unsyncedLabel: { fontSize: 13, color: '#E65100' },

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
