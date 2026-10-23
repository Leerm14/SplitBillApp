-- ============================================================
-- Join approval (pgTAP) — migration 0014
--   JA-01..07  lược đồ: cột, bảng, chỉ mục, RLS, quyền, Realtime
--   JA-10..15  duyệt TẮT → vào thẳng (JOINED / ALREADY_MEMBER), REMOVED vẫn bị chặn
--   JA-20..25  set_join_approval: chỉ chủ nhóm, nhóm ACTIVE, nhật ký
--   JA-30..47  duyệt BẬT → PENDING, báo chủ nhóm, yêu cầu trùng, lời mời đích danh
--   JA-50..55  RPC cũ: JOIN_APPROVAL_REQUIRED
--   JA-60..66  list_join_requests / my_join_request / RLS
--   JA-70..78  approve / reject / cancel
--   JA-80..86  tắt duyệt khi còn yêu cầu, đóng nhóm, chuyển quyền chủ nhóm
--   JA-90..94  anon / chưa đăng nhập / ghi trực tiếp
-- ============================================================

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;

DO $$
DECLARE _s TEXT;
BEGIN
  SELECT n.nspname INTO _s
  FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace
  WHERE e.extname = 'pgtap';
  IF _s IS NOT NULL THEN
    EXECUTE format('GRANT USAGE ON SCHEMA %I TO anon, authenticated, service_role', _s);
    EXECUTE format('GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA %I TO anon, authenticated, service_role', _s);
  END IF;
END $$;

SELECT no_plan();

-- ------------------------------------------------------------
-- Helpers
-- ------------------------------------------------------------
CREATE SCHEMA _t;
GRANT USAGE ON SCHEMA _t TO anon, authenticated, service_role;

CREATE FUNCTION _t.new_user(_id UUID, _name TEXT) RETURNS UUID LANGUAGE plpgsql AS $f$
BEGIN
  INSERT INTO auth.users (id, aud, role, email, raw_user_meta_data, created_at, updated_at)
  VALUES (_id, 'authenticated', 'authenticated', _id::text || '@test.local',
          jsonb_build_object('display_name', _name), now(), now());
  RETURN _id;
END $f$;

CREATE FUNCTION _t.login(_uid UUID) RETURNS VOID LANGUAGE plpgsql AS $f$
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', _uid, 'role', 'authenticated', 'aud', 'authenticated')::text, true);
  PERFORM set_config('role', 'authenticated', true);
END $f$;

CREATE FUNCTION _t.no_user() RETURNS VOID LANGUAGE plpgsql AS $f$
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claims', '', true);
  PERFORM set_config('role', 'authenticated', true);
END $f$;

CREATE FUNCTION _t.as_anon() RETURNS VOID LANGUAGE plpgsql AS $f$
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'anon')::text, true);
  PERFORM set_config('role', 'anon', true);
END $f$;

-- id yêu cầu (PENDING trước, rồi mới nhất) — bỏ qua RLS để truyền id vào RPC
CREATE FUNCTION _t.req(_g UUID, _u UUID) RETURNS UUID
LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $f$
  SELECT r.id FROM public.group_join_requests r
  WHERE r.group_id = _g AND r.user_id = _u
  ORDER BY (r.status = 'PENDING') DESC, r.decided_at DESC NULLS FIRST
  LIMIT 1;
$f$;

GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA _t TO anon, authenticated, service_role;

-- ------------------------------------------------------------
-- Fixtures
--   G1 ACTIVE (mã JAONE001): O chủ; M ACTIVE; R, R2 REMOVED.
--   G2 ACTIVE (mã JATWO002): O chủ — để đóng nhóm.
--   P, Q, T, U, V, W, X: người ngoài.
--   Lời mời G1: OPEN1 (mở, 1 lượt, O tạo) · TGT_T (đích danh T, O tạo) ·
--               MTGT_U (đích danh U, M tạo) · OPEN5 (mở, 5 lượt, O tạo) ·
--               TGT_X (đích danh X, O tạo)
-- ------------------------------------------------------------
DO $$
BEGIN
  PERFORM _t.new_user('a8000000-0000-4000-8000-000000000001', 'Owner');
  PERFORM _t.new_user('b8000000-0000-4000-8000-000000000001', 'Member');
  PERFORM _t.new_user('c8000000-0000-4000-8000-000000000001', 'Pat');
  PERFORM _t.new_user('c8000000-0000-4000-8000-000000000002', 'Quinn');
  PERFORM _t.new_user('c8000000-0000-4000-8000-000000000003', 'Tess');
  PERFORM _t.new_user('c8000000-0000-4000-8000-000000000004', 'Uma');
  PERFORM _t.new_user('c8000000-0000-4000-8000-000000000005', 'Vic');
  PERFORM _t.new_user('c8000000-0000-4000-8000-000000000006', 'Walt');
  PERFORM _t.new_user('c8000000-0000-4000-8000-000000000007', 'Xena');
  PERFORM _t.new_user('e8000000-0000-4000-8000-000000000001', 'Rex');
  PERFORM _t.new_user('e8000000-0000-4000-8000-000000000002', 'Rio');
END $$;

INSERT INTO public.groups (id, name, owner_id, invite_code, status) VALUES
  ('18000000-0000-4000-8000-000000000001', 'Ja One', 'a8000000-0000-4000-8000-000000000001', 'JAONE001', 'ACTIVE'),
  ('18000000-0000-4000-8000-000000000002', 'Ja Two', 'a8000000-0000-4000-8000-000000000001', 'JATWO002', 'ACTIVE');

INSERT INTO public.group_members (group_id, user_id, role, status, left_at) VALUES
  ('18000000-0000-4000-8000-000000000001', 'a8000000-0000-4000-8000-000000000001', 'owner',  'ACTIVE',  NULL),
  ('18000000-0000-4000-8000-000000000001', 'b8000000-0000-4000-8000-000000000001', 'member', 'ACTIVE',  NULL),
  ('18000000-0000-4000-8000-000000000001', 'e8000000-0000-4000-8000-000000000001', 'member', 'REMOVED', now() - interval '1 day'),
  ('18000000-0000-4000-8000-000000000001', 'e8000000-0000-4000-8000-000000000002', 'member', 'REMOVED', now() - interval '1 day'),
  ('18000000-0000-4000-8000-000000000002', 'a8000000-0000-4000-8000-000000000001', 'owner',  'ACTIVE',  NULL);

INSERT INTO public.group_invites (id, group_id, token, invited_user_id, created_by, expires_at, max_uses) VALUES
  ('58000000-0000-4000-8000-000000000001', '18000000-0000-4000-8000-000000000001', 'JAOPEN000001',
   NULL, 'a8000000-0000-4000-8000-000000000001', now() + interval '1 day', 1),
  ('58000000-0000-4000-8000-000000000002', '18000000-0000-4000-8000-000000000001', 'JATARGETT001',
   'c8000000-0000-4000-8000-000000000003', 'a8000000-0000-4000-8000-000000000001', now() + interval '1 day', 1),
  ('58000000-0000-4000-8000-000000000003', '18000000-0000-4000-8000-000000000001', 'JAMEMBERU001',
   'c8000000-0000-4000-8000-000000000004', 'b8000000-0000-4000-8000-000000000001', now() + interval '1 day', 1),
  ('58000000-0000-4000-8000-000000000004', '18000000-0000-4000-8000-000000000001', 'JAOPEN000005',
   NULL, 'a8000000-0000-4000-8000-000000000001', now() + interval '1 day', 5),
  ('58000000-0000-4000-8000-000000000005', '18000000-0000-4000-8000-000000000001', 'JATARGETX001',
   'c8000000-0000-4000-8000-000000000007', 'a8000000-0000-4000-8000-000000000001', now() + interval '1 day', 1);

-- ============================================================
-- 1. Lược đồ
-- ============================================================
SELECT is(
  (SELECT row(a.attnotnull, pg_get_expr(d.adbin, d.adrelid))::text
   FROM pg_attribute a JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
   WHERE a.attrelid = 'public.groups'::regclass AND a.attname = 'require_approval'),
  row(true, 'false')::text,
  'JA-01: groups.require_approval boolean NOT NULL DEFAULT false');

SELECT ok(
  (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.group_join_requests'::regclass),
  'JA-02: group_join_requests has RLS enabled');

SELECT ok(
  EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'group_join_requests'
          AND indexdef ILIKE 'CREATE UNIQUE INDEX%(group_id, user_id)%WHERE (status = ''PENDING''::text)%'),
  'JA-03: partial UNIQUE index — one PENDING request per (group_id, user_id)');

SELECT ok(
  has_table_privilege('authenticated', 'public.group_join_requests', 'SELECT')
  AND NOT has_table_privilege('authenticated', 'public.group_join_requests', 'INSERT')
  AND NOT has_table_privilege('authenticated', 'public.group_join_requests', 'UPDATE')
  AND NOT has_table_privilege('authenticated', 'public.group_join_requests', 'DELETE')
  AND NOT has_table_privilege('anon', 'public.group_join_requests', 'SELECT'),
  'JA-04: authenticated may only SELECT group_join_requests (RPC-only writes); anon nothing');

SELECT ok(
  EXISTS (SELECT 1 FROM pg_publication_tables
          WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'group_join_requests'),
  'JA-05: group_join_requests is in the supabase_realtime publication');

SELECT is(
  ARRAY(
    SELECT f FROM unnest(ARRAY[
      'public.set_join_approval(uuid,boolean)', 'public.join_by_token(text)', 'public.join_by_code(text)',
      'public.accept_invite_by_id_v2(uuid)', 'public.list_join_requests(uuid)', 'public.my_join_request(uuid)',
      'public.approve_join_request(uuid)', 'public.reject_join_request(uuid,text)',
      'public.cancel_join_request(uuid)', 'public.accept_invite(text)', 'public.join_group(text)'
    ]) f
    WHERE has_function_privilege('anon', f, 'EXECUTE')
       OR NOT has_function_privilege('authenticated', f, 'EXECUTE')
  ),
  ARRAY[]::text[],
  'JA-06: new/changed RPCs — anon denied, authenticated allowed');

SELECT ok(
  NOT has_function_privilege('authenticated', 'public.process_join(uuid,uuid,uuid)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public.reject_join_requests_on_close()', 'EXECUTE'),
  'JA-07: internal join core / trigger function are not callable by the app');

-- ============================================================
-- 2. Duyệt TẮT
-- ============================================================
SELECT _t.login('c8000000-0000-4000-8000-000000000001');
SELECT is(
  public.join_by_code(' jaone001 '),
  jsonb_build_object('status', 'JOINED', 'group_id', '18000000-0000-4000-8000-000000000001'::uuid,
                     'group_name', 'Ja One', 'request_id', NULL),
  'JA-10: approval off → join_by_code JOINED (trimmed, case-insensitive)');
SELECT is(
  public.join_by_code('JAONE001') ->> 'status', 'ALREADY_MEMBER',
  'JA-11: joining again while ACTIVE → ALREADY_MEMBER');

SELECT _t.login('e8000000-0000-4000-8000-000000000002');
SELECT throws_like($q$SELECT public.join_by_code('JAONE001')$q$, 'MEMBER_REMOVED:%',
  'JA-12: approval off → REMOVED member still blocked by code (BE-07)');
SELECT throws_like($q$SELECT public.join_by_token('JAOPEN000005')$q$, 'MEMBER_REMOVED:%',
  'JA-13: approval off → REMOVED member still blocked by an open invite');

SELECT _t.login('c8000000-0000-4000-8000-000000000006');
SELECT throws_like($q$SELECT public.join_by_code('NOPE0000')$q$, 'INVITE_CODE_NOT_FOUND:%',
  'JA-14a: unknown code → INVITE_CODE_NOT_FOUND');
SELECT throws_like($q$SELECT public.join_by_token('nope')$q$, 'INVITE_NOT_FOUND:%',
  'JA-14b: unknown token → INVITE_NOT_FOUND');

RESET ROLE;
SELECT is(
  (SELECT count(*)::int FROM public.notifications
   WHERE user_id = 'a8000000-0000-4000-8000-000000000001' AND type = 'MEMBER_JOINED'
     AND actor_id = 'c8000000-0000-4000-8000-000000000001'),
  1,
  'JA-15: approval off → owner gets MEMBER_JOINED once, no request row');

-- ============================================================
-- 3. set_join_approval
-- ============================================================
SELECT _t.login('b8000000-0000-4000-8000-000000000001');
SELECT throws_like($q$SELECT public.set_join_approval('18000000-0000-4000-8000-000000000001', true)$q$,
  'NOT_OWNER:%', 'JA-20: non-owner member cannot toggle approval');

SELECT _t.login('a8000000-0000-4000-8000-000000000001');
SELECT is(
  (SELECT g.require_approval FROM public.set_join_approval('18000000-0000-4000-8000-000000000001', true) g),
  true,
  'JA-21: owner turns approval on');
SELECT is(
  (SELECT g.require_approval FROM public.set_join_approval('18000000-0000-4000-8000-000000000001', true) g),
  true,
  'JA-22: setting the same value again is a no-op');
SELECT throws_like($q$SELECT public.set_join_approval('18000000-0000-4000-8000-000000000001', NULL)$q$,
  'INVALID_VALUE:%', 'JA-23: NULL is rejected');
SELECT throws_like($q$SELECT public.set_join_approval('18000000-0000-4000-8000-0000000000ff', true)$q$,
  'GROUP_NOT_FOUND:%', 'JA-24: unknown group → GROUP_NOT_FOUND');

RESET ROLE;
SELECT is(
  (SELECT count(*)::int FROM public.activity_logs
   WHERE group_id = '18000000-0000-4000-8000-000000000001' AND action = 'UPDATE' AND entity_type = 'GROUP'
     AND (before ->> 'require_approval')::boolean = false AND (after ->> 'require_approval')::boolean = true),
  1,
  'JA-25: toggling writes exactly one UPDATE/GROUP activity log');

-- ============================================================
-- 4. Duyệt BẬT
-- ============================================================
-- Q xin bằng mã
SELECT _t.login('c8000000-0000-4000-8000-000000000002');
CREATE TEMP TABLE _q_res AS SELECT public.join_by_code('JAONE001') AS r;
GRANT SELECT ON _q_res TO authenticated;
SELECT is(
  (SELECT (r - 'request_id') FROM _q_res),
  jsonb_build_object('status', 'PENDING', 'group_id', '18000000-0000-4000-8000-000000000001'::uuid,
                     'group_name', 'Ja One'),
  'JA-30: approval on → join_by_code returns PENDING');
SELECT is(
  (SELECT (r ->> 'request_id')::uuid FROM _q_res),
  _t.req('18000000-0000-4000-8000-000000000001', 'c8000000-0000-4000-8000-000000000002'),
  'JA-31: result carries the request id');
SELECT is(
  public.join_by_code('JAONE001') ->> 'request_id',
  (SELECT r ->> 'request_id' FROM _q_res),
  'JA-32: duplicate request returns the same PENDING request');

RESET ROLE;
SELECT is(
  (SELECT row(r.status, r.via, r.invite_id IS NULL, r.decided_at IS NULL)::text
   FROM public.group_join_requests r
   WHERE r.user_id = 'c8000000-0000-4000-8000-000000000002'),
  row('PENDING', 'CODE', true, true)::text,
  'JA-33: exactly one PENDING request via CODE');
SELECT is(
  (SELECT count(*)::int FROM public.group_members
   WHERE group_id = '18000000-0000-4000-8000-000000000001' AND user_id = 'c8000000-0000-4000-8000-000000000002'),
  0,
  'JA-34: requester is not a member yet');
SELECT is(
  (SELECT count(*)::int FROM public.notifications
   WHERE user_id = 'a8000000-0000-4000-8000-000000000001' AND type = 'JOIN_REQUESTED'
     AND group_id = '18000000-0000-4000-8000-000000000001'
     AND actor_id = 'c8000000-0000-4000-8000-000000000002'),
  1,
  'JA-35: owner gets exactly one JOIN_REQUESTED (group_id, actor = requester), not re-sent on duplicate');
SELECT is(
  (SELECT count(*)::int FROM public.activity_logs
   WHERE action = 'REQUEST' AND entity_type = 'JOIN_REQUEST'
     AND actor_id = 'c8000000-0000-4000-8000-000000000002'),
  1,
  'JA-36: request writes a REQUEST/JOIN_REQUEST activity log');

-- T: lời mời đích danh do chủ nhóm tạo → vào thẳng
SELECT _t.login('c8000000-0000-4000-8000-000000000003');
SELECT is(
  public.join_by_token('JATARGETT001') ->> 'status', 'JOINED',
  'JA-37: owner-created invite targeted to the caller bypasses approval');
RESET ROLE;
SELECT is(
  (SELECT row(gm.status, gi.used_count)::text
   FROM public.group_members gm, public.group_invites gi
   WHERE gm.group_id = '18000000-0000-4000-8000-000000000001'
     AND gm.user_id = 'c8000000-0000-4000-8000-000000000003'
     AND gi.id = '58000000-0000-4000-8000-000000000002'),
  row('ACTIVE', 1)::text,
  'JA-38: bypassing member is ACTIVE and the invite is used once');

-- X: accept_invite_by_id_v2 (đích danh, chủ nhóm tạo) → JOINED
SELECT _t.login('c8000000-0000-4000-8000-000000000001');
SELECT throws_like($q$SELECT public.accept_invite_by_id_v2('58000000-0000-4000-8000-000000000005')$q$,
  'INVITE_NOT_FOR_YOU:%', 'JA-39a: accept_invite_by_id_v2 — only the invitee');
SELECT throws_like($q$SELECT public.accept_invite_by_id_v2('58000000-0000-4000-8000-000000000004')$q$,
  'INVITE_NOT_FOR_YOU:%', 'JA-39b: accept_invite_by_id_v2 — open invites are rejected');
SELECT _t.login('c8000000-0000-4000-8000-000000000007');
SELECT is(
  public.accept_invite_by_id_v2('58000000-0000-4000-8000-000000000005'),
  jsonb_build_object('status', 'JOINED', 'group_id', '18000000-0000-4000-8000-000000000001'::uuid,
                     'group_name', 'Ja One', 'request_id', NULL),
  'JA-39: accept_invite_by_id_v2 with an owner-targeted invite → JOINED');

-- U: lời mời đích danh nhưng do thành viên (không phải chủ) tạo → PENDING
SELECT _t.login('c8000000-0000-4000-8000-000000000004');
SELECT is(
  public.accept_invite_by_id_v2('58000000-0000-4000-8000-000000000003') ->> 'status', 'PENDING',
  'JA-40: member-created targeted invite does NOT bypass approval');
RESET ROLE;
SELECT is(
  (SELECT row(r.via, r.invite_id, gi.used_count)::text
   FROM public.group_join_requests r JOIN public.group_invites gi ON gi.id = r.invite_id
   WHERE r.user_id = 'c8000000-0000-4000-8000-000000000004' AND r.status = 'PENDING'),
  row('INVITE', '58000000-0000-4000-8000-000000000003'::uuid, 1)::text,
  'JA-41: token request stores via INVITE + invite_id and reserves an invite slot');

-- V: lời mời mở 1 lượt → PENDING giữ chỗ; W hết lượt; V gọi lại vẫn PENDING
SELECT _t.login('c8000000-0000-4000-8000-000000000005');
SELECT is(public.join_by_token('JAOPEN000001') ->> 'status', 'PENDING',
  'JA-42: open invite with approval on → PENDING');
SELECT is(public.join_by_token('JAOPEN000001') ->> 'status', 'PENDING',
  'JA-43: repeating the request on the now-full invite returns the existing PENDING request');
SELECT _t.login('c8000000-0000-4000-8000-000000000006');
SELECT throws_like($q$SELECT public.join_by_token('JAOPEN000001')$q$, 'INVITE_EXHAUSTED:%',
  'JA-44: the reserved slot is taken — another requester gets INVITE_EXHAUSTED');
RESET ROLE;
SELECT is(
  (SELECT used_count FROM public.group_invites WHERE id = '58000000-0000-4000-8000-000000000001'),
  1,
  'JA-45: duplicate request does not consume another slot');

-- R: REMOVED, duyệt bật → được xin
SELECT _t.login('e8000000-0000-4000-8000-000000000001');
SELECT is(public.join_by_code('JAONE001') ->> 'status', 'PENDING',
  'JA-46: approval on → REMOVED member may request (owner decides)');

-- Thành viên ACTIVE dùng mã → ALREADY_MEMBER
SELECT _t.login('b8000000-0000-4000-8000-000000000001');
SELECT is(public.join_by_code('JAONE001') ->> 'status', 'ALREADY_MEMBER',
  'JA-47: ACTIVE member → ALREADY_MEMBER even with approval on');

-- ============================================================
-- 5. RPC cũ
-- ============================================================
SELECT _t.login('c8000000-0000-4000-8000-000000000006');
SELECT throws_like($q$SELECT public.join_group('JAONE001')$q$, 'JOIN_APPROVAL_REQUIRED:%',
  'JA-50: join_group raises JOIN_APPROVAL_REQUIRED when approval is on');
SELECT throws_like($q$SELECT public.accept_invite('JAOPEN000005')$q$, 'JOIN_APPROVAL_REQUIRED:%',
  'JA-51: accept_invite (open invite) raises JOIN_APPROVAL_REQUIRED');
RESET ROLE;
SELECT is(
  (SELECT row(
     (SELECT count(*) FROM public.group_join_requests WHERE user_id = 'c8000000-0000-4000-8000-000000000006'),
     (SELECT used_count FROM public.group_invites WHERE id = '58000000-0000-4000-8000-000000000004'))::text),
  row(0, 0)::text,
  'JA-52: old RPCs leave no request and consume no slot');

-- Lời mời đích danh do thành viên tạo cho P2 (Walt) → accept_invite_by_id cũ cũng bị chặn
INSERT INTO public.group_invites (id, group_id, token, invited_user_id, created_by, expires_at, max_uses) VALUES
  ('58000000-0000-4000-8000-000000000006', '18000000-0000-4000-8000-000000000001', 'JAMEMBERW001',
   'c8000000-0000-4000-8000-000000000006', 'b8000000-0000-4000-8000-000000000001', now() + interval '1 day', 1),
  ('58000000-0000-4000-8000-000000000007', '18000000-0000-4000-8000-000000000001', 'JATARGETW001',
   'c8000000-0000-4000-8000-000000000006', 'a8000000-0000-4000-8000-000000000001', now() + interval '1 day', 1);
SELECT _t.login('c8000000-0000-4000-8000-000000000006');
SELECT throws_like($q$SELECT public.accept_invite_by_id('58000000-0000-4000-8000-000000000006')$q$,
  'JOIN_APPROVAL_REQUIRED:%', 'JA-53: accept_invite_by_id (member-created) raises JOIN_APPROVAL_REQUIRED');

SELECT _t.login('c8000000-0000-4000-8000-000000000001');
SELECT is(
  (SELECT g.id FROM public.join_group('JAONE001') g), '18000000-0000-4000-8000-000000000001'::uuid,
  'JA-54: join_group still returns the group for an ACTIVE member');

SELECT _t.login('c8000000-0000-4000-8000-000000000006');
SELECT is(
  (SELECT g.id FROM public.accept_invite('JATARGETW001') g), '18000000-0000-4000-8000-000000000001'::uuid,
  'JA-55: accept_invite with an owner-targeted invite still joins (no approval needed)');

-- ============================================================
-- 6. list / my / RLS
-- ============================================================
SELECT _t.login('a8000000-0000-4000-8000-000000000001');
SELECT is(
  ARRAY(SELECT l.display_name FROM public.list_join_requests('18000000-0000-4000-8000-000000000001') l ORDER BY 1),
  ARRAY['Quinn', 'Rex', 'Uma', 'Vic']::text[],
  'JA-60: owner lists the 4 PENDING requests with requester profiles');
SELECT is(
  pg_get_function_result('public.list_join_requests(uuid)'::regprocedure),
  'TABLE(id uuid, user_id uuid, display_name text, user_code text, avatar_path text, via text, created_at timestamp with time zone)',
  'JA-61: list_join_requests result shape');
SELECT is((SELECT count(*)::int FROM public.group_join_requests), 4,
  'JA-62: owner reads the group''s requests through RLS');

SELECT _t.login('b8000000-0000-4000-8000-000000000001');
SELECT throws_like($q$SELECT * FROM public.list_join_requests('18000000-0000-4000-8000-000000000001')$q$,
  'NOT_OWNER:%', 'JA-63: non-owner member cannot list requests');
SELECT is((SELECT count(*)::int FROM public.group_join_requests), 0,
  'JA-64: other members cannot read join requests (RLS)');
SELECT is(public.my_join_request('18000000-0000-4000-8000-000000000001'), NULL::jsonb,
  'JA-65a: my_join_request with no request → NULL');

SELECT _t.login('c8000000-0000-4000-8000-000000000002');
SELECT is(
  (SELECT array_agg(r.user_id)::text FROM public.group_join_requests r),
  ARRAY['c8000000-0000-4000-8000-000000000002'::uuid]::text,
  'JA-65: requester reads only their own request (RLS)');
SELECT is(
  public.my_join_request('18000000-0000-4000-8000-000000000001'),
  jsonb_build_object('status', 'PENDING',
                     'request_id', _t.req('18000000-0000-4000-8000-000000000001', 'c8000000-0000-4000-8000-000000000002')),
  'JA-66: my_join_request → {status, request_id}');

-- ============================================================
-- 7. approve / reject / cancel
-- ============================================================
SELECT _t.login('b8000000-0000-4000-8000-000000000001');
SELECT throws_like(
  format('SELECT public.approve_join_request(%L)',
         _t.req('18000000-0000-4000-8000-000000000001', 'c8000000-0000-4000-8000-000000000002')),
  'NOT_OWNER:%', 'JA-70: non-owner cannot approve');
SELECT throws_like(
  format('SELECT public.reject_join_request(%L)',
         _t.req('18000000-0000-4000-8000-000000000001', 'c8000000-0000-4000-8000-000000000002')),
  'NOT_OWNER:%', 'JA-70b: non-owner cannot reject');

SELECT _t.login('a8000000-0000-4000-8000-000000000001');
SELECT is(
  (SELECT g.id FROM public.approve_join_request(
     _t.req('18000000-0000-4000-8000-000000000001', 'c8000000-0000-4000-8000-000000000002')) g),
  '18000000-0000-4000-8000-000000000001'::uuid,
  'JA-71: owner approves Q');
SELECT throws_like(
  format('SELECT public.approve_join_request(%L)',
         _t.req('18000000-0000-4000-8000-000000000001', 'c8000000-0000-4000-8000-000000000002')),
  'NOT_PENDING:%', 'JA-71b: approving twice → NOT_PENDING');
SELECT throws_like($q$SELECT public.approve_join_request('98000000-0000-4000-8000-000000000000')$q$,
  'JOIN_REQUEST_NOT_FOUND:%', 'JA-71c: unknown request → JOIN_REQUEST_NOT_FOUND');
RESET ROLE;
SELECT is(
  (SELECT row(gm.status, gm.role, r.status, r.decided_by, r.decided_at IS NOT NULL)::text
   FROM public.group_members gm, public.group_join_requests r
   WHERE gm.group_id = '18000000-0000-4000-8000-000000000001'
     AND gm.user_id = 'c8000000-0000-4000-8000-000000000002'
     AND r.user_id = gm.user_id),
  row('ACTIVE', 'member', 'APPROVED', 'a8000000-0000-4000-8000-000000000001'::uuid, true)::text,
  'JA-72: approve adds an ACTIVE member and marks the request APPROVED (decided_at/by)');
SELECT is(
  (SELECT count(*)::int FROM public.notifications
   WHERE user_id = 'c8000000-0000-4000-8000-000000000002' AND type = 'JOIN_APPROVED'
     AND group_id = '18000000-0000-4000-8000-000000000001'
     AND actor_id = 'a8000000-0000-4000-8000-000000000001'),
  1,
  'JA-73: requester gets JOIN_APPROVED (group_id, actor = owner)');

-- R (REMOVED) được duyệt → kích hoạt lại
SELECT _t.login('a8000000-0000-4000-8000-000000000001');
SELECT lives_ok(
  format('SELECT public.approve_join_request(%L)',
         _t.req('18000000-0000-4000-8000-000000000001', 'e8000000-0000-4000-8000-000000000001')),
  'JA-74a: owner approves the REMOVED member''s request');
RESET ROLE;
SELECT is(
  (SELECT row(gm.status, gm.left_at IS NULL)::text FROM public.group_members gm
   WHERE gm.group_id = '18000000-0000-4000-8000-000000000001'
     AND gm.user_id = 'e8000000-0000-4000-8000-000000000001'),
  row('ACTIVE', true)::text,
  'JA-74: approving a REMOVED member reactivates them (left_at cleared)');

-- Từ chối U
SELECT _t.login('a8000000-0000-4000-8000-000000000001');
SELECT throws_like(
  format('SELECT public.reject_join_request(%L, %L)',
         _t.req('18000000-0000-4000-8000-000000000001', 'c8000000-0000-4000-8000-000000000004'), repeat('x', 501)),
  'INVALID_REASON:%', 'JA-75a: reason over 500 characters is rejected');
SELECT lives_ok(
  format('SELECT public.reject_join_request(%L, %L)',
         _t.req('18000000-0000-4000-8000-000000000001', 'c8000000-0000-4000-8000-000000000004'), '  Không quen  '),
  'JA-75b: owner rejects U with a reason');
SELECT throws_like(
  format('SELECT public.reject_join_request(%L)',
         _t.req('18000000-0000-4000-8000-000000000001', 'c8000000-0000-4000-8000-000000000004')),
  'NOT_PENDING:%', 'JA-75c: rejecting twice → NOT_PENDING');
RESET ROLE;
SELECT is(
  (SELECT row(r.status, r.reason, r.decided_by,
              (SELECT count(*) FROM public.group_members
               WHERE group_id = r.group_id AND user_id = r.user_id),
              (SELECT count(*) FROM public.notifications
               WHERE user_id = r.user_id AND type = 'JOIN_REJECTED' AND group_id = r.group_id
                 AND actor_id = 'a8000000-0000-4000-8000-000000000001'))::text
   FROM public.group_join_requests r WHERE r.user_id = 'c8000000-0000-4000-8000-000000000004'),
  row('REJECTED', 'Không quen', 'a8000000-0000-4000-8000-000000000001'::uuid, 0, 1)::text,
  'JA-75: reject → REJECTED (trimmed reason), no membership, JOIN_REJECTED sent');

SELECT _t.login('c8000000-0000-4000-8000-000000000004');
SELECT is(
  public.my_join_request('18000000-0000-4000-8000-000000000001') ->> 'status', 'REJECTED',
  'JA-76: requester sees REJECTED via my_join_request');

-- Hủy V
SELECT _t.login('c8000000-0000-4000-8000-000000000002');
SELECT throws_like(
  format('SELECT public.cancel_join_request(%L)',
         _t.req('18000000-0000-4000-8000-000000000001', 'c8000000-0000-4000-8000-000000000005')),
  'NOT_AUTHORIZED:%', 'JA-77a: only the requester can cancel');
SELECT _t.login('c8000000-0000-4000-8000-000000000005');
SELECT lives_ok(
  format('SELECT public.cancel_join_request(%L)',
         _t.req('18000000-0000-4000-8000-000000000001', 'c8000000-0000-4000-8000-000000000005')),
  'JA-77b: requester cancels own request');
SELECT throws_like(
  format('SELECT public.cancel_join_request(%L)',
         _t.req('18000000-0000-4000-8000-000000000001', 'c8000000-0000-4000-8000-000000000005')),
  'NOT_PENDING:%', 'JA-77c: cancelling twice → NOT_PENDING');
SELECT is(
  public.my_join_request('18000000-0000-4000-8000-000000000001') ->> 'status', 'CANCELLED',
  'JA-77: cancelled request shows CANCELLED');
SELECT _t.login('a8000000-0000-4000-8000-000000000001');
SELECT throws_like(
  format('SELECT public.approve_join_request(%L)',
         _t.req('18000000-0000-4000-8000-000000000001', 'c8000000-0000-4000-8000-000000000005')),
  'NOT_PENDING:%', 'JA-78: a cancelled request cannot be approved');

-- ============================================================
-- 8. Tắt duyệt khi còn yêu cầu, đóng nhóm, chuyển quyền
-- ============================================================
-- V xin lại (yêu cầu mới), chủ nhóm tắt duyệt, V vào thẳng → yêu cầu cũ CANCELLED
SELECT _t.login('c8000000-0000-4000-8000-000000000005');
SELECT is(public.join_by_code('JAONE001') ->> 'status', 'PENDING',
  'JA-80a: after cancelling, the requester can request again');
SELECT _t.login('a8000000-0000-4000-8000-000000000001');
SELECT is(
  (SELECT g.require_approval FROM public.set_join_approval('18000000-0000-4000-8000-000000000001', false) g),
  false, 'JA-80b: owner turns approval off');
SELECT _t.login('c8000000-0000-4000-8000-000000000005');
SELECT is(public.join_by_code('JAONE001') ->> 'status', 'JOINED',
  'JA-80c: approval off → joins directly');
RESET ROLE;
SELECT is(
  ARRAY(SELECT r.status FROM public.group_join_requests r
        WHERE r.user_id = 'c8000000-0000-4000-8000-000000000005' ORDER BY r.status),
  ARRAY['CANCELLED', 'CANCELLED']::text[],
  'JA-80: direct join closes the leftover PENDING request (CANCELLED)');

-- Đóng nhóm G2 khi còn yêu cầu
SELECT _t.login('a8000000-0000-4000-8000-000000000001');
SELECT lives_ok($q$SELECT public.set_join_approval('18000000-0000-4000-8000-000000000002', true)$q$,
  'JA-81a: approval on for G2');
SELECT _t.login('c8000000-0000-4000-8000-000000000006');
SELECT is(public.join_by_code('JATWO002') ->> 'status', 'PENDING', 'JA-81b: W requests to join G2');
SELECT _t.login('a8000000-0000-4000-8000-000000000001');
SELECT lives_ok($q$SELECT public.close_group('18000000-0000-4000-8000-000000000002')$q$,
  'JA-81c: owner closes G2');
RESET ROLE;
SELECT is(
  (SELECT row(r.status, r.reason,
              (SELECT count(*) FROM public.notifications
               WHERE user_id = r.user_id AND type = 'JOIN_REJECTED' AND group_id = r.group_id))::text
   FROM public.group_join_requests r
   WHERE r.group_id = '18000000-0000-4000-8000-000000000002'),
  row('REJECTED', 'GROUP_CLOSED', 1)::text,
  'JA-81: closing the group auto-rejects pending requests and notifies the requester');
SELECT _t.login('a8000000-0000-4000-8000-000000000001');
SELECT throws_like(
  format('SELECT public.approve_join_request(%L)',
         _t.req('18000000-0000-4000-8000-000000000002', 'c8000000-0000-4000-8000-000000000006')),
  'GROUP_CLOSED:%', 'JA-82: approve fails on a CLOSED group');
SELECT throws_like($q$SELECT public.set_join_approval('18000000-0000-4000-8000-000000000002', false)$q$,
  'GROUP_CLOSED:%', 'JA-83: cannot toggle approval on a CLOSED group');

-- Chuyển quyền: yêu cầu đang chờ thuộc chủ mới
SELECT lives_ok($q$SELECT public.set_join_approval('18000000-0000-4000-8000-000000000001', true)$q$,
  'JA-84a: approval back on for G1');
SELECT _t.login('c8000000-0000-4000-8000-000000000004');
SELECT is(public.join_by_code('JAONE001') ->> 'status', 'PENDING', 'JA-84b: U (rejected before) requests again');
SELECT _t.login('a8000000-0000-4000-8000-000000000001');
SELECT lives_ok(
  $q$SELECT public.transfer_ownership('18000000-0000-4000-8000-000000000001', 'b8000000-0000-4000-8000-000000000001')$q$,
  'JA-84c: owner transfers ownership to M');
SELECT throws_like($q$SELECT * FROM public.list_join_requests('18000000-0000-4000-8000-000000000001')$q$,
  'NOT_OWNER:%', 'JA-84: former owner can no longer list requests');
SELECT is((SELECT count(*)::int FROM public.group_join_requests
           WHERE group_id = '18000000-0000-4000-8000-000000000001'), 0,
  'JA-85: former owner can no longer read the group''s requests (RLS)');
SELECT _t.login('b8000000-0000-4000-8000-000000000001');
SELECT is(
  ARRAY(SELECT l.display_name FROM public.list_join_requests('18000000-0000-4000-8000-000000000001') l),
  ARRAY['Uma']::text[],
  'JA-86a: new owner sees the pending request');
SELECT lives_ok(
  format('SELECT public.approve_join_request(%L)',
         _t.req('18000000-0000-4000-8000-000000000001', 'c8000000-0000-4000-8000-000000000004')),
  'JA-86: new owner approves it');

-- ============================================================
-- 9. anon / chưa đăng nhập / ghi trực tiếp
-- ============================================================
SELECT _t.no_user();
SELECT throws_like($q$SELECT public.join_by_code('JAONE001')$q$, 'NOT_AUTHENTICATED:%',
  'JA-90: join_by_code requires a logged-in user');

SELECT _t.login('c8000000-0000-4000-8000-000000000006');
SELECT throws_ok(
  $q$INSERT INTO public.group_join_requests (group_id, user_id, via)
     VALUES ('18000000-0000-4000-8000-000000000001', 'c8000000-0000-4000-8000-000000000006', 'CODE')$q$,
  '42501', NULL, 'JA-91: authenticated cannot insert join requests directly');
SELECT throws_ok(
  $q$UPDATE public.group_join_requests SET status = 'APPROVED'$q$,
  '42501', NULL, 'JA-92: authenticated cannot update join requests directly');

SELECT _t.as_anon();
SELECT throws_ok($q$SELECT public.join_by_token('JAOPEN000005')$q$, '42501', NULL,
  'JA-93a: anon cannot call join_by_token');
SELECT throws_ok($q$SELECT public.join_by_code('JAONE001')$q$, '42501', NULL,
  'JA-93b: anon cannot call join_by_code');
SELECT throws_ok($q$SELECT * FROM public.list_join_requests('18000000-0000-4000-8000-000000000001')$q$, '42501', NULL,
  'JA-93c: anon cannot call list_join_requests');
SELECT throws_ok($q$SELECT public.approve_join_request('98000000-0000-4000-8000-000000000000')$q$, '42501', NULL,
  'JA-93d: anon cannot call approve_join_request');
SELECT throws_ok($q$SELECT count(*) FROM public.group_join_requests$q$, '42501', NULL,
  'JA-94: anon cannot read group_join_requests');
RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
