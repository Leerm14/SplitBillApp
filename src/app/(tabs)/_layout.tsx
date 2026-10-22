import { Tabs, useRouter } from 'expo-router';
import React from 'react';
import { Platform, Pressable, Text, View } from 'react-native';
import { useQuery } from '@tanstack/react-query';

import { fetchUnreadCount } from '@/api/notifications';
import { useAuth } from '@/hooks/use-auth';

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
      style={{ marginRight: 16, position: 'relative' }}
      hitSlop={8}
    >
      <Text style={{ fontSize: 22 }}>🔔</Text>
      {(unreadCount ?? 0) > 0 && (
        <View
          style={{
            position: 'absolute',
            top: -4,
            right: -6,
            backgroundColor: '#FF3B30',
            borderRadius: 9,
            minWidth: 18,
            height: 18,
            justifyContent: 'center',
            alignItems: 'center',
            paddingHorizontal: 4,
          }}
        >
          <Text style={{ color: '#fff', fontSize: 11, fontWeight: '700' }}>
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
        tabBarActiveTintColor: '#007AFF',
        tabBarInactiveTintColor: '#8E8E93',
        tabBarStyle: Platform.select({
          ios: { position: 'absolute' },
          default: {},
        }),
        headerStyle: { backgroundColor: '#fff' },
        headerTitleStyle: { fontWeight: '600' },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: 'Tổng quan',
          tabBarLabel: 'Home',
          tabBarIcon: ({ focused }) => (
            <Text style={{ fontSize: 22, opacity: focused ? 1 : 0.6 }}>🏠</Text>
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
            <Text style={{ fontSize: 22, opacity: focused ? 1 : 0.6 }}>👥</Text>
          ),
        }}
      />
      <Tabs.Screen
        name="contacts"
        options={{
          title: 'Bạn bè',
          tabBarLabel: 'Bạn bè',
          tabBarIcon: ({ focused }) => (
            <Text style={{ fontSize: 22, opacity: focused ? 1 : 0.6 }}>👫</Text>
          ),
        }}
      />
      <Tabs.Screen
        name="account"
        options={{
          title: 'Tài khoản',
          tabBarLabel: 'Tài khoản',
          tabBarIcon: ({ focused }) => (
            <Text style={{ fontSize: 22, opacity: focused ? 1 : 0.6 }}>👤</Text>
          ),
        }}
      />
    </Tabs>
  );
}
