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

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { toUserMessage } from '@/api/errors';
import { useAuth } from '@/hooks/use-auth';
import { deleteAccount, listMySessions, revokeMySession, type MySession } from '@/api/auth';
import { describeUserAgent } from '@/lib/device-name';

const SESSIONS_KEY = ['my-sessions'] as const;

/** "14:05 23/10/2026" */
function formatDateTime(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())} ${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()}`;
}

export default function SecurityScreen() {
  const { changePassword, signOutAll, signOut, user } = useAuth();
  const queryClient = useQueryClient();

  // Migration 0015: các phiên đăng nhập (thiết bị) của chính mình
  const sessionsQ = useQuery({
    queryKey: SESSIONS_KEY,
    queryFn: listMySessions,
    enabled: !!user,
  });

  const revokeMutation = useMutation({
    mutationFn: (sessionId: string) => revokeMySession(sessionId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: SESSIONS_KEY }),
    onError: (err) => Alert.alert('Lỗi', toUserMessage(err, 'Không thể đăng xuất thiết bị')),
  });

  const handleRevoke = (s: MySession) => {
    Alert.alert(
      'Đăng xuất thiết bị',
      `Đăng xuất ${describeUserAgent(s.user_agent)}? Thiết bị đó sẽ phải đăng nhập lại (có thể mất tới 1 giờ để bị thoát hẳn).`,
      [
        { text: 'Hủy', style: 'cancel' },
        { text: 'Đăng xuất', style: 'destructive', onPress: () => revokeMutation.mutate(s.id) },
      ],
    );
  };

  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [changingPassword, setChangingPassword] = useState(false);
  const [deletingAccount, setDeletingAccount] = useState(false);

  const handleChangePassword = async () => {
    if (!newPassword || !confirmPassword) {
      Alert.alert('Lỗi', 'Vui lòng nhập đầy đủ mật khẩu');
      return;
    }
    if (newPassword !== confirmPassword) {
      Alert.alert('Lỗi', 'Mật khẩu xác nhận không khớp');
      return;
    }
    if (newPassword.length < 6) {
      Alert.alert('Lỗi', 'Mật khẩu phải có ít nhất 6 ký tự');
      return;
    }

    setChangingPassword(true);
    try {
      await changePassword(newPassword);
      Alert.alert('Thành công', 'Đã đổi mật khẩu');
      setNewPassword('');
      setConfirmPassword('');
    } catch (err: any) {
      Alert.alert('Lỗi', toUserMessage(err, 'Có lỗi xảy ra'));
    } finally {
      setChangingPassword(false);
    }
  };

  const handleSignOutAll = () => {
    Alert.alert(
      'Đăng xuất khỏi mọi thiết bị',
      'Bạn sẽ bị đăng xuất khỏi tất cả các thiết bị, bao gồm thiết bị này.',
      [
        { text: 'Hủy', style: 'cancel' },
        {
          text: 'Đăng xuất tất cả',
          style: 'destructive',
          onPress: async () => {
            try {
              await signOutAll();
            } catch (err: any) {
              Alert.alert('Lỗi', toUserMessage(err, 'Có lỗi xảy ra'));
            }
          },
        },
      ]
    );
  };

  const handleDeleteAccount = () => {
    Alert.alert(
      'Xóa tài khoản',
      // APP-21: theo spec — tài khoản được ẩn danh, lịch sử nhóm vẫn giữ để số dư của người khác đúng
      'Bạn có chắc chắn muốn xóa tài khoản? Bạn sẽ không đăng nhập được nữa và hồ sơ (tên, ảnh, mã người dùng) sẽ được ẩn danh. ' +
        'Các khoản chi và thanh toán đã ghi trong nhóm vẫn được giữ, hiển thị dưới tên ẩn danh. Hành động này không thể hoàn tác.',
      [
        { text: 'Hủy', style: 'cancel' },
        {
          text: 'Xóa tài khoản',
          style: 'destructive',
          onPress: async () => {
            setDeletingAccount(true);
            try {
              // APP-13: Use API layer instead of direct supabase calls
              await deleteAccount();

              Alert.alert('Đã xóa', 'Tài khoản đã được xóa và ẩn danh. Lịch sử trong nhóm vẫn được giữ.', [
                {
                  text: 'OK',
                  // REV-A10: đăng xuất lỗi (mất mạng…) phải báo người dùng, không nuốt lỗi
                  onPress: () => {
                    signOut().catch((e) => Alert.alert('Lỗi', toUserMessage(e, 'Không thể đăng xuất')));
                  },
                },
              ]);
            } catch (err: any) {
              Alert.alert('Lỗi', toUserMessage(err, 'Có lỗi xảy ra'));
            } finally {
              setDeletingAccount(false);
            }
          },
        },
      ]
    );
  };

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.contentContainer}>
      {/* Đổi mật khẩu */}
      <View style={styles.card}>
        <Text style={styles.sectionTitle}>Đổi mật khẩu</Text>
        <View style={styles.formGroup}>
          <TextInput
            style={styles.input}
            placeholder="Mật khẩu mới"
            placeholderTextColor="#999"
            value={newPassword}
            onChangeText={setNewPassword}
            secureTextEntry
            autoComplete="new-password"
          />
          <TextInput
            style={styles.input}
            placeholder="Xác nhận mật khẩu mới"
            placeholderTextColor="#999"
            value={confirmPassword}
            onChangeText={setConfirmPassword}
            secureTextEntry
            autoComplete="new-password"
          />
          <Pressable
            style={[styles.button, changingPassword && styles.buttonDisabled]}
            onPress={handleChangePassword}
            disabled={changingPassword}
          >
            {changingPassword ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text style={styles.buttonText}>Đổi mật khẩu</Text>
            )}
          </Pressable>
        </View>
      </View>

      {/* Thiết bị đang đăng nhập (migration 0015) */}
      <View style={styles.card}>
        <Text style={styles.sectionTitle}>Thiết bị đang đăng nhập</Text>
        <Text style={styles.sectionDescription}>
          Nếu thấy thiết bị lạ, hãy đăng xuất thiết bị đó và đổi mật khẩu.
        </Text>

        {sessionsQ.isLoading ? (
          <ActivityIndicator style={styles.sessionsLoading} color="#007AFF" />
        ) : sessionsQ.error ? (
          <Pressable onPress={() => sessionsQ.refetch()}>
            <Text style={styles.sessionsError}>
              {toUserMessage(sessionsQ.error, 'Không tải được danh sách thiết bị')} · Thử lại
            </Text>
          </Pressable>
        ) : (
          <View style={styles.sessionList}>
            {(sessionsQ.data ?? []).map((s) => (
              <View key={s.id} style={styles.sessionRow}>
                <View style={styles.sessionInfo}>
                  <Text style={styles.sessionName}>
                    {describeUserAgent(s.user_agent)}
                    {s.is_current ? <Text style={styles.currentBadge}>  · Thiết bị này</Text> : null}
                  </Text>
                  <Text style={styles.sessionMeta}>
                    Hoạt động lúc {formatDateTime(s.last_active_at)}
                    {s.ip ? ` · IP ${s.ip}` : ''}
                  </Text>
                  <Text style={styles.sessionMeta}>Đăng nhập lúc {formatDateTime(s.created_at)}</Text>
                </View>
                {!s.is_current && (
                  <Pressable
                    style={[styles.sessionButton, revokeMutation.isPending && styles.buttonDisabled]}
                    onPress={() => handleRevoke(s)}
                    disabled={revokeMutation.isPending}
                  >
                    <Text style={styles.sessionButtonText}>Đăng xuất</Text>
                  </Pressable>
                )}
              </View>
            ))}
          </View>
        )}

        <Pressable style={styles.outlineButton} onPress={handleSignOutAll}>
          <Text style={styles.outlineButtonText}>Đăng xuất tất cả thiết bị</Text>
        </Pressable>
      </View>

      {/* Xóa tài khoản */}
      <View style={styles.card}>
        <Text style={styles.sectionTitle}>Xóa tài khoản</Text>
        <Text style={styles.sectionDescription}>
          Xóa tài khoản và ẩn danh hồ sơ của bạn. Khoản chi, thanh toán đã ghi trong nhóm vẫn được giữ dưới tên ẩn danh để công nợ của người khác không bị sai. Hành động này không thể hoàn tác.
        </Text>
        <Pressable
          style={[styles.destructiveButton, deletingAccount && styles.buttonDisabled]}
          onPress={handleDeleteAccount}
          disabled={deletingAccount}
        >
          {deletingAccount ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={styles.destructiveButtonText}>Xóa tài khoản</Text>
          )}
        </Pressable>
      </View>
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
  sectionTitle: {
    fontSize: 18,
    fontWeight: '600',
    color: '#1a1a1a',
    marginBottom: 8,
  },
  sectionDescription: {
    fontSize: 14,
    color: '#666',
    marginBottom: 16,
    lineHeight: 20,
  },
  formGroup: {
    gap: 12,
    marginTop: 8,
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
  button: {
    backgroundColor: '#007AFF',
    borderRadius: 12,
    padding: 16,
    alignItems: 'center',
    marginTop: 4,
  },
  buttonDisabled: {
    opacity: 0.6,
  },
  buttonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  outlineButton: {
    borderWidth: 1,
    borderColor: '#007AFF',
    borderRadius: 12,
    padding: 16,
    alignItems: 'center',
  },
  outlineButtonText: {
    color: '#007AFF',
    fontSize: 16,
    fontWeight: '600',
  },
  sessionsLoading: {
    marginVertical: 16,
  },
  sessionsError: {
    color: '#FF3B30',
    fontSize: 14,
    marginBottom: 16,
  },
  sessionList: {
    marginBottom: 16,
  },
  sessionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#e5e5ea',
    gap: 12,
  },
  sessionInfo: {
    flex: 1,
    gap: 2,
  },
  sessionName: {
    fontSize: 15,
    fontWeight: '600',
    color: '#1a1a1a',
  },
  currentBadge: {
    fontSize: 13,
    fontWeight: '600',
    color: '#34C759',
  },
  sessionMeta: {
    fontSize: 13,
    color: '#666',
  },
  sessionButton: {
    borderWidth: 1,
    borderColor: '#FF3B30',
    borderRadius: 10,
    paddingVertical: 8,
    paddingHorizontal: 12,
  },
  sessionButtonText: {
    color: '#FF3B30',
    fontSize: 14,
    fontWeight: '600',
  },
  destructiveButton: {
    backgroundColor: '#FF3B30',
    borderRadius: 12,
    padding: 16,
    alignItems: 'center',
  },
  destructiveButtonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
});
