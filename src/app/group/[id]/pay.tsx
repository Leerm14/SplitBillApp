import { useQuery, useQueryClient } from '@tanstack/react-query';
import * as Crypto from 'expo-crypto';
import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useEffect, useMemo, useRef, useState } from 'react';
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

import { fetchExpenses } from '@/api/expenses';
import { fetchGroup, fetchGroupMembers } from '@/api/groups';
import { fetchPayments, createPayment } from '@/api/payments';
import { enqueue } from '@/offline';
import { formatVND, parseVND } from '@/domain/money';
import {
  computeBalances,
  simplifyDebts,
  type ExpenseInput,
  type PaymentInput,
} from '@/domain/settlement';
import { pairwiseDebts } from '@/domain/pairwise';
import { useAuth } from '@/hooks/use-auth';

export default function PayScreen() {
  const { id: groupId } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { user } = useAuth();
  const queryClient = useQueryClient();

  const [toId, setToId] = useState('');
  const [amountText, setAmountText] = useState('');
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);
  // APP-07: Generate idempotency key per form lifecycle, not per submit
  const idempotencyKeyRef = useRef(Crypto.randomUUID());

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

  // APP-06: Fetch group to check simplify_debts setting
  const groupQ = useQuery({
    queryKey: ['group', groupId],
    queryFn: () => fetchGroup(groupId),
  });

  // Tính gợi ý cho user hiện tại
  const mySuggestion = useMemo(() => {
    if (!membersQ.data || !expensesQ.data || !paymentsQ.data || !user) return null;

    const memberIds = membersQ.data.map((m: any) => m.id);
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
      const projectedBal = computeBalances(memberIds, expenses, payments, { includePending: true });
      // APP-06: Respect group setting for simplify_debts
      if (groupQ.data?.simplify_debts === false) {
        const pairDebts = pairwiseDebts(memberIds, expenses, payments, { includePending: true });
        return pairDebts.find((s) => s.from === user.id) || null;
      }
      const suggestions = simplifyDebts(projectedBal);
      return suggestions.find((s) => s.from === user.id) || null;
    } catch {
      return null;
    }
  }, [membersQ.data, expensesQ.data, paymentsQ.data, user, groupQ.data]);

  // APP-14: Pre-fill từ gợi ý (useEffect thay vì useMemo để tránh setState trong render)
  useEffect(() => {
    if (mySuggestion && !toId && !amountText) {
      setToId(mySuggestion.to);
      setAmountText(String(mySuggestion.amount));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- chỉ chạy khi mySuggestion thay đổi
  }, [mySuggestion]);

  const amount = parseVND(amountText);
  const isAmountValid = amount !== null && amount > 0;

  const handleSubmit = async () => {
    if (!toId) {
      Alert.alert('Lỗi', 'Vui lòng chọn người nhận');
      return;
    }
    if (!isAmountValid) {
      Alert.alert('Lỗi', 'Vui lòng nhập số tiền hợp lệ');
      return;
    }

    setSubmitting(true);
    // APP-07: Use ref-based idempotency key (generated per form lifecycle)
    const currentKey = idempotencyKeyRef.current;
    try {
      await createPayment({
        group_id: groupId,
        to_id: toId,
        amount: amount!,
        note: note.trim() || undefined,
        idempotency_key: currentKey,
      });
      // APP-07: Reset key after successful submit
      idempotencyKeyRef.current = Crypto.randomUUID();
      queryClient.invalidateQueries({ queryKey: ['payments', groupId] });
      queryClient.invalidateQueries({ queryKey: ['expenses', groupId] });
      queryClient.invalidateQueries({ queryKey: ['groups'] });
      Alert.alert('Thành công', 'Đã gửi yêu cầu thanh toán. Chờ người nhận xác nhận.');
      router.back();
    } catch (err: any) {
      // Lỗi mạng → lưu vào hàng đợi offline
      const msg = String(err.message || '').toLowerCase();
      if (msg.includes('network') || msg.includes('fetch') || msg.includes('failed to fetch')) {
        try {
          await enqueue('create_payment', {
            groupId, toId, amount, note: note.trim() || undefined, idempotencyKey: currentKey,
          }, currentKey);
          Alert.alert('Đã lưu', 'Thanh toán sẽ được gửi khi có mạng.');
          router.back();
          return;
        } catch { /* bỏ qua lỗi enqueue */ }
      }
      Alert.alert('Lỗi', err.message || 'Không thể gửi thanh toán');
    } finally {
      setSubmitting(false);
    }
  };

  const members = membersQ.data || [];
  const otherMembers = members.filter((m: any) => m.id !== user?.id);
  const getName = (id: string) => members.find((m: any) => m.id === id)?.displayName || id.slice(0, 8);

  const isLoading = membersQ.isLoading || expensesQ.isLoading || paymentsQ.isLoading;

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
        <Text style={{ fontSize: 16, color: '#FF3B30', textAlign: 'center' }}>
          ⚠️ {(queryError as Error).message || 'Không thể tải dữ liệu'}
        </Text>
      </View>
    );
  }

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      style={styles.flex}
    >
      <ScrollView style={styles.container} contentContainerStyle={styles.content}>
        {/* Gợi ý */}
        {mySuggestion && (
          <View style={styles.suggestion}>
            <Text style={styles.suggestionLabel}>💡 Gợi ý tất toán</Text>
            <Text style={styles.suggestionText}>
              Chuyển {getName(mySuggestion.to)} {formatVND(mySuggestion.amount)}
            </Text>
          </View>
        )}

        {/* Người nhận */}
        <Text style={styles.label}>Người nhận</Text>
        <View style={styles.memberList}>
          {otherMembers.map((m: any) => (
            <Pressable
              key={m.id}
              style={[styles.memberChip, toId === m.id && styles.memberChipActive]}
              onPress={() => setToId(m.id)}
            >
              <Text style={[styles.memberChipText, toId === m.id && styles.memberChipTextActive]}>
                {m.displayName || m.id.slice(0, 8)}
              </Text>
            </Pressable>
          ))}
        </View>

        {/* Số tiền */}
        <Text style={styles.label}>Số tiền (VND)</Text>
        <TextInput
          style={styles.input}
          placeholder="0"
          placeholderTextColor="#999"
          value={amountText}
          onChangeText={setAmountText}
          keyboardType="numeric"
        />
        {isAmountValid && (
          <Text style={styles.amountPreview}>{formatVND(amount)}</Text>
        )}

        {/* APP-17: Cảnh báo vượt mức gợi ý (BR-07) — so sánh với gợi ý cụ thể cho người nhận đã chọn */}
        {isAmountValid && (() => {
          // Tìm gợi ý cho chính recipient đã chọn (toId)
          if (!toId || !mySuggestion) return null;
          // Nếu gợi ý là cho chính người nhận đã chọn → hiển thị cảnh báo khi vượt mức
          if (mySuggestion.to === toId && amount > mySuggestion.amount) {
            return (
              <View style={styles.warningBanner}>
                <Text style={styles.warningText}>
                  ⚠️ Số tiền vượt mức gợi ý {formatVND(mySuggestion.amount)}. Bạn có chắc chắn?
                </Text>
              </View>
            );
          }
          return null;
        })()}

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

