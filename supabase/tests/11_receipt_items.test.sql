-- ============================================================
-- Món trên hóa đơn (pgTAP) — migration 0017
--   RCP-01..04  set_expense_receipt_items: người tạo ghi / ghi lại (thay thế), đánh dấu source
--   RCP-10..13  chặn: không phải người tạo, khoản chi đã hủy, dữ liệu sai
--   RCP-20..23  RLS: thành viên đọc được, người ngoài không; không INSERT thẳng; anon không gọi được
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

CREATE FUNCTION _t.as_anon() RETURNS VOID LANGUAGE plpgsql AS $f$
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'anon')::text, true);
  PERFORM set_config('role', 'anon', true);
END $f$;

GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA _t TO anon, authenticated, service_role;

-- ------------------------------------------------------------
-- Fixtures: G ACTIVE, A chủ (tạo khoản chi E1, E2), B thành viên, X người ngoài. E2 đã hủy.
-- ------------------------------------------------------------
DO $$
BEGIN
  PERFORM _t.new_user('a1100000-0000-4000-8000-000000000001', 'Alice');
  PERFORM _t.new_user('b1100000-0000-4000-8000-000000000001', 'Bob');
  PERFORM _t.new_user('d1100000-0000-4000-8000-000000000001', 'Xavi');
END $$;

INSERT INTO public.groups (id, name, owner_id, invite_code, status) VALUES
  ('11100000-0000-4000-8000-000000000001', 'Receipt Group', 'a1100000-0000-4000-8000-000000000001', 'RCPT0001', 'ACTIVE');

INSERT INTO public.group_members (group_id, user_id, role, status) VALUES
  ('11100000-0000-4000-8000-000000000001', 'a1100000-0000-4000-8000-000000000001', 'owner',  'ACTIVE'),
  ('11100000-0000-4000-8000-000000000001', 'b1100000-0000-4000-8000-000000000001', 'member', 'ACTIVE');

INSERT INTO public.expenses (id, group_id, paid_by, amount, description, created_by, idempotency_key, split_method, status) VALUES
  ('e1100000-0000-4000-8000-000000000001', '11100000-0000-4000-8000-000000000001',
   'a1100000-0000-4000-8000-000000000001', 126000, 'Quán phở', 'a1100000-0000-4000-8000-000000000001',
   'rcpt-test-1', 'EQUAL', 'ACTIVE'),
  ('e1100000-0000-4000-8000-000000000002', '11100000-0000-4000-8000-000000000001',
   'a1100000-0000-4000-8000-000000000001', 50000, 'Đã hủy', 'a1100000-0000-4000-8000-000000000001',
   'rcpt-test-2', 'EQUAL', 'CANCELLED');

-- ------------------------------------------------------------
-- RCP-01..04: người tạo ghi danh sách dòng
-- ------------------------------------------------------------
SELECT _t.login('a1100000-0000-4000-8000-000000000001');

SELECT is(
  public.set_expense_receipt_items('e1100000-0000-4000-8000-000000000001', $j$[
    {"name": "Phở bò", "quantity": 1, "amount": 60000, "kind": "ITEM"},
    {"name": "Bún chả", "quantity": 1, "amount": 50000, "kind": "ITEM"},
    {"name": "Trà đá", "quantity": 2, "amount": 10000, "kind": "ITEM"},
    {"name": "Phí dịch vụ", "amount": 6000, "kind": "FEE"}
  ]$j$::jsonb),
  4, 'RCP-01: returns number of saved items');

SELECT results_eq(
  $q$SELECT name, quantity, amount, kind FROM public.receipt_items
     WHERE expense_id = 'e1100000-0000-4000-8000-000000000001' ORDER BY position$q$,
  $q$VALUES ('Phở bò'::text, 1, 60000::bigint, 'ITEM'::text), ('Bún chả', 1, 50000, 'ITEM'),
            ('Trà đá', 2, 10000, 'ITEM'), ('Phí dịch vụ', 1, 6000, 'FEE')$q$,
  'RCP-02: items stored in order; quantity defaults to 1');

SELECT is(
  (SELECT source FROM public.expenses WHERE id = 'e1100000-0000-4000-8000-000000000001'),
  'OCR', 'RCP-03: expense marked source = OCR');

SELECT is(
  public.set_expense_receipt_items('e1100000-0000-4000-8000-000000000001',
    '[{"name": "Phở bò", "amount": 60000, "kind": "ITEM"}, {"name": "Giảm giá", "amount": 5000, "kind": "DISCOUNT"}]'::jsonb),
  2, 'RCP-04: calling again replaces the list');
SELECT is(
  (SELECT count(*)::int FROM public.receipt_items WHERE expense_id = 'e1100000-0000-4000-8000-000000000001'),
  2, 'RCP-04: no leftover rows after replace');

-- ------------------------------------------------------------
-- RCP-10..13: chặn
-- ------------------------------------------------------------
SELECT throws_like(
  $q$SELECT public.set_expense_receipt_items('e1100000-0000-4000-8000-000000000002',
       '[{"name": "Phở", "amount": 1000, "kind": "ITEM"}]'::jsonb)$q$,
  'EXPENSE_NOT_ACTIVE%', 'RCP-10: cancelled expense rejected');

SELECT throws_like(
  $q$SELECT public.set_expense_receipt_items('e1100000-0000-4000-8000-000000000001',
       '[{"name": "Phở", "amount": 1000, "kind": "SNACK"}]'::jsonb)$q$,
  'INVALID_RECEIPT_ITEMS%', 'RCP-11: invalid kind rejected');

SELECT throws_like(
  $q$SELECT public.set_expense_receipt_items('e1100000-0000-4000-8000-000000000001',
       '[{"name": "   ", "amount": 1000, "kind": "ITEM"}]'::jsonb)$q$,
  'INVALID_RECEIPT_ITEMS%', 'RCP-12: empty name rejected');

SELECT _t.login('b1100000-0000-4000-8000-000000000001');
SELECT throws_like(
  $q$SELECT public.set_expense_receipt_items('e1100000-0000-4000-8000-000000000001', '[]'::jsonb)$q$,
  'NOT_EXPENSE_CREATOR%', 'RCP-13: other member cannot overwrite items');

-- ------------------------------------------------------------
-- RCP-20..23: RLS và quyền
-- ------------------------------------------------------------
SELECT is(
  (SELECT count(*)::int FROM public.receipt_items WHERE expense_id = 'e1100000-0000-4000-8000-000000000001'),
  2, 'RCP-20: group member reads items');

SELECT throws_ok(
  $q$INSERT INTO public.receipt_items (expense_id, position, kind, name, amount)
     VALUES ('e1100000-0000-4000-8000-000000000001', 9, 'ITEM', 'Hack', 1)$q$,
  '42501', NULL, 'RCP-21: no direct INSERT');

SELECT _t.login('d1100000-0000-4000-8000-000000000001');
SELECT is(
  (SELECT count(*)::int FROM public.receipt_items WHERE expense_id = 'e1100000-0000-4000-8000-000000000001'),
  0, 'RCP-22: outsider reads nothing');

SELECT _t.as_anon();
SELECT throws_ok(
  $q$SELECT public.set_expense_receipt_items('e1100000-0000-4000-8000-000000000001', '[]'::jsonb)$q$,
  '42501', NULL, 'RCP-23: anon cannot call set_expense_receipt_items');
RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
