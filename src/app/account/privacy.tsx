import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import React, { useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { toUserMessage } from '@/api/errors';
import { fetchProfile, updateProfile } from '@/api/profiles';

export default function PrivacyScreen() {
  const queryClient = useQueryClient();

  const { data: profile, isLoading } = useQuery({
    queryKey: ['profile'],
    queryFn: fetchProfile,
  });

  // APP-15: Derive searchable from profile data; local override khi user toggle
  const [localSearchable, setLocalSearchable] = useState<boolean | null>(null);
  // Dùng giá trị local nếu user đã toggle, ngược lại dùng giá trị từ server
  const searchable = localSearchable ?? profile?.searchable ?? true;
  const setSearchable = setLocalSearchable;

  const updateMutation = useMutation({
    mutationFn: (value: boolean) => updateProfile({ searchable: value }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['profile'] });
      Alert.alert('Thành công', 'Đã cập nhật cài đặt quyền riêng tư');
    },
    onError: (err: any) => {
      // Revert on error — reset local override so server value is used
      setLocalSearchable(null);
      Alert.alert('Lỗi', toUserMessage(err, 'Không thể cập nhật'));
    },
  });

  const handleToggle = (value: boolean) => {
    setSearchable(value);
    updateMutation.mutate(value);
  };

  if (isLoading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color="#007AFF" />
      </View>
    );
  }

  return (
    <SafeAreaView style={styles.container} edges={['bottom']}>
      <ScrollView contentContainerStyle={styles.content}>
        {/* Searchable toggle */}
        <View style={styles.card}>
          <View style={styles.settingRow}>
            <View style={styles.settingInfo}>
              <Text style={styles.settingTitle}>Hiển thị trong tìm kiếm</Text>
              <Text style={styles.settingDesc}>
                Cho phép người dùng khác tìm thấy bạn qua tên hoặc mã người dùng
              </Text>
            </View>
            <Switch
              value={searchable ?? true}
              onValueChange={handleToggle}
              trackColor={{ false: '#E5E5EA', true: '#34C759' }}
              thumbColor="#fff"
              disabled={updateMutation.isPending}
            />
          </View>
        </View>

        {/* User code (read-only) */}
        <View style={styles.card}>
          <Text style={styles.fieldLabel}>Mã người dùng</Text>
          <View style={styles.codeRow}>
            <Text style={styles.codeValue}>
              {profile?.user_code || '---'}
            </Text>
          </View>
          <Text style={styles.fieldHint}>
            Mã người dùng không thể thay đổi. Chia sẻ mã này để bạn bè thêm bạn.
          </Text>
        </View>
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
    padding: 20,
    gap: 12,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 4,
    elevation: 2,
  },
  settingRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 16,
  },
  settingInfo: { flex: 1 },
  settingTitle: { fontSize: 16, fontWeight: '600', color: '#1a1a1a' },
  settingDesc: { fontSize: 13, color: '#8E8E93', marginTop: 4, lineHeight: 18 },

  fieldLabel: {
    fontSize: 14,
    fontWeight: '600',
    color: '#8E8E93',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  codeRow: {
    backgroundColor: '#f2f2f7',
    borderRadius: 10,
    padding: 14,
  },
  codeValue: {
    fontSize: 20,
    fontWeight: '700',
    color: '#1a1a1a',
    letterSpacing: 2,
  },
  fieldHint: {
    fontSize: 13,
    color: '#8E8E93',
    lineHeight: 18,
  },
});
