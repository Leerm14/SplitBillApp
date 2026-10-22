import { QueryClient } from '@tanstack/react-query';
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client';
import { Slot, useRouter, useSegments } from 'expo-router';
import * as Linking from 'expo-linking';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import React, { useEffect, useState } from 'react';
import { ActivityIndicator, View } from 'react-native';

import { AuthProvider, useAuth } from '@/hooks/use-auth';
import { useNotifications } from '@/hooks/use-notifications';
import { useOfflineSync } from '@/hooks/use-offline-sync';
import { SyncStatusBar } from '@/components/sync-status-bar';
import { persistOptions, queryClientConfig } from '@/lib/query-persister';

SplashScreen.preventAutoHideAsync();

// APP-12: Use centralized queryClientConfig with proper gcTime
const queryClient = new QueryClient(queryClientConfig);

/** Chuyển hướng dựa trên trạng thái đăng nhập */
function AuthGate({ children }: { children: React.ReactNode }) {
  const { session, loading } = useAuth();
  const segments = useSegments();
  const router = useRouter();

  // APP-11: Save deep link path when not logged in
  const [pendingDeepLink, setPendingDeepLink] = useState<string | null>(null);

  useEffect(() => {
    if (loading) return;

    // Luôn ẩn splash khi loading xong
    SplashScreen.hideAsync();

    const inAuthGroup = segments[0] === '(auth)';

    if (!session && !inAuthGroup) {
      // Chưa đăng nhập → chuyển sang sign-in
      router.replace('/(auth)/sign-in' as any);
    } else if (session && inAuthGroup) {
      // Đã đăng nhập → chuyển sang tabs
      router.replace('/(tabs)' as any);
    }
  }, [session, loading, segments]);

  // APP-11: Handle deep links — save path when not logged in
  useEffect(() => {
    const handleUrl = ({ url }: { url: string }) => {
      const parsed = Linking.parse(url);
      if (parsed.path?.startsWith('join/')) {
        const token = parsed.queryParams?.token ?? parsed.path.split('/')[1] ?? '';
        if (session) {
          router.push(`/join/${token}` as any);
        } else {
          // APP-11: Save path for after login
          setPendingDeepLink(`/join/${token}`);
        }
      }
    };

    const subscription = Linking.addEventListener('url', handleUrl);
    return () => subscription.remove();
  }, [session]);

  // APP-11: Navigate to saved deep link after login
  useEffect(() => {
    if (session && pendingDeepLink) {
      router.push(pendingDeepLink as any);
      setPendingDeepLink(null);
    }
  }, [session, pendingDeepLink]);

  // Đăng ký push notification khi đã đăng nhập
  try {
    useNotifications();
  } catch (e) {
    console.warn('useNotifications error:', e);
  }

  // Đồng bộ hàng đợi offline
  const { pendingCount, lastSyncAt, isSyncing, sync } = useOfflineSync();

  if (loading) {
    // Hiển thị loading indicator thay vì blank screen
    // SplashScreen vẫn đang hiện phía trên, nhưng phòng trường hợp nó hide sớm
    return (
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#208AEF' }}>
        <ActivityIndicator size="large" color="#fff" />
      </View>
    );
  }

  return (
    <>
      <SyncStatusBar
        pendingCount={pendingCount}
        lastSyncAt={lastSyncAt}
        isSyncing={isSyncing}
        onSyncPress={sync}
      />
      {children}
    </>
  );
}

export default function RootLayout() {
  return (
    <PersistQueryClientProvider
      client={queryClient}
      persistOptions={persistOptions}
    >
      <AuthProvider>
        <AuthGate>
          <StatusBar style="dark" />
          <Slot />
        </AuthGate>
      </AuthProvider>
    </PersistQueryClientProvider>
  );
}
