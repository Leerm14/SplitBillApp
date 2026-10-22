import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { acceptInvite } from '@/api/groups';

export default function JoinByTokenScreen() {
  const { token } = useLocalSearchParams<{ token: string }>();
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!token) {
      setError('Token không hợp lệ');
      setLoading(false);
      return;
    }

    (async () => {
      try {
        const result = await acceptInvite(token);
        const groupId = typeof result === 'string' ? result : result?.group_id;
        if (groupId) {
          router.replace(`/group/${groupId}` as any);
        } else {
          router.replace('/(tabs)/groups' as any);
        }
      } catch (err: any) {
        setError(err.message || 'Không thể tham gia nhóm. Liên kết có thể đã hết hạn.');
        setLoading(false);
      }
    })();
  }, [token]);

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.center}>
        {loading ? (
          <>
            <ActivityIndicator size="large" color="#007AFF" />
            <Text style={styles.loadingText}>Đang tham gia nhóm...</Text>
          </>
        ) : (
          <>
            <Text style={styles.errorIcon}>❌</Text>
            <Text style={styles.errorTitle}>Không thể tham gia</Text>
            <Text style={styles.errorText}>{error}</Text>
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
