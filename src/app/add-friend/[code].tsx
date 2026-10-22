import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import React, { useState } from 'react';
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { fetchFriends, fetchUserByCode, sendFriendRequest } from '@/api/contacts';
import { getServerErrorCode, toUserMessage } from '@/api/errors';
import { Avatar } from '@/components/avatar';
import { ErrorState } from '@/components/error-state';
import { useAuth } from '@/hooks/use-auth';
import { SHORT_CODE_RE } from '@/lib/app-links';

/**
 * MVP-05: Mở từ QR kết bạn (`…/add-friend/<user_code>`). Tìm đúng người theo mã (find_user_by_code,
 * không lọc `searchable`), hiện hồ sơ công khai và nút "Gửi lời mời kết bạn".
 * Chưa đăng nhập → AuthGate giữ đường dẫn và quay lại sau khi đăng nhập.
 */
export default function AddFriendByCodeScreen() {
  const { code: rawCode } = useLocalSearchParams<{ code: string }>();
  const code = typeof rawCode === 'string' ? rawCode.toUpperCase() : '';
  const validCode = SHORT_CODE_RE.test(code);
  const router = useRouter();
  const queryClient = useQueryClient();
  const { session, user } = useAuth();
  const [sent, setSent] = useState(false);

  const userQ = useQuery({
    queryKey: ['user-by-code', code],
    queryFn: () => fetchUserByCode(code),
    enabled: validCode && !!session,
  });

  const friendsQ = useQuery({
    queryKey: ['friends'],
    queryFn: fetchFriends,
    enabled: !!session,
  });

  const target = userQ.data ?? null;
  const isSelf = !!target && target.id === user?.id;
  const isFriend =
    !!target &&
    (friendsQ.data ?? []).some((f) => f.requester_id === target.id || f.addressee_id === target.id);

  const sendMutation = useMutation({
    mutationFn: () => sendFriendRequest(target!.id),
    onSuccess: () => {
      setSent(true);
      queryClient.invalidateQueries({ queryKey: ['pendingRequests'] });
      queryClient.invalidateQueries({ queryKey: ['friends'] });
      Alert.alert('Đã gửi', `Đã gửi lời mời kết bạn tới ${target?.display_name ?? 'người này'}.`);
    },
    onError: (err) => {
      if (getServerErrorCode(err) === 'ALREADY_PENDING') setSent(true);
      Alert.alert('Lỗi', toUserMessage(err, 'Không thể gửi lời mời'));
    },
  });

  const header = <Stack.Screen options={{ headerShown: true, title: 'Thêm bạn bè', headerBackTitle: 'Quay lại' }} />;

  if (!validCode) {
    return (
      <>
        {header}
        <ErrorState title="Mã QR không hợp lệ" message="Mã người dùng không đúng định dạng." />
      </>
    );
  }

  if (!session || userQ.isLoading) {
    return (
      <View style={styles.center}>
        {header}
        <ActivityIndicator size="large" color="#007AFF" />
        <Text style={styles.loadingText}>{session ? 'Đang tìm người dùng...' : 'Vui lòng đăng nhập...'}</Text>
      </View>
    );
  }

  if (userQ.error) {
    return (
      <>
        {header}
        <ErrorState message={toUserMessage(userQ.error, 'Không tìm được người dùng')} onRetry={() => userQ.refetch()} />
      </>
    );
  }

  if (!target) {
    return (
      <>
        {header}
        <ErrorState title="Không tìm thấy" message={`Không có người dùng nào có mã ${code}.`} />
      </>
    );
  }

  return (
    <SafeAreaView style={styles.container} edges={['bottom']}>
      {header}
      <View style={styles.card}>
        <Avatar name={target.display_name} path={target.avatar_path} seed={target.id} size={88} />
        <Text style={styles.name}>{target.display_name}</Text>
        <Text style={styles.code}>Mã: {target.user_code}</Text>
      </View>

      {isSelf ? (
        <View style={styles.badge}>
          <Text style={styles.badgeText}>Đây là mã QR của bạn</Text>
        </View>
      ) : isFriend ? (
        <Pressable style={styles.secondaryBtn} onPress={() => router.replace(`/user/${target.id}` as any)}>
          <Text style={styles.secondaryBtnText}>Đã là bạn bè — Xem hồ sơ</Text>
        </Pressable>
      ) : sent ? (
        <View style={styles.badge}>
          <Text style={styles.badgeText}>Đã gửi lời mời — chờ phản hồi</Text>
        </View>
      ) : (
        <Pressable
          style={[styles.primaryBtn, sendMutation.isPending && styles.disabled]}
          onPress={() => sendMutation.mutate()}
          disabled={sendMutation.isPending}
        >
          {sendMutation.isPending ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={styles.primaryBtnText}>Gửi lời mời kết bạn</Text>
          )}
        </Pressable>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f2f2f7', padding: 16, gap: 16 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', gap: 12, backgroundColor: '#f2f2f7' },
  loadingText: { fontSize: 15, color: '#666' },
  card: {
    backgroundColor: '#fff',
    borderRadius: 16,
    padding: 24,
    alignItems: 'center',
    gap: 8,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 4,
    elevation: 2,
  },
  name: { fontSize: 22, fontWeight: '700', color: '#1a1a1a', marginTop: 4 },
  code: { fontSize: 15, color: '#8E8E93' },
  primaryBtn: { backgroundColor: '#007AFF', borderRadius: 12, padding: 16, alignItems: 'center' },
  primaryBtnText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  disabled: { opacity: 0.6 },
  secondaryBtn: {
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 16,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#007AFF',
  },
  secondaryBtnText: { color: '#007AFF', fontSize: 16, fontWeight: '600' },
  badge: { backgroundColor: '#fff', borderRadius: 12, padding: 16, alignItems: 'center', borderWidth: 1, borderColor: '#E5E5EA' },
  badgeText: { color: '#8E8E93', fontSize: 16, fontWeight: '500' },
});
