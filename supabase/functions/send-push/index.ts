/**
 * Edge Function: send-push
 * Gửi push notification qua Expo Push API.
 * Được gọi bởi Database Webhook khi có row mới trong bảng `notifications`.
 *
 * Sửa lỗi:
 * - SEC-03: Kiểm tra webhook secret
 * - BE-15: Chia lô 100 tin nhắn cho Expo Push API
 * - BE-14: Thêm CORS headers cho mọi phản hồi
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
// SEC-03: Webhook secret để xác thực request từ Database Webhook
const webhookSecret = Deno.env.get('WEBHOOK_SECRET') ?? '';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, content-type, x-client-info, apikey, x-webhook-secret',
  'Content-Type': 'application/json',
};

interface NotificationRecord {
  id: string;
  user_id: string;
  type: string;
  group_id: string | null;
  expense_id: string | null;
  payment_id: string | null;
  created_at: string;
}

// Map notification type to Vietnamese title/body
function getNotificationContent(type: string, groupName?: string): { title: string; body: string } {
  const group = groupName ? ` trong "${groupName}"` : '';
  const map: Record<string, { title: string; body: string }> = {
    EXPENSE_CREATED: { title: 'Khoản chi mới', body: `Có khoản chi mới${group}` },
    EXPENSE_UPDATED: { title: 'Khoản chi đã sửa', body: `Khoản chi đã được sửa${group}` },
    EXPENSE_CANCELLED: { title: 'Khoản chi đã hủy', body: `Khoản chi đã bị hủy${group}` },
    PAYMENT_CREATED: { title: 'Yêu cầu thanh toán', body: `Có yêu cầu thanh toán mới${group}` },
    PAYMENT_CONFIRMED: { title: 'Thanh toán đã xác nhận', body: `Thanh toán đã được xác nhận${group}` },
    PAYMENT_REJECTED: { title: 'Thanh toán bị từ chối', body: `Thanh toán đã bị từ chối${group}` },
    PAYMENT_DISPUTED: { title: 'Báo sai lệch', body: `Thanh toán bị báo sai lệch${group}` },
    PAYMENT_CANCELLED: { title: 'Thanh toán đã hủy', body: `Thanh toán đã bị hủy${group}` },
    MEMBER_JOINED: { title: 'Thành viên mới', body: `Có thành viên mới${group}` },
    MEMBER_REMOVED: { title: 'Thành viên bị xóa', body: `Có thành viên bị xóa${group}` },
    INVITE_CREATED: { title: 'Lời mời mới', body: `Bạn được mời vào nhóm${group ? group : ''}` },
    INVITE_ACCEPTED: { title: 'Lời mời đã chấp nhận', body: `Lời mời đã được chấp nhận${group}` },
    GROUP_UPDATED: { title: 'Nhóm đã cập nhật', body: `Thông tin nhóm đã thay đổi${group}` },
    SUGGESTION_CHANGED: { title: 'Gợi ý thay đổi', body: `Gợi ý tất toán đã thay đổi${group}` },
  };
  return map[type] ?? { title: 'Thông báo', body: `Bạn có thông báo mới${group}` };
}

/**
 * BE-15: Chia danh sách messages thành các lô tối đa 100 tin
 */
function chunkArray<T>(arr: T[], chunkSize: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += chunkSize) {
    chunks.push(arr.slice(i, i + chunkSize));
  }
  return chunks;
}

Deno.serve(async (req) => {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    // SEC-03: Kiểm tra webhook secret
    const requestSecret = req.headers.get('x-webhook-secret') ?? '';
    if (!webhookSecret || requestSecret !== webhookSecret) {
      return new Response(
        JSON.stringify({ error: 'Unauthorized: invalid webhook secret' }),
        { status: 401, headers: corsHeaders },
      );
    }

    const payload = await req.json();

    // SEC-03: Đọc lại bản ghi từ DB theo id thay vì tin payload
    const notificationId = payload?.record?.id;
    if (!notificationId) {
      return new Response(
        JSON.stringify({ error: 'Missing notification id in payload' }),
        { status: 400, headers: corsHeaders },
      );
    }

    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // Đọc lại bản ghi thực từ DB (không tin payload)
    const { data: record, error: recordError } = await supabase
      .from('notifications')
      .select('id, user_id, type, group_id, expense_id, payment_id, created_at')
      .eq('id', notificationId)
      .single();

    if (recordError || !record) {
      return new Response(
        JSON.stringify({ error: 'Notification not found' }),
        { status: 404, headers: corsHeaders },
      );
    }

    // Get user's push tokens
    const { data: tokens, error: tokenError } = await supabase
      .from('push_tokens')
      .select('expo_token')
      .eq('user_id', record.user_id);

    if (tokenError || !tokens || tokens.length === 0) {
      return new Response(
        JSON.stringify({ message: 'No push tokens found' }),
        { status: 200, headers: corsHeaders },
      );
    }

    // Get group name if available
    let groupName: string | undefined;
    if (record.group_id) {
      const { data: group } = await supabase
        .from('groups')
        .select('name')
        .eq('id', record.group_id)
        .single();
      groupName = group?.name;
    }

    const { title, body } = getNotificationContent(record.type, groupName);

    // Build Expo push messages
    const messages = tokens.map((t: any) => ({
      to: t.expo_token,
      sound: 'default',
      title,
      body,
      data: {
        notification_id: record.id,
        type: record.type,
        group_id: record.group_id,
        expense_id: record.expense_id,
        payment_id: record.payment_id,
      },
    }));

    // BE-15: Chia lô tối đa 100 tin và gửi tuần tự
    const chunks = chunkArray(messages, 100);
    const allInvalidTokens: string[] = [];

    for (const chunk of chunks) {
      const response = await fetch('https://exp.host/--/api/v2/push/send', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        body: JSON.stringify(chunk),
      });

      const result = await response.json();

      // Handle invalid tokens
      if (result.data) {
        for (let i = 0; i < result.data.length; i++) {
          if (
            result.data[i].status === 'error' &&
            result.data[i].details?.error === 'DeviceNotRegistered'
          ) {
            // Find the token that corresponds to this chunk index
            const chunkStartIndex = chunks.indexOf(chunk) * 100;
            allInvalidTokens.push(tokens[chunkStartIndex + i].expo_token);
          }
        }
      }
    }

    // Delete invalid tokens
    if (allInvalidTokens.length > 0) {
      await supabase
        .from('push_tokens')
        .delete()
        .in('expo_token', allInvalidTokens);
    }

    return new Response(
      JSON.stringify({ sent: messages.length }),
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
