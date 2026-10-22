import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import React, { useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { toUserMessage } from '@/api/errors';
import {
  addPaymentHandle,
  deletePaymentHandle,
  fetchPaymentHandles,
  normalizePaymentHandleText,
  PAYMENT_HANDLE_MAX_LENGTH,
  updatePaymentHandle,
  type PaymentHandle,
} from '@/api/contacts';

const HANDLE_TYPES = [
  { value: 'BANK', label: 'Ngân hàng' },
  { value: 'EWALLET', label: 'Ví điện tử' },
  { value: 'OTHER', label: 'Khác' },
] as const;

/** MVP-07: thông tin thanh toán hiện cho người chung nhóm / bạn bè — tuyệt đối không nhập bí mật */
const SECRET_WARNING = 'Không nhập mật khẩu, mã OTP hay số CVV';

export default function PaymentMethodsScreen() {
  const queryClient = useQueryClient();
  // null = đóng; 'new' = thêm; còn lại = id đang sửa
  const [editing, setEditing] = useState<string | null>(null);
  const [formType, setFormType] = useState<string>('BANK');
  const [formText, setFormText] = useState('');

  const handlesQ = useQuery({
    queryKey: ['myPaymentHandles'],
    queryFn: () => fetchPaymentHandles(),
  });

  const closeForm = () => {
    setEditing(null);
    setFormText('');
    setFormType('BANK');
  };

  const openAdd = () => {
    setFormType('BANK');
    setFormText('');
    setEditing('new');
  };

  const openEdit = (handle: PaymentHandle) => {
    setFormType(handle.type);
    setFormText(handle.display_text);
    setEditing(handle.id);
  };

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['myPaymentHandles'] });
    queryClient.invalidateQueries({ queryKey: ['paymentHandles'] });
  };

  const saveMutation = useMutation({
    mutationFn: () => {
      const text = normalizePaymentHandleText(formText);
      return editing && editing !== 'new'
        ? updatePaymentHandle(editing, formType, text)
        : addPaymentHandle(formType, text);
    },
    onSuccess: () => {
      const wasEdit = editing !== 'new';
      invalidate();
      closeForm();
      Alert.alert('Thành công', wasEdit ? 'Đã cập nhật phương thức thanh toán' : 'Đã thêm phương thức thanh toán');
    },
    onError: (err: unknown) => {
      Alert.alert('Lỗi', toUserMessage(err, 'Không thể lưu'));
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deletePaymentHandle(id),
    onSuccess: invalidate,
    onError: (err: unknown) => {
      Alert.alert('Lỗi', toUserMessage(err, 'Không thể xóa'));
    },
  });

  const handleDelete = (handle: PaymentHandle) => {
    Alert.alert('Xóa phương thức', `Xóa "${handle.display_text}"?`, [
      { text: 'Hủy', style: 'cancel' },
      { text: 'Xóa', style: 'destructive', onPress: () => deleteMutation.mutate(handle.id) },
    ]);
  };

  const trimmedLength = formText.trim().length;
  const canSave = trimmedLength > 0 && trimmedLength <= PAYMENT_HANDLE_MAX_LENGTH && !saveMutation.isPending;

  const typeLabel = (type: string) => HANDLE_TYPES.find(t => t.value === type)?.label ?? type;
  const typeIcon = (type: string) => {
    switch (type) {
      case 'BANK': return '🏦';
      case 'EWALLET': return '📱';
      default: return '💳';
    }
  };

  return (
    <SafeAreaView style={styles.container} edges={['bottom']}>
      <FlatList
        data={handlesQ.data ?? []}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.list}
        ListEmptyComponent={
          handlesQ.isLoading ? (
            <View style={styles.center}>
              <ActivityIndicator size="large" color="#007AFF" />
            </View>
          ) : (
            <View style={styles.emptyState}>
              <Text style={styles.emptyIcon}>💳</Text>
              <Text style={styles.emptyTitle}>Chưa có phương thức thanh toán</Text>
              <Text style={styles.emptyDesc}>
                Thêm thông tin ngân hàng hoặc ví điện tử để bạn bè thanh toán cho bạn dễ dàng hơn.
              </Text>
            </View>
          )
        }
        renderItem={({ item }) => (
          <View style={styles.handleCard}>
            <View style={styles.handleRow}>
              <Text style={styles.handleIcon}>{typeIcon(item.type)}</Text>
              <View style={styles.handleInfo}>
                <Text style={styles.handleType}>{typeLabel(item.type)}</Text>
                <Text style={styles.handleText}>{item.display_text}</Text>
              </View>
              <View style={styles.rowActions}>
                <Pressable style={styles.editBtn} onPress={() => openEdit(item)}>
                  <Text style={styles.editBtnText}>Sửa</Text>
                </Pressable>
                <Pressable style={styles.deleteBtn} onPress={() => handleDelete(item)}>
                  <Text style={styles.deleteBtnText}>Xóa</Text>
                </Pressable>
              </View>
            </View>
          </View>
        )}
        ListHeaderComponent={
          <View style={styles.warning}>
            <Text style={styles.warningText}>⚠️ {SECRET_WARNING}. Thông tin này hiện cho bạn bè và người chung nhóm.</Text>
          </View>
        }
        ListFooterComponent={
          <Pressable style={styles.addBtn} onPress={openAdd}>
            <Text style={styles.addBtnText}>+ Thêm phương thức thanh toán</Text>
          </Pressable>
        }
      />

      {/* Thêm / sửa */}
      <Modal visible={editing !== null} animationType="slide" transparent onRequestClose={closeForm}>
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <Text style={styles.modalTitle}>
              {editing === 'new' ? 'Thêm phương thức thanh toán' : 'Sửa phương thức thanh toán'}
            </Text>

            {/* Type selector */}
            <Text style={styles.fieldLabel}>Loại</Text>
            <View style={styles.typeRow}>
              {HANDLE_TYPES.map((t) => (
                <Pressable
                  key={t.value}
                  style={[styles.typeChip, formType === t.value && styles.typeChipActive]}
                  onPress={() => setFormType(t.value)}
                >
                  <Text style={[styles.typeChipText, formType === t.value && styles.typeChipTextActive]}>
                    {t.label}
                  </Text>
                </Pressable>
              ))}
            </View>

            {/* Display text */}
            <Text style={styles.fieldLabel}>Thông tin</Text>
            <TextInput
              style={styles.input}
              placeholder={formType === 'BANK' ? 'VD: Vietcombank - 1234567890 - Nguyễn Văn A' : 'VD: MoMo - 0901234567'}
              placeholderTextColor="#999"
              value={formText}
              onChangeText={setFormText}
              maxLength={PAYMENT_HANDLE_MAX_LENGTH}
              multiline
            />
            <View style={styles.inputMeta}>
              <Text style={styles.inputWarning}>{SECRET_WARNING}</Text>
              <Text style={styles.counter}>
                {trimmedLength}/{PAYMENT_HANDLE_MAX_LENGTH}
              </Text>
            </View>

            <View style={styles.modalActions}>
              <Pressable style={styles.cancelBtn} onPress={closeForm}>
                <Text style={styles.cancelBtnText}>Hủy</Text>
              </Pressable>
              <Pressable
                style={[styles.saveBtn, !canSave && styles.saveBtnDisabled]}
                onPress={() => saveMutation.mutate()}
                disabled={!canSave}
              >
                {saveMutation.isPending ? (
                  <ActivityIndicator color="#fff" size="small" />
                ) : (
                  <Text style={styles.saveBtnText}>Lưu</Text>
                )}
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f2f2f7' },
  list: { padding: 16, gap: 12, flexGrow: 1 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', paddingTop: 64 },
  emptyState: { alignItems: 'center', paddingTop: 64, paddingHorizontal: 32 },
  emptyIcon: { fontSize: 48, marginBottom: 16 },
  emptyTitle: { fontSize: 18, fontWeight: '600', color: '#1a1a1a', marginBottom: 8 },
  emptyDesc: { fontSize: 14, color: '#8E8E93', textAlign: 'center', lineHeight: 20 },
  handleCard: {
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 16,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 4,
    elevation: 2,
  },
  handleRow: { flexDirection: 'row', alignItems: 'center' },
  handleIcon: { fontSize: 28, marginRight: 12 },
  handleInfo: { flex: 1 },
  handleType: { fontSize: 13, color: '#8E8E93', marginBottom: 2 },
  handleText: { fontSize: 16, color: '#1a1a1a', fontWeight: '500' },
  deleteBtn: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#FF3B30',
  },
  deleteBtnText: { color: '#FF3B30', fontSize: 14, fontWeight: '500' },
  addBtn: {
    backgroundColor: '#007AFF',
    borderRadius: 12,
    padding: 16,
    alignItems: 'center',
    marginTop: 4,
  },
  addBtnText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.4)',
    justifyContent: 'flex-end',
  },
  modalContent: {
    backgroundColor: '#fff',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    padding: 24,
    paddingBottom: 40,
  },
  modalTitle: { fontSize: 20, fontWeight: '700', color: '#1a1a1a', marginBottom: 20 },
  fieldLabel: { fontSize: 14, fontWeight: '600', color: '#1a1a1a', marginBottom: 8 },
  typeRow: { flexDirection: 'row', gap: 8, marginBottom: 20 },
  typeChip: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 20,
    backgroundColor: '#f2f2f7',
    borderWidth: 1,
    borderColor: '#E5E5EA',
  },
  typeChipActive: { backgroundColor: '#007AFF', borderColor: '#007AFF' },
  typeChipText: { fontSize: 14, color: '#1a1a1a' },
  typeChipTextActive: { color: '#fff', fontWeight: '600' },
  input: {
    backgroundColor: '#f2f2f7',
    borderRadius: 12,
    padding: 14,
    fontSize: 16,
    color: '#1a1a1a',
    minHeight: 56,
    textAlignVertical: 'top',
  },
  inputMeta: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 6, marginBottom: 20, gap: 8 },
  inputWarning: { flex: 1, fontSize: 12, color: '#FF3B30' },
  counter: { fontSize: 12, color: '#8E8E93' },
  warning: { backgroundColor: '#FFF3E0', borderRadius: 10, padding: 12, borderLeftWidth: 4, borderLeftColor: '#FF9500' },
  warningText: { fontSize: 13, color: '#8A4B00', lineHeight: 18 },
  rowActions: { flexDirection: 'row', gap: 8 },
  editBtn: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#007AFF',
  },
  editBtnText: { color: '#007AFF', fontSize: 14, fontWeight: '500' },
  modalActions: { flexDirection: 'row', gap: 12 },
  cancelBtn: {
    flex: 1,
    backgroundColor: '#f2f2f7',
    borderRadius: 12,
    padding: 16,
    alignItems: 'center',
  },
  cancelBtnText: { color: '#1a1a1a', fontSize: 16, fontWeight: '600' },
  saveBtn: {
    flex: 1,
    backgroundColor: '#007AFF',
    borderRadius: 12,
    padding: 16,
    alignItems: 'center',
  },
  saveBtnDisabled: { opacity: 0.5 },
  saveBtnText: { color: '#fff', fontSize: 16, fontWeight: '600' },
});
