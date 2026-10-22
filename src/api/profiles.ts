import { supabase } from '@/lib/supabase';

// ============================
// Profiles API
// ============================

export type Profile = {
  id: string;
  display_name: string;
  user_code: string;
  avatar_path: string | null;
  searchable: boolean;
  created_at: string;
};

async function getUserId(): Promise<string> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error('Chưa đăng nhập');
  return user.id;
}

export async function fetchProfile(): Promise<Profile> {
  const userId = await getUserId();
  const { data, error } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', userId)
    .single();

  if (error) throw error;
  return data;
}

// APP-13: Fetch another user's profile by ID
export async function fetchUserProfile(userId: string): Promise<Profile> {
  const { data, error } = await supabase
    .from('profiles')
    .select('id, display_name, user_code, avatar_path, searchable, created_at')
    .eq('id', userId)
    .single();

  if (error) throw error;
  return data;
}

export async function updateProfile(updates: {
  display_name?: string;
  searchable?: boolean;
}): Promise<Profile> {
  const userId = await getUserId();
  const { data, error } = await supabase
    .from('profiles')
    .update(updates)
    .eq('id', userId)
    .select()
    .single();

  if (error) throw error;
  return data;
}

export async function uploadAvatar(uri: string): Promise<string> {
  const userId = await getUserId();

  // Fetch file as blob
  const response = await fetch(uri);
  const blob = await response.blob();

  const filePath = `${userId}/avatar.jpg`;

  // Upload to storage
  const { error: uploadError } = await supabase.storage
    .from('avatars')
    .upload(filePath, blob, {
      upsert: true,
      contentType: 'image/jpeg',
    });

  if (uploadError) throw uploadError;

  // Update avatar_path in profiles
  const { error: updateError } = await supabase
    .from('profiles')
    .update({ avatar_path: filePath })
    .eq('id', userId);

  if (updateError) throw updateError;

  // Return public URL
  return getAvatarUrl(filePath);
}

export async function deleteAvatar(): Promise<void> {
  const userId = await getUserId();
  const filePath = `${userId}/avatar.jpg`;

  // Remove from storage
  const { error: removeError } = await supabase.storage
    .from('avatars')
    .remove([filePath]);

  if (removeError) throw removeError;

  // Set avatar_path to null in profiles
  const { error: updateError } = await supabase
    .from('profiles')
    .update({ avatar_path: null })
    .eq('id', userId);

  if (updateError) throw updateError;
}

export function getAvatarUrl(avatarPath: string): string {
  return supabase.storage.from('avatars').getPublicUrl(avatarPath).data
    .publicUrl;
}
