import { useQuery, useQueryClient } from '@tanstack/react-query';
import * as Crypto from 'expo-crypto';
import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { toUserMessage } from '@/api/errors';
import { fetchPayment } from '@/api/payments';
import { formatVND } from '@/domain/money';
import { useAuth } from '@/hooks/use-auth';
import { submitAction, type QueueAction } from '@/offline';

export default function PaymentDetailScreen() {
  const { id: paymentId } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { user } = useAuth();
  const queryClient = useQueryClient();

  const [processing, setProcessing] = useState(false);
  const [showDisputeInput, setShowDisputeInput] = useState(false);
  const [disputeReason, setDisputeReason] = useState('');

  const paymentQ = useQuery({
    queryKey: ['payment', paymentId],
    queryFn: () => fetchPayment(paymentId),
  });

  const invalidateAll = () => {
    queryClient.invalidateQueries({ queryKey: ['payment', paymentId] });
    queryClient.invalidateQueries({ queryKey: ['payments'] });
    queryClient.invalidateQueries({ queryKey: ['groups'] });
  };

  // APP-07: chặn bấm hai lần bằng ref đồng bộ
  const processingRef = useRef(false);

  /**
   * APP-08: Xác nhận / từ chối / báo sai lệch / hủy đều đi qua hàng đợi:
   * ghi hàng đợi trước, gửi ngay; mất mạng thì báo "Chưa đồng bộ" và tự gửi lại.
   * @returns true nếu đã gửi được hoặc đã vào hàng đợi
   */
  const runAction = async (
    action: Exclude<QueueAction, 'create_expense' | 'create_payment'>,
    successTitle: string,
    successMessage: string,
    fallbackError: string,
    reason?: string,
  ): Promise<boolean> => {
    if (processingRef.current || !user) return false;
    processingRef.current = true;
    setProcessing(true);
    try {
      // REV-A11: chưa có thanh toán trong cache → đọc lại để payload có groupId
      // (màn nhóm dựa vào groupId để hiện "Chưa đồng bộ"); mất mạng thì vẫn ghi hàng đợi.
      let groupId = paymentQ.data?.group_id;
      if (!groupId) {
        try {
          groupId = (await queryClient.fetchQuery({
            queryKey: ['payment', paymentId],
            queryFn: () => fetchPayment(paymentId),
          })).group_id;
        } catch (e) {
          console.warn('[Payment] Không lấy được groupId trước khi gửi thao tác:', e);
        }
      }
      const res = await submitAction(
        action,
        { paymentId, groupId, reason },
        Crypto.randomUUID(),
        user.id,
      );
      invalidateAll();
      if (res.status === 'queued') {
        Alert.alert('Chưa đồng bộ', 'Thao tác đã được lưu và sẽ tự gửi khi có mạng.');
      } else {
        Alert.alert(successTitle, successMessage);
      }
      return true;
    } catch (err: any) {
      Alert.alert('Lỗi', toUserMessage(err, fallbackError));
      return false;
    } finally {
      processingRef.current = false;
      setProcessing(false);
    }
  };

  const handleConfirm = () => {
    Alert.alert('Xác nhận thanh toán', 'Bạn có chắc đã nhận được khoản thanh toán này?', [
      { text: 'Không', style: 'cancel' },
      {
        text: 'Xác nhận',
        onPress: () => {
          runAction('confirm_payment', 'Thành công', 'Đã xác nhận thanh toán', 'Không thể xác nhận');
        },
      },
    ]);
  };

  const handleReject = () => {
    Alert.alert('Từ chối thanh toán', 'Bạn có chắc muốn từ chối khoản thanh toán này?', [
      { text: 'Không', style: 'cancel' },
      {
        text: 'Từ chối',
        style: 'destructive',
        onPress: () => {
          runAction('reject_payment', 'Đã từ chối', 'Khoản thanh toán đã bị từ chối', 'Không thể từ chối');
        },
      },
    ]);
  };

  const handleCancel = () => {
    Alert.alert('Hủy thanh toán', 'Bạn có chắc muốn hủy yêu cầu thanh toán này?', [
      { text: 'Không', style: 'cancel' },
      {
        text: 'Hủy thanh toán',
        style: 'destructive',
        onPress: async () => {
          const ok = await runAction('cancel_payment', 'Đã hủy', 'Yêu cầu thanh toán đã được hủy', 'Không thể hủy');
          if (ok) router.back();
        },
      },
    ]);
  };

  const handleDispute = async () => {
    if (!disputeReason.trim()) {
      Alert.alert('Lỗi', 'Vui lòng nhập lý do báo sai lệch');
      return;
    }
    const ok = await runAction(
      'dispute_payment',
      'Đã gửi',
      'Đã báo sai lệch. Người gửi có thể hủy rồi gửi lại thanh toán đúng.',
      'Không thể báo sai lệch',
      disputeReason.trim(),
    );
    if (ok) {
      setShowDisputeInput(false);
      setDisputeReason('');
    }
  };

  if (paymentQ.isLoading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color="#007AFF" />
      </View>
    );
  }

  if (paymentQ.error || !paymentQ.data) {
    return (
      <View style={styles.center}>
        <Text style={styles.errorText}>Không thể tải thông tin thanh toán</Text>
        <Pressable style={styles.retryBtn} onPress={() => paymentQ.refetch()}>
          <Text style={styles.retryBtnText}>Thử lại</Text>
        </Pressable>
      </View>
    );
  }

  const payment = paymentQ.data;
  const senderName = (payment.sender as any)?.display_name || payment.from_id?.slice(0, 8) || '';
  const receiverName = (payment.receiver as any)?.display_name || payment.to_id?.slice(0, 8) || '';
  const isSender = payment.from_id === user?.id;
  const isReceiver = payment.to_id === user?.id;

  const statusConfig: Record<string, { icon: string; label: string; color: string; bg: string }> = {
    PENDING: { icon: '⏳', label: 'Chờ xác nhận', color: '#FF9500', bg: '#FFF8E1' },
    CONFIRMED: { icon: '✅', label: 'Đã xác nhận', color: '#2E7D32', bg: '#E8F5E9' },
    REJECTED: { icon: '❌', label: 'Đã từ chối', color: '#C62828', bg: '#FFEBEE' },
    DISPUTED: { icon: '⚠️', label: 'Báo sai lệch', color: '#E65100', bg: '#FFF3E0' },
    CANCELLED: { icon: '🚫', label: 'Đã hủy', color: '#666', bg: '#f2f2f7' },
  };

  const status = statusConfig[payment.status] || statusConfig.PENDING;

  return (
    <SafeAreaView style={styles.container} edges={['bottom']}>
      <ScrollView contentContainerStyle={styles.content}>
        {/* Card 1: Số tiền & trạng thái */}
        <View style={styles.card}>
          <Text style={styles.amountLarge}>{formatVND(Number(payment.amount))}</Text>
          <View style={styles.statusRow}>
            <View style={[styles.statusBadge, { backgroundColor: status.bg }]}>
              <Text style={[styles.statusText, { color: status.color }]}>
                {status.icon} {status.label}
              </Text>
            </View>
          </View>
        </View>

        {/* Card 2: Người gửi & nhận */}
        <View style={styles.card}>
          <View style={styles.transferRow}>
            <View style={styles.personBox}>
              <Text style={styles.personLabel}>Người gửi</Text>
              <Text style={styles.personName}>
                {senderName}
                {isSender ? ' (bạn)' : ''}
              </Text>
            </View>
            <Text style={styles.arrow}>→</Text>
            <View style={styles.personBox}>
              <Text style={styles.personLabel}>Người nhận</Text>
              <Text style={styles.personName}>
                {receiverName}
                {isReceiver ? ' (bạn)' : ''}
              </Text>
            </View>
          </View>
        </View>

        {/* Card 3: Ghi chú */}
        {payment.note ? (
          <View style={styles.card}>
            <Text style={styles.cardLabel}>Ghi chú</Text>
            <Text style={styles.noteText}>{payment.note}</Text>
          </View>
        ) : null}

        {/* Card 4: Lý do tranh chấp */}
        {payment.reason ? (
          <View style={styles.card}>
            <Text style={styles.cardLabel}>
              {payment.status === 'REJECTED' ? 'Lý do từ chối' : 'Lý do báo sai lệch'}
            </Text>
            <Text style={styles.reasonText}>{payment.reason}</Text>
          </View>
        ) : null}

        {/* Card 5: Thông tin */}
        <View style={styles.card}>
          <Text style={styles.cardLabel}>Thông tin</Text>
          <View style={styles.infoRow}>
            <Text style={styles.infoLabel}>Ngày tạo</Text>
            <Text style={styles.infoValue}>
              {new Date(payment.created_at).toLocaleDateString('vi-VN', {
                day: '2-digit', month: '2-digit', year: 'numeric',
                hour: '2-digit', minute: '2-digit',
              })}
            </Text>
          </View>
          {payment.decided_at && (
            <View style={styles.infoRow}>
              <Text style={styles.infoLabel}>Ngày xử lý</Text>
              <Text style={styles.infoValue}>
                {new Date(payment.decided_at).toLocaleDateString('vi-VN', {
                  day: '2-digit', month: '2-digit', year: 'numeric',
                  hour: '2-digit', minute: '2-digit',
                })}
              </Text>
            </View>
          )}
          {payment.method && (
            <View style={styles.infoRow}>
              <Text style={styles.infoLabel}>Phương thức</Text>
              <Text style={styles.infoValue}>{payment.method}</Text>
            </View>
          )}
        </View>

        {/* Actions: PENDING + receiver → Xác nhận / Từ chối */}
        {payment.status === 'PENDING' && isReceiver && (
          <View style={styles.actions}>
            <Pressable
              style={[styles.confirmBtn, processing && styles.btnDisabled]}
              onPress={handleConfirm}
              disabled={processing}
            >
              {processing ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <Text style={styles.confirmBtnText}>✓ Xác nhận</Text>
              )}
            </Pressable>
            <Pressable
              style={[styles.rejectBtn, processing && styles.btnDisabled]}
              onPress={handleReject}
              disabled={processing}
            >
              <Text style={styles.rejectBtnText}>✗ Từ chối</Text>
            </Pressable>
          </View>
        )}

        {/* NEW-07: Người gửi hủy được khi PENDING hoặc DISPUTED (hủy rồi gửi lại khoản đúng) */}
        {(payment.status === 'PENDING' || payment.status === 'DISPUTED') && isSender && (
          <Pressable
            style={[styles.cancelBtn, processing && styles.btnDisabled]}
            onPress={handleCancel}
            disabled={processing}
          >
            <Text style={styles.cancelBtnText}>🚫 Hủy yêu cầu thanh toán</Text>
          </Pressable>
        )}

        {/* NEW-07 (BE-11): Người nhận báo sai lệch khi thanh toán còn PENDING */}
        {payment.status === 'PENDING' && isReceiver && !showDisputeInput && (
          <Pressable
            style={styles.disputeBtn}
            onPress={() => setShowDisputeInput(true)}
          >
            <Text style={styles.disputeBtnText}>⚠️ Báo sai lệch (số tiền / chưa nhận được)</Text>
          </Pressable>
        )}

        {/* Form báo sai lệch */}
        {showDisputeInput && payment.status === 'PENDING' && isReceiver && (
          <View style={styles.card}>
            <Text style={styles.cardLabel}>Lý do báo sai lệch</Text>
            <TextInput
              style={styles.disputeInput}
              placeholder="Nhập lý do báo sai lệch..."
              placeholderTextColor="#999"
              value={disputeReason}
              onChangeText={setDisputeReason}
              multiline
              numberOfLines={3}
            />
            <View style={styles.disputeActions}>
              <Pressable
                style={[styles.submitDisputeBtn, processing && styles.btnDisabled]}
                onPress={handleDispute}
                disabled={processing}
              >
                {processing ? (
                  <ActivityIndicator color="#fff" />
                ) : (
                  <Text style={styles.submitDisputeBtnText}>Gửi báo sai lệch</Text>
                )}
              </Pressable>
              <Pressable
                style={styles.cancelDisputeBtn}
                onPress={() => {
                  setShowDisputeInput(false);
                  setDisputeReason('');
                }}
              >
                <Text style={styles.cancelDisputeBtnText}>Hủy</Text>
              </Pressable>
            </View>
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
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
  },
  statusBadge: {
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 12,
  },
  statusText: { fontSize: 14, fontWeight: '600' },

  transferRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  personBox: { flex: 1, alignItems: 'center', gap: 4 },
  personLabel: { fontSize: 12, color: '#8E8E93', textTransform: 'uppercase', letterSpacing: 0.5 },
  personName: { fontSize: 16, fontWeight: '600', color: '#1a1a1a' },
  arrow: { fontSize: 24, color: '#C7C7CC', marginHorizontal: 12 },

  cardLabel: {
    fontSize: 13,
    fontWeight: '600',
    color: '#8E8E93',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  noteText: { fontSize: 15, color: '#1a1a1a', lineHeight: 22 },
  reasonText: { fontSize: 15, color: '#E65100', lineHeight: 22 },

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
  confirmBtn: {
    flex: 1,
    backgroundColor: '#34C759',
    borderRadius: 12,
    padding: 16,
    alignItems: 'center',
  },
  confirmBtnText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  rejectBtn: {
    flex: 1,
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 16,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#FF3B30',
  },
  rejectBtnText: { color: '#FF3B30', fontSize: 16, fontWeight: '600' },

  cancelBtn: {
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 16,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#FF3B30',
    marginTop: 4,
  },
  cancelBtnText: { color: '#FF3B30', fontSize: 16, fontWeight: '600' },

  disputeBtn: {
    backgroundColor: '#FFF3E0',
    borderRadius: 12,
    padding: 16,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#FFB300',
    marginTop: 4,
  },
  disputeBtnText: { color: '#E65100', fontSize: 16, fontWeight: '600' },

  disputeInput: {
    borderWidth: 1,
    borderColor: '#ddd',
    borderRadius: 10,
    padding: 12,
    fontSize: 15,
    backgroundColor: '#fafafa',
    color: '#1a1a1a',
    minHeight: 80,
    textAlignVertical: 'top',
  },
  disputeActions: { flexDirection: 'row', gap: 12 },
  submitDisputeBtn: {
    flex: 1,
    backgroundColor: '#FF9500',
    borderRadius: 10,
    padding: 14,
    alignItems: 'center',
  },
  submitDisputeBtnText: { color: '#fff', fontSize: 15, fontWeight: '600' },
  cancelDisputeBtn: {
    flex: 1,
    backgroundColor: '#f2f2f7',
    borderRadius: 10,
    padding: 14,
    alignItems: 'center',
  },
  cancelDisputeBtnText: { color: '#666', fontSize: 15, fontWeight: '600' },

  btnDisabled: { opacity: 0.6 },
});
