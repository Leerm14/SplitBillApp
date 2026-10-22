import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import React, { useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import {
  fetchProfile,
  updateProfile,
  getAvatarUrl,
} from '@/api/profiles';
import { toUserMessage } from '@/api/errors';
import { useAuth } from '@/hooks/use-auth';

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

  const handleAvatarPress = () => {
    Alert.alert('Ảnh đại diện', 'Chọn hành động', [
      { text: 'Chụp ảnh', onPress: () => Alert.alert('Thông báo', 'Tính năng đang được phát triển') },
      { text: 'Chọn từ thư viện', onPress: () => Alert.alert('Thông báo', 'Tính năng đang được phát triển') },
      { text: 'Xóa ảnh', style: 'destructive', onPress: () => Alert.alert('Thông báo', 'Tính năng đang được phát triển') },
      { text: 'Hủy', style: 'cancel' },
    ]);
  };

  const handleCopyCode = () => {
    // Clipboard sẽ được thêm sau, tạm thời dùng Alert
    Alert.alert('Mã người dùng', profile?.user_code || '');
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
        <Pressable onPress={handleAvatarPress} style={styles.avatarContainer}>
          {profile?.avatar_path ? (
            <Image
              source={{ uri: getAvatarUrl(profile.avatar_path) }}
              style={styles.avatar}
            />
          ) : (
            <View style={styles.avatarPlaceholder}>
              <Text style={styles.avatarPlaceholderText}>
                {(profile?.display_name || user?.email || '?')[0].toUpperCase()}
              </Text>
            </View>
          )}
          <Text style={styles.changeAvatarText}>Thay đổi ảnh</Text>
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
  avatar: {
    width: 80,
    height: 80,
    borderRadius: 40,
  },
  avatarPlaceholder: {
    width: 80,
    height: 80,
    borderRadius: 40,
    backgroundColor: '#007AFF',
    justifyContent: 'center',
    alignItems: 'center',
  },
  avatarPlaceholderText: {
    fontSize: 32,
    fontWeight: '700',
    color: '#fff',
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
