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

import { createExpense } from '@/api/expenses';
import { enqueue } from '@/offline';
import { fetchGroupMembers } from '@/api/groups';
import { formatVND, parseVND } from '@/domain/money';
import { splitEqual, splitPercent, validateShares } from '@/domain/split';
import { useAuth } from '@/hooks/use-auth';

export default function AddExpenseScreen() {
  const { id: groupId } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { user } = useAuth();
  const queryClient = useQueryClient();

  const [description, setDescription] = useState('');
  const [amountText, setAmountText] = useState('');
  const [note, setNote] = useState('');
  const [paidBy, setPaidBy] = useState(user?.id || '');
  const [splitMode, setSplitMode] = useState<'EQUAL' | 'PERCENT' | 'EXACT'>('EQUAL');
  const [selectedMembers, setSelectedMembers] = useState<Set<string>>(new Set());
  const [customAmounts, setCustomAmounts] = useState<Record<string, string>>({});
  const [percentInputs, setPercentInputs] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  // APP-07: Generate idempotency key per form lifecycle, not per submit
  const idempotencyKeyRef = useRef(Crypto.randomUUID());

  const membersQ = useQuery({
    queryKey: ['group-members', groupId],
    queryFn: () => fetchGroupMembers(groupId),
  });

  // APP-14: Khi có danh sách thành viên, chọn tất cả
  useEffect(() => {
    if (membersQ.data && selectedMembers.size === 0) {
      setSelectedMembers(new Set(membersQ.data.map((m: any) => m.id)));
      if (!paidBy && membersQ.data.length > 0) {
        setPaidBy(user?.id || membersQ.data[0].id);
      }
    }
  }, [membersQ.data]);

  const amount = parseVND(amountText) ?? 0;
  const isAmountValid = amount > 0;

  // APP-09: Tính phần chia theo phần trăm using splitPercent from domain
  const computePercentShares = (totalAmount: number, members: string[], percents: Record<string, string>) => {
    const bpList = members.map((userId) => {
      const pct = parseFloat(percents[userId] || '0');
      return { userId, bp: Math.round((isNaN(pct) ? 0 : pct) * 100) }; // convert percent to basis points
    });
    return splitPercent(totalAmount, bpList).map((s) => ({
      userId: s.user_id,
      amount: s.amount,
    }));
  };

  // Tính phần chia
  const shares = useMemo(() => {
    if (!isAmountValid || selectedMembers.size === 0) return [];

    const memberArr = [...selectedMembers];
    if (splitMode === 'EQUAL') {
      return splitEqual(amount, memberArr);
    }
    if (splitMode === 'PERCENT') {
      return computePercentShares(amount, memberArr, percentInputs);
    }
    // EXACT: parse từ text
    return memberArr.map((userId) => ({
      userId,
      amount: parseVND(customAmounts[userId] || '0') ?? 0,
    }));
  }, [amount, selectedMembers, splitMode, customAmounts, percentInputs]);

  const percentTotal = splitMode === 'PERCENT'
    ? [...selectedMembers].reduce((s, uid) => {
        const v = parseFloat(percentInputs[uid] || '0');
        return s + (isNaN(v) ? 0 : v);
      }, 0)
    : 0;

  const customTotal = splitMode === 'EXACT'
    ? shares.reduce((s, sh) => s + (isNaN(sh.amount) ? 0 : sh.amount), 0)
    : 0;

  const toggleMember = (memberId: string) => {
    const next = new Set(selectedMembers);
    if (next.has(memberId)) {
      next.delete(memberId);
    } else {
      next.add(memberId);
    }
    setSelectedMembers(next);
  };

  const handleSubmit = async () => {
    if (!isAmountValid) {
      Alert.alert('Lỗi', 'Vui lòng nhập số tiền hợp lệ');
      return;
    }
    if (selectedMembers.size === 0) {
      Alert.alert('Lỗi', 'Vui lòng chọn ít nhất 1 người chịu');
      return;
    }
    if (!description.trim()) {
      Alert.alert('Lỗi', 'Vui lòng nhập mô tả');
      return;
    }

    let finalShares = shares;
    if (splitMode === 'EQUAL') {
      finalShares = splitEqual(amount, [...selectedMembers]);
    }

    if (splitMode === 'PERCENT') {
      const roundedTotal = Math.round(percentTotal * 100) / 100;
      if (roundedTotal !== 100) {
        Alert.alert('Lỗi', `Tổng phần trăm phải bằng 100% (hiện tại: ${roundedTotal}%)`);
        return;
      }
      finalShares = computePercentShares(amount, [...selectedMembers], percentInputs);
    }

    try {
      if (splitMode === 'EXACT') {
        validateShares(amount, finalShares);
      }
    } catch (err: any) {
      Alert.alert('Lỗi', err.message);
      return;
    }

    setSubmitting(true);
    // APP-07: Use ref-based idempotency key (generated per form lifecycle)
    const currentKey = idempotencyKeyRef.current;
    try {
      await createExpense({
        groupId,
        paidBy,
        amount,
        description: description.trim(),
        shares: finalShares,
        idempotencyKey: currentKey,
        splitMethod: splitMode,
        note: note.trim(),
      });
      // APP-07: Reset key after successful submit
      idempotencyKeyRef.current = Crypto.randomUUID();
      queryClient.invalidateQueries({ queryKey: ['expenses', groupId] });
      queryClient.invalidateQueries({ queryKey: ['groups'] });
      router.back();
    } catch (err: any) {
      // Lỗi mạng → lưu vào hàng đợi offline
      const msg = String(err.message || '').toLowerCase();
      if (msg.includes('network') || msg.includes('fetch') || msg.includes('failed to fetch')) {
        try {
          await enqueue('create_expense', {
            groupId, paidBy, amount, description: description.trim(),
            shares: finalShares, idempotencyKey: currentKey, splitMethod: splitMode, note: note.trim(),
          }, currentKey);
          Alert.alert('Đã lưu', 'Thao tác sẽ được đồng bộ khi có mạng.');
          router.back();
          return;
        } catch { /* bỏ qua lỗi enqueue */ }
      }
      Alert.alert('Lỗi', err.message || 'Không thể tạo khoản chi');
    } finally {
      setSubmitting(false);
    }
  };

  if (membersQ.isLoading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color="#007AFF" />
      </View>
    );
  }

  const members = membersQ.data || [];

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      style={styles.flex}
    >
      <ScrollView style={styles.container} contentContainerStyle={styles.content}>
        {/* Mô tả */}
        <Text style={styles.label}>Mô tả</Text>
        <TextInput
          style={styles.input}
          placeholder="Bữa trưa, cà phê, ..."
          placeholderTextColor="#999"
          value={description}
          onChangeText={setDescription}
        />

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

        {/* Ghi chú */}
        <Text style={styles.label}>Ghi chú</Text>
        <TextInput
          style={styles.input}
          placeholder="Ghi chú thêm (không bắt buộc)"
          placeholderTextColor="#999"
          value={note}
          onChangeText={setNote}
        />

        {/* Người trả */}
        <Text style={styles.label}>Người trả</Text>
        <View style={styles.memberList}>
          {members.map((m: any) => (
            <Pressable
              key={m.id}
              style={[styles.memberChip, paidBy === m.id && styles.memberChipActive]}
              onPress={() => setPaidBy(m.id)}
            >
              <Text style={[styles.memberChipText, paidBy === m.id && styles.memberChipTextActive]}>
                {m.displayName || m.id.slice(0, 8)}
                {m.id === user?.id ? ' (bạn)' : ''}
              </Text>
            </Pressable>
          ))}
        </View>

        {/* Chia cho */}
        <View style={styles.splitHeader}>
          <Text style={styles.label}>Chia cho</Text>
        </View>

        {/* Segmented control */}
        <View style={styles.splitTabs}>
          {(['EQUAL', 'PERCENT', 'EXACT'] as const).map((mode) => (
            <Pressable
              key={mode}
              style={[styles.splitTab, splitMode === mode && styles.splitTabActive]}
              onPress={() => setSplitMode(mode)}
            >
              <Text style={[styles.splitTabText, splitMode === mode && styles.splitTabTextActive]}>
                {mode === 'EQUAL' ? 'Chia đều' : mode === 'PERCENT' ? 'Phần trăm' : 'Số tiền'}
              </Text>
            </Pressable>
          ))}
        </View>

        {members.map((m: any) => (
          <View key={m.id} style={styles.shareRow}>
            <Pressable
              style={[styles.checkbox, selectedMembers.has(m.id) && styles.checkboxActive]}
              onPress={() => toggleMember(m.id)}
            >
              {selectedMembers.has(m.id) && <Text style={styles.checkmark}>✓</Text>}
            </Pressable>
            <Text style={styles.shareName}>
              {m.displayName || m.id.slice(0, 8)}
            </Text>
            {splitMode === 'EQUAL' && isAmountValid && selectedMembers.has(m.id) ? (
              <Text style={styles.shareAmount}>
                {formatVND(shares.find((s) => s.userId === m.id)?.amount || 0)}
              </Text>
            ) : splitMode === 'PERCENT' && selectedMembers.has(m.id) ? (
              <View style={styles.percentContainer}>
                <TextInput
                  style={styles.shareInput}
                  placeholder="0"
                  placeholderTextColor="#999"
                  keyboardType="decimal-pad"
                  value={percentInputs[m.id] || ''}
                  onChangeText={(t) => setPercentInputs((prev) => ({ ...prev, [m.id]: t }))}
                />
                <Text style={styles.percentSign}>%</Text>
                {isAmountValid && (
                  <Text style={styles.percentPreview}>
                    ≈ {formatVND(shares.find((s) => s.userId === m.id)?.amount || 0)}
                  </Text>
                )}
              </View>
            ) : splitMode === 'EXACT' && selectedMembers.has(m.id) ? (
              <TextInput
                style={styles.shareInput}
                placeholder="0"
                placeholderTextColor="#999"
                keyboardType="numeric"
                value={customAmounts[m.id] || ''}
                onChangeText={(t) => setCustomAmounts((prev) => ({ ...prev, [m.id]: t }))}
              />
            ) : null}
          </View>
        ))}

        {/* Validation feedback */}
        {splitMode === 'PERCENT' && (
          <Text style={[styles.customTotal, Math.round(percentTotal * 100) / 100 === 100 ? styles.positive : styles.negative]}>
            Tổng: {percentTotal.toFixed(1)}% / 100%
            {Math.round(percentTotal * 100) / 100 !== 100 ? ' ⚠️ Chưa khớp' : ' ✓'}
          </Text>
        )}

        {splitMode === 'EXACT' && isAmountValid && (
          <Text style={[styles.customTotal, customTotal === amount ? styles.positive : styles.negative]}>
            Tổng phần chia: {formatVND(customTotal)} / {formatVND(amount)}
            {customTotal !== amount ? ' ⚠️ Chưa khớp' : ' ✓'}
          </Text>
        )}

        {/* Nút tạo */}
        <Pressable
          style={[styles.submitBtn, submitting && styles.buttonDisabled]}
          onPress={handleSubmit}
          disabled={submitting}
        >
          {submitting ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={styles.submitBtnText}>Tạo khoản chi</Text>
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
  memberChipActive: { backgroundColor: '#007AFF' },
  memberChipText: { fontSize: 14, color: '#666' },
  memberChipTextActive: { color: '#fff', fontWeight: '500' },

  splitHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },

  splitTabs: {
    flexDirection: 'row',
    backgroundColor: '#e5e5ea',
    borderRadius: 10,
    padding: 2,
  },
  splitTab: {
    flex: 1,
    paddingVertical: 8,
    alignItems: 'center',
    borderRadius: 8,
  },
  splitTabActive: { backgroundColor: '#fff' },
  splitTabText: { fontSize: 13, fontWeight: '500', color: '#666' },
  splitTabTextActive: { color: '#007AFF', fontWeight: '600' },

  shareRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: '#fff',
    padding: 12,
    borderRadius: 10,
  },
  checkbox: {
    width: 24,
    height: 24,
    borderRadius: 6,
    borderWidth: 2,
    borderColor: '#ddd',
    justifyContent: 'center',
    alignItems: 'center',
  },
  checkboxActive: { backgroundColor: '#007AFF', borderColor: '#007AFF' },
  checkmark: { color: '#fff', fontSize: 14, fontWeight: '700' },
  shareName: { flex: 1, fontSize: 15, color: '#1a1a1a' },
  shareAmount: { fontSize: 14, color: '#666', fontWeight: '500' },
  shareInput: {
    width: 80,
    borderWidth: 1,
    borderColor: '#ddd',
    borderRadius: 8,
    padding: 8,
    fontSize: 14,
    textAlign: 'right',
    color: '#1a1a1a',
  },

  percentContainer: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  percentSign: { fontSize: 14, color: '#666' },
  percentPreview: { fontSize: 12, color: '#8E8E93' },

  customTotal: { fontSize: 14, fontWeight: '500', textAlign: 'right' },
  positive: { color: '#34C759' },
  negative: { color: '#FF3B30' },

  submitBtn: {
    backgroundColor: '#007AFF',
    borderRadius: 12,
    padding: 16,
    alignItems: 'center',
    marginTop: 8,
  },
  buttonDisabled: { opacity: 0.6 },
  submitBtnText: { color: '#fff', fontSize: 16, fontWeight: '600' },
});
