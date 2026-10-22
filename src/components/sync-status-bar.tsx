/**
 * Thanh trạng thái đồng bộ — hiển thị khi có thao tác chưa đồng bộ.
 */

import React from 'react';
import { View, Text, StyleSheet, Pressable } from 'react-native';

interface Props {
  pendingCount: number;
  lastSyncAt: Date | null;
  isSyncing: boolean;
  onSyncPress: () => void;
}

export function SyncStatusBar({ pendingCount, lastSyncAt, isSyncing, onSyncPress }: Props) {
  if (pendingCount === 0 && !isSyncing) return null;

  return (
    <Pressable style={styles.container} onPress={onSyncPress}>
      {isSyncing ? (
        <Text style={styles.text}>🔄 Đang đồng bộ...</Text>
      ) : pendingCount > 0 ? (
        <Text style={styles.textWarning}>
          ⚠️ {pendingCount} thao tác chưa đồng bộ. Nhấn để thử lại.
        </Text>
      ) : null}
      {lastSyncAt && (
        <Text style={styles.timestamp}>
          Đồng bộ lúc{' '}
          {lastSyncAt.toLocaleTimeString('vi-VN', {
            hour: '2-digit',
            minute: '2-digit',
          })}
        </Text>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: '#FFF8E1',
    paddingVertical: 8,
    paddingHorizontal: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#FFE082',
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  text: { fontSize: 13, color: '#F57F17' },
  textWarning: { fontSize: 13, color: '#E65100', flex: 1 },
  timestamp: { fontSize: 11, color: '#F9A825' },
});

