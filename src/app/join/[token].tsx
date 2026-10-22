import { useQueryClient } from '@tanstack/react-query';
import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { toUserMessage } from '@/api/errors';
import { acceptInvite } from '@/api/groups';
import { useAuth } from '@/hooks/use-auth';

export default function JoinByTokenScreen() {
  const { token } = useLocalSearchParams<{ token: string }>();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { session, loading: authLoading } = useAuth();
  const [error, setError] = useState<string | null>(null);
  // Mỗi token chỉ gọi acceptInvite một lần (effect có thể chạy lại khi phiên làm mới)
  const attemptedRef = useRef<string | null>(null);

  // APP-15: lỗi token rỗng tính dẫn xuất, không setState trong effect
  const displayError = !token ? 'Token không hợp lệ' : error;

  useEffect(() => {
    // APP-11: chỉ gọi acceptInvite khi đã có phiên; chưa đăng nhập thì AuthGate chuyển sang
    // đăng nhập và giữ lại đường dẫn này để quay về sau
    if (!token || authLoading || !session) return;
    if (attemptedRef.current === token) return;
    attemptedRef.current = token;

    acceptInvite(token)
      .then((result: any) => {
        const groupId = typeof result === 'string' ? result : result?.group_id;
        queryClient.invalidateQueries({ queryKey: ['groups'] });
        if (groupId) {
          router.replace(`/group/${groupId}` as any);
        } else {
          router.replace('/(tabs)/groups' as any);
        }
      })
      .catch((err) => {
        setError(toUserMessage(err, 'Không thể tham gia nhóm. Liên kết có thể đã hết hạn.'));
      });
  }, [token, session, authLoading, router, queryClient]);

  const loading = !displayError;

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.center}>
        {loading ? (
          <>
            <ActivityIndicator size="large" color="#007AFF" />
            <Text style={styles.loadingText}>
              {session ? 'Đang tham gia nhóm...' : 'Vui lòng đăng nhập để tham gia nhóm...'}
            </Text>
          </>
        ) : (
          <>
            <Text style={styles.errorIcon}>❌</Text>
            <Text style={styles.errorTitle}>Không thể tham gia</Text>
            <Text style={styles.errorText}>{displayError}</Text>
            <Pressable
              style={styles.backBtn}
              onPress={() => router.replace('/(tabs)/groups' as any)}
            >
              <Text style={styles.backBtnText}>Quay lại</Text>
            </Pressable>
          </>
        )}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f2f2f7' },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 24, gap: 12 },
  loadingText: { fontSize: 16, color: '#666', marginTop: 12 },
  errorIcon: { fontSize: 48, marginBottom: 8 },
  errorTitle: { fontSize: 20, fontWeight: '700', color: '#1a1a1a' },
  errorText: { fontSize: 15, color: '#666', textAlign: 'center', lineHeight: 22 },
  backBtn: {
    backgroundColor: '#007AFF',
    borderRadius: 12,
    paddingHorizontal: 32,
    paddingVertical: 14,
    marginTop: 16,
  },
  backBtnText: { color: '#fff', fontSize: 16, fontWeight: '600' },
});
