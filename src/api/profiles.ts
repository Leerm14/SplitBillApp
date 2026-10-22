import { throwApiError } from '@/api/errors';
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

/** Thông tin người khác được xem (SEC-04): chỉ 4 cột công khai. */
export type PublicProfile = Pick<Profile, 'id' | 'display_name' | 'user_code' | 'avatar_path'>;

// NEW-01: Bảng profiles chỉ cho đọc 4 cột công khai; hồ sơ đầy đủ của mình đọc qua RPC
export async function fetchProfile(): Promise<Profile> {
  const { data, error, status } = await supabase.rpc('get_my_profile');

  if (error) throwApiError(error, status);
  return (Array.isArray(data) ? data[0] : data) as Profile;
}

// APP-13: Fetch another user's profile by ID
export async function fetchUserProfile(userId: string): Promise<PublicProfile> {
  const { data, error, status } = await supabase
    .from('profiles')
    .select('id, display_name, user_code, avatar_path')
    .eq('id', userId)
    .single();

  if (error) throwApiError(error, status);
  return data as PublicProfile;
}

/**
 * NEW-02: Cập nhật hồ sơ qua RPC update_profile (bảng profiles không cho UPDATE trực tiếp,
 * chỉ SELECT được 4 cột công khai). Tham số NULL = giữ nguyên.
 */
async function callUpdateProfile(args: {
  displayName?: string | null;
  avatarPath?: string | null;
  searchable?: boolean | null;
  clearAvatar?: boolean;
}): Promise<Profile> {
  const { data, error, status } = await supabase.rpc('update_profile', {
    _display_name: args.displayName ?? null,
    _avatar_path: args.avatarPath ?? null,
    _searchable: args.searchable ?? null,
    _clear_avatar: args.clearAvatar ?? false,
  });
  if (error) throwApiError(error, status);
  // RPC trả về dòng profile (có thể bọc trong mảng tùy cách khai báo RETURNS)
  return (Array.isArray(data) ? data[0] : data) as Profile;
}

export async function updateProfile(updates: {
  display_name?: string;
  searchable?: boolean;
}): Promise<Profile> {
  return callUpdateProfile({
    displayName: updates.display_name,
    searchable: updates.searchable,
  });
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

  if (uploadError) throwApiError(uploadError);

  // NEW-02: Lưu avatar_path qua RPC
  await callUpdateProfile({ avatarPath: filePath });

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

  if (removeError) throwApiError(removeError);

  // NEW-02: Xóa avatar_path qua RPC (_clear_avatar)
  await callUpdateProfile({ clearAvatar: true });
}

export function getAvatarUrl(avatarPath: string): string {
  return supabase.storage.from('avatars').getPublicUrl(avatarPath).data
    .publicUrl;
}
