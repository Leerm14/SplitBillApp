import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import React, { useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';

import { toUserMessage } from '@/api/errors';
import { createGroup, updateGroup } from '@/api/groups';
import { destroyImage, uploadImage } from '@/api/images';
import { Avatar } from '@/components/avatar';
import { showImageActions } from '@/lib/pick-image';

export default function NewGroupScreen() {
  const router = useRouter();
  const queryClient = useQueryClient();

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [simplifyDebts, setSimplifyDebts] = useState(true);
  const [avatarUri, setAvatarUri] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);

  const pickAvatar = () =>
    showImageActions({
      title: 'Ảnh nhóm',
      square: true,
      hasImage: !!avatarUri,
      onPicked: setAvatarUri,
      onRemove: () => setAvatarUri(null),
    });

  /** MVP-03: ảnh nhóm cần id nhóm → upload sau khi tạo, rồi lưu bằng update_group(_avatar_path). */
  const attachAvatar = async (groupId: string, uri: string): Promise<boolean> => {
    let publicId: string | null = null;
    try {
      publicId = await uploadImage('group', uri, { groupId });
      await updateGroup(groupId, { avatar_path: publicId });
      return true;
    } catch (err) {
      console.warn('[NewGroup] group image failed:', (err as Error)?.message);
      if (publicId) await destroyImage('group', publicId, { groupId });
      return false;
    }
  };

  const handleSubmit = async () => {
    if (submittingRef.current) return;
    if (!name.trim()) {
      Alert.alert('Lỗi', 'Vui lòng nhập tên nhóm');
      return;
    }

    submittingRef.current = true;
    setSubmitting(true);
    try {
      // MVP-03 / H4: một RPC create_group (atomic) với mô tả + công tắc đơn giản hóa
      const group = await createGroup(name.trim(), {
        description: description.trim(),
        simplifyDebts,
      });
      queryClient.invalidateQueries({ queryKey: ['groups'] });

      const avatarOk = avatarUri ? await attachAvatar(group.id, avatarUri) : true;
      queryClient.invalidateQueries({ queryKey: ['group', group.id] });
      router.replace(`/group/${group.id}` as any);
      if (!avatarOk) {
        Alert.alert('Đã tạo nhóm', 'Nhóm đã được tạo nhưng chưa có ảnh nhóm. Bạn có thể thêm ảnh trong Cài đặt nhóm.');
      }
    } catch (err: any) {
      Alert.alert('Lỗi', toUserMessage(err, 'Không thể tạo nhóm'));
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      style={styles.flex}
    >
      <ScrollView style={styles.container} contentContainerStyle={styles.content}>
        {/* Ảnh nhóm */}
        <Pressable onPress={pickAvatar} style={styles.avatarContainer} disabled={submitting}>
          {avatarUri ? (
            <Avatar name={name} path={null} localUri={avatarUri} size={100} />
          ) : (
            <View style={styles.avatarPlaceholder}>
              <Text style={styles.avatarIcon}>📷</Text>
              <Text style={styles.avatarText}>Thêm ảnh nhóm</Text>
            </View>
          )}
        </Pressable>

        {/* Tên nhóm */}
        <View style={styles.card}>
          <Text style={styles.label}>Tên nhóm *</Text>
          <TextInput
            style={styles.input}
            value={name}
            onChangeText={setName}
            placeholder="Ví dụ: Chuyến đi Đà Lạt"
            placeholderTextColor="#C7C7CC"
            maxLength={100}
            autoFocus
          />

          <Text style={styles.label}>Mô tả</Text>
          <TextInput
            style={[styles.input, styles.textArea]}
            value={description}
            onChangeText={setDescription}
            placeholder="Mô tả nhóm (tùy chọn)"
            placeholderTextColor="#C7C7CC"
            maxLength={500}
            multiline
            numberOfLines={3}
            textAlignVertical="top"
          />

          <View style={styles.switchRow}>
            <View style={styles.switchInfo}>
              <Text style={styles.switchLabel}>Đơn giản hóa công nợ</Text>
              <Text style={styles.switchDescription}>
                Bù trừ nợ trong cả nhóm để giảm số lần chuyển tiền. Tắt thì mỗi người trả trực tiếp cho
                người đã trả hộ mình.
              </Text>
            </View>
            <Switch
              value={simplifyDebts}
              onValueChange={setSimplifyDebts}
              trackColor={{ false: '#E5E5EA', true: '#34C759' }}
              thumbColor="#fff"
            />
          </View>
        </View>

        {/* Nút tạo */}
        <Pressable
          style={[styles.submitBtn, (submitting || !name.trim()) && styles.submitBtnDisabled]}
          onPress={handleSubmit}
          disabled={submitting || !name.trim()}
        >
          {submitting ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={styles.submitBtnText}>Tạo nhóm</Text>
          )}
        </Pressable>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  container: { flex: 1, backgroundColor: '#f2f2f7' },
  content: { padding: 16, gap: 16, paddingBottom: 40 },
  avatarContainer: { alignItems: 'center' },
  avatarPlaceholder: {
    width: 100,
    height: 100,
    borderRadius: 50,
    backgroundColor: '#E5E5EA',
    justifyContent: 'center',
    alignItems: 'center',
    gap: 4,
  },
  avatarIcon: { fontSize: 24 },
  avatarText: { fontSize: 12, color: '#8E8E93' },
  card: {
    backgroundColor: '#fff',
    borderRadius: 16,
    padding: 16,
    gap: 12,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 4,
    elevation: 2,
  },
  label: { fontSize: 14, fontWeight: '600', color: '#1a1a1a' },
  input: {
    backgroundColor: '#f2f2f7',
    borderRadius: 10,
    padding: 12,
    fontSize: 16,
    color: '#1a1a1a',
  },
  textArea: { minHeight: 80 },
  switchRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingTop: 8,
    gap: 12,
  },
  switchInfo: { flex: 1 },
  switchLabel: { fontSize: 15, fontWeight: '600', color: '#1a1a1a' },
  switchDescription: { fontSize: 13, color: '#8E8E93', marginTop: 2 },
  submitBtn: {
    backgroundColor: '#007AFF',
    borderRadius: 12,
    padding: 16,
    alignItems: 'center',
  },
  submitBtnDisabled: { opacity: 0.5 },
  submitBtnText: { color: '#fff', fontSize: 16, fontWeight: '600' },
});
