import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import * as Clipboard from 'expo-clipboard';
import React, { useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { fetchProfile, updateProfile, uploadAvatar, deleteAvatar, type Profile } from '@/api/profiles';
import { toUserMessage } from '@/api/errors';
import { Avatar } from '@/components/avatar';
import { useAuth } from '@/hooks/use-auth';
import { showImageActions } from '@/lib/pick-image';

export default function ProfileScreen() {
  const { user } = useAuth();
  const queryClient = useQueryClient();

  const {
    data: profile,
    isLoading,
    error,
  } = useQuery({
    queryKey: ['profile'],
    queryFn: fetchProfile,
  });

  // APP-15: Derive from query; local override khi user chỉnh sửa
  const [localDisplayName, setLocalDisplayName] = useState<string | null>(null);
  const displayName = localDisplayName ?? profile?.display_name ?? '';
  const setDisplayName = setLocalDisplayName;

  const [avatarBusy, setAvatarBusy] = useState(false);

  const updateMutation = useMutation({
    mutationFn: (updates: { display_name?: string; searchable?: boolean }) =>
      updateProfile(updates),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['profile'] });
      Alert.alert('Thành công', 'Đã cập nhật hồ sơ');
    },
    onError: (err: any) => {
      Alert.alert('Lỗi', toUserMessage(err, 'Có lỗi xảy ra'));
    },
  });

  const handleSave = () => {
    if (!displayName.trim()) {
      Alert.alert('Lỗi', 'Tên hiển thị không được để trống');
      return;
    }
    updateMutation.mutate({ display_name: displayName.trim() });
  };

  /** Hồ sơ mới từ RPC → cập nhật cache ngay để mọi màn thấy ảnh mới */
  const applyProfile = (next: Profile | null | undefined) => {
    if (next?.id) queryClient.setQueryData(['profile'], next);
    queryClient.invalidateQueries({ queryKey: ['profile'] });
    queryClient.invalidateQueries({ queryKey: ['group-members'] });
    queryClient.invalidateQueries({ queryKey: ['friends'] });
  };

  /** MVP-02: Upload ảnh mới lên Cloudinary, lưu public_id, xóa ảnh cũ */
  const handleUploadAvatar = async (uri: string) => {
    setAvatarBusy(true);
    try {
      applyProfile(await uploadAvatar(uri, profile?.avatar_path ?? null));
      Alert.alert('Thành công', 'Đã cập nhật ảnh đại diện');
    } catch (err: any) {
      Alert.alert('Lỗi', toUserMessage(err, 'Không thể upload ảnh. Vui lòng thử lại.'));
    } finally {
      setAvatarBusy(false);
    }
  };

  /** MVP-02: Xóa ảnh đại diện (clear_avatar rồi xóa trên Cloudinary) */
  const handleDeleteAvatar = () => {
    const previous = profile?.avatar_path;
    if (!previous) return;
    Alert.alert('Xóa ảnh đại diện', 'Bạn có chắc muốn xóa ảnh đại diện?', [
      { text: 'Hủy', style: 'cancel' },
      {
        text: 'Xóa',
        style: 'destructive',
        onPress: async () => {
          setAvatarBusy(true);
          try {
            applyProfile(await deleteAvatar(previous));
            Alert.alert('Thành công', 'Đã xóa ảnh đại diện');
          } catch (err: any) {
            Alert.alert('Lỗi', toUserMessage(err, 'Không thể xóa ảnh. Vui lòng thử lại.'));
          } finally {
            setAvatarBusy(false);
          }
        },
      },
    ]);
  };

  const handleAvatarPress = () =>
    showImageActions({
      title: 'Ảnh đại diện',
      square: true,
      hasImage: !!profile?.avatar_path,
      onPicked: (uri) => {
        handleUploadAvatar(uri);
      },
      onRemove: handleDeleteAvatar,
    });

  const handleCopyCode = async () => {
    if (!profile?.user_code) return;
    await Clipboard.setStringAsync(profile.user_code);
    Alert.alert('Đã sao chép', `Mã người dùng ${profile.user_code}`);
  };

  if (isLoading) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator size="large" color="#007AFF" />
      </View>
    );
  }

  if (error) {
    return (
      <View style={styles.loadingContainer}>
        <Text style={styles.errorText}>Không thể tải hồ sơ</Text>
      </View>
    );
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.contentContainer}>
      {/* Avatar section */}
      <View style={styles.card}>
        <Pressable
          onPress={handleAvatarPress}
          style={styles.avatarContainer}
          disabled={avatarBusy}
        >
          {avatarBusy ? (
            <View style={styles.avatarPlaceholder}>
              <ActivityIndicator size="large" color="#fff" />
            </View>
          ) : (
            <Avatar
              name={profile?.display_name || user?.email}
              path={profile?.avatar_path}
              seed={profile?.id}
              size={80}
            />
          )}
          <Text style={styles.changeAvatarText}>
            {avatarBusy ? 'Đang xử lý...' : 'Thay đổi ảnh'}
          </Text>
        </Pressable>
      </View>

      {/* Display name */}
      <View style={styles.card}>
        <Text style={styles.label}>Tên hiển thị</Text>
        <TextInput
          style={styles.input}
          value={displayName}
          onChangeText={setDisplayName}
          placeholder="Nhập tên hiển thị"
          placeholderTextColor="#999"
        />
      </View>

      {/* User code */}
      <View style={styles.card}>
        <Text style={styles.label}>Mã người dùng</Text>
        <View style={styles.codeRow}>
          <Text style={styles.codeText}>{profile?.user_code}</Text>
          <Pressable onPress={handleCopyCode} style={styles.copyButton}>
            <Text style={styles.copyButtonText}>Sao chép</Text>
          </Pressable>
        </View>
      </View>

      {/* Save button */}
      <Pressable
        style={[styles.saveButton, updateMutation.isPending && styles.saveButtonDisabled]}
        onPress={handleSave}
        disabled={updateMutation.isPending}
      >
        {updateMutation.isPending ? (
          <ActivityIndicator color="#fff" />
        ) : (
          <Text style={styles.saveButtonText}>Lưu</Text>
        )}
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f2f2f7',
  },
  contentContainer: {
    padding: 16,
    gap: 16,
  },
  loadingContainer: {
    flex: 1,
    backgroundColor: '#f2f2f7',
    justifyContent: 'center',
    alignItems: 'center',
  },
  errorText: {
    fontSize: 16,
    color: '#FF3B30',
  },
  card: {
    backgroundColor: '#fff',
    borderRadius: 16,
    padding: 24,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 4,
    elevation: 2,
  },
  avatarContainer: {
    alignItems: 'center',
    gap: 12,
  },
  avatarPlaceholder: {
    width: 80,
    height: 80,
    borderRadius: 40,
    backgroundColor: '#007AFF',
    justifyContent: 'center',
    alignItems: 'center',
  },
  changeAvatarText: {
    fontSize: 14,
    color: '#007AFF',
    fontWeight: '500',
  },
  label: {
    fontSize: 14,
    fontWeight: '600',
    color: '#666',
    marginBottom: 8,
  },
  input: {
    borderWidth: 1,
    borderColor: '#ddd',
    borderRadius: 12,
    padding: 16,
    fontSize: 16,
    backgroundColor: '#f9f9f9',
    color: '#1a1a1a',
  },
  codeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  codeText: {
    fontSize: 18,
    fontWeight: '600',
    color: '#1a1a1a',
    letterSpacing: 1,
  },
  copyButton: {
    backgroundColor: '#f2f2f7',
    borderRadius: 8,
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  copyButtonText: {
    fontSize: 14,
    color: '#007AFF',
    fontWeight: '600',
  },
  saveButton: {
    backgroundColor: '#007AFF',
    borderRadius: 12,
    padding: 16,
    alignItems: 'center',
  },
  saveButtonDisabled: {
    opacity: 0.6,
  },
  saveButtonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
});
