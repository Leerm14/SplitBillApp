import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import React from 'react';
import {
  ActivityIndicator,
  Alert,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { toUserMessage } from '@/api/errors';
import { fetchProfile, getAvatarUrl } from '@/api/profiles';
import { useAuth } from '@/hooks/use-auth';

export default function AccountScreen() {
  const { user, signOut } = useAuth();
  const router = useRouter();

  const { data: profile, isLoading } = useQuery({
    queryKey: ['profile'],
    queryFn: fetchProfile,
  });

  const handleSignOut = () => {
    Alert.alert('Đăng xuất', 'Bạn có chắc muốn đăng xuất?', [
      { text: 'Hủy', style: 'cancel' },
      {
        text: 'Đăng xuất',
        style: 'destructive',
        onPress: async () => {
          try {
            await signOut();
          } catch (err) {
            // APP-02: đăng xuất lỗi (mất mạng) thì phiên vẫn còn — báo người dùng thử lại
            Alert.alert('Lỗi', toUserMessage(err, 'Không thể đăng xuất. Vui lòng thử lại.'));
          }
        },
      },
    ]);
  };

  return (
    <SafeAreaView style={styles.container} edges={['bottom']}>
      <ScrollView style={styles.scrollView} contentContainerStyle={styles.content}>
        {/* Profile card */}
        <View style={styles.profileCard}>
          {profile?.avatar_path ? (
            <Image
              source={{ uri: getAvatarUrl(profile.avatar_path) }}
              style={styles.avatarImage}
            />
          ) : (
            <View style={styles.avatar}>
              <Text style={styles.avatarText}>
                {(profile?.display_name || user?.user_metadata?.display_name || user?.email || '?')[0].toUpperCase()}
              </Text>
            </View>
          )}
          <Text style={styles.name}>
            {profile?.display_name || user?.user_metadata?.display_name || 'Người dùng'}
          </Text>
          <Text style={styles.email}>{user?.email}</Text>
          {profile?.user_code && (
            <Text style={styles.userCode}>Mã: {profile.user_code}</Text>
          )}
        </View>

        {/* Menu items */}
        <View style={styles.menuGroup}>
          <Pressable
            style={styles.menuItem}
            onPress={() => router.push('/account/profile' as any)}
          >
            <Text style={styles.menuItemText}>Hồ sơ</Text>
            <Text style={styles.chevron}>›</Text>
          </Pressable>
          <View style={styles.menuDivider} />
          <Pressable
            style={styles.menuItem}
            onPress={() => router.push('/account/security' as any)}
          >
            <Text style={styles.menuItemText}>Bảo mật</Text>
            <Text style={styles.chevron}>›</Text>
          </Pressable>
          <View style={styles.menuDivider} />
          <Pressable
            style={styles.menuItem}
            onPress={() => router.push('/account/privacy' as any)}
          >
            <Text style={styles.menuItemText}>Quyền riêng tư</Text>
            <Text style={styles.chevron}>›</Text>
          </Pressable>
        </View>

        {/* Sign out */}
        <Pressable style={styles.signOutBtn} onPress={handleSignOut}>
          <Text style={styles.signOutText}>Đăng xuất</Text>
        </Pressable>

        {isLoading && (
          <ActivityIndicator style={styles.loader} size="small" color="#007AFF" />
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f2f2f7' },
  scrollView: { flex: 1 },
  content: { padding: 16, gap: 24 },
  profileCard: {
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
  avatar: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: '#007AFF',
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 8,
  },
  avatarImage: {
    width: 64,
    height: 64,
    borderRadius: 32,
    marginBottom: 8,
  },
  avatarText: { fontSize: 28, fontWeight: '700', color: '#fff' },
  name: { fontSize: 20, fontWeight: '600', color: '#1a1a1a' },
  email: { fontSize: 14, color: '#8E8E93' },
  userCode: { fontSize: 13, color: '#8E8E93', marginTop: 2 },
  menuGroup: {
    backgroundColor: '#fff',
    borderRadius: 16,
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 4,
    elevation: 2,
  },
  menuItem: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: 16,
    paddingHorizontal: 20,
  },
  menuItemText: {
    fontSize: 16,
    color: '#1a1a1a',
  },
  chevron: {
    fontSize: 22,
    color: '#C7C7CC',
    fontWeight: '600',
  },
  menuDivider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: '#E5E5EA',
    marginLeft: 20,
  },
  signOutBtn: {
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 16,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#FF3B30',
  },
  signOutText: { color: '#FF3B30', fontSize: 16, fontWeight: '600' },
  loader: {
    marginTop: 8,
  },
});
