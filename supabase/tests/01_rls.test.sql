-- ============================================================
-- RLS & quyền (pgTAP) — TST-01
-- Đọc theo spec hiện tại (DEV 3.3): thành viên ACTIVE đọc hết; người đã rời (LEFT)
-- đọc lịch sử tới lúc rời (BE-12); REMOVED / người ngoài không đọc được.
-- Ghi: chỉ qua RPC. anon: không đọc, không gọi RPC.
--
-- Đổi user: _t.login(uuid) đặt request.jwt.claims + role authenticated (SET LOCAL),
-- luôn gọi sau RESET ROLE (đang là postgres). Không dùng PERFORM/EXECUTE ngoài hàm.
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

CREATE FUNCTION _t.login_anon() RETURNS VOID LANGUAGE plpgsql AS $f$
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claims', '{"role":"anon"}', true);
  PERFORM set_config('role', 'anon', true);
END $f$;

GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA _t TO anon, authenticated, service_role;

-- ------------------------------------------------------------
-- Fixtures
--   G1: A chủ nhóm; B, M ACTIVE; D LEFT (rời hôm qua); R REMOVED; X người ngoài
--   E1 (2 ngày trước) và E2 (hôm nay) do B tạo; P1 (2 ngày trước), P2 (hôm nay)
-- ------------------------------------------------------------
DO $$
BEGIN
  PERFORM _t.new_user('a0000000-0000-4000-8000-00000000000a', 'Alice');
  PERFORM _t.new_user('b0000000-0000-4000-8000-00000000000b', 'Bob');
  PERFORM _t.new_user('c0000000-0000-4000-8000-00000000000c', 'Mia');
  PERFORM _t.new_user('d0000000-0000-4000-8000-00000000000d', 'Dan');
  PERFORM _t.new_user('e0000000-0000-4000-8000-00000000000e', 'Rex');
  PERFORM _t.new_user('f0000000-0000-4000-8000-00000000000f', 'Xena');
END $$;

INSERT INTO public.groups (id, name, owner_id, invite_code)
VALUES ('10000000-0000-4000-8000-000000000001', 'RLS Group', 'a0000000-0000-4000-8000-00000000000a', 'RLSGRP01');

INSERT INTO public.group_members (group_id, user_id, role, status, left_at) VALUES
  ('10000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-00000000000a', 'owner',  'ACTIVE',  NULL),
  ('10000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-00000000000b', 'member', 'ACTIVE',  NULL),
  ('10000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-00000000000c', 'member', 'ACTIVE',  NULL),
  ('10000000-0000-4000-8000-000000000001', 'd0000000-0000-4000-8000-00000000000d', 'member', 'LEFT',    now() - interval '1 day'),
  ('10000000-0000-4000-8000-000000000001', 'e0000000-0000-4000-8000-00000000000e', 'member', 'REMOVED', now() - interval '1 day');

INSERT INTO public.expenses (id, group_id, paid_by, amount, description, created_by, idempotency_key, created_at) VALUES
  ('20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001',
   'b0000000-0000-4000-8000-00000000000b', 20000, 'Old', 'b0000000-0000-4000-8000-00000000000b', 'rls-e1',
   now() - interval '2 days'),
  ('20000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001',
   'b0000000-0000-4000-8000-00000000000b', 20000, 'New', 'b0000000-0000-4000-8000-00000000000b', 'rls-e2',
   now());

INSERT INTO public.expense_shares (expense_id, user_id, amount) VALUES
  ('20000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-00000000000b', 10000),
  ('20000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-00000000000c', 10000),
  ('20000000-0000-4000-8000-000000000002', 'b0000000-0000-4000-8000-00000000000b', 10000),
  ('20000000-0000-4000-8000-000000000002', 'c0000000-0000-4000-8000-00000000000c', 10000);

INSERT INTO public.payments (id, group_id, from_id, to_id, amount, status, idempotency_key, created_at) VALUES
  ('30000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001',
   'c0000000-0000-4000-8000-00000000000c', 'b0000000-0000-4000-8000-00000000000b', 10000, 'PENDING', 'rls-p1',
   now() - interval '2 days'),
  ('30000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001',
   'c0000000-0000-4000-8000-00000000000c', 'b0000000-0000-4000-8000-00000000000b', 5000, 'PENDING', 'rls-p2',
   now());

INSERT INTO public.activity_logs (id, group_id, actor_id, action, entity_type, created_at) VALUES
  ('40000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001',
   'b0000000-0000-4000-8000-00000000000b', 'EXPENSE_CREATED', 'EXPENSE', now() - interval '2 days'),
  ('40000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001',
   'b0000000-0000-4000-8000-00000000000b', 'EXPENSE_CREATED', 'EXPENSE', now());

INSERT INTO public.group_invites (id, group_id, token, created_by, expires_at)
VALUES ('50000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001',
        'RLSINVITE001', 'a0000000-0000-4000-8000-00000000000a', now() + interval '1 day');

INSERT INTO public.notifications (id, user_id, type, group_id) VALUES
  ('60000000-0000-4000-8000-00000000000a', 'a0000000-0000-4000-8000-00000000000a', 'EXPENSE_CREATED', '10000000-0000-4000-8000-000000000001'),
  ('60000000-0000-4000-8000-00000000000b', 'b0000000-0000-4000-8000-00000000000b', 'EXPENSE_CREATED', '10000000-0000-4000-8000-000000000001');

-- ============================================================
-- Người ngoài (X)
-- ============================================================
RESET ROLE;
SELECT _t.login('f0000000-0000-4000-8000-00000000000f');

SELECT is((SELECT count(*)::int FROM public.groups WHERE id = '10000000-0000-4000-8000-000000000001'), 0,
  'RLS-01: outsider cannot read the group');
SELECT is((SELECT count(*)::int FROM public.group_members WHERE group_id = '10000000-0000-4000-8000-000000000001'), 0,
  'RLS-02: outsider cannot read group_members');
SELECT is((SELECT count(*)::int FROM public.expenses WHERE group_id = '10000000-0000-4000-8000-000000000001'), 0,
  'RLS-03: outsider cannot read expenses');
SELECT is((SELECT count(*)::int FROM public.expense_shares), 0,
  'RLS-04: outsider cannot read expense_shares');
SELECT is((SELECT count(*)::int FROM public.payments WHERE group_id = '10000000-0000-4000-8000-000000000001'), 0,
  'RLS-05: outsider cannot read payments');
SELECT is((SELECT count(*)::int FROM public.activity_logs WHERE group_id = '10000000-0000-4000-8000-000000000001'), 0,
  'RLS-06: outsider cannot read activity_logs');
SELECT is((SELECT count(*)::int FROM public.group_invites WHERE group_id = '10000000-0000-4000-8000-000000000001'), 0,
  'RLS-07: outsider cannot read group_invites');
SELECT is((SELECT count(*)::int FROM public.group_balances WHERE group_id = '10000000-0000-4000-8000-000000000001'), 0,
  'RLS-08: outsider cannot read group_balances');
SELECT is((SELECT count(*)::int FROM public.profiles WHERE id = 'a0000000-0000-4000-8000-00000000000a'), 0,
  'RLS-09: outsider cannot read an unrelated profile');

-- ============================================================
-- Thành viên ACTIVE (B)
-- ============================================================
RESET ROLE;
SELECT _t.login('b0000000-0000-4000-8000-00000000000b');

SELECT is((SELECT count(*)::int FROM public.groups WHERE id = '10000000-0000-4000-8000-000000000001'), 1,
  'RLS-10: member reads the group');
SELECT is((SELECT count(*)::int FROM public.expenses WHERE group_id = '10000000-0000-4000-8000-000000000001'), 2,
  'RLS-11: member reads all expenses');
SELECT is((SELECT count(*)::int FROM public.payments WHERE group_id = '10000000-0000-4000-8000-000000000001'), 2,
  'RLS-12: member reads all payments');
SELECT is((SELECT count(*)::int FROM public.group_invites WHERE group_id = '10000000-0000-4000-8000-000000000001'), 1,
  'RLS-13: member reads group invites');
SELECT is((SELECT count(*)::int FROM public.group_balances WHERE group_id = '10000000-0000-4000-8000-000000000001'), 3,
  'RLS-14: member reads group_balances (ACTIVE members)');
SELECT is((SELECT count(*)::int FROM public.notifications WHERE user_id = 'a0000000-0000-4000-8000-00000000000a'), 0,
  'RLS-15: member cannot read other users notifications');
SELECT is((SELECT count(*)::int FROM public.notifications), 1,
  'RLS-16: member reads own notifications');

-- Hồ sơ: người chung nhóm thấy cột công khai; cột riêng bị chặn bằng quyền cột
SELECT is((SELECT display_name FROM public.profiles WHERE id = 'a0000000-0000-4000-8000-00000000000a'), 'Alice',
  'RLS-17: co-member reads display_name');
SELECT is((SELECT count(*)::int FROM public.profiles WHERE id = 'd0000000-0000-4000-8000-00000000000d'), 1,
  'RLS-18: co-member reads profile of a member who left (history names)');
SELECT throws_ok(
  $q$SELECT searchable FROM public.profiles WHERE id = 'a0000000-0000-4000-8000-00000000000a'$q$,
  '42501', NULL,
  'RLS-19: other user searchable column is not readable (SEC-04)');
SELECT throws_ok(
  $q$SELECT deleted_at FROM public.profiles WHERE id = 'b0000000-0000-4000-8000-00000000000b'$q$,
  '42501', NULL,
  'RLS-20: private columns are not readable through the table even for self (use get_my_profile)');

-- Ghi thẳng vào bảng bị chặn (SEC-01, SEC-05)
SELECT throws_ok(
  $q$INSERT INTO public.payments (group_id, from_id, to_id, amount, status, idempotency_key)
     VALUES ('10000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-00000000000b',
             'a0000000-0000-4000-8000-00000000000a', 99999, 'CONFIRMED', 'rls-direct-confirmed')$q$,
  '42501', NULL,
  'RLS-21: member cannot INSERT a CONFIRMED payment directly (SEC-01)');
SELECT throws_ok(
  $q$UPDATE public.payments SET status = 'CONFIRMED' WHERE id = '30000000-0000-4000-8000-000000000001'$q$,
  '42501', NULL,
  'RLS-22: member cannot UPDATE payments directly');
SELECT throws_ok(
  $q$INSERT INTO public.expenses (group_id, paid_by, amount, created_by, idempotency_key)
     VALUES ('10000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-00000000000b', 1,
             'b0000000-0000-4000-8000-00000000000b', 'rls-direct-expense')$q$,
  '42501', NULL,
  'RLS-23: member cannot INSERT expenses directly');
SELECT throws_ok(
  $q$UPDATE public.profiles SET user_code = 'HACKED01' WHERE id = 'b0000000-0000-4000-8000-00000000000b'$q$,
  '42501', NULL,
  'RLS-24: user cannot UPDATE own profile columns directly (SEC-05)');
SELECT throws_ok(
  $q$DELETE FROM public.group_members WHERE group_id = '10000000-0000-4000-8000-000000000001'$q$,
  '42501', NULL,
  'RLS-25: member cannot DELETE group_members');
SELECT lives_ok(
  $q$UPDATE public.notifications SET read_at = now() WHERE id = '60000000-0000-4000-8000-00000000000b'$q$,
  'RLS-26: user marks own notification as read');
SELECT throws_ok(
  $q$UPDATE public.notifications SET user_id = 'a0000000-0000-4000-8000-00000000000a'
     WHERE id = '60000000-0000-4000-8000-00000000000b'$q$,
  '42501', NULL,
  'RLS-27: user cannot re-assign a notification');

-- Hàm nội bộ không gọi được như RPC (SEC-02)
SELECT throws_ok(
  $q$SELECT public.assert_active_member_of_active_group('10000000-0000-4000-8000-000000000001')$q$,
  '42501', NULL,
  'RLS-28: assert_active_member_of_active_group is not callable');
SELECT throws_ok(
  $q$SELECT public.anonymize_account('a0000000-0000-4000-8000-00000000000a')$q$,
  '42501', NULL,
  'RLS-29: authenticated cannot call anonymize_account');

-- ============================================================
-- Người đã rời (D, LEFT hôm qua) — BE-12
-- ============================================================
RESET ROLE;
SELECT _t.login('d0000000-0000-4000-8000-00000000000d');

SELECT is((SELECT count(*)::int FROM public.groups WHERE id = '10000000-0000-4000-8000-000000000001'), 1,
  'RLS-30: LEFT member still reads the group row');
SELECT is(
  ARRAY(SELECT description FROM public.expenses WHERE group_id = '10000000-0000-4000-8000-000000000001' ORDER BY 1),
  ARRAY['Old'],
  'RLS-31: LEFT member reads only expenses created before left_at');
SELECT is((SELECT count(*)::int FROM public.expense_shares), 2,
  'RLS-32: LEFT member reads only shares of visible expenses');
SELECT is(
  ARRAY(SELECT id FROM public.payments WHERE group_id = '10000000-0000-4000-8000-000000000001'),
  ARRAY['30000000-0000-4000-8000-000000000001'::uuid],
  'RLS-33: LEFT member reads only payments created before left_at');
SELECT is(
  ARRAY(SELECT id FROM public.activity_logs WHERE group_id = '10000000-0000-4000-8000-000000000001'),
  ARRAY['40000000-0000-4000-8000-000000000001'::uuid],
  'RLS-34: LEFT member reads only activity before left_at');
SELECT is((SELECT count(*)::int FROM public.group_invites), 0,
  'RLS-35: LEFT member cannot read current invites');

-- ============================================================
-- Người bị xóa (R, REMOVED)
-- ============================================================
RESET ROLE;
SELECT _t.login('e0000000-0000-4000-8000-00000000000e');

SELECT is((SELECT count(*)::int FROM public.groups WHERE id = '10000000-0000-4000-8000-000000000001'), 0,
  'RLS-36: REMOVED member cannot read the group');
SELECT is((SELECT count(*)::int FROM public.expenses), 0,
  'RLS-37: REMOVED member cannot read expenses');

-- ============================================================
-- Storage receipts (BE-12, SEC-09)
-- Quy tắc: xem chú thích PART 9 trong 0010_backend_fixes.sql
-- ============================================================
RESET ROLE;
SELECT _t.login('b0000000-0000-4000-8000-00000000000b'); -- B tạo E1
SELECT ok(public.can_write_receipt('10000000-0000-4000-8000-000000000001/20000000-0000-4000-8000-000000000001/r.jpg', NULL, true),
  'STO-01: expense creator may upload its receipt');
SELECT ok(public.can_write_receipt('10000000-0000-4000-8000-000000000001/20000000-0000-4000-8000-000000000001/r.jpg', 'c0000000-0000-4000-8000-00000000000c', false),
  'STO-02: expense creator may overwrite/delete its receipt');

RESET ROLE;
SELECT _t.login('c0000000-0000-4000-8000-00000000000c'); -- M: ACTIVE, không tạo E1
SELECT ok(NOT public.can_write_receipt('10000000-0000-4000-8000-000000000001/20000000-0000-4000-8000-000000000001/r.jpg', NULL, true),
  'STO-03: other member cannot upload into another member expense');
SELECT ok(NOT public.can_write_receipt('10000000-0000-4000-8000-000000000001/20000000-0000-4000-8000-000000000001/r.jpg', 'b0000000-0000-4000-8000-00000000000b', false),
  'STO-04: other member cannot overwrite/delete another member receipt (SEC-09)');
SELECT ok(public.can_write_receipt('10000000-0000-4000-8000-000000000001/70000000-0000-4000-8000-000000000001/r.jpg', NULL, true),
  'STO-05: active member may upload before the expense exists');
SELECT ok(public.can_write_receipt('10000000-0000-4000-8000-000000000001/70000000-0000-4000-8000-000000000001/r.jpg', 'c0000000-0000-4000-8000-00000000000c', false),
  'STO-06: uploader may replace an unattached receipt');
SELECT ok(NOT public.can_write_receipt('10000000-0000-4000-8000-000000000001/70000000-0000-4000-8000-000000000001/r.jpg', 'b0000000-0000-4000-8000-00000000000b', false),
  'STO-07: nobody else (non-owner) may replace an unattached receipt');
SELECT ok(public.can_read_receipt('10000000-0000-4000-8000-000000000001/20000000-0000-4000-8000-000000000002/r.jpg'),
  'STO-08: active member reads receipts');
SELECT ok(NOT public.can_read_receipt('not-a-uuid/also-not/r.jpg'),
  'STO-09: malformed path is denied without error');
SELECT throws_ok(
  $q$INSERT INTO storage.objects (bucket_id, name, owner)
     VALUES ('receipts', '10000000-0000-4000-8000-000000000001/20000000-0000-4000-8000-000000000001/m.jpg',
             'c0000000-0000-4000-8000-00000000000c')$q$,
  '42501', NULL,
  'STO-10: storage policy rejects upload by a non-creator');

RESET ROLE;
SELECT _t.login('a0000000-0000-4000-8000-00000000000a'); -- chủ nhóm
SELECT ok(public.can_write_receipt('10000000-0000-4000-8000-000000000001/20000000-0000-4000-8000-000000000001/r.jpg', 'b0000000-0000-4000-8000-00000000000b', false),
  'STO-11: group owner may manage any receipt');

RESET ROLE;
SELECT _t.login('d0000000-0000-4000-8000-00000000000d'); -- LEFT
SELECT ok(public.can_read_receipt('10000000-0000-4000-8000-000000000001/20000000-0000-4000-8000-000000000001/r.jpg'),
  'STO-12: LEFT member reads receipts of expenses before left_at (BE-12)');
SELECT ok(NOT public.can_read_receipt('10000000-0000-4000-8000-000000000001/20000000-0000-4000-8000-000000000002/r.jpg'),
  'STO-13: LEFT member cannot read receipts of later expenses');
SELECT ok(NOT public.can_write_receipt('10000000-0000-4000-8000-000000000001/70000000-0000-4000-8000-000000000002/r.jpg', NULL, true),
  'STO-14: LEFT member cannot upload');

RESET ROLE;
SELECT _t.login('f0000000-0000-4000-8000-00000000000f'); -- người ngoài
SELECT ok(NOT public.can_read_receipt('10000000-0000-4000-8000-000000000001/20000000-0000-4000-8000-000000000001/r.jpg'),
  'STO-15: outsider cannot read receipts');

-- ============================================================
-- anon (SEC-02)
-- ============================================================
RESET ROLE;
SELECT _t.login_anon();

SELECT throws_ok($q$SELECT count(*) FROM public.groups$q$, '42501', NULL,
  'ANON-01: anon cannot read groups');
SELECT throws_ok($q$SELECT count(*) FROM public.profiles$q$, '42501', NULL,
  'ANON-02: anon cannot read profiles');
SELECT throws_ok($q$SELECT count(*) FROM public.group_balances$q$, '42501', NULL,
  'ANON-03: anon cannot read group_balances');
SELECT throws_ok($q$SELECT public.create_group('anon group')$q$, '42501', NULL,
  'ANON-04: anon cannot call create_group');
SELECT throws_ok($q$SELECT public.confirm_payment('30000000-0000-4000-8000-000000000001')$q$, '42501', NULL,
  'ANON-05: anon cannot call confirm_payment');
SELECT throws_ok($q$SELECT public.respond_payment('30000000-0000-4000-8000-000000000001', true)$q$, '42501', NULL,
  'ANON-06: anon cannot call respond_payment');
SELECT throws_ok($q$SELECT public.revoke_invite('50000000-0000-4000-8000-000000000001')$q$, '42501', NULL,
  'ANON-07: anon cannot call revoke_invite');
SELECT throws_ok($q$SELECT public.is_member('10000000-0000-4000-8000-000000000001')$q$, '42501', NULL,
  'ANON-08: anon cannot call helper functions');

RESET ROLE;
SELECT * FROM finish();
ROLLBACK;
