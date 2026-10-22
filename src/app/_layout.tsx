import { QueryClient } from '@tanstack/react-query';
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client';
import { Stack, usePathname, useRouter, useSegments } from 'expo-router';
import * as Linking from 'expo-linking';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';

import { AuthProvider, useAuth } from '@/hooks/use-auth';
import { useNotifications } from '@/hooks/use-notifications';
import { useOfflineSync } from '@/hooks/use-offline-sync';
import { SyncStatusBar, isSyncStatusBarVisible } from '@/components/sync-status-bar';
import { resumableRoute } from '@/lib/app-links';
import { onPendingLinkChange, peekPendingLink, setPendingLink, takePendingLink } from '@/lib/pending-link';
import { persistOptions, queryClientConfig } from '@/lib/query-persister';
import { describeQueueItem } from '@/offline/sync';

SplashScreen.preventAutoHideAsync();

// APP-12: Use centralized queryClientConfig with proper gcTime
const queryClient = new QueryClient(queryClientConfig);

/**
 * APP-11 / MVP-04 / MVP-05: Đường dẫn trong app cần giữ lại qua bước đăng nhập
 * (liên kết mời join/<token>, mã nhóm join-code/<code>, kết bạn add-friend/<code>).
 */
function resumePathFromUrl(url: string | null): string | null {
  if (!url) return null;
  const parsed = Linking.parse(url);
  const path = (parsed.path ?? '').replace(/^\/+/, '');
  const route = resumableRoute(path);
  if (route) return route;
  // Dạng cũ: …/join?token=<token>
  const token = typeof parsed.queryParams?.token === 'string' ? parsed.queryParams.token : '';
  return path === 'join' && token ? resumableRoute(`join/${token}`) : null;
}

/** Chuyển hướng dựa trên trạng thái đăng nhập */
function AuthGate({ children }: { children: React.ReactNode }) {
  const { session, loading } = useAuth();
  const segments = useSegments();
  const pathname = usePathname();
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const sessionRef = useRef(session);
  useEffect(() => {
    sessionRef.current = session;
  }, [session]);

  // REV-A8: đích mới được lưu (ví dụ thông báo cold start) → chạy lại hiệu ứng điều hướng
  const [pendingVersion, setPendingVersion] = useState(0);
  useEffect(() => onPendingLinkChange(() => setPendingVersion((v) => v + 1)), []);

  // APP-11: Mở app từ liên kết khi app đang tắt (cold start)
  useEffect(() => {
    Linking.getInitialURL()
      .then((url) => {
        const path = resumePathFromUrl(url);
        if (path && !sessionRef.current) setPendingLink(path);
      })
      .catch(() => {});

    // Liên kết tới khi app đang chạy: expo-router tự điều hướng; chỉ cần nhớ nếu chưa đăng nhập
    const subscription = Linking.addEventListener('url', ({ url }) => {
      const path = resumePathFromUrl(url);
      if (path && !sessionRef.current) setPendingLink(path);
    });
    return () => subscription.remove();
  }, []);

  useEffect(() => {
    if (loading) return;

    // Luôn ẩn splash khi loading xong
    SplashScreen.hideAsync();

    const inAuthGroup = segments[0] === '(auth)';

    if (!session && !inAuthGroup) {
      // APP-11: Đang ở màn mở từ liên kết (join / join-code / add-friend) mà chưa đăng nhập → nhớ đường dẫn
      const resume = resumableRoute(pathname);
      if (resume) setPendingLink(resume);
      // REV-A5: Stack.Protected đã gỡ các màn cần đăng nhập khỏi ngăn xếp; replace để chắc chắn tới sign-in
      router.replace('/(auth)/sign-in' as any);
    } else if (session && inAuthGroup) {
      // Đã đăng nhập → về liên kết đang chờ (nếu có), ngược lại về tabs
      const target = takePendingLink();
      router.replace((target ?? '/(tabs)') as any);
    } else if (session && peekPendingLink()) {
      const target = takePendingLink();
      if (target && target !== pathname) router.push(target as any);
    }
  }, [session, loading, segments, pathname, router, pendingVersion]);

  // Đăng ký push notification khi đã đăng nhập
  useNotifications();

  // Đồng bộ hàng đợi offline
  const { pendingCount, pendingItems, failedItems, lastSyncAt, isSyncing, isOnline, sync, retry, discard } =
    useOfflineSync();

  if (loading) {
    // Hiển thị loading indicator thay vì blank screen
    // SplashScreen vẫn đang hiện phía trên, nhưng phòng trường hợp nó hide sớm
    return (
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#208AEF' }}>
        <ActivityIndicator size="large" color="#fff" />
      </View>
    );
  }

  const showBar = !!session && isSyncStatusBarVisible({ pendingCount, failedCount: failedItems.length, isOnline });

  return (
    <View style={styles.root}>
      {showBar && (
        // REV-A6: thanh nằm dưới thanh trạng thái hệ thống — tự đệm phần tai thỏ / status bar
        <View style={{ paddingTop: insets.top, backgroundColor: '#FFF8E1' }}>
          <SyncStatusBar
            pendingCount={pendingCount}
            pendingItems={pendingItems}
            failedItems={failedItems}
            lastSyncAt={lastSyncAt}
            isSyncing={isSyncing}
            isOnline={isOnline}
            onSyncPress={sync}
            onRetry={retry}
            onDiscard={discard}
            describeItem={describeQueueItem}
          />
        </View>
      )}
      {/* REV-A6: SafeAreaProvider lồng đo lại inset theo vị trí thật của vùng màn hình:
          khi thanh đồng bộ đã chiếm phần trên, header của các màn không đệm thêm lần nữa. */}
      <SafeAreaProvider style={styles.root}>{children}</SafeAreaProvider>
    </View>
  );
}

/** REV-A5: Ngăn xếp gốc — màn cần đăng nhập nằm trong Stack.Protected nên đăng xuất sẽ dọn sạch ngăn xếp. */
function RootStack() {
  const { session } = useAuth();
  const signedIn = !!session;
  return (
    <Stack
      screenOptions={{
        headerShown: false,
        headerBackTitle: 'Quay lại',
        headerStyle: { backgroundColor: '#fff' },
        headerTitleStyle: { fontWeight: '600' },
        headerTintColor: '#007AFF',
      }}
    >
      <Stack.Protected guard={signedIn} redirectTo="/(auth)/sign-in">
        {/* APP-19: Stack thay cho Slot để các màn con có nút quay lại */}
        <Stack.Screen name="(tabs)" />
        <Stack.Screen name="group" />
        <Stack.Screen name="payment" />
        <Stack.Screen name="account" />
        <Stack.Screen name="contacts" />
        <Stack.Screen name="user" />
        <Stack.Screen name="join" />
        {/* MVP-04 / MVP-05: QR mã nhóm và QR kết bạn */}
        <Stack.Screen name="join-code/[code]" />
        <Stack.Screen name="add-friend/[code]" />
        <Stack.Screen name="scan" options={{ headerShown: false, animation: 'slide_from_bottom' }} />
        <Stack.Screen name="notifications" />
        <Stack.Screen name="history" options={{ headerShown: true, title: 'Lịch sử' }} />
      </Stack.Protected>
      <Stack.Protected guard={!signedIn}>
        <Stack.Screen name="(auth)" />
      </Stack.Protected>
    </Stack>
  );
}

export default function RootLayout() {
  return (
    <PersistQueryClientProvider client={queryClient} persistOptions={persistOptions}>
      <AuthProvider>
        <AuthGate>
          <StatusBar style="dark" />
          <RootStack />
        </AuthGate>
      </AuthProvider>
    </PersistQueryClientProvider>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
});
