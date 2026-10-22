import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocalSearchParams } from 'expo-router';
import React from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { createInvite, fetchGroup, fetchInvites, revokeInvite } from '@/api/groups';

export default function InviteScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const queryClient = useQueryClient();

  const groupQ = useQuery({
    queryKey: ['group', id],
    queryFn: () => fetchGroup(id),
  });

  const invitesQ = useQuery({
    queryKey: ['group-invites', id],
    queryFn: () => fetchInvites(id),
  });

  const createMutation = useMutation({
    mutationFn: () => createInvite(id),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['group-invites', id] });
      const token = typeof data === 'string' ? data : data?.token;
      if (token) {
        Alert.alert('Liên kết mời', `splitbillapp://join/${token}`);
      }
    },
    onError: (err: any) => {
      Alert.alert('Lỗi', err.message || 'Không thể tạo liên kết mời');
    },
  });

  const revokeMutation = useMutation({
    mutationFn: (inviteId: string) => revokeInvite(inviteId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['group-invites', id] });
      Alert.alert('Thành công', 'Đã thu hồi lời mời');
    },
    onError: (err: any) => {
      Alert.alert('Lỗi', err.message || 'Không thể thu hồi lời mời');
    },
  });

  const handleShareInviteCode = async () => {
    if (!groupQ.data) return;
    try {
      await Share.share({
        message: `Tham gia nhóm "${groupQ.data.name}" trên Split Bill!\nMã mời: ${groupQ.data.invite_code}`,
      });
    } catch {}
  };

  const handleShareInviteLink = async (token: string) => {
    try {
      await Share.share({
        message: `Tham gia nhóm "${groupQ.data?.name}" trên Split Bill!\nsplitbillapp://join/${token}`,
      });
    } catch {}
  };

  const handleRevokeInvite = (inviteId: string) => {
    Alert.alert('Thu hồi lời mời', 'Bạn có chắc muốn thu hồi lời mời này?', [
      { text: 'Hủy', style: 'cancel' },
      { text: 'Thu hồi', style: 'destructive', onPress: () => revokeMutation.mutate(inviteId) },
    ]);
  };

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
        {/* Invite code */}
        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Mã mời nhóm</Text>
          <Text style={styles.inviteCode}>{groupQ.data?.invite_code}</Text>
          <Pressable style={styles.shareBtn} onPress={handleShareInviteCode}>
            <Text style={styles.shareBtnText}>📋 Chia sẻ mã mời</Text>
          </Pressable>
        </View>

        {/* Create invite link */}
        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Tạo liên kết mời</Text>
          <Text style={styles.description}>
            Tạo liên kết mời riêng để chia sẻ với bạn bè. Liên kết có hiệu lực trong 72 giờ.
          </Text>
          <Pressable
            style={[styles.createBtn, createMutation.isPending && styles.createBtnDisabled]}
            onPress={() => createMutation.mutate()}
            disabled={createMutation.isPending}
          >
            {createMutation.isPending ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text style={styles.createBtnText}>+ Tạo liên kết mời</Text>
            )}
          </Pressable>
        </View>

        {/* Active invites */}
        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Lời mời đang hoạt động</Text>
          {invitesQ.isLoading ? (
            <ActivityIndicator color="#007AFF" />
          ) : (invitesQ.data || []).length === 0 ? (
            <Text style={styles.emptyText}>Chưa có lời mời nào</Text>
          ) : (
            (invitesQ.data || []).map((invite: any) => (
              <View key={invite.id} style={styles.inviteRow}>
                <View style={styles.inviteInfo}>
                  <Text style={styles.inviteToken} numberOfLines={1}>
                    splitbillapp://join/{invite.token}
                  </Text>
                  <Text style={styles.inviteMeta}>
                    Hết hạn: {new Date(invite.expires_at).toLocaleDateString('vi-VN', {
                      day: '2-digit',
                      month: '2-digit',
                      year: 'numeric',
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                    {' · '}Đã dùng: {invite.uses_count ?? 0}/{invite.max_uses ?? 1}
                  </Text>
                </View>
                <View style={styles.inviteActions}>
                  <Pressable
                    style={styles.inviteShareBtn}
                    onPress={() => handleShareInviteLink(invite.token)}
                  >
                    <Text style={styles.inviteShareBtnText}>📤</Text>
                  </Pressable>
                  <Pressable
                    style={styles.revokeBtn}
                    onPress={() => handleRevokeInvite(invite.id)}
                  >
                    <Text style={styles.revokeBtnText}>Thu hồi</Text>
                  </Pressable>
                </View>
              </View>
            ))
          )}
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
    padding: 16,
    gap: 12,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 4,
    elevation: 2,
  },
  sectionTitle: { fontSize: 17, fontWeight: '600', color: '#1a1a1a' },
  description: { fontSize: 14, color: '#8E8E93', lineHeight: 20 },
  inviteCode: {
    fontSize: 28,
    fontWeight: '700',
    color: '#007AFF',
    textAlign: 'center',
    letterSpacing: 2,
    paddingVertical: 12,
  },
  shareBtn: {
    backgroundColor: '#f2f2f7',
    borderRadius: 10,
    padding: 12,
    alignItems: 'center',
  },
  shareBtnText: { fontSize: 15, color: '#007AFF', fontWeight: '500' },
  createBtn: {
    backgroundColor: '#007AFF',
    borderRadius: 12,
    padding: 14,
    alignItems: 'center',
  },
  createBtnDisabled: { opacity: 0.5 },
  createBtnText: { color: '#fff', fontSize: 15, fontWeight: '600' },
  emptyText: { fontSize: 14, color: '#8E8E93', textAlign: 'center', paddingVertical: 12 },
  inviteRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#E5E5EA',
    gap: 8,
  },
  inviteInfo: { flex: 1 },
  inviteToken: { fontSize: 13, color: '#1a1a1a', fontFamily: 'monospace' },
  inviteMeta: { fontSize: 12, color: '#8E8E93', marginTop: 4 },
  inviteActions: { flexDirection: 'row', gap: 8, alignItems: 'center' },
  inviteShareBtn: { padding: 6 },
  inviteShareBtnText: { fontSize: 18 },
  revokeBtn: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#FF3B30',
  },
  revokeBtnText: { fontSize: 12, color: '#FF3B30', fontWeight: '500' },
});
