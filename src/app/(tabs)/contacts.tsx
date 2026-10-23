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
import { Avatar } from '@/components/avatar';
import { useAuth } from '@/hooks/use-auth';
import { Colors, Spacing, Radii, FontSizes, FontWeights, Shadows } from '@/lib/theme';

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
        <ActivityIndicator size="large" color={Colors.primary} />
      </View>
    );
  }

  const hasPending = (pendingRequests ?? []).length > 0;

  return (
    <SafeAreaView style={styles.container} edges={['bottom']}>
      {/* Search bar */}
      <View style={styles.searchContainer}>
        <View style={styles.searchInputWrap}>
          <Text style={styles.searchIcon}>🔍</Text>
          <TextInput
            style={styles.searchInput}
            placeholder="Tìm bạn bè..."
            placeholderTextColor={Colors.textTertiary}
            value={search}
            onChangeText={setSearch}
          />
        </View>
      </View>

      <FlatList
        data={filteredFriends}
        keyExtractor={(item: any) => `${item.requester_id}-${item.addressee_id}`}
        contentContainerStyle={styles.list}
        refreshControl={
          <RefreshControl refreshing={isRefreshing} onRefresh={handleRefresh} tintColor={Colors.primary} />
        }
        ListHeaderComponent={
          hasPending ? (
            <View style={styles.pendingSection}>
              <View style={styles.pendingSectionHeader}>
                <View style={styles.pendingBadge}>
                  <Text style={styles.pendingBadgeText}>{pendingRequests!.length}</Text>
                </View>
                <Text style={styles.sectionTitle}>
                  Lời mời kết bạn
                </Text>
              </View>
              {pendingRequests!.map((req: any) => {
                const requester = req.requester as FriendProfile;
                return (
                  <View key={req.requester_id} style={styles.pendingCard}>
                    <View style={styles.pendingInfo}>
                      <Avatar name={requester?.display_name} path={requester?.avatar_path} seed={requester?.id} size={44} />
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
            <View style={styles.emptyIconWrap}>
              <Text style={styles.emptyIcon}>👫</Text>
            </View>
            <Text style={styles.emptyText}>Chưa có bạn bè nào</Text>
            <Text style={styles.emptyHint}>
              Nhấn nút + ở góc phải trên cùng để tìm và thêm bạn bè
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
                <Avatar name={profile.display_name} path={profile.avatar_path} seed={profile.id} size={44} />
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
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: Colors.background },
  searchContainer: {
    paddingHorizontal: Spacing.lg,
    paddingTop: Spacing.md,
    paddingBottom: Spacing.xs,
  },
  searchInputWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Colors.borderLight,
    borderRadius: Radii.md,
    borderWidth: 1,
    borderColor: Colors.border,
    paddingHorizontal: Spacing.md,
  },
  searchIcon: {
    fontSize: FontSizes.md,
    marginRight: Spacing.sm,
  },
  searchInput: {
    flex: 1,
    paddingVertical: Spacing.md,
    fontSize: FontSizes.md,
    color: Colors.text,
  },
  list: { padding: Spacing.lg, gap: Spacing.sm, paddingBottom: Spacing.lg },

  // Pending section
  pendingSection: {
    marginBottom: Spacing.lg,
    gap: Spacing.sm,
    backgroundColor: Colors.primaryLight,
    borderRadius: Radii.lg,
    padding: Spacing.lg,
  },
  pendingSectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    marginBottom: Spacing.xs,
  },
  pendingBadge: {
    backgroundColor: Colors.primary,
    borderRadius: Radii.full,
    width: 24,
    height: 24,
    justifyContent: 'center',
    alignItems: 'center',
  },
  pendingBadgeText: {
    color: Colors.textInverse,
    fontSize: FontSizes.xs,
    fontWeight: FontWeights.bold,
  },
  sectionTitle: {
    fontSize: FontSizes.md,
    fontWeight: FontWeights.bold,
    color: Colors.primaryDark,
  },
  pendingCard: {
    backgroundColor: Colors.surface,
    borderRadius: Radii.md,
    padding: Spacing.lg,
    gap: Spacing.md,
    ...Shadows.sm,
  },
  pendingInfo: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
  },
  pendingMeta: { flex: 1 },
  pendingActions: {
    flexDirection: 'row',
    gap: Spacing.sm,
  },
  acceptBtn: {
    flex: 1,
    backgroundColor: Colors.success,
    borderRadius: Radii.sm,
    paddingVertical: Spacing.md,
    alignItems: 'center',
    minHeight: 44,
    justifyContent: 'center',
  },
  acceptBtnText: {
    color: Colors.textInverse,
    fontSize: FontSizes.sm,
    fontWeight: FontWeights.semibold,
  },
  declineBtn: {
    flex: 1,
    backgroundColor: Colors.surface,
    borderRadius: Radii.sm,
    paddingVertical: Spacing.md,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: Colors.border,
    minHeight: 44,
    justifyContent: 'center',
  },
  declineBtnText: {
    color: Colors.textSecondary,
    fontSize: FontSizes.sm,
    fontWeight: FontWeights.semibold,
  },

  // Friend card
  friendCard: {
    backgroundColor: Colors.surface,
    borderRadius: Radii.lg,
    padding: Spacing.lg,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    ...Shadows.sm,
  },
  friendRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    flex: 1,
  },
  friendMeta: { flex: 1 },
  friendName: {
    fontSize: FontSizes.md,
    fontWeight: FontWeights.semibold,
    color: Colors.text,
  },
  friendCode: {
    fontSize: FontSizes.sm,
    color: Colors.textSecondary,
    marginTop: 2,
  },
  arrow: { fontSize: 22, color: Colors.textTertiary, fontWeight: FontWeights.regular },

  // Empty
  empty: {
    alignItems: 'center',
    paddingTop: 60,
    paddingHorizontal: Spacing.xxxl,
  },
  emptyIconWrap: {
    width: 80,
    height: 80,
    borderRadius: Radii.full,
    backgroundColor: Colors.primaryLight,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: Spacing.lg,
  },
  emptyIcon: { fontSize: 36 },
  emptyText: {
    fontSize: FontSizes.lg,
    fontWeight: FontWeights.semibold,
    color: Colors.text,
    textAlign: 'center',
  },
  emptyHint: {
    fontSize: FontSizes.sm,
    color: Colors.textTertiary,
    marginTop: Spacing.sm,
    textAlign: 'center',
    lineHeight: 20,
  },
});
