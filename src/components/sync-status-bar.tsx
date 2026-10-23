/**
 * Thanh trạng thái đồng bộ (DEV mục 6):
 * - APP-08: số thao tác "Chưa đồng bộ"; thao tác lỗi kèm lý do và nút Thử lại / Bỏ
 * - REV-A3: mục PENDING cũng bỏ được (xem danh sách bằng nút "Chi tiết")
 * - REV-A6: không tự đệm safe-area; _layout bọc thanh bằng phần đệm insets.top
 * - APP-12: "Đồng bộ lúc HH:mm DD/MM" theo lần tải dữ liệu thành công gần nhất trong cache,
 *   hiện khi mất mạng hoặc còn thao tác chưa đồng bộ
 */

import React, { useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';

import type { QueueItem } from '@/offline/queue';
import { Colors, Spacing, Radii, FontSizes, FontWeights } from '@/lib/theme';

interface Props {
  pendingCount: number;
  /** REV-A3: mục đang chờ gửi — cho phép bỏ */
  pendingItems: QueueItem[];
  failedItems: QueueItem[];
  lastSyncAt: Date | null;
  isSyncing: boolean;
  isOnline: boolean;
  onSyncPress: () => void;
  onRetry: (id: number) => void;
  onDiscard: (id: number) => void;
  describeItem: (item: QueueItem) => string;
}

/** HH:mm DD/MM — giờ 24h (Asia/Ho_Chi_Minh theo máy người dùng) */
export function formatSyncTime(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())} ${pad(d.getDate())}/${pad(d.getMonth() + 1)}`;
}

/** REV-A6: _layout dùng để biết có cần chừa chỗ cho thanh hay không */
export function isSyncStatusBarVisible(p: { pendingCount: number; failedCount: number; isOnline: boolean }): boolean {
  // Không hiện chỉ vì lượt đồng bộ định kỳ đang chạy khi không có gì chờ (tránh nhấp nháy mỗi 30 giây)
  return !p.isOnline || p.pendingCount > 0 || p.failedCount > 0;
}

export function SyncStatusBar({
  pendingCount,
  pendingItems,
  failedItems,
  lastSyncAt,
  isSyncing,
  isOnline,
  onSyncPress,
  onRetry,
  onDiscard,
  describeItem,
}: Props) {
  const [showPending, setShowPending] = useState(false);
  if (!isSyncStatusBarVisible({ pendingCount, failedCount: failedItems.length, isOnline })) return null;

  const confirmDiscard = (item: QueueItem) => {
    Alert.alert('Bỏ thao tác', `Bỏ "${describeItem(item)}"? Thao tác này sẽ không được gửi lên máy chủ (nếu đang gửi dở, máy chủ có thể vẫn đã nhận).`, [
      { text: 'Giữ lại', style: 'cancel' },
      { text: 'Bỏ', style: 'destructive', onPress: () => onDiscard(item.id) },
    ]);
  };

  return (
    <View style={styles.wrapper}>
      <Pressable style={styles.container} onPress={onSyncPress} disabled={isSyncing}>
        {isSyncing ? (
          <Text style={styles.text}>🔄 Đang đồng bộ...</Text>
        ) : pendingCount > 0 ? (
          <Text style={styles.textWarning}>
            ⚠️ {pendingCount} thao tác chưa đồng bộ. Nhấn để thử lại.
          </Text>
        ) : !isOnline ? (
          <Text style={styles.textWarning}>📴 Đang ngoại tuyến — dữ liệu có thể chưa mới nhất</Text>
        ) : (
          <Text style={styles.textWarning}>Có thao tác lỗi cần xử lý</Text>
        )}
        {lastSyncAt && (
          <Text style={styles.timestamp}>Đồng bộ lúc {formatSyncTime(lastSyncAt)}</Text>
        )}
      </Pressable>

      {/* REV-A3: mục PENDING (ví dụ lỗi máy chủ kéo dài) — người dùng có thể bỏ */}
      {pendingItems.length > 0 && (
        <Pressable style={styles.toggleRow} onPress={() => setShowPending((v) => !v)}>
          <Text style={styles.toggleText}>{showPending ? 'Ẩn danh sách chờ gửi' : 'Chi tiết thao tác chờ gửi'}</Text>
        </Pressable>
      )}
      {showPending &&
        pendingItems.map((item) => (
          <View key={item.id} style={styles.failedRow}>
            <View style={styles.failedInfo}>
              <Text style={styles.pendingTitle} numberOfLines={1}>
                ⏳ {describeItem(item)}
              </Text>
              {item.error_message ? (
                <Text style={styles.failedError} numberOfLines={2}>
                  {item.error_message}
                </Text>
              ) : null}
            </View>
            <Pressable style={styles.discardBtn} onPress={() => confirmDiscard(item)}>
              <Text style={styles.discardBtnText}>Bỏ</Text>
            </Pressable>
          </View>
        ))}

      {failedItems.map((item) => (
        <View key={item.id} style={styles.failedRow}>
          <View style={styles.failedInfo}>
            <Text style={styles.failedTitle} numberOfLines={1}>
              ❌ {describeItem(item)}
            </Text>
            {item.error_message ? (
              <Text style={styles.failedError} numberOfLines={2}>
                {item.error_message}
              </Text>
            ) : null}
          </View>
          <Pressable style={styles.retryBtn} onPress={() => onRetry(item.id)}>
            <Text style={styles.retryBtnText}>Thử lại</Text>
          </Pressable>
          <Pressable style={styles.discardBtn} onPress={() => confirmDiscard(item)}>
            <Text style={styles.discardBtnText}>Bỏ</Text>
          </Pressable>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    backgroundColor: Colors.warningLight,
    borderBottomWidth: 1,
    borderBottomColor: Colors.warning,
  },
  container: {
    paddingVertical: Spacing.sm,
    paddingHorizontal: Spacing.lg,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: Spacing.sm,
  },
  text: { fontSize: FontSizes.sm, color: Colors.warningDark },
  textWarning: { fontSize: FontSizes.sm, color: Colors.warningDark, flex: 1 },
  timestamp: { fontSize: FontSizes.xs, color: Colors.warning },

  failedRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    paddingVertical: 6,
    paddingHorizontal: Spacing.lg,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: Colors.warning,
  },
  failedInfo: { flex: 1, gap: 2 },
  pendingTitle: { fontSize: FontSizes.sm, color: Colors.warningDark, fontWeight: FontWeights.medium },
  toggleRow: { paddingHorizontal: Spacing.lg, paddingBottom: 6 },
  toggleText: { fontSize: 12, color: Colors.primary, fontWeight: FontWeights.medium },
  failedTitle: { fontSize: FontSizes.sm, color: Colors.dangerDark, fontWeight: FontWeights.medium },
  failedError: { fontSize: 12, color: Colors.textSecondary },
  retryBtn: { backgroundColor: Colors.primary, borderRadius: 6, paddingHorizontal: 10, paddingVertical: 5 },
  retryBtnText: { color: Colors.textInverse, fontSize: 12, fontWeight: FontWeights.semibold },
  discardBtn: { borderRadius: 6, paddingHorizontal: 10, paddingVertical: 5, borderWidth: 1, borderColor: Colors.danger },
  discardBtnText: { color: Colors.danger, fontSize: 12, fontWeight: FontWeights.semibold },
});
