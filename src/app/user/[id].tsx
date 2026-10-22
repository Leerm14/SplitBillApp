import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
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
  fetchFriends,
  fetchPendingRequests,
  fetchPaymentHandles,
  sendFriendRequest,
  unfriend,
} from '@/api/contacts';
import { toUserMessage } from '@/api/errors';
import { fetchUserProfile } from '@/api/profiles';
import { useAuth } from '@/hooks/use-auth';

export default function UserProfileScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const queryClient = useQueryClient();
  // APP-13: Use useAuth instead of direct supabase.auth.getUser()
  const { user } = useAuth();
  const currentUserId = user?.id ?? null;

  // APP-13: Fetch user profile through API layer
  const { data: userProfile, isLoading: profileLoading } = useQuery({
    queryKey: ['userProfile', id],
    queryFn: () => fetchUserProfile(id),
    enabled: !!id,
  });

  // Fetch friends to check friendship status
  const { data: friends } = useQuery({
    queryKey: ['friends'],
    queryFn: fetchFriends,
  });

  // Fetch pending requests
  const { data: pendingRequests } = useQuery({
    queryKey: ['pendingRequests'],
    queryFn: fetchPendingRequests,
  });

  // Fetch payment handles (only if friends)
  const isFriend = React.useMemo(() => {
    if (!friends || !currentUserId) return false;
    return friends.some(
      (f: any) =>
        (f.requester_id === id && f.addressee_id === currentUserId) ||
        (f.addressee_id === id && f.requester_id === currentUserId)
    );
  }, [friends, currentUserId, id]);

  const isPending = React.useMemo(() => {
    if (!pendingRequests) return false;
    return pendingRequests.some((r: any) => r.requester_id === id);
  }, [pendingRequests, id]);


  const { data: paymentHandles } = useQuery({
    queryKey: ['paymentHandles', id],
    queryFn: () => fetchPaymentHandles(id),
    enabled: isFriend,
  });

  const sendRequestMutation = useMutation({
    mutationFn: () => sendFriendRequest(id!),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['friends'] });
      queryClient.invalidateQueries({ queryKey: ['pendingRequests'] });
      Alert.alert('Thành công', 'Đã gửi lời mời kết bạn');
    },
    onError: (err: any) => {
      Alert.alert('Lỗi', toUserMessage(err, 'Không thể gửi lời mời'));
    },
  });

  const unfriendMutation = useMutation({
    mutationFn: () => unfriend(id!),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['friends'] });
      queryClient.invalidateQueries({ queryKey: ['pendingRequests'] });
      Alert.alert('Thành công', 'Đã hủy kết bạn');
    },
    onError: (err: any) => {
      Alert.alert('Lỗi', toUserMessage(err, 'Không thể hủy kết bạn'));
    },
  });

  const handleUnfriend = () => {
    Alert.alert('Hủy kết bạn', `Bạn có chắc muốn hủy kết bạn với ${userProfile?.display_name}?`, [
      { text: 'Hủy', style: 'cancel' },
      {
        text: 'Xác nhận',
        style: 'destructive',
        onPress: () => unfriendMutation.mutate(),
      },
    ]);
  };

  if (profileLoading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color="#007AFF" />
      </View>
    );
  }

  if (!userProfile) {
    return (
      <View style={styles.center}>
        <Text style={styles.errorText}>Không tìm thấy người dùng</Text>
      </View>
    );
  }

  const isOwnProfile = currentUserId === id;

  return (
    <SafeAreaView style={styles.container} edges={['bottom']}>
      <ScrollView contentContainerStyle={styles.content}>
        {/* Profile card */}
        <View style={styles.profileCard}>
          <View style={styles.avatar}>
            <Text style={styles.avatarText}>
              {(userProfile.display_name || '?')[0].toUpperCase()}
            </Text>
          </View>
          <Text style={styles.displayName}>{userProfile.display_name}</Text>
          <Text style={styles.userCode}>Mã: {userProfile.user_code}</Text>
        </View>

        {/* Friendship action */}
        {!isOwnProfile && (
          <View style={styles.actionSection}>
            {isFriend ? (
              <Pressable style={styles.unfriendBtn} onPress={handleUnfriend}>
                <Text style={styles.unfriendBtnText}>Hủy kết bạn</Text>
              </Pressable>
            ) : isPending ? (
              <View style={styles.pendingBadge}>
                <Text style={styles.pendingBadgeText}>Đang chờ phản hồi</Text>
              </View>
            ) : (
              <Pressable
                style={styles.addFriendBtn}
                onPress={() => sendRequestMutation.mutate()}
                disabled={sendRequestMutation.isPending}
              >
                {sendRequestMutation.isPending ? (
                  <ActivityIndicator size="small" color="#fff" />
                ) : (
                  <Text style={styles.addFriendBtnText}>Thêm bạn bè</Text>
                )}
              </Pressable>
            )}
          </View>
        )}

        {/* Payment handles (only if friends) */}
        {isFriend && (paymentHandles ?? []).length > 0 && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Thông tin thanh toán</Text>
            {paymentHandles!.map((handle: any) => (
              <View key={handle.id} style={styles.handleCard}>
                <Text style={styles.handleType}>{handle.type}</Text>
                <Text style={styles.handleValue}>{handle.display_text}</Text>
              </View>
            ))}
          </View>
        )}

        {/* Invite to group */}
        {isFriend && (
          <Pressable
            style={styles.inviteBtn}
            onPress={() => router.push('/(tabs)/groups' as any)}
          >
            <Text style={styles.inviteBtnText}>Mời vào nhóm</Text>
          </Pressable>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f2f2f7' },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  content: { padding: 16, gap: 16 },
  errorText: { fontSize: 16, color: '#666' },

  // Profile card
  profileCard: {
    backgroundColor: '#fff',
    borderRadius: 16,
    padding: 24,
    alignItems: 'center',
    gap: 8,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 4,
    elevation: 2,
  },
  avatar: {
    width: 80,
    height: 80,
    borderRadius: 40,
    backgroundColor: '#007AFF',
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 8,
  },
  avatarText: { fontSize: 36, fontWeight: '700', color: '#fff' },
  displayName: { fontSize: 24, fontWeight: '700', color: '#1a1a1a' },
  userCode: { fontSize: 15, color: '#8E8E93' },

  // Actions
  actionSection: { gap: 12 },
  addFriendBtn: {
    backgroundColor: '#007AFF',
    borderRadius: 12,
    padding: 16,
    alignItems: 'center',
  },
  addFriendBtnText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  pendingBadge: {
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 16,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#E5E5EA',
  },
  pendingBadgeText: { color: '#8E8E93', fontSize: 16, fontWeight: '500' },
  unfriendBtn: {
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 16,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#FF3B30',
  },
  unfriendBtnText: { color: '#FF3B30', fontSize: 16, fontWeight: '600' },

  // Payment handles
  section: {
    gap: 8,
  },
  sectionTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: '#1a1a1a',
    marginBottom: 4,
  },
  handleCard: {
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 14,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 4,
    elevation: 2,
  },
  handleType: {
    fontSize: 14,
    fontWeight: '600',
    color: '#8E8E93',
    textTransform: 'uppercase',
  },
  handleValue: { fontSize: 16, color: '#1a1a1a', fontWeight: '500' },

  // Invite
  inviteBtn: {
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 16,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#007AFF',
  },
  inviteBtnText: { color: '#007AFF', fontSize: 16, fontWeight: '600' },
});
