import { supabase } from '@/lib/supabase';
import { clearPersistedCache } from '@/lib/query-persister';
import { clearQueue } from '@/offline/queue';
import type { Session, User } from '@supabase/supabase-js';
import React, { createContext, useContext, useEffect, useRef, useState } from 'react';

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
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const loadingRef = useRef(true);

  const finishLoading = (s: Session | null) => {
    if (loadingRef.current) {
      loadingRef.current = false;
      setSession(s);
      setLoading(false);
    }
  };

  useEffect(() => {
    let mounted = true;

    // Timeout: nếu getSession() treo quá 5s → bỏ qua, cho vào sign-in
    const timeout = setTimeout(() => {
      if (mounted && loadingRef.current) {
        console.warn('[Auth] getSession timeout (5s) → reset loading');
        finishLoading(null);
      }
    }, 5000);

    // Lấy session hiện tại
    supabase.auth
      .getSession()
      .then(({ data: { session: s } }) => {
        if (mounted) {
          console.log('[Auth] getSession OK, session:', s ? 'exists' : 'null');
          finishLoading(s);
        }
      })
      .catch((err) => {
        console.warn('[Auth] getSession error:', err);
        if (mounted) finishLoading(null);
      });

    // Lắng nghe thay đổi auth
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, s) => {
      console.log('[Auth] onAuthStateChange:', _event);
      if (mounted) {
        setSession(s);
        // Nếu vẫn đang loading (getSession chưa trả về), hoàn thành luôn
        if (loadingRef.current) {
          finishLoading(s);
        }
      }
    });

    return () => {
      mounted = false;
      clearTimeout(timeout);
      subscription.unsubscribe();
    };
  }, []);

  const signUp = async (email: string, password: string, displayName: string) => {
    const { error } = await supabase.auth.signUp({
      email,
      password,
      options: { data: { display_name: displayName } },
    });
    if (error) throw error;
  };

  const signIn = async (email: string, password: string) => {
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) throw error;
  };

  const signOut = async () => {
    // APP-02: Clear persisted cache and offline queue on sign out
    await clearPersistedCache();
    await clearQueue();
    const { error } = await supabase.auth.signOut();
    if (error) throw error;
  };

  const resetPassword = async (email: string) => {
    const { error } = await supabase.auth.resetPasswordForEmail(email);
    if (error) throw error;
  };

  const signOutAll = async () => {
    const { error } = await supabase.auth.signOut({ scope: 'global' });
    if (error) throw error;
  };

  const changePassword = async (newPassword: string) => {
    const { error } = await supabase.auth.updateUser({ password: newPassword });
    if (error) throw error;
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
