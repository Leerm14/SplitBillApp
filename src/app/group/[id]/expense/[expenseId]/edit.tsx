import { useQuery, useQueryClient } from '@tanstack/react-query';
import * as Crypto from 'expo-crypto';
import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useMemo, useRef, useState } from 'react';
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

import { isVersionConflict, toUserMessage } from '@/api/errors';
import {
  compressReceipt,
  fetchExpense,
  updateExpense,
  uploadReceiptFile,
  type Expense,
  type ExpenseShareInput,
} from '@/api/expenses';
import { isActiveMember, type GroupMember } from '@/api/groups';
import { ErrorState } from '@/components/error-state';
import { ReceiptPicker } from '@/components/receipt-image';
import { formatVND, parseVND } from '@/domain/money';
import {
  bpToPercentText,
  FULL_BP,
  percentInputsToBp,
  splitEqual,
  splitPercent,
  splitPercentEqually,
  validateShares,
} from '@/domain/split';
import { useAuth } from '@/hooks/use-auth';
import { useGroupAccess } from '@/hooks/use-group-settlement';
import { useReceiptUrl } from '@/hooks/use-receipt-url';
import { buildReceiptPath, resolveReceiptPathForUpdate } from '@/lib/receipt-path';

type SplitMode = 'EQUAL' | 'PERCENT' | 'EXACT';

/** APP-09: Phần chia theo phần trăm (dùng splitPercent của domain), kèm percentBp. */
function computePercentShares(totalAmount: number, memberIds: string[], percents: Record<string, string>): ExpenseShareInput[] {
  const bpList = percentInputsToBp(memberIds, percents);
  if (!bpList) throw new Error('Phần trăm không hợp lệ (0–100, tối đa 2 chữ số thập phân)');
  return splitPercent(totalAmount, bpList);
}

export default function EditExpenseScreen() {
  const { id: groupId, expenseId } = useLocalSearchParams<{ id: string; expenseId: string }>();

  const expenseQ = useQuery({
    queryKey: ['expense', expenseId],
    queryFn: () => fetchExpense(expenseId),
  });

  // REV-S5 / REV-S10: quyền ghi + trạng thái thành viên của người tham gia
  const { membersQ, groupQ, canWrite, isViewerActive } = useGroupAccess(groupId);

  // REV-S3: form dựa trên một bản chụp cố định; bản mới hơn tải về KHÔNG dựng lại form (không mất chỗ
  // người dùng đang sửa) — chỉ hiện banner "Tải lại". setState lúc render (không dùng effect).
  const [snapshot, setSnapshot] = useState<Expense | null>(null);
  if (snapshot === null && expenseQ.data) setSnapshot(expenseQ.data);

  if ((expenseQ.isLoading || membersQ.isLoading || groupQ.isLoading) && !snapshot) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color="#007AFF" />
      </View>
    );
  }

  // REV-S3: chỉ báo lỗi khi KHÔNG có dữ liệu (lỗi lúc tải lại nền thì giữ form)
  const queryError = expenseQ.error || membersQ.error;
  const base = snapshot ?? expenseQ.data;
  if (!base || !membersQ.data) {
    return (
      <ErrorState
        message={toUserMessage(queryError, 'Không thể tải khoản chi')}
        onRetry={() => {
          expenseQ.refetch();
          membersQ.refetch();
        }}
      />
    );
  }

  // REV-S10: server từ chối sửa khoản chi có người đã rời (PARTICIPANT_NOT_ACTIVE)
  const activeIds = new Set(membersQ.data.filter(isActiveMember).map((m) => m.id));
  const participants = [base.paid_by, ...(base.expense_shares || []).map((s) => s.user_id)];
  const inactive = [...new Set(participants)].filter((uid) => !activeIds.has(uid));
  if (base.status !== 'ACTIVE' || !canWrite || inactive.length > 0) {
    const nameOf = (uid: string) => membersQ.data?.find((m) => m.id === uid)?.displayName || uid.slice(0, 8);
    return (
      <ErrorState
        title="Không thể sửa khoản chi"
        message={
          base.status !== 'ACTIVE'
            ? 'Khoản chi đã bị hủy.'
            : !isViewerActive
              ? 'Bạn đã rời nhóm nên không thể sửa khoản chi.'
              : !canWrite
                ? 'Nhóm đã đóng nên không thể sửa khoản chi.'
                : `${inactive.map(nameOf).join(', ')} đã rời nhóm nên khoản chi này không sửa được nữa.`
        }
      />
    );
  }

  const latest = expenseQ.data;
  const newerAvailable = !!latest && (latest.version ?? 1) > (base.version ?? 1);

  // APP-15: form khởi tạo state từ bản chụp qua props; `key` theo version của bản chụp → chỉ dựng lại
  // khi người dùng chủ động "Tải lại" (banner REV-S3 hoặc sau xung đột phiên bản APP-05).
  return (
    <EditExpenseForm
      key={`${base.id}-${base.version}`}
      groupId={groupId}
      expense={base}
      // NEW-03: Chỉ thành viên ACTIVE được chọn làm người trả / người chịu
      members={membersQ.data.filter(isActiveMember)}
      newerAvailable={newerAvailable}
      onLoadLatest={() => {
        if (latest) setSnapshot(latest);
      }}
      reload={async () => {
        const res = await expenseQ.refetch();
        if (res.error) throw res.error;
        if (res.data) setSnapshot(res.data);
      }}
    />
  );
}

function EditExpenseForm({
  groupId,
  expense,
  members,
  newerAvailable,
  onLoadLatest,
  reload,
}: {
  groupId: string;
  expense: Expense;
  members: GroupMember[];
  /** REV-S3: có bản mới hơn trên server so với bản form đang sửa */
  newerAvailable: boolean;
  onLoadLatest: () => void;
  reload: () => Promise<void>;
}) {
  const router = useRouter();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const expenseId = expense.id;
  const initialMode = (expense.split_method || 'EQUAL') as SplitMode;

  const [description, setDescription] = useState(expense.description || '');
  const [amountText, setAmountText] = useState(String(Number(expense.amount)));
  const [note, setNote] = useState(expense.note || '');
  const [paidBy, setPaidBy] = useState(expense.paid_by);
  const [splitMode, setSplitMode] = useState<SplitMode>(initialMode);
  const [selectedMembers, setSelectedMembers] = useState<Set<string>>(
    () => new Set((expense.expense_shares || []).map((s) => s.user_id)),
  );
  const [customAmounts, setCustomAmounts] = useState<Record<string, string>>(() => {
    const amounts: Record<string, string> = {};
    if (initialMode === 'EXACT') {
      for (const s of expense.expense_shares || []) amounts[s.user_id] = String(Number(s.amount));
    }
    return amounts;
  });
  // APP-09: nạp lại phần trăm từ percent_bp đã lưu
  const [percentInputs, setPercentInputs] = useState<Record<string, string>>(() => {
    const percents: Record<string, string> = {};
    if (initialMode === 'PERCENT') {
      for (const s of expense.expense_shares || []) {
        if (s.percent_bp != null) percents[s.user_id] = bpToPercentText(Number(s.percent_bp));
      }
    }
    return percents;
  });
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const version = expense.version ?? 1;

  // MVP-01: ảnh hóa đơn — thêm / thay / xóa
  const [newReceiptUri, setNewReceiptUri] = useState<string | null>(null);
  const [receiptRemoved, setReceiptRemoved] = useState(false);
  // L7: đường dẫn ảnh mới tạo MỘT lần cho form (thư mục = id khoản chi) → upload lại dùng upsert
  const newReceiptPathRef = useRef<string | null>(null);
  const existingReceipt = receiptRemoved ? null : expense.receipt_path;
  const receiptUrlQ = useReceiptUrl(existingReceipt);

  const amount = parseVND(amountText) ?? 0;
  const isAmountValid = amount > 0;
  const selectedIds = useMemo(() => [...selectedMembers], [selectedMembers]);

  const bpList = splitMode === 'PERCENT' ? percentInputsToBp(selectedIds, percentInputs) : null;
  const totalBp = bpList ? bpList.reduce((sum, x) => sum + x.bp, 0) : null;
  const percentOk = totalBp === FULL_BP;

  // Tính phần chia (xem trước)
  const shares = useMemo((): ExpenseShareInput[] => {
    if (amount <= 0 || selectedIds.length === 0) return [];
    if (splitMode === 'EQUAL') return splitEqual(amount, selectedIds);
    if (splitMode === 'PERCENT') {
      try {
        return computePercentShares(amount, selectedIds, percentInputs);
      } catch {
        return []; // chưa đủ 100% — chưa xem trước được
      }
    }
    // EXACT
    return selectedIds.map((userId) => ({
      userId,
      amount: parseVND(customAmounts[userId] || '') ?? 0,
    }));
  }, [amount, selectedIds, splitMode, customAmounts, percentInputs]);

  const customTotal = splitMode === 'EXACT' ? shares.reduce((s, sh) => s + sh.amount, 0) : 0;

  /** REV-S9: "Chia đều %" — phần vạn đều cho người đang chọn, phần dư theo user_id tăng dần */
  const fillEqualPercent = () => {
    const next: Record<string, string> = {};
    for (const x of splitPercentEqually(selectedIds)) next[x.userId] = bpToPercentText(x.bp);
    setPercentInputs(next);
  };

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
    if (submittingRef.current) return;
    if (!isAmountValid) {
      Alert.alert('Lỗi', 'Vui lòng nhập số tiền hợp lệ');
      return;
    }
    if (selectedIds.length === 0) {
      Alert.alert('Lỗi', 'Vui lòng chọn ít nhất 1 người chịu');
      return;
    }
    if (!description.trim()) {
      Alert.alert('Lỗi', 'Vui lòng nhập mô tả');
      return;
    }

    let finalShares: ExpenseShareInput[];
    try {
      if (splitMode === 'EQUAL') {
        finalShares = splitEqual(amount, selectedIds);
      } else if (splitMode === 'PERCENT') {
        // APP-09: splitPercent ném lỗi nếu tổng ≠ 100%; gửi kèm percentBp
        finalShares = computePercentShares(amount, selectedIds, percentInputs);
      } else {
        finalShares = shares;
        validateShares(amount, finalShares);
      }
    } catch (err: any) {
      Alert.alert('Lỗi', err.message);
      return;
    }

    submittingRef.current = true;
    setSubmitting(true);
    try {
      // MVP-01: ảnh mới → nén + upload (upsert) trước; update_expense ghi đè receipt_path nên luôn gửi rõ giá trị
      let uploadedPath: string | null = null;
      if (newReceiptUri) {
        if (!newReceiptPathRef.current) {
          newReceiptPathRef.current = buildReceiptPath(groupId, expenseId, Crypto.randomUUID());
        }
        uploadedPath = await uploadReceiptFile(newReceiptPathRef.current, await compressReceipt(newReceiptUri));
      }
      const receiptPath = resolveReceiptPathForUpdate({
        existing: expense.receipt_path ?? null,
        uploadedPath,
        removed: receiptRemoved,
      });
      await updateExpense({
        expenseId,
        expectedVersion: version,
        paidBy,
        amount,
        description: description.trim(),
        splitMethod: splitMode,
        note: note.trim(),
        shares: finalShares,
        receiptPath,
      });
      queryClient.invalidateQueries({ queryKey: ['expense', expenseId] });
      queryClient.invalidateQueries({ queryKey: ['expenses', groupId] });
      queryClient.invalidateQueries({ queryKey: ['groups'] });
      router.back();
    } catch (err: any) {
      // APP-05: xung đột phiên bản theo hợp đồng: code 'PT409' hoặc message bắt đầu 'VERSION_CONFLICT'
      if (isVersionConflict(err)) {
        Alert.alert(
          'Xung đột phiên bản',
          'Khoản chi đã được cập nhật bởi người khác. Tải bản mới nhất rồi sửa lại?',
          [
            { text: 'Hủy', style: 'cancel' },
            {
              text: 'Tải lại',
              // APP-05: chờ refetch xong; form được dựng lại theo key (id + version mới)
              onPress: () => {
                reload().catch((e) => Alert.alert('Lỗi', toUserMessage(e, 'Không tải lại được')));
              },
            },
          ],
        );
      } else {
        Alert.alert('Lỗi', toUserMessage(err, 'Không thể cập nhật khoản chi'));
      }
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      style={styles.flex}
    >
      <ScrollView style={styles.container} contentContainerStyle={styles.content}>
        {/* REV-S3: bản mới hơn vừa tải về — không tự thay form, để người dùng chọn tải lại */}
        {newerAvailable && (
          <Pressable
            style={styles.newerBanner}
            onPress={() =>
              Alert.alert('Tải lại khoản chi', 'Các thay đổi bạn đang nhập sẽ bị bỏ. Tải bản mới nhất?', [
                { text: 'Hủy', style: 'cancel' },
                { text: 'Tải lại', style: 'destructive', onPress: onLoadLatest },
              ])
            }
          >
            <Text style={styles.newerBannerText}>Khoản chi vừa được cập nhật — Tải lại</Text>
          </Pressable>
        )}

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

        {/* MVP-01: Ảnh hóa đơn — thêm / thay / xóa */}
        <Text style={styles.label}>Ảnh hóa đơn</Text>
        <ReceiptPicker
          localUri={newReceiptUri}
          remoteUrl={receiptUrlQ.data ?? null}
          remoteLoading={!!existingReceipt && receiptUrlQ.isLoading}
          remoteError={!!existingReceipt && receiptUrlQ.isError}
          disabled={submitting}
          onPicked={(uri) => setNewReceiptUri(uri)}
          onRemove={() => {
            setNewReceiptUri(null);
            setReceiptRemoved(true);
          }}
        />

        {/* Người trả */}
        <Text style={styles.label}>Người trả</Text>
        <View style={styles.memberList}>
          {members.map((m) => (
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

        {members.map((m) => (
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

        {/* REV-S9: chia đều phần trăm (thirds → 33,34 + 33,33 + 33,33) */}
        {splitMode === 'PERCENT' && selectedIds.length > 0 && (
          <Pressable style={styles.equalPercentBtn} onPress={fillEqualPercent}>
            <Text style={styles.equalPercentText}>Chia đều %</Text>
          </Pressable>
        )}

        {/* Validation feedback */}
        {splitMode === 'PERCENT' && (
          <Text style={[styles.customTotal, percentOk ? styles.positive : styles.negative]}>
            {totalBp === null
              ? 'Phần trăm không hợp lệ (0–100, tối đa 2 chữ số thập phân) ⚠️'
              : `Tổng: ${(totalBp / 100).toFixed(2)}% / 100%${percentOk ? ' ✓' : ' ⚠️ Chưa khớp'}`}
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

  equalPercentBtn: {
    alignSelf: 'flex-end',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#007AFF',
  },
  equalPercentText: { fontSize: 13, color: '#007AFF', fontWeight: '600' },
  newerBanner: {
    backgroundColor: '#FFF3E0',
    borderRadius: 10,
    padding: 12,
    borderLeftWidth: 4,
    borderLeftColor: '#FF9800',
  },
  newerBannerText: { fontSize: 14, color: '#E65100', fontWeight: '600' },
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
