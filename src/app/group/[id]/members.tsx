import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocalSearchParams, useRouter } from 'expo-router';
import React from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import {
  closeGroup,
  fetchGroup,
  fetchGroupMembers,
  isActiveMember,
  leaveGroup,
  removeMember,
  transferOwnership,
} from '@/api/groups';
import { toUserMessage } from '@/api/errors';
import { useAuth } from '@/hooks/use-auth';

const AVATAR_COLORS = ['#007AFF', '#34C759', '#FF9500', '#AF52DE', '#FF2D55', '#5AC8FA', '#FF3B30', '#5856D6'];

export default function MembersScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { user } = useAuth();
  const queryClient = useQueryClient();

  const groupQ = useQuery({
    queryKey: ['group', id],
    queryFn: () => fetchGroup(id),
  });

  const membersQ = useQuery({
    queryKey: ['group-members', id],
    queryFn: () => fetchGroupMembers(id),
  });

  const isOwner = groupQ.data?.owner_id === user?.id;

  const transferMutation = useMutation({
    mutationFn: (newOwnerId: string) => transferOwnership(id, newOwnerId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['group', id] });
      queryClient.invalidateQueries({ queryKey: ['group-members', id] });
      queryClient.invalidateQueries({ queryKey: ['groups'] });
      Alert.alert('Thành công', 'Đã chuyển quyền chủ nhóm');
    },
    onError: (err: any) => {
      Alert.alert('Lỗi', toUserMessage(err, 'Không thể chuyển quyền'));
    },
  });

  const removeMutation = useMutation({
    mutationFn: (userId: string) => removeMember(id, userId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['group-members', id] });
      queryClient.invalidateQueries({ queryKey: ['groups'] });
      Alert.alert('Thành công', 'Đã xóa thành viên khỏi nhóm');
    },
    onError: (err: any) => {
      Alert.alert('Lỗi', toUserMessage(err, 'Không thể xóa thành viên'));
    },
  });

  const leaveMutation = useMutation({
    mutationFn: () => leaveGroup(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['groups'] });
      router.replace('/(tabs)/groups' as any);
    },
    onError: (err: any) => {
      Alert.alert('Lỗi', toUserMessage(err, 'Không thể rời nhóm'));
    },
  });

  const closeMutation = useMutation({
    mutationFn: () => closeGroup(id),
    onSuccess: () => {
      // REV-S11: trạng thái CLOSED của nhóm phải hiện ngay ở màn nhóm và danh sách nhóm
      queryClient.invalidateQueries({ queryKey: ['group', id] });
      queryClient.invalidateQueries({ queryKey: ['groups'] });
      router.replace('/(tabs)/groups' as any);
    },
    onError: (err: any) => {
      Alert.alert('Lỗi', toUserMessage(err, 'Không thể đóng nhóm'));
    },
  });

  const handleMemberPress = (member: any) => {
    if (!isOwner || member.id === user?.id) return;

    Alert.alert(
      member.displayName || member.id.slice(0, 8),
      'Chọn hành động',
      [
        {
          text: 'Chuyển quyền chủ nhóm',
          onPress: () => {
            Alert.alert(
              'Chuyển quyền chủ nhóm',
              `Bạn có chắc muốn chuyển quyền chủ nhóm cho ${member.displayName || member.id.slice(0, 8)}?`,
              [
                { text: 'Hủy', style: 'cancel' },
                {
                  text: 'Chuyển quyền',
                  style: 'destructive',
                  onPress: () => transferMutation.mutate(member.id),
                },
              ],
            );
          },
        },
        {
          text: 'Xóa khỏi nhóm',
          style: 'destructive',
          onPress: () => {
            Alert.alert(
              'Xóa thành viên',
              `Bạn có chắc muốn xóa ${member.displayName || member.id.slice(0, 8)} khỏi nhóm?`,
              [
                { text: 'Hủy', style: 'cancel' },
                {
                  text: 'Xóa',
                  style: 'destructive',
                  onPress: () => removeMutation.mutate(member.id),
                },
              ],
            );
          },
        },
        { text: 'Đóng', style: 'cancel' },
      ],
    );
  };

  const handleLeave = () => {
    Alert.alert('Rời nhóm', 'Bạn có chắc muốn rời khỏi nhóm này?', [
      { text: 'Hủy', style: 'cancel' },
      { text: 'Rời nhóm', style: 'destructive', onPress: () => leaveMutation.mutate() },
    ]);
  };

  const handleClose = () => {
    Alert.alert(
      'Đóng nhóm',
      'Đóng nhóm sẽ ngăn mọi hoạt động mới. Bạn có chắc chắn?',
      [
        { text: 'Hủy', style: 'cancel' },
        { text: 'Đóng nhóm', style: 'destructive', onPress: () => closeMutation.mutate() },
      ],
    );
  };

  if (membersQ.isLoading || groupQ.isLoading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color="#007AFF" />
      </View>
    );
  }

  return (
    <SafeAreaView style={styles.container} edges={['bottom']}>
      <ScrollView contentContainerStyle={styles.content}>
        {/* Member list */}
        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Danh sách thành viên</Text>
          {/* NEW-03: Người đã rời / bị xóa không còn là thành viên */}
          {(membersQ.data || []).filter(isActiveMember).map((member: any, index: number) => {
            const name = member.displayName || member.id.slice(0, 8);
            const letter = name[0].toUpperCase();
            const color = AVATAR_COLORS[index % AVATAR_COLORS.length];
            const isMemberOwner = member.id === groupQ.data?.owner_id;

            return (
              <Pressable
                key={member.id}
                style={styles.memberRow}
                onLongPress={() => handleMemberPress(member)}
                disabled={!isOwner || member.id === user?.id}
              >
                <View style={[styles.avatar, { backgroundColor: color }]}>
                  <Text style={styles.avatarText}>{letter}</Text>
                </View>
                <View style={styles.memberInfo}>
                  <Text style={styles.memberName}>
                    {name}
                    {member.id === user?.id ? ' (bạn)' : ''}
                  </Text>
                  <Text style={styles.memberRole}>
                    {isMemberOwner ? '👑 Chủ nhóm' : 'Thành viên'}
                  </Text>
                </View>
                {isOwner && member.id !== user?.id && (
                  <Text style={styles.memberAction}>⋯</Text>
                )}
              </Pressable>
            );
          })}
        </View>

        {/* Bottom actions */}
        <View style={styles.bottomActions}>
          {!isOwner && (
            <Pressable
              style={[styles.dangerBtn, leaveMutation.isPending && styles.dangerBtnDisabled]}
              onPress={handleLeave}
              disabled={leaveMutation.isPending}
            >
              {leaveMutation.isPending ? (
                <ActivityIndicator color="#FF3B30" />
              ) : (
                <Text style={styles.dangerBtnText}>Rời nhóm</Text>
              )}
            </Pressable>
          )}
          {isOwner && (
            <Pressable
              style={[styles.dangerBtn, closeMutation.isPending && styles.dangerBtnDisabled]}
              onPress={handleClose}
              disabled={closeMutation.isPending}
            >
              {closeMutation.isPending ? (
                <ActivityIndicator color="#FF3B30" />
              ) : (
                <Text style={styles.dangerBtnText}>Đóng nhóm</Text>
              )}
            </Pressable>
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
  sectionTitle: { fontSize: 17, fontWeight: '600', color: '#1a1a1a', marginBottom: 4 },
  memberRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#E5E5EA',
    gap: 12,
  },
  avatar: {
    width: 40,
    height: 40,
    borderRadius: 20,
    justifyContent: 'center',
    alignItems: 'center',
  },
  avatarText: { fontSize: 16, fontWeight: '700', color: '#fff' },
  memberInfo: { flex: 1 },
  memberName: { fontSize: 15, fontWeight: '500', color: '#1a1a1a' },
  memberRole: { fontSize: 13, color: '#8E8E93', marginTop: 2 },
  memberAction: { fontSize: 20, color: '#8E8E93', paddingHorizontal: 4 },
  bottomActions: { gap: 12, marginTop: 8 },
  dangerBtn: {
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 16,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#FF3B30',
  },
  dangerBtnDisabled: { opacity: 0.5 },
  dangerBtnText: { color: '#FF3B30', fontSize: 16, fontWeight: '600' },
});
