/**
 * OCR-02 / BR-12 / BR-13: Màn kiểm tra hóa đơn sau khi ML Kit đọc ảnh — người dùng sửa tên món,
 * số lượng, số tiền, loại dòng (món / phí / thuế / giảm giá), thêm hoặc xóa dòng, và xác nhận tổng.
 * Không tự lưu (OCR-05): chỉ trả kết quả về màn thêm khoản chi khi bấm "Dùng hóa đơn này".
 */
import * as Crypto from 'expo-crypto';
import { Image } from 'expo-image';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ReceiptViewer } from '@/components/receipt-image';
import { formatVND, parseVND } from '@/domain/money';
import {
  normalizeReceiptItems,
  RECEIPT_ITEM_NAME_MAX,
  RECEIPT_ITEMS_MAX,
  RECEIPT_KIND_LABEL,
  receiptSum,
  type ReceiptItem,
  type ReceiptItemKind,
} from '@/domain/receipt';
import { readReceipt } from '@/lib/ocr';

/** Kết quả người dùng đã xác nhận */
export type ReceiptDraft = {
  storeName: string;
  items: ReceiptItem[];
  /** Tổng in trên hóa đơn (người dùng có thể sửa); null = không có */
  printedTotal: number | null;
  /** Tổng dùng cho khoản chi: tổng trên hóa đơn nếu có, không thì tổng các dòng */
  total: number;
};

type Row = { key: string; name: string; quantity: string; amount: string; kind: ReceiptItemKind };

const KIND_ORDER: ReceiptItemKind[] = ['ITEM', 'FEE', 'TAX', 'DISCOUNT'];

function toRow(it: ReceiptItem): Row {
  return {
    key: Crypto.randomUUID(),
    name: it.name,
    quantity: String(it.quantity),
    amount: it.amount > 0 ? String(it.amount) : '',
    kind: it.kind,
  };
}

function rowsToItems(rows: Row[]): ReceiptItem[] {
  return normalizeReceiptItems(
    rows.map((r) => ({
      name: r.name,
      quantity: Number(r.quantity) || 1,
      amount: parseVND(r.amount) ?? 0,
      kind: r.kind,
    })),
  );
}

type Props = {
  /** Ảnh hóa đơn trên máy; đọc bằng ML Kit khi mở mà chưa có `initial` */
  imageUri: string | null;
  /** Kết quả đã sửa trước đó — mở lại để sửa tiếp, không đọc lại ảnh */
  initial: ReceiptDraft | null;
  onCancel: () => void;
  onApply: (draft: ReceiptDraft) => void;
};

/** Mỗi lần mở là một lần gắn (render có điều kiện) — state khởi tạo từ props, không đồng bộ trong effect */
export function ReceiptReviewModal({ imageUri, initial, onCancel, onApply }: Props) {
  const [status, setStatus] = useState<'reading' | 'ready' | 'error'>(initial || !imageUri ? 'ready' : 'reading');
  const [errorText, setErrorText] = useState<string | null>(null);
  const [storeName, setStoreName] = useState(initial?.storeName ?? '');
  const [rows, setRows] = useState<Row[]>(() => (initial?.items ?? []).map(toRow));
  const [printedText, setPrintedText] = useState(initial?.printedTotal ? String(initial.printedTotal) : '');
  const [viewing, setViewing] = useState(false);
  // Lượt đọc mới nhất — kết quả của lượt cũ về muộn (hoặc sau khi đóng) bị bỏ
  const readRunRef = useRef(0);

  const startRead = useCallback(() => {
    if (!imageUri) return;
    const run = ++readRunRef.current;
    readReceipt(imageUri)
      .then((parsed) => {
        if (run !== readRunRef.current) return;
        setStoreName(parsed.storeName);
        setRows(parsed.items.map(toRow));
        setPrintedText(parsed.printedTotal ? String(parsed.printedTotal) : '');
        setStatus('ready');
        if (parsed.items.length === 0 && !parsed.printedTotal) {
          setErrorText('Không tìm thấy món nào trên ảnh. Bạn có thể thêm dòng bằng tay hoặc chụp lại rõ hơn.');
        }
      })
      .catch((err) => {
        if (run !== readRunRef.current) return;
        console.warn('[ReceiptReview] OCR failed:', (err as Error)?.message);
        setStatus('error');
        setErrorText('Không đọc được chữ trên ảnh. Bạn có thể nhập các dòng bằng tay.');
      });
  }, [imageUri]);

  // Mở lần đầu chưa có kết quả → đọc ảnh; đóng → bỏ kết quả đang chờ
  useEffect(() => {
    if (!initial) startRead();
    const runs = readRunRef;
    return () => {
      runs.current++;
    };
  }, [initial, startRead]);

  const reread = () => {
    setStatus('reading');
    setErrorText(null);
    startRead();
  };

  const items = rowsToItems(rows);
  const sum = receiptSum(items);
  const printedTotal = parseVND(printedText);
  const hasPrinted = printedTotal !== null && printedTotal > 0;
  const total = hasPrinted ? printedTotal! : sum;
  const diff = hasPrinted ? sum - printedTotal! : 0;
  const canApply = status !== 'reading' && total > 0;

  const updateRow = (key: string, patch: Partial<Row>) =>
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  const removeRow = (key: string) => setRows((prev) => prev.filter((r) => r.key !== key));
  const addRow = () =>
    setRows((prev) =>
      prev.length >= RECEIPT_ITEMS_MAX
        ? prev
        : [...prev, { key: Crypto.randomUUID(), name: '', quantity: '1', amount: '', kind: 'ITEM' }],
    );
  const cycleKind = (row: Row) =>
    updateRow(row.key, { kind: KIND_ORDER[(KIND_ORDER.indexOf(row.kind) + 1) % KIND_ORDER.length] });

  const apply = () => {
    if (!canApply) return;
    onApply({ storeName: storeName.trim(), items, printedTotal: hasPrinted ? printedTotal : null, total });
  };

  return (
    <Modal visible animationType="slide" onRequestClose={onCancel} presentationStyle="fullScreen">
      <SafeAreaView style={styles.flex} edges={['top', 'bottom']}>
        <View style={styles.header}>
          <Pressable onPress={onCancel} hitSlop={8} accessibilityRole="button">
            <Text style={styles.headerAction}>Hủy</Text>
          </Pressable>
          <Text style={styles.headerTitle}>Kiểm tra hóa đơn</Text>
          <Pressable onPress={apply} disabled={!canApply} hitSlop={8} accessibilityRole="button">
            <Text style={[styles.headerAction, styles.headerActionStrong, !canApply && styles.disabledText]}>Xong</Text>
          </Pressable>
        </View>

        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.flex}>
          <ScrollView style={styles.container} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
            {imageUri ? (
              <Pressable onPress={() => setViewing(true)} accessibilityLabel="Xem ảnh hóa đơn">
                <Image source={{ uri: imageUri }} style={styles.thumb} contentFit="cover" />
              </Pressable>
            ) : null}
            <Text style={styles.disclaimer}>
              Kết quả đọc tự động trên máy, có thể sai. Hãy kiểm tra từng dòng trước khi dùng.
            </Text>

            {status === 'reading' ? (
              <View style={styles.reading}>
                <ActivityIndicator size="large" color="#007AFF" />
                <Text style={styles.readingText}>Đang đọc hóa đơn…</Text>
              </View>
            ) : (
              <>
                {errorText ? <Text style={styles.errorText}>{errorText}</Text> : null}
                {imageUri && (initial || status === 'error') ? (
                  <Pressable style={styles.rereadBtn} onPress={reread}>
                    <Text style={styles.rereadText}>↻ Đọc lại từ ảnh</Text>
                  </Pressable>
                ) : null}

                <Text style={styles.label}>Cửa hàng</Text>
                <TextInput
                  style={styles.input}
                  placeholder="Tên cửa hàng (dùng làm mô tả)"
                  placeholderTextColor="#999"
                  value={storeName}
                  onChangeText={setStoreName}
                  maxLength={RECEIPT_ITEM_NAME_MAX}
                />

                <Text style={styles.label}>Các dòng trên hóa đơn ({rows.length})</Text>
                <Text style={styles.hint}>Chạm nhãn loại để đổi: Món → Phí → Thuế → Giảm giá</Text>
                {rows.map((row) => (
                  <View key={row.key} style={styles.rowCard}>
                    <View style={styles.rowTop}>
                      <Pressable
                        style={[styles.kindChip, row.kind !== 'ITEM' && styles.kindChipExtra, row.kind === 'DISCOUNT' && styles.kindChipDiscount]}
                        onPress={() => cycleKind(row)}
                        accessibilityRole="button"
                        accessibilityLabel={`Loại: ${RECEIPT_KIND_LABEL[row.kind]}. Chạm để đổi`}
                      >
                        <Text style={styles.kindChipText}>{RECEIPT_KIND_LABEL[row.kind]}</Text>
                      </Pressable>
                      <TextInput
                        style={[styles.input, styles.nameInput]}
                        placeholder="Tên món"
                        placeholderTextColor="#999"
                        value={row.name}
                        onChangeText={(t) => updateRow(row.key, { name: t })}
                        maxLength={RECEIPT_ITEM_NAME_MAX}
                      />
                      <Pressable onPress={() => removeRow(row.key)} hitSlop={8} accessibilityLabel="Xóa dòng">
                        <Text style={styles.removeText}>✕</Text>
                      </Pressable>
                    </View>
                    <View style={styles.rowBottom}>
                      {row.kind === 'ITEM' ? (
                        <>
                          <Text style={styles.smallLabel}>SL</Text>
                          <TextInput
                            style={[styles.input, styles.qtyInput]}
                            keyboardType="number-pad"
                            value={row.quantity}
                            onChangeText={(t) => updateRow(row.key, { quantity: t.replace(/\D/g, '').slice(0, 3) })}
                          />
                        </>
                      ) : null}
                      <Text style={[styles.smallLabel, styles.amountLabel]}>
                        {row.kind === 'DISCOUNT' ? '− Số tiền' : 'Thành tiền'}
                      </Text>
                      <TextInput
                        style={[styles.input, styles.amountInput]}
                        keyboardType="numeric"
                        placeholder="0"
                        placeholderTextColor="#999"
                        value={row.amount}
                        onChangeText={(t) => updateRow(row.key, { amount: t })}
                      />
                    </View>
                  </View>
                ))}
                <Pressable style={styles.addBtn} onPress={addRow}>
                  <Text style={styles.addBtnText}>+ Thêm dòng</Text>
                </Pressable>

                {/* BR-13: tổng các dòng so với tổng in trên hóa đơn */}
                <View style={styles.summary}>
                  <View style={styles.summaryRow}>
                    <Text style={styles.summaryLabel}>Tổng các dòng</Text>
                    <Text style={styles.summaryValue}>{formatVND(sum)}</Text>
                  </View>
                  <View style={styles.summaryRow}>
                    <Text style={styles.summaryLabel}>Tổng trên hóa đơn</Text>
                    <TextInput
                      style={[styles.input, styles.amountInput]}
                      keyboardType="numeric"
                      placeholder="Không có"
                      placeholderTextColor="#999"
                      value={printedText}
                      onChangeText={setPrintedText}
                    />
                  </View>
                  {hasPrinted && diff !== 0 ? (
                    <Text style={styles.warning}>
                      ⚠️ Các dòng {diff > 0 ? 'nhiều hơn' : 'ít hơn'} tổng trên hóa đơn {formatVND(Math.abs(diff))}. Kiểm tra
                      món bị đọc sai; khoản chi sẽ dùng tổng trên hóa đơn.
                    </Text>
                  ) : hasPrinted ? (
                    <Text style={styles.ok}>✓ Khớp tổng trên hóa đơn</Text>
                  ) : null}
                  <View style={[styles.summaryRow, styles.totalRow]}>
                    <Text style={styles.totalLabel}>Tổng khoản chi</Text>
                    <Text style={styles.totalValue}>{formatVND(total)}</Text>
                  </View>
                </View>

                <Pressable style={[styles.applyBtn, !canApply && styles.applyBtnDisabled]} onPress={apply} disabled={!canApply}>
                  <Text style={styles.applyBtnText}>Dùng hóa đơn này</Text>
                </Pressable>
              </>
            )}
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
      <ReceiptViewer uri={imageUri} visible={viewing} onClose={() => setViewing(false)} />
    </Modal>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: '#f2f2f7' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: '#fff',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#ddd',
  },
  headerTitle: { fontSize: 17, fontWeight: '600', color: '#1a1a1a' },
  headerAction: { fontSize: 16, color: '#007AFF' },
  headerActionStrong: { fontWeight: '600' },
  disabledText: { opacity: 0.4 },
  container: { flex: 1 },
  content: { padding: 16, gap: 10, paddingBottom: 40 },
  thumb: { width: '100%', height: 160, borderRadius: 12, backgroundColor: '#e5e5ea' },
  disclaimer: { fontSize: 12, color: '#8E8E93' },
  reading: { alignItems: 'center', paddingVertical: 48, gap: 12 },
  readingText: { fontSize: 15, color: '#666' },
  errorText: { fontSize: 14, color: '#FF9500' },
  rereadBtn: { alignSelf: 'flex-start' },
  rereadText: { fontSize: 14, color: '#007AFF', fontWeight: '600' },
  label: { fontSize: 15, fontWeight: '600', color: '#1a1a1a', marginTop: 4 },
  hint: { fontSize: 12, color: '#8E8E93', marginTop: -6 },
  input: {
    borderWidth: 1,
    borderColor: '#ddd',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
    backgroundColor: '#fff',
    color: '#1a1a1a',
  },
  rowCard: { backgroundColor: '#fff', borderRadius: 12, padding: 10, gap: 8 },
  rowTop: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  rowBottom: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  kindChip: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 14, backgroundColor: '#e5f0ff' },
  kindChipExtra: { backgroundColor: '#FFF3E0' },
  kindChipDiscount: { backgroundColor: '#E8F8EC' },
  kindChipText: { fontSize: 12, fontWeight: '600', color: '#1a1a1a' },
  nameInput: { flex: 1 },
  removeText: { fontSize: 18, color: '#FF3B30', paddingHorizontal: 4 },
  smallLabel: { fontSize: 13, color: '#666' },
  amountLabel: { marginLeft: 'auto' },
  qtyInput: { width: 56, textAlign: 'center' },
  amountInput: { width: 130, textAlign: 'right' },
  addBtn: {
    borderWidth: 1,
    borderColor: '#007AFF',
    borderStyle: 'dashed',
    borderRadius: 12,
    padding: 12,
    alignItems: 'center',
  },
  addBtnText: { fontSize: 15, color: '#007AFF', fontWeight: '600' },
  summary: { backgroundColor: '#fff', borderRadius: 12, padding: 12, gap: 8, marginTop: 4 },
  summaryRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  summaryLabel: { fontSize: 14, color: '#666' },
  summaryValue: { fontSize: 15, color: '#1a1a1a', fontWeight: '500' },
  warning: { fontSize: 13, color: '#FF3B30', lineHeight: 18 },
  ok: { fontSize: 13, color: '#34C759' },
  totalRow: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: '#ddd', paddingTop: 8 },
  totalLabel: { fontSize: 16, fontWeight: '600', color: '#1a1a1a' },
  totalValue: { fontSize: 18, fontWeight: '700', color: '#007AFF' },
  applyBtn: { backgroundColor: '#007AFF', borderRadius: 12, padding: 16, alignItems: 'center', marginTop: 8 },
  applyBtnDisabled: { opacity: 0.5 },
  applyBtnText: { color: '#fff', fontSize: 16, fontWeight: '600' },
});
