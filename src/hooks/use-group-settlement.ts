/**
 * Dữ liệu nhóm + số dư + gợi ý tất toán dùng chung cho các màn
 * chi tiết nhóm, thanh toán, tổng quan công nợ, chi tiết công nợ.
 *
 * APP-01: lỗi tính toán (người lạ trong khoản chi, BR-02 tổng ≠ 0) KHÔNG bị nuốt —
 *         trả về `settlementError` và console.error để màn hình hiện trạng thái lỗi.
 * APP-06: gợi ý luôn theo công tắc simplify_debts của nhóm (NULL = bật).
 * REV-S6 (§7 DEBT-01): khi có mạng, số dư chính thức / dự kiến lấy từ view group_balances;
 *         chế độ bù trừ → simplifyDebts trên số dư dự kiến của view; chế độ từng cặp vẫn cần dữ liệu
 *         khoản chi (pairwiseDebts). View lỗi (mất mạng) → tự tính ở client, `source = 'client'`
 *         để màn hình hiện nhãn "Chưa đồng bộ".
 * REV-S5: quyền xem/ghi của người đang xem (đã rời nhóm, nhóm đã đóng) qua useGroupAccess.
 */

import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';

import { fetchExpenses } from '@/api/expenses';
import { fetchGroup, fetchGroupBalances, fetchGroupMembers, isActiveMember } from '@/api/groups';
import { fetchPayments } from '@/api/payments';
import { simplifyDebts, type Transfer } from '@/domain/settlement';
import {
  assertZeroSum,
  computeGroupSettlement,
  isSimplifyEnabled,
  pendingTotals,
  toExpenseInputs,
  toPaymentInputs,
  type MemberPosition,
} from '@/domain/suggest';
import { useAuth } from '@/hooks/use-auth';

/** REV-S6: key bắt đầu bằng 'groups' để mọi chỗ ghi invalidate ['groups'] cũng làm mới số dư của view */
export function groupBalancesKey(groupId: string) {
  return ['groups', 'balances', groupId] as const;
}

export type SettlementView = {
  /** Số dư chính thức — chỉ thanh toán CONFIRMED (BR-06) */
  officialBal: Map<string, number>;
  /** Số dư dự kiến — tính cả thanh toán PENDING */
  projectedBal: Map<string, number>;
  /** Gợi ý tất toán theo công tắc của nhóm */
  suggestions: Transfer[];
  simplify: boolean;
  /** REV-S6: 'server' = view group_balances; 'client' = tự tính khi không tải được view ("Chưa đồng bộ") */
  source: 'server' | 'client';
  /** REV-S6: tổng PENDING đã gửi / đang chờ nhận theo người */
  pending: Map<string, { sent: number; received: number }>;
};

/**
 * REV-S5: Quyền của người đang xem trong nhóm. Dùng chung query ['group', id] và ['group-members', id].
 * - isViewerActive: mình còn là thành viên ACTIVE (đã rời / bị xóa → chỉ xem lịch sử)
 * - isGroupClosed: nhóm đã đóng → ẩn mọi nút ghi
 */
export function useGroupAccess(groupId: string) {
  const { user } = useAuth();
  const groupQ = useQuery({
    queryKey: ['group', groupId],
    queryFn: () => fetchGroup(groupId),
    enabled: !!groupId && !!user,
  });

  // APP-01: danh sách gồm cả thành viên đã rời để tính số dư
  const membersQ = useQuery({
    queryKey: ['group-members', groupId],
    queryFn: () => fetchGroupMembers(groupId),
    enabled: !!groupId && !!user,
  });

  const me = membersQ.data?.find((m) => m.id === user?.id);
  // Chưa tải được danh sách → chưa kết luận (không chặn nhầm khi đang tải)
  const accessKnown = !!membersQ.data && !!groupQ.data;
  const isViewerActive = !accessKnown || (!!me && isActiveMember(me));
  const isGroupClosed = groupQ.data?.status === 'CLOSED';
  const canWrite = isViewerActive && !isGroupClosed;

  return { groupQ, membersQ, accessKnown, isViewerActive, isGroupClosed, canWrite };
}

export function useGroupSettlement(groupId: string) {
  const { user } = useAuth();
  const { groupQ, membersQ, accessKnown, isViewerActive, isGroupClosed, canWrite } = useGroupAccess(groupId);

  const expensesQ = useQuery({
    queryKey: ['expenses', groupId],
    queryFn: () => fetchExpenses(groupId),
    enabled: !!groupId && !!user,
  });

  const paymentsQ = useQuery({
    queryKey: ['payments', groupId],
    queryFn: () => fetchPayments(groupId),
    enabled: !!groupId && !!user,
  });

  // REV-S6: số dư từ view group_balances (§7 DEBT-01)
  const balancesQ = useQuery({
    queryKey: groupBalancesKey(groupId),
    queryFn: () => fetchGroupBalances(groupId),
    enabled: !!groupId && !!user,
  });

  const memberNames = useMemo(
    () => new Map((membersQ.data ?? []).map((m) => [m.id, m.displayName || m.id.slice(0, 8)])),
    [membersQ.data],
  );

  const expenseInputs = useMemo(() => toExpenseInputs(expensesQ.data ?? []), [expensesQ.data]);
  const paymentInputs = useMemo(() => toPaymentInputs(paymentsQ.data ?? []), [paymentsQ.data]);

  const simplify = groupQ.data?.simplify_debts;

  // REV-S6: không dùng được view (lỗi, hoặc mất mạng mà chưa từng tải) → tự tính ở client
  const viewUnavailable = !!balancesQ.error || (!balancesQ.data && balancesQ.fetchStatus === 'paused');
  const viewRows = viewUnavailable ? null : (balancesQ.data ?? null);

  const { settlement, settlementError } = useMemo((): {
    settlement: SettlementView | null;
    settlementError: Error | null;
  } => {
    if (!membersQ.data || !groupQ.data) return { settlement: null, settlementError: null };
    const fail = (err: unknown) => {
      // APP-01 / BR-02: ghi log, không hiển thị gợi ý, không tự bù chênh lệch
      console.error(`[Settlement] Không tính được công nợ nhóm ${groupId}:`, err);
      return { settlement: null, settlementError: err instanceof Error ? err : new Error(String(err)) };
    };
    const simplifyOn = isSimplifyEnabled(simplify);
    const haveClientData = !!expensesQ.data && !!paymentsQ.data;

    try {
      if (viewRows) {
        // REV-S6: số dư chính thức / dự kiến từ view (chỉ thành viên ACTIVE; LEFT luôn 0 theo BR-11)
        const officialBal = new Map(viewRows.map((r) => [r.userId, r.officialBalance]));
        const projectedBal = new Map(viewRows.map((r) => [r.userId, r.projectedBalance]));
        const pending = new Map(viewRows.map((r) => [r.userId, { sent: r.pendingSent, received: r.pendingReceived }]));
        assertZeroSum(officialBal, 'số dư chính thức');
        assertZeroSum(projectedBal, 'số dư dự kiến');
        let suggestions: Transfer[];
        if (simplifyOn) {
          suggestions = simplifyDebts(projectedBal);
        } else {
          // Chế độ từng cặp cần dữ liệu từng khoản chi
          if (!haveClientData) return { settlement: null, settlementError: null };
          const memberIds = membersQ.data.map((m) => m.id);
          suggestions = computeGroupSettlement(memberIds, expenseInputs, paymentInputs, false).suggestions;
        }
        return {
          settlement: { officialBal, projectedBal, suggestions, simplify: simplifyOn, source: 'server', pending },
          settlementError: null,
        };
      }

      if (!viewUnavailable || !haveClientData) return { settlement: null, settlementError: null };
      const memberIds = membersQ.data.map((m) => m.id);
      const computed = computeGroupSettlement(memberIds, expenseInputs, paymentInputs, simplify);
      // Hiển thị như view: thành viên ACTIVE + người còn số dư khác 0 (không có ai nếu dữ liệu đúng BR-11)
      const shown = new Set(
        membersQ.data
          .filter((m) => isActiveMember(m) || computed.officialBal.get(m.id) || computed.projectedBal.get(m.id))
          .map((m) => m.id),
      );
      const pick = (bal: Map<string, number>) => new Map([...bal].filter(([id]) => shown.has(id)));
      return {
        settlement: {
          officialBal: pick(computed.officialBal),
          projectedBal: pick(computed.projectedBal),
          suggestions: computed.suggestions,
          simplify: computed.simplify,
          source: 'client',
          pending: pendingTotals(paymentInputs),
        },
        settlementError: null,
      };
    } catch (err) {
      return fail(err);
    }
  }, [
    membersQ.data,
    groupQ.data,
    expensesQ.data,
    paymentsQ.data,
    expenseInputs,
    paymentInputs,
    simplify,
    groupId,
    viewRows,
    viewUnavailable,
  ]);

  // REV-S6: tình trạng của chính mình (AC-01.1 "Bạn đã cân bằng", §6 ví dụ 2)
  const myPosition = useMemo((): MemberPosition | null => {
    if (!settlement || !user) return null;
    const pend = settlement.pending.get(user.id) ?? { sent: 0, received: 0 };
    return {
      official: settlement.officialBal.get(user.id) ?? 0,
      projected: settlement.projectedBal.get(user.id) ?? 0,
      pendingReceived: pend.received,
      pendingSent: pend.sent,
    };
  }, [settlement, user]);

  // Đang tải view mà chưa có kết quả → coi như đang tải (không nháy số tự tính rồi đổi sang số của view)
  const isLoading =
    groupQ.isLoading || membersQ.isLoading || expensesQ.isLoading || paymentsQ.isLoading || balancesQ.isLoading;
  // REV-S6: lỗi của view không chặn màn hình (đã có phương án tự tính)
  const queryError = (groupQ.error || membersQ.error || expensesQ.error || paymentsQ.error) as Error | null;

  const refetchAll = () => {
    groupQ.refetch();
    membersQ.refetch();
    expensesQ.refetch();
    paymentsQ.refetch();
    balancesQ.refetch();
  };

  const getName = (uid: string) => memberNames.get(uid) || uid.slice(0, 8);

  return {
    groupQ,
    membersQ,
    expensesQ,
    paymentsQ,
    balancesQ,
    memberNames,
    getName,
    expenseInputs,
    paymentInputs,
    settlement,
    settlementError,
    myPosition,
    /** REV-S6: đang hiện số tự tính ở client → nhãn "Chưa đồng bộ" */
    isUnsynced: settlement?.source === 'client',
    accessKnown,
    isViewerActive,
    isGroupClosed,
    canWrite,
    isLoading,
    queryError,
    refetchAll,
  };
}
