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
import { Colors, Spacing, Radii, FontSizes, FontWeights, Shadows } from '@/lib/theme';

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
        <ActivityIndicator size="large" color={Colors.primary} />
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
            <RefreshControl refreshing={isRefetching} onRefresh={() => { refetch(); }} tintColor={Colors.primary} />
          }
          renderSectionHeader={({ section }) =>
            section.title ? (
              <View style={styles.sectionTitleRow}>
                <View style={styles.sectionTitleLine} />
                <Text style={styles.sectionTitle}>{section.title}</Text>
                <View style={styles.sectionTitleLine} />
              </View>
            ) : null
          }
          renderSectionFooter={({ section }) =>
            section.key === 'active' && section.data.length === 0 ? (
              <View style={styles.empty}>
                <View style={styles.emptyIconWrap}>
                  <Text style={styles.emptyIcon}>👥</Text>
                </View>
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
                <View style={[styles.cardBorder, archived && styles.cardBorderArchived]} />
                <Avatar name={item.name} path={item.avatar_path} seed={item.id} size={44} style={styles.groupAvatar} />
                <View style={styles.cardInfo}>
                  <Text style={[styles.groupName, archived && styles.groupNameArchived]}>{item.name}</Text>
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
            <View style={styles.modalHeader}>
              <View style={styles.modalHeaderAccent} />
              <Text style={styles.modalTitle}>Tham gia nhóm</Text>
              <Text style={styles.modalSubtitle}>Nhập mã mời từ chủ nhóm để tham gia</Text>
            </View>
            <TextInput
              style={styles.input}
              placeholder="Mã mời (8 ký tự)"
              placeholderTextColor={Colors.textTertiary}
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
                  <ActivityIndicator color={Colors.textInverse} size="small" />
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
  container: { flex: 1, backgroundColor: Colors.background },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: Colors.background },
  actions: {
    flexDirection: 'row',
    gap: Spacing.md,
    paddingHorizontal: Spacing.lg,
    paddingTop: Spacing.md,
    paddingBottom: Spacing.xs,
  },
  actionBtn: {
    flex: 1,
    backgroundColor: Colors.primary,
    borderRadius: Radii.md,
    padding: Spacing.lg,
    alignItems: 'center',
    minHeight: 48,
    justifyContent: 'center',
  },
  actionBtnSecondary: {
    backgroundColor: Colors.surface,
    borderWidth: 1.5,
    borderColor: Colors.primary,
  },
  actionBtnText: {
    color: Colors.textInverse,
    fontSize: FontSizes.md,
    fontWeight: FontWeights.semibold,
  },
  actionBtnTextSecondary: { color: Colors.primary },
  scanBtn: { flex: 0, paddingHorizontal: Spacing.lg },
  list: { padding: Spacing.lg, gap: Spacing.sm },
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
  card: {
    backgroundColor: Colors.surface,
    borderRadius: Radii.lg,
    padding: Spacing.lg,
    flexDirection: 'row',
    alignItems: 'center',
    overflow: 'hidden',
    ...Shadows.sm,
  },
  cardArchived: { opacity: 0.6 },
  cardBorder: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    width: 3,
    backgroundColor: Colors.primary,
    borderTopLeftRadius: Radii.lg,
    borderBottomLeftRadius: Radii.lg,
  },
  cardBorderArchived: {
    backgroundColor: Colors.textTertiary,
  },
  cardInfo: { flex: 1 },
  groupAvatar: { marginRight: Spacing.md },
  sectionTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    marginTop: Spacing.xl,
    marginBottom: Spacing.sm,
  },
  sectionTitleLine: {
    flex: 1,
    height: 1,
    backgroundColor: Colors.border,
  },
  sectionTitle: {
    fontSize: FontSizes.sm,
    fontWeight: FontWeights.semibold,
    color: Colors.textSecondary,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  groupName: {
    fontSize: FontSizes.lg,
    fontWeight: FontWeights.semibold,
    color: Colors.text,
  },
  groupNameArchived: {
    color: Colors.textSecondary,
  },
  groupMeta: {
    fontSize: FontSizes.sm,
    color: Colors.textSecondary,
    marginTop: 2,
  },
  arrow: { fontSize: 22, color: Colors.textTertiary, fontWeight: FontWeights.regular },

  // Modal styles
  modalOverlay: {
    flex: 1,
    backgroundColor: Colors.overlay,
    justifyContent: 'center',
    paddingHorizontal: Spacing.xxl,
  },
  modal: {
    backgroundColor: Colors.surface,
    borderRadius: Radii.xl,
    padding: Spacing.xxl,
    gap: Spacing.lg,
    ...Shadows.lg,
  },
  modalHeader: {
    gap: Spacing.xs,
  },
  modalHeaderAccent: {
    width: 40,
    height: 4,
    borderRadius: Radii.full,
    backgroundColor: Colors.primary,
    marginBottom: Spacing.sm,
  },
  modalTitle: {
    fontSize: FontSizes.xl,
    fontWeight: FontWeights.bold,
    color: Colors.text,
  },
  modalSubtitle: {
    fontSize: FontSizes.sm,
    color: Colors.textSecondary,
    lineHeight: 20,
  },
  input: {
    borderWidth: 1.5,
    borderColor: Colors.border,
    borderRadius: Radii.md,
    padding: Spacing.lg,
    fontSize: FontSizes.lg,
    backgroundColor: Colors.borderLight,
    color: Colors.text,
    letterSpacing: 2,
    fontWeight: FontWeights.semibold,
    textAlign: 'center',
  },
  modalActions: {
    flexDirection: 'row',
    gap: Spacing.md,
    justifyContent: 'flex-end',
    marginTop: Spacing.sm,
  },
  modalCancel: {
    paddingVertical: Spacing.md,
    paddingHorizontal: Spacing.lg,
    borderRadius: Radii.md,
  },
  modalCancelText: {
    fontSize: FontSizes.md,
    color: Colors.textSecondary,
    fontWeight: FontWeights.medium,
  },
  modalConfirm: {
    backgroundColor: Colors.primary,
    borderRadius: Radii.md,
    paddingHorizontal: Spacing.xxl,
    paddingVertical: Spacing.md,
    minWidth: 100,
    alignItems: 'center',
    justifyContent: 'center',
  },
  modalConfirmText: {
    color: Colors.textInverse,
    fontSize: FontSizes.md,
    fontWeight: FontWeights.semibold,
  },
  buttonDisabled: { opacity: 0.6 },
});
