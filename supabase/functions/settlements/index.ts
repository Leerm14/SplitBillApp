/**
 * Edge Function: settlements
 * Đối chiếu gợi ý tất toán phía server.
 *
 * POST /settlements
 * Body: { group_id: string }
 * Response: {
 *   official_balances:  Record<userId, number>  // chỉ thanh toán CONFIRMED (BR-01)
 *   projected_balances: Record<userId, number>  // + thanh toán PENDING (BR-06)
 *   balances:           Record<userId, number>  // = projected_balances (giữ cho client cũ)
 *   transfers: Transfer[]                        // gợi ý tính trên số dư dự kiến
 *   simplify: boolean                            // groups.simplify_debts (BR-09)
 *   view_mismatches: { user_id, official, projected, view_official, view_projected }[]
 * }
 *
 * Sửa lỗi:
 * - BE-01: tính trên MỌI người từng xuất hiện (kể cả LEFT/REMOVED)
 * - BE-13: dùng mã nguồn chung src/domain/settlement.ts, pairwise.ts (bản sinh trong
 *   ../_shared — `npm run sync:shared`), không chép thuật toán. Gợi ý tính trên số dư
 *   dự kiến (BR-06); chế độ theo cặp cũng tính cả PENDING. Đối chiếu với view group_balances.
 * - BE-14: CORS headers trên mọi response kể cả lỗi
 */

// Deno: import URL, không phải module Node (eslint chạy resolver Node)
// eslint-disable-next-line import/no-unresolved
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import {
  computeBalances,
  simplifyDebts,
  type ExpenseInput,
  type PaymentInput,
  type PaymentStatus,
  type Transfer,
} from '../_shared/settlement.ts';
import { pairwiseDebts } from '../_shared/pairwise.ts';

const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, content-type, x-client-info, apikey',
  'Content-Type': 'application/json',
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: corsHeaders });

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/** Ném lỗi khi truy vấn Supabase lỗi (trước đây lỗi bị bỏ qua → kết quả sai mà vẫn 200). */
function must<T>(res: { data: T | null; error: { message: string } | null }, what: string): T {
  if (res.error) throw new HttpError(500, `${what}: ${res.error.message}`);
  return (res.data ?? ([] as unknown)) as T;
}

const toObject = (m: Map<string, number>) => Object.fromEntries([...m.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

    const authHeader = req.headers.get('Authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      return json({ error: 'Missing authorization header' }, 401);
    }

    let groupId: unknown;
    try {
      groupId = (await req.json())?.group_id;
    } catch {
      return json({ error: 'Invalid JSON body' }, 400);
    }
    if (typeof groupId !== 'string' || !groupId) {
      return json({ error: 'Missing group_id' }, 400);
    }

    const serviceClient = createClient(supabaseUrl, supabaseServiceKey);
    const {
      data: { user },
      error: authError,
    } = await serviceClient.auth.getUser(authHeader.slice('Bearer '.length));
    if (authError || !user) {
      return json({ error: 'Invalid token' }, 401);
    }

    // Gợi ý tất toán là dữ liệu hiện tại của nhóm → chỉ thành viên ACTIVE.
    // (Người đã rời chỉ được xem lịch sử tới lúc rời — BE-12 — qua RLS ở app.)
    const membership = await serviceClient
      .from('group_members')
      .select('user_id')
      .eq('group_id', groupId)
      .eq('user_id', user.id)
      .eq('status', 'ACTIVE')
      .maybeSingle();
    if (membership.error) throw new HttpError(500, `membership: ${membership.error.message}`);
    if (!membership.data) {
      return json({ error: 'NOT_MEMBER: Bạn không phải thành viên nhóm này' }, 403);
    }

    const group = must(
      await serviceClient.from('groups').select('simplify_debts').eq('id', groupId).single(),
      'group',
    ) as { simplify_debts: boolean | null };

    const members = must(
      await serviceClient.from('group_members').select('user_id').eq('group_id', groupId),
      'members',
    ) as { user_id: string }[];

    const rawExpenses = must(
      await serviceClient
        .from('expenses')
        .select('id, paid_by, status, expense_shares(user_id, amount)')
        .eq('group_id', groupId),
      'expenses',
    ) as { id: string; paid_by: string; status: string; expense_shares: { user_id: string; amount: number | string }[] }[];

    const rawPayments = must(
      await serviceClient.from('payments').select('from_id, to_id, amount, status').eq('group_id', groupId),
      'payments',
    ) as { from_id: string; to_id: string; amount: number | string; status: string }[];

    const expenses: ExpenseInput[] = rawExpenses.map((e) => ({
      paidBy: e.paid_by,
      status: e.status as ExpenseInput['status'],
      shares: (e.expense_shares ?? []).map((s) => ({ userId: s.user_id, amount: Number(s.amount) })),
    }));

    const payments: PaymentInput[] = rawPayments.map((p) => ({
      fromId: p.from_id,
      toId: p.to_id,
      amount: Number(p.amount),
      status: p.status as PaymentStatus,
    }));

    // BE-01: mọi người từng xuất hiện trong nhóm, khoản chi hoặc thanh toán
    const participantIds = new Set<string>(members.map((m) => m.user_id));
    for (const e of expenses) {
      participantIds.add(e.paidBy);
      for (const s of e.shares) participantIds.add(s.userId);
    }
    for (const p of payments) {
      participantIds.add(p.fromId);
      participantIds.add(p.toId);
    }
    const memberIds = [...participantIds];

    const official = computeBalances(memberIds, expenses, payments);
    const projected = computeBalances(memberIds, expenses, payments, { includePending: true });

    // BR-09 + BR-06: gợi ý luôn tính trên số dư dự kiến (không bảo chuyển lại khoản đang chờ)
    const useSimplify = group.simplify_debts ?? true;
    const transfers: Transfer[] = useSimplify
      ? simplifyDebts(projected)
      : pairwiseDebts(memberIds, expenses, payments, { includePending: true });

    // Đối chiếu với view group_balances (DEV mục 3.5) — chỉ có thành viên ACTIVE
    const viewRows = must(
      await serviceClient
        .from('group_balances')
        .select('user_id, official_balance, projected_balance')
        .eq('group_id', groupId),
      'group_balances',
    ) as { user_id: string; official_balance: number | string; projected_balance: number | string }[];

    const viewMismatches = viewRows
      .filter(
        (r) =>
          Number(r.official_balance) !== (official.get(r.user_id) ?? 0) ||
          Number(r.projected_balance) !== (projected.get(r.user_id) ?? 0),
      )
      .map((r) => ({
        user_id: r.user_id,
        official: official.get(r.user_id) ?? 0,
        projected: projected.get(r.user_id) ?? 0,
        view_official: Number(r.official_balance),
        view_projected: Number(r.projected_balance),
      }));
    if (viewMismatches.length > 0) {
      console.error('settlements: group_balances mismatch', groupId, JSON.stringify(viewMismatches));
    }

    const projectedObj = toObject(projected);
    return json({
      official_balances: toObject(official),
      projected_balances: projectedObj,
      balances: projectedObj,
      transfers,
      simplify: useSimplify,
      view_mismatches: viewMismatches,
    });
  } catch (err) {
    // BE-14: CORS headers on error response
    const status = err instanceof HttpError ? err.status : 500;
    return json({ error: (err as Error).message }, status);
  }
});
