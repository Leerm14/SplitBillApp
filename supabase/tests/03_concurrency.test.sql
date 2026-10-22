-- ============================================================
-- Khóa và thao tác lặp (pgTAP) — BE-02, BE-06, BE-08, PAY-04
--
-- GIỚI HẠN: pgTAP chạy MỘT phiên trong MỘT giao dịch (ROLLBACK ở cuối), nên không tạo
-- được hai giao dịch thật sự chạy song song. Dùng dblink để mở kết nối thứ hai cần dữ
-- liệu đã COMMIT (làm bẩn DB test) và chuỗi kết nối có mật khẩu → không ổn định trên
-- máy dev / CI. Vì vậy file này KHÔNG kiểm thử đồng thời thật, mà kiểm tra:
--   1. Tĩnh: các RPC lấy đúng khóa (định nghĩa hàm chứa FOR SHARE / FOR UPDATE và gọi
--      hàm kiểm tra chung). Đây là điều kiện để Postgres tuần tự hóa các giao dịch.
--   2. Tuần tự: kết quả của lần gọi thứ hai sau khi lần đầu đã ghi (xác nhận hai lần,
--      sửa cùng version hai lần, mã mời 1 lượt dùng hai lần, ...).
-- Kiểm thử đồng thời thật (hai kết nối) vẫn phải làm tay hoặc bằng script ngoài pgTAP.
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

-- Định nghĩa hàm (để kiểm tra khóa)
CREATE FUNCTION _t.def(_sig TEXT) RETURNS TEXT LANGUAGE sql AS $f$
  SELECT pg_get_functiondef(to_regprocedure(_sig));
$f$;

GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA _t TO anon, authenticated, service_role;

-- ============================================================
-- 1. Tĩnh: khóa (BE-08)
-- ============================================================

SELECT ok(_t.def('public.assert_active_member_of_active_group(uuid)') ~* 'from\s+public\.groups\s+where\s+id\s*=\s*_group_id\s+for\s+share',
  'LOCK-01: write helper locks the groups row FOR SHARE');

SELECT is(
  ARRAY(
    SELECT f FROM unnest(ARRAY[
      'public.leave_group(uuid)', 'public.remove_member(uuid,uuid)', 'public.close_group(uuid)',
      'public.anonymize_account(uuid)', 'public.update_group(uuid,text,text,boolean)',
      'public.rotate_invite_code(uuid)'
    ]) f
    WHERE _t.def(f) !~* 'for\s+update'
  ),
  ARRAY[]::text[],
  'LOCK-02: BR-11 checks (leave/remove/close/delete account) lock groups FOR UPDATE');

SELECT is(
  ARRAY(
    SELECT f FROM unnest(ARRAY[
      'public.create_expense(uuid,uuid,bigint,text,jsonb,text,text,text,text)',
      'public.update_expense(uuid,integer,uuid,bigint,text,text,text,jsonb,text)',
      'public.cancel_expense(uuid)',
      'public.create_payment(uuid,uuid,bigint,text,text)',
      'public.confirm_payment(uuid)', 'public.reject_payment(uuid,text)',
      'public.dispute_payment(uuid,text)', 'public.cancel_payment(uuid)',
      'public.create_invite(uuid,uuid,integer,integer)', 'public.revoke_invite(uuid)'
    ]) f
    WHERE _t.def(f) NOT LIKE '%public.assert_active_member_of_active_group(%'
  ),
  ARRAY[]::text[],
  'LOCK-03: every expense/payment write RPC goes through the FOR SHARE group lock');

SELECT is(
  ARRAY(
    SELECT f FROM unnest(ARRAY[
      'public.update_expense(uuid,integer,uuid,bigint,text,text,text,jsonb,text)',
      'public.cancel_expense(uuid)',
      'public.confirm_payment(uuid)', 'public.reject_payment(uuid,text)',
      'public.dispute_payment(uuid,text)', 'public.cancel_payment(uuid)',
      'public.accept_invite(text)'
    ]) f
    WHERE _t.def(f) !~* 'for\s+update'
  ),
  ARRAY[]::text[],
  'LOCK-04: row-level FOR UPDATE on the expense / payment / invite being changed (BE-02, BE-06, PAY-04)');

-- ============================================================
-- 2. Tuần tự
-- ============================================================
DO $$
BEGIN
  PERFORM _t.new_user('a0000000-0000-4000-8000-00000000000a', 'Alice');
  PERFORM _t.new_user('b0000000-0000-4000-8000-00000000000b', 'Bob');
  PERFORM _t.new_user('c0000000-0000-4000-8000-00000000000c', 'Mia');
  PERFORM _t.new_user('d0000000-0000-4000-8000-00000000000d', 'Dan');
END $$;

INSERT INTO public.groups (id, name, owner_id, invite_code)
VALUES ('10000000-0000-4000-8000-000000000001', 'Conc Group', 'a0000000-0000-4000-8000-00000000000a', 'CONCGRP1');
INSERT INTO public.group_members (group_id, user_id, role) VALUES
  ('10000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-00000000000a', 'owner'),
  ('10000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-00000000000b', 'member');
INSERT INTO public.group_invites (id, group_id, token, created_by, expires_at, max_uses)
VALUES ('50000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001',
        'ONEUSETOKEN1', 'a0000000-0000-4000-8000-00000000000a', now() + interval '1 day', 1);
INSERT INTO public.payments (id, group_id, from_id, to_id, amount, status, idempotency_key) VALUES
  ('30000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001',
   'b0000000-0000-4000-8000-00000000000b', 'a0000000-0000-4000-8000-00000000000a', 500, 'PENDING', 'conc-p1');

-- Hai lần xác nhận cùng một thanh toán
RESET ROLE;
SELECT _t.login('a0000000-0000-4000-8000-00000000000a');
SELECT lives_ok($q$SELECT public.confirm_payment('30000000-0000-4000-8000-000000000001')$q$,
  'SEQ-01: first confirm succeeds');
SELECT throws_like($q$SELECT public.confirm_payment('30000000-0000-4000-8000-000000000001')$q$, 'NOT_PENDING:%',
  'SEQ-02: second confirm is rejected — cannot count a payment twice');
SELECT throws_like($q$SELECT public.reject_payment('30000000-0000-4000-8000-000000000001', 'late')$q$, 'NOT_PENDING:%',
  'SEQ-03: reject after confirm is rejected');

-- Hai người sửa cùng version
SELECT lives_ok(
  $q$SELECT public.create_expense('10000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-00000000000a',
      2000, 'Coffee', '[{"userId":"a0000000-0000-4000-8000-00000000000a","amount":1000},
                        {"userId":"b0000000-0000-4000-8000-00000000000b","amount":1000}]'::jsonb, 'conc-e1')$q$,
  'SEQ-04: setup expense');
SELECT lives_ok(
  $q$SELECT public.update_expense((SELECT id FROM public.expenses WHERE idempotency_key = 'conc-e1'), 1,
      'a0000000-0000-4000-8000-00000000000a', 2000, 'Coffee (A)', 'EQUAL', '',
      '[{"userId":"a0000000-0000-4000-8000-00000000000a","amount":1000},
        {"userId":"b0000000-0000-4000-8000-00000000000b","amount":1000}]'::jsonb)$q$,
  'SEQ-05: first editor with version 1 wins');
SELECT throws_ok(
  $q$SELECT public.update_expense((SELECT id FROM public.expenses WHERE idempotency_key = 'conc-e1'), 1,
      'a0000000-0000-4000-8000-00000000000a', 4000, 'Coffee (B)', 'EQUAL', '',
      '[{"userId":"a0000000-0000-4000-8000-00000000000a","amount":2000},
        {"userId":"b0000000-0000-4000-8000-00000000000b","amount":2000}]'::jsonb)$q$,
  'PT409', NULL,
  'SEQ-06: second editor with the same version gets PT409, nothing overwritten');
SELECT is((SELECT amount FROM public.expenses WHERE idempotency_key = 'conc-e1'), 2000::bigint,
  'SEQ-07: first edit is kept');

-- Mã mời 1 lượt
RESET ROLE;
SELECT _t.login('c0000000-0000-4000-8000-00000000000c');
SELECT lives_ok($q$SELECT public.accept_invite('ONEUSETOKEN1')$q$, 'SEQ-08: first user uses the single-use invite');
SELECT lives_ok($q$SELECT public.accept_invite('ONEUSETOKEN1')$q$, 'SEQ-09: same user again is idempotent');

RESET ROLE;
SELECT _t.login('d0000000-0000-4000-8000-00000000000d');
SELECT throws_like($q$SELECT public.accept_invite('ONEUSETOKEN1')$q$, 'INVITE_EXHAUSTED:%',
  'SEQ-10: second user cannot reuse a single-use invite (BE-06)');

RESET ROLE;
SELECT is((SELECT used_count FROM public.group_invites WHERE token = 'ONEUSETOKEN1'), 1,
  'SEQ-11: used_count counted once');

-- BR-11 sau khi đã ghi: B có số dư ≠ 0 do khoản chi vừa sửa → không rời được
SELECT _t.login('b0000000-0000-4000-8000-00000000000b');
SELECT throws_like($q$SELECT public.leave_group('10000000-0000-4000-8000-000000000001')$q$, 'NONZERO_BALANCE:%',
  'SEQ-12: leave sees the committed expense (BR-11)');

RESET ROLE;
SELECT * FROM finish();
ROLLBACK;
