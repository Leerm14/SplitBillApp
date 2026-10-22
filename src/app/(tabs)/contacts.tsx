import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import React, { useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { toUserMessage } from '@/api/errors';
import { fetchFriends, fetchPendingRequests, respondFriendRequest } from '@/api/contacts';
import { useAuth } from '@/hooks/use-auth';

type FriendProfile = {
  id: string;
  display_name: string;
  user_code: string;
  avatar_path: string | null;
};

export default function ContactsScreen() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  // APP-13: Use useAuth instead of direct supabase.auth.getUser()
  const { user } = useAuth();
  const currentUserId = user?.id ?? null;

  const {
    data: friends,
    isLoading: friendsLoading,
    refetch: refetchFriends,
    isRefetching: friendsRefetching,
  } = useQuery({
    queryKey: ['friends'],
    queryFn: fetchFriends,
  });

  const {
    data: pendingRequests,
    isLoading: pendingLoading,
    refetch: refetchPending,
    isRefetching: pendingRefetching,
  } = useQuery({
    queryKey: ['pendingRequests'],
    queryFn: fetchPendingRequests,
  });

  const respondMutation = useMutation({
    mutationFn: ({ requesterId, accept }: { requesterId: string; accept: boolean }) =>
      respondFriendRequest(requesterId, accept),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['friends'] });
      queryClient.invalidateQueries({ queryKey: ['pendingRequests'] });
    },
    onError: (err: any) => {
      Alert.alert('Lỗi', toUserMessage(err, 'Không thể xử lý yêu cầu'));
    },
  });

  const handleRefresh = () => {
    refetchFriends();
    refetchPending();
  };

  // Extract friend profile from friendship record
  const getFriendProfile = (friendship: any): FriendProfile | null => {
    if (!currentUserId) return null;
    if (friendship.requester_id === currentUserId) {
      return friendship.addressee as FriendProfile;
    }
    return friendship.requester as FriendProfile;
  };

  // Filter friends by search
  const filteredFriends = (friends ?? []).filter((f: any) => {
    if (!search.trim()) return true;
    const profile = getFriendProfile(f);
    if (!profile) return false;
    const q = search.toLowerCase();
    return (
      profile.display_name?.toLowerCase().includes(q) ||
      profile.user_code?.toLowerCase().includes(q)
    );
  });

  const isLoading = friendsLoading || pendingLoading;
  const isRefreshing = friendsRefetching || pendingRefetching;

  if (isLoading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color="#007AFF" />
      </View>
    );
  }

  const hasPending = (pendingRequests ?? []).length > 0;

  return (
    <SafeAreaView style={styles.container} edges={['bottom']}>
      {/* Search bar */}
      <View style={styles.searchContainer}>
        <TextInput
          style={styles.searchInput}
          placeholder="Tìm bạn bè..."
          placeholderTextColor="#999"
          value={search}
          onChangeText={setSearch}
        />
      </View>

      <FlatList
        data={filteredFriends}
        keyExtractor={(item: any) => `${item.requester_id}-${item.addressee_id}`}
        contentContainerStyle={styles.list}
        refreshControl={
          <RefreshControl refreshing={isRefreshing} onRefresh={handleRefresh} />
        }
        ListHeaderComponent={
          hasPending ? (
            <View style={styles.pendingSection}>
              <Text style={styles.sectionTitle}>
                Lời mời kết bạn ({pendingRequests!.length})
              </Text>
              {pendingRequests!.map((req: any) => {
                const requester = req.requester as FriendProfile;
                return (
                  <View key={req.requester_id} style={styles.pendingCard}>
                    <View style={styles.pendingInfo}>
                      <View style={styles.avatar}>
                        <Text style={styles.avatarText}>
                          {(requester?.display_name || '?')[0].toUpperCase()}
                        </Text>
                      </View>
                      <View style={styles.pendingMeta}>
                        <Text style={styles.friendName}>
                          {requester?.display_name || 'Người dùng'}
                        </Text>
                        <Text style={styles.friendCode}>
                          {requester?.user_code || ''}
                        </Text>
                      </View>
                    </View>
                    <View style={styles.pendingActions}>
                      <Pressable
                        style={styles.acceptBtn}
                        onPress={() =>
                          respondMutation.mutate({
                            requesterId: req.requester_id,
                            accept: true,
                          })
                        }
                      >
                        <Text style={styles.acceptBtnText}>Chấp nhận</Text>
                      </Pressable>
                      <Pressable
                        style={styles.declineBtn}
                        onPress={() =>
                          respondMutation.mutate({
                            requesterId: req.requester_id,
                            accept: false,
                          })
                        }
                      >
                        <Text style={styles.declineBtnText}>Từ chối</Text>
                      </Pressable>
                    </View>
                  </View>
                );
              })}
            </View>
          ) : undefined
        }
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={styles.emptyIcon}>👫</Text>
            <Text style={styles.emptyText}>Chưa có bạn bè nào</Text>
            <Text style={styles.emptyHint}>
              Nhấn nút + để tìm và thêm bạn bè
            </Text>
          </View>
        }
        renderItem={({ item }) => {
          const profile = getFriendProfile(item);
          if (!profile) return null;
          return (
            <Pressable
              style={styles.friendCard}
              onPress={() => router.push(`/user/${profile.id}` as any)}
            >
              <View style={styles.friendRow}>
                <View style={styles.avatar}>
                  <Text style={styles.avatarText}>
                    {(profile.display_name || '?')[0].toUpperCase()}
                  </Text>
                </View>
                <View style={styles.friendMeta}>
                  <Text style={styles.friendName}>{profile.display_name}</Text>
                  <Text style={styles.friendCode}>{profile.user_code}</Text>
                </View>
              </View>
              <Text style={styles.arrow}>›</Text>
            </Pressable>
          );
        }}
      />

      {/* FAB */}
      <Pressable
        style={styles.fab}
        onPress={() => router.push('/contacts/add' as any)}
      >
        <Text style={styles.fabText}>+</Text>
      </Pressable>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f2f2f7' },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  searchContainer: {
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 4,
  },
  searchInput: {
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 14,
    fontSize: 16,
    color: '#1a1a1a',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 4,
    elevation: 2,
  },
  list: { padding: 16, gap: 8, paddingBottom: 80 },

  // Pending section
  pendingSection: {
    marginBottom: 16,
    gap: 8,
  },
  sectionTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: '#1a1a1a',
    marginBottom: 4,
  },
  pendingCard: {
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 14,
    gap: 12,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 4,
    elevation: 2,
  },
  pendingInfo: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  pendingMeta: { flex: 1 },
  pendingActions: {
    flexDirection: 'row',
    gap: 8,
  },
  acceptBtn: {
    flex: 1,
    backgroundColor: '#34C759',
    borderRadius: 10,
    paddingVertical: 10,
    alignItems: 'center',
  },
  acceptBtnText: { color: '#fff', fontSize: 14, fontWeight: '600' },
  declineBtn: {
    flex: 1,
    backgroundColor: '#f2f2f7',
    borderRadius: 10,
    paddingVertical: 10,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#E5E5EA',
  },
  declineBtnText: { color: '#666', fontSize: 14, fontWeight: '600' },

  // Friend card
  friendCard: {
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
  friendRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    flex: 1,
  },
  avatar: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: '#007AFF',
    justifyContent: 'center',
    alignItems: 'center',
  },
  avatarText: { fontSize: 18, fontWeight: '700', color: '#fff' },
  friendMeta: { flex: 1 },
  friendName: { fontSize: 16, fontWeight: '600', color: '#1a1a1a' },
  friendCode: { fontSize: 13, color: '#8E8E93', marginTop: 2 },
  arrow: { fontSize: 22, color: '#C7C7CC', fontWeight: '300' },

  // Empty
  empty: { alignItems: 'center', paddingTop: 40 },
  emptyIcon: { fontSize: 48, marginBottom: 12 },
  emptyText: { fontSize: 16, color: '#666' },
  emptyHint: { fontSize: 14, color: '#999', marginTop: 4 },

  // FAB
  fab: {
    position: 'absolute',
    bottom: 24,
    right: 20,
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: '#007AFF',
    justifyContent: 'center',
    alignItems: 'center',
    shadowColor: '#007AFF',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 6,
  },
  fabText: { fontSize: 28, color: '#fff', fontWeight: '400', marginTop: -2 },
});
