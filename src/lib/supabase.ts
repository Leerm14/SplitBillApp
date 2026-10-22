import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { Platform } from 'react-native';

const _supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL;
const _supabaseAnonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

// CFG-03: Throw error when placeholder is used
if (!_supabaseUrl || _supabaseUrl === 'https://placeholder.supabase.co') {
  throw new Error('EXPO_PUBLIC_SUPABASE_URL is not configured. Set it in .env or EAS build secrets.');
}
if (!_supabaseAnonKey || _supabaseAnonKey === 'placeholder-anon-key') {
  throw new Error('EXPO_PUBLIC_SUPABASE_ANON_KEY is not configured. Set it in .env or EAS build secrets.');
}

// After validation, these are guaranteed to be strings
const supabaseUrl: string = _supabaseUrl;
const supabaseAnonKey: string = _supabaseAnonKey;

let _supabase: SupabaseClient | null = null;

function getSupabase(): SupabaseClient {
  if (_supabase) return _supabase;

  // SEC-10: Removed console.log that exposed URL prefix

  _supabase = createClient(supabaseUrl, supabaseAnonKey, {
    auth: {
      // Trên web SSR (Node.js), AsyncStorage dùng window → lỗi.
      // Chỉ set storage khi chạy trên client.
      ...(typeof window !== 'undefined' ? { storage: AsyncStorage } : {}),
      autoRefreshToken: true,
      persistSession: typeof window !== 'undefined',
      detectSessionInUrl: Platform.OS === 'web',
    },
  });

  return _supabase;
}

// Dùng Proxy để lazy init — không tạo client ngay lúc import (SSR safe).
export const supabase = new Proxy({} as SupabaseClient, {
  get(_target, prop, receiver) {
    const client = getSupabase();
    const value = (client as any)[prop];
    if (typeof value === 'function') {
      return value.bind(client);
    }
    return value;
  },
});
