/**
 * Edge Function: delete-account
 * Xóa tài khoản người dùng theo yêu cầu.
 *
 * POST /delete-account
 * Headers: Authorization: Bearer <user_token>
 *
 * Quy trình:
 * 1. Kiểm tra user không phải chủ nhóm ACTIVE nào (BE-05: chặn chủ nhóm)
 * 2. Kiểm tra user không còn số dư khác 0 ở bất kỳ nhóm nào
 * 3. Kiểm tra user không có thanh toán PENDING
 * 4. Ẩn danh hồ sơ (display_name, avatar, searchable) — không xóa dòng (BE-05)
 * 5. Xóa push tokens
 * 6. Xóa avatar file trong storage
 * 7. Set deleted_at trên profiles
 * 8. Rời tất cả nhóm
 * 9. Xóa friendships (BE-04: dùng đúng tên cột)
 * 10. Xóa payment handles
 * 11. Xóa tài khoản Auth
 *
 * Sửa lỗi: BE-04, BE-05, BE-14, APP-21
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

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

    // Verify user
    const serviceClient = createClient(supabaseUrl, supabaseServiceKey);
    const {
      data: { user },
      error: authError,
    } = await serviceClient.auth.getUser(authHeader.replace('Bearer ', ''));

    if (authError || !user) {
      return new Response(
        JSON.stringify({ error: 'Invalid or expired token' }),
        { status: 401, headers: corsHeaders },
      );
    }

    const userId = user.id;

    // BE-05: Kiểm tra user không phải chủ nhóm ACTIVE nào — phải chuyển quyền trước
    const { data: ownedGroups, error: ownedError } = await serviceClient
      .from('groups')
      .select('id, name')
      .eq('owner_id', userId)
      .eq('status', 'ACTIVE');

    if (ownedError) {
      return new Response(
        JSON.stringify({ error: 'Lỗi kiểm tra nhóm sở hữu' }),
        { status: 500, headers: corsHeaders },
      );
    }

    if (ownedGroups && ownedGroups.length > 0) {
      const groupNames = ownedGroups.map((g: any) => g.name).join(', ');
      return new Response(
        JSON.stringify({
          error: 'Bạn đang là chủ nhóm',
          details: `Vui lòng chuyển quyền chủ nhóm trước khi xóa tài khoản. Nhóm: ${groupNames}`,
          group_ids: ownedGroups.map((g: any) => g.id),
        }),
        { status: 400, headers: corsHeaders },
      );
    }

    // 1. Kiểm tra số dư ở tất cả nhóm
    const { data: balances, error: balError } = await serviceClient
      .from('group_balances')
      .select('group_id, official_balance')
      .eq('user_id', userId);

    if (balError) {
      return new Response(
        JSON.stringify({ error: 'Lỗi kiểm tra số dư' }),
        { status: 500, headers: corsHeaders },
      );
    }

    const nonZeroGroups = (balances ?? []).filter((b: any) => Number(b.official_balance) !== 0);
    if (nonZeroGroups.length > 0) {
      const groupIds = nonZeroGroups.map((b: any) => b.group_id);
      return new Response(
        JSON.stringify({
          error: 'Bạn còn số dư chưa thanh toán',
          details: `Còn ${nonZeroGroups.length} nhóm chưa thanh toán hết`,
          group_ids: groupIds,
        }),
        { status: 400, headers: corsHeaders },
      );
    }

    // 2. Kiểm tra thanh toán PENDING
    const { count: pendingCount, error: pendingError } = await serviceClient
      .from('payments')
      .select('id', { count: 'exact', head: true })
      .or(`from_id.eq.${userId},to_id.eq.${userId}`)
      .eq('status', 'PENDING');

    if (pendingError) {
      return new Response(
        JSON.stringify({ error: 'Lỗi kiểm tra thanh toán' }),
        { status: 500, headers: corsHeaders },
      );
    }

    if ((pendingCount ?? 0) > 0) {
      return new Response(
        JSON.stringify({
          error: 'Bạn còn thanh toán đang chờ xử lý',
          details: `Có ${pendingCount} thanh toán chưa hoàn tất`,
        }),
        { status: 400, headers: corsHeaders },
      );
    }

    // 3. Lấy thông tin profile trước khi ẩn danh
    const { data: profile } = await serviceClient
      .from('profiles')
      .select('avatar_path')
      .eq('id', userId)
      .single();

    // 4. BE-05: Ẩn danh hồ sơ (không xóa dòng, giữ lịch sử)
    // APP-21: Đây là ẩn danh, không phải "xóa vĩnh viễn"
    const { error: anonError } = await serviceClient
      .from('profiles')
      .update({
        display_name: 'Người dùng đã xóa',
        avatar_path: null,
        searchable: false,
        deleted_at: new Date().toISOString(),
        user_code: `DEL_${userId.slice(0, 8)}`,
      })
      .eq('id', userId);

    if (anonError) {
      return new Response(
        JSON.stringify({ error: 'Lỗi ẩn danh hồ sơ' }),
        { status: 500, headers: corsHeaders },
      );
    }

    // 5. Xóa push tokens
    const { error: tokenError } = await serviceClient
      .from('push_tokens')
      .delete()
      .eq('user_id', userId);

    if (tokenError) {
      console.error('Failed to delete push tokens:', tokenError.message);
    }

    // 6. Xóa avatar từ storage (nếu có)
    if (profile?.avatar_path) {
      await serviceClient.storage
        .from('avatars')
        .remove([profile.avatar_path]);
    }

    // 7. Rời tất cả nhóm (set status = LEFT)
    const { error: leaveError } = await serviceClient
      .from('group_members')
      .update({
        status: 'LEFT',
        left_at: new Date().toISOString(),
      })
      .eq('user_id', userId)
      .eq('status', 'ACTIVE');

    if (leaveError) {
      console.error('Failed to leave groups:', leaveError.message);
    }

    // 8. BE-04: Xóa friendships — sửa đúng tên cột (requester_id/addressee_id)
    const { error: friendError } = await serviceClient
      .from('friendships')
      .delete()
      .or(`requester_id.eq.${userId},addressee_id.eq.${userId}`);

    if (friendError) {
      console.error('Failed to delete friendships:', friendError.message);
    }

    // 9. Xóa payment handles
    const { error: handleError } = await serviceClient
      .from('payment_handles')
      .delete()
      .eq('user_id', userId);

    if (handleError) {
      console.error('Failed to delete payment handles:', handleError.message);
    }

    // 10. Xóa tài khoản Auth — profile đã ẩn danh nên FK không bị ảnh hưởng
    // BE-05: Không cascade xóa profiles (đã ẩn danh ở bước 4)
    const { error: deleteError } = await serviceClient.auth.admin.deleteUser(userId);
    if (deleteError) {
      console.error('Failed to delete auth user:', deleteError.message);
      // Profile đã ẩn danh nên vẫn an toàn
    }

    return new Response(
      JSON.stringify({
        success: true,
        // APP-21: Sửa câu chữ — ẩn danh và giữ lịch sử, không phải "xóa vĩnh viễn"
        message: 'Tài khoản đã được ẩn danh. Lịch sử giao dịch được giữ lại để đảm bảo tính chính xác cho các thành viên khác.',
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
