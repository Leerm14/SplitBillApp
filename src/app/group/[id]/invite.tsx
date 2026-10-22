import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Modal,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import QRCode from 'react-native-qrcode-svg';

import { fetchFriends, type Friendship } from '@/api/contacts';
import { toUserMessage } from '@/api/errors';
import {
  createInvite,
  fetchGroup,
  fetchGroupMembers,
  fetchInvites,
  isActiveMember,
  rotateInviteCode,
  revokeInvite,
} from '@/api/groups';
import { Avatar } from '@/components/avatar';
import { useAuth } from '@/hooks/use-auth';
import { createAppLink } from '@/lib/app-link-url';

// APP-11: Tạo liên kết theo đúng scheme trong app.json ("splitbill"), không viết cứng
function inviteLink(token: string): string {
  return createAppLink({ kind: 'join', token });
}

// MVP-04 / H2: QR mã mời nhóm chứa liên kết app (màn quét chỉ nhận liên kết của app)
function groupCodeLink(code: string): string {
  return createAppLink({ kind: 'join-code', code });
}

export default function InviteScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const queryClient = useQueryClient();
  const router = useRouter();
  const { user } = useAuth();

  const [invitedIds, setInvitedIds] = useState<Set<string>>(new Set());
  const [qrModalToken, setQrModalToken] = useState<string | null>(null);

  const groupQ = useQuery({
    queryKey: ['group', id],
    queryFn: () => fetchGroup(id),
  });

  const invitesQ = useQuery({
    queryKey: ['group-invites', id],
    queryFn: () => fetchInvites(id),
  });

  const friendsQ = useQuery({
    queryKey: ['friends'],
    queryFn: fetchFriends,
  });

  const membersQ = useQuery({
    queryKey: ['group-members', id],
    queryFn: () => fetchGroupMembers(id),
  });

  const availableFriends = React.useMemo(() => {
    if (!friendsQ.data || !membersQ.data) return [];
    // Người đã rời / bị xóa vẫn mời lại được (lời mời đích danh) — chỉ bỏ thành viên đang ACTIVE
    const memberIds = new Set(membersQ.data.filter(isActiveMember).map((m) => m.id));
    const userId = user?.id;
    return friendsQ.data
      .map((f: Friendship) => {
        const friend = f.requester_id === userId ? f.addressee : f.requester;
        return friend;
      })
      .filter((f): f is NonNullable<typeof f> => !!f && !memberIds.has(f.id));
  }, [friendsQ.data, membersQ.data, user?.id]);

  const isOwner = !!user && groupQ.data?.owner_id === user.id;

  const createMutation = useMutation({
    mutationFn: () => createInvite(id),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['group-invites', id] });
      const token = typeof data === 'string' ? data : data?.token;
      if (token) {
        Alert.alert('Liên kết mời', inviteLink(token));
      }
    },
    onError: (err: any) => {
      Alert.alert('Lỗi', toUserMessage(err, 'Không thể tạo liên kết mời'));
    },
  });

  const revokeMutation = useMutation({
    mutationFn: (inviteId: string) => revokeInvite(inviteId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['group-invites', id] });
      Alert.alert('Thành công', 'Đã thu hồi lời mời');
    },
    onError: (err: any) => {
      Alert.alert('Lỗi', toUserMessage(err, 'Không thể thu hồi lời mời'));
    },
  });

  const inviteFriendMutation = useMutation({
    mutationFn: (friendId: string) => createInvite(id, { invitedUserId: friendId }),
    onSuccess: (_data, friendId) => {
      setInvitedIds(prev => new Set(prev).add(friendId));
      queryClient.invalidateQueries({ queryKey: ['group-invites', id] });
      Alert.alert('Thành công', 'Đã gửi lời mời. Bạn bè sẽ nhận thông báo để tham gia nhóm.');
    },
    onError: (err: any) => {
      Alert.alert('Lỗi', toUserMessage(err, 'Không thể mời'));
    },
  });

  const rotateMutation = useMutation({
    mutationFn: () => rotateInviteCode(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['group', id] });
      Alert.alert('Thành công', 'Đã đổi mã mời nhóm');
    },
    onError: (err: any) => {
      Alert.alert('Lỗi', toUserMessage(err, 'Không thể đổi mã mời'));
    },
  });

  const handleShareInviteCode = async () => {
    if (!groupQ.data) return;
    try {
      await Share.share({
        message: `Tham gia nhóm "${groupQ.data.name}" trên Split Bill!\nMã mời: ${groupQ.data.invite_code}\n${groupCodeLink(groupQ.data.invite_code)}`,
      });
    } catch {}
  };

  const handleShareInviteLink = async (token: string) => {
    try {
      await Share.share({
        message: `Tham gia nhóm "${groupQ.data?.name}" trên Split Bill!\n${inviteLink(token)}`,
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
          {groupQ.data?.invite_code && (
            <View style={styles.qrCenter}>
              <QRCode
                value={groupCodeLink(groupQ.data.invite_code)}
                size={160}
                backgroundColor="#fff"
              />
            </View>
          )}
          <Text style={styles.inviteCode}>{groupQ.data?.invite_code}</Text>
          <Pressable style={styles.shareBtn} onPress={handleShareInviteCode}>
            <Text style={styles.shareBtnText}>📋 Chia sẻ mã mời</Text>
          </Pressable>
          {/* MVP-08 / L3: chỉ chủ nhóm đổi được mã mời */}
          {isOwner && (
            <Pressable
              style={[styles.rotateBtn, rotateMutation.isPending && styles.createBtnDisabled]}
              disabled={rotateMutation.isPending}
              onPress={() => {
                Alert.alert(
                  'Đổi mã mời',
                  'Mã mời và mã QR cũ sẽ không còn dùng được. Bạn có chắc?',
                  [
                    { text: 'Hủy', style: 'cancel' },
                    { text: 'Đổi mã', style: 'destructive', onPress: () => rotateMutation.mutate() },
                  ]
                );
              }}
            >
              <Text style={styles.rotateBtnText}>🔄 Đổi mã mời</Text>
            </Pressable>
          )}
          <Pressable style={styles.scanNavBtn} onPress={() => router.push('/scan' as any)}>
            <Text style={styles.scanNavBtnText}>📷 Quét mã QR</Text>
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

        {/* Invite friends */}
        {availableFriends.length > 0 && (
          <View style={styles.card}>
            <Text style={styles.sectionTitle}>Mời bạn bè</Text>
            {availableFriends.map((friend) => (
              <View key={friend.id} style={styles.friendRow}>
                <Avatar name={friend.display_name} path={friend.avatar_path} seed={friend.id} size={36} />
                <View style={styles.friendInfo}>
                  <Text style={styles.friendName}>{friend.display_name}</Text>
                  <Text style={styles.friendCode}>{friend.user_code}</Text>
                </View>
                {invitedIds.has(friend.id) ? (
                  <View style={styles.invitedBadge}>
                    <Text style={styles.invitedText}>Đã mời</Text>
                  </View>
                ) : (
                  <Pressable
                    style={styles.inviteFriendBtn}
                    onPress={() => inviteFriendMutation.mutate(friend.id)}
                    disabled={inviteFriendMutation.isPending}
                  >
                    <Text style={styles.inviteFriendBtnText}>Mời</Text>
                  </Pressable>
                )}
              </View>
            ))}
          </View>
        )}

        {/* Active invites */}
        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Lời mời đang hoạt động</Text>
          {invitesQ.isLoading ? (
            <ActivityIndicator color="#007AFF" />
          ) : (invitesQ.data || []).length === 0 ? (
            <Text style={styles.emptyText}>Chưa có lời mời nào</Text>
          ) : (
            (invitesQ.data || []).map((invite) => (
              <View key={invite.id} style={styles.inviteRow}>
                <View style={styles.inviteInfo}>
                  <Text style={styles.inviteToken} numberOfLines={1}>
                    {inviteLink(invite.token)}
                  </Text>
                  <Text style={styles.inviteMeta}>
                    Hết hạn: {new Date(invite.expires_at).toLocaleDateString('vi-VN', {
                      day: '2-digit',
                      month: '2-digit',
                      year: 'numeric',
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                    {' · '}Đã dùng: {invite.used_count ?? 0}/{invite.max_uses ?? 1}
                  </Text>
                </View>
                <View style={styles.inviteActions}>
                  <Pressable
                    style={styles.inviteShareBtn}
                    onPress={() => setQrModalToken(invite.token)}
                  >
                    <Text style={styles.inviteShareBtnText}>🔳</Text>
                  </Pressable>
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

      {/* QR Code Modal for invite links */}
      <Modal
        visible={!!qrModalToken}
        transparent
        animationType="fade"
        onRequestClose={() => setQrModalToken(null)}
      >
        <Pressable style={styles.qrModalOverlay} onPress={() => setQrModalToken(null)}>
          <View style={styles.qrModalContent}>
            <Text style={styles.qrModalTitle}>Mã QR liên kết mời</Text>
            {qrModalToken && (
              <QRCode
                value={inviteLink(qrModalToken)}
                size={200}
                backgroundColor="#fff"
              />
            )}
            <Text style={styles.qrModalHint}>
              Bạn bè quét mã này để tham gia nhóm
            </Text>
            <Pressable style={styles.qrModalClose} onPress={() => setQrModalToken(null)}>
              <Text style={styles.qrModalCloseText}>Đóng</Text>
            </Pressable>
          </View>
        </Pressable>
      </Modal>
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
  rotateBtn: {
    backgroundColor: '#FFF3E0',
    borderRadius: 10,
    padding: 12,
    alignItems: 'center',
  },
  rotateBtnText: { fontSize: 15, color: '#FF9500', fontWeight: '500' },
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
  friendRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#E5E5EA',
    gap: 10,
  },
  friendInfo: { flex: 1 },
  friendName: { fontSize: 15, fontWeight: '500', color: '#1a1a1a' },
  friendCode: { fontSize: 12, color: '#8E8E93', marginTop: 1 },
  inviteFriendBtn: {
    backgroundColor: '#007AFF',
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 7,
  },
  inviteFriendBtnText: { color: '#fff', fontSize: 13, fontWeight: '600' },
  invitedBadge: {
    backgroundColor: '#f2f2f7',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  invitedText: { color: '#8E8E93', fontSize: 13, fontWeight: '500' },
  qrCenter: {
    alignItems: 'center',
    paddingVertical: 8,
  },
  scanNavBtn: {
    backgroundColor: '#f2f2f7',
    borderRadius: 10,
    padding: 12,
    alignItems: 'center',
  },
  scanNavBtnText: { fontSize: 15, color: '#007AFF', fontWeight: '500' },
  qrModalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  qrModalContent: {
    backgroundColor: '#fff',
    borderRadius: 20,
    padding: 28,
    alignItems: 'center',
    gap: 16,
    marginHorizontal: 32,
  },
  qrModalTitle: { fontSize: 17, fontWeight: '600', color: '#1a1a1a' },
  qrModalHint: { fontSize: 14, color: '#8E8E93', textAlign: 'center' },
  qrModalClose: {
    backgroundColor: '#f2f2f7',
    borderRadius: 10,
    paddingHorizontal: 24,
    paddingVertical: 10,
  },
  qrModalCloseText: { fontSize: 15, color: '#007AFF', fontWeight: '500' },
});
