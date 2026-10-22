import { useMutation, useQueryClient } from '@tanstack/react-query';
import React, { useState, useCallback } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { searchUsers, sendFriendRequest } from '@/api/contacts';
import { fetchProfile } from '@/api/profiles';
import { useQuery } from '@tanstack/react-query';

type SearchResult = {
  id: string;
  display_name: string;
  user_code: string;
  avatar_path: string | null;
  friendship_status: string | null; // 'ACCEPTED' | 'PENDING' | null
};

export default function AddFriendScreen() {
  const queryClient = useQueryClient();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [sentIds, setSentIds] = useState<Set<string>>(new Set());

  const { data: profile } = useQuery({
    queryKey: ['profile'],
    queryFn: fetchProfile,
  });

  const handleSearch = useCallback(async () => {
    const q = query.trim();
    if (!q) return;
    setSearching(true);
    try {
      const data = await searchUsers(q);
      setResults(data ?? []);
    } catch (err: any) {
      Alert.alert('Lỗi', err.message || 'Không thể tìm kiếm');
    } finally {
      setSearching(false);
    }
  }, [query]);

  const sendMutation = useMutation({
    mutationFn: (addresseeId: string) => sendFriendRequest(addresseeId),
    onSuccess: (_data, addresseeId) => {
      setSentIds((prev) => new Set(prev).add(addresseeId));
      queryClient.invalidateQueries({ queryKey: ['pendingRequests'] });
      Alert.alert('Thành công', 'Đã gửi lời mời kết bạn');
    },
    onError: (err: any) => {
      Alert.alert('Lỗi', err.message || 'Không thể gửi lời mời');
    },
  });

  const getStatusLabel = (item: SearchResult) => {
    if (sentIds.has(item.id)) return 'Đã gửi';
    if (item.friendship_status === 'ACCEPTED') return 'Bạn bè';
    if (item.friendship_status === 'PENDING') return 'Đang chờ';
    return null;
  };

  return (
    <SafeAreaView style={styles.container} edges={['bottom']}>
      {/* Search input */}
      <View style={styles.searchRow}>
        <TextInput
          style={styles.searchInput}
          placeholder="Tìm theo tên hoặc mã người dùng..."
          placeholderTextColor="#999"
          value={query}
          onChangeText={setQuery}
          onSubmitEditing={handleSearch}
          returnKeyType="search"
          autoFocus
        />
        <Pressable style={styles.searchBtn} onPress={handleSearch}>
          <Text style={styles.searchBtnText}>Tìm</Text>
        </Pressable>
      </View>

      {/* Search results */}
      {searching ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color="#007AFF" />
        </View>
      ) : (
        <FlatList
          data={results}
          keyExtractor={(item) => item.id}
          contentContainerStyle={styles.list}
          ListEmptyComponent={
            query.trim() ? (
              <View style={styles.empty}>
                <Text style={styles.emptyText}>Không tìm thấy kết quả</Text>
              </View>
            ) : undefined
          }
          renderItem={({ item }) => {
            const statusLabel = getStatusLabel(item);
            const canSend = !statusLabel;

            return (
              <View style={styles.resultCard}>
                <View style={styles.resultRow}>
                  <View style={styles.avatar}>
                    <Text style={styles.avatarText}>
                      {(item.display_name || '?')[0].toUpperCase()}
                    </Text>
                  </View>
                  <View style={styles.resultMeta}>
                    <Text style={styles.resultName}>{item.display_name}</Text>
                    <Text style={styles.resultCode}>{item.user_code}</Text>
                  </View>
                </View>
                {canSend ? (
                  <Pressable
                    style={styles.sendBtn}
                    onPress={() => sendMutation.mutate(item.id)}
                    disabled={sendMutation.isPending}
                  >
                    {sendMutation.isPending ? (
                      <ActivityIndicator size="small" color="#fff" />
                    ) : (
                      <Text style={styles.sendBtnText}>Gửi lời mời</Text>
                    )}
                  </Pressable>
                ) : (
                  <View style={styles.statusBadge}>
                    <Text style={styles.statusText}>{statusLabel}</Text>
                  </View>
                )}
              </View>
            );
          }}
        />
      )}

      {/* Your code section */}
      <View style={styles.myCodeSection}>
        <Text style={styles.myCodeLabel}>Mã người dùng của bạn</Text>
        <View style={styles.myCodeCard}>
          <View style={styles.qrPlaceholder}>
            <Text style={styles.qrText}>📱</Text>
            <Text style={styles.qrSubtext}>QR Code</Text>
          </View>
          <View style={styles.codeDisplay}>
            <Text style={styles.codeValue}>
              {profile?.user_code || '---'}
            </Text>
            <Text style={styles.codeHint}>
              Chia sẻ mã này để bạn bè thêm bạn
            </Text>
          </View>
        </View>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f2f2f7' },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },

  // Search
  searchRow: {
    flexDirection: 'row',
    gap: 10,
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 8,
  },
  searchInput: {
    flex: 1,
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
  searchBtn: {
    backgroundColor: '#007AFF',
    borderRadius: 12,
    paddingHorizontal: 20,
    justifyContent: 'center',
  },
  searchBtnText: { color: '#fff', fontSize: 16, fontWeight: '600' },

  // Results
  list: { padding: 16, gap: 8 },
  empty: { alignItems: 'center', paddingTop: 40 },
  emptyText: { fontSize: 16, color: '#666' },

  resultCard: {
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
  resultRow: {
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
  resultMeta: { flex: 1 },
  resultName: { fontSize: 16, fontWeight: '600', color: '#1a1a1a' },
  resultCode: { fontSize: 13, color: '#8E8E93', marginTop: 2 },

  sendBtn: {
    backgroundColor: '#007AFF',
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  sendBtnText: { color: '#fff', fontSize: 14, fontWeight: '600' },

  statusBadge: {
    backgroundColor: '#f2f2f7',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  statusText: { color: '#8E8E93', fontSize: 13, fontWeight: '500' },

  // My code
  myCodeSection: {
    padding: 16,
    gap: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#E5E5EA',
    backgroundColor: '#fff',
  },
  myCodeLabel: {
    fontSize: 14,
    fontWeight: '600',
    color: '#8E8E93',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  myCodeCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 16,
  },
  qrPlaceholder: {
    width: 64,
    height: 64,
    borderRadius: 12,
    backgroundColor: '#f2f2f7',
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#E5E5EA',
  },
  qrText: { fontSize: 24 },
  qrSubtext: { fontSize: 10, color: '#8E8E93' },
  codeDisplay: { flex: 1 },
  codeValue: {
    fontSize: 22,
    fontWeight: '700',
    color: '#1a1a1a',
    letterSpacing: 2,
  },
  codeHint: { fontSize: 13, color: '#8E8E93', marginTop: 2 },
});
