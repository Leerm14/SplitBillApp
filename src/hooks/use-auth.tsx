import type { Session, User } from '@supabase/supabase-js';
import { useQueryClient } from '@tanstack/react-query';
import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';

import {
  getSession,
  onAuthStateChange,
  resetPasswordForEmail,
  signInWithEmail,
  signOutSession,
  signUpWithEmail,
  updatePassword,
} from '@/api/auth';
import { unregisterCurrentPushToken } from '@/api/notifications';
import { clearPersistedCache } from '@/lib/query-persister';
import { clearQueue } from '@/offline/queue';

type AuthContextType = {
  session: Session | null;
  user: User | null;
  loading: boolean;
  signUp: (email: string, password: string, displayName: string) => Promise<void>;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  resetPassword: (email: string) => Promise<void>;
  signOutAll: () => Promise<void>;
  changePassword: (newPassword: string) => Promise<void>;
};

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const queryClient = useQueryClient();
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const loadingRef = useRef(true);
  // REV-A1: tài khoản của phiên gần nhất trong tiến trình này (null sau khi đăng xuất)
  const lastUserIdRef = useRef<string | null>(null);

  /**
   * APP-02: Xóa mọi dữ liệu cục bộ của tài khoản vừa đăng xuất: cache TanStack Query trong bộ nhớ,
   * cache đã lưu (AsyncStorage) và hàng đợi offline. Gọi được nhiều lần.
   */
  const clearLocalData = useCallback(async () => {
    queryClient.clear();
    await clearPersistedCache();
    try {
      await clearQueue();
    } catch (e) {
      console.warn('[Auth] Không xóa được hàng đợi offline:', e);
    }
  }, [queryClient]);

  // Giữ bản mới nhất cho listener đăng ký một lần
  const clearLocalDataRef = useRef(clearLocalData);
  useEffect(() => {
    clearLocalDataRef.current = clearLocalData;
  }, [clearLocalData]);

  useEffect(() => {
    let mounted = true;

    const finishLoading = (s: Session | null) => {
      if (loadingRef.current) {
        loadingRef.current = false;
        if (lastUserIdRef.current === null) lastUserIdRef.current = s?.user?.id ?? null;
        setSession(s);
        setLoading(false);
      }
    };

    // Timeout: nếu getSession() treo quá 5s → bỏ qua, cho vào sign-in
    const timeout = setTimeout(() => {
      if (mounted && loadingRef.current) {
        console.warn('[Auth] getSession timeout (5s) → reset loading');
        finishLoading(null);
      }
    }, 5000);

    // Lấy session hiện tại
    getSession()
      .then((s) => {
        if (mounted) finishLoading(s);
      })
      .catch((err) => {
        console.warn('[Auth] getSession error:', err);
        if (mounted) finishLoading(null);
      });

    // Lắng nghe thay đổi auth
    const unsubscribe = onAuthStateChange((event, s) => {
      if (!mounted) return;
      // REV-A1: đăng nhập (hoặc đổi sang tài khoản khác) → bỏ mọi cache của phiên trước / lúc ẩn danh
      // (ví dụ [] của ['groups'] tải bằng anon key sau khi đăng xuất) TRƯỚC khi màn hình đọc cache.
      // INITIAL_SESSION của cùng tài khoản thì giữ cache đã lưu để xem offline.
      const nextUserId = s?.user?.id ?? null;
      if (event === 'INITIAL_SESSION') {
        lastUserIdRef.current = nextUserId;
      } else if (nextUserId && nextUserId !== lastUserIdRef.current) {
        queryClient.clear();
        lastUserIdRef.current = nextUserId;
      } else if (!nextUserId && event === 'SIGNED_OUT') {
        lastUserIdRef.current = null;
      }
      setSession(s);
      // Nếu vẫn đang loading (getSession chưa trả về), hoàn thành luôn
      if (loadingRef.current) finishLoading(s);
      // APP-02: Phiên bị thu hồi ở nơi khác (đăng xuất mọi thiết bị, token hết hạn) cũng phải xóa dữ liệu
      if (event === 'SIGNED_OUT') {
        clearLocalDataRef.current().catch((e) => console.warn('[Auth] clearLocalData error:', e));
      }
    });

    return () => {
      mounted = false;
      clearTimeout(timeout);
      unsubscribe();
    };
  }, [queryClient]);

  const signUp = async (email: string, password: string, displayName: string) => {
    await signUpWithEmail(email, password, displayName);
  };

  const signIn = async (email: string, password: string) => {
    await signInWithEmail(email, password);
  };

  /**
   * APP-02: Gỡ push token (cần phiên còn hiệu lực) → đăng xuất → xóa cache, cache đã lưu, hàng đợi.
   * Nếu đăng xuất lỗi (mất mạng) thì phiên vẫn còn, không xóa dữ liệu.
   */
  const signOutWithScope = async (scope: 'local' | 'global') => {
    await unregisterCurrentPushToken();
    await signOutSession(scope);
    await clearLocalData();
  };

  const signOut = () => signOutWithScope('local');

  const signOutAll = () => signOutWithScope('global');

  const resetPassword = async (email: string) => {
    await resetPasswordForEmail(email);
  };

  const changePassword = async (newPassword: string) => {
    await updatePassword(newPassword);
  };

  return (
    <AuthContext.Provider
      value={{
        session,
        user: session?.user ?? null,
        loading,
        signUp,
        signIn,
        signOut,
        resetPassword,
        signOutAll,
        changePassword,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth phải được dùng trong AuthProvider');
  return ctx;
}
