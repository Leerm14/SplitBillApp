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
import { useJoinRequests } from '@/hooks/use-join-requests';
import { useGroupUnsyncedItems } from '@/hooks/use-offline-sync';
import { Colors, Spacing, Radii, FontSizes, FontWeights, Shadows } from '@/lib/theme';
import { describeQueueItem, submitAction } from '@/offline';

const AVATAR_COLORS = [Colors.primary, Colors.success, Colors.warning, '#AF52DE', '#FF2D55', '#5AC8FA', Colors.danger, '#5856D6'];

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

  // Migration 0014: số yêu cầu tham gia chờ duyệt (chỉ chủ nhóm) — hiện trên nút Thành viên
  const pendingJoinCount = useJoinRequests(id, groupQ.data?.owner_id === user?.id).data?.length ?? 0;

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
        <ActivityIndicator size="large" color={Colors.primary} />
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
            tintColor={Colors.primary}
          />
        }
      >
        {/* Header nhóm */}
        <View style={styles.groupHeader}>
          {/* Decorative teal overlay layer */}
          <View style={styles.headerOverlay} />
          {/* MVP-03: ảnh nhóm */}
          <View style={styles.avatarWrapper}>
            <Avatar name={groupQ.data?.name} path={groupQ.data?.avatar_path} seed={id} size={68} />
          </View>
          <Text style={styles.groupName}>{groupQ.data?.name}</Text>
          {groupQ.data?.description ? (
            <Text style={styles.groupDescription}>{groupQ.data.description}</Text>
          ) : null}
          <Pressable onPress={handleShareInvite} style={styles.inviteChip}>
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
                  size={34}
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
                <Text style={styles.quickActionText}>👤 Thành viên{pendingJoinCount > 0 ? ` (${pendingJoinCount} chờ duyệt)` : ''}</Text>
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

        {/* Tabs — segmented control */}
        <View style={styles.tabsWrapper}>
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
            <View style={styles.errorBox}>
              <ErrorState
                inline
                title="Không tính được công nợ"
                message="Số liệu của nhóm không khớp (tổng số dư khác 0 hoặc thiếu thành viên). Lỗi đã được ghi lại."
                onRetry={refetchAll}
              />
            </View>
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
            {[...settlement.officialBal.entries()].map(([userId, balance], index) => (
              <View key={userId} style={[styles.balanceRow, index % 2 === 1 && styles.balanceRowAlt]}>
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

            <Text style={[styles.sectionTitle, { marginTop: Spacing.xl }]}>
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
                <Text style={[styles.sectionTitle, { marginTop: Spacing.xl }]}>⏳ Đang chờ xác nhận</Text>
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
              (expensesQ.data || []).map((e, index) => (
                <Pressable
                  key={e.id}
                  style={[
                    styles.expenseCard,
                    e.status === 'CANCELLED' && styles.cancelled,
                    index < (expensesQ.data || []).length - 1 && styles.expenseCardBorder,
                  ]}
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
                  <View style={styles.paymentStatusBadge}>
                    <Text style={[
                      styles.paymentStatusText,
                      p.status === 'CONFIRMED' && styles.paymentStatusConfirmed,
                      p.status === 'REJECTED' && styles.paymentStatusRejected,
                      p.status === 'PENDING' && styles.paymentStatusPending,
                      p.status === 'DISPUTED' && styles.paymentStatusDisputed,
                      p.status === 'CANCELLED' && styles.paymentStatusCancelled,
                    ]}>
                      {PAYMENT_STATUS_LABEL[p.status] ?? p.status}
                    </Text>
                  </View>
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

        {/* Bottom spacer for scroll breathing */}
        <View style={styles.bottomSpacer} />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: Colors.background },

  // ── Group Header ──────────────────────────────────────────────
  groupHeader: {
    paddingTop: Spacing.xxl,
    paddingBottom: Spacing.xl,
    paddingHorizontal: Spacing.xl,
    backgroundColor: Colors.surface,
    alignItems: 'center',
    gap: Spacing.xs,
    overflow: 'hidden',
    ...Shadows.sm,
  },
  headerOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: 100,
    backgroundColor: Colors.primaryLight,
    opacity: 0.5,
  },
  avatarWrapper: {
    marginBottom: Spacing.sm,
    borderRadius: Radii.full,
    padding: 3,
    borderWidth: 2,
    borderColor: Colors.primaryMuted,
  },
  groupName: {
    fontSize: FontSizes.xxl,
    fontWeight: FontWeights.bold,
    color: Colors.text,
    textAlign: 'center',
  },
  groupDescription: {
    fontSize: FontSizes.md,
    color: Colors.textSecondary,
    textAlign: 'center',
    lineHeight: 20,
  },
  inviteChip: {
    marginTop: Spacing.xs,
    backgroundColor: Colors.primaryLight,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.xs,
    borderRadius: Radii.full,
  },
  inviteCode: {
    fontSize: FontSizes.sm,
    color: Colors.primaryDark,
    fontWeight: FontWeights.medium,
  },
  memberAvatars: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: Spacing.md,
    gap: 0,
  },
  memberAvatar: { borderWidth: 2, borderColor: Colors.surface },
  memberCount: { fontSize: FontSizes.sm, color: Colors.textSecondary, marginLeft: Spacing.sm },

  // ── Action Buttons ────────────────────────────────────────────
  actions: {
    flexDirection: 'row',
    gap: Spacing.md,
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.lg,
  },
  actionBtn: {
    flex: 1,
    backgroundColor: Colors.primary,
    borderRadius: Radii.md,
    paddingVertical: Spacing.lg,
    alignItems: 'center',
    ...Shadows.md,
  },
  actionBtnGreen: {
    backgroundColor: Colors.success,
    ...Shadows.colored(Colors.success),
  },
  actionBtnText: {
    color: Colors.textInverse,
    fontSize: FontSizes.md,
    fontWeight: FontWeights.semibold,
  },

  // ── Tabs (Segmented Control) ──────────────────────────────────
  tabsWrapper: {
    paddingHorizontal: Spacing.lg,
    marginBottom: Spacing.md,
  },
  tabs: {
    flexDirection: 'row',
    backgroundColor: Colors.borderLight,
    borderRadius: Radii.md,
    padding: 3,
  },
  tab: {
    flex: 1,
    paddingVertical: Spacing.sm + 2,
    alignItems: 'center',
    borderRadius: Radii.sm + 2,
  },
  tabActive: {
    backgroundColor: Colors.primary,
    ...Shadows.sm,
  },
  tabText: {
    fontSize: FontSizes.sm,
    fontWeight: FontWeights.medium,
    color: Colors.textSecondary,
  },
  tabTextActive: {
    color: Colors.textInverse,
    fontWeight: FontWeights.semibold,
  },

  // ── Section / General ─────────────────────────────────────────
  section: { paddingHorizontal: Spacing.lg, paddingVertical: Spacing.md, gap: Spacing.sm },
  sectionTitle: {
    fontSize: FontSizes.lg,
    fontWeight: FontWeights.semibold,
    color: Colors.text,
    marginBottom: Spacing.xs,
  },

  // ── Empty states ──────────────────────────────────────────────
  emptyState: {
    alignItems: 'center',
    paddingVertical: Spacing.xxxl + 8,
    backgroundColor: Colors.surface,
    borderRadius: Radii.lg,
    marginVertical: Spacing.sm,
  },
  emptyStateIcon: { fontSize: 48, marginBottom: Spacing.md },
  emptyStateText: {
    fontSize: FontSizes.lg,
    color: Colors.textSecondary,
    fontWeight: FontWeights.medium,
  },
  emptyStateHint: {
    fontSize: FontSizes.sm,
    color: Colors.textTertiary,
    marginTop: Spacing.xs,
    textAlign: 'center',
    paddingHorizontal: Spacing.xxl,
  },

  // ── Error box ─────────────────────────────────────────────────
  errorBox: {
    backgroundColor: Colors.dangerLight,
    borderRadius: Radii.lg,
    padding: Spacing.lg,
  },

  // ── Debts Tab ─────────────────────────────────────────────────
  balanceRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    backgroundColor: Colors.surface,
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.md + 2,
    borderRadius: Radii.sm,
  },
  balanceRowAlt: {
    backgroundColor: Colors.borderLight,
  },
  balanceName: { fontSize: FontSizes.md, color: Colors.text, fontWeight: FontWeights.regular },
  balanceAmount: { fontSize: FontSizes.md, fontWeight: FontWeights.semibold, color: Colors.text },
  positive: { color: Colors.success },
  negative: { color: Colors.danger },
  settledBox: {
    backgroundColor: Colors.successLight,
    padding: Spacing.xl,
    borderRadius: Radii.md,
    alignItems: 'center',
  },
  settledText: {
    fontSize: FontSizes.lg,
    color: Colors.successDark,
    fontWeight: FontWeights.medium,
  },
  suggestionRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    backgroundColor: Colors.accentLight,
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.md + 2,
    borderRadius: Radii.sm,
    borderLeftWidth: 4,
    borderLeftColor: Colors.accentDark,
  },
  suggestionText: {
    fontSize: FontSizes.md,
    color: Colors.accentDark,
    fontWeight: FontWeights.medium,
    flex: 1,
  },
  suggestionAmount: {
    fontSize: FontSizes.md,
    fontWeight: FontWeights.bold,
    color: Colors.accentDark,
  },
  pendingRow: {
    backgroundColor: Colors.infoLight,
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.md,
    borderRadius: Radii.sm,
    gap: Spacing.xs,
    borderLeftWidth: 4,
    borderLeftColor: Colors.info,
  },
  pendingText: {
    fontSize: FontSizes.sm,
    color: Colors.info,
    fontWeight: FontWeights.medium,
  },
  pendingStatus: { fontSize: FontSizes.sm, color: Colors.info, opacity: 0.8 },

  // ── Expenses Tab ──────────────────────────────────────────────
  expenseCard: {
    backgroundColor: Colors.surface,
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.md + 2,
    borderRadius: Radii.md,
    gap: Spacing.xs + 2,
  },
  expenseCardBorder: {
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
    borderBottomLeftRadius: 0,
    borderBottomRightRadius: 0,
  },
  cancelled: { opacity: 0.5 },
  cancelledText: { textDecorationLine: 'line-through' },
  expenseHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  expenseDesc: {
    fontSize: FontSizes.md,
    fontWeight: FontWeights.medium,
    color: Colors.text,
    flex: 1,
    marginRight: Spacing.sm,
  },
  expenseAmount: {
    fontSize: FontSizes.md,
    fontWeight: FontWeights.semibold,
    color: Colors.text,
  },
  expenseMeta: { fontSize: FontSizes.sm, color: Colors.textTertiary },
  sharesContainer: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.sm,
    marginTop: Spacing.xs,
  },
  shareItem: {
    fontSize: FontSizes.xs,
    color: Colors.textSecondary,
    backgroundColor: Colors.borderLight,
    paddingHorizontal: Spacing.sm,
    paddingVertical: 3,
    borderRadius: Radii.sm - 2,
  },
  cancelBtn: {
    alignSelf: 'flex-start',
    marginTop: Spacing.xs,
    paddingVertical: Spacing.xs + 2,
    paddingHorizontal: Spacing.md,
    borderRadius: Radii.sm,
    borderWidth: 1,
    borderColor: Colors.danger,
  },
  cancelBtnText: {
    color: Colors.danger,
    fontSize: FontSizes.sm,
    fontWeight: FontWeights.medium,
  },

  // ── Payments Tab ──────────────────────────────────────────────
  paymentCard: {
    backgroundColor: Colors.surface,
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.md + 2,
    borderRadius: Radii.md,
    gap: Spacing.xs,
    ...Shadows.sm,
  },
  paymentHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  paymentText: {
    fontSize: FontSizes.md,
    fontWeight: FontWeights.medium,
    color: Colors.text,
    flex: 1,
  },
  paymentAmount: {
    fontSize: FontSizes.md,
    fontWeight: FontWeights.semibold,
    color: Colors.text,
  },
  paymentStatusBadge: {
    alignSelf: 'flex-start',
  },
  paymentStatusText: {
    fontSize: FontSizes.sm,
    fontWeight: FontWeights.medium,
    color: Colors.textSecondary,
  },
  paymentStatusConfirmed: { color: Colors.success },
  paymentStatusRejected: { color: Colors.danger },
  paymentStatusPending: { color: Colors.warning },
  paymentStatusDisputed: { color: Colors.warningDark },
  paymentStatusCancelled: { color: Colors.textTertiary },
  paymentNote: {
    fontSize: FontSizes.sm,
    color: Colors.textSecondary,
    fontStyle: 'italic',
  },
  paymentDate: { fontSize: FontSizes.xs, color: Colors.textTertiary },
  respondActions: {
    flexDirection: 'row',
    gap: Spacing.md,
    marginTop: Spacing.sm,
  },
  confirmBtn: {
    flex: 1,
    backgroundColor: Colors.success,
    borderRadius: Radii.sm,
    paddingVertical: Spacing.sm + 2,
    alignItems: 'center',
    ...Shadows.sm,
  },
  confirmBtnText: {
    color: Colors.textInverse,
    fontSize: FontSizes.sm,
    fontWeight: FontWeights.semibold,
  },
  rejectBtn: {
    flex: 1,
    backgroundColor: Colors.surface,
    borderRadius: Radii.sm,
    paddingVertical: Spacing.sm + 2,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: Colors.danger,
  },
  rejectBtnText: {
    color: Colors.danger,
    fontSize: FontSizes.sm,
    fontWeight: FontWeights.semibold,
  },

  // ── Quick actions ─────────────────────────────────────────────
  quickActions: {
    flexDirection: 'row',
    gap: Spacing.sm,
    marginTop: Spacing.lg,
    flexWrap: 'wrap',
    justifyContent: 'center',
  },
  quickActionBtn: {
    backgroundColor: Colors.primaryLight,
    borderRadius: Radii.full,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
    minHeight: 36,
    justifyContent: 'center',
  },
  quickActionText: {
    fontSize: FontSizes.sm,
    color: Colors.primaryDark,
    fontWeight: FontWeights.medium,
  },

  // ── View all debts ────────────────────────────────────────────
  viewAllDebtsBtn: {
    backgroundColor: Colors.surface,
    borderRadius: Radii.md,
    paddingVertical: Spacing.md + 2,
    alignItems: 'center',
    borderWidth: 1.5,
    borderColor: Colors.primary,
    marginTop: Spacing.xs,
  },
  viewAllDebtsText: {
    fontSize: FontSizes.md,
    color: Colors.primary,
    fontWeight: FontWeights.semibold,
  },

  // ── REV-S5: chỉ xem ──────────────────────────────────────────
  readOnlyBanner: {
    marginHorizontal: Spacing.lg,
    marginVertical: Spacing.md,
    padding: Spacing.lg,
    borderRadius: Radii.md,
    gap: Spacing.xs,
    backgroundColor: Colors.primaryLight,
    borderWidth: 1,
    borderColor: Colors.primaryMuted,
  },
  readOnlyTitle: {
    fontSize: FontSizes.md,
    fontWeight: FontWeights.semibold,
    color: Colors.primaryDark,
  },
  readOnlyText: {
    fontSize: FontSizes.sm,
    color: Colors.primaryDark,
    opacity: 0.8,
    lineHeight: 18,
  },

  // ── REV-S6: tình trạng cá nhân + nhãn "Chưa đồng bộ" ────────
  myPositionBox: {
    backgroundColor: Colors.primaryLight,
    padding: Spacing.lg,
    borderRadius: Radii.md,
    marginBottom: Spacing.sm,
    borderLeftWidth: 4,
    borderLeftColor: Colors.primary,
  },
  myPositionText: {
    fontSize: FontSizes.md,
    fontWeight: FontWeights.semibold,
    color: Colors.primaryDark,
  },
  unsyncedLabel: {
    fontSize: FontSizes.sm,
    color: Colors.warningDark,
    marginBottom: Spacing.xs,
  },

  // ── APP-08: Chưa đồng bộ ─────────────────────────────────────
  unsyncedRow: {
    backgroundColor: Colors.warningLight,
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.md,
    borderRadius: Radii.sm,
    gap: 2,
    borderLeftWidth: 4,
    borderLeftColor: Colors.warning,
  },
  unsyncedText: {
    fontSize: FontSizes.sm,
    color: Colors.warningDark,
    fontWeight: FontWeights.medium,
  },
  unsyncedBadge: { fontSize: FontSizes.xs, color: Colors.warningDark },
  unsyncedFailed: { fontSize: FontSizes.xs, color: Colors.dangerDark },

  // ── Bottom spacer ─────────────────────────────────────────────
  bottomSpacer: { height: Spacing.xxl },
});
