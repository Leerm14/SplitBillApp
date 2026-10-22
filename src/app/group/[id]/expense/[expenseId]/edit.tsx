import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useEffect, useMemo, useState } from 'react';
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

import { fetchExpense, updateExpense } from '@/api/expenses';
import { fetchGroupMembers } from '@/api/groups';
import { formatVND, parseVND } from '@/domain/money';
import { splitEqual, validateShares } from '@/domain/split';
import { useAuth } from '@/hooks/use-auth';

export default function EditExpenseScreen() {
  const { id: groupId, expenseId } = useLocalSearchParams<{ id: string; expenseId: string }>();
  const router = useRouter();
  const { user } = useAuth();
  const queryClient = useQueryClient();

  const [description, setDescription] = useState('');
  const [amountText, setAmountText] = useState('');
  const [note, setNote] = useState('');
  const [paidBy, setPaidBy] = useState('');
  const [splitMode, setSplitMode] = useState<'EQUAL' | 'PERCENT' | 'EXACT'>('EQUAL');
  const [selectedMembers, setSelectedMembers] = useState<Set<string>>(new Set());
  const [customAmounts, setCustomAmounts] = useState<Record<string, string>>({});
  const [percentInputs, setPercentInputs] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [version, setVersion] = useState(1);
  const [loaded, setLoaded] = useState(false);

  const expenseQ = useQuery({
    queryKey: ['expense', expenseId],
    queryFn: () => fetchExpense(expenseId),
  });

  const membersQ = useQuery({
    queryKey: ['group-members', groupId],
    queryFn: () => fetchGroupMembers(groupId),
  });

  // Pre-fill fields when expense data loads
  useEffect(() => {
    if (expenseQ.data && !loaded) {
      const e = expenseQ.data;
      setDescription(e.description || '');
      setAmountText(String(Number(e.amount)));
      setNote(e.note || '');
      setPaidBy(e.paid_by);
      setVersion(e.version ?? 1);

      const method = (e.split_method || 'EQUAL') as 'EQUAL' | 'PERCENT' | 'EXACT';
      setSplitMode(method);

      const memberIds = new Set((e.expense_shares || []).map((s: any) => s.user_id));
      setSelectedMembers(memberIds);

      if (method === 'EXACT') {
        const amounts: Record<string, string> = {};
        (e.expense_shares || []).forEach((s: any) => {
          amounts[s.user_id] = String(Number(s.amount));
        });
        setCustomAmounts(amounts);
      } else if (method === 'PERCENT') {
        const percents: Record<string, string> = {};
        (e.expense_shares || []).forEach((s: any) => {
          const bp = Number(s.percent_bp || 0);
          percents[s.user_id] = String(bp / 100);
        });
        setPercentInputs(percents);
      }

      setLoaded(true);
    }
  }, [expenseQ.data, loaded]);

  const amount = parseVND(amountText) ?? 0;
  const isAmountValid = amount > 0;

  // Tính phần chia theo phần trăm
  const computePercentShares = (totalAmount: number, members: string[], percents: Record<string, string>) => {
    const result: { userId: string; amount: number }[] = [];
    let allocated = 0;

    const parsed = members.map((userId) => {
      const pct = parseFloat(percents[userId] || '0');
      return { userId, percent: isNaN(pct) ? 0 : pct };
    });

    for (let i = 0; i < parsed.length; i++) {
      const share = Math.floor(totalAmount * parsed[i].percent / 100);
      result.push({ userId: parsed[i].userId, amount: share });
      allocated += share;
    }

    // Phân phối phần dư cho người đầu tiên
    const remainder = totalAmount - allocated;
    if (result.length > 0 && remainder > 0) {
      result[0].amount += remainder;
    }

    return result;
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
    // EXACT
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
    try {
      await updateExpense({
        expenseId,
        expectedVersion: version,
        paidBy,
        amount,
        description: description.trim(),
        splitMethod: splitMode,
        note: note.trim(),
        shares: finalShares,
      });
      queryClient.invalidateQueries({ queryKey: ['expense', expenseId] });
      queryClient.invalidateQueries({ queryKey: ['expenses', groupId] });
      queryClient.invalidateQueries({ queryKey: ['groups'] });
      router.back();
    } catch (err: any) {
      // APP-05: Detect version conflict by error code (ERRCODE P0002 = raise_exception)
      // or by text match for backward compatibility
      const errCode = err.code || err.details?.code || '';
      const errMsg = err.message || '';
      const isConflict = errCode === 'P0002' || errMsg.includes('version') || errMsg.includes('conflict') || errMsg.includes('đã được sửa');
      if (isConflict) {
        Alert.alert(
          'Xung đột phiên bản',
          'Khoản chi đã được cập nhật bởi người khác. Bạn có muốn tải lại?',
          [
            { text: 'Hủy', style: 'cancel' },
            {
              text: 'Tải lại',
              onPress: async () => {
                // APP-05: Await refetch to get fresh data, then reset form
                const result = await expenseQ.refetch();
                if (result.data) {
                  setLoaded(false); // Reset to trigger re-initialization from fresh data
                }
              },
            },
          ],
        );
      } else {
        Alert.alert('Lỗi', errMsg || 'Không thể cập nhật khoản chi');
      }
    } finally {
      setSubmitting(false);
    }
  };

  if (expenseQ.isLoading || membersQ.isLoading) {
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

        {/* Nút lưu */}
        <Pressable
          style={[styles.submitBtn, submitting && styles.buttonDisabled]}
          onPress={handleSubmit}
          disabled={submitting}
        >
          {submitting ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={styles.submitBtnText}>Lưu thay đổi</Text>
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
