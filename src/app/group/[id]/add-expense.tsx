import { useQueryClient } from '@tanstack/react-query';
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

import { toUserMessage } from '@/api/errors';
import { compressReceipt, type ExpenseShareInput } from '@/api/expenses';
import { isActiveMember } from '@/api/groups';
import { ErrorState } from '@/components/error-state';
import { ReceiptPicker } from '@/components/receipt-image';
import { ReceiptReviewModal, type ReceiptDraft } from '@/components/receipt-review';
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
import { useGroupsList } from '@/hooks/use-groups';
import { isOcrAvailable } from '@/lib/ocr';
import { persistReceiptCopy } from '@/lib/receipt-files';
import { buildReceiptPath } from '@/lib/receipt-path';
import { submitAction } from '@/offline';

type SplitMode = 'EQUAL' | 'PERCENT' | 'EXACT';

/** APP-09: Phần chia theo phần trăm, kèm percentBp để RPC lưu percent_bp. Ném lỗi nếu ô sai hoặc tổng ≠ 100%. */
function computePercentShares(totalAmount: number, memberIds: string[], percents: Record<string, string>): ExpenseShareInput[] {
  const bpList = percentInputsToBp(memberIds, percents);
  if (!bpList) throw new Error('Phần trăm không hợp lệ (0–100, tối đa 2 chữ số thập phân)');
  return splitPercent(totalAmount, bpList);
}

export default function AddExpenseScreen() {
  const { id: routeGroupId, pickGroup } = useLocalSearchParams<{ id: string; pickGroup?: string }>();
  const router = useRouter();
  const { user } = useAuth();
  const queryClient = useQueryClient();

  // Mở từ nút + ở Home (pickGroup=1): cho chọn nhóm, mặc định là nhóm trên route (nhóm mới nhất)
  const showGroupPicker = pickGroup === '1';
  const { activeGroups } = useGroupsList();
  const [groupIdInput, setGroupIdInput] = useState<string | null>(null);
  const groupId = groupIdInput ?? routeGroupId;

  const [description, setDescription] = useState('');
  const [amountText, setAmountText] = useState('');
  const [note, setNote] = useState('');
  // APP-14: null = chưa chọn → mặc định là mình; không setState trong effect
  const [paidByInput, setPaidBy] = useState<string | null>(null);
  const [splitMode, setSplitMode] = useState<SplitMode>('EQUAL');
  // APP-14: null = chưa đụng tới → mặc định chọn tất cả thành viên ACTIVE (tính dẫn xuất)
  const [selectedInput, setSelectedMembers] = useState<Set<string> | null>(null);
  const [customAmounts, setCustomAmounts] = useState<Record<string, string>>({});
  const [percentInputs, setPercentInputs] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  // MVP-01: Ảnh hóa đơn (uri trên máy, chưa upload)
  const [receiptUri, setReceiptUri] = useState<string | null>(null);
  // OCR-02: kết quả đọc hóa đơn người dùng đã kiểm tra; reviewOpen = đang mở màn kiểm tra
  const [receiptDraft, setReceiptDraft] = useState<ReceiptDraft | null>(null);
  const [reviewOpen, setReviewOpen] = useState(false);
  const ocrAvailable = isOcrAvailable();
  // MVP-01 / L7: đường dẫn ảnh tạo MỘT lần cho mỗi form — gửi lại (upsert) không tạo ảnh mồ côi
  const receiptPathRef = useRef<string | null>(null);
  // APP-07: idempotency key giữ theo form, chỉ đổi khi đã lưu
  const idempotencyKeyRef = useRef(Crypto.randomUUID());
  // APP-07: chặn bấm hai lần bằng ref đồng bộ
  const submittingRef = useRef(false);

  // REV-S5: dùng chung query nhóm + thành viên; đã rời nhóm / nhóm đã đóng thì không cho thêm
  const { membersQ, groupQ, isViewerActive, isGroupClosed, canWrite } = useGroupAccess(groupId);

  // NEW-03: Chỉ thành viên ACTIVE được chọn làm người trả / người chịu
  const members = useMemo(() => (membersQ.data ?? []).filter(isActiveMember), [membersQ.data]);

  const selectedMembers = useMemo(
    () => selectedInput ?? new Set(members.map((m) => m.id)),
    [selectedInput, members],
  );
  const paidBy = paidByInput ?? (members.some((m) => m.id === user?.id) ? user!.id : members[0]?.id ?? '');

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
    // EXACT: parse từ text
    return selectedIds.map((userId) => ({
      userId,
      amount: parseVND(customAmounts[userId] || '') ?? 0,
    }));
  }, [amount, selectedIds, splitMode, customAmounts, percentInputs]);

  const customTotal = splitMode === 'EXACT' ? shares.reduce((s, sh) => s + sh.amount, 0) : 0;

  /** Đổi nhóm: xoá các lựa chọn gắn với thành viên nhóm cũ; mô tả / số tiền / ghi chú / ảnh giữ nguyên */
  const selectGroup = (nextId: string) => {
    if (nextId === groupId || submittingRef.current) return;
    setGroupIdInput(nextId);
    setPaidBy(null);
    setSelectedMembers(null);
    setCustomAmounts({});
    setPercentInputs({});
    receiptPathRef.current = null;
    idempotencyKeyRef.current = Crypto.randomUUID();
  };

  /** Chọn ảnh mới → bỏ kết quả đọc của ảnh cũ, đọc ngay nếu máy có ML Kit */
  const handleReceiptPicked = (uri: string) => {
    setReceiptUri(uri);
    setReceiptDraft(null);
    if (ocrAvailable) setReviewOpen(true);
  };

  const handleReceiptRemoved = () => {
    setReceiptUri(null);
    setReceiptDraft(null);
  };

  /** OCR-02 / BR-12: điền sẵn số tiền (tổng đã xác nhận) và mô tả (tên cửa hàng, nếu đang trống) */
  const applyReceipt = (draft: ReceiptDraft) => {
    setReceiptDraft(draft);
    setReviewOpen(false);
    setAmountText(String(draft.total));
    if (!description.trim() && draft.storeName) setDescription(draft.storeName);
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
    if (submittingRef.current || !user) return;
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
    if (!paidBy) {
      Alert.alert('Lỗi', 'Vui lòng chọn người trả');
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
    const currentKey = idempotencyKeyRef.current;

    // MVP-01: nén ảnh và chép vào thư mục tài liệu; hàng đợi upload (upsert) rồi mới gọi create_expense,
    // nên mất mạng vẫn lưu được và tự gửi ảnh khi có mạng
    let receiptPath: string | undefined;
    let localReceiptUri: string | undefined;
    if (receiptUri) {
      try {
        if (!receiptPathRef.current) {
          receiptPathRef.current = buildReceiptPath(groupId, Crypto.randomUUID(), Crypto.randomUUID());
        }
        localReceiptUri = await persistReceiptCopy(await compressReceipt(receiptUri));
        receiptPath = receiptPathRef.current;
      } catch (err) {
        console.warn('[AddExpense] receipt prepare failed:', (err as Error)?.message);
        Alert.alert('Lỗi', 'Không đọc được ảnh hóa đơn. Hãy chọn ảnh khác hoặc xóa ảnh.');
        submittingRef.current = false;
        setSubmitting(false);
        return;
      }
    }

    try {
      // APP-08: ghi hàng đợi trước (kèm key), rồi gửi ngay
      const res = await submitAction(
        'create_expense',
        {
          groupId,
          paidBy,
          amount,
          description: description.trim(),
          shares: finalShares,
          idempotencyKey: currentKey,
          splitMethod: splitMode,
          note: note.trim(),
          receiptPath,
          localReceiptUri,
          // OCR-06: khoản chi có danh sách món đọc từ hóa đơn → source = OCR
          ...(receiptDraft && receiptDraft.items.length > 0
            ? { receiptItems: receiptDraft.items, source: 'OCR' as const }
            : {}),
        },
        currentKey,
        user.id,
      );
      // APP-07: Reset key (và đường dẫn ảnh) sau khi đã lưu
      idempotencyKeyRef.current = Crypto.randomUUID();
      receiptPathRef.current = null;
      queryClient.invalidateQueries({ queryKey: ['expenses', groupId] });
      queryClient.invalidateQueries({ queryKey: ['groups'] });
      if (res.status === 'queued') {
        Alert.alert(
          'Chưa đồng bộ',
          receiptPath
            ? 'Chưa gửi được do mất kết nối. Khoản chi và ảnh hóa đơn đã được lưu trên máy và sẽ tự gửi khi có mạng.'
            : 'Chưa gửi được do mất kết nối. Khoản chi đã được lưu và sẽ tự gửi khi có mạng.',
        );
      } else if (receiptPath && !(res.result as { receipt_path?: string | null } | null)?.receipt_path) {
        Alert.alert('Đã lưu khoản chi', 'Không tải được ảnh hóa đơn lên. Bạn có thể thêm lại ảnh ở màn sửa khoản chi.');
      }
      router.back();
    } catch (err: any) {
      Alert.alert('Lỗi', toUserMessage(err, 'Không thể tạo khoản chi'));
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

  /** REV-S9: "Chia đều %" — điền phần vạn đều cho người đang chọn, phần dư theo user_id tăng dần */
  const fillEqualPercent = () => {
    const next: Record<string, string> = {};
    for (const x of splitPercentEqually(selectedIds)) next[x.userId] = bpToPercentText(x.bp);
    setPercentInputs(next);
  };

  const membersLoading = membersQ.isLoading || groupQ.isLoading;
  const membersFailed = !!membersQ.error && !membersQ.data;

  // Khi có bộ chọn nhóm, trạng thái tải / lỗi hiện ngay trong form để vẫn đổi được nhóm
  if (!showGroupPicker && membersLoading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color="#007AFF" />
      </View>
    );
  }

  if (!showGroupPicker && membersFailed) {
    return (
      <ErrorState
        message={toUserMessage(membersQ.error, 'Không thể tải danh sách thành viên')}
        onRetry={() => membersQ.refetch()}
      />
    );
  }

  // REV-S5: chỉ xem
  if (!showGroupPicker && !canWrite) {
    return (
      <ErrorState
        title={!isViewerActive ? 'Bạn đã rời nhóm' : isGroupClosed ? 'Nhóm đã đóng' : 'Không thể thêm khoản chi'}
        message="Bạn chỉ xem được dữ liệu của nhóm này, không thể thêm khoản chi mới."
      />
    );
  }

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      style={styles.flex}
    >
      <ScrollView style={styles.container} contentContainerStyle={styles.content}>
        {/* Nhóm (chỉ khi mở từ nút + ở Home) */}
        {showGroupPicker && activeGroups.length > 0 && (
          <>
            <Text style={styles.label}>Nhóm</Text>
            <View style={styles.memberList}>
              {activeGroups.map((g) => (
                <Pressable
                  key={g.id}
                  style={[styles.memberChip, groupId === g.id && styles.memberChipActive]}
                  onPress={() => selectGroup(g.id)}
                  disabled={submitting}
                  accessibilityRole="button"
                  accessibilityState={{ selected: groupId === g.id }}
                >
                  <Text style={[styles.memberChipText, groupId === g.id && styles.memberChipTextActive]}>
                    {g.name}
                  </Text>
                </Pressable>
              ))}
            </View>
          </>
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


        {/* MVP-01: Ảnh hóa đơn */}
        <Text style={styles.label}>Ảnh hóa đơn</Text>
        <ReceiptPicker
          localUri={receiptUri}
          remoteUrl={null}
          disabled={submitting}
          onPicked={handleReceiptPicked}
          onRemove={handleReceiptRemoved}
        />
        {/* OCR-02: đọc món + số tiền bằng ML Kit trên máy, người dùng sửa trước khi dùng */}
        {receiptUri && ocrAvailable ? (
          receiptDraft ? (
            <View style={styles.receiptSummary}>
              <View style={styles.flex}>
                <Text style={styles.receiptSummaryTitle}>
                  🧾 {receiptDraft.items.length} dòng · {formatVND(receiptDraft.total)}
                </Text>
                {receiptDraft.total !== amount ? (
                  <Text style={styles.receiptSummaryWarn}>Số tiền đang khác tổng hóa đơn</Text>
                ) : null}
              </View>
              <Pressable onPress={() => setReviewOpen(true)} disabled={submitting} hitSlop={8}>
                <Text style={styles.receiptSummaryAction}>Sửa món</Text>
              </Pressable>
            </View>
          ) : (
            <Pressable style={styles.readReceiptBtn} onPress={() => setReviewOpen(true)} disabled={submitting}>
              <Text style={styles.readReceiptText}>🔍 Đọc món và số tiền từ ảnh</Text>
            </Pressable>
          )
        ) : null}

        {/* Phần phụ thuộc nhóm: thành viên, người trả, cách chia */}
        {membersLoading ? (
          <ActivityIndicator style={styles.sectionLoading} size="large" color="#007AFF" />
        ) : membersFailed ? (
          <ErrorState
            inline
            message={toUserMessage(membersQ.error, 'Không thể tải danh sách thành viên')}
            onRetry={() => membersQ.refetch()}
          />
        ) : !canWrite ? (
          <ErrorState
            inline
            title={!isViewerActive ? 'Bạn đã rời nhóm' : isGroupClosed ? 'Nhóm đã đóng' : 'Không thể thêm khoản chi'}
            message="Bạn chỉ xem được dữ liệu của nhóm này, không thể thêm khoản chi mới."
          />
        ) : (
          <>
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
          </>
        )}
      </ScrollView>
      {reviewOpen ? (
        <ReceiptReviewModal
          imageUri={receiptUri}
          initial={receiptDraft}
          onCancel={() => setReviewOpen(false)}
          onApply={applyReceipt}
        />
      ) : null}
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  container: { flex: 1, backgroundColor: '#f2f2f7' },
  content: { padding: 16, gap: 12, paddingBottom: 40 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  sectionLoading: { paddingVertical: 24 },

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

  readReceiptBtn: {
    borderWidth: 1,
    borderColor: '#007AFF',
    borderRadius: 12,
    padding: 12,
    alignItems: 'center',
    backgroundColor: '#fff',
  },
  readReceiptText: { fontSize: 15, color: '#007AFF', fontWeight: '600' },
  receiptSummary: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 12,
  },
  receiptSummaryTitle: { fontSize: 15, color: '#1a1a1a', fontWeight: '500' },
  receiptSummaryWarn: { fontSize: 12, color: '#FF9500', marginTop: 2 },
  receiptSummaryAction: { fontSize: 15, color: '#007AFF', fontWeight: '600' },

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
