/**
 * APP-01 / APP-19: Trạng thái lỗi dùng chung — thay cho việc hiện màn rỗng khi query
 * hoặc phép tính công nợ lỗi.
 */

import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Colors, Spacing, Radii, FontSizes, FontWeights } from '@/lib/theme';

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
  center: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: Spacing.xxl,
    gap: Spacing.md,
  },
  inline: {
    backgroundColor: Colors.dangerLight,
    borderRadius: Radii.lg,
    padding: Spacing.lg,
    alignItems: 'center',
    gap: Spacing.sm,
    borderWidth: 1,
    borderColor: Colors.danger + '30',
  },
  title: {
    fontSize: FontSizes.md,
    color: Colors.danger,
    textAlign: 'center',
    fontWeight: FontWeights.semibold,
  },
  message: {
    fontSize: FontSizes.sm,
    color: Colors.textSecondary,
    textAlign: 'center',
    lineHeight: 20,
  },
  retryBtn: {
    backgroundColor: Colors.primary,
    paddingHorizontal: Spacing.xxl,
    paddingVertical: Spacing.md,
    borderRadius: Radii.md,
    marginTop: Spacing.xs,
  },
  retryBtnText: {
    color: Colors.textInverse,
    fontWeight: FontWeights.semibold,
    fontSize: FontSizes.sm,
  },
});
