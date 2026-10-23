/**
 * Migration 0014: yêu cầu tham gia đang chờ chủ nhóm duyệt.
 * - JoinPendingView: màn mở từ link / QR (join/[token], join-code/[code]) — báo đã gửi, cho hủy yêu cầu
 * - showJoinPendingAlert: hộp thoại cho chỗ không có màn riêng (nhập mã ở tab Nhóm, lời mời trong Thông báo)
 */
import { useMutation, useQueryClient, type QueryClient } from '@tanstack/react-query';
import React from 'react';
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text } from 'react-native';

import { cancelJoinRequest, type JoinResult } from '@/api/groups';
import { joinPendingMessage, joinRequestErrorMessage } from '@/lib/membership';
import { myJoinRequestKey } from '@/lib/realtime-keys';

function afterCancel(queryClient: QueryClient, groupId: string) {
  queryClient.invalidateQueries({ queryKey: ['groups'] });
  if (groupId) queryClient.invalidateQueries({ queryKey: myJoinRequestKey(groupId) });
}

/** Hộp thoại "Đã gửi yêu cầu…" kèm nút "Hủy yêu cầu" (khi có request_id). */
export function showJoinPendingAlert(result: JoinResult, queryClient: QueryClient) {
  const requestId = result.requestId;
  Alert.alert('Đã gửi yêu cầu', joinPendingMessage(result.groupName), [
    ...(requestId
      ? [
          {
            text: 'Hủy yêu cầu',
            style: 'destructive' as const,
            onPress: () => {
              cancelJoinRequest(requestId)
                .then(() => {
                  afterCancel(queryClient, result.groupId);
                  Alert.alert('Đã hủy', 'Đã hủy yêu cầu tham gia nhóm.');
                })
                .catch((err) => Alert.alert('Lỗi', joinRequestErrorMessage(err, 'Không thể hủy yêu cầu')));
            },
          },
        ]
      : []),
    { text: 'OK' },
  ]);
}

type Props = {
  result: JoinResult;
  /** Quay về danh sách nhóm */
  onDone: () => void;
};

/** Trạng thái chờ duyệt trên màn mở từ link / QR (giữ kiểu của các màn join). */
export function JoinPendingView({ result, onDone }: Props) {
  const queryClient = useQueryClient();
  const cancelMutation = useMutation({
    mutationFn: () => cancelJoinRequest(result.requestId!),
    onSuccess: () => afterCancel(queryClient, result.groupId),
    onError: (err) => Alert.alert('Lỗi', joinRequestErrorMessage(err, 'Không thể hủy yêu cầu')),
  });

  const confirmCancel = () =>
    Alert.alert('Hủy yêu cầu', 'Bạn có chắc muốn hủy yêu cầu tham gia nhóm?', [
      { text: 'Không', style: 'cancel' },
      { text: 'Hủy yêu cầu', style: 'destructive', onPress: () => cancelMutation.mutate() },
    ]);

  if (cancelMutation.isSuccess) {
    return (
      <>
        <Text style={styles.icon}>↩️</Text>
        <Text style={styles.title}>Đã hủy yêu cầu</Text>
        <Text style={styles.text}>Bạn đã hủy yêu cầu tham gia nhóm {result.groupName || 'này'}.</Text>
        <Pressable style={styles.primaryBtn} onPress={onDone}>
          <Text style={styles.primaryBtnText}>Quay lại</Text>
        </Pressable>
      </>
    );
  }

  return (
    <>
      <Text style={styles.icon}>⏳</Text>
      <Text style={styles.title}>Đang chờ duyệt</Text>
      <Text style={styles.text}>{joinPendingMessage(result.groupName)}</Text>
      <Pressable style={styles.primaryBtn} onPress={onDone}>
        <Text style={styles.primaryBtnText}>Về danh sách nhóm</Text>
      </Pressable>
      {!!result.requestId && (
        <Pressable
          style={[styles.secondaryBtn, cancelMutation.isPending && styles.disabled]}
          onPress={confirmCancel}
          disabled={cancelMutation.isPending}
        >
          {cancelMutation.isPending ? (
            <ActivityIndicator color="#FF3B30" />
          ) : (
            <Text style={styles.secondaryBtnText}>Hủy yêu cầu</Text>
          )}
        </Pressable>
      )}
    </>
  );
}

const styles = StyleSheet.create({
  icon: { fontSize: 48, marginBottom: 8 },
  title: { fontSize: 20, fontWeight: '700', color: '#1a1a1a' },
  text: { fontSize: 15, color: '#666', textAlign: 'center', lineHeight: 22 },
  primaryBtn: {
    backgroundColor: '#007AFF',
    borderRadius: 12,
    paddingHorizontal: 32,
    paddingVertical: 14,
    marginTop: 16,
    minWidth: 220,
    alignItems: 'center',
  },
  primaryBtnText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  secondaryBtn: {
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#FF3B30',
    paddingHorizontal: 32,
    paddingVertical: 13,
    minWidth: 220,
    alignItems: 'center',
  },
  secondaryBtnText: { color: '#FF3B30', fontSize: 16, fontWeight: '600' },
  disabled: { opacity: 0.5 },
});
