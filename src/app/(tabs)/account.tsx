import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import React from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { toUserMessage } from '@/api/errors';
import { fetchProfile } from '@/api/profiles';
import { Avatar } from '@/components/avatar';
import { useAuth } from '@/hooks/use-auth';
import { Colors, Spacing, Radii, FontSizes, FontWeights, Shadows } from '@/lib/theme';

const MENU_ITEMS = [
  { label: 'Hồ sơ', icon: '👤', route: '/account/profile' },
  { label: 'Bảo mật', icon: '🔒', route: '/account/security' },
  { label: 'Quyền riêng tư', icon: '🛡️', route: '/account/privacy' },
  { label: 'Phương thức thanh toán', icon: '💳', route: '/account/payment-methods' },
] as const;

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
          {/* Teal gradient-like banner behind avatar */}
          <View style={styles.profileBanner}>
            <View style={styles.bannerLayer1} />
            <View style={styles.bannerLayer2} />
          </View>

          <View style={styles.avatarWrapper}>
            <Avatar
              name={profile?.display_name || user?.user_metadata?.display_name || user?.email}
              path={profile?.avatar_path}
              seed={profile?.id ?? user?.id}
              size={72}
              style={styles.avatar}
            />
          </View>

          <Text style={styles.name}>
            {profile?.display_name || user?.user_metadata?.display_name || 'Người dùng'}
          </Text>
          <Text style={styles.email}>{user?.email}</Text>
          {profile?.user_code && (
            <View style={styles.userCodeBadge}>
              <Text style={styles.userCodeText}>Mã: {profile.user_code}</Text>
            </View>
          )}
        </View>

        {/* Menu items */}
        <View style={styles.menuGroup}>
          {MENU_ITEMS.map((item, index) => (
            <React.Fragment key={item.route}>
              {index > 0 && <View style={styles.menuDivider} />}
              <Pressable
                style={({ pressed }) => [
                  styles.menuItem,
                  pressed && styles.menuItemPressed,
                ]}
                onPress={() => router.push(item.route as any)}
              >
                <View style={styles.menuItemLeft}>
                  <Text style={styles.menuIcon}>{item.icon}</Text>
                  <Text style={styles.menuItemText}>{item.label}</Text>
                </View>
                <Text style={styles.chevron}>›</Text>
              </Pressable>
            </React.Fragment>
          ))}
        </View>

        {/* Sign out */}
        <Pressable
          style={({ pressed }) => [
            styles.signOutBtn,
            pressed && styles.signOutBtnPressed,
          ]}
          onPress={handleSignOut}
        >
          <Text style={styles.signOutText}>Đăng xuất</Text>
        </Pressable>

        {isLoading && (
          <ActivityIndicator style={styles.loader} size="small" color={Colors.primary} />
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Colors.background,
  },
  scrollView: {
    flex: 1,
  },
  content: {
    padding: Spacing.lg,
    gap: Spacing.xl,
    paddingBottom: Spacing.xxxl,
  },

  // ── Profile Card ──────────────────────────────────────────
  profileCard: {
    backgroundColor: Colors.surface,
    borderRadius: Radii.lg,
    overflow: 'hidden',
    alignItems: 'center',
    paddingBottom: Spacing.xxl,
    ...Shadows.md,
  },
  profileBanner: {
    width: '100%',
    height: 80,
    position: 'relative',
    overflow: 'hidden',
  },
  bannerLayer1: {
    ...StyleSheet.absoluteFill,
    backgroundColor: Colors.primary,
    opacity: 0.9,
  },
  bannerLayer2: {
    ...StyleSheet.absoluteFill,
    backgroundColor: Colors.primaryDark,
    opacity: 0.4,
    borderBottomLeftRadius: 100,
    borderBottomRightRadius: 100,
    transform: [{ scaleX: 1.5 }],
  },
  avatarWrapper: {
    marginTop: -36,
    borderRadius: 40,
    borderWidth: 3,
    borderColor: Colors.surface,
    ...Shadows.md,
  },
  avatar: {
    // no extra margin needed — wrapper handles positioning
  },
  name: {
    fontSize: FontSizes.xl,
    fontWeight: FontWeights.semibold,
    color: Colors.text,
    marginTop: Spacing.md,
  },
  email: {
    fontSize: FontSizes.sm,
    color: Colors.textSecondary,
    marginTop: Spacing.xs,
  },
  userCodeBadge: {
    marginTop: Spacing.sm,
    backgroundColor: Colors.primaryLight,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.xs,
    borderRadius: Radii.full,
  },
  userCodeText: {
    fontSize: FontSizes.xs,
    color: Colors.primaryDark,
    fontWeight: FontWeights.medium,
  },

  // ── Menu Group ────────────────────────────────────────────
  menuGroup: {
    backgroundColor: Colors.surface,
    borderRadius: Radii.lg,
    overflow: 'hidden',
    ...Shadows.sm,
  },
  menuItem: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: Spacing.lg,
    paddingHorizontal: Spacing.xl,
    minHeight: 52,
  },
  menuItemPressed: {
    backgroundColor: Colors.borderLight,
  },
  menuItemLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
  },
  menuIcon: {
    fontSize: FontSizes.lg,
    width: 28,
    textAlign: 'center',
  },
  menuItemText: {
    fontSize: FontSizes.md,
    color: Colors.text,
    fontWeight: FontWeights.medium,
  },
  chevron: {
    fontSize: 22,
    color: Colors.textTertiary,
    fontWeight: FontWeights.semibold,
  },
  menuDivider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: Colors.border,
    marginLeft: 60,
  },

  // ── Sign Out ──────────────────────────────────────────────
  signOutBtn: {
    backgroundColor: Colors.surface,
    borderRadius: Radii.md,
    paddingVertical: Spacing.lg,
    alignItems: 'center',
    borderWidth: 1.5,
    borderColor: Colors.danger,
    ...Shadows.sm,
  },
  signOutBtnPressed: {
    backgroundColor: Colors.dangerLight,
  },
  signOutText: {
    color: Colors.danger,
    fontSize: FontSizes.md,
    fontWeight: FontWeights.semibold,
  },
  loader: {
    marginTop: Spacing.sm,
  },
});
