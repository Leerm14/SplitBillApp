import { useCallback, useEffect, useRef } from 'react';
import { Platform } from 'react-native';
import { useRootNavigationState, useRouter } from 'expo-router';
import { useQueryClient } from '@tanstack/react-query';
import { registerPushToken } from '@/api/notifications';
import { useAuth } from '@/hooks/use-auth';
import { setPendingLink } from '@/lib/pending-link';

let Notifications: typeof import('expo-notifications') | null = null;
let Device: typeof import('expo-device') | null = null;
let Constants: typeof import('expo-constants')['default'] | null = null;

// require trong try: các module này không có (hoặc lỗi) trên web
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  Notifications = require('expo-notifications');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  Device = require('expo-device');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
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

/** APP-10: Đường dẫn trong app từ dữ liệu của thông báo (null nếu không có đích). */
function pathFromNotificationData(data: any): string | null {
  // MVP-06: lời mời đích danh — người nhận chưa là thành viên, mở màn Thông báo để xác nhận tham gia
  if (data?.type === 'GROUP_INVITED') return '/notifications';
  if (data?.expense_id && data?.group_id) return `/group/${data.group_id}/expense/${data.expense_id}`;
  if (data?.payment_id) return `/payment/${data.payment_id}`;
  if (data?.group_id) return `/group/${data.group_id}`;
  return null;
}

/** REV-A8: Khóa của một lần bấm thông báo — để listener và cold start không điều hướng hai lần. */
function responseKey(response: any): string {
  return `${response?.notification?.request?.identifier ?? ''}|${response?.actionIdentifier ?? ''}`;
}

export function useNotifications() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { user, loading } = useAuth();
  const userId = user?.id ?? null;
  // REV-A8: chỉ điều hướng khi navigator gốc đã gắn
  const navigatorReady = !!useRootNavigationState()?.key;
  const handledResponses = useRef(new Set<string>());
  const userIdRef = useRef(userId);
  useEffect(() => {
    userIdRef.current = userId;
  }, [userId]);

  /**
   * APP-10 / REV-A8: Mở đích của thông báo. Chưa đăng nhập → lưu lại như liên kết mời,
   * AuthGate mở sau khi đăng nhập xong. Mỗi lần bấm chỉ xử lý một lần.
   */
  const handleResponse = useCallback(
    (response: any) => {
      const key = responseKey(response);
      if (handledResponses.current.has(key)) return;
      handledResponses.current.add(key);
      const path = pathFromNotificationData(response?.notification?.request?.content?.data);
      try {
        Notifications?.clearLastNotificationResponse();
      } catch (e) {
        console.warn('[Push] Không xóa được phản hồi thông báo gần nhất:', e);
      }
      if (!path) return;
      if (userIdRef.current) router.push(path as any);
      else setPendingLink(path);
    },
    [router],
  );

  // APP-10 / REV-A4: Đăng ký push token SAU khi đăng nhập; chạy lại ở MỖI lần đăng nhập (userId đổi
  // null → id) để RPC register_push_token dọn dòng cũ của máy này khỏi tài khoản khác.
  useEffect(() => {
    if (!userId || !Notifications || !Device) return;
    let cancelled = false;
    registerForPushNotificationsAsync()
      .then((token) => {
        if (!cancelled && token) {
          return registerPushToken(token, Platform.OS);
        }
      })
      .catch((e) => console.error('Error registering push token:', e));
    return () => {
      cancelled = true;
    };
  }, [userId]);

  useEffect(() => {
    if (!Notifications || !Device) return;
    const NotificationsModule = Notifications;

    // Thông báo tới khi app đang mở
    const received = NotificationsModule.addNotificationReceivedListener(() => {
      queryClient.invalidateQueries({ queryKey: ['notifications'] });
      queryClient.invalidateQueries({ queryKey: ['unread-count'] });
    });

    // Người dùng bấm thông báo khi app đang chạy
    const response = NotificationsModule.addNotificationResponseReceivedListener((r) => {
      try {
        handleResponse(r);
      } catch (e) {
        console.error('Error handling notification response:', e);
      }
    });

    return () => {
      received.remove();
      response.remove();
    };
  }, [queryClient, handleResponse]);

  // REV-A8: Cold start — đọc phản hồi gần nhất (API đồng bộ của SDK 58) khi auth đã xác định
  // và navigator đã gắn; trùng với listener thì handledResponses bỏ qua.
  useEffect(() => {
    if (!Notifications || loading || !navigatorReady) return;
    try {
      const last = Notifications.getLastNotificationResponse();
      if (last) handleResponse(last);
    } catch (e) {
      console.error('Error reading last notification response:', e);
    }
  }, [loading, navigatorReady, handleResponse]);
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

    // APP-10: projectId lấy từ expo-constants (app.json → extra.eas.projectId).
    // Còn là giá trị mẫu thì bỏ qua đăng ký push thay vì crash.
    const projectId = getEasProjectId();
    if (!projectId) {
      console.warn(
        '[Push] Chưa cấu hình EAS projectId (app.json → expo.extra.eas.projectId đang là giá trị mẫu). ' +
          'Bỏ qua đăng ký push. Chạy `npx eas-cli@latest init` hoặc điền projectId thật.',
      );
      return undefined;
    }
    const tokenData = await Notifications.getExpoPushTokenAsync({ projectId });
    return tokenData.data;
  } catch (e) {
    console.error('Error registering for push notifications:', e);
    return undefined;
  }
}

const PLACEHOLDER_PROJECT_IDS = new Set(['', 'your-project-id-here']);

/** APP-10: projectId của EAS, hoặc null khi thiếu / còn giá trị mẫu */
function getEasProjectId(): string | null {
  const id: unknown = Constants?.expoConfig?.extra?.eas?.projectId ?? Constants?.easConfig?.projectId;
  if (typeof id !== 'string' || PLACEHOLDER_PROJECT_IDS.has(id.trim())) return null;
  return id.trim();
}
