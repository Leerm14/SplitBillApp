import { throwApiError } from '@/api/errors';
import { destroyImage, imageUrl, uploadImage } from '@/api/images';
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

/**
 * MVP-02: Đổi ảnh đại diện — upload Cloudinary → update_profile(_avatar_path) → xóa ảnh cũ (best-effort).
 * `previousPath` là avatar_path hiện tại (public_id cũ) để xóa sau khi lưu thành công.
 */
export async function uploadAvatar(uri: string, previousPath?: string | null): Promise<Profile> {
  const publicId = await uploadImage('avatar', uri);
  let profile: Profile;
  try {
    profile = await callUpdateProfile({ avatarPath: publicId });
  } catch (e) {
    // Không lưu được → ảnh vừa upload thành mồ côi, xóa luôn
    await destroyImage('avatar', publicId);
    throw e;
  }
  if (previousPath && previousPath !== publicId) await destroyImage('avatar', previousPath);
  return profile;
}

/** MVP-02: Xóa ảnh đại diện — _clear_avatar rồi xóa ảnh trên Cloudinary (best-effort). */
export async function deleteAvatar(previousPath: string | null | undefined): Promise<Profile> {
  const profile = await callUpdateProfile({ clearAvatar: true });
  await destroyImage('avatar', previousPath);
  return profile;
}

/** MVP-02: URL ảnh đại diện (Cloudinary, ảnh vuông `size` px); null → hiện chữ cái đầu. */
export function getAvatarUrl(avatarPath: string | null | undefined, size = 200): string | null {
  return imageUrl(avatarPath, { width: size });
}
