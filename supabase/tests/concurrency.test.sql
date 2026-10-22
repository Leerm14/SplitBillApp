-- ============================================================
-- Concurrency Tests — pgTAP-based concurrency/idempotency tests
-- Run with: supabase test db
--
-- TST-02: Rewritten to use pgTAP framework
-- Fixed: respond_payment → confirm_payment/reject_payment (SEC-01)
-- Fixed: WHEN OTHERS → specific exception matching (BE-11)
-- ============================================================

BEGIN;

SELECT plan(7);

-- ============================
-- 1. SETUP
-- ============================

INSERT INTO auth.users (id, email, encrypted_password, email_confirmed_at, role)
VALUES
  ('aa000000-1111-0000-0000-000000000001', 'conc_test_a@test.local',
   crypt('testpass123', gen_salt('bf')), now(), 'authenticated'),
  ('aa000000-1111-0000-0000-000000000002', 'conc_test_b@test.local',
   crypt('testpass123', gen_salt('bf')), now(), 'authenticated')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.profiles (id, display_name, user_code)
VALUES
  ('aa000000-1111-0000-0000-000000000001', 'Conc User A', 'CNCTSTA1'),
  ('aa000000-1111-0000-0000-000000000002', 'Conc User B', 'CNCTSTA2')
ON CONFLICT (id) DO UPDATE SET display_name = EXCLUDED.display_name;

INSERT INTO public.groups (id, name, owner_id, invite_code)
VALUES ('aa000000-2222-0000-0000-000000000001', 'CONC_TEST_Group',
        'aa000000-1111-0000-0000-000000000001', 'CNCTST01')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.group_members (group_id, user_id, role, status)
VALUES
  ('aa000000-2222-0000-0000-000000000001', 'aa000000-1111-0000-0000-000000000001', 'owner', 'ACTIVE'),
  ('aa000000-2222-0000-0000-000000000001', 'aa000000-1111-0000-0000-000000000002', 'member', 'ACTIVE')
ON CONFLICT (group_id, user_id) DO UPDATE SET status = 'ACTIVE';

-- Helper: Switch to authenticated user
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
  EXECUTE 'SET LOCAL role = authenticated';
END $$;

CREATE OR REPLACE FUNCTION _test_reset_role()
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  RESET role;
END $$;

-- ============================
-- TEST 1: Optimistic Locking — version conflict
-- ============================
SELECT _test_login('aa000000-1111-0000-0000-000000000001');

-- User A tạo expense
DO $$
DECLARE
  _expense_id UUID;
  _shares JSONB := '[{"userId":"aa000000-1111-0000-0000-000000000001","amount":50000},{"userId":"aa000000-1111-0000-0000-000000000002","amount":50000}]';
BEGIN
  SELECT id INTO _expense_id FROM public.create_expense(
    'aa000000-2222-0000-0000-000000000001',
    'aa000000-1111-0000-0000-000000000001',
    100000, 'Conc Test Expense', _shares, 'conc-test-key-001'
  );

  -- User A sửa expense (version 1 → 2)
  PERFORM public.update_expense(
    _expense_id, 1,
    'aa000000-1111-0000-0000-000000000001',
    120000, 'Updated by A', 'EQUAL', '',
    '[{"userId":"aa000000-1111-0000-0000-000000000001","amount":60000},{"userId":"aa000000-1111-0000-0000-000000000002","amount":60000}]'::jsonb
  );

  -- Store expense_id for the test
  PERFORM set_config('test.expense_id', _expense_id::text, true);
END $$;

-- User B thử sửa với version cũ (1) → phải thất bại
SELECT throws_ok(
  format(
    $$SELECT public.update_expense(
      '%s'::uuid, 1,
      'aa000000-1111-0000-0000-000000000002',
      150000, 'Updated by B', 'EQUAL', '',
      '[{"userId":"aa000000-1111-0000-0000-000000000001","amount":75000},{"userId":"aa000000-1111-0000-0000-000000000002","amount":75000}]'::jsonb
    )$$, current_setting('test.expense_id')
  ),
  'P0002', -- raise_exception ERRCODE
  'TEST-CONC-01: Optimistic locking prevents concurrent edit'
);
SELECT _test_reset_role();

-- ============================
-- TEST 2: Idempotency — cùng key tạo expense nhiều lần
-- ============================
SELECT _test_login('aa000000-1111-0000-0000-000000000001');
DO $$
DECLARE
  _id1 UUID;
  _id2 UUID;
  _shares JSONB := '[{"userId":"aa000000-1111-0000-0000-000000000001","amount":30000},{"userId":"aa000000-1111-0000-0000-000000000002","amount":30000}]';
BEGIN
  SELECT id INTO _id1 FROM public.create_expense(
    'aa000000-2222-0000-0000-000000000001',
    'aa000000-1111-0000-0000-000000000001',
    60000, 'Idempotency Test', _shares, 'idemp-test-key-001'
  );

  SELECT id INTO _id2 FROM public.create_expense(
    'aa000000-2222-0000-0000-000000000001',
    'aa000000-1111-0000-0000-000000000001',
    60000, 'Idempotency Test', _shares, 'idemp-test-key-001'
  );

  -- Store for assertion
  PERFORM set_config('test.idemp_same', (_id1 = _id2)::text, true);
END $$;

SELECT ok(
  current_setting('test.idemp_same')::boolean,
  'TEST-CONC-02: Same idempotency_key returns same expense'
);

-- Count: chỉ có 1 expense với key này
SELECT is(
  (SELECT COUNT(*)::int FROM public.expenses WHERE idempotency_key = 'idemp-test-key-001'),
  1,
  'TEST-CONC-02b: Only 1 expense exists with the same key'
);
SELECT _test_reset_role();

-- ============================
-- TEST 3: Double confirm payment — xác nhận 2 lần phải thất bại
-- ============================
-- User B tạo payment
INSERT INTO public.payments (id, group_id, from_id, to_id, amount, status, idempotency_key)
VALUES ('aa000000-3333-0000-0000-000000000001',
        'aa000000-2222-0000-0000-000000000001',
        'aa000000-1111-0000-0000-000000000002',
        'aa000000-1111-0000-0000-000000000001',
        50000, 'PENDING', 'conc-test-pay-001')
ON CONFLICT (id) DO UPDATE SET status = 'PENDING', decided_at = NULL;

-- User A (receiver) confirms
SELECT _test_login('aa000000-1111-0000-0000-000000000001');
SELECT lives_ok(
  $$SELECT public.confirm_payment('aa000000-3333-0000-0000-000000000001')$$,
  'TEST-CONC-03a: First confirm succeeds'
);

-- User A confirms again → phải thất bại
SELECT throws_ok(
  $$SELECT public.confirm_payment('aa000000-3333-0000-0000-000000000001')$$,
  'P0002',
  'TEST-CONC-03b: Double confirm payment is rejected'
);
SELECT _test_reset_role();

-- ============================
-- TEST 4: Cancel already cancelled expense — idempotent
-- ============================
SELECT _test_login('aa000000-1111-0000-0000-000000000001');
DO $$
DECLARE
  _expense_id UUID;
  _shares JSONB := '[{"userId":"aa000000-1111-0000-0000-000000000001","amount":20000},{"userId":"aa000000-1111-0000-0000-000000000002","amount":20000}]';
  _status1 TEXT;
  _status2 TEXT;
BEGIN
  SELECT id INTO _expense_id FROM public.create_expense(
    'aa000000-2222-0000-0000-000000000001',
    'aa000000-1111-0000-0000-000000000001',
    40000, 'Cancel Test', _shares, 'cancel-test-key-001'
  );

  -- Hủy lần 1
  SELECT status INTO _status1 FROM public.cancel_expense(_expense_id);
  -- Hủy lần 2 — phải idempotent
  SELECT status INTO _status2 FROM public.cancel_expense(_expense_id);

  PERFORM set_config('test.cancel_ok', (_status1 = 'CANCELLED' AND _status2 = 'CANCELLED')::text, true);
END $$;

SELECT ok(
  current_setting('test.cancel_ok')::boolean,
  'TEST-CONC-04: Double cancel expense is idempotent'
);
SELECT _test_reset_role();

-- ============================
-- TEST 5: Cancel DISPUTED payment — phải bị từ chối (BE-11)
-- Chỉ cho cancel PENDING, không cho cancel DISPUTED
-- ============================
-- User B tạo payment mới
INSERT INTO public.payments (id, group_id, from_id, to_id, amount, status, idempotency_key)
VALUES ('aa000000-3333-0000-0000-000000000002',
        'aa000000-2222-0000-0000-000000000001',
        'aa000000-1111-0000-0000-000000000002',
        'aa000000-1111-0000-0000-000000000001',
        30000, 'PENDING', 'conc-test-pay-002')
ON CONFLICT (id) DO UPDATE SET status = 'PENDING', decided_at = NULL;

-- User A confirms
SELECT _test_login('aa000000-1111-0000-0000-000000000001');
PERFORM public.confirm_payment('aa000000-3333-0000-0000-000000000002');
-- User A disputes (receiver)
PERFORM public.dispute_payment('aa000000-3333-0000-0000-000000000002', 'Số tiền sai');
SELECT _test_reset_role();

-- User B tries to cancel DISPUTED → should fail
SELECT _test_login('aa000000-1111-0000-0000-000000000002');
SELECT throws_ok(
  $$SELECT public.cancel_payment('aa000000-3333-0000-0000-000000000002')$$,
  'P0002',
  'TEST-CONC-05: Cannot cancel DISPUTED payment'
);
SELECT _test_reset_role();

-- ============================
-- CLEANUP
-- ============================
DROP FUNCTION IF EXISTS _test_login(UUID);
DROP FUNCTION IF EXISTS _test_reset_role();

SELECT * FROM finish();

ROLLBACK;
