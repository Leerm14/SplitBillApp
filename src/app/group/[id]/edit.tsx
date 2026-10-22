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
import { fetchGroup, updateGroup } from '@/api/groups';
import { isSimplifyEnabled } from '@/domain/suggest';
import { useAuth } from '@/hooks/use-auth';

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
