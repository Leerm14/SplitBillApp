/**
 * Edge Function: send-push
 * Gửi push notification qua Expo Push API.
 * Được gọi bởi Database Webhook khi có row mới trong bảng `notifications`.
 *
 * Kích hoạt: trigger public.trigger_push_notification (migration 0010) gọi bằng pg_net,
 * gửi header `x-webhook-secret` (đọc từ Supabase Vault), KHÔNG gửi JWT. Vì vậy hàm này
 * deploy với verify_jwt = false (supabase/config.toml, hoặc
 * `supabase functions deploy send-push --no-verify-jwt`) và tự xác thực bằng secret.
 * Secret của hàm: WEBHOOK_SECRET = giá trị Vault 'webhook_secret'.
 *
 * Sửa lỗi:
 * - SEC-03: Kiểm tra webhook secret (so sánh thời gian hằng — CFG-04/NEW-09)
 * - BE-15: Chia lô 100 tin nhắn cho Expo Push API
 * - BE-14: Thêm CORS headers cho mọi phản hồi
 */

// Deno: import URL, không phải module Node (eslint chạy resolver Node)
// eslint-disable-next-line import/no-unresolved
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

// Nội dung tiếng Việt cho MỌI loại thông báo mà RPC tạo (grep
// `INSERT INTO public.notifications` trong supabase/migrations 0001–0012):
//   EXPENSE_CREATED/UPDATED/CANCELLED, PAYMENT_CREATED/CONFIRMED/REJECTED/DISPUTED/
//   CANCELLED, MEMBER_JOINED/LEFT/REMOVED, OWNERSHIP_RECEIVED/TRANSFERRED,
//   FRIEND_REQUEST/ACCEPTED/DECLINED, GROUP_INVITED (0012, kèm invite_id).
// Thêm loại mới trong migration → thêm vào đây (loại lạ rơi về nội dung chung).
function getNotificationContent(
  type: string,
  groupName?: string,
  actorName?: string,
): { title: string; body: string } {
  const inGroup = groupName ? ` trong nhóm "${groupName}"` : '';
  const group = groupName ? ` "${groupName}"` : '';
  const actor = actorName && actorName.trim() !== '' ? actorName : 'Ai đó';
  const map: Record<string, { title: string; body: string }> = {
    // Khoản chi
    EXPENSE_CREATED: { title: 'Khoản chi mới', body: `Có khoản chi mới${inGroup}` },
    EXPENSE_UPDATED: { title: 'Khoản chi đã sửa', body: `Một khoản chi đã được sửa${inGroup}` },
    EXPENSE_CANCELLED: { title: 'Khoản chi đã hủy', body: `Một khoản chi đã bị hủy${inGroup}` },
    // Thanh toán
    PAYMENT_CREATED: { title: 'Thanh toán chờ xác nhận', body: `Bạn có khoản thanh toán cần xác nhận${inGroup}` },
    PAYMENT_CONFIRMED: { title: 'Thanh toán đã xác nhận', body: `Khoản thanh toán của bạn đã được xác nhận${inGroup}` },
    PAYMENT_REJECTED: { title: 'Thanh toán bị từ chối', body: `Khoản thanh toán của bạn đã bị từ chối${inGroup}` },
    PAYMENT_DISPUTED: { title: 'Thanh toán bị báo sai lệch', body: `Một khoản thanh toán bị báo sai lệch${inGroup}` },
    PAYMENT_CANCELLED: { title: 'Thanh toán đã hủy', body: `Một khoản thanh toán đã bị hủy${inGroup}` },
    // Thành viên nhóm
    MEMBER_JOINED: { title: 'Thành viên mới', body: `${actor} đã tham gia nhóm${group}` },
    MEMBER_LEFT: { title: 'Thành viên rời nhóm', body: `Một thành viên đã rời nhóm${group}` },
    MEMBER_REMOVED: { title: 'Bạn đã bị xóa khỏi nhóm', body: `Bạn không còn là thành viên của nhóm${group}` },
    OWNERSHIP_RECEIVED: { title: 'Bạn là chủ nhóm mới', body: `Bạn đã được chuyển quyền chủ nhóm${group}` },
    OWNERSHIP_TRANSFERRED: { title: 'Đã chuyển quyền chủ nhóm', body: `Bạn đã chuyển quyền chủ nhóm${group}` },
    // Lời mời đích danh (MVP-06): "<tên người mời> mời bạn vào nhóm <tên nhóm>"
    GROUP_INVITED: { title: 'Lời mời vào nhóm', body: `${actor} mời bạn vào nhóm${group}` },
    // Bạn bè
    FRIEND_REQUEST: { title: 'Lời mời kết bạn', body: `${actor} muốn kết bạn với bạn` },
    FRIEND_ACCEPTED: { title: 'Đã trở thành bạn bè', body: `${actor} đã chấp nhận lời mời kết bạn` },
    FRIEND_DECLINED: { title: 'Lời mời kết bạn', body: `${actor} đã từ chối lời mời kết bạn` },
  };
  return map[type] ?? { title: 'Thông báo', body: `Bạn có thông báo mới${inGroup}` };
}

/**
 * So sánh secret trong thời gian hằng: băm SHA-256 hai chuỗi (độ dài cố định 32 byte)
 * rồi XOR từng byte — thời gian không phụ thuộc vị trí ký tự sai đầu tiên.
 */
async function secretsEqual(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(a)),
    crypto.subtle.digest('SHA-256', enc.encode(b)),
  ]);
  const va = new Uint8Array(ha);
  const vb = new Uint8Array(hb);
  let diff = 0;
  for (let i = 0; i < va.length; i++) diff |= va[i] ^ vb[i];
  return diff === 0;
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
    if (req.method !== 'POST') {
      return new Response(
        JSON.stringify({ error: 'Method not allowed' }),
        { status: 405, headers: corsHeaders },
      );
    }

    // SEC-03: Kiểm tra webhook secret (không dùng JWT — verify_jwt = false)
    if (!webhookSecret) {
      console.error('send-push: WEBHOOK_SECRET is not configured');
      return new Response(
        JSON.stringify({ error: 'Webhook secret not configured' }),
        { status: 500, headers: corsHeaders },
      );
    }
    const requestSecret = req.headers.get('x-webhook-secret') ?? '';
    if (!(await secretsEqual(requestSecret, webhookSecret))) {
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
      .select('id, user_id, type, group_id, expense_id, payment_id, actor_id, invite_id, created_at')
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

    // Tên người thực hiện (thông báo bạn bè, MEMBER_JOINED, GROUP_INVITED)
    let actorName: string | undefined;
    if (record.actor_id) {
      const { data: actor } = await supabase
        .from('profiles')
        .select('display_name')
        .eq('id', record.actor_id)
        .single();
      actorName = actor?.display_name;
    }

    const { title, body } = getNotificationContent(record.type, groupName, actorName);

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
        // Thông báo bạn bè: app mở hồ sơ người này (/user/<actor_id>)
        actor_id: record.actor_id,
        // GROUP_INVITED: app gọi accept_invite_by_id(invite_id)
        invite_id: record.invite_id,
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
