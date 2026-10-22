-- ============================================================
-- RPC (pgTAP) — TST-02, theo spec hiện tại (DEV 3.4, BA)
--   - idempotency trả đúng bản ghi cũ, phạm vi theo người tạo (BE-09, NEW-06)
--   - xung đột version: SQLSTATE PT409 + 'VERSION_CONFLICT:' (APP-05)
--   - dispute chỉ khi PENDING; người gửi được hủy khoản DISPUTED (BE-11)
--   - nhóm CLOSED từ chối mọi thao tác ghi
--   - BR-11: rời nhóm / xóa thành viên / đóng nhóm bị chặn khi số dư ≠ 0 hoặc còn PENDING
--   - update_group NULL = giữ nguyên (NEW-08), update_profile (NEW-02), BE-07, BE-05
-- Lỗi nghiệp vụ: RAISE EXCEPTION không ERRCODE → SQLSTATE P0001; kiểm tra tiền tố 'CODE:'.
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

CREATE FUNCTION _t.login_service() RETURNS VOID LANGUAGE plpgsql AS $f$
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);
  PERFORM set_config('role', 'service_role', true);
END $f$;

GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA _t TO anon, authenticated, service_role;

-- Giá trị cần mang giữa các bước (token lời mời, ...)
CREATE TABLE _t.vars (k TEXT PRIMARY KEY, v TEXT);
GRANT SELECT ON _t.vars TO authenticated, service_role;

-- ------------------------------------------------------------
-- Fixtures
--   G1 ACTIVE: A chủ; B, M ACTIVE; R REMOVED. Số dư ban đầu = 0.
--   G2 CLOSED: A chủ; B ACTIVE; khoản chi EC.
--   X người ngoài; U người không có lịch sử (xóa tài khoản); V bị xóa thẳng khỏi auth.users.
-- ------------------------------------------------------------
DO $$
BEGIN
  PERFORM _t.new_user('a0000000-0000-4000-8000-00000000000a', 'Alice');
  PERFORM _t.new_user('b0000000-0000-4000-8000-00000000000b', 'Bob');
  PERFORM _t.new_user('c0000000-0000-4000-8000-00000000000c', 'Mia');
  PERFORM _t.new_user('e0000000-0000-4000-8000-00000000000e', 'Rex');
  PERFORM _t.new_user('f0000000-0000-4000-8000-00000000000f', 'Xena');
  PERFORM _t.new_user('90000000-0000-4000-8000-000000000009', 'Uma');
  PERFORM _t.new_user('80000000-0000-4000-8000-000000000008', 'Vic');
END $$;

INSERT INTO public.groups (id, name, description, owner_id, invite_code, status) VALUES
  ('10000000-0000-4000-8000-000000000001', 'Group One', 'desc', 'a0000000-0000-4000-8000-00000000000a', 'GONECODE', 'ACTIVE'),
  ('10000000-0000-4000-8000-000000000002', 'Closed Group', '', 'a0000000-0000-4000-8000-00000000000a', 'GTWOCODE', 'CLOSED');

INSERT INTO public.group_members (group_id, user_id, role, status, left_at) VALUES
  ('10000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-00000000000a', 'owner',  'ACTIVE',  NULL),
  ('10000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-00000000000b', 'member', 'ACTIVE',  NULL),
  ('10000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-00000000000c', 'member', 'ACTIVE',  NULL),
  ('10000000-0000-4000-8000-000000000001', 'e0000000-0000-4000-8000-00000000000e', 'member', 'REMOVED', now() - interval '1 day'),
  ('10000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-00000000000a', 'owner',  'ACTIVE',  NULL),
  ('10000000-0000-4000-8000-000000000002', 'b0000000-0000-4000-8000-00000000000b', 'member', 'ACTIVE',  NULL);

INSERT INTO public.expenses (id, group_id, paid_by, amount, description, created_by, idempotency_key) VALUES
  ('20000000-0000-4000-8000-0000000000c1', '10000000-0000-4000-8000-000000000002',
   'b0000000-0000-4000-8000-00000000000b', 10000, 'Closed expense', 'b0000000-0000-4000-8000-00000000000b', 'closed-1');
INSERT INTO public.expense_shares (expense_id, user_id, amount) VALUES
  ('20000000-0000-4000-8000-0000000000c1', 'a0000000-0000-4000-8000-00000000000a', 5000),
  ('20000000-0000-4000-8000-0000000000c1', 'b0000000-0000-4000-8000-00000000000b', 5000);

INSERT INTO public.group_invites (id, group_id, token, created_by, expires_at, max_uses)
VALUES ('50000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001',
        'OPENTOKEN001', 'a0000000-0000-4000-8000-00000000000a', now() + interval '1 day', 5);

-- U: không có lịch sử nhóm, có token push, bạn bè, phương thức thanh toán
INSERT INTO public.push_tokens (user_id, expo_token) VALUES ('90000000-0000-4000-8000-000000000009', 'ExponentPushToken[uma]');
INSERT INTO public.friendships (requester_id, addressee_id, status)
VALUES ('90000000-0000-4000-8000-000000000009', 'f0000000-0000-4000-8000-00000000000f', 'ACCEPTED');
INSERT INTO public.payment_handles (user_id, type, display_text)
VALUES ('90000000-0000-4000-8000-000000000009', 'BANK', 'VCB ***1234');

-- ============================================================
-- KHOẢN CHI
-- ============================================================
RESET ROLE;
SELECT _t.login('b0000000-0000-4000-8000-00000000000b');

SELECT lives_ok(
  $q$SELECT public.create_expense('10000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-00000000000b',
      30000, 'Dinner',
      '[{"userId":"a0000000-0000-4000-8000-00000000000a","amount":10000},
        {"userId":"b0000000-0000-4000-8000-00000000000b","amount":10000},
        {"userId":"c0000000-0000-4000-8000-00000000000c","amount":10000}]'::jsonb,
      'exp-key-1')$q$,
  'EXP-01: member creates an expense (6 positional args resolve to the 9-arg RPC)');

SELECT is(
  (public.create_expense('10000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-00000000000b',
      30000, 'Dinner',
      '[{"userId":"a0000000-0000-4000-8000-00000000000a","amount":10000},
        {"userId":"b0000000-0000-4000-8000-00000000000b","amount":10000},
        {"userId":"c0000000-0000-4000-8000-00000000000c","amount":10000}]'::jsonb,
      'exp-key-1')).id,
  (SELECT id FROM public.expenses WHERE created_by = 'b0000000-0000-4000-8000-00000000000b' AND idempotency_key = 'exp-key-1'),
  'EXP-02: same idempotency key returns the same expense');

SELECT is((SELECT count(*)::int FROM public.expenses WHERE idempotency_key = 'exp-key-1'), 1,
  'EXP-03: retry did not create a duplicate');

SELECT throws_like(
  $q$SELECT public.create_expense('10000000-0000-4000-8000-000000000002', 'b0000000-0000-4000-8000-00000000000b',
      30000, 'Other group', '[{"userId":"b0000000-0000-4000-8000-00000000000b","amount":30000}]'::jsonb, 'exp-key-1')$q$,
  'IDEMPOTENCY_KEY_REUSED:%',
  'EXP-04: reusing a key for another group is rejected, not silently returned');

SELECT throws_like(
  $q$SELECT public.create_expense('10000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-00000000000b',
      30000, 'Bad', '[{"userId":"b0000000-0000-4000-8000-00000000000b","amount":20000}]'::jsonb, 'exp-key-bad')$q$,
  'SHARE_MISMATCH:%',
  'EXP-05: shares must add up to the amount');

SELECT throws_like(
  $q$SELECT public.create_expense('10000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-00000000000b',
      20000, 'Removed share',
      '[{"userId":"b0000000-0000-4000-8000-00000000000b","amount":10000},
        {"userId":"e0000000-0000-4000-8000-00000000000e","amount":10000}]'::jsonb, 'exp-key-rm')$q$,
  'SHARE_USER_NOT_MEMBER:%',
  'EXP-06: REMOVED member cannot be in shares');

SELECT throws_like(
  $q$SELECT public.create_expense('10000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-00000000000b',
      20000, 'Dup',
      '[{"userId":"b0000000-0000-4000-8000-00000000000b","amount":10000},
        {"userId":"b0000000-0000-4000-8000-00000000000b","amount":10000}]'::jsonb, 'exp-key-dup')$q$,
  'DUPLICATE_SHARE_USER:%',
  'EXP-07: duplicate share user is rejected with a business code');

SELECT throws_like(
  $q$SELECT public.create_expense('10000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-00000000000b',
      10000, 'Receipt', '[{"userId":"b0000000-0000-4000-8000-00000000000b","amount":10000}]'::jsonb, 'exp-key-rcpt',
      'EQUAL', '', 'some-other-group/x/r.jpg')$q$,
  'INVALID_RECEIPT_PATH:%',
  'EXP-08: receipt path must be inside the group folder (SEC-09)');

RESET ROLE;
SELECT _t.login('a0000000-0000-4000-8000-00000000000a');

SELECT lives_ok(
  $q$SELECT public.create_expense('10000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-00000000000a',
      20000, 'Taxi',
      '[{"userId":"a0000000-0000-4000-8000-00000000000a","amount":10000},
        {"userId":"b0000000-0000-4000-8000-00000000000b","amount":10000}]'::jsonb,
      'exp-key-1')$q$,
  'EXP-09: another user may use the same idempotency key (BE-09 scope)');

SELECT is((SELECT count(*)::int FROM public.expenses WHERE idempotency_key = 'exp-key-1'), 2,
  'EXP-10: two distinct expenses exist for the shared key');

RESET ROLE;
SELECT _t.login('f0000000-0000-4000-8000-00000000000f');
SELECT throws_like(
  $q$SELECT public.create_expense('10000000-0000-4000-8000-000000000001', 'f0000000-0000-4000-8000-00000000000f',
      10000, 'Outsider', '[{"userId":"f0000000-0000-4000-8000-00000000000f","amount":10000}]'::jsonb, 'x-key')$q$,
  'NOT_MEMBER:%',
  'EXP-11: outsider cannot create an expense');

-- ---------------- update_expense ----------------
RESET ROLE;
SELECT _t.login('c0000000-0000-4000-8000-00000000000c');
SELECT throws_like(
  $q$SELECT public.update_expense(
      (SELECT id FROM public.expenses WHERE description = 'Dinner'), 1,
      'b0000000-0000-4000-8000-00000000000b', 30000, 'Hijack', 'EQUAL', '',
      '[{"userId":"c0000000-0000-4000-8000-00000000000c","amount":30000}]'::jsonb)$q$,
  'NOT_AUTHORIZED:%',
  'UPD-01: only creator or owner can edit');

RESET ROLE;
SELECT _t.login('b0000000-0000-4000-8000-00000000000b');
SELECT throws_ok(
  $q$SELECT public.update_expense(
      (SELECT id FROM public.expenses WHERE description = 'Dinner'), 99,
      'b0000000-0000-4000-8000-00000000000b', 30000, 'Dinner v2', 'EQUAL', '',
      '[{"userId":"a0000000-0000-4000-8000-00000000000a","amount":10000},
        {"userId":"b0000000-0000-4000-8000-00000000000b","amount":10000},
        {"userId":"c0000000-0000-4000-8000-00000000000c","amount":10000}]'::jsonb)$q$,
  'PT409', NULL,
  'UPD-02: stale version raises SQLSTATE PT409 (APP-05)');
SELECT throws_like(
  $q$SELECT public.update_expense(
      (SELECT id FROM public.expenses WHERE description = 'Dinner'), 99,
      'b0000000-0000-4000-8000-00000000000b', 30000, 'Dinner v2', 'EQUAL', '',
      '[{"userId":"b0000000-0000-4000-8000-00000000000b","amount":30000}]'::jsonb)$q$,
  'VERSION_CONFLICT:%',
  'UPD-03: stale version message keeps the VERSION_CONFLICT prefix');
SELECT is(
  (public.update_expense(
      (SELECT id FROM public.expenses WHERE description = 'Dinner'), 1,
      'b0000000-0000-4000-8000-00000000000b', 30000, 'Dinner v2', 'EQUAL', 'note',
      '[{"userId":"a0000000-0000-4000-8000-00000000000a","amount":10000},
        {"userId":"b0000000-0000-4000-8000-00000000000b","amount":10000},
        {"userId":"c0000000-0000-4000-8000-00000000000c","amount":10000}]'::jsonb)).version,
  2,
  'UPD-04: update with the current version bumps it');
SELECT throws_ok(
  $q$SELECT public.update_expense(
      (SELECT id FROM public.expenses WHERE description = 'Dinner v2'), 1,
      'b0000000-0000-4000-8000-00000000000b', 30000, 'Dinner v3', 'EQUAL', '',
      '[{"userId":"b0000000-0000-4000-8000-00000000000b","amount":30000}]'::jsonb)$q$,
  'PT409', NULL,
  'UPD-05: second edit with the old version conflicts');

-- ---------------- cancel_expense ----------------
SELECT lives_ok(
  $q$SELECT public.create_expense('10000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-00000000000b',
      4000, 'Snack', '[{"userId":"b0000000-0000-4000-8000-00000000000b","amount":2000},
                       {"userId":"c0000000-0000-4000-8000-00000000000c","amount":2000}]'::jsonb, 'exp-key-snack')$q$,
  'CAN-00: setup expense to cancel');

RESET ROLE;
SELECT _t.login('c0000000-0000-4000-8000-00000000000c');
SELECT throws_like(
  $q$SELECT public.cancel_expense((SELECT id FROM public.expenses WHERE description = 'Snack'))$q$,
  'NOT_AUTHORIZED:%',
  'CAN-01: non-creator cannot cancel');

RESET ROLE;
SELECT _t.login('b0000000-0000-4000-8000-00000000000b');
SELECT is((public.cancel_expense((SELECT id FROM public.expenses WHERE description = 'Snack'))).status, 'CANCELLED',
  'CAN-02: creator cancels');
SELECT is((public.cancel_expense((SELECT id FROM public.expenses WHERE description = 'Snack'))).status, 'CANCELLED',
  'CAN-03: cancelling twice is a no-op (EXP-07)');
SELECT is(
  (SELECT count(*)::int FROM public.activity_logs
   WHERE action = 'EXPENSE_CANCELLED' AND entity_id = (SELECT id FROM public.expenses WHERE description = 'Snack')),
  1,
  'CAN-04: only one cancel is logged');

-- ============================================================
-- THANH TOÁN
-- ============================================================
RESET ROLE;
SELECT _t.login('c0000000-0000-4000-8000-00000000000c');

SELECT is(
  public.create_payment('10000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-00000000000b',
                        10000, 'tra Bob', 'pay-key-1') ->> 'status',
  'PENDING',
  'PAY-01: create_payment always creates PENDING');
SELECT is(
  (public.create_payment('10000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-00000000000b',
                         10000, 'tra Bob', 'pay-key-1') ->> 'id')::uuid,
  (SELECT id FROM public.payments WHERE from_id = 'c0000000-0000-4000-8000-00000000000c' AND idempotency_key = 'pay-key-1'),
  'PAY-02: same key returns the same payment');
SELECT is((SELECT count(*)::int FROM public.payments WHERE idempotency_key = 'pay-key-1'), 1,
  'PAY-03: retry did not duplicate');
SELECT throws_like(
  $q$SELECT public.create_payment('10000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-00000000000b',
                                  12345, NULL, 'pay-key-1')$q$,
  'IDEMPOTENCY_KEY_REUSED:%',
  'PAY-04: same key with a different amount is rejected');
SELECT throws_like(
  $q$SELECT public.create_payment('10000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-00000000000c', 1000, NULL, 'self')$q$,
  'SELF_PAYMENT:%',
  'PAY-05: cannot pay yourself');
SELECT throws_like(
  $q$SELECT public.create_payment('10000000-0000-4000-8000-000000000001', 'e0000000-0000-4000-8000-00000000000e', 1000, NULL, 'to-removed')$q$,
  'RECEIVER_NOT_MEMBER:%',
  'PAY-06: cannot pay a removed member');
SELECT isnt(
  public.create_payment('10000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-00000000000a', 1000, 'no key', NULL) ->> 'id',
  NULL,
  'PAY-07: missing idempotency key does not violate NOT NULL');

RESET ROLE;
SELECT _t.login('a0000000-0000-4000-8000-00000000000a');
SELECT isnt(
  public.create_payment('10000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-00000000000b', 5000, NULL, 'pay-key-1') ->> 'id',
  NULL,
  'PAY-08: another sender may use the same key — a real row, not nulls (NEW-06)');
SELECT is((SELECT count(*)::int FROM public.payments WHERE idempotency_key = 'pay-key-1'), 2,
  'PAY-09: two payments share the key across senders');

-- confirm / dispute / cancel
RESET ROLE;
SELECT _t.login('c0000000-0000-4000-8000-00000000000c');
SELECT throws_like(
  $q$SELECT public.confirm_payment((SELECT id FROM public.payments WHERE from_id = 'c0000000-0000-4000-8000-00000000000c' AND idempotency_key = 'pay-key-1'))$q$,
  'NOT_RECEIVER:%',
  'PAY-10: sender cannot confirm own payment');

RESET ROLE;
SELECT _t.login('b0000000-0000-4000-8000-00000000000b');
SELECT is(
  (public.confirm_payment((SELECT id FROM public.payments WHERE from_id = 'c0000000-0000-4000-8000-00000000000c' AND idempotency_key = 'pay-key-1'))).status,
  'CONFIRMED',
  'PAY-11: receiver confirms');
SELECT throws_like(
  $q$SELECT public.confirm_payment((SELECT id FROM public.payments WHERE from_id = 'c0000000-0000-4000-8000-00000000000c' AND idempotency_key = 'pay-key-1'))$q$,
  'NOT_PENDING:%',
  'PAY-12: cannot confirm twice (PAY-04)');
SELECT throws_like(
  $q$SELECT public.dispute_payment((SELECT id FROM public.payments WHERE from_id = 'c0000000-0000-4000-8000-00000000000c' AND idempotency_key = 'pay-key-1'), 'sai')$q$,
  'NOT_PENDING:%',
  'PAY-13: a CONFIRMED payment cannot be disputed (BE-11)');
SELECT is(
  (public.dispute_payment((SELECT id FROM public.payments WHERE from_id = 'a0000000-0000-4000-8000-00000000000a' AND idempotency_key = 'pay-key-1'), 'chua nhan')).status,
  'DISPUTED',
  'PAY-14: receiver disputes a PENDING payment');

RESET ROLE;
SELECT _t.login('a0000000-0000-4000-8000-00000000000a');
SELECT is(
  (public.cancel_payment((SELECT id FROM public.payments WHERE from_id = 'a0000000-0000-4000-8000-00000000000a' AND idempotency_key = 'pay-key-1'))).status,
  'CANCELLED',
  'PAY-15: sender cancels a DISPUTED payment');

-- ============================================================
-- NHÓM: update_group (NEW-08)
-- ============================================================
SELECT is(
  (SELECT row(g.name, g.description, g.simplify_debts)::text
   FROM public.update_group('10000000-0000-4000-8000-000000000001', NULL, NULL, false) g),
  row('Group One', 'desc', false)::text,
  'GRP-01: NULL name/description keep current values');
SELECT throws_like(
  $q$SELECT public.update_group('10000000-0000-4000-8000-000000000001', '   ', NULL, NULL)$q$,
  'INVALID_NAME:%',
  'GRP-02: blank name is rejected');

RESET ROLE;
SELECT _t.login('b0000000-0000-4000-8000-00000000000b');
SELECT throws_like(
  $q$SELECT public.update_group('10000000-0000-4000-8000-000000000001', 'Mine', NULL, NULL)$q$,
  'NOT_OWNER:%',
  'GRP-03: only owner updates the group');

-- ============================================================
-- HỒ SƠ: update_profile (contract #1, NEW-02, SEC-05)
-- ============================================================
SELECT is((public.update_profile(_display_name => '  Bob Two  ')).display_name, 'Bob Two',
  'PRO-01: display_name is trimmed');
SELECT throws_like(
  $q$SELECT public.update_profile(_avatar_path => 'a0000000-0000-4000-8000-00000000000a/avatar.jpg')$q$,
  'INVALID_AVATAR_PATH:%',
  'PRO-02: avatar must be under the caller folder');
SELECT is((public.update_profile(_avatar_path => 'b0000000-0000-4000-8000-00000000000b/avatar.jpg')).avatar_path,
  'b0000000-0000-4000-8000-00000000000b/avatar.jpg',
  'PRO-03: own avatar path is saved');
SELECT is((public.update_profile(_clear_avatar => true)).avatar_path, NULL,
  'PRO-04: _clear_avatar removes the avatar');
SELECT throws_like(
  $q$SELECT public.update_profile(_display_name => '   ')$q$,
  'INVALID_DISPLAY_NAME:%',
  'PRO-05: blank display name is rejected');
SELECT is(
  (SELECT row(p.display_name, p.searchable)::text FROM public.update_profile(_searchable => false) p),
  row('Bob Two', false)::text,
  'PRO-06: NULL arguments keep current values');

-- ============================================================
-- LỜI MỜI (BE-03, BE-07)
-- ============================================================
RESET ROLE;
SELECT _t.login('e0000000-0000-4000-8000-00000000000e'); -- R (REMOVED)
SELECT throws_like($q$SELECT public.join_group('GONECODE')$q$, 'MEMBER_REMOVED:%',
  'INV-01: removed member cannot rejoin with the group code');
SELECT throws_like($q$SELECT public.accept_invite('OPENTOKEN001')$q$, 'MEMBER_REMOVED:%',
  'INV-02: removed member cannot rejoin with an open invite');

RESET ROLE;
SELECT _t.login('b0000000-0000-4000-8000-00000000000b');
SELECT throws_like(
  $q$SELECT public.create_invite('10000000-0000-4000-8000-000000000001', 'e0000000-0000-4000-8000-00000000000e')$q$,
  'NOT_OWNER:%',
  'INV-03: only the owner can re-invite a removed member');
SELECT throws_like($q$SELECT public.rotate_invite_code('10000000-0000-4000-8000-000000000001')$q$, 'NOT_OWNER:%',
  'INV-04: only the owner rotates the invite code');

RESET ROLE;
SELECT _t.login('a0000000-0000-4000-8000-00000000000a');
SELECT isnt((public.rotate_invite_code('10000000-0000-4000-8000-000000000001')).invite_code, 'GONECODE',
  'INV-05: owner rotates the invite code');
SELECT lives_ok(
  $q$SELECT public.create_invite('10000000-0000-4000-8000-000000000001', 'e0000000-0000-4000-8000-00000000000e', 24, 1)$q$,
  'INV-06: owner creates a targeted re-invite for the removed member');

RESET ROLE;
INSERT INTO _t.vars (k, v)
SELECT 'reinvite', token FROM public.group_invites
WHERE invited_user_id = 'e0000000-0000-4000-8000-00000000000e' AND revoked_at IS NULL;

SELECT _t.login('c0000000-0000-4000-8000-00000000000c');
SELECT throws_like($q$SELECT public.join_group('GONECODE')$q$, 'INVITE_CODE_NOT_FOUND:%',
  'INV-07: old code stops working after rotation');

RESET ROLE;
SELECT _t.login('e0000000-0000-4000-8000-00000000000e');
SELECT lives_ok(
  format('SELECT public.accept_invite(%L)', (SELECT v FROM _t.vars WHERE k = 'reinvite')),
  'INV-08: removed member accepts the owner targeted invite');
SELECT is(
  (SELECT status FROM public.group_members
   WHERE group_id = '10000000-0000-4000-8000-000000000001' AND user_id = 'e0000000-0000-4000-8000-00000000000e'),
  'ACTIVE',
  'INV-09: removed member is ACTIVE again');

RESET ROLE;
SELECT _t.login('f0000000-0000-4000-8000-00000000000f');
SELECT throws_like($q$SELECT public.revoke_invite('50000000-0000-4000-8000-000000000001')$q$, 'NOT_MEMBER:%',
  'INV-10: outsider cannot revoke invites (BE-03)');

RESET ROLE;
SELECT _t.login('c0000000-0000-4000-8000-00000000000c');
SELECT throws_like($q$SELECT public.revoke_invite('50000000-0000-4000-8000-000000000001')$q$, 'NOT_AUTHORIZED:%',
  'INV-11: member who did not create the invite cannot revoke it');

-- ============================================================
-- NHÓM CLOSED: mọi thao tác ghi bị từ chối
-- ============================================================
RESET ROLE;
SELECT _t.login('b0000000-0000-4000-8000-00000000000b');
SELECT throws_like(
  $q$SELECT public.create_expense('10000000-0000-4000-8000-000000000002', 'b0000000-0000-4000-8000-00000000000b',
      1000, 'Late', '[{"userId":"b0000000-0000-4000-8000-00000000000b","amount":1000}]'::jsonb, 'closed-new')$q$,
  'GROUP_CLOSED:%', 'CLS-01: create_expense on CLOSED group');
SELECT throws_like(
  $q$SELECT public.create_payment('10000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-00000000000a', 1000, NULL, 'closed-pay')$q$,
  'GROUP_CLOSED:%', 'CLS-02: create_payment on CLOSED group');
SELECT throws_like(
  $q$SELECT public.cancel_expense('20000000-0000-4000-8000-0000000000c1')$q$,
  'GROUP_CLOSED:%', 'CLS-03: cancel_expense on CLOSED group');
SELECT throws_like(
  $q$SELECT public.update_expense('20000000-0000-4000-8000-0000000000c1', 1, 'b0000000-0000-4000-8000-00000000000b',
      10000, 'x', 'EQUAL', '', '[{"userId":"b0000000-0000-4000-8000-00000000000b","amount":10000}]'::jsonb)$q$,
  'GROUP_CLOSED:%', 'CLS-04: update_expense on CLOSED group');
SELECT throws_like(
  $q$SELECT public.create_invite('10000000-0000-4000-8000-000000000002')$q$,
  'GROUP_CLOSED:%', 'CLS-05: create_invite on CLOSED group');
SELECT throws_like(
  $q$SELECT public.leave_group('10000000-0000-4000-8000-000000000002')$q$,
  'GROUP_CLOSED:%', 'CLS-06: leave_group on CLOSED group');

RESET ROLE;
SELECT _t.login('a0000000-0000-4000-8000-00000000000a');
SELECT throws_like(
  $q$SELECT public.update_group('10000000-0000-4000-8000-000000000002', 'Reopen?', NULL, NULL)$q$,
  'GROUP_CLOSED:%', 'CLS-07: update_group on CLOSED group');
SELECT throws_like(
  $q$SELECT public.rotate_invite_code('10000000-0000-4000-8000-000000000002')$q$,
  'GROUP_CLOSED:%', 'CLS-08: rotate_invite_code on CLOSED group');

-- ============================================================
-- BR-11 (thứ tự tuần tự; khóa đồng thời xem 03_concurrency.test.sql)
-- Số dư G1 lúc này: A 0, B 0 (Dinner + Taxi + M trả 10.000 đã xác nhận), M 0,
-- M còn thanh toán PENDING 1.000 cho A (PAY-07).
-- ============================================================
RESET ROLE;
SELECT _t.login('c0000000-0000-4000-8000-00000000000c');
SELECT throws_like($q$SELECT public.leave_group('10000000-0000-4000-8000-000000000001')$q$, 'PENDING_PAYMENTS:%',
  'BR11-01: cannot leave with a PENDING payment');

RESET ROLE;
SELECT _t.login('a0000000-0000-4000-8000-00000000000a');
SELECT throws_like($q$SELECT public.close_group('10000000-0000-4000-8000-000000000001')$q$, 'PENDING_PAYMENTS:%',
  'BR11-02: cannot close with a PENDING payment');
SELECT lives_ok(
  $q$SELECT public.confirm_payment((SELECT id FROM public.payments WHERE note = 'no key'))$q$,
  'BR11-03: owner confirms the pending payment');
SELECT throws_like($q$SELECT public.remove_member('10000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-00000000000c')$q$,
  'NONZERO_BALANCE:%', 'BR11-04: cannot remove a member with a nonzero balance');
SELECT throws_like($q$SELECT public.close_group('10000000-0000-4000-8000-000000000001')$q$, 'UNSETTLED_BALANCES:%',
  'BR11-05: cannot close with unsettled balances');

RESET ROLE;
SELECT _t.login('c0000000-0000-4000-8000-00000000000c');
SELECT throws_like($q$SELECT public.leave_group('10000000-0000-4000-8000-000000000001')$q$, 'NONZERO_BALANCE:%',
  'BR11-06: cannot leave with a nonzero balance');

RESET ROLE;
SELECT _t.login('b0000000-0000-4000-8000-00000000000b');
SELECT is(
  (SELECT official_balance::bigint FROM public.group_balances
   WHERE group_id = '10000000-0000-4000-8000-000000000001' AND user_id = 'b0000000-0000-4000-8000-00000000000b'),
  0::bigint,
  'BR11-07: B is settled');
SELECT lives_ok($q$SELECT public.leave_group('10000000-0000-4000-8000-000000000001')$q$,
  'BR11-08: settled member leaves');

RESET ROLE;
SELECT _t.login('a0000000-0000-4000-8000-00000000000a');
SELECT throws_like(
  $q$SELECT public.cancel_expense((SELECT id FROM public.expenses WHERE description = 'Taxi'))$q$,
  'PARTICIPANT_NOT_ACTIVE:%',
  'BR11-09: an expense involving a member who left can no longer change their balance (BE-03)');

-- ============================================================
-- XÓA TÀI KHOẢN (BE-04, BE-05) — anonymize_account chỉ service_role
-- ============================================================
RESET ROLE;
SELECT _t.login_service();
SELECT throws_like($q$SELECT public.anonymize_account('a0000000-0000-4000-8000-00000000000a')$q$,
  'OWNER_OF_ACTIVE_GROUP:%', 'DEL-01: owner of an active group must transfer first');
SELECT throws_like($q$SELECT public.anonymize_account('c0000000-0000-4000-8000-00000000000c')$q$,
  'NONZERO_BALANCE:%', 'DEL-02: unsettled member cannot be anonymized');
SELECT is(
  (public.anonymize_account('90000000-0000-4000-8000-000000000009')) ->> 'already_anonymized',
  'false',
  'DEL-03: user without history is anonymized');
SELECT is(
  (public.anonymize_account('90000000-0000-4000-8000-000000000009')) ->> 'already_anonymized',
  'true',
  'DEL-04: retry after a later failure is idempotent');

RESET ROLE;
SELECT is(
  (SELECT row(display_name, searchable, avatar_path IS NULL, deleted_at IS NOT NULL, user_code LIKE 'DEL%')::text
   FROM public.profiles WHERE id = '90000000-0000-4000-8000-000000000009'),
  row('Người dùng đã xóa', false, true, true, true)::text,
  'DEL-05: profile row kept as an anonymized tombstone (never hard-deleted)');
SELECT is(
  (SELECT count(*)::int FROM public.push_tokens WHERE user_id = '90000000-0000-4000-8000-000000000009')
  + (SELECT count(*)::int FROM public.friendships WHERE requester_id = '90000000-0000-4000-8000-000000000009' OR addressee_id = '90000000-0000-4000-8000-000000000009')
  + (SELECT count(*)::int FROM public.payment_handles WHERE user_id = '90000000-0000-4000-8000-000000000009'),
  0,
  'DEL-06: tokens, friendships (requester/addressee) and payment handles are removed (BE-04)');

SELECT _t.login('90000000-0000-4000-8000-000000000009');
SELECT throws_like($q$SELECT public.create_group('After delete')$q$, 'ACCOUNT_DELETED:%',
  'DEL-07: anonymized account cannot keep writing with an old token');

RESET ROLE;
DELETE FROM auth.users WHERE id = '90000000-0000-4000-8000-000000000009';
SELECT is((SELECT count(*)::int FROM public.profiles WHERE id = '90000000-0000-4000-8000-000000000009'), 1,
  'DEL-08: deleting the Auth user keeps the profile (FK cascade removed)');

DELETE FROM auth.users WHERE id = '80000000-0000-4000-8000-000000000008';
SELECT is(
  (SELECT row(display_name, deleted_at IS NOT NULL)::text FROM public.profiles WHERE id = '80000000-0000-4000-8000-000000000008'),
  row('Người dùng đã xóa', true)::text,
  'DEL-09: Auth user deleted outside the flow is still anonymized, not deleted');

SELECT * FROM finish();
ROLLBACK;
