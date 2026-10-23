import { Tabs, useRouter } from 'expo-router';
import React from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { useQuery } from '@tanstack/react-query';

import { fetchUnreadCount } from '@/api/notifications';
import { useAuth } from '@/hooks/use-auth';
import { Colors, Spacing, FontSizes, FontWeights, Shadows } from '@/lib/theme';

/** Bell icon with unread badge – navigates to /notifications */
function NotificationBell() {
  const router = useRouter();
  // REV-A1: chỉ đếm khi đã đăng nhập
  const { user } = useAuth();
  const { data: unreadCount } = useQuery({
    queryKey: ['unread-count'],
    queryFn: fetchUnreadCount,
    enabled: !!user,
    refetchInterval: 30_000, // poll every 30s
  });

  return (
    <Pressable
      onPress={() => router.push('/notifications' as any)}
      style={styles.bellButton}
      hitSlop={8}
    >
      <Text style={styles.bellIcon}>🔔</Text>
      {(unreadCount ?? 0) > 0 && (
        <View style={styles.badge}>
          <Text style={styles.badgeText}>
            {(unreadCount ?? 0) > 99 ? '99+' : unreadCount}
          </Text>
        </View>
      )}
    </Pressable>
  );
}

export default function TabsLayout() {
  return (
    <Tabs
      screenOptions={{
        tabBarActiveTintColor: Colors.primary,
        tabBarInactiveTintColor: Colors.textTertiary,
        tabBarStyle: Platform.select({
          ios: {
            position: 'absolute',
            backgroundColor: Colors.surface,
            borderTopColor: Colors.borderLight,
          },
          default: {
            backgroundColor: Colors.surface,
            borderTopColor: Colors.borderLight,
          },
        }),
        headerStyle: { backgroundColor: Colors.surface },
        headerTitleStyle: { fontWeight: FontWeights.semibold, color: Colors.text },
        headerShadowVisible: false,
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: 'Tổng quan',
          tabBarLabel: 'Home',
          tabBarIcon: ({ focused }) => (
            <Text style={[styles.tabIcon, !focused && styles.tabIconInactive]}>🏠</Text>
          ),
          headerRight: () => <NotificationBell />,
        }}
      />
      <Tabs.Screen
        name="groups"
        options={{
          title: 'Nhóm',
          tabBarLabel: 'Nhóm',
          tabBarIcon: ({ focused }) => (
            <Text style={[styles.tabIcon, !focused && styles.tabIconInactive]}>👥</Text>
          ),
        }}
      />
      <Tabs.Screen
        name="contacts"
        options={{
          title: 'Bạn bè',
          tabBarLabel: 'Bạn bè',
          tabBarIcon: ({ focused }) => (
            <Text style={[styles.tabIcon, !focused && styles.tabIconInactive]}>👫</Text>
          ),
        }}
      />
      <Tabs.Screen
        name="account"
        options={{
          title: 'Tài khoản',
          tabBarLabel: 'Tài khoản',
          tabBarIcon: ({ focused }) => (
            <Text style={[styles.tabIcon, !focused && styles.tabIconInactive]}>👤</Text>
          ),
        }}
      />
    </Tabs>
  );
}

const styles = StyleSheet.create({
  bellButton: {
    marginRight: Spacing.lg,
    position: 'relative',
    width: 44,
    height: 44,
    justifyContent: 'center',
    alignItems: 'center',
  },
  bellIcon: {
    fontSize: 22,
  },
  badge: {
    position: 'absolute',
    top: 4,
    right: 2,
    backgroundColor: Colors.danger,
    borderRadius: 9,
    minWidth: 18,
    height: 18,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: Spacing.xs,
    borderWidth: 2,
    borderColor: Colors.surface,
  },
  badgeText: {
    color: Colors.textInverse,
    fontSize: FontSizes.xs,
    fontWeight: FontWeights.bold,
  },
  tabIcon: {
    fontSize: 22,
  },
  tabIconInactive: {
    opacity: 0.55,
  },
});
