import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import QRCode from 'react-native-qrcode-svg';

import { toUserMessage } from '@/api/errors';
import { fetchUserByCode, searchUsers, sendFriendRequest } from '@/api/contacts';
import { fetchProfile } from '@/api/profiles';
import { Avatar } from '@/components/avatar';
import { createAppLink } from '@/lib/app-link-url';
import { SHORT_CODE_RE } from '@/lib/app-links';

type SearchResult = {
  id: string;
  display_name: string;
  user_code: string;
  avatar_path: string | null;
  friendship_status: string | null; // 'ACCEPTED' | 'PENDING' | null
};

export default function AddFriendScreen() {
  const queryClient = useQueryClient();
  const router = useRouter();
  // MVP-05: mở kèm ?code=<user_code> (từ QR) → tìm chính xác theo mã
  const { code: codeParam } = useLocalSearchParams<{ code?: string }>();
  const initialCode = typeof codeParam === 'string' ? codeParam.trim().toUpperCase() : '';
  const [query, setQuery] = useState(initialCode);
  const [showMyQr, setShowMyQr] = useState(false);
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [sentIds, setSentIds] = useState<Set<string>>(new Set());

  const { data: profile } = useQuery({
    queryKey: ['profile'],
    queryFn: fetchProfile,
  });

  /** MVP-05: tìm đúng một người theo mã (find_user_by_code — không lọc searchable) */
  const searchByCode = useCallback(async (code: string) => {
    setSearching(true);
    try {
      const found = await fetchUserByCode(code);
      setResults(found ? [{ ...found, friendship_status: null }] : []);
    } catch (err: any) {
      Alert.alert('Lỗi', toUserMessage(err, 'Không thể tìm kiếm'));
    } finally {
      setSearching(false);
    }
  }, []);

  const searchedCodeRef = useRef<string | null>(null);
  useEffect(() => {
    if (!SHORT_CODE_RE.test(initialCode) || searchedCodeRef.current === initialCode) return;
    searchedCodeRef.current = initialCode;
    searchByCode(initialCode);
  }, [initialCode, searchByCode]);

  const handleSearch = useCallback(async () => {
    const q = query.trim();
    if (!q) return;
    setSearching(true);
    try {
      const data = await searchUsers(q);
      setResults(data ?? []);
    } catch (err: any) {
      Alert.alert('Lỗi', toUserMessage(err, 'Không thể tìm kiếm'));
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
      Alert.alert('Lỗi', toUserMessage(err, 'Không thể gửi lời mời'));
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
                  <Avatar name={item.display_name} path={item.avatar_path} seed={item.id} size={44} />
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
          {profile?.user_code ? (
            <Pressable onPress={() => setShowMyQr(true)} accessibilityLabel="Phóng to mã QR của bạn">
              <QRCode
                value={createAppLink({ kind: 'add-friend', code: profile.user_code })}
                size={72}
                backgroundColor="#fff"
              />
            </Pressable>
          ) : (
            <View style={styles.qrPlaceholder}>
              <ActivityIndicator size="small" color="#8E8E93" />
            </View>
          )}
          <View style={styles.codeDisplay}>
            <Text style={styles.codeValue}>
              {profile?.user_code || '---'}
            </Text>
            <Text style={styles.codeHint}>
              Chạm vào mã QR để phóng to cho bạn bè quét
            </Text>
          </View>
        </View>
        <Pressable style={styles.scanBtn} onPress={() => router.push('/scan')}>
          <Text style={styles.scanBtnText}>📷 Quét mã QR bạn bè</Text>
        </Pressable>
      </View>

      {/* MVP-05: QR kết bạn cỡ lớn để quét */}
      <Modal visible={showMyQr} transparent animationType="fade" onRequestClose={() => setShowMyQr(false)}>
        <Pressable style={styles.qrOverlay} onPress={() => setShowMyQr(false)}>
          <View style={styles.qrModal}>
            <Text style={styles.qrTitle}>Mã QR kết bạn của bạn</Text>
            {profile?.user_code ? (
              <QRCode
                value={createAppLink({ kind: 'add-friend', code: profile.user_code })}
                size={220}
                backgroundColor="#fff"
              />
            ) : null}
            <Text style={styles.qrCode}>{profile?.user_code}</Text>
            <Text style={styles.qrHint}>Chạm để đóng</Text>
          </View>
        </Pressable>
      </Modal>
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
  codeDisplay: { flex: 1 },
  codeValue: {
    fontSize: 22,
    fontWeight: '700',
    color: '#1a1a1a',
    letterSpacing: 2,
  },
  codeHint: { fontSize: 13, color: '#8E8E93', marginTop: 2 },
  scanBtn: {
    backgroundColor: '#007AFF',
    borderRadius: 12,
    padding: 14,
    alignItems: 'center',
    marginTop: 8,
  },
  scanBtnText: { color: '#fff', fontSize: 15, fontWeight: '600' },
  qrOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center', alignItems: 'center' },
  qrModal: { backgroundColor: '#fff', borderRadius: 20, padding: 28, alignItems: 'center', gap: 14, marginHorizontal: 32 },
  qrTitle: { fontSize: 17, fontWeight: '600', color: '#1a1a1a' },
  qrCode: { fontSize: 22, fontWeight: '700', letterSpacing: 2, color: '#1a1a1a' },
  qrHint: { fontSize: 13, color: '#8E8E93' },
});
