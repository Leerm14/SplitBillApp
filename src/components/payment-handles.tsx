/**
 * MVP-07: Phương thức thanh toán của người nhận (ngân hàng / ví / khác) kèm nút sao chép.
 * Số tài khoản là dữ liệu cá nhân: chỉ đọc được qua policy (chính mình, người chung nhóm, bạn bè),
 * không ghi log.
 */
import { useQuery } from '@tanstack/react-query';
import * as Clipboard from 'expo-clipboard';
import React, { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { fetchPaymentHandles, type PaymentHandle } from '@/api/contacts';

export const PAYMENT_HANDLE_TYPE_LABEL: Record<string, string> = {
  BANK: 'Ngân hàng',
  EWALLET: 'Ví điện tử',
  OTHER: 'Khác',
};

export function paymentHandleTypeLabel(type: string): string {
  return PAYMENT_HANDLE_TYPE_LABEL[type] ?? type;
}

function HandleRow({ handle }: { handle: PaymentHandle }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await Clipboard.setStringAsync(handle.display_text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };
  return (
    <View style={styles.row}>
      <View style={styles.info}>
        <Text style={styles.type}>{paymentHandleTypeLabel(handle.type)}</Text>
        <Text style={styles.text} selectable>
          {handle.display_text}
        </Text>
      </View>
      <Pressable
        style={[styles.copyBtn, copied && styles.copyBtnDone]}
        onPress={copy}
        accessibilityRole="button"
        accessibilityLabel={`Sao chép ${paymentHandleTypeLabel(handle.type)}`}
      >
        <Text style={[styles.copyText, copied && styles.copyTextDone]}>{copied ? 'Đã chép' : 'Sao chép'}</Text>
      </Pressable>
    </View>
  );
}

export function PaymentHandleList({ handles }: { handles: PaymentHandle[] }) {
  return (
    <View style={styles.list}>
      {handles.map((h) => (
        <HandleRow key={h.id} handle={h} />
      ))}
    </View>
  );
}

/**
 * Phương thức thanh toán của `userId` (tải riêng). Không có → hiện gợi ý ngắn (hoặc không hiện gì
 * nếu `hideWhenEmpty`).
 */
export function RecipientPaymentHandles({
  userId,
  name,
  hideWhenEmpty,
}: {
  userId: string;
  name?: string;
  hideWhenEmpty?: boolean;
}) {
  const q = useQuery({
    queryKey: ['paymentHandles', userId],
    queryFn: () => fetchPaymentHandles(userId),
    enabled: !!userId,
  });
  if (q.isLoading) return <ActivityIndicator size="small" color="#8E8E93" style={styles.loading} />;
  const handles = q.data ?? [];
  if (handles.length === 0) {
    if (hideWhenEmpty || q.isError) return null;
    return <Text style={styles.empty}>{name ? `${name} chưa thêm phương thức thanh toán.` : 'Chưa có phương thức thanh toán.'}</Text>;
  }
  return <PaymentHandleList handles={handles} />;
}

const styles = StyleSheet.create({
  list: { gap: 6 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: '#f7f7fa',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  info: { flex: 1 },
  type: { fontSize: 11, color: '#8E8E93', textTransform: 'uppercase', fontWeight: '600' },
  text: { fontSize: 14, color: '#1a1a1a', marginTop: 2 },
  copyBtn: { borderWidth: 1, borderColor: '#007AFF', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 5 },
  copyBtnDone: { borderColor: '#34C759', backgroundColor: '#E8F8EC' },
  copyText: { fontSize: 12, color: '#007AFF', fontWeight: '600' },
  copyTextDone: { color: '#34C759' },
  loading: { alignSelf: 'flex-start', marginVertical: 4 },
  empty: { fontSize: 12, color: '#8E8E93', fontStyle: 'italic' },
});
