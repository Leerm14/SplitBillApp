/**
 * Edge Function: delete-account
 * Xóa tài khoản theo yêu cầu: ẩn danh hồ sơ, GIỮ lịch sử tài chính, xóa user Auth.
 *
 * POST /delete-account
 * Headers: Authorization: Bearer <user_token>
 *
 * Quy trình (BE-04, BE-05):
 * 1. Xác thực người gọi.
 * 2. Kiểm tra trước để báo lỗi dễ hiểu (chủ nhóm ACTIVE, số dư ≠ 0, thanh toán PENDING).
 * 3. RPC public.anonymize_account(_user_id) (chỉ service_role gọi được) — MỌI bước DB trong
 *    một giao dịch: khóa nhóm, kiểm tra lại các điều kiện trên, rời nhóm, thu hồi lời mời,
 *    xóa friendships / push_tokens / payment_handles / thông báo, ẩn danh hồ sơ.
 *    Bước nào lỗi → rollback toàn bộ → trả 409/500.
 * 4. Xóa ảnh đại diện trong bucket avatars (thư mục <user_id>/).
 * 5. Xóa user Auth. profiles không còn FK CASCADE tới auth.users (migration 0010) nên hồ sơ
 *    ẩn danh ở lại làm "bia mộ" cho lịch sử nhóm.
 *
 * Chỉ trả 200 khi mọi bước thành công. Gọi lại sau khi lỗi ở bước 4/5 là an toàn:
 * anonymize_account trả already_anonymized = true và các bước sau chạy lại.
 *
 * Sửa lỗi: BE-04, BE-05, BE-14, APP-21
 */

// Deno: import URL, không phải module Node (eslint chạy resolver Node)
// eslint-disable-next-line import/no-unresolved
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, content-type, x-client-info, apikey',
  'Content-Type': 'application/json',
};

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), { status, headers: corsHeaders });

/** Lỗi nghiệp vụ do anonymize_account raise → 409 (người dùng cần xử lý trước). */
const BUSINESS_CODES: Record<string, string> = {
  OWNER_OF_ACTIVE_GROUP: 'Bạn đang là chủ nhóm. Vui lòng chuyển quyền chủ nhóm trước khi xóa tài khoản.',
  NONZERO_BALANCE: 'Bạn còn số dư chưa thanh toán.',
  PENDING_PAYMENTS: 'Bạn còn thanh toán đang chờ xử lý.',
};

/** Xóa mọi file trong thư mục avatars/<userId>/ (không phụ thuộc avatar_path đã bị xóa). */
async function removeAvatarFolder(client: ReturnType<typeof createClient>, userId: string): Promise<string | null> {
  for (let round = 0; round < 20; round++) {
    const { data: files, error: listError } = await client.storage
      .from('avatars')
      .list(userId, { limit: 100 });
    if (listError) return listError.message;
    const paths = (files ?? []).filter((f) => f.name).map((f) => `${userId}/${f.name}`);
    if (paths.length === 0) return null;
    const { error: removeError } = await client.storage.from('avatars').remove(paths);
    if (removeError) return removeError.message;
  }
  return 'Too many avatar files';
}

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

    const serviceClient = createClient(supabaseUrl, supabaseServiceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const {
      data: { user },
      error: authError,
    } = await serviceClient.auth.getUser(authHeader.slice('Bearer '.length));

    if (authError || !user) {
      return json({ error: 'Invalid or expired token' }, 401);
    }

    const userId = user.id;

    // ── 2. Kiểm tra trước (thông báo chi tiết). anonymize_account kiểm tra lại có khóa. ──
    const { data: ownedGroups, error: ownedError } = await serviceClient
      .from('groups')
      .select('id, name')
      .eq('owner_id', userId)
      .eq('status', 'ACTIVE');
    if (ownedError) return json({ error: 'Lỗi kiểm tra nhóm sở hữu', details: ownedError.message }, 500);
    if (ownedGroups && ownedGroups.length > 0) {
      return json(
        {
          error: 'OWNER_OF_ACTIVE_GROUP: Bạn đang là chủ nhóm',
          details: `Vui lòng chuyển quyền chủ nhóm trước khi xóa tài khoản. Nhóm: ${ownedGroups.map((g) => g.name).join(', ')}`,
          group_ids: ownedGroups.map((g) => g.id),
        },
        409,
      );
    }

    const { data: balances, error: balError } = await serviceClient
      .from('group_balances')
      .select('group_id, official_balance')
      .eq('user_id', userId);
    if (balError) return json({ error: 'Lỗi kiểm tra số dư', details: balError.message }, 500);
    const nonZeroGroups = (balances ?? []).filter((b) => Number(b.official_balance) !== 0);
    if (nonZeroGroups.length > 0) {
      return json(
        {
          error: 'NONZERO_BALANCE: Bạn còn số dư chưa thanh toán',
          details: `Còn ${nonZeroGroups.length} nhóm chưa thanh toán hết`,
          group_ids: nonZeroGroups.map((b) => b.group_id),
        },
        409,
      );
    }

    const { count: pendingCount, error: pendingError } = await serviceClient
      .from('payments')
      .select('id', { count: 'exact', head: true })
      .or(`from_id.eq.${userId},to_id.eq.${userId}`)
      .eq('status', 'PENDING');
    if (pendingError) return json({ error: 'Lỗi kiểm tra thanh toán', details: pendingError.message }, 500);
    if ((pendingCount ?? 0) > 0) {
      return json(
        {
          error: 'PENDING_PAYMENTS: Bạn còn thanh toán đang chờ xử lý',
          details: `Có ${pendingCount} thanh toán chưa hoàn tất`,
        },
        409,
      );
    }

    // ── 3. Mọi bước DB trong một giao dịch ──
    const { data: anonResult, error: anonError } = await serviceClient.rpc('anonymize_account', {
      _user_id: userId,
    });
    if (anonError) {
      const code = /^([A-Z][A-Z0-9_]+):/.exec(anonError.message ?? '')?.[1];
      if (code && BUSINESS_CODES[code]) {
        return json({ error: `${code}: ${BUSINESS_CODES[code]}`, details: anonError.message }, 409);
      }
      console.error('delete-account: anonymize_account failed', anonError.message);
      return json({ error: 'Lỗi ẩn danh tài khoản', details: anonError.message }, 500);
    }

    // ── 4. Ảnh đại diện ──
    const avatarError = await removeAvatarFolder(serviceClient, userId);
    if (avatarError) {
      console.error('delete-account: avatar removal failed', avatarError);
      return json({ error: 'Lỗi xóa ảnh đại diện. Vui lòng thử lại.', details: avatarError }, 500);
    }

    // ── 5. User Auth (hồ sơ ẩn danh được giữ lại) ──
    const { error: deleteError } = await serviceClient.auth.admin.deleteUser(userId);
    if (deleteError) {
      console.error('delete-account: deleteUser failed', deleteError.message);
      return json({ error: 'Lỗi xóa tài khoản đăng nhập. Vui lòng thử lại.', details: deleteError.message }, 500);
    }

    return json(
      {
        success: true,
        already_anonymized: (anonResult as { already_anonymized?: boolean } | null)?.already_anonymized ?? false,
        // APP-21: ẩn danh và giữ lịch sử, không phải "xóa vĩnh viễn"
        message: 'Tài khoản đã được xóa. Hồ sơ được ẩn danh, lịch sử giao dịch được giữ lại cho các thành viên khác.',
      },
      200,
    );
  } catch (err) {
    // BE-14: CORS headers on error response
    return json({ error: (err as Error).message }, 500);
  }
});
