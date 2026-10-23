import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import {
  approveJoinRequest,
  closeGroup,
  createInvite,
  isActiveMember,
  leaveGroup,
  rejectJoinRequest,
  removeMember,
  transferOwnership,
  type JoinRequest,
} from '@/api/groups';
import { toUserMessage } from '@/api/errors';
import { Avatar } from '@/components/avatar';
import { useAuth } from '@/hooks/use-auth';
import { useGroupSettlement } from '@/hooks/use-group-settlement';
import { useJoinRequests } from '@/hooks/use-join-requests';
import {
  balanceLabel,
  canRemoveMember,
  hasPendingPayment,
  joinRequestErrorMessage,
  joinViaLabel,
} from '@/lib/membership';
import { joinRequestsKey } from '@/lib/realtime-keys';

const AVATAR_COLORS = ['#007AFF', '#34C759', '#FF9500', '#AF52DE', '#FF2D55', '#5AC8FA', '#FF3B30', '#5856D6'];

/** Thời điểm gửi yêu cầu: DD/MM/YYYY HH:mm */
function formatRequestTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export default function MembersScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { user } = useAuth();
  const queryClient = useQueryClient();

  // Số dư chính thức + thanh toán chờ của từng thành viên: quy tắc "chỉ xóa người đã tất toán"
  const { groupQ, membersQ, paymentsQ, settlement } = useGroupSettlement(id);

  const isOwner = groupQ.data?.owner_id === user?.id;

  // Migration 0014: yêu cầu tham gia đang chờ duyệt (chỉ chủ nhóm)
  const joinRequestsQ = useJoinRequests(id, isOwner);
  const joinRequests = joinRequestsQ.data ?? [];
  const [rejectTarget, setRejectTarget] = useState<JoinRequest | null>(null);
  const [rejectReason, setRejectReason] = useState('');

  const invalidateMembership = () => {
    queryClient.invalidateQueries({ queryKey: joinRequestsKey(id) });
    queryClient.invalidateQueries({ queryKey: ['group-members', id] });
    queryClient.invalidateQueries({ queryKey: ['group', id] });
    queryClient.invalidateQueries({ queryKey: ['groups'] });
  };

  const approveMutation = useMutation({
    mutationFn: (requestId: string) => approveJoinRequest(requestId),
    onSuccess: invalidateMembership,
    onError: (err) => {
      // Yêu cầu có thể đã bị hủy / xử lý ở máy khác → tải lại danh sách
      queryClient.invalidateQueries({ queryKey: joinRequestsKey(id) });
      Alert.alert('Lỗi', joinRequestErrorMessage(err, 'Không thể duyệt yêu cầu'));
    },
  });

  const rejectMutation = useMutation({
    mutationFn: ({ requestId, reason }: { requestId: string; reason: string }) => rejectJoinRequest(requestId, reason),
    onSuccess: () => {
      setRejectTarget(null);
      setRejectReason('');
      invalidateMembership();
    },
    onError: (err) => {
      queryClient.invalidateQueries({ queryKey: joinRequestsKey(id) });
      Alert.alert('Lỗi', joinRequestErrorMessage(err, 'Không thể từ chối yêu cầu'));
    },
  });

  const busyRequestId = approveMutation.isPending
    ? approveMutation.variables
    : rejectMutation.isPending
      ? rejectMutation.variables?.requestId
      : null;

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
      // NONZERO_BALANCE / PENDING_PAYMENTS: số dư vừa đổi ở máy khác → tải lại
      queryClient.invalidateQueries({ queryKey: ['groups'] });
      queryClient.invalidateQueries({ queryKey: ['payments', id] });
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

  const reinviteMutation = useMutation({
    mutationFn: (userId: string) => createInvite(id, { invitedUserId: userId }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['group-invites', id] });
      Alert.alert('Thành công', 'Đã gửi lời mời. Người được mời sẽ nhận thông báo để tham gia lại.');
    },
    onError: (err: any) => {
      Alert.alert('Lỗi', toUserMessage(err, 'Không thể mời lại'));
    },
  });

  /** Số dư chính thức của một thành viên ACTIVE; null = chưa tải được (view chỉ có thành viên ACTIVE, thiếu dòng = 0). */
  const officialBalanceOf = (userId: string): number | null =>
    settlement ? (settlement.officialBal.get(userId) ?? 0) : null;

  /** Kiểm tra trước khi xóa: số dư = 0 và không còn thanh toán PENDING (server vẫn chặn lại). */
  const removeCheckOf = (userId: string) => {
    const pend = settlement?.pending.get(userId);
    const hasPending = (!!pend && (pend.sent > 0 || pend.received > 0)) || hasPendingPayment(paymentsQ.data, userId);
    return canRemoveMember(officialBalanceOf(userId), hasPending);
  };

  const confirmRemove = (member: any) => {
    const name = member.displayName || member.id.slice(0, 8);
    const check = removeCheckOf(member.id);
    if (!check.allowed) {
      Alert.alert('Chưa thể xóa', `${name}: ${check.reason}. Thành viên cần tất toán công nợ trước khi bị xóa khỏi nhóm.`);
      return;
    }
    Alert.alert('Xóa thành viên', `Bạn có chắc muốn xóa ${name} khỏi nhóm?`, [
      { text: 'Hủy', style: 'cancel' },
      { text: 'Xóa', style: 'destructive', onPress: () => removeMutation.mutate(member.id) },
    ]);
  };

  const handleMemberPress = (member: any) => {
    if (!isOwner || member.id === user?.id) return;
    const name = member.displayName || member.id.slice(0, 8);
    const check = removeCheckOf(member.id);

    Alert.alert(name, 'Chọn hành động', [
      {
        text: 'Chuyển quyền chủ nhóm',
        onPress: () => {
          Alert.alert('Chuyển quyền chủ nhóm', `Bạn có chắc muốn chuyển quyền chủ nhóm cho ${name}?`, [
            { text: 'Hủy', style: 'cancel' },
            {
              text: 'Chuyển quyền',
              style: 'destructive',
              onPress: () => transferMutation.mutate(member.id),
            },
          ]);
        },
      },
      {
        text: check.allowed ? 'Xóa khỏi nhóm' : `Xóa khỏi nhóm (${check.reason})`,
        style: 'destructive',
        onPress: () => confirmRemove(member),
      },
      { text: 'Đóng', style: 'cancel' },
    ]);
  };

  const confirmApprove = (req: JoinRequest) => {
    const name = req.displayName || req.userCode || req.userId.slice(0, 8);
    Alert.alert('Duyệt thành viên', `Cho ${name} vào nhóm?`, [
      { text: 'Hủy', style: 'cancel' },
      { text: 'Duyệt', onPress: () => approveMutation.mutate(req.id) },
    ]);
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
        {/* Migration 0014: yêu cầu tham gia chờ duyệt — chỉ chủ nhóm */}
        {isOwner && joinRequestsQ.error && (
          <View style={styles.card}>
            <Text style={styles.sectionTitle}>Yêu cầu tham gia</Text>
            <Text style={styles.mutedText}>{toUserMessage(joinRequestsQ.error, 'Không tải được yêu cầu tham gia')}</Text>
            <Pressable onPress={() => joinRequestsQ.refetch()}>
              <Text style={styles.linkText}>Thử lại</Text>
            </Pressable>
          </View>
        )}
        {isOwner && joinRequests.length > 0 && (
          <View style={styles.card}>
            <Text style={styles.sectionTitle}>Yêu cầu tham gia ({joinRequests.length})</Text>
            {joinRequests.map((req) => {
              const name = req.displayName || req.userCode || req.userId.slice(0, 8);
              const busy = busyRequestId === req.id;
              const meta = [req.userCode ? `#${req.userCode}` : '', joinViaLabel(req.via), formatRequestTime(req.createdAt)]
                .filter(Boolean)
                .join(' · ');
              return (
                <View key={req.id} style={styles.requestRow}>
                  <Avatar name={name} path={req.avatarPath} seed={req.userId} size={44} />
                  <View style={styles.memberInfo}>
                    <Text style={styles.memberName} numberOfLines={1}>
                      {name}
                    </Text>
                    {!!meta && <Text style={styles.memberRole}>{meta}</Text>}
                    <View style={styles.requestActions}>
                      {busy ? (
                        <ActivityIndicator color="#007AFF" />
                      ) : (
                        <>
                          <Pressable
                            style={styles.approveBtn}
                            onPress={() => confirmApprove(req)}
                            disabled={!!busyRequestId}
                          >
                            <Text style={styles.approveBtnText}>Duyệt</Text>
                          </Pressable>
                          <Pressable
                            style={styles.rejectBtn}
                            onPress={() => {
                              setRejectReason('');
                              setRejectTarget(req);
                            }}
                            disabled={!!busyRequestId}
                          >
                            <Text style={styles.rejectBtnText}>Từ chối</Text>
                          </Pressable>
                        </>
                      )}
                    </View>
                  </View>
                </View>
              );
            })}
          </View>
        )}

        {/* Member list */}
        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Danh sách thành viên</Text>
          {/* NEW-03: Người đã rời / bị xóa không còn là thành viên */}
          {(membersQ.data || []).filter(isActiveMember).map((member: any, index: number) => {
            const name = member.displayName || member.id.slice(0, 8);
            const color = AVATAR_COLORS[index % AVATAR_COLORS.length];
            const isMemberOwner = member.id === groupQ.data?.owner_id;
            const balance = officialBalanceOf(member.id);
            const canManage = isOwner && member.id !== user?.id;
            const check = canManage ? removeCheckOf(member.id) : null;

            return (
              <Pressable
                key={member.id}
                style={styles.memberRow}
                onLongPress={() => handleMemberPress(member)}
                disabled={!canManage}
              >
                <Avatar name={name} path={member.avatarPath} color={color} size={44} />
                <View style={styles.memberInfo}>
                  <Text style={styles.memberName}>
                    {name}
                    {member.id === user?.id ? ' (bạn)' : ''}
                  </Text>
                  <Text style={styles.memberRole}>
                    {isMemberOwner ? '👑 Chủ nhóm' : 'Thành viên'}
                  </Text>
                  {balance !== null && (
                    <Text
                      style={[
                        styles.balanceText,
                        balance > 0 ? styles.balancePositive : balance < 0 ? styles.balanceNegative : null,
                      ]}
                    >
                      {balanceLabel(balance)}
                    </Text>
                  )}
                </View>
                {canManage && check && (
                  <View style={styles.manageCol}>
                    <View style={styles.manageRow}>
                      <Pressable
                        style={[styles.removeBtn, !check.allowed && styles.removeBtnDisabled]}
                        onPress={() => confirmRemove(member)}
                        disabled={!check.allowed || removeMutation.isPending}
                        accessibilityState={{ disabled: !check.allowed }}
                      >
                        <Text style={[styles.removeBtnText, !check.allowed && styles.removeBtnTextDisabled]}>
                          Xóa khỏi nhóm
                        </Text>
                      </Pressable>
                      <Pressable onPress={() => handleMemberPress(member)} hitSlop={8}>
                        <Text style={styles.memberAction}>⋯</Text>
                      </Pressable>
                    </View>
                    {!check.allowed && <Text style={styles.removeReason}>{check.reason}</Text>}
                  </View>
                )}
              </Pressable>
            );
          })}
          {/* Migration 0014: thành viên thường chỉ xem trạng thái duyệt */}
          {!isOwner && !!groupQ.data?.require_approval && (
            <Text style={styles.mutedText}>
              Nhóm đang bật duyệt thành viên mới: người vào bằng link, mã nhóm hoặc QR cần chủ nhóm duyệt.
            </Text>
          )}
        </View>

        {/* Removed/left members - only visible to owner */}
        {isOwner && (() => {
          const removedMembers = (membersQ.data || []).filter((m: any) => !isActiveMember(m));
          if (removedMembers.length === 0) return null;
          return (
            <View style={styles.card}>
              <Text style={styles.sectionTitle}>Đã rời nhóm / Bị xóa</Text>
              {removedMembers.map((member: any) => {
                const name = member.displayName || member.id.slice(0, 8);
                const statusLabel = member.status === 'LEFT' ? 'Đã rời' : 'Bị xóa';
                return (
                  <View key={member.id} style={styles.memberRow}>
                    <Avatar name={name} path={member.avatarPath} color="#C7C7CC" size={44} />
                    <View style={styles.memberInfo}>
                      <Text style={[styles.memberName, { color: '#8E8E93' }]}>{name}</Text>
                      <Text style={styles.memberRole}>{statusLabel}</Text>
                    </View>
                    <Pressable
                      style={styles.reinviteBtn}
                      onPress={() =>
                        Alert.alert('Mời lại', `Gửi lời mời vào nhóm cho ${name}? Người này sẽ nhận thông báo.`, [
                          { text: 'Hủy', style: 'cancel' },
                          { text: 'Mời lại', onPress: () => reinviteMutation.mutate(member.id) },
                        ])
                      }
                      disabled={reinviteMutation.isPending}
                    >
                      <Text style={styles.reinviteBtnText}>Mời lại</Text>
                    </Pressable>
                  </View>
                );
              })}
            </View>
          );
        })()}

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

      {/* Từ chối yêu cầu tham gia: xác nhận + lý do (không bắt buộc) — Alert.prompt chỉ có trên iOS */}
      <Modal
        visible={!!rejectTarget}
        transparent
        animationType="fade"
        onRequestClose={() => {
          if (!rejectMutation.isPending) setRejectTarget(null);
        }}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Từ chối yêu cầu</Text>
            <Text style={styles.modalText}>
              Từ chối yêu cầu tham gia nhóm của{' '}
              {rejectTarget?.displayName || rejectTarget?.userCode || 'người này'}?
            </Text>
            <TextInput
              style={styles.modalInput}
              value={rejectReason}
              onChangeText={setRejectReason}
              placeholder="Lý do (không bắt buộc)"
              placeholderTextColor="#C7C7CC"
              maxLength={200}
              multiline
            />
            <View style={styles.modalActions}>
              <Pressable
                style={styles.modalCancel}
                onPress={() => setRejectTarget(null)}
                disabled={rejectMutation.isPending}
              >
                <Text style={styles.modalCancelText}>Hủy</Text>
              </Pressable>
              <Pressable
                style={[styles.modalReject, rejectMutation.isPending && styles.dangerBtnDisabled]}
                onPress={() => rejectTarget && rejectMutation.mutate({ requestId: rejectTarget.id, reason: rejectReason })}
                disabled={rejectMutation.isPending}
              >
                {rejectMutation.isPending ? (
                  <ActivityIndicator color="#fff" />
                ) : (
                  <Text style={styles.modalRejectText}>Từ chối</Text>
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
  memberInfo: { flex: 1 },
  memberName: { fontSize: 15, fontWeight: '500', color: '#1a1a1a' },
  memberRole: { fontSize: 13, color: '#8E8E93', marginTop: 2 },
  memberAction: { fontSize: 20, color: '#8E8E93', paddingHorizontal: 4 },
  balanceText: { fontSize: 13, color: '#8E8E93', marginTop: 2 },
  balancePositive: { color: '#34C759' },
  balanceNegative: { color: '#FF3B30' },
  manageCol: { alignItems: 'flex-end', maxWidth: 160, gap: 4 },
  manageRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  removeBtn: {
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#FF3B30',
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  removeBtnDisabled: { borderColor: '#D1D1D6', backgroundColor: '#F2F2F7' },
  removeBtnText: { color: '#FF3B30', fontSize: 12, fontWeight: '600' },
  removeBtnTextDisabled: { color: '#AEAEB2' },
  removeReason: { fontSize: 11, color: '#FF9500', textAlign: 'right' },
  mutedText: { fontSize: 13, color: '#8E8E93', lineHeight: 18 },
  linkText: { fontSize: 14, color: '#007AFF', fontWeight: '600' },
  requestRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#E5E5EA',
    gap: 12,
  },
  requestActions: { flexDirection: 'row', gap: 8, marginTop: 8, minHeight: 30, alignItems: 'center' },
  approveBtn: { backgroundColor: '#007AFF', borderRadius: 8, paddingHorizontal: 16, paddingVertical: 6 },
  approveBtnText: { color: '#fff', fontSize: 13, fontWeight: '600' },
  rejectBtn: {
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#FF3B30',
    paddingHorizontal: 16,
    paddingVertical: 5,
  },
  rejectBtnText: { color: '#FF3B30', fontSize: 13, fontWeight: '600' },
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
  reinviteBtn: {
    backgroundColor: '#007AFF',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  reinviteBtnText: { color: '#fff', fontSize: 13, fontWeight: '600' },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.4)',
    justifyContent: 'center',
    padding: 24,
  },
  modalCard: { backgroundColor: '#fff', borderRadius: 16, padding: 20, gap: 12 },
  modalTitle: { fontSize: 18, fontWeight: '700', color: '#1a1a1a' },
  modalText: { fontSize: 15, color: '#3a3a3c', lineHeight: 21 },
  modalInput: {
    backgroundColor: '#f2f2f7',
    borderRadius: 10,
    padding: 12,
    fontSize: 15,
    color: '#1a1a1a',
    minHeight: 64,
    textAlignVertical: 'top',
  },
  modalActions: { flexDirection: 'row', gap: 12, marginTop: 4 },
  modalCancel: { flex: 1, borderRadius: 10, paddingVertical: 12, alignItems: 'center', backgroundColor: '#f2f2f7' },
  modalCancelText: { fontSize: 15, fontWeight: '600', color: '#1a1a1a' },
  modalReject: { flex: 1, borderRadius: 10, paddingVertical: 12, alignItems: 'center', backgroundColor: '#FF3B30' },
  modalRejectText: { fontSize: 15, fontWeight: '600', color: '#fff' },
});
