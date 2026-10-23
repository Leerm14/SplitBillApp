import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { toUserMessage } from '@/api/errors';
import { fetchGroup, setJoinApproval, updateGroup, type Group } from '@/api/groups';
import { destroyImage, uploadImage } from '@/api/images';
import { Avatar } from '@/components/avatar';
import { isSimplifyEnabled } from '@/domain/suggest';
import { useAuth } from '@/hooks/use-auth';
import { showImageActions } from '@/lib/pick-image';

export default function EditGroupScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { user } = useAuth();
  const queryClient = useQueryClient();

  const groupQ = useQuery({
    queryKey: ['group', id],
    queryFn: () => fetchGroup(id),
  });

  // APP-15: Derive from query data; local overrides khi user chỉnh sửa
  const [localName, setLocalName] = useState<string | null>(null);
  const [localDescription, setLocalDescription] = useState<string | null>(null);
  const [localSimplifyDebts, setLocalSimplifyDebts] = useState<boolean | null>(null);

  const name = localName ?? groupQ.data?.name ?? '';
  const description = localDescription ?? groupQ.data?.description ?? '';
  // APP-06: simplify_debts NULL được hiểu là bật (BR-09), thống nhất với màn công nợ
  const simplifyDebts = localSimplifyDebts ?? isSimplifyEnabled(groupQ.data?.simplify_debts);

  const setName = setLocalName;
  const setDescription = setLocalDescription;
  const setSimplifyDebts = setLocalSimplifyDebts;

  // Redirect if not owner
  useEffect(() => {
    if (groupQ.data && user && groupQ.data.owner_id !== user.id) {
      router.back();
    }
  }, [groupQ.data, user, router]);

  // MVP-03: đổi / xóa ảnh nhóm (lưu ngay, độc lập với nút Lưu)
  const [imageBusy, setImageBusy] = useState(false);

  const applyGroup = (next: Group | null | undefined) => {
    if (next?.id) queryClient.setQueryData(['group', id], next);
    queryClient.invalidateQueries({ queryKey: ['group', id] });
    queryClient.invalidateQueries({ queryKey: ['groups'] });
  };

  const changeImage = async (uri: string) => {
    const previous = groupQ.data?.avatar_path ?? null;
    setImageBusy(true);
    let publicId: string | null = null;
    try {
      publicId = await uploadImage('group', uri, { groupId: id });
      applyGroup(await updateGroup(id, { avatar_path: publicId }));
      if (previous && previous !== publicId) await destroyImage('group', previous, { groupId: id });
    } catch (err) {
      if (publicId) await destroyImage('group', publicId, { groupId: id });
      Alert.alert('Lỗi', toUserMessage(err, 'Không thể đổi ảnh nhóm'));
    } finally {
      setImageBusy(false);
    }
  };

  const removeImage = () => {
    const previous = groupQ.data?.avatar_path;
    if (!previous) return;
    Alert.alert('Xóa ảnh nhóm', 'Bạn có chắc muốn xóa ảnh nhóm?', [
      { text: 'Hủy', style: 'cancel' },
      {
        text: 'Xóa',
        style: 'destructive',
        onPress: async () => {
          setImageBusy(true);
          try {
            applyGroup(await updateGroup(id, { clear_avatar: true }));
            await destroyImage('group', previous, { groupId: id });
          } catch (err) {
            Alert.alert('Lỗi', toUserMessage(err, 'Không thể xóa ảnh nhóm'));
          } finally {
            setImageBusy(false);
          }
        },
      },
    ]);
  };

  const pickImage = () =>
    showImageActions({
      title: 'Ảnh nhóm',
      square: true,
      hasImage: !!groupQ.data?.avatar_path,
      onPicked: (uri) => {
        changeImage(uri);
      },
      onRemove: removeImage,
    });

  // Migration 0014: duyệt thành viên mới — lưu ngay khi gạt (độc lập với nút Lưu), chỉ chủ nhóm
  const isOwner = !!user && groupQ.data?.owner_id === user.id;
  const approvalMutation = useMutation({
    mutationFn: (required: boolean) => setJoinApproval(id, required),
    onSuccess: (next) => applyGroup(next),
    onError: (err) => {
      Alert.alert('Lỗi', toUserMessage(err, 'Không thể đổi cài đặt duyệt thành viên'));
    },
  });
  const requireApproval = approvalMutation.isPending
    ? !!approvalMutation.variables
    : !!groupQ.data?.require_approval;

  const mutation = useMutation({
    // Hợp đồng update_group: NULL = giữ nguyên → chỉ gửi trường đã đổi
    mutationFn: () => {
      const updates: { name?: string; description?: string; simplify_debts?: boolean } = {};
      if (localName !== null && name.trim() !== (groupQ.data?.name ?? '')) updates.name = name.trim();
      if (localDescription !== null && description.trim() !== (groupQ.data?.description ?? '')) {
        updates.description = description.trim();
      }
      if (localSimplifyDebts !== null && localSimplifyDebts !== isSimplifyEnabled(groupQ.data?.simplify_debts)) {
        updates.simplify_debts = localSimplifyDebts;
      }
      if (Object.keys(updates).length === 0) return Promise.resolve(null);
      return updateGroup(id, updates);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['group', id] });
      queryClient.invalidateQueries({ queryKey: ['groups'] });
      Alert.alert('Thành công', 'Đã cập nhật nhóm');
      router.back();
    },
    onError: (err: any) => {
      Alert.alert('Lỗi', toUserMessage(err, 'Không thể cập nhật nhóm'));
    },
  });

  if (groupQ.isLoading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color="#007AFF" />
      </View>
    );
  }

  return (
    <SafeAreaView style={styles.container} edges={['bottom']}>
      <ScrollView contentContainerStyle={styles.content}>
        {/* MVP-03: ảnh nhóm */}
        <Pressable style={styles.imageRow} onPress={pickImage} disabled={imageBusy}>
          {imageBusy ? (
            <View style={styles.imageBusy}>
              <ActivityIndicator color="#fff" />
            </View>
          ) : (
            <Avatar name={groupQ.data?.name} path={groupQ.data?.avatar_path} seed={id} size={88} />
          )}
          <Text style={styles.imageHint}>{imageBusy ? 'Đang xử lý...' : 'Đổi ảnh nhóm'}</Text>
        </Pressable>

        <View style={styles.card}>
          <Text style={styles.label}>Tên nhóm</Text>
          <TextInput
            style={styles.input}
            value={name}
            onChangeText={setName}
            placeholder="Nhập tên nhóm"
            placeholderTextColor="#C7C7CC"
          />

          <Text style={styles.label}>Mô tả</Text>
          <TextInput
            style={[styles.input, styles.textArea]}
            value={description}
            onChangeText={setDescription}
            placeholder="Nhập mô tả nhóm (tùy chọn)"
            placeholderTextColor="#C7C7CC"
            multiline
            numberOfLines={3}
            textAlignVertical="top"
          />

          <View style={styles.switchRow}>
            <View style={styles.switchInfo}>
              <Text style={styles.switchLabel}>Đơn giản hóa công nợ</Text>
              <Text style={styles.switchDescription}>
                Bù trừ nợ trong cả nhóm để giảm số lần chuyển tiền
              </Text>
            </View>
            <Switch
              value={simplifyDebts}
              onValueChange={setSimplifyDebts}
              trackColor={{ false: '#E5E5EA', true: '#34C759' }}
              thumbColor="#fff"
            />
          </View>

          {/* Migration 0014: duyệt thành viên mới */}
          <View style={styles.switchRow}>
            <View style={styles.switchInfo}>
              <Text style={styles.switchLabel}>Duyệt thành viên mới</Text>
              <Text style={styles.switchDescription}>
                Khi bật, người vào bằng link, mã nhóm hoặc QR phải chờ bạn duyệt. Lời mời đích danh bạn gửi thì vào
                thẳng.
              </Text>
              {!isOwner && <Text style={styles.switchDescription}>Chỉ chủ nhóm đổi được cài đặt này.</Text>}
            </View>
            <Switch
              value={requireApproval}
              onValueChange={(v) => approvalMutation.mutate(v)}
              disabled={!isOwner || approvalMutation.isPending}
              trackColor={{ false: '#E5E5EA', true: '#34C759' }}
              thumbColor="#fff"
            />
          </View>
        </View>

        <Pressable
          style={[styles.saveBtn, mutation.isPending && styles.saveBtnDisabled]}
          onPress={() => mutation.mutate()}
          disabled={mutation.isPending || !name.trim()}
        >
          {mutation.isPending ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={styles.saveBtnText}>Lưu</Text>
          )}
        </Pressable>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f2f2f7' },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  content: { padding: 16, gap: 16 },
  imageRow: { alignItems: 'center', gap: 8 },
  imageBusy: {
    width: 88,
    height: 88,
    borderRadius: 44,
    backgroundColor: '#8E8E93',
    justifyContent: 'center',
    alignItems: 'center',
  },
  imageHint: { fontSize: 14, color: '#007AFF', fontWeight: '500' },
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
  saveBtn: {
    backgroundColor: '#007AFF',
    borderRadius: 12,
    padding: 16,
    alignItems: 'center',
  },
  saveBtnDisabled: { opacity: 0.5 },
  saveBtnText: { color: '#fff', fontSize: 16, fontWeight: '600' },
});
