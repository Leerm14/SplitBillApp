-- ============================================================
-- MVP features (pgTAP) — migration 0012
--   MVP-01..07  create_group(_name, _description, _simplify_debts) — một lần, đủ trường
--   MVP-10..18  update_group: ảnh nhóm (_avatar_path '<group_id>/...', _clear_avatar)
--   MVP-20..27  find_user_by_code: khớp chính xác, không lọc searchable, bỏ hồ sơ đã xóa / chính mình
--   MVP-30..36  create_invite đích danh → thông báo GROUP_INVITED kèm invite_id
--   MVP-40..49  accept_invite_by_id: chỉ người được mời, giữ nguyên logic accept_invite
--   MVP-50..58  payment_handles: chủ sở hữu ghi được, display_text 1..200
--   MVP-60..62  quyền: anon không gọi được, authenticated gọi được
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

-- role authenticated nhưng không có sub (JWT thiếu / hỏng)
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

CREATE FUNCTION _t.def(_sig TEXT) RETURNS TEXT LANGUAGE sql AS $f$
  SELECT pg_get_functiondef(to_regprocedure(_sig));
$f$;

GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA _t TO anon, authenticated, service_role;

-- ------------------------------------------------------------
-- Fixtures
--   G1 ACTIVE: A chủ; B ACTIVE; R REMOVED.   G2 CLOSED: A chủ.
--   N tắt searchable, mã NSRCH001. D đã xóa (mã GONE0001). X người ngoài.
--   Y được mời đích danh. Z có lời mời đã thu hồi / hết hạn.
-- ------------------------------------------------------------
DO $$
BEGIN
  PERFORM _t.new_user('a6000000-0000-4000-8000-000000000001', 'Alice');
  PERFORM _t.new_user('b6000000-0000-4000-8000-000000000001', 'Bob');
  PERFORM _t.new_user('c6000000-0000-4000-8000-000000000001', 'Nina');
  PERFORM _t.new_user('c6000000-0000-4000-8000-000000000002', 'Dead');
  PERFORM _t.new_user('d6000000-0000-4000-8000-000000000001', 'Xavi');
  PERFORM _t.new_user('d6000000-0000-4000-8000-000000000002', 'Yuki');
  PERFORM _t.new_user('d6000000-0000-4000-8000-000000000003', 'Zed');
  PERFORM _t.new_user('e6000000-0000-4000-8000-000000000001', 'Rex');
END $$;

UPDATE public.profiles SET user_code = 'NSRCH001', searchable = false
WHERE id = 'c6000000-0000-4000-8000-000000000001';
UPDATE public.profiles SET user_code = 'GONE0001', deleted_at = now(), display_name = 'Người dùng đã xóa'
WHERE id = 'c6000000-0000-4000-8000-000000000002';
UPDATE public.profiles SET user_code = 'XAVI0001'
WHERE id = 'd6000000-0000-4000-8000-000000000001';

INSERT INTO public.groups (id, name, owner_id, invite_code, status) VALUES
  ('16000000-0000-4000-8000-000000000001', 'Mvp One', 'a6000000-0000-4000-8000-000000000001', 'MVPONE01', 'ACTIVE'),
  ('16000000-0000-4000-8000-000000000002', 'Mvp Closed', 'a6000000-0000-4000-8000-000000000001', 'MVPTWO02', 'CLOSED');

INSERT INTO public.group_members (group_id, user_id, role, status, left_at) VALUES
  ('16000000-0000-4000-8000-000000000001', 'a6000000-0000-4000-8000-000000000001', 'owner',  'ACTIVE',  NULL),
  ('16000000-0000-4000-8000-000000000001', 'b6000000-0000-4000-8000-000000000001', 'member', 'ACTIVE',  NULL),
  ('16000000-0000-4000-8000-000000000001', 'e6000000-0000-4000-8000-000000000001', 'member', 'REMOVED', now() - interval '1 day'),
  ('16000000-0000-4000-8000-000000000002', 'a6000000-0000-4000-8000-000000000001', 'owner',  'ACTIVE',  NULL);

INSERT INTO public.group_invites (id, group_id, token, invited_user_id, created_by, expires_at, max_uses, revoked_at) VALUES
  ('56000000-0000-4000-8000-000000000001', '16000000-0000-4000-8000-000000000001', 'MVPREVOKED01',
   'd6000000-0000-4000-8000-000000000003', 'a6000000-0000-4000-8000-000000000001', now() + interval '1 day', 1, now()),
  ('56000000-0000-4000-8000-000000000002', '16000000-0000-4000-8000-000000000001', 'MVPEXPIRED01',
   'd6000000-0000-4000-8000-000000000003', 'a6000000-0000-4000-8000-000000000001', now() - interval '1 hour', 1, NULL),
  ('56000000-0000-4000-8000-000000000003', '16000000-0000-4000-8000-000000000001', 'MVPOPEN00001',
   NULL, 'a6000000-0000-4000-8000-000000000001', now() + interval '1 day', 5, NULL),
  -- đích danh Z nhưng nhóm CLOSED
  ('56000000-0000-4000-8000-000000000004', '16000000-0000-4000-8000-000000000002', 'MVPCLOSED001',
   'd6000000-0000-4000-8000-000000000003', 'a6000000-0000-4000-8000-000000000001', now() + interval '1 day', 1, NULL);

INSERT INTO public.payment_handles (id, user_id, type, display_text) VALUES
  ('66000000-0000-4000-8000-000000000001', 'a6000000-0000-4000-8000-000000000001', 'BANK', 'VCB ***1234');

-- ============================================================
-- 1. create_group
-- ============================================================
SELECT ok(
  to_regprocedure('public.create_group(text)') IS NULL
  AND to_regprocedure('public.create_group(text,text,boolean)') IS NOT NULL,
  'MVP-01: create_group has only the 3-arg signature (legacy 1-arg dropped)');

SELECT _t.login('a6000000-0000-4000-8000-000000000001');
SELECT is(
  (SELECT row(g.name, g.description, g.simplify_debts, g.status, g.owner_id)::text
   FROM public.create_group('  Mvp Trip  ', 'Đà Lạt 3 ngày', false) g),
  row('Mvp Trip', 'Đà Lạt 3 ngày', false, 'ACTIVE', 'a6000000-0000-4000-8000-000000000001'::uuid)::text,
  'MVP-02: create_group stores trimmed name, description and simplify_debts = false in one call');

RESET ROLE;
SELECT is(
  (SELECT row(gm.role, gm.status, g.invite_code IS NOT NULL AND length(g.invite_code) = 8)::text
   FROM public.groups g JOIN public.group_members gm ON gm.group_id = g.id
   WHERE g.name = 'Mvp Trip' AND gm.user_id = 'a6000000-0000-4000-8000-000000000001'),
  row('owner', 'ACTIVE', true)::text,
  'MVP-03: creator is the ACTIVE owner member and the group has an invite_code');
SELECT is(
  (SELECT count(*)::int FROM public.activity_logs l JOIN public.groups g ON g.id = l.group_id
   WHERE g.name = 'Mvp Trip' AND l.action = 'CREATE' AND l.entity_type = 'GROUP'
     AND (l.after ->> 'simplify_debts')::boolean = false),
  1,
  'MVP-04: create_group writes a CREATE/GROUP activity log');

SELECT _t.login('a6000000-0000-4000-8000-000000000001');
SELECT is(
  (SELECT row(g.description, g.simplify_debts)::text FROM public.create_group('Mvp Default') g),
  row('', true)::text,
  'MVP-05: create_group defaults: description '''' and simplify_debts = true');
SELECT throws_like($q$SELECT public.create_group('   ', 'x', true)$q$, 'INVALID_NAME:%',
  'MVP-06: blank group name is rejected');
SELECT throws_like($q$SELECT public.create_group(NULL)$q$, 'INVALID_NAME:%',
  'MVP-07: NULL group name is rejected');

-- ============================================================
-- 2. update_group — ảnh nhóm
-- ============================================================
RESET ROLE;
SELECT ok(
  to_regprocedure('public.update_group(uuid,text,text,boolean)') IS NULL
  AND to_regprocedure('public.update_group(uuid,text,text,boolean,text,boolean)') IS NOT NULL,
  'MVP-10: update_group has only the 6-arg signature (legacy 4-arg dropped)');

SELECT _t.login('a6000000-0000-4000-8000-000000000001');
SELECT is(
  (SELECT row(g.name, g.avatar_path)::text
   FROM public.update_group('16000000-0000-4000-8000-000000000001', NULL, NULL, NULL,
                            '16000000-0000-4000-8000-000000000001/group_1700000000') g),
  row('Mvp One', '16000000-0000-4000-8000-000000000001/group_1700000000')::text,
  'MVP-11: owner sets the group image (public_id under <group_id>/), other fields kept');

SELECT throws_like(
  $q$SELECT public.update_group('16000000-0000-4000-8000-000000000001', NULL, NULL, NULL,
                                '16000000-0000-4000-8000-000000000002/group_1')$q$,
  'INVALID_AVATAR_PATH:%', 'MVP-12: image under another group''s folder is rejected');
SELECT throws_like(
  $q$SELECT public.update_group('16000000-0000-4000-8000-000000000001', NULL, NULL, NULL,
                                '16000000-0000-4000-8000-000000000001/')$q$,
  'INVALID_AVATAR_PATH:%', 'MVP-13: bare folder prefix is rejected');
SELECT throws_like(
  $q$SELECT public.update_group('16000000-0000-4000-8000-000000000001', NULL, NULL, NULL,
                                '16000000-0000-4000-8000-000000000001/../a6000000-0000-4000-8000-000000000001/avatar_1')$q$,
  'INVALID_AVATAR_PATH:%', 'MVP-14: path traversal is rejected');
SELECT throws_like(
  $q$SELECT public.update_group('16000000-0000-4000-8000-000000000001', NULL, NULL, NULL, 'group_1')$q$,
  'INVALID_AVATAR_PATH:%', 'MVP-15: path without the group prefix is rejected');

SELECT is(
  (SELECT row(g.name, g.simplify_debts, g.avatar_path)::text
   FROM public.update_group('16000000-0000-4000-8000-000000000001', 'Mvp Renamed', NULL, false) g),
  row('Mvp Renamed', false, '16000000-0000-4000-8000-000000000001/group_1700000000')::text,
  'MVP-16: 4-arg call (defaults) still works and keeps the current image');

SELECT is(
  (SELECT g.avatar_path
   FROM public.update_group('16000000-0000-4000-8000-000000000001', NULL, NULL, NULL,
                            '16000000-0000-4000-8000-000000000001/group_2', true) g),
  NULL::text,
  'MVP-17: _clear_avatar = true clears the image (wins over _avatar_path)');

SELECT throws_like(
  $q$SELECT public.update_group('16000000-0000-4000-8000-000000000002', NULL, NULL, NULL,
                                '16000000-0000-4000-8000-000000000002/group_1')$q$,
  'GROUP_CLOSED:%', 'MVP-18a: cannot set the image of a CLOSED group');

SELECT _t.login('b6000000-0000-4000-8000-000000000001');
SELECT throws_like(
  $q$SELECT public.update_group('16000000-0000-4000-8000-000000000001', NULL, NULL, NULL,
                                '16000000-0000-4000-8000-000000000001/group_3')$q$,
  'NOT_OWNER:%', 'MVP-18b: only the owner can change the group image');

-- ============================================================
-- 3. find_user_by_code
-- ============================================================
SELECT _t.login('d6000000-0000-4000-8000-000000000001');
SELECT is(
  (SELECT row(f.id, f.display_name, f.user_code)::text FROM public.find_user_by_code('  nsrch001 ') f),
  row('c6000000-0000-4000-8000-000000000001'::uuid, 'Nina', 'NSRCH001')::text,
  'MVP-20: exact code match (trimmed, case-insensitive) finds a non-searchable user');
SELECT is(
  (SELECT count(*)::int FROM public.search_users('NSRCH001')),
  0,
  'MVP-21: search_users still hides the non-searchable user (only QR / exact code finds them)');
SELECT is((SELECT count(*)::int FROM public.find_user_by_code('GONE0001')), 0,
  'MVP-22: deleted profiles are excluded');
SELECT is((SELECT count(*)::int FROM public.find_user_by_code('XAVI0001')), 0,
  'MVP-23: the caller''s own code returns nothing');
SELECT is(
  (SELECT count(*)::int FROM public.find_user_by_code('ZZZZZZZZ'))
  + (SELECT count(*)::int FROM public.find_user_by_code(''))
  + (SELECT count(*)::int FROM public.find_user_by_code(NULL))
  + (SELECT count(*)::int FROM public.find_user_by_code('NSRCH%')),
  0,
  'MVP-24: unknown / empty / NULL / wildcard codes return an empty result');
SELECT is(
  pg_get_function_result('public.find_user_by_code(text)'::regprocedure),
  'TABLE(id uuid, display_name text, user_code text, avatar_path text)',
  'MVP-25: find_user_by_code returns only the 4 public columns');

SELECT _t.no_user();
SELECT throws_like($q$SELECT * FROM public.find_user_by_code('NSRCH001')$q$, 'NOT_AUTHENTICATED:%',
  'MVP-26: find_user_by_code requires a logged-in user');

SELECT _t.login('c6000000-0000-4000-8000-000000000002');
SELECT throws_like($q$SELECT * FROM public.find_user_by_code('NSRCH001')$q$, 'ACCOUNT_DELETED:%',
  'MVP-27: a deleted account cannot look up codes');

-- ============================================================
-- 4. create_invite → GROUP_INVITED
-- ============================================================
RESET ROLE;
SELECT ok(
  EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
    WHERE c.conrelid = 'public.notifications'::regclass AND c.contype = 'f'
      AND a.attname = 'invite_id' AND c.confrelid = 'public.group_invites'::regclass
      AND c.confdeltype = 'c'
  ),
  'MVP-30: notifications.invite_id references group_invites ON DELETE CASCADE');

SELECT _t.login('a6000000-0000-4000-8000-000000000001');
SELECT lives_ok(
  $q$SELECT public.create_invite('16000000-0000-4000-8000-000000000001', 'd6000000-0000-4000-8000-000000000002')$q$,
  'MVP-31: owner creates an addressed invite for Y');

RESET ROLE;
SELECT is(
  (SELECT row(n.type, n.group_id, n.actor_id, n.invite_id = gi.id, n.read_at IS NULL)::text
   FROM public.notifications n
   JOIN public.group_invites gi ON gi.group_id = '16000000-0000-4000-8000-000000000001'
                               AND gi.invited_user_id = 'd6000000-0000-4000-8000-000000000002'
   WHERE n.user_id = 'd6000000-0000-4000-8000-000000000002'),
  row('GROUP_INVITED', '16000000-0000-4000-8000-000000000001'::uuid,
      'a6000000-0000-4000-8000-000000000001'::uuid, true, true)::text,
  'MVP-32: invitee gets exactly one GROUP_INVITED with group_id, actor_id (inviter) and invite_id');

SELECT _t.login('a6000000-0000-4000-8000-000000000001');
SELECT lives_ok($q$SELECT public.create_invite('16000000-0000-4000-8000-000000000001')$q$,
  'MVP-33a: open invite still works');
SELECT lives_ok(
  $q$SELECT public.create_invite('16000000-0000-4000-8000-000000000001', 'b6000000-0000-4000-8000-000000000001')$q$,
  'MVP-33b: addressed invite to an ACTIVE member still works');
RESET ROLE;
SELECT is(
  (SELECT count(*)::int FROM public.notifications WHERE type = 'GROUP_INVITED'),
  1,
  'MVP-33: open invites and invites to ACTIVE members create no GROUP_INVITED');

-- Người được mời đọc được thông báo (kèm invite_id) nhưng KHÔNG đọc được lời mời / token
SELECT _t.login('d6000000-0000-4000-8000-000000000002');
SELECT is(
  (SELECT count(*)::int FROM public.notifications WHERE type = 'GROUP_INVITED' AND invite_id IS NOT NULL),
  1,
  'MVP-34: invitee reads own GROUP_INVITED notification with invite_id');
SELECT is((SELECT count(*)::int FROM public.group_invites), 0,
  'MVP-35: invitee cannot read group_invites (token) — hence accept_invite_by_id');

SELECT _t.login('b6000000-0000-4000-8000-000000000001');
SELECT throws_like(
  $q$SELECT public.create_invite('16000000-0000-4000-8000-000000000001', 'e6000000-0000-4000-8000-000000000001')$q$,
  'NOT_OWNER:%', 'MVP-36: non-owner still cannot re-invite a REMOVED member (BE-07 kept)');

-- ============================================================
-- 5. accept_invite_by_id
-- ============================================================
SELECT ok(
  _t.def('public.accept_invite_by_id(uuid)') LIKE '%public.accept_invite(_token)%',
  'MVP-40: accept_invite_by_id delegates to accept_invite (same lock order: group → invite)');

-- X (không phải người được mời) dùng id lời mời của Y
SELECT _t.login('d6000000-0000-4000-8000-000000000001');
SELECT throws_like($q$SELECT public.accept_invite_by_id(NULL)$q$,
  'INVITE_NOT_FOUND:%', 'MVP-41: NULL invite id → INVITE_NOT_FOUND');
RESET ROLE;
CREATE TEMP TABLE _y_invite AS
  SELECT id FROM public.group_invites
  WHERE group_id = '16000000-0000-4000-8000-000000000001'
    AND invited_user_id = 'd6000000-0000-4000-8000-000000000002';
GRANT SELECT ON _y_invite TO authenticated;

SELECT _t.login('d6000000-0000-4000-8000-000000000001');
SELECT throws_like(
  format('SELECT public.accept_invite_by_id(%L)', (SELECT id FROM _y_invite)),
  'INVITE_NOT_FOR_YOU:%', 'MVP-42: someone else cannot accept an invite addressed to Y');
SELECT throws_like(
  $q$SELECT public.accept_invite_by_id('56000000-0000-4000-8000-000000000003')$q$,
  'INVITE_NOT_FOR_YOU:%', 'MVP-43: open (non-addressed) invites cannot be accepted by id');
SELECT throws_like(
  $q$SELECT public.accept_invite_by_id('56000000-0000-4000-8000-0000000000ff')$q$,
  'INVITE_NOT_FOUND:%', 'MVP-44: unknown invite id → INVITE_NOT_FOUND');

SELECT _t.login('d6000000-0000-4000-8000-000000000002');
SELECT is(
  (SELECT g.id FROM public.accept_invite_by_id((SELECT id FROM _y_invite)) g),
  '16000000-0000-4000-8000-000000000001'::uuid,
  'MVP-45: invitee accepts by id and joins the group');
SELECT is(
  (SELECT g.id FROM public.accept_invite_by_id((SELECT id FROM _y_invite)) g),
  '16000000-0000-4000-8000-000000000001'::uuid,
  'MVP-46: accepting again while ACTIVE is idempotent');
RESET ROLE;
SELECT is(
  (SELECT row(gm.status, gi.used_count,
              (SELECT count(*) FROM public.notifications
               WHERE user_id = 'a6000000-0000-4000-8000-000000000001' AND type = 'MEMBER_JOINED'
                 AND actor_id = 'd6000000-0000-4000-8000-000000000002'))::text
   FROM public.group_members gm, public.group_invites gi
   WHERE gm.group_id = '16000000-0000-4000-8000-000000000001'
     AND gm.user_id = 'd6000000-0000-4000-8000-000000000002'
     AND gi.id = (SELECT id FROM _y_invite)),
  row('ACTIVE', 1, 1)::text,
  'MVP-47: member ACTIVE, used_count 1 (idempotent accept free), owner notified once');

SELECT _t.login('d6000000-0000-4000-8000-000000000003');
SELECT throws_like($q$SELECT public.accept_invite_by_id('56000000-0000-4000-8000-000000000001')$q$,
  'INVITE_REVOKED:%', 'MVP-48a: revoked invite → INVITE_REVOKED');
SELECT throws_like($q$SELECT public.accept_invite_by_id('56000000-0000-4000-8000-000000000002')$q$,
  'INVITE_EXPIRED:%', 'MVP-48b: expired invite → INVITE_EXPIRED');
SELECT throws_like($q$SELECT public.accept_invite_by_id('56000000-0000-4000-8000-000000000004')$q$,
  'GROUP_CLOSED:%', 'MVP-48c: invite to a CLOSED group → GROUP_CLOSED');

-- BE-07: chủ nhóm mời lại người REMOVED → thông báo → chấp nhận bằng id
SELECT _t.login('a6000000-0000-4000-8000-000000000001');
SELECT lives_ok(
  $q$SELECT public.create_invite('16000000-0000-4000-8000-000000000001', 'e6000000-0000-4000-8000-000000000001')$q$,
  'MVP-49a: owner re-invites the REMOVED member');
SELECT _t.login('e6000000-0000-4000-8000-000000000001');
SELECT is(
  (SELECT g.id FROM public.accept_invite_by_id(
     (SELECT n.invite_id FROM public.notifications n WHERE n.type = 'GROUP_INVITED')) g),
  '16000000-0000-4000-8000-000000000001'::uuid,
  'MVP-49b: REMOVED member rejoins via the GROUP_INVITED notification''s invite_id');

-- ============================================================
-- 6. payment_handles
-- ============================================================
RESET ROLE;
SELECT ok(
  (SELECT convalidated FROM pg_constraint
   WHERE conrelid = 'public.payment_handles'::regclass AND conname = 'payment_handles_display_text_length'),
  'MVP-50: display_text length constraint exists and is validated');
SELECT ok(
  has_table_privilege('authenticated', 'public.payment_handles', 'INSERT')
  AND has_table_privilege('authenticated', 'public.payment_handles', 'UPDATE')
  AND has_table_privilege('authenticated', 'public.payment_handles', 'DELETE')
  AND NOT has_table_privilege('anon', 'public.payment_handles', 'SELECT'),
  'MVP-51: authenticated may write payment_handles (RLS limits to own rows); anon has nothing');

SELECT _t.login('a6000000-0000-4000-8000-000000000001');
SELECT lives_ok(
  $q$INSERT INTO public.payment_handles (user_id, type, display_text)
     VALUES ('a6000000-0000-4000-8000-000000000001', 'EWALLET', 'Momo 0901 *** 789')$q$,
  'MVP-52: owner inserts a payment handle');
UPDATE public.payment_handles SET display_text = 'Vietcombank 0123 — NGUYEN VAN A'
WHERE id = '66000000-0000-4000-8000-000000000001';
SELECT is(
  (SELECT display_text FROM public.payment_handles WHERE id = '66000000-0000-4000-8000-000000000001'),
  'Vietcombank 0123 — NGUYEN VAN A',
  'MVP-53: owner updates own payment handle');
SELECT throws_ok(
  $q$UPDATE public.payment_handles SET display_text = '' WHERE id = '66000000-0000-4000-8000-000000000001'$q$,
  '23514', NULL, 'MVP-54a: empty display_text is rejected');
SELECT throws_ok(
  $q$UPDATE public.payment_handles SET display_text = '    ' WHERE id = '66000000-0000-4000-8000-000000000001'$q$,
  '23514', NULL, 'MVP-54b: whitespace-only display_text is rejected');
SELECT throws_ok(
  $q$INSERT INTO public.payment_handles (user_id, type, display_text)
     VALUES ('a6000000-0000-4000-8000-000000000001', 'OTHER', repeat('x', 201))$q$,
  '23514', NULL, 'MVP-55a: 201-character display_text is rejected');
SELECT lives_ok(
  $q$INSERT INTO public.payment_handles (user_id, type, display_text)
     VALUES ('a6000000-0000-4000-8000-000000000001', 'OTHER', repeat('x', 200))$q$,
  'MVP-55b: 200-character display_text is accepted');

-- B (cùng nhóm, đọc được) không sửa / xóa / chèn hộ được
SELECT _t.login('b6000000-0000-4000-8000-000000000001');
UPDATE public.payment_handles SET display_text = 'hijacked' WHERE id = '66000000-0000-4000-8000-000000000001';
DELETE FROM public.payment_handles WHERE id = '66000000-0000-4000-8000-000000000001';
SELECT throws_ok(
  $q$INSERT INTO public.payment_handles (user_id, type, display_text)
     VALUES ('a6000000-0000-4000-8000-000000000001', 'BANK', 'fake')$q$,
  '42501', NULL, 'MVP-56a: cannot insert a handle for someone else');
RESET ROLE;
SELECT is(
  (SELECT display_text FROM public.payment_handles WHERE id = '66000000-0000-4000-8000-000000000001'),
  'Vietcombank 0123 — NGUYEN VAN A',
  'MVP-56: another user cannot update or delete my payment handle');

SELECT _t.login('a6000000-0000-4000-8000-000000000001');
DELETE FROM public.payment_handles WHERE id = '66000000-0000-4000-8000-000000000001';
RESET ROLE;
SELECT is(
  (SELECT count(*)::int FROM public.payment_handles WHERE id = '66000000-0000-4000-8000-000000000001'),
  0,
  'MVP-57: owner deletes own payment handle');

-- ============================================================
-- 7. Quyền
-- ============================================================
SELECT is(
  ARRAY(
    SELECT f FROM unnest(ARRAY[
      'public.create_group(text,text,boolean)',
      'public.update_group(uuid,text,text,boolean,text,boolean)',
      'public.find_user_by_code(text)',
      'public.create_invite(uuid,uuid,integer,integer)',
      'public.accept_invite_by_id(uuid)'
    ]) f
    WHERE has_function_privilege('anon', f, 'EXECUTE')
       OR NOT has_function_privilege('authenticated', f, 'EXECUTE')
  ),
  ARRAY[]::text[],
  'MVP-60: new/changed RPCs — anon denied, authenticated allowed');

SELECT _t.as_anon();
SELECT throws_ok($q$SELECT * FROM public.find_user_by_code('NSRCH001')$q$, '42501', NULL,
  'MVP-61: anon cannot call find_user_by_code');
SELECT throws_ok($q$SELECT public.accept_invite_by_id('56000000-0000-4000-8000-000000000003')$q$, '42501', NULL,
  'MVP-62: anon cannot call accept_invite_by_id');
RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
