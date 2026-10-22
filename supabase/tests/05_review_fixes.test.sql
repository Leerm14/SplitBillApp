-- ============================================================
-- Review fixes (pgTAP) — migration 0011
--   REV-01..05  transfer_ownership khóa nhóm, từ chối nhóm CLOSED / người nhận không ACTIVE
--   REV-10..13  bạn bè (ACCEPTED) đọc được payment_handles
--   REV-20..31  accept_invite / revoke_invite: thứ tự khóa groups → invites, giữ hành vi 0010
--   REV-40..47  handle_auth_user_deleted: dọn dữ liệu khi xóa user Auth ngoài app
--   REV-50..57  register_push_token / unregister_push_token
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

CREATE FUNCTION _t.def(_sig TEXT) RETURNS TEXT LANGUAGE sql AS $f$
  SELECT pg_get_functiondef(to_regprocedure(_sig));
$f$;

GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA _t TO anon, authenticated, service_role;

-- ------------------------------------------------------------
-- Fixtures
--   G1 ACTIVE: A chủ; B, W ACTIVE; C LEFT; R REMOVED.
--   G2 CLOSED: A chủ; B ACTIVE.
--   G3 ACTIVE: O chủ; B ACTIVE; O có số dư +5000 (B nợ O).
--   H có phương thức thanh toán; F bạn (ACCEPTED) của H; N chỉ mới gửi lời mời (PENDING).
--   X người ngoài. P1, P2 dùng chung một thiết bị.
-- ------------------------------------------------------------
DO $$
BEGIN
  PERFORM _t.new_user('a1000000-0000-4000-8000-000000000001', 'Alice');
  PERFORM _t.new_user('b1000000-0000-4000-8000-000000000001', 'Bob');
  PERFORM _t.new_user('c1000000-0000-4000-8000-000000000001', 'Cleo');
  PERFORM _t.new_user('e1000000-0000-4000-8000-000000000001', 'Rex');
  PERFORM _t.new_user('d1000000-0000-4000-8000-000000000001', 'Walt');
  PERFORM _t.new_user('d2000000-0000-4000-8000-000000000002', 'Olga');
  PERFORM _t.new_user('f1000000-0000-4000-8000-000000000001', 'Finn');
  PERFORM _t.new_user('f2000000-0000-4000-8000-000000000002', 'Hana');
  PERFORM _t.new_user('f3000000-0000-4000-8000-000000000003', 'Nate');
  PERFORM _t.new_user('f4000000-0000-4000-8000-000000000004', 'Xena');
  PERFORM _t.new_user('f5000000-0000-4000-8000-000000000005', 'Pia');
  PERFORM _t.new_user('f6000000-0000-4000-8000-000000000006', 'Paz');
END $$;

INSERT INTO public.groups (id, name, owner_id, invite_code, status) VALUES
  ('11000000-0000-4000-8000-000000000001', 'Rev One', 'a1000000-0000-4000-8000-000000000001', 'REVONE01', 'ACTIVE'),
  ('11000000-0000-4000-8000-000000000002', 'Rev Closed', 'a1000000-0000-4000-8000-000000000001', 'REVTWO02', 'CLOSED'),
  ('11000000-0000-4000-8000-000000000003', 'Rev Olga', 'd2000000-0000-4000-8000-000000000002', 'REVTRE03', 'ACTIVE');

INSERT INTO public.group_members (group_id, user_id, role, status, left_at) VALUES
  ('11000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000001', 'owner',  'ACTIVE',  NULL),
  ('11000000-0000-4000-8000-000000000001', 'b1000000-0000-4000-8000-000000000001', 'member', 'ACTIVE',  NULL),
  ('11000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000001', 'member', 'ACTIVE',  NULL),
  ('11000000-0000-4000-8000-000000000001', 'c1000000-0000-4000-8000-000000000001', 'member', 'LEFT',    now() - interval '1 day'),
  ('11000000-0000-4000-8000-000000000001', 'e1000000-0000-4000-8000-000000000001', 'member', 'REMOVED', now() - interval '1 day'),
  ('11000000-0000-4000-8000-000000000002', 'a1000000-0000-4000-8000-000000000001', 'owner',  'ACTIVE',  NULL),
  ('11000000-0000-4000-8000-000000000002', 'b1000000-0000-4000-8000-000000000001', 'member', 'ACTIVE',  NULL),
  ('11000000-0000-4000-8000-000000000003', 'd2000000-0000-4000-8000-000000000002', 'owner',  'ACTIVE',  NULL),
  ('11000000-0000-4000-8000-000000000003', 'b1000000-0000-4000-8000-000000000001', 'member', 'ACTIVE',  NULL);

INSERT INTO public.expenses (id, group_id, paid_by, amount, description, created_by, idempotency_key) VALUES
  ('21000000-0000-4000-8000-000000000001', '11000000-0000-4000-8000-000000000003',
   'd2000000-0000-4000-8000-000000000002', 10000, 'Olga paid', 'd2000000-0000-4000-8000-000000000002', 'rev-olga-1');
INSERT INTO public.expense_shares (expense_id, user_id, amount) VALUES
  ('21000000-0000-4000-8000-000000000001', 'd2000000-0000-4000-8000-000000000002', 5000),
  ('21000000-0000-4000-8000-000000000001', 'b1000000-0000-4000-8000-000000000001', 5000);

INSERT INTO public.group_invites (id, group_id, token, invited_user_id, created_by, expires_at, max_uses) VALUES
  -- mở, do A tạo
  ('51000000-0000-4000-8000-000000000001', '11000000-0000-4000-8000-000000000001', 'REVOPEN00001',
   NULL, 'a1000000-0000-4000-8000-000000000001', now() + interval '1 day', 5),
  -- đích danh R, do chủ nhóm A tạo → R (REMOVED) vào lại được
  ('51000000-0000-4000-8000-000000000002', '11000000-0000-4000-8000-000000000001', 'REVREMOVED01',
   'e1000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000001', now() + interval '1 day', 1),
  -- do B tạo (B tự thu hồi)
  ('51000000-0000-4000-8000-000000000003', '11000000-0000-4000-8000-000000000001', 'REVBOB000001',
   NULL, 'b1000000-0000-4000-8000-000000000001', now() + interval '1 day', 1),
  -- do W tạo (trigger xóa user thu hồi)
  ('51000000-0000-4000-8000-000000000004', '11000000-0000-4000-8000-000000000001', 'REVWALT00001',
   NULL, 'd1000000-0000-4000-8000-000000000001', now() + interval '1 day', 1),
  -- nhóm CLOSED
  ('51000000-0000-4000-8000-000000000005', '11000000-0000-4000-8000-000000000002', 'REVCLOSED001',
   NULL, 'a1000000-0000-4000-8000-000000000001', now() + interval '1 day', 1);

INSERT INTO public.payment_handles (user_id, type, display_text) VALUES
  ('f2000000-0000-4000-8000-000000000002', 'BANK', 'VCB ***9999'),
  ('d1000000-0000-4000-8000-000000000001', 'EWALLET', 'Momo ***1111');
INSERT INTO public.friendships (requester_id, addressee_id, status) VALUES
  ('f2000000-0000-4000-8000-000000000002', 'f1000000-0000-4000-8000-000000000001', 'ACCEPTED'),
  ('f3000000-0000-4000-8000-000000000003', 'f2000000-0000-4000-8000-000000000002', 'PENDING'),
  ('d1000000-0000-4000-8000-000000000001', 'f1000000-0000-4000-8000-000000000001', 'ACCEPTED');
INSERT INTO public.push_tokens (user_id, expo_token, platform) VALUES
  ('d1000000-0000-4000-8000-000000000001', 'ExponentPushToken[walt]', 'ios');

-- ============================================================
-- 1. transfer_ownership
-- ============================================================
SELECT ok(_t.def('public.transfer_ownership(uuid,uuid)') ~* 'from\s+public\.groups\s+where\s+id\s*=\s*_group_id\s+for\s+update',
  'REV-01: transfer_ownership locks the groups row FOR UPDATE');

SELECT _t.login('a1000000-0000-4000-8000-000000000001');

SELECT throws_like(
  $q$SELECT public.transfer_ownership('11000000-0000-4000-8000-000000000002', 'b1000000-0000-4000-8000-000000000001')$q$,
  'GROUP_CLOSED:%',
  'REV-02: transfer_ownership on a CLOSED group is rejected');

SELECT throws_like(
  $q$SELECT public.transfer_ownership('11000000-0000-4000-8000-000000000001', 'c1000000-0000-4000-8000-000000000001')$q$,
  'TARGET_NOT_MEMBER:%',
  'REV-03: transfer_ownership to a LEFT member is rejected');

SELECT _t.login('b1000000-0000-4000-8000-000000000001');
SELECT throws_like(
  $q$SELECT public.transfer_ownership('11000000-0000-4000-8000-000000000001', 'b1000000-0000-4000-8000-000000000001')$q$,
  'NOT_OWNER:%',
  'REV-04: non-owner cannot transfer ownership');

-- ============================================================
-- 2. payment_handles — bạn bè
-- ============================================================
SELECT _t.login('f1000000-0000-4000-8000-000000000001');
SELECT is(
  (SELECT count(*)::int FROM public.payment_handles WHERE user_id = 'f2000000-0000-4000-8000-000000000002'), 1,
  'REV-10: friend (addressee side of ACCEPTED) can read payment handles');

SELECT _t.login('f2000000-0000-4000-8000-000000000002');
SELECT is(
  (SELECT count(*)::int FROM public.payment_handles WHERE user_id = 'd1000000-0000-4000-8000-000000000001'), 0,
  'REV-11: friend-of-friend cannot read payment handles');

SELECT _t.login('f3000000-0000-4000-8000-000000000003');
SELECT is(
  (SELECT count(*)::int FROM public.payment_handles WHERE user_id = 'f2000000-0000-4000-8000-000000000002'), 0,
  'REV-12: PENDING friend request does not grant access to payment handles');

SELECT _t.login('f4000000-0000-4000-8000-000000000004');
SELECT is(
  (SELECT count(*)::int FROM public.payment_handles), 0,
  'REV-13: stranger reads no payment handles');

-- ============================================================
-- 3. accept_invite / revoke_invite
-- ============================================================
SELECT ok(
  _t.def('public.accept_invite(text)') ~* 'from\s+public\.groups\s+where\s+id\s*=\s*_group_id\s+for\s+share.*from\s+public\.group_invites\s+where\s+id\s*=\s*_invite_id\s+for\s+update',
  'REV-20: accept_invite locks groups FOR SHARE before the invite FOR UPDATE');

SELECT ok(
  position('assert_active_member_of_active_group(' IN _t.def('public.revoke_invite(uuid)'))
    BETWEEN 1 AND position('FOR UPDATE' IN _t.def('public.revoke_invite(uuid)')),
  'REV-21: revoke_invite locks the group (helper) before the invite FOR UPDATE');

-- anonymize_account: groups FOR UPDATE trước, hồ sơ FOR NO KEY UPDATE sau (không
-- xung đột FOR KEY SHARE của FK khi RPC khác chèn dòng tham chiếu hồ sơ)
SELECT ok(
  _t.def('public.anonymize_account(uuid)') ~* 'from\s+public\.profiles\s+where\s+id\s*=\s*_user_id\s+for\s+no\s+key\s+update'
  AND _t.def('public.anonymize_account(uuid)') !~* 'from\s+public\.profiles\s+where\s+id\s*=\s*_user_id\s+for\s+update'
  AND _t.def('public.anonymize_account(uuid)') ~* 'order\s+by\s+g\.id\s+for\s+update.*from\s+public\.profiles\s+where\s+id\s*=\s*_user_id\s+for\s+no\s+key\s+update',
  'REV-36: anonymize_account locks groups FOR UPDATE before the profile FOR NO KEY UPDATE');

-- X: người mới vào bằng lời mời mở
SELECT _t.login('f4000000-0000-4000-8000-000000000004');
SELECT is(
  (public.accept_invite('REVOPEN00001')).id, '11000000-0000-4000-8000-000000000001'::uuid,
  'REV-22: accept_invite joins the group');

RESET ROLE;
SELECT is(
  (SELECT row(gm.status, gi.used_count)::text
   FROM public.group_members gm, public.group_invites gi
   WHERE gm.group_id = '11000000-0000-4000-8000-000000000001' AND gm.user_id = 'f4000000-0000-4000-8000-000000000004'
     AND gi.id = '51000000-0000-4000-8000-000000000001'),
  row('ACTIVE', 1)::text,
  'REV-23: member is ACTIVE and used_count incremented');
SELECT is(
  (SELECT count(*)::int FROM public.notifications
   WHERE user_id = 'a1000000-0000-4000-8000-000000000001' AND type = 'MEMBER_JOINED'
     AND actor_id = 'f4000000-0000-4000-8000-000000000004'),
  1,
  'REV-24: owner gets MEMBER_JOINED with actor');

SELECT _t.login('f4000000-0000-4000-8000-000000000004');
SELECT is(
  (public.accept_invite('REVOPEN00001')).id, '11000000-0000-4000-8000-000000000001'::uuid,
  'REV-25: accepting again while ACTIVE is idempotent');
RESET ROLE;
SELECT is((SELECT used_count FROM public.group_invites WHERE id = '51000000-0000-4000-8000-000000000001'), 1,
  'REV-26: idempotent accept does not consume a use');

SELECT _t.login('e1000000-0000-4000-8000-000000000001');
SELECT throws_like($q$SELECT public.accept_invite('REVOPEN00001')$q$, 'MEMBER_REMOVED:%',
  'REV-27: REMOVED member cannot rejoin with an open invite');
SELECT is(
  (public.accept_invite('REVREMOVED01')).id, '11000000-0000-4000-8000-000000000001'::uuid,
  'REV-28: REMOVED member rejoins with an owner-addressed invite (BE-07 kept)');

SELECT _t.login('f4000000-0000-4000-8000-000000000004');
SELECT throws_like($q$SELECT public.accept_invite('REVCLOSED001')$q$, 'GROUP_CLOSED:%',
  'REV-29: invite to a CLOSED group is rejected');
SELECT throws_like($q$SELECT public.accept_invite('NOSUCHTOKEN0')$q$, 'INVITE_NOT_FOUND:%',
  'REV-30: unknown token → INVITE_NOT_FOUND');

-- revoke_invite: X (thành viên, không tạo, không phải chủ) → NOT_AUTHORIZED
SELECT throws_like($q$SELECT public.revoke_invite('51000000-0000-4000-8000-000000000003')$q$, 'NOT_AUTHORIZED:%',
  'REV-31: member who is not creator/owner cannot revoke');

SELECT _t.login('f3000000-0000-4000-8000-000000000003');
SELECT throws_like($q$SELECT public.revoke_invite('51000000-0000-4000-8000-000000000003')$q$, 'NOT_MEMBER:%',
  'REV-32: outsider cannot revoke (and cannot probe invites)');

SELECT _t.login('b1000000-0000-4000-8000-000000000001');
SELECT ok((public.revoke_invite('51000000-0000-4000-8000-000000000003')).revoked_at IS NOT NULL,
  'REV-33: creator revokes own invite');
SELECT lives_ok($q$SELECT public.revoke_invite('51000000-0000-4000-8000-000000000003')$q$,
  'REV-34: revoking again is idempotent');
RESET ROLE;
SELECT is(
  (SELECT count(*)::int FROM public.activity_logs
   WHERE action = 'REVOKE' AND entity_id = '51000000-0000-4000-8000-000000000003'),
  1,
  'REV-35: revoke is logged once');

-- transfer_ownership thành công (sau các test lời mời: R cần lời mời do chủ hiện tại tạo)
SELECT _t.login('a1000000-0000-4000-8000-000000000001');
SELECT is(
  (public.transfer_ownership('11000000-0000-4000-8000-000000000001', 'b1000000-0000-4000-8000-000000000001')).owner_id,
  'b1000000-0000-4000-8000-000000000001'::uuid,
  'REV-05: owner transfers to an ACTIVE member');
RESET ROLE;
SELECT is(
  (SELECT string_agg(user_id::text || '=' || role, ',' ORDER BY user_id) FROM public.group_members
   WHERE group_id = '11000000-0000-4000-8000-000000000001'
     AND user_id IN ('a1000000-0000-4000-8000-000000000001', 'b1000000-0000-4000-8000-000000000001')),
  'a1000000-0000-4000-8000-000000000001=member,b1000000-0000-4000-8000-000000000001=owner',
  'REV-06: roles swapped after transfer');

-- ============================================================
-- 4. Xóa user Auth ngoài app (trigger)
-- ============================================================
RESET ROLE;
SELECT lives_ok($q$DELETE FROM auth.users WHERE id = 'd1000000-0000-4000-8000-000000000001'$q$,
  'REV-40: deleting an Auth user (clean member) succeeds');

SELECT is(
  (SELECT row(status, left_at IS NOT NULL)::text FROM public.group_members
   WHERE group_id = '11000000-0000-4000-8000-000000000001' AND user_id = 'd1000000-0000-4000-8000-000000000001'),
  row('LEFT', true)::text,
  'REV-41: ACTIVE membership becomes LEFT with left_at');

SELECT ok(
  (SELECT revoked_at IS NOT NULL FROM public.group_invites WHERE id = '51000000-0000-4000-8000-000000000004'),
  'REV-42: invites created by the deleted user are revoked');

SELECT is(
  (SELECT count(*)::int FROM public.friendships
   WHERE requester_id = 'd1000000-0000-4000-8000-000000000001' OR addressee_id = 'd1000000-0000-4000-8000-000000000001')
  + (SELECT count(*)::int FROM public.payment_handles WHERE user_id = 'd1000000-0000-4000-8000-000000000001')
  + (SELECT count(*)::int FROM public.push_tokens WHERE user_id = 'd1000000-0000-4000-8000-000000000001'),
  0,
  'REV-43: friendships, payment handles and push tokens are removed');

SELECT is(
  (SELECT row(display_name, deleted_at IS NOT NULL, user_code LIKE 'DEL%')::text
   FROM public.profiles WHERE id = 'd1000000-0000-4000-8000-000000000001'),
  row('Người dùng đã xóa', true, true)::text,
  'REV-44: profile anonymized (tombstone)');

SELECT is(
  (SELECT count(*)::int FROM public.notifications
   WHERE user_id = 'b1000000-0000-4000-8000-000000000001' AND type = 'MEMBER_LEFT'
     AND group_id = '11000000-0000-4000-8000-000000000001'
     AND actor_id = 'd1000000-0000-4000-8000-000000000001'),
  1,
  'REV-45: current owner is notified MEMBER_LEFT');

SELECT is(
  (SELECT count(*)::int FROM public.activity_logs WHERE action = 'ACCOUNT_DELETED_UNSAFE'
     AND actor_id = 'd1000000-0000-4000-8000-000000000001'),
  0,
  'REV-46: clean deletion is not flagged as unsafe');

-- O: chủ nhóm ACTIVE, số dư ≠ 0 → xóa vẫn thành công, nhưng có dấu vết cho quản trị
SELECT lives_ok($q$DELETE FROM auth.users WHERE id = 'd2000000-0000-4000-8000-000000000002'$q$,
  'REV-47: deleting an owner with a balance never fails (Dashboard deletion)');

SELECT is(
  (SELECT after -> 'reasons' FROM public.activity_logs
   WHERE action = 'ACCOUNT_DELETED_UNSAFE' AND actor_id = 'd2000000-0000-4000-8000-000000000002'
     AND group_id = '11000000-0000-4000-8000-000000000003'),
  '["OWNER_OF_ACTIVE_GROUP", "NONZERO_BALANCE"]'::jsonb,
  'REV-48: unsafe deletion recorded in activity_logs with reasons');

SELECT is(
  (SELECT row(gm.status, p.deleted_at IS NOT NULL)::text
   FROM public.group_members gm JOIN public.profiles p ON p.id = gm.user_id
   WHERE gm.group_id = '11000000-0000-4000-8000-000000000003' AND gm.user_id = 'd2000000-0000-4000-8000-000000000002'),
  row('LEFT', true)::text,
  'REV-49: unsafe deletion still anonymizes and leaves the group');

-- ============================================================
-- 5. Push token theo thiết bị
-- ============================================================
SELECT ok(
  NOT has_function_privilege('anon', 'public.register_push_token(text,text)', 'EXECUTE')
  AND has_function_privilege('authenticated', 'public.register_push_token(text,text)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.unregister_push_token(text)', 'EXECUTE')
  AND has_function_privilege('authenticated', 'public.unregister_push_token(text)', 'EXECUTE'),
  'REV-50: push token RPCs are authenticated-only');

SELECT _t.login('f5000000-0000-4000-8000-000000000005');
SELECT lives_ok($q$SELECT public.register_push_token('ExponentPushToken[shared]', 'ios')$q$,
  'REV-51: P1 registers the device token');
SELECT lives_ok($q$SELECT public.register_push_token('ExponentPushToken[p1-only]', 'android')$q$,
  'REV-52: P1 registers a second device');

SELECT _t.login('f6000000-0000-4000-8000-000000000006');
SELECT lives_ok($q$SELECT public.register_push_token('ExponentPushToken[shared]', 'android')$q$,
  'REV-53: P2 signs in on the same device');

RESET ROLE;
SELECT is(
  (SELECT string_agg(user_id::text || ':' || platform, ',' ORDER BY user_id)
   FROM public.push_tokens WHERE expo_token = 'ExponentPushToken[shared]'),
  'f6000000-0000-4000-8000-000000000006:android',
  'REV-54: register_push_token removes the other user''s row for the same token');
SELECT is(
  (SELECT count(*)::int FROM public.push_tokens WHERE user_id = 'f5000000-0000-4000-8000-000000000005'), 1,
  'REV-55: other devices of the previous user are kept');

SELECT _t.login('f6000000-0000-4000-8000-000000000006');
SELECT public.register_push_token('ExponentPushToken[shared]', 'ios');
SELECT throws_like($q$SELECT public.register_push_token('   ', 'ios')$q$, 'INVALID_PUSH_TOKEN:%',
  'REV-56: blank token is rejected');
-- P2 không xóa được token của P1
SELECT public.unregister_push_token('ExponentPushToken[p1-only]');
SELECT public.unregister_push_token('ExponentPushToken[shared]');

RESET ROLE;
SELECT is(
  (SELECT count(*)::int FROM public.push_tokens WHERE user_id = 'f6000000-0000-4000-8000-000000000006')
  * 10 + (SELECT count(*)::int FROM public.push_tokens WHERE user_id = 'f5000000-0000-4000-8000-000000000005'),
  1,
  'REV-57: unregister removes only the caller''s own row');

SELECT * FROM finish();
ROLLBACK;
