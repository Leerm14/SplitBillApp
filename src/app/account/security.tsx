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

import { useAuth } from '@/hooks/use-auth';
import { deleteAccount } from '@/api/auth';

export default function SecurityScreen() {
  const { changePassword, signOutAll, signOut } = useAuth();

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
      Alert.alert('Lỗi', err.message || 'Có lỗi xảy ra');
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
              Alert.alert('Lỗi', err.message || 'Có lỗi xảy ra');
            }
          },
        },
      ]
    );
  };

  const handleDeleteAccount = () => {
    Alert.alert(
      'Xóa tài khoản',
      'Bạn có chắc chắn muốn xóa tài khoản? Hành động này không thể hoàn tác. Tất cả dữ liệu của bạn sẽ bị xóa vĩnh viễn.',
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

              Alert.alert('Đã xóa', 'Tài khoản đã được xóa thành công.', [
                {
                  text: 'OK',
                  onPress: () => signOut(),
                },
              ]);
            } catch (err: any) {
              Alert.alert('Lỗi', err.message || 'Có lỗi xảy ra');
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

      {/* Đăng xuất khỏi mọi thiết bị */}
      <View style={styles.card}>
        <Text style={styles.sectionTitle}>Đăng xuất khỏi mọi thiết bị</Text>
        <Text style={styles.sectionDescription}>
          Đăng xuất tài khoản khỏi tất cả các thiết bị đang đăng nhập.
        </Text>
        <Pressable style={styles.outlineButton} onPress={handleSignOutAll}>
          <Text style={styles.outlineButtonText}>Đăng xuất tất cả thiết bị</Text>
        </Pressable>
      </View>

      {/* Xóa tài khoản */}
      <View style={styles.card}>
        <Text style={styles.sectionTitle}>Xóa tài khoản</Text>
        <Text style={styles.sectionDescription}>
          Xóa vĩnh viễn tài khoản và tất cả dữ liệu liên quan. Hành động này không thể hoàn tác.
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
