import { useQueryClient } from '@tanstack/react-query';
import * as Crypto from 'expo-crypto';
import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { toUserMessage } from '@/api/errors';
import { isActiveMember } from '@/api/groups';
import { ErrorState } from '@/components/error-state';
import { RecipientPaymentHandles } from '@/components/payment-handles';
import { formatVND, parseVND } from '@/domain/money';
import { useAuth } from '@/hooks/use-auth';
import { useGroupSettlement } from '@/hooks/use-group-settlement';
import { submitAction } from '@/offline';

export default function PayScreen() {
  // `to` (tùy chọn): mở từ màn chi tiết công nợ với người nhận chọn sẵn
  const { id: groupId, to: toParam } = useLocalSearchParams<{ id: string; to?: string }>();
  const router = useRouter();
  const { user } = useAuth();
  const queryClient = useQueryClient();

  // APP-14: không setState trong effect — null nghĩa là "người dùng chưa chọn/nhập", lấy theo gợi ý
  const [toIdInput, setToId] = useState<string | null>(null);
  const [amountInput, setAmountText] = useState<string | null>(null);
  // REV-S8: người dùng đã tự gõ số tiền → không tự điền lại khi đổi người nhận
  const [amountEdited, setAmountEdited] = useState(false);
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);
  // APP-07: idempotency key giữ theo form, chỉ đổi khi đã lưu (gửi được hoặc đã vào hàng đợi)
  const idempotencyKeyRef = useRef(Crypto.randomUUID());
  // APP-07: chặn bấm hai lần bằng ref đồng bộ (state cập nhật trễ một nhịp render)
  const submittingRef = useRef(false);

  // APP-06: gợi ý theo công tắc simplify_debts của nhóm (dùng chung suggestTransfers)
  const {
    membersQ,
    getName,
    settlement,
    settlementError,
    isViewerActive,
    isGroupClosed,
    canWrite,
    isLoading,
    queryError,
    refetchAll,
  } = useGroupSettlement(groupId);

  // Các gợi ý mà mình là người trả (có thể nhiều người nhận khi tắt bù trừ)
  const mySuggestions = (settlement?.suggestions ?? []).filter((t) => t.from === user?.id);

  // REV-S8: người nhận / số tiền mặc định chốt lại ở lần render đầu có dữ liệu — lần tải lại sau
  // (gợi ý đổi vì người khác vừa ghi) không âm thầm đổi số đang hiện trên form.
  const [frozenDefaults, setFrozenDefaults] = useState<{ toId: string; amountText: string } | null>(null);
  if (frozenDefaults === null && (settlement || settlementError)) {
    const defaultTo = toParam ?? mySuggestions[0]?.to ?? '';
    const defaultSuggestion = mySuggestions.find((t) => t.to === defaultTo);
    setFrozenDefaults({ toId: defaultTo, amountText: defaultSuggestion ? String(defaultSuggestion.amount) : '' });
  }

  const toId = toIdInput ?? frozenDefaults?.toId ?? toParam ?? '';
  // APP-17: gợi ý cho đúng người nhận đang chọn
  const suggestionForRecipient = mySuggestions.find((t) => t.to === toId) ?? null;
  const amountText = amountInput ?? frozenDefaults?.amountText ?? '';

  /** REV-S8: đổi người nhận do người dùng chọn — điền số gợi ý của người đó nếu chưa tự nhập số */
  const selectRecipient = (id: string, suggestedAmount?: number) => {
    setToId(id);
    if (suggestedAmount !== undefined) {
      setAmountText(String(suggestedAmount));
    } else if (!amountEdited) {
      const s = mySuggestions.find((t) => t.to === id);
      setAmountText(s ? String(s.amount) : '');
    }
  };

  const amount = parseVND(amountText);
  const isAmountValid = amount !== null && amount > 0;

  const handleSubmit = async () => {
    if (submittingRef.current) return;
    if (!user) return;
    if (!toId) {
      Alert.alert('Lỗi', 'Vui lòng chọn người nhận');
      return;
    }
    if (!isAmountValid) {
      Alert.alert('Lỗi', 'Vui lòng nhập số tiền hợp lệ');
      return;
    }

    submittingRef.current = true;
    setSubmitting(true);
    const currentKey = idempotencyKeyRef.current;
    try {
      // APP-08: ghi hàng đợi trước (kèm key), rồi gửi ngay
      const res = await submitAction(
        'create_payment',
        { groupId, toId, amount: amount!, note: note.trim() || undefined, idempotencyKey: currentKey },
        currentKey,
        user.id,
      );
      // APP-07: Reset key sau khi đã lưu
      idempotencyKeyRef.current = Crypto.randomUUID();
      queryClient.invalidateQueries({ queryKey: ['payments', groupId] });
      queryClient.invalidateQueries({ queryKey: ['groups'] });
      if (res.status === 'queued') {
        Alert.alert('Chưa đồng bộ', 'Chưa gửi được do mất kết nối. Thanh toán đã được lưu và sẽ tự gửi khi có mạng.');
      } else {
        Alert.alert('Thành công', 'Đã gửi yêu cầu thanh toán. Chờ người nhận xác nhận.');
      }
      router.back();
    } catch (err: any) {
      Alert.alert('Lỗi', toUserMessage(err, 'Không thể gửi thanh toán'));
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

  const members = membersQ.data || [];
  // NEW-03: Chỉ trả được cho thành viên ACTIVE (RPC create_payment cũng kiểm tra)
  const otherMembers = members.filter((m) => isActiveMember(m) && m.id !== user?.id);

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

  // REV-S5: đã rời nhóm / nhóm đã đóng → không cho gửi thanh toán
  if (!canWrite) {
    return (
      <ErrorState
        title={!isViewerActive ? 'Bạn đã rời nhóm' : isGroupClosed ? 'Nhóm đã đóng' : 'Không thể gửi thanh toán'}
        message="Bạn chỉ xem được dữ liệu của nhóm này, không thể gửi thanh toán mới."
      />
    );
  }

  /** APP-17 (BR-07): cảnh báo theo người nhận đang chọn */
  const renderOverpayWarning = () => {
    if (!isAmountValid || !toId || settlementError) return null;
    if (suggestionForRecipient) {
      if (amount! <= suggestionForRecipient.amount) return null;
      return (
        <View style={styles.warningBanner}>
          <Text style={styles.warningText}>
            ⚠️ Số tiền vượt mức gợi ý cho {getName(toId)} ({formatVND(suggestionForRecipient.amount)}). Bạn có chắc chắn?
          </Text>
        </View>
      );
    }
    const otherHint = mySuggestions.length > 0
      ? `, nhưng gợi ý đang là chuyển ${mySuggestions.map((t) => `${getName(t.to)} ${formatVND(t.amount)}`).join(', ')}.`
      : '.';
    return (
      <View style={styles.warningBanner}>
        <Text style={styles.warningText}>
          ⚠️ Theo gợi ý hiện tại, bạn không cần chuyển cho {getName(toId)}. Bạn vẫn có thể gửi — số dư sẽ tự cân lại{otherHint}
        </Text>
      </View>
    );
  };

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      style={styles.flex}
    >
      <ScrollView style={styles.container} contentContainerStyle={styles.content}>
        {/* APP-01: không tính được gợi ý (BR-02) — báo lỗi, vẫn cho gửi thanh toán */}
        {settlementError && (
          <ErrorState
            inline
            title="Không tính được gợi ý tất toán"
            message="Số liệu của nhóm không khớp. Lỗi đã được ghi lại."
          />
        )}

        {/* Gợi ý */}
        {mySuggestions.length > 0 && (
          <View style={styles.suggestion}>
            <Text style={styles.suggestionLabel}>💡 Gợi ý tất toán</Text>
            {mySuggestions.map((t) => (
              <Pressable key={t.to} onPress={() => selectRecipient(t.to, t.amount)}>
                <Text style={styles.suggestionText}>
                  Chuyển {getName(t.to)} {formatVND(t.amount)}
                </Text>
              </Pressable>
            ))}
          </View>
        )}

        {/* Người nhận */}
        <Text style={styles.label}>Người nhận</Text>
        <View style={styles.memberList}>
          {otherMembers.map((m) => (
            <Pressable
              key={m.id}
              style={[styles.memberChip, toId === m.id && styles.memberChipActive]}
              onPress={() => selectRecipient(m.id)}
            >
              <Text style={[styles.memberChipText, toId === m.id && styles.memberChipTextActive]}>
                {m.displayName || m.id.slice(0, 8)}
              </Text>
            </Pressable>
          ))}
        </View>

        {/* MVP-07: phương thức thanh toán của người nhận — ngân hàng hiện mã VietQR kèm số tiền / ghi chú đang nhập */}
        {toId ? (
          <View style={styles.handlesBox}>
            <Text style={styles.handlesTitle}>Thông tin chuyển khoản của {getName(toId)}</Text>
            <RecipientPaymentHandles
              userId={toId}
              name={getName(toId)}
              prefill={{ amount: isAmountValid ? amount : null, memo: note.trim() || null }}
            />
          </View>
        ) : null}

        {/* Số tiền */}
        <Text style={styles.label}>Số tiền (VND)</Text>
        <TextInput
          style={styles.input}
          placeholder="0"
          placeholderTextColor="#999"
          value={amountText}
          onChangeText={(t) => {
            setAmountEdited(true);
            setAmountText(t);
          }}
          keyboardType="numeric"
        />
        {isAmountValid && (
          <Text style={styles.amountPreview}>{formatVND(amount!)}</Text>
        )}

        {/* APP-17: Cảnh báo vượt mức gợi ý (BR-07) theo đúng người nhận đang chọn */}
        {renderOverpayWarning()}

        {/* Ghi chú */}
        <Text style={styles.label}>Ghi chú (tùy chọn)</Text>
        <TextInput
          style={styles.input}
          placeholder="Ví dụ: Chuyển qua Momo"
          placeholderTextColor="#999"
          value={note}
          onChangeText={setNote}
        />

        {/* Nút gửi */}
        <Pressable
          style={[styles.submitBtn, submitting && styles.buttonDisabled]}
          onPress={handleSubmit}
          disabled={submitting}
        >
          {submitting ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={styles.submitBtnText}>Gửi thanh toán</Text>
          )}
        </Pressable>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  container: { flex: 1, backgroundColor: '#f2f2f7' },
  content: { padding: 16, gap: 12, paddingBottom: 40 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },

  suggestion: {
    backgroundColor: '#E8F5E9',
    borderRadius: 12,
    padding: 16,
    gap: 4,
  },
  suggestionLabel: { fontSize: 13, fontWeight: '600', color: '#2E7D32' },
  suggestionText: { fontSize: 16, fontWeight: '500', color: '#1B5E20' },

  label: { fontSize: 15, fontWeight: '600', color: '#1a1a1a', marginTop: 4 },
  handlesBox: { backgroundColor: '#fff', borderRadius: 12, padding: 12, gap: 8 },
  handlesTitle: { fontSize: 14, fontWeight: '600', color: '#1a1a1a' },
  input: {
    borderWidth: 1,
    borderColor: '#ddd',
    borderRadius: 12,
    padding: 14,
    fontSize: 16,
    backgroundColor: '#fff',
    color: '#1a1a1a',
  },
  amountPreview: { fontSize: 13, color: '#007AFF', marginTop: -4 },

  memberList: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  memberChip: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 20,
    backgroundColor: '#e5e5ea',
  },
  memberChipActive: { backgroundColor: '#34C759' },
  memberChipText: { fontSize: 14, color: '#666' },
  memberChipTextActive: { color: '#fff', fontWeight: '500' },

  submitBtn: {
    backgroundColor: '#34C759',
    borderRadius: 12,
    padding: 16,
    alignItems: 'center',
    marginTop: 8,
  },
  buttonDisabled: { opacity: 0.6 },
  submitBtnText: { color: '#fff', fontSize: 16, fontWeight: '600' },

  warningBanner: {
    backgroundColor: '#FFF3E0',
    borderRadius: 10,
    padding: 12,
    borderLeftWidth: 4,
    borderLeftColor: '#FF9800',
  },
  warningText: { fontSize: 14, color: '#E65100', fontWeight: '500' },
});

