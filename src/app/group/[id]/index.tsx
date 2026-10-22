import { useQueryClient } from '@tanstack/react-query';
import * as Crypto from 'expo-crypto';
import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useState } from 'react';
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

import { toUserMessage } from '@/api/errors';
import { cancelExpense } from '@/api/expenses';
import { isActiveMember } from '@/api/groups';
import { Avatar } from '@/components/avatar';
import { ErrorState } from '@/components/error-state';
import { formatVND } from '@/domain/money';
import { describeMyPosition } from '@/domain/suggest';
import { useAuth } from '@/hooks/use-auth';
import { useGroupSettlement } from '@/hooks/use-group-settlement';
import { useGroupUnsyncedItems } from '@/hooks/use-offline-sync';
import { describeQueueItem, submitAction } from '@/offline';

const AVATAR_COLORS = ['#007AFF', '#34C759', '#FF9500', '#AF52DE', '#FF2D55', '#5AC8FA', '#FF3B30', '#5856D6'];

const PAYMENT_STATUS_LABEL: Record<string, string> = {
  PENDING: '⏳ Chờ xác nhận',
  CONFIRMED: '✅ Đã xác nhận',
  REJECTED: '❌ Từ chối',
  DISPUTED: '⚠️ Báo sai lệch',
  CANCELLED: '🚫 Đã hủy',
};

export default function GroupDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState<'debts' | 'expenses' | 'payments'>('debts');

  // APP-01 / APP-06: số dư + gợi ý dùng chung, lỗi tính toán không bị nuốt
  const {
    groupQ,
    membersQ,
    expensesQ,
    paymentsQ,
    getName,
    settlement,
    settlementError,
    myPosition,
    isUnsynced,
    isViewerActive,
    isGroupClosed,
    canWrite,
    isLoading,
    queryError,
    refetchAll,
  } = useGroupSettlement(id);

  // REV-S10: server từ chối sửa / hủy khoản chi có người đã rời (PARTICIPANT_NOT_ACTIVE)
  const activeIds = new Set((membersQ.data ?? []).filter(isActiveMember).map((m) => m.id));
  const allParticipantsActive = (e: { paid_by: string; expense_shares: { user_id: string }[] }) =>
    activeIds.has(e.paid_by) && e.expense_shares.every((s) => activeIds.has(s.user_id));

  // APP-08: thao tác của nhóm này còn trong hàng đợi → hiện "Chưa đồng bộ"
  const unsyncedItems = useGroupUnsyncedItems(id);
  const pendingPayments = (paymentsQ.data ?? []).filter((p) => p.status === 'PENDING');

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
            Alert.alert('Lỗi', toUserMessage(err, 'Không thể hủy'));
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
            if (!user) return;
            try {
              // APP-08: ghi hàng đợi trước rồi gửi ngay; mất mạng thì tự gửi lại sau
              const res = await submitAction(
                accept ? 'confirm_payment' : 'reject_payment',
                { paymentId, groupId: id },
                Crypto.randomUUID(),
                user.id,
              );
              queryClient.invalidateQueries({ queryKey: ['payments', id] });
              queryClient.invalidateQueries({ queryKey: ['expenses', id] });
              queryClient.invalidateQueries({ queryKey: ['groups'] });
              // REV-S11: màn chi tiết thanh toán (nếu đã mở) cũng phải làm mới
              queryClient.invalidateQueries({ queryKey: ['payment', paymentId] });
              if (res.status === 'queued') {
                Alert.alert('Chưa đồng bộ', 'Thao tác đã được lưu và sẽ tự gửi khi có mạng.');
              }
            } catch (err: any) {
              Alert.alert('Lỗi', toUserMessage(err, 'Có lỗi xảy ra'));
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
  if (queryError) {
    return (
      <ErrorState
        title="Không thể tải dữ liệu nhóm"
        message={toUserMessage(queryError, 'Đã xảy ra lỗi')}
        onRetry={refetchAll}
      />
    );
  }

  // NEW-03: Danh sách tính số dư gồm cả người đã rời; phần hiển thị chỉ lấy ACTIVE
  const activeMembers = (membersQ.data || []).filter(isActiveMember);

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
          {/* MVP-03: ảnh nhóm */}
          <Avatar name={groupQ.data?.name} path={groupQ.data?.avatar_path} seed={id} size={64} />
          <Text style={styles.groupName}>{groupQ.data?.name}</Text>
          {groupQ.data?.description ? (
            <Text style={styles.groupDescription}>{groupQ.data.description}</Text>
          ) : null}
          <Pressable onPress={handleShareInvite}>
            <Text style={styles.inviteCode}>📋 Mã mời: {groupQ.data?.invite_code}</Text>
          </Pressable>

          {/* Member avatars — MVP-02: ảnh đại diện, chưa có thì chữ cái đầu */}
          {activeMembers.length > 0 && (
            <View style={styles.memberAvatars}>
              {activeMembers.slice(0, 8).map((m, index) => (
                <Avatar
                  key={m.id}
                  name={m.displayName || m.id.slice(0, 8)}
                  path={m.avatarPath}
                  color={AVATAR_COLORS[index % AVATAR_COLORS.length]}
                  size={32}
                  style={[styles.memberAvatar, { marginLeft: index > 0 ? -8 : 0 }]}
                />
              ))}
              <Text style={styles.memberCount}>
                {activeMembers.length} thành viên
              </Text>
            </View>
          )}

          {/* Quick actions — REV-S5: người đã rời / nhóm đã đóng chỉ xem (Lịch sử vẫn mở được) */}
          <View style={styles.quickActions}>
            {isViewerActive && (
              <Pressable style={styles.quickActionBtn} onPress={() => router.push(`/group/${id}/members` as any)}>
                <Text style={styles.quickActionText}>👤 Thành viên</Text>
              </Pressable>
            )}
            {canWrite && (
              <Pressable style={styles.quickActionBtn} onPress={() => router.push(`/group/${id}/invite` as any)}>
                <Text style={styles.quickActionText}>🔗 Mời</Text>
              </Pressable>
            )}
            {canWrite && groupQ.data?.owner_id === user?.id && (
              <Pressable style={styles.quickActionBtn} onPress={() => router.push(`/group/${id}/edit` as any)}>
                <Text style={styles.quickActionText}>⚙️ Cài đặt</Text>
              </Pressable>
            )}
            <Pressable style={styles.quickActionBtn} onPress={() => router.push(`/history?groupId=${id}` as any)}>
              <Text style={styles.quickActionText}>📋 Lịch sử</Text>
            </Pressable>
          </View>
        </View>

        {/* REV-S5: trạng thái chỉ xem */}
        {!isViewerActive ? (
          <View style={styles.readOnlyBanner}>
            <Text style={styles.readOnlyTitle}>🚪 Bạn đã rời nhóm</Text>
            <Text style={styles.readOnlyText}>
              Bạn chỉ xem được khoản chi, thanh toán và lịch sử của nhóm; không thể thêm hay thay đổi dữ liệu.
            </Text>
          </View>
        ) : isGroupClosed ? (
          <View style={styles.readOnlyBanner}>
            <Text style={styles.readOnlyTitle}>🔒 Nhóm đã đóng</Text>
            <Text style={styles.readOnlyText}>Nhóm đã đóng nên không thể thêm khoản chi hay thanh toán.</Text>
          </View>
        ) : (
          /* Action buttons */
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
        )}

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

        {/* APP-08: Thao tác chưa gửi được lên máy chủ */}
        {unsyncedItems.length > 0 && (
          <View style={styles.section}>
            {unsyncedItems.map((item) => (
              <View key={item.id} style={styles.unsyncedRow}>
                <Text style={styles.unsyncedText}>{describeQueueItem(item)}</Text>
                <Text style={item.status === 'FAILED' ? styles.unsyncedFailed : styles.unsyncedBadge}>
                  {item.status === 'FAILED' ? `Lỗi: ${item.error_message ?? ''}` : 'Chưa đồng bộ'}
                </Text>
              </View>
            ))}
          </View>
        )}

        {/* APP-01: Lỗi tính công nợ (BR-02) — không hiện gợi ý, không hiện màn rỗng */}
        {/* REV-S5: người đã rời không xem số dư / gợi ý (số dư của họ luôn 0 theo BR-11) */}
        {activeTab === 'debts' && !isViewerActive && (
          <View style={styles.section}>
            <View style={styles.emptyState}>
              <Text style={styles.emptyStateIcon}>🚪</Text>
              <Text style={styles.emptyStateText}>Bạn đã rời nhóm</Text>
              <Text style={styles.emptyStateHint}>Số dư và gợi ý tất toán chỉ hiển thị cho thành viên đang ở trong nhóm.</Text>
            </View>
          </View>
        )}

        {activeTab === 'debts' && isViewerActive && settlementError && (
          <View style={styles.section}>
            <ErrorState
              inline
              title="Không tính được công nợ"
              message="Số liệu của nhóm không khớp (tổng số dư khác 0 hoặc thiếu thành viên). Lỗi đã được ghi lại."
              onRetry={refetchAll}
            />
          </View>
        )}

        {/* Tab: Công nợ */}
        {activeTab === 'debts' && isViewerActive && settlement && (
          <View style={styles.section}>
            {/* REV-S6: tình trạng của chính mình (AC-01.1, §6 ví dụ 2) */}
            {myPosition && (
              <View style={styles.myPositionBox}>
                <Text style={styles.myPositionText}>{describeMyPosition(myPosition, formatVND)}</Text>
              </View>
            )}
            {/* REV-S6: số tự tính khi không tải được view group_balances */}
            {isUnsynced && <Text style={styles.unsyncedLabel}>⚠️ Chưa đồng bộ — số dư tính trên dữ liệu đã lưu trên máy</Text>}
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

            <Text style={[styles.sectionTitle, { marginTop: 20 }]}>
              {settlement.simplify ? 'Gợi ý tất toán' : 'Gợi ý tất toán (từng cặp)'}
            </Text>
            {settlement.suggestions.length === 0 ? (
              <View style={styles.settledBox}>
                <Text style={styles.settledText}>✅ Tất cả đã cân bằng!</Text>
              </View>
            ) : (
              settlement.suggestions.map((t, i) => (
                <Pressable
                  key={i}
                  style={styles.suggestionRow}
                  // APP-16: mở đúng cặp from → to của gợi ý
                  onPress={() => router.push(`/group/${id}/debts/${t.to}?from=${t.from}` as any)}
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

            {pendingPayments.length > 0 && (
              <>
                <Text style={[styles.sectionTitle, { marginTop: 20 }]}>⏳ Đang chờ xác nhận</Text>
                {pendingPayments.map((p) => (
                  <View key={p.id} style={styles.pendingRow}>
                    <Text style={styles.pendingText}>
                      {getName(p.from_id)} → {getName(p.to_id)}: {formatVND(Number(p.amount))}
                    </Text>
                    <Text style={styles.pendingStatus}>Chờ {getName(p.to_id)} xác nhận</Text>
                    {/* Action buttons khi user là người nhận (REV-S5: chỉ khi còn ghi được) */}
                    {canWrite && p.to_id === user?.id && (
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
                <Text style={styles.emptyStateHint}>Nhấn &quot;+ Khoản chi&quot; để thêm chi phí đầu tiên</Text>
              </View>
            ) : (
              (expensesQ.data || []).map((e) => (
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
                    {e.expense_shares.map((s) => (
                      <Text key={s.user_id} style={styles.shareItem}>
                        {getName(s.user_id)}: {formatVND(Number(s.amount))}
                      </Text>
                    ))}
                  </View>
                  {/* Nút hủy */}
                  {/* REV-S5 / REV-S10: không hiện khi chỉ xem hoặc có người tham gia đã rời nhóm */}
                  {canWrite &&
                    e.status === 'ACTIVE' &&
                    allParticipantsActive(e) &&
                    (e.created_by === user?.id || groupQ.data?.owner_id === user?.id) && (
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
                <Text style={styles.emptyStateHint}>Nhấn &quot;💸 Thanh toán&quot; để gửi thanh toán</Text>
              </View>
            ) : (
              (paymentsQ.data || []).map((p) => (
                <View key={p.id} style={styles.paymentCard}>
                  <View style={styles.paymentHeader}>
                    <Text style={styles.paymentText}>
                      {getName(p.from_id)} → {getName(p.to_id)}
                    </Text>
                    <Text style={styles.paymentAmount}>{formatVND(Number(p.amount))}</Text>
                  </View>
                  <Text style={styles.paymentStatus}>
                    {PAYMENT_STATUS_LABEL[p.status] ?? p.status}
                  </Text>
                  {p.note ? <Text style={styles.paymentNote}>&ldquo;{p.note}&rdquo;</Text> : null}
                  <Text style={styles.paymentDate}>
                    {new Date(p.created_at).toLocaleDateString('vi-VN', {
                      day: '2-digit', month: '2-digit', year: 'numeric',
                      hour: '2-digit', minute: '2-digit',
                    })}
                  </Text>

                  {/* Nút xác nhận/từ chối cho người nhận */}
                  {canWrite && p.status === 'PENDING' && p.to_id === user?.id && (
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
  groupDescription: { fontSize: 14, color: '#666', textAlign: 'center' },
  inviteCode: { fontSize: 14, color: '#007AFF', fontWeight: '500' },
  memberAvatars: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 8,
    gap: 0,
  },
  memberAvatar: { borderWidth: 2, borderColor: '#fff' },
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

  // REV-S5: chỉ xem
  readOnlyBanner: {
    margin: 16, padding: 14, borderRadius: 12, gap: 4,
    backgroundColor: '#F2F2F7', borderWidth: 1, borderColor: '#D1D1D6',
  },
  readOnlyTitle: { fontSize: 15, fontWeight: '600', color: '#1a1a1a' },
  readOnlyText: { fontSize: 13, color: '#666' },

  // REV-S6: tình trạng cá nhân + nhãn "Chưa đồng bộ"
  myPositionBox: { backgroundColor: '#E3F2FD', padding: 14, borderRadius: 10, marginBottom: 8 },
  myPositionText: { fontSize: 15, fontWeight: '600', color: '#1565C0' },
  unsyncedLabel: { fontSize: 13, color: '#E65100', marginBottom: 4 },

  // APP-08: Chưa đồng bộ
  unsyncedRow: {
    backgroundColor: '#FFF8E1', padding: 12, borderRadius: 10, gap: 2,
    borderLeftWidth: 4, borderLeftColor: '#FFB300',
  },
  unsyncedText: { fontSize: 14, color: '#5D4037', fontWeight: '500' },
  unsyncedBadge: { fontSize: 12, color: '#E65100' },
  unsyncedFailed: { fontSize: 12, color: '#C62828' },
});
