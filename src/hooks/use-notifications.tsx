import { useCallback, useEffect, useRef, useState } from 'react';
import { Platform } from 'react-native';
import { useRouter } from 'expo-router';
import { useQueryClient } from '@tanstack/react-query';
import { registerPushToken } from '@/api/notifications';
import { useAuth } from '@/hooks/use-auth';

let Notifications: typeof import('expo-notifications') | null = null;
let Device: typeof import('expo-device') | null = null;
let Constants: typeof import('expo-constants')['default'] | null = null;

try {
  Notifications = require('expo-notifications');
  Device = require('expo-device');
  Constants = require('expo-constants').default;
} catch {
  // expo-notifications or expo-device not available (e.g., web)
}

if (Notifications) {
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowAlert: true,
      shouldPlaySound: true,
      shouldSetBadge: true,
      shouldShowBanner: true,
      shouldShowList: true,
    }),
  });
}

export function useNotifications() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const [expoPushToken, setExpoPushToken] = useState<string>('');
  const notificationListener = useRef<any>(null);
  const responseListener = useRef<any>(null);

  // APP-10: Handle notification data for navigation
  const handleNotificationData = useCallback((data: any) => {
    if (data?.expense_id && data?.group_id) {
      router.push(
        `/group/${data.group_id}/expense/${data.expense_id}` as any,
      );
    } else if (data?.payment_id) {
      router.push(`/payment/${data.payment_id}` as any);
    } else if (data?.group_id) {
      router.push(`/group/${data.group_id}` as any);
    }
  }, [router]);

  const registerPushTokenAsync = useCallback(async () => {
    if (!Notifications || !Device) return;

    try {
      const token = await registerForPushNotificationsAsync();
      if (token) {
        setExpoPushToken(token);
        registerPushToken(token, Platform.OS).catch(console.error);
      }
    } catch (e) {
      console.error('Error registering push token:', e);
    }
  }, []);

  // APP-10: Only register push token AFTER user is authenticated
  useEffect(() => {
    if (user) {
      registerPushTokenAsync();
    }
  }, [user, registerPushTokenAsync]);

  useEffect(() => {
    if (!Notifications || !Device) return;

    const NotificationsModule = Notifications;

    // Handle notification received while app is open
    notificationListener.current =
      NotificationsModule.addNotificationReceivedListener(() => {
        queryClient.invalidateQueries({ queryKey: ['notifications'] });
        queryClient.invalidateQueries({ queryKey: ['unread-count'] });
      });

    // User tapped notification
    responseListener.current =
      NotificationsModule.addNotificationResponseReceivedListener((response: any) => {
        try {
          const data = response.notification.request.content.data;
          handleNotificationData(data);
        } catch (e) {
          console.error('Error handling notification response:', e);
        }
      });

    // APP-10: Handle cold start notification
    NotificationsModule.getLastNotificationResponseAsync().then((response) => {
      if (response) {
        const data = response.notification.request.content.data;
        handleNotificationData(data);
      }
    });

    return () => {
      if (notificationListener.current) {
        notificationListener.current.remove();
      }
      if (responseListener.current) {
        responseListener.current.remove();
      }
    };
  }, [queryClient, handleNotificationData]);

  return { expoPushToken };
}

async function registerForPushNotificationsAsync(): Promise<
  string | undefined
> {
  try {
    if (!Notifications || !Device) return undefined;

    if (!Device.isDevice) {
      console.log('Push notifications require a physical device');
      return undefined;
    }

    const { status: existingStatus } =
      await Notifications.getPermissionsAsync();
    let finalStatus = existingStatus;
    if (existingStatus !== 'granted') {
      const { status } = await Notifications.requestPermissionsAsync();
      finalStatus = status;
    }
    if (finalStatus !== 'granted') {
      return undefined;
    }

    // APP-10: Add projectId to getExpoPushTokenAsync
    const tokenData = await Notifications.getExpoPushTokenAsync({
      projectId: Constants?.expoConfig?.extra?.eas?.projectId,
    });
    return tokenData.data;
  } catch (e) {
    console.error('Error registering for push notifications:', e);
    return undefined;
  }
}
