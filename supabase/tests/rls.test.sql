-- ============================================================
-- RLS Tests — pgTAP-based Row Level Security tests for Split Bill App
-- Run with: supabase test db
--
-- TST-01: Rewritten to use pgTAP framework with proper role switching
-- Uses SET LOCAL role + request.jwt.claims (not SECURITY DEFINER hack)
-- ============================================================

BEGIN;

SELECT plan(18);

-- ============================
-- 1. SETUP: Test users and data
-- ============================

-- Tạo 3 users: member_a (chủ nhóm), member_b (thành viên), outsider (người ngoài)
INSERT INTO auth.users (id, email, encrypted_password, email_confirmed_at, role)
VALUES
  ('aaaaaaaa-0000-0000-0000-aaaaaaaaaaaa', 'rls_test_a@test.local',
   crypt('testpass123', gen_salt('bf')), now(), 'authenticated'),
  ('bbbbbbbb-0000-0000-0000-bbbbbbbbbbbb', 'rls_test_b@test.local',
   crypt('testpass123', gen_salt('bf')), now(), 'authenticated'),
  ('cccccccc-0000-0000-0000-cccccccccccc', 'rls_test_outsider@test.local',
   crypt('testpass123', gen_salt('bf')), now(), 'authenticated')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.profiles (id, display_name, user_code)
VALUES
  ('aaaaaaaa-0000-0000-0000-aaaaaaaaaaaa', 'Test Member A', 'RLSTSTA1'),
  ('bbbbbbbb-0000-0000-0000-bbbbbbbbbbbb', 'Test Member B', 'RLSTSTB1'),
  ('cccccccc-0000-0000-0000-cccccccccccc', 'Test Outsider', 'RLSTSTC1')
ON CONFLICT (id) DO UPDATE SET display_name = EXCLUDED.display_name;

-- Tạo nhóm test
INSERT INTO public.groups (id, name, owner_id, invite_code)
VALUES ('11111111-0000-0000-0000-111111111111', 'RLS_TEST_Group',
        'aaaaaaaa-0000-0000-0000-aaaaaaaaaaaa', 'RLSTST01')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.group_members (group_id, user_id, role, status)
VALUES
  ('11111111-0000-0000-0000-111111111111', 'aaaaaaaa-0000-0000-0000-aaaaaaaaaaaa', 'owner', 'ACTIVE'),
  ('11111111-0000-0000-0000-111111111111', 'bbbbbbbb-0000-0000-0000-bbbbbbbbbbbb', 'member', 'ACTIVE')
ON CONFLICT (group_id, user_id) DO UPDATE SET status = 'ACTIVE', left_at = NULL;

-- Tạo expense test
INSERT INTO public.expenses (id, group_id, paid_by, amount, description, created_by, idempotency_key, status)
VALUES ('22222222-0000-0000-0000-222222222222', '11111111-0000-0000-0000-111111111111',
        'aaaaaaaa-0000-0000-0000-aaaaaaaaaaaa', 90000, 'RLS Test Expense',
        'aaaaaaaa-0000-0000-0000-aaaaaaaaaaaa', 'rls-test-key-001', 'ACTIVE')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.expense_shares (expense_id, user_id, amount)
VALUES
  ('22222222-0000-0000-0000-222222222222', 'aaaaaaaa-0000-0000-0000-aaaaaaaaaaaa', 45000),
  ('22222222-0000-0000-0000-222222222222', 'bbbbbbbb-0000-0000-0000-bbbbbbbbbbbb', 45000)
ON CONFLICT (expense_id, user_id) DO NOTHING;

-- Tạo payment test
INSERT INTO public.payments (id, group_id, from_id, to_id, amount, status, idempotency_key)
VALUES ('33333333-0000-0000-0000-333333333333', '11111111-0000-0000-0000-111111111111',
        'bbbbbbbb-0000-0000-0000-bbbbbbbbbbbb', 'aaaaaaaa-0000-0000-0000-aaaaaaaaaaaa',
        45000, 'PENDING', 'rls-test-pay-001')
ON CONFLICT (id) DO NOTHING;

-- Tạo notifications
INSERT INTO public.notifications (id, user_id, type, group_id)
VALUES
  ('44444444-0000-0000-0000-444444444444', 'aaaaaaaa-0000-0000-0000-aaaaaaaaaaaa',
   'EXPENSE_CREATED', '11111111-0000-0000-0000-111111111111'),
  ('44444444-0000-0000-0000-444444444445', 'bbbbbbbb-0000-0000-0000-bbbbbbbbbbbb',
   'EXPENSE_CREATED', '11111111-0000-0000-0000-111111111111')
ON CONFLICT (id) DO NOTHING;

-- ============================
-- Helper: Switch to authenticated user via SET LOCAL
-- ============================
CREATE OR REPLACE FUNCTION _test_login(_user_id UUID)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claims',
    json_build_object(
      'sub', _user_id,
      'role', 'authenticated',
      'aud', 'authenticated'
    )::text, true);
  PERFORM set_config('request.jwt.claim.sub', _user_id::text, true);
  -- Use SET LOCAL instead of set_config('role', ...) — correct for pgTAP
  EXECUTE 'SET LOCAL role = authenticated';
END $$;

-- Helper: Reset to service role
CREATE OR REPLACE FUNCTION _test_reset_role()
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  RESET role;
END $$;

-- ============================
-- TEST 1: Outsider KHÔNG đọc được groups
-- ============================
SELECT _test_login('cccccccc-0000-0000-0000-cccccccccccc');
SELECT is(
  (SELECT COUNT(*)::int FROM public.groups WHERE id = '11111111-0000-0000-0000-111111111111'),
  0,
  'TEST-RLS-01: Outsider cannot read group'
);
SELECT _test_reset_role();

-- ============================
-- TEST 2: Member CÓ đọc được groups
-- ============================
SELECT _test_login('aaaaaaaa-0000-0000-0000-aaaaaaaaaaaa');
SELECT ok(
  (SELECT COUNT(*) FROM public.groups WHERE id = '11111111-0000-0000-0000-111111111111') > 0,
  'TEST-RLS-02: Member can read own group'
);
SELECT _test_reset_role();

-- ============================
-- TEST 3: Outsider KHÔNG đọc được expenses
-- ============================
SELECT _test_login('cccccccc-0000-0000-0000-cccccccccccc');
SELECT is(
  (SELECT COUNT(*)::int FROM public.expenses WHERE group_id = '11111111-0000-0000-0000-111111111111'),
  0,
  'TEST-RLS-03: Outsider cannot read expenses'
);
SELECT _test_reset_role();

-- ============================
-- TEST 4: Member đọc được expenses
-- ============================
SELECT _test_login('bbbbbbbb-0000-0000-0000-bbbbbbbbbbbb');
SELECT ok(
  (SELECT COUNT(*) FROM public.expenses WHERE group_id = '11111111-0000-0000-0000-111111111111') > 0,
  'TEST-RLS-04: Member can read expenses'
);
SELECT _test_reset_role();

-- ============================
-- TEST 5: Outsider KHÔNG đọc được expense_shares
-- ============================
SELECT _test_login('cccccccc-0000-0000-0000-cccccccccccc');
SELECT is(
  (SELECT COUNT(*)::int FROM public.expense_shares WHERE expense_id = '22222222-0000-0000-0000-222222222222'),
  0,
  'TEST-RLS-05: Outsider cannot read expense_shares'
);
SELECT _test_reset_role();

-- ============================
-- TEST 6: Outsider KHÔNG đọc được payments
-- ============================
SELECT _test_login('cccccccc-0000-0000-0000-cccccccccccc');
SELECT is(
  (SELECT COUNT(*)::int FROM public.payments WHERE group_id = '11111111-0000-0000-0000-111111111111'),
  0,
  'TEST-RLS-06: Outsider cannot read payments'
);
SELECT _test_reset_role();

-- ============================
-- TEST 7: Member đọc được payments
-- ============================
SELECT _test_login('aaaaaaaa-0000-0000-0000-aaaaaaaaaaaa');
SELECT ok(
  (SELECT COUNT(*) FROM public.payments WHERE group_id = '11111111-0000-0000-0000-111111111111') > 0,
  'TEST-RLS-07: Member can read payments'
);
SELECT _test_reset_role();

-- ============================
-- TEST 8: Outsider KHÔNG đọc được activity_logs
-- ============================
SELECT _test_login('cccccccc-0000-0000-0000-cccccccccccc');
SELECT is(
  (SELECT COUNT(*)::int FROM public.activity_logs WHERE group_id = '11111111-0000-0000-0000-111111111111'),
  0,
  'TEST-RLS-08: Outsider cannot read activity_logs'
);
SELECT _test_reset_role();

-- ============================
-- TEST 9: User KHÔNG đọc được notifications của người khác
-- ============================
SELECT _test_login('bbbbbbbb-0000-0000-0000-bbbbbbbbbbbb');
SELECT is(
  (SELECT COUNT(*)::int FROM public.notifications WHERE user_id = 'aaaaaaaa-0000-0000-0000-aaaaaaaaaaaa'),
  0,
  'TEST-RLS-09: User cannot read other user notifications'
);
SELECT _test_reset_role();

-- ============================
-- TEST 10: User đọc được notifications của mình
-- ============================
SELECT _test_login('aaaaaaaa-0000-0000-0000-aaaaaaaaaaaa');
SELECT ok(
  (SELECT COUNT(*) FROM public.notifications WHERE user_id = 'aaaaaaaa-0000-0000-0000-aaaaaaaaaaaa') > 0,
  'TEST-RLS-10: User can read own notifications'
);
SELECT _test_reset_role();

-- ============================
-- TEST 11: LEFT member KHÔNG đọc được groups (sau khi rời)
-- ============================
-- Cập nhật member_b thành LEFT
UPDATE public.group_members
SET status = 'LEFT', left_at = now()
WHERE group_id = '11111111-0000-0000-0000-111111111111'
  AND user_id = 'bbbbbbbb-0000-0000-0000-bbbbbbbbbbbb';

SELECT _test_login('bbbbbbbb-0000-0000-0000-bbbbbbbbbbbb');
SELECT is(
  (SELECT COUNT(*)::int FROM public.groups WHERE id = '11111111-0000-0000-0000-111111111111'),
  0,
  'TEST-RLS-11: LEFT member cannot read group'
);
SELECT _test_reset_role();

-- Khôi phục ACTIVE
UPDATE public.group_members
SET status = 'ACTIVE', left_at = NULL
WHERE group_id = '11111111-0000-0000-0000-111111111111'
  AND user_id = 'bbbbbbbb-0000-0000-0000-bbbbbbbbbbbb';

-- ============================
-- TEST 12: Outsider KHÔNG tạo được payment (RLS INSERT blocked)
-- ============================
SELECT _test_login('cccccccc-0000-0000-0000-cccccccccccc');
SELECT throws_ok(
  $$INSERT INTO public.payments (group_id, from_id, to_id, amount, status, idempotency_key)
    VALUES ('11111111-0000-0000-0000-111111111111',
            'cccccccc-0000-0000-0000-cccccccccccc',
            'aaaaaaaa-0000-0000-0000-aaaaaaaaaaaa',
            10000, 'PENDING', 'rls-test-outsider-pay')$$,
  NULL, -- any exception
  'TEST-RLS-12: Outsider cannot insert payment'
);
SELECT _test_reset_role();

-- ============================
-- TEST 13: Outsider KHÔNG đọc được group_members
-- ============================
SELECT _test_login('cccccccc-0000-0000-0000-cccccccccccc');
SELECT is(
  (SELECT COUNT(*)::int FROM public.group_members WHERE group_id = '11111111-0000-0000-0000-111111111111'),
  0,
  'TEST-RLS-13: Outsider cannot read group_members'
);
SELECT _test_reset_role();

-- ============================
-- TEST 14: Outsider KHÔNG đọc được group_invites
-- ============================
SELECT _test_login('cccccccc-0000-0000-0000-cccccccccccc');
SELECT is(
  (SELECT COUNT(*)::int FROM public.group_invites WHERE group_id = '11111111-0000-0000-0000-111111111111'),
  0,
  'TEST-RLS-14: Outsider cannot read group_invites'
);
SELECT _test_reset_role();

-- ============================
-- TEST 15-16: RPC access control (SEC-01, SEC-02)
-- ============================
-- TEST 15: Outsider KHÔNG gọi được create_payment RPC
SELECT _test_login('cccccccc-0000-0000-0000-cccccccccccc');
SELECT throws_ok(
  $$SELECT public.create_payment(
    '11111111-0000-0000-0000-111111111111',
    'aaaaaaaa-0000-0000-0000-aaaaaaaaaaaa',
    10000, NULL, 'rls-rpc-test-001')$$,
  NULL,
  'TEST-RLS-15: Outsider cannot call create_payment RPC'
);
SELECT _test_reset_role();

-- TEST 16: Member CÓ gọi được create_expense RPC
SELECT _test_login('aaaaaaaa-0000-0000-0000-aaaaaaaaaaaa');
SELECT lives_ok(
  $$SELECT public.create_expense(
    '11111111-0000-0000-0000-111111111111',
    'aaaaaaaa-0000-0000-0000-aaaaaaaaaaaa',
    50000, 'RPC Test', '[{"userId":"aaaaaaaa-0000-0000-0000-aaaaaaaaaaaa","amount":25000},{"userId":"bbbbbbbb-0000-0000-0000-bbbbbbbbbbbb","amount":25000}]'::jsonb,
    'rls-rpc-test-002')$$,
  'TEST-RLS-16: Member can call create_expense RPC'
);
SELECT _test_reset_role();

-- ============================
-- TEST 17-18: Anon role cannot access data
-- ============================
PERFORM set_config('request.jwt.claims', '{}', true);
EXECUTE 'SET LOCAL role = anon';

SELECT is(
  (SELECT COUNT(*)::int FROM public.groups),
  0,
  'TEST-RLS-17: Anon cannot read any groups'
);

SELECT is(
  (SELECT COUNT(*)::int FROM public.profiles),
  0,
  'TEST-RLS-18: Anon cannot read any profiles'
);

RESET role;

-- ============================
-- CLEANUP
-- ============================
DROP FUNCTION IF EXISTS _test_login(UUID);
DROP FUNCTION IF EXISTS _test_reset_role();

SELECT * FROM finish();

ROLLBACK;
