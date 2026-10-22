import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Image } from 'expo-image';
import React, { useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { toUserMessage } from '@/api/errors';
import { cancelExpense, fetchExpense } from '@/api/expenses';
import { isActiveMember } from '@/api/groups';
import { ReceiptViewer } from '@/components/receipt-image';
import { formatVND } from '@/domain/money';
import { useAuth } from '@/hooks/use-auth';
import { useGroupAccess } from '@/hooks/use-group-settlement';
import { useReceiptUrl } from '@/hooks/use-receipt-url';

export default function ExpenseDetailScreen() {
  const { id: groupId, expenseId } = useLocalSearchParams<{ id: string; expenseId: string }>();
  const router = useRouter();
  const { user } = useAuth();
  const queryClient = useQueryClient();

  const expenseQ = useQuery({
    queryKey: ['expense', expenseId],
    queryFn: () => fetchExpense(expenseId),
  });

  // REV-S5 / REV-S10: quyền ghi của mình + trạng thái thành viên của người tham gia khoản chi
  const { groupQ, membersQ, canWrite, isViewerActive } = useGroupAccess(groupId);
  // MVP-01: Ảnh hóa đơn — signed URL ngắn hạn (chỉ thành viên nhóm lấy được)
  const receiptQ = useReceiptUrl(expenseQ.data?.receipt_path);
  const receiptUrl = receiptQ.data ?? null;
  const [receiptFullscreen, setReceiptFullscreen] = useState(false);

  const handleCancel = () => {
    Alert.alert('Hủy khoản chi', 'Bạn có chắc muốn hủy khoản chi này?', [
      { text: 'Không', style: 'cancel' },
      {
        text: 'Hủy khoản chi',
        style: 'destructive',
        onPress: async () => {
          try {
            await cancelExpense(expenseId);
            queryClient.invalidateQueries({ queryKey: ['expense', expenseId] });
            queryClient.invalidateQueries({ queryKey: ['expenses', groupId] });
            queryClient.invalidateQueries({ queryKey: ['groups'] });
            router.back();
          } catch (err: any) {
            Alert.alert('Lỗi', toUserMessage(err, 'Không thể hủy khoản chi'));
          }
        },
      },
    ]);
  };

  if (expenseQ.isLoading || groupQ.isLoading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color="#007AFF" />
      </View>
    );
  }

  if (expenseQ.error || !expenseQ.data) {
    return (
      <View style={styles.center}>
        <Text style={styles.errorText}>Không thể tải khoản chi</Text>
        <Pressable style={styles.retryBtn} onPress={() => expenseQ.refetch()}>
          <Text style={styles.retryBtnText}>Thử lại</Text>
        </Pressable>
      </View>
    );
  }

  const expense = expenseQ.data;
  const isActive = expense.status === 'ACTIVE';
  const canManage = expense.created_by === user?.id || groupQ.data?.owner_id === user?.id;
  // REV-S10: có người trả / người chịu không còn ACTIVE → server từ chối (PARTICIPANT_NOT_ACTIVE)
  const members = membersQ.data ?? [];
  const inactiveParticipants = members.length
    ? [expense.paid_by, ...(expense.expense_shares || []).map((s) => s.user_id)]
        .filter((uid, i, arr) => arr.indexOf(uid) === i)
        .filter((uid) => {
          const m = members.find((x) => x.id === uid);
          return !m || !isActiveMember(m);
        })
    : [];
  const nameOf = (uid: string) =>
    uid === user?.id ? 'Bạn' : members.find((m) => m.id === uid)?.displayName || uid.slice(0, 8);
  const canEdit = isActive && canWrite && inactiveParticipants.length === 0;

  const splitMethodLabel = (method: string) => {
    switch (method) {
      case 'EQUAL': return 'Chia đều';
      case 'PERCENT': return 'Phần trăm';
      case 'EXACT': return 'Số tiền';
      default: return method || 'Chia đều';
    }
  };

  const getPayerName = () => {
    const payer = expense.payer as any;
    if (payer?.display_name) return payer.display_name;
    return expense.paid_by?.slice(0, 8) || '';
  };

  const getCreatorName = () => {
    const creator = expense.creator as any;
    if (creator?.display_name) return creator.display_name;
    return expense.created_by?.slice(0, 8) || '';
  };

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      {/* Card 1: Số tiền & trạng thái */}
      <View style={styles.card}>
        <Text style={styles.amountLarge}>{formatVND(Number(expense.amount))}</Text>
        <View style={styles.statusRow}>
          <View style={[styles.statusBadge, isActive ? styles.badgeActive : styles.badgeCancelled]}>
            <Text style={[styles.statusText, isActive ? styles.statusActive : styles.statusCancelled]}>
              {isActive ? 'Đang hoạt động' : 'Đã hủy'}
            </Text>
          </View>
          <Text style={styles.dateText}>
            {new Date(expense.created_at).toLocaleDateString('vi-VN', {
              day: '2-digit', month: '2-digit', year: 'numeric',
              hour: '2-digit', minute: '2-digit',
            })}
          </Text>
        </View>
      </View>

      {/* Card 2: Người trả */}
      <View style={styles.card}>
        <Text style={styles.cardLabel}>Người trả</Text>
        <Text style={styles.cardValue}>
          {getPayerName()}
          {expense.paid_by === user?.id ? ' (bạn)' : ''}
        </Text>
      </View>

      {/* Card 3: Phần chia */}
      <View style={styles.card}>
        <Text style={styles.cardLabel}>Phần chia</Text>
        {(expense.expense_shares || []).map((s: any) => {
          const shareAmount = Number(s.amount);
          const percentBp = s.percent_bp ? Number(s.percent_bp) : null;
          return (
            <View key={s.user_id} style={styles.shareRow}>
              <Text style={styles.shareName}>{nameOf(s.user_id)}</Text>
              <View style={styles.shareRight}>
                {percentBp !== null && percentBp > 0 && (
                  <Text style={styles.sharePercent}>{(percentBp / 100).toFixed(1)}%</Text>
                )}
                <Text style={styles.shareAmount}>{formatVND(shareAmount)}</Text>
              </View>
            </View>
          );
        })}
      </View>

      {/* Card 4: Ghi chú */}
      {expense.note ? (
        <View style={styles.card}>
          <Text style={styles.cardLabel}>Ghi chú</Text>
          <Text style={styles.noteText}>{expense.note}</Text>
        </View>
      ) : null}


      {/* MVP-01: Ảnh hóa đơn — chạm để xem toàn màn hình */}
      {expense.receipt_path ? (
        <View style={styles.card}>
          <Text style={styles.cardLabel}>Ảnh hóa đơn</Text>
          {receiptUrl ? (
            <Pressable onPress={() => setReceiptFullscreen(true)} accessibilityLabel="Xem ảnh hóa đơn">
              <Image source={{ uri: receiptUrl }} style={styles.receiptThumb} contentFit="cover" />
            </Pressable>
          ) : receiptQ.isLoading ? (
            <ActivityIndicator color="#007AFF" />
          ) : (
            <Pressable onPress={() => receiptQ.refetch()}>
              <Text style={styles.receiptError}>Không tải được ảnh hóa đơn. Chạm để thử lại.</Text>
            </Pressable>
          )}
        </View>
      ) : null}
      <ReceiptViewer uri={receiptUrl} visible={receiptFullscreen} onClose={() => setReceiptFullscreen(false)} />

      {/* Card 5: Thông tin */}
      <View style={styles.card}>
        <Text style={styles.cardLabel}>Thông tin</Text>
        <View style={styles.infoRow}>
          <Text style={styles.infoLabel}>Phương thức chia</Text>
          <Text style={styles.infoValue}>{splitMethodLabel(expense.split_method)}</Text>
        </View>
        <View style={styles.infoRow}>
          <Text style={styles.infoLabel}>Người tạo</Text>
          <Text style={styles.infoValue}>{getCreatorName()}</Text>
        </View>
        <View style={styles.infoRow}>
          <Text style={styles.infoLabel}>Ngày tạo</Text>
          <Text style={styles.infoValue}>
            {new Date(expense.created_at).toLocaleDateString('vi-VN')}
          </Text>
        </View>
        {expense.updated_at && expense.updated_at !== expense.created_at && (
          <View style={styles.infoRow}>
            <Text style={styles.infoLabel}>Cập nhật lần cuối</Text>
            <Text style={styles.infoValue}>
              {new Date(expense.updated_at).toLocaleDateString('vi-VN', {
                day: '2-digit', month: '2-digit', year: 'numeric',
                hour: '2-digit', minute: '2-digit',
              })}
            </Text>
          </View>
        )}
        <View style={styles.infoRow}>
          <Text style={styles.infoLabel}>Phiên bản</Text>
          <Text style={styles.infoValue}>{expense.version ?? 1}</Text>
        </View>
      </View>

      {/* REV-S5 / REV-S10: giải thích vì sao không sửa / hủy được */}
      {isActive && !canEdit && (
        <View style={styles.lockedInfo}>
          <Text style={styles.lockedInfoText}>
            {!isViewerActive
              ? 'Bạn đã rời nhóm nên không thể sửa hoặc hủy khoản chi.'
              : !canWrite
                ? 'Nhóm đã đóng nên không thể sửa hoặc hủy khoản chi.'
                : `Không thể sửa hoặc hủy: ${inactiveParticipants.map(nameOf).join(', ')} đã rời nhóm.`}
          </Text>
        </View>
      )}

      {/* Bottom actions */}
      {canEdit && (
        <View style={styles.actions}>
          <Pressable
            style={styles.editBtn}
            onPress={() => router.push(`/group/${groupId}/expense/${expenseId}/edit` as any)}
          >
            <Text style={styles.editBtnText}>✏️ Sửa</Text>
          </Pressable>
          {canManage && (
            <Pressable style={styles.cancelBtn} onPress={handleCancel}>
              <Text style={styles.cancelBtnText}>🗑 Hủy</Text>
            </Pressable>
          )}
        </View>
      )}

      {/* Cancelled info */}
      {expense.status === 'CANCELLED' && expense.cancelled_at && (
        <View style={styles.cancelledInfo}>
          <Text style={styles.cancelledInfoText}>
            Đã hủy lúc {new Date(expense.cancelled_at).toLocaleDateString('vi-VN', {
              day: '2-digit', month: '2-digit', year: 'numeric',
              hour: '2-digit', minute: '2-digit',
            })}
          </Text>
        </View>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f2f2f7' },
  content: { padding: 16, gap: 12, paddingBottom: 40 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },

  errorText: { fontSize: 16, color: '#666', marginBottom: 12 },
  retryBtn: {
    backgroundColor: '#007AFF', borderRadius: 12,
    paddingHorizontal: 24, paddingVertical: 12,
  },
  retryBtnText: { color: '#fff', fontSize: 15, fontWeight: '600' },

  card: {
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 16,
    gap: 8,
  },

  amountLarge: {
    fontSize: 32,
    fontWeight: '700',
    color: '#1a1a1a',
    textAlign: 'center',
  },
  statusRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    gap: 12,
  },
  statusBadge: {
    paddingHorizontal: 12,
    paddingVertical: 4,
    borderRadius: 12,
  },
  badgeActive: { backgroundColor: '#E8F5E9' },
  badgeCancelled: { backgroundColor: '#FFEBEE' },
  statusText: { fontSize: 13, fontWeight: '600' },
  statusActive: { color: '#2E7D32' },
  statusCancelled: { color: '#C62828' },
  dateText: { fontSize: 13, color: '#8E8E93' },

  cardLabel: {
    fontSize: 13,
    fontWeight: '600',
    color: '#8E8E93',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  cardValue: { fontSize: 17, fontWeight: '500', color: '#1a1a1a' },

  shareRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 4,
  },
  shareName: { fontSize: 15, color: '#1a1a1a' },
  shareRight: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  sharePercent: { fontSize: 13, color: '#8E8E93' },
  shareAmount: { fontSize: 15, fontWeight: '600', color: '#1a1a1a' },

  noteText: { fontSize: 15, color: '#1a1a1a', lineHeight: 22 },

  infoRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 2,
  },
  infoLabel: { fontSize: 14, color: '#8E8E93' },
  infoValue: { fontSize: 14, color: '#1a1a1a', fontWeight: '500' },

  actions: {
    flexDirection: 'row',
    gap: 12,
    marginTop: 4,
  },
  editBtn: {
    flex: 1,
    backgroundColor: '#007AFF',
    borderRadius: 12,
    padding: 14,
    alignItems: 'center',
  },
  editBtnText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  cancelBtn: {
    flex: 1,
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 14,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#FF3B30',
  },
  cancelBtnText: { color: '#FF3B30', fontSize: 16, fontWeight: '600' },

  lockedInfo: {
    backgroundColor: '#F2F2F7',
    borderRadius: 10,
    padding: 12,
    borderWidth: 1,
    borderColor: '#D1D1D6',
  },
  lockedInfoText: { fontSize: 14, color: '#666' },

  cancelledInfo: {
    backgroundColor: '#FFEBEE',
    borderRadius: 10,
    padding: 12,
    alignItems: 'center',
  },
  cancelledInfoText: { fontSize: 14, color: '#C62828' },

  // MVP-01: ảnh hóa đơn
  receiptThumb: { width: '100%', height: 200, borderRadius: 8 },
  receiptError: { fontSize: 14, color: '#FF3B30' },
});
