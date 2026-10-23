/**
 * MVP-07: Phương thức thanh toán của người nhận (ngân hàng / ví / khác) kèm nút sao chép.
 * Số tài khoản là dữ liệu cá nhân: chỉ đọc được qua policy (chính mình, người chung nhóm, bạn bè),
 * không ghi log.
 */
import { useQuery } from '@tanstack/react-query';
import * as Clipboard from 'expo-clipboard';
import React, { useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import QRCode from 'react-native-qrcode-svg';

import { fetchPaymentHandles, type PaymentHandle } from '@/api/contacts';
import { formatVND } from '@/domain/money';
import { bankHandleQR } from '@/domain/vietqr';
import { saveQRToLibrary, type QRSvgRef } from '@/lib/qr-image';
import { Colors, Spacing, Radii, FontSizes, FontWeights } from '@/lib/theme';

/** Số tiền / nội dung điền sẵn vào mã VietQR (không bắt buộc) */
export type TransferPrefill = { amount?: number | null; memo?: string | null };

export const PAYMENT_HANDLE_TYPE_LABEL: Record<string, string> = {
  BANK: 'Ngân hàng',
  EWALLET: 'Ví điện tử',
  OTHER: 'Khác',
};

export function paymentHandleTypeLabel(type: string): string {
  return PAYMENT_HANDLE_TYPE_LABEL[type] ?? type;
}

function useCopy(text: string) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await Clipboard.setStringAsync(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };
  return { copied, copy };
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const { copied, copy } = useCopy(text);
  return (
    <Pressable
      style={[styles.copyBtn, copied && styles.copyBtnDone]}
      onPress={copy}
      accessibilityRole="button"
      accessibilityLabel={`Sao chép ${label}`}
    >
      <Text style={[styles.copyText, copied && styles.copyTextDone]}>{copied ? 'Đã chép' : 'Sao chép'}</Text>
    </Pressable>
  );
}

/** Ngân hàng nhận ra được → mã VietQR (app ngân hàng quét là điền sẵn tài khoản, số tiền, nội dung) */
function BankQRCard({ handle, prefill }: { handle: PaymentHandle; prefill?: TransferPrefill }) {
  const amount = prefill?.amount && prefill.amount > 0 ? prefill.amount : null;
  const memo = prefill?.memo ?? null;
  const qr = useMemo(() => bankHandleQR(handle.display_text, { amount, memo }), [handle.display_text, amount, memo]);
  const svgRef = useRef<QRSvgRef | null>(null);
  const [saving, setSaving] = useState(false);
  if (!qr) return <HandleRow handle={handle} />;
  const { bank, accountNumber, accountName } = qr.parsed;

  // Người trả dùng chính máy này: lưu ảnh rồi chọn ảnh trong mục Quét QR của app ngân hàng
  const saveImage = async () => {
    if (!svgRef.current || saving) return;
    setSaving(true);
    try {
      const res = await saveQRToLibrary(svgRef.current);
      if (res === 'denied') {
        Alert.alert('Chưa có quyền lưu ảnh', 'Hãy cho phép ứng dụng lưu ảnh trong Cài đặt rồi thử lại.');
      } else {
        Alert.alert(
          'Đã lưu ảnh mã QR',
          'Mở app ngân hàng → Quét QR → chọn ảnh từ thư viện để chuyển khoản.',
        );
      }
    } catch (err) {
      console.warn('[BankQRCard] save QR failed:', (err as Error)?.message);
      Alert.alert('Lỗi', 'Không lưu được ảnh mã QR. Bạn có thể sao chép số tài khoản để chuyển khoản.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <View style={styles.qrCard}>
      <View style={styles.qrBox}>
        <QRCode
          value={qr.payload}
          size={180}
          quietZone={12}
          backgroundColor="#fff"
          ecl="M"
          getRef={(c) => {
            svgRef.current = c;
          }}
        />
      </View>
      <Text style={styles.qrHint}>Quét bằng app ngân hàng để chuyển khoản{amount ? ` ${formatVND(amount)}` : ''}</Text>
      {Platform.OS !== 'web' ? (
        <Pressable
          style={[styles.saveQrBtn, saving && styles.saveQrBtnDisabled]}
          onPress={saveImage}
          disabled={saving}
          accessibilityRole="button"
          accessibilityLabel="Lưu ảnh mã QR vào thư viện ảnh"
        >
          {saving ? (
            <ActivityIndicator size="small" color={Colors.primary} />
          ) : (
            <Text style={styles.saveQrText}>⬇️ Lưu ảnh QR</Text>
          )}
        </Pressable>
      ) : null}
      <View style={styles.qrInfo}>
        <View style={styles.info}>
          <Text style={styles.type}>{bank.name}</Text>
          <Text style={styles.text} selectable>
            {accountNumber}
          </Text>
          {accountName ? <Text style={styles.accountName}>{accountName}</Text> : null}
        </View>
        <CopyButton text={accountNumber} label="số tài khoản" />
      </View>
    </View>
  );
}

function HandleRow({ handle }: { handle: PaymentHandle }) {
  return (
    <View style={styles.row}>
      <View style={styles.info}>
        <Text style={styles.type}>{paymentHandleTypeLabel(handle.type)}</Text>
        <Text style={styles.text} selectable>
          {handle.display_text}
        </Text>
      </View>
      <CopyButton text={handle.display_text} label={paymentHandleTypeLabel(handle.type)} />
    </View>
  );
}

export function PaymentHandleList({ handles, prefill }: { handles: PaymentHandle[]; prefill?: TransferPrefill }) {
  return (
    <View style={styles.list}>
      {handles.map((h) =>
        h.type === 'BANK' ? <BankQRCard key={h.id} handle={h} prefill={prefill} /> : <HandleRow key={h.id} handle={h} />,
      )}
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
  prefill,
}: {
  userId: string;
  name?: string;
  hideWhenEmpty?: boolean;
  prefill?: TransferPrefill;
}) {
  const q = useQuery({
    queryKey: ['paymentHandles', userId],
    queryFn: () => fetchPaymentHandles(userId),
    enabled: !!userId,
  });
  if (q.isLoading) return <ActivityIndicator size="small" color={Colors.textTertiary} style={styles.loading} />;
  const handles = q.data ?? [];
  if (handles.length === 0) {
    if (hideWhenEmpty || q.isError) return null;
    return <Text style={styles.empty}>{name ? `${name} chưa thêm phương thức thanh toán.` : 'Chưa có phương thức thanh toán.'}</Text>;
  }
  return <PaymentHandleList handles={handles} prefill={prefill} />;
}

const styles = StyleSheet.create({
  list: { gap: 6 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md - 2,
    backgroundColor: Colors.borderLight,
    borderRadius: Radii.sm + 2,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
  },
  info: { flex: 1 },
  type: { fontSize: FontSizes.xs, color: Colors.textTertiary, textTransform: 'uppercase', fontWeight: FontWeights.semibold },
  text: { fontSize: FontSizes.md - 1, color: Colors.text, marginTop: 2 },
  copyBtn: { borderWidth: 1, borderColor: Colors.primary, borderRadius: Radii.sm, paddingHorizontal: 10, paddingVertical: 5 },
  copyBtnDone: { borderColor: Colors.success, backgroundColor: Colors.successLight },
  copyText: { fontSize: 12, color: Colors.primary, fontWeight: FontWeights.semibold },
  copyTextDone: { color: Colors.success },
  loading: { alignSelf: 'flex-start', marginVertical: Spacing.xs },
  empty: { fontSize: 12, color: Colors.textTertiary, fontStyle: 'italic' },
  qrCard: {
    backgroundColor: Colors.borderLight,
    borderRadius: Radii.sm + 2,
    padding: Spacing.md,
    alignItems: 'center',
    gap: Spacing.sm,
  },
  qrBox: { backgroundColor: '#fff', borderRadius: Radii.md, overflow: 'hidden' },
  saveQrBtn: {
    borderWidth: 1,
    borderColor: Colors.primary,
    borderRadius: Radii.sm,
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.sm,
    minWidth: 140,
    alignItems: 'center',
  },
  saveQrBtnDisabled: { opacity: 0.6 },
  saveQrText: { fontSize: FontSizes.sm, color: Colors.primary, fontWeight: FontWeights.semibold },
  qrHint: { fontSize: 12, color: Colors.textSecondary, textAlign: 'center' },
  qrInfo: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md - 2, alignSelf: 'stretch' },
  accountName: { fontSize: FontSizes.sm, color: Colors.textSecondary, marginTop: 2 },
});
