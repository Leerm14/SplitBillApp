import { useQueryClient } from '@tanstack/react-query';
import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useState } from 'react';
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

import { toUserMessage } from '@/api/errors';
import { updateGroup } from '@/api/groups';
import { ErrorState } from '@/components/error-state';
import { formatVND } from '@/domain/money';
import { describeMyPosition, isSimplifyEnabled } from '@/domain/suggest';
import { useAuth } from '@/hooks/use-auth';
import { useGroupSettlement } from '@/hooks/use-group-settlement';

export default function DebtsOverviewScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [togglingSimplify, setTogglingSimplify] = useState(false);

  // APP-01 / APP-06: số dư + gợi ý dùng chung (suggestTransfers), lỗi không bị nuốt
  const {
    groupQ,
    paymentsQ,
    expensesQ,
    getName,
    settlement,
    settlementError,
    myPosition,
    isUnsynced,
    isViewerActive,
    canWrite,
    isLoading,
    queryError,
    refetchAll,
  } = useGroupSettlement(id);

  const officialBalances = settlement?.officialBal ?? null;
  const suggestions = settlement?.suggestions ?? [];
  const pendingPayments = (paymentsQ.data ?? []).filter((p) => p.status === 'PENDING');
  const isAllBalanced = !!officialBalances && [...officialBalances.values()].every((v) => v === 0);

  const handleToggleSimplify = async (value: boolean) => {
    setTogglingSimplify(true);
    try {
      // NEW-08: chỉ gửi simplify_debts — các tham số khác NULL = giữ nguyên ở server
      await updateGroup(id, { simplify_debts: value });
      queryClient.invalidateQueries({ queryKey: ['group', id] });
    } catch (err: any) {
      Alert.alert('Lỗi', toUserMessage(err, 'Không thể thay đổi chế độ'));
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

  // APP-19: Hiển thị lỗi thay vì dữ liệu trống
  if (queryError) {
    return <ErrorState message={toUserMessage(queryError, 'Không thể tải dữ liệu')} onRetry={refetchAll} />;
  }

  // REV-S5: người đã rời nhóm không xem số dư / gợi ý
  if (!isViewerActive) {
    return (
      <ErrorState
        title="Bạn đã rời nhóm"
        message="Số dư và gợi ý tất toán chỉ hiển thị cho thành viên đang ở trong nhóm. Bạn vẫn xem được lịch sử của nhóm."
      />
    );
  }

  // APP-06: NULL được hiểu là bật (BR-09)
  const simplifyEnabled = isSimplifyEnabled(groupQ.data?.simplify_debts);
  const isOwner = groupQ.data?.owner_id === user?.id;

  return (
    <SafeAreaView style={styles.container} edges={['bottom']}>
      <ScrollView
        refreshControl={
          <RefreshControl
            refreshing={groupQ.isRefetching || expensesQ.isRefetching || paymentsQ.isRefetching}
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
              disabled={togglingSimplify || !isOwner || !canWrite}
              trackColor={{ false: '#e5e5ea', true: '#34C759' }}
              thumbColor="#fff"
            />
          </View>
        </View>

        {/* REV-S6: tình trạng của chính mình + nhãn "Chưa đồng bộ" khi số dư tự tính ở client */}
        {!settlementError && myPosition && (
          <View style={styles.card}>
            <Text style={styles.myPositionText}>{describeMyPosition(myPosition, formatVND)}</Text>
            {isUnsynced && (
              <Text style={styles.unsyncedLabel}>⚠️ Chưa đồng bộ — số dư tính trên dữ liệu đã lưu trên máy</Text>
            )}
          </View>
        )}

        {/* APP-01: lỗi tính công nợ (BR-02) — báo lỗi thay vì hiện "cân bằng" hoặc rỗng */}
        {settlementError ? (
          <View style={styles.section}>
            <ErrorState
              inline
              title="Không tính được công nợ"
              message="Số liệu của nhóm không khớp (tổng số dư khác 0 hoặc thiếu thành viên). Lỗi đã được ghi lại."
              onRetry={refetchAll}
            />
          </View>
        ) : isAllBalanced && suggestions.length === 0 && pendingPayments.length === 0 ? (
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
                    // APP-16: mở đúng cặp from → to của gợi ý (kể cả giữa hai người khác)
                    onPress={() => router.push(`/group/${id}/debts/${t.to}?from=${t.from}` as any)}
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
                {pendingPayments.map((p) => (
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
  myPositionText: { fontSize: 16, fontWeight: '600', color: '#1565C0' },
  unsyncedLabel: { fontSize: 13, color: '#E65100', marginTop: 6 },
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
