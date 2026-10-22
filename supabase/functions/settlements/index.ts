/**
 * Edge Function: settlements
 * Đối chiếu gợi ý tất toán phía server.
 *
 * POST /settlements
 * Body: { group_id: string }
 * Response: { balances: Record<string, number>, transfers: Transfer[], simplify: boolean }
 *
 * Sửa lỗi:
 * - BE-01: Dùng ALL members (kể cả LEFT/REMOVED) thay vì chỉ ACTIVE
 * - BE-13: Hỗ trợ chế độ pairwise khi simplify_debts = false
 * - BE-14: CORS headers trên mọi response kể cả lỗi
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// ── Domain types & logic (copy từ src/domain/settlement.ts) ──────────

type ExpenseInput = {
  paidBy: string;
  status: 'ACTIVE' | 'CANCELLED';
  shares: { userId: string; amount: number }[];
};

type PaymentStatus = 'PENDING' | 'CONFIRMED' | 'REJECTED' | 'DISPUTED' | 'CANCELLED';

type PaymentInput = {
  fromId: string;
  toId: string;
  amount: number;
  status: PaymentStatus;
};

type Transfer = { from: string; to: string; amount: number };

const EXACT_LIMIT = 20;

function computeBalances(
  memberIds: string[],
  expenses: ExpenseInput[],
  payments: PaymentInput[],
  opts: { includePending?: boolean } = {},
): Map<string, number> {
  const bal = new Map<string, number>(memberIds.map((id) => [id, 0]));
  const add = (id: string, v: number) => {
    if (!bal.has(id)) {
      // BE-01: Thêm người chưa có trong danh sách (LEFT/REMOVED)
      bal.set(id, 0);
    }
    bal.set(id, bal.get(id)! + v);
  };

  for (const e of expenses) {
    if (e.status !== 'ACTIVE') continue;
    let total = 0;
    for (const s of e.shares) {
      add(s.userId, -s.amount);
      total += s.amount;
    }
    add(e.paidBy, total);
  }

  for (const p of payments) {
    const counted = p.status === 'CONFIRMED' || (opts.includePending && p.status === 'PENDING');
    if (!counted) continue;
    add(p.fromId, p.amount);
    add(p.toId, -p.amount);
  }
  return bal;
}

function simplifyDebts(balances: Map<string, number>): Transfer[] {
  const people = [...balances.entries()]
    .filter(([, v]) => v !== 0)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  let sum = 0;
  for (const [id, v] of people) {
    if (!Number.isSafeInteger(v)) throw new Error(`Số dư không phải số nguyên VND: ${id}`);
    sum += v;
  }
  if (sum !== 0) throw new Error(`Tổng số dư phải bằng 0, đang là ${sum}`);
  if (people.length === 0) return [];

  if (people.length > EXACT_LIMIT) return pairEqualsFirst(people);
  return splitZeroSumGroups(people).flatMap(greedySettle);
}

function splitZeroSumGroups(people: [string, number][]): [string, number][][] {
  const n = people.length;
  const full = (1 << n) - 1;
  const total = new Float64Array(1 << n);
  const dp = new Int32Array(1 << n);

  for (let mask = 1; mask <= full; mask++) {
    const low = 31 - Math.clz32(mask & -mask);
    total[mask] = total[mask & (mask - 1)] + people[low][1];
    let best = 0;
    for (let i = 0; i < n; i++) {
      if (mask & (1 << i)) best = Math.max(best, dp[mask ^ (1 << i)]);
    }
    dp[mask] = best + (total[mask] === 0 ? 1 : 0);
  }

  const groups: [string, number][][] = [];
  let mask = full;
  let groupStart = full;
  while (mask) {
    const need = dp[mask] - (total[mask] === 0 ? 1 : 0);
    let next = -1;
    for (let i = 0; i < n; i++) {
      if (mask & (1 << i) && dp[mask ^ (1 << i)] === need) {
        next = mask ^ (1 << i);
        break;
      }
    }
    mask = next;
    if (total[mask] === 0) {
      const diff = groupStart ^ mask;
      groups.push(people.filter((_, i) => diff & (1 << i)));
      groupStart = mask;
    }
  }
  return groups;
}

function greedySettle(group: [string, number][]): Transfer[] {
  const creditors = group.filter(([, v]) => v > 0).map(([id, v]) => ({ id, v }));
  const debtors = group.filter(([, v]) => v < 0).map(([id, v]) => ({ id, v: -v }));
  const byAmountThenId = (a: { id: string; v: number }, b: { id: string; v: number }) =>
    b.v - a.v || (a.id < b.id ? -1 : 1);
  const out: Transfer[] = [];

  while (creditors.length && debtors.length) {
    creditors.sort(byAmountThenId);
    debtors.sort(byAmountThenId);
    const c = creditors[0];
    const d = debtors[0];
    const amount = Math.min(c.v, d.v);
    out.push({ from: d.id, to: c.id, amount });
    c.v -= amount;
    d.v -= amount;
    if (c.v === 0) creditors.shift();
    if (d.v === 0) debtors.shift();
  }
  return out;
}

function pairEqualsFirst(people: [string, number][]): Transfer[] {
  const out: Transfer[] = [];
  const rest = new Map(people);
  const creditorsByAmount = new Map<number, string[]>();
  for (const [id, v] of people) {
    if (v > 0) creditorsByAmount.set(v, [...(creditorsByAmount.get(v) ?? []), id]);
  }
  for (const [id, v] of people) {
    if (v >= 0) continue;
    const match = creditorsByAmount.get(-v);
    if (match?.length) {
      const to = match.shift()!;
      out.push({ from: id, to, amount: -v });
      rest.delete(id);
      rest.delete(to);
    }
  }
  return [...out, ...greedySettle([...rest.entries()])];
}

/**
 * BE-13: Tính nợ theo cặp (pairwise) khi simplify_debts = false
 */
function pairwiseDebts(
  expenses: ExpenseInput[],
  payments: PaymentInput[],
): Transfer[] {
  const pairMap = new Map<string, number>();

  const pairKey = (u1: string, u2: string): string =>
    u1 < u2 ? `${u1}|${u2}` : `${u2}|${u1}`;

  const addDebt = (from: string, to: string, amount: number) => {
    if (from === to || amount === 0) return;
    const key = pairKey(from, to);
    const current = pairMap.get(key) ?? 0;
    if (from < to) {
      pairMap.set(key, current + amount);
    } else {
      pairMap.set(key, current - amount);
    }
  };

  for (const exp of expenses) {
    if (exp.status !== 'ACTIVE') continue;
    for (const share of exp.shares) {
      if (share.userId !== exp.paidBy) {
        addDebt(share.userId, exp.paidBy, share.amount);
      }
    }
  }

  for (const pay of payments) {
    if (pay.status !== 'CONFIRMED') continue;
    addDebt(pay.toId, pay.fromId, pay.amount);
  }

  const transfers: Transfer[] = [];
  for (const [key, netAmount] of pairMap) {
    if (Math.abs(netAmount) < 1) continue;
    const [a, b] = key.split('|');
    if (netAmount > 0) {
      transfers.push({ from: a, to: b, amount: netAmount });
    } else {
      transfers.push({ from: b, to: a, amount: -netAmount });
    }
  }
  return transfers.sort((a, b) => b.amount - a.amount);
}

// ── Edge Function Handler ──────────────────────────────────────────

const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, content-type, x-client-info, apikey',
  'Content-Type': 'application/json',
};

Deno.serve(async (req) => {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    // Auth: lấy token từ header
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      return new Response(
        JSON.stringify({ error: 'Missing authorization header' }),
        { status: 401, headers: corsHeaders },
      );
    }

    // Parse body
    const { group_id } = await req.json();
    if (!group_id) {
      return new Response(
        JSON.stringify({ error: 'Missing group_id' }),
        { status: 400, headers: corsHeaders },
      );
    }

    // Verify user
    const serviceClient = createClient(supabaseUrl, supabaseServiceKey);
    const {
      data: { user },
    } = await serviceClient.auth.getUser(authHeader.replace('Bearer ', ''));
    if (!user) {
      return new Response(
        JSON.stringify({ error: 'Invalid token' }),
        { status: 401, headers: corsHeaders },
      );
    }

    // Kiểm tra membership
    const { data: membership } = await serviceClient
      .from('group_members')
      .select('user_id')
      .eq('group_id', group_id)
      .eq('user_id', user.id)
      .in('status', ['ACTIVE', 'LEFT']) // BE-12: LEFT members cũng có thể xem
      .single();

    if (!membership) {
      return new Response(
        JSON.stringify({ error: 'Bạn không phải thành viên nhóm này' }),
        { status: 403, headers: corsHeaders },
      );
    }

    // Lấy group info
    const { data: group } = await serviceClient
      .from('groups')
      .select('simplify_debts')
      .eq('id', group_id)
      .single();

    // BE-01: Lấy TẤT CẢ members (kể cả LEFT/REMOVED) để không throw Unknown member
    const { data: members } = await serviceClient
      .from('group_members')
      .select('user_id')
      .eq('group_id', group_id);

    const memberIds = (members ?? []).map((m: any) => m.user_id);

    // Lấy expenses
    const { data: rawExpenses } = await serviceClient
      .from('expenses')
      .select('paid_by, status, id')
      .eq('group_id', group_id);

    // Lấy expense shares
    const expenseIds = (rawExpenses ?? []).map((e: any) => e.id);
    const { data: rawShares } = await serviceClient
      .from('expense_shares')
      .select('expense_id, user_id, amount')
      .in('expense_id', expenseIds.length > 0 ? expenseIds : ['00000000-0000-0000-0000-000000000000']);

    // Map shares to expenses
    const sharesMap = new Map<string, { userId: string; amount: number }[]>();
    for (const s of rawShares ?? []) {
      if (!sharesMap.has(s.expense_id)) sharesMap.set(s.expense_id, []);
      sharesMap.get(s.expense_id)!.push({ userId: s.user_id, amount: Number(s.amount) });
    }

    const expenses: ExpenseInput[] = (rawExpenses ?? []).map((e: any) => ({
      paidBy: e.paid_by,
      status: e.status as 'ACTIVE' | 'CANCELLED',
      shares: sharesMap.get(e.id) ?? [],
    }));

    // Lấy payments
    const { data: rawPayments } = await serviceClient
      .from('payments')
      .select('from_id, to_id, amount, status')
      .eq('group_id', group_id);

    const payments: PaymentInput[] = (rawPayments ?? []).map((p: any) => ({
      fromId: p.from_id,
      toId: p.to_id,
      amount: Number(p.amount),
      status: p.status as PaymentStatus,
    }));

    // Tính balances — BE-13: dùng số dư dự kiến (includePending) theo BR-06
    const balances = computeBalances(memberIds, expenses, payments, { includePending: true });
    const balancesObj: Record<string, number> = {};
    for (const [k, v] of balances) {
      balancesObj[k] = v;
    }

    // Tính transfers — BE-13: hỗ trợ cả pairwise
    const useSimplify = group?.simplify_debts ?? true;
    let transfers: Transfer[];
    if (useSimplify) {
      // Dùng official balances cho simplify
      const officialBalances = computeBalances(memberIds, expenses, payments);
      transfers = simplifyDebts(officialBalances);
    } else {
      // BE-13: Pairwise debts
      transfers = pairwiseDebts(expenses, payments);
    }

    return new Response(
      JSON.stringify({
        balances: balancesObj,
        transfers,
        simplify: useSimplify,
      }),
      { status: 200, headers: corsHeaders },
    );
  } catch (err) {
    // BE-14: CORS headers on error response
    return new Response(
      JSON.stringify({ error: (err as Error).message }),
      { status: 500, headers: corsHeaders },
    );
  }
});
