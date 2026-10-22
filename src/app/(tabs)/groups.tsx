import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import React, { useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Modal,
  Pressable,
  RefreshControl,
  SectionList,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { toUserMessage } from '@/api/errors';
import { joinGroup } from '@/api/groups';
import { Avatar } from '@/components/avatar';
import { ErrorState } from '@/components/error-state';
import { useGroupsList } from '@/hooks/use-groups';

export default function GroupsScreen() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [showJoin, setShowJoin] = useState(false);
  const [inviteCode, setInviteCode] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // REV-A1 / REV-S4: danh sách theo người dùng; tách nhóm đang hoạt động và nhóm "Đã lưu trữ"
  const { isLoading, refetch, isRefetching, error, data, activeGroups, archivedGroups } = useGroupsList();
  const sections = [
    { key: 'active', title: null as string | null, data: activeGroups },
    ...(archivedGroups.length > 0 ? [{ key: 'archived', title: 'Đã lưu trữ', data: archivedGroups }] : []),
  ];

  const handleJoinGroup = async () => {
    if (!inviteCode.trim()) {
      Alert.alert('Lỗi', 'Vui lòng nhập mã mời');
      return;
    }
    setSubmitting(true);
    try {
      const group = await joinGroup(inviteCode.trim());
      queryClient.invalidateQueries({ queryKey: ['groups'] });
      setShowJoin(false);
      setInviteCode('');
      router.push(`/group/${group.id}` as any);
    } catch (err: any) {
      Alert.alert('Lỗi', toUserMessage(err, 'Mã mời không hợp lệ'));
    } finally {
      setSubmitting(false);
    }
  };

  if (isLoading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color="#007AFF" />
      </View>
    );
  }

  return (
    <SafeAreaView style={styles.container} edges={['bottom']}>
      {/* Action buttons — MVP-03: nút "Tạo nhóm" mở màn hình mới thay vì modal */}
      <View style={styles.actions}>
        <Pressable style={styles.actionBtn} onPress={() => router.push('/group/new' as any)}>
          <Text style={styles.actionBtnText}>+ Tạo nhóm</Text>
        </Pressable>
        <Pressable style={[styles.actionBtn, styles.actionBtnSecondary]} onPress={() => setShowJoin(true)}>
          <Text style={[styles.actionBtnText, styles.actionBtnTextSecondary]}>Nhập mã mời</Text>
        </Pressable>
        {/* MVP-04: quét QR mời nhóm */}
        <Pressable
          style={[styles.actionBtn, styles.actionBtnSecondary, styles.scanBtn]}
          onPress={() => router.push('/scan' as any)}
          accessibilityLabel="Quét mã QR"
        >
          <Text style={[styles.actionBtnText, styles.actionBtnTextSecondary]}>📷</Text>
        </Pressable>
      </View>

      {/* APP-19: lỗi tải danh sách — không hiện như "chưa có nhóm" */}
      {error && !data ? (
        <ErrorState message={toUserMessage(error, 'Không thể tải danh sách nhóm')} onRetry={() => refetch()} />
      ) : (
        <SectionList
          sections={sections}
          keyExtractor={(item) => item.id}
          contentContainerStyle={styles.list}
          stickySectionHeadersEnabled={false}
          refreshControl={
            <RefreshControl refreshing={isRefetching} onRefresh={() => { refetch(); }} />
          }
          renderSectionHeader={({ section }) =>
            section.title ? <Text style={styles.sectionTitle}>{section.title}</Text> : null
          }
          renderSectionFooter={({ section }) =>
            section.key === 'active' && section.data.length === 0 ? (
              <View style={styles.empty}>
                <Text style={styles.emptyIcon}>👥</Text>
                <Text style={styles.emptyText}>Chưa có nhóm nào đang hoạt động</Text>
                <Text style={styles.emptyHint}>Tạo nhóm mới hoặc nhập mã mời để bắt đầu</Text>
              </View>
            ) : null
          }
          renderItem={({ item, section }) => {
            const archived = section.key === 'archived';
            // REV-S4: nhóm lưu trữ — nói rõ vì sao (đã rời / bị xóa / nhóm đã đóng)
            const archivedReason =
              item.memberStatus === 'LEFT'
                ? 'Bạn đã rời nhóm'
                : item.memberStatus === 'REMOVED'
                  ? 'Bạn đã bị xóa khỏi nhóm'
                  : 'Nhóm đã đóng';
            return (
              <Pressable
                style={[styles.card, archived && styles.cardArchived]}
                onPress={() => router.push(`/group/${item.id}` as any)}
              >
                <Avatar name={item.name} path={item.avatar_path} seed={item.id} size={44} style={styles.groupAvatar} />
                <View style={styles.cardInfo}>
                  <Text style={styles.groupName}>{item.name}</Text>
                  <Text style={styles.groupMeta}>
                    {archived
                      ? archivedReason
                      : `${item.role === 'owner' ? 'Chủ nhóm' : 'Thành viên'} · Mã: ${item.invite_code}`}
                  </Text>
                </View>
                <Text style={styles.arrow}>›</Text>
              </Pressable>
            );
          }}
        />
      )}

      {/* Modal tham gia nhóm */}
      <Modal visible={showJoin} transparent animationType="slide">
        <View style={styles.modalOverlay}>
          <View style={styles.modal}>
            <Text style={styles.modalTitle}>Tham gia nhóm</Text>
            <TextInput
              style={styles.input}
              placeholder="Mã mời (8 ký tự)"
              placeholderTextColor="#999"
              value={inviteCode}
              onChangeText={setInviteCode}
              autoCapitalize="characters"
              maxLength={8}
              autoFocus
            />
            <View style={styles.modalActions}>
              <Pressable style={styles.modalCancel} onPress={() => { setShowJoin(false); setInviteCode(''); }}>
                <Text style={styles.modalCancelText}>Hủy</Text>
              </Pressable>
              <Pressable
                style={[styles.modalConfirm, submitting && styles.buttonDisabled]}
                onPress={handleJoinGroup}
                disabled={submitting}
              >
                {submitting ? (
                  <ActivityIndicator color="#fff" size="small" />
                ) : (
                  <Text style={styles.modalConfirmText}>Tham gia</Text>
                )}
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f2f2f7' },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  actions: {
    flexDirection: 'row',
    gap: 12,
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 4,
  },
  actionBtn: {
    flex: 1,
    backgroundColor: '#007AFF',
    borderRadius: 12,
    padding: 14,
    alignItems: 'center',
  },
  actionBtnSecondary: {
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#007AFF',
  },
  actionBtnText: { color: '#fff', fontSize: 15, fontWeight: '600' },
  actionBtnTextSecondary: { color: '#007AFF' },
  list: { padding: 16, gap: 8 },
  empty: { alignItems: 'center', paddingTop: 40 },
  emptyIcon: { fontSize: 48, marginBottom: 12 },
  emptyText: { fontSize: 16, color: '#666' },
  emptyHint: { fontSize: 14, color: '#999', marginTop: 4 },
  card: {
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 16,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 4,
    elevation: 2,
  },
  cardArchived: { opacity: 0.7 },
  cardInfo: { flex: 1 },
  groupAvatar: { marginRight: 12 },
  scanBtn: { flex: 0, paddingHorizontal: 16 },
  sectionTitle: { fontSize: 15, fontWeight: '600', color: '#8E8E93', marginTop: 12, marginBottom: 4 },
  groupName: { fontSize: 16, fontWeight: '600', color: '#1a1a1a' },
  groupMeta: { fontSize: 13, color: '#8E8E93', marginTop: 2 },
  arrow: { fontSize: 22, color: '#C7C7CC', fontWeight: '300' },

  // Modal styles
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.4)',
    justifyContent: 'center',
    paddingHorizontal: 24,
  },
  modal: {
    backgroundColor: '#fff',
    borderRadius: 16,
    padding: 24,
    gap: 16,
  },
  modalTitle: { fontSize: 20, fontWeight: '700', color: '#1a1a1a' },
  input: {
    borderWidth: 1,
    borderColor: '#ddd',
    borderRadius: 12,
    padding: 16,
    fontSize: 16,
    backgroundColor: '#f9f9f9',
    color: '#1a1a1a',
  },
  modalActions: { flexDirection: 'row', gap: 12, justifyContent: 'flex-end' },
  modalCancel: { padding: 12 },
  modalCancelText: { fontSize: 16, color: '#666' },
  modalConfirm: {
    backgroundColor: '#007AFF',
    borderRadius: 10,
    paddingHorizontal: 24,
    paddingVertical: 12,
  },
  modalConfirmText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  buttonDisabled: { opacity: 0.6 },
});
