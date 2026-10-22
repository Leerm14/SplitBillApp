/**
 * APP-01 / APP-19: Trạng thái lỗi dùng chung — thay cho việc hiện màn rỗng khi query
 * hoặc phép tính công nợ lỗi.
 */

import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

interface Props {
  title?: string;
  message?: string | null;
  onRetry?: () => void;
  /** Hiện gọn trong một thẻ (giữa màn hình khác) thay vì chiếm cả màn hình */
  inline?: boolean;
}

export function ErrorState({ title = 'Không thể tải dữ liệu', message, onRetry, inline }: Props) {
  return (
    <View style={inline ? styles.inline : styles.center}>
      <Text style={styles.title}>⚠️ {title}</Text>
      {message ? <Text style={styles.message}>{message}</Text> : null}
      {onRetry ? (
        <Pressable style={styles.retryBtn} onPress={onRetry}>
          <Text style={styles.retryBtnText}>Thử lại</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 24, gap: 8 },
  inline: {
    backgroundColor: '#FFEBEE',
    borderRadius: 12,
    padding: 16,
    alignItems: 'center',
    gap: 8,
  },
  title: { fontSize: 16, color: '#FF3B30', textAlign: 'center', fontWeight: '600' },
  message: { fontSize: 14, color: '#8E8E93', textAlign: 'center' },
  retryBtn: {
    backgroundColor: '#007AFF',
    paddingHorizontal: 24,
    paddingVertical: 10,
    borderRadius: 10,
    marginTop: 4,
  },
  retryBtnText: { color: '#fff', fontWeight: '600' },
});
