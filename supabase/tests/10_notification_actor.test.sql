-- ============================================================
-- Người thực hiện của thông báo (pgTAP) — migration 0016
--   ACT-01  MEMBER_JOINED cho chủ nhóm ghi actor = người vừa vào
--   ACT-02  OWNERSHIP_RECEIVED cho chủ mới ghi actor = chủ cũ
--   ACT-03  không còn OWNERSHIP_TRANSFERRED gửi cho chính người chuyển quyền
--   ACT-04  EXPENSE_CREATED cho thành viên khác ghi actor = người tạo khoản chi
--   ACT-05  người tạo khoản chi không nhận thông báo của chính mình
--   ACT-06  thông báo hệ thống (không có người gọi) vẫn được tạo, actor để trống
-- ============================================================

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;

SELECT no_plan();

CREATE SCHEMA _t;
GRANT USAGE ON SCHEMA _t TO anon, authenticated, service_role;

CREATE FUNCTION _t.login(_uid UUID) RETURNS VOID LANGUAGE plpgsql AS $f$
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', _uid, 'role', 'authenticated', 'aud', 'authenticated')::text, true);
  PERFORM set_config('role', 'authenticated', true);
END $f$;

CREATE FUNCTION _t.as_system() RETURNS VOID LANGUAGE plpgsql AS $f$
BEGIN
  PERFORM set_config('request.jwt.claims', '', true);
  PERFORM set_config('role', 'postgres', true);
END $f$;

GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA _t TO anon, authenticated, service_role;

INSERT INTO auth.users (id, aud, role, email, raw_user_meta_data, created_at, updated_at) VALUES
  ('ac700000-0000-0000-0000-00000000000a', 'authenticated', 'authenticated', 'act-a@test.local', '{"display_name":"A"}', now(), now()),
  ('ac700000-0000-0000-0000-00000000000b', 'authenticated', 'authenticated', 'act-b@test.local', '{"display_name":"B"}', now(), now());

-- A tạo nhóm, B vào bằng mã nhóm
SELECT _t.login('ac700000-0000-0000-0000-00000000000a');
CREATE TEMP TABLE _g ON COMMIT DROP AS SELECT * FROM public.create_group('Nhóm ACT', '', true);
GRANT SELECT ON _g TO authenticated, postgres;

SELECT _t.login('ac700000-0000-0000-0000-00000000000b');
SELECT public.join_by_code((SELECT invite_code FROM _g));

SELECT _t.as_system();
SELECT is(
  (SELECT actor_id FROM public.notifications
    WHERE user_id = 'ac700000-0000-0000-0000-00000000000a' AND type = 'MEMBER_JOINED' AND group_id = (SELECT id FROM _g)),
  'ac700000-0000-0000-0000-00000000000b'::uuid, 'ACT-01: MEMBER_JOINED ghi người vừa vào');

-- A chuyển quyền chủ nhóm cho B
SELECT _t.login('ac700000-0000-0000-0000-00000000000a');
SELECT public.transfer_ownership((SELECT id FROM _g), 'ac700000-0000-0000-0000-00000000000b');

SELECT _t.as_system();
SELECT is(
  (SELECT actor_id FROM public.notifications
    WHERE user_id = 'ac700000-0000-0000-0000-00000000000b' AND type = 'OWNERSHIP_RECEIVED' AND group_id = (SELECT id FROM _g)),
  'ac700000-0000-0000-0000-00000000000a'::uuid, 'ACT-02: OWNERSHIP_RECEIVED ghi chủ cũ');
SELECT ok(NOT EXISTS (
  SELECT 1 FROM public.notifications
   WHERE user_id = 'ac700000-0000-0000-0000-00000000000a' AND type = 'OWNERSHIP_TRANSFERRED'),
  'ACT-03: người chuyển quyền không nhận thông báo của chính mình');

-- B thêm khoản chi chia đôi
SELECT _t.login('ac700000-0000-0000-0000-00000000000b');
SELECT public.create_expense(
  (SELECT id FROM _g), 'ac700000-0000-0000-0000-00000000000b', 100000, 'Cà phê',
  '[{"userId":"ac700000-0000-0000-0000-00000000000a","amount":50000},{"userId":"ac700000-0000-0000-0000-00000000000b","amount":50000}]'::jsonb,
  'act-exp-1', 'EQUAL', '', NULL);

SELECT _t.as_system();
SELECT is(
  (SELECT actor_id FROM public.notifications
    WHERE user_id = 'ac700000-0000-0000-0000-00000000000a' AND type = 'EXPENSE_CREATED' AND group_id = (SELECT id FROM _g)),
  'ac700000-0000-0000-0000-00000000000b'::uuid, 'ACT-04: EXPENSE_CREATED ghi người tạo');
SELECT ok(NOT EXISTS (
  SELECT 1 FROM public.notifications
   WHERE user_id = 'ac700000-0000-0000-0000-00000000000b' AND type = 'EXPENSE_CREATED'),
  'ACT-05: người tạo không nhận thông báo của chính mình');

-- Hệ thống tạo thông báo (không có người gọi): vẫn chèn được, actor để trống
INSERT INTO public.notifications (user_id, type, group_id)
VALUES ('ac700000-0000-0000-0000-00000000000b', 'MEMBER_LEFT', (SELECT id FROM _g));
SELECT ok(EXISTS (
  SELECT 1 FROM public.notifications
   WHERE user_id = 'ac700000-0000-0000-0000-00000000000b' AND type = 'MEMBER_LEFT' AND actor_id IS NULL),
  'ACT-06: thông báo hệ thống giữ nguyên');

SELECT * FROM finish();
ROLLBACK;
