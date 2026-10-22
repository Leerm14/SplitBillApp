/**
 * Edge Function: cloudinary-sign
 * Ký upload / xóa ảnh trên Cloudinary (MVP-00, phương án A — mục 4.3).
 * Chỉ ảnh đại diện và ảnh nhóm. Ảnh hóa đơn giữ Supabase Storage bucket `receipts`
 * (riêng tư theo nhóm) — KHÔNG ký ở đây.
 *
 * POST /cloudinary-sign
 * Headers: Authorization: Bearer <user_token>
 *
 * Ký upload:
 *   Body: { action: 'sign', kind: 'avatar' | 'group', group_id?: string }
 *   200:  { cloud_name, api_key, timestamp, signature, public_id, asset_folder,
 *           allowed_formats, upload_url }
 *   App POST multipart tới upload_url với: file, api_key, timestamp, signature,
 *   public_id, asset_folder, allowed_formats (đúng giá trị đã nhận — đổi gì chữ ký sai).
 *
 * Xóa ảnh:
 *   Body: { action: 'destroy', kind: 'avatar' | 'group', public_id: string, group_id?: string }
 *   200:  { result }   ('ok' | 'not found' — kết quả của Cloudinary)
 *
 * (Thiếu `action` → coi như 'sign'.)
 *
 * Quyền:
 *   avatar: chính người gọi — public_id '<uid>/avatar_<timestamp>'; destroy chỉ public_id
 *           bắt đầu bằng '<uid>/'.
 *   group:  chủ nhóm. sign: nhóm phải ACTIVE — public_id '<group_id>/group_<timestamp>'.
 *           destroy: người gọi là chủ nhóm và public_id bắt đầu bằng '<group_id>/'.
 *   Tài khoản đã ẩn danh (deleted_at) bị chặn.
 *
 * Lỗi: JSON { error: 'CODE: message' } với status 400 / 401 / 403 / 404 / 405 / 409 /
 * 500 / 502. Không trả lỗi nội bộ thô (chỉ ghi console).
 *
 * Secret (npx supabase@latest secrets set --env-file <file ngoài repo>):
 *   CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET.
 * API secret chỉ nằm trong Edge Function — KHÔNG BAO GIỜ gửi về app.
 */

// Deno: import URL, không phải module Node (eslint chạy resolver Node)
// eslint-disable-next-line import/no-unresolved
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const ENV_NAMES = [
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'CLOUDINARY_CLOUD_NAME',
  'CLOUDINARY_API_KEY',
  'CLOUDINARY_API_SECRET',
] as const;
type EnvName = (typeof ENV_NAMES)[number];

const ALLOWED_FORMATS = 'jpg,png,webp,heic';
const CLOUDINARY_TIMEOUT_MS = 10_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// public_id do hàm này đặt: '<uuid>/avatar_<ts>' hoặc '<uuid>/group_<ts>'. Cho phép rộng hơn
// một chút (chữ, số, _ - /) nhưng không '..', không ký tự lạ.
const PUBLIC_ID_RE = /^[A-Za-z0-9_\-/]+$/;

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, content-type, x-client-info, apikey',
  'Content-Type': 'application/json',
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: corsHeaders });

class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    detail: string,
  ) {
    super(`${code}: ${detail}`);
  }
}

type Kind = 'avatar' | 'group';
type Action = 'sign' | 'destroy';

function readEnv(): Record<EnvName, string> {
  const missing: string[] = [];
  const env = {} as Record<EnvName, string>;
  for (const name of ENV_NAMES) {
    const value = Deno.env.get(name)?.trim();
    if (!value) missing.push(name);
    else env[name] = value;
  }
  if (missing.length > 0) {
    throw new HttpError(500, 'CONFIG_MISSING', `Server is missing configuration: ${missing.join(', ')}.`);
  }
  return env;
}

/**
 * Chữ ký Cloudinary: tham số (trừ file, cloud_name, resource_type, api_key) sắp xếp theo
 * tên, nối 'k=v' bằng '&', nối api_secret vào cuối, SHA-1 hex.
 */
async function signParams(params: Record<string, string | number>, apiSecret: string): Promise<string> {
  const toSign =
    Object.keys(params)
      .sort()
      .map((k) => `${k}=${params[k]}`)
      .join('&') + apiSecret;
  const hash = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(toSign));
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function makeServiceClient(url: string, key: string) {
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}
type ServiceClient = ReturnType<typeof makeServiceClient>;

/** Nhóm tồn tại và người gọi là chủ. requireActive: nhóm phải ACTIVE (ký upload). */
async function assertGroupOwner(
  client: ServiceClient,
  groupId: unknown,
  userId: string,
  requireActive: boolean,
): Promise<string> {
  if (typeof groupId !== 'string' || !UUID_RE.test(groupId)) {
    throw new HttpError(400, 'INVALID_GROUP_ID', 'group_id must be a group UUID for kind=group.');
  }
  const { data: group, error } = await client
    .from('groups')
    .select('owner_id, status')
    .eq('id', groupId)
    .maybeSingle();
  if (error) {
    console.error('cloudinary-sign: group lookup failed', error.message);
    throw new HttpError(500, 'INTERNAL', 'Could not verify the group.');
  }
  if (!group) throw new HttpError(404, 'GROUP_NOT_FOUND', 'Group does not exist.');
  if (group.owner_id !== userId) {
    throw new HttpError(403, 'NOT_OWNER', 'Only the group owner can change the group image.');
  }
  if (requireActive && group.status !== 'ACTIVE') {
    throw new HttpError(409, 'GROUP_CLOSED', 'Group is closed.');
  }
  return groupId.toLowerCase();
}

function assertPublicIdUnder(publicId: unknown, prefix: string): string {
  if (
    typeof publicId !== 'string' ||
    publicId.length > 255 ||
    !PUBLIC_ID_RE.test(publicId) ||
    publicId.includes('..') ||
    !publicId.startsWith(prefix) ||
    publicId.length <= prefix.length
  ) {
    throw new HttpError(403, 'INVALID_PUBLIC_ID', `public_id must be an image under '${prefix}'.`);
  }
  return publicId;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    if (req.method !== 'POST') {
      throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'Use POST.');
    }

    // ── 0. Cấu hình (fail fast, không dùng `!`) ──
    const env = readEnv();

    // ── 1. Xác thực JWT ──
    const authHeader = req.headers.get('Authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      throw new HttpError(401, 'NOT_AUTHENTICATED', 'Missing authorization header.');
    }

    const serviceClient = makeServiceClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
    const {
      data: { user },
      error: authError,
    } = await serviceClient.auth.getUser(authHeader.slice('Bearer '.length));
    if (authError || !user) {
      throw new HttpError(401, 'NOT_AUTHENTICATED', 'Invalid or expired token.');
    }
    const userId = user.id.toLowerCase();

    // Tài khoản đã ẩn danh (token cũ còn hạn) — như assert_authenticated() trong DB
    const { data: profile, error: profileError } = await serviceClient
      .from('profiles')
      .select('deleted_at')
      .eq('id', userId)
      .maybeSingle();
    if (profileError) {
      console.error('cloudinary-sign: profile lookup failed', profileError.message);
      throw new HttpError(500, 'INTERNAL', 'Could not verify the account.');
    }
    if (!profile || profile.deleted_at) {
      throw new HttpError(403, 'ACCOUNT_DELETED', 'This account has been deleted.');
    }

    // ── 2. Body ──
    let body: Record<string, unknown>;
    try {
      const parsed = await req.json();
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
      body = parsed as Record<string, unknown>;
    } catch {
      throw new HttpError(400, 'INVALID_BODY', 'Body must be a JSON object.');
    }

    const action = (body.action ?? 'sign') as Action;
    if (action !== 'sign' && action !== 'destroy') {
      throw new HttpError(400, 'INVALID_ACTION', "action must be 'sign' or 'destroy'.");
    }
    const kind = body.kind as Kind;
    if (kind !== 'avatar' && kind !== 'group') {
      throw new HttpError(400, 'INVALID_KIND', "kind must be 'avatar' or 'group'.");
    }

    // ── 3a. Xóa ảnh ──
    if (action === 'destroy') {
      let publicId: string;
      if (kind === 'avatar') {
        publicId = assertPublicIdUnder(body.public_id, `${userId}/`);
      } else {
        const groupId = await assertGroupOwner(serviceClient, body.group_id, userId, false);
        publicId = assertPublicIdUnder(body.public_id, `${groupId}/`);
      }

      const timestamp = Math.floor(Date.now() / 1000);
      const signed = { invalidate: 'true', public_id: publicId, timestamp };
      const signature = await signParams(signed, env.CLOUDINARY_API_SECRET);

      const form = new URLSearchParams();
      form.append('public_id', publicId);
      form.append('invalidate', 'true');
      form.append('timestamp', String(timestamp));
      form.append('api_key', env.CLOUDINARY_API_KEY);
      form.append('signature', signature);

      let response: Response;
      try {
        response = await fetch(
          `https://api.cloudinary.com/v1_1/${encodeURIComponent(env.CLOUDINARY_CLOUD_NAME)}/image/destroy`,
          { method: 'POST', body: form, signal: AbortSignal.timeout(CLOUDINARY_TIMEOUT_MS) },
        );
      } catch (err) {
        console.error('cloudinary-sign: destroy request failed', (err as Error).message);
        throw new HttpError(502, 'CLOUDINARY_ERROR', 'Image service is unavailable. Please try again.');
      }

      const payload = (await response.json().catch(() => null)) as { result?: string } | null;
      if (!response.ok || !payload || typeof payload.result !== 'string') {
        console.error('cloudinary-sign: destroy failed', response.status, JSON.stringify(payload));
        throw new HttpError(502, 'CLOUDINARY_ERROR', `Image service rejected the request (HTTP ${response.status}).`);
      }

      return json({ result: payload.result });
    }

    // ── 3b. Ký upload: server tự đặt public_id ──
    const timestamp = Math.floor(Date.now() / 1000);
    let publicId: string;
    let assetFolder: string;

    if (kind === 'avatar') {
      publicId = `${userId}/avatar_${timestamp}`;
      assetFolder = 'splitbill/avatars';
    } else {
      const groupId = await assertGroupOwner(serviceClient, body.group_id, userId, true);
      publicId = `${groupId}/group_${timestamp}`;
      assetFolder = 'splitbill/groups';
    }

    const signature = await signParams(
      {
        allowed_formats: ALLOWED_FORMATS,
        asset_folder: assetFolder,
        public_id: publicId,
        timestamp,
      },
      env.CLOUDINARY_API_SECRET,
    );

    return json({
      cloud_name: env.CLOUDINARY_CLOUD_NAME,
      api_key: env.CLOUDINARY_API_KEY,
      timestamp,
      signature,
      public_id: publicId,
      asset_folder: assetFolder,
      allowed_formats: ALLOWED_FORMATS,
      upload_url: `https://api.cloudinary.com/v1_1/${encodeURIComponent(env.CLOUDINARY_CLOUD_NAME)}/image/upload`,
    });
  } catch (err) {
    if (err instanceof HttpError) {
      return json({ error: err.message }, err.status);
    }
    console.error('cloudinary-sign: unexpected error', (err as Error)?.message);
    return json({ error: 'INTERNAL: Unexpected server error.' }, 500);
  }
});
