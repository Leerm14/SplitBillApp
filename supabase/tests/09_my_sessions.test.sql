-- ============================================================
-- Thiết bị đang đăng nhập (pgTAP) — migration 0015
--   SES-01..04  list_my_sessions: chỉ phiên của mình, đánh dấu phiên hiện tại
--   SES-05..08  revoke_my_session: xóa phiên khác của mình; không xóa phiên hiện tại / của người khác
--   SES-09      anon không gọi được
-- ============================================================

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;

SELECT no_plan();

CREATE SCHEMA _t;
GRANT USAGE ON SCHEMA _t TO anon, authenticated, service_role;

CREATE FUNCTION _t.login(_uid UUID, _session UUID) RETURNS VOID LANGUAGE plpgsql AS $f$
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', _uid, 'role', 'authenticated', 'aud', 'authenticated', 'session_id', _session)::text, true);
  PERFORM set_config('role', 'authenticated', true);
END $f$;

CREATE FUNCTION _t.as_anon() RETURNS VOID LANGUAGE plpgsql AS $f$
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'anon')::text, true);
  PERFORM set_config('role', 'anon', true);
END $f$;

GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA _t TO anon, authenticated, service_role;

-- Fixtures: A có 2 phiên (S1 hiện tại, S2 máy khác), B có 1 phiên (S3)
INSERT INTO auth.users (id, aud, role, email, raw_user_meta_data, created_at, updated_at) VALUES
  ('5e550000-0000-0000-0000-00000000000a', 'authenticated', 'authenticated', 'ses-a@test.local', '{"display_name":"A"}', now(), now()),
  ('5e550000-0000-0000-0000-00000000000b', 'authenticated', 'authenticated', 'ses-b@test.local', '{"display_name":"B"}', now(), now());

INSERT INTO auth.sessions (id, user_id, created_at, updated_at) VALUES
  ('5e550000-0000-0000-0000-000000000001', '5e550000-0000-0000-0000-00000000000a', now() - interval '2 days', now()),
  ('5e550000-0000-0000-0000-000000000002', '5e550000-0000-0000-0000-00000000000a', now() - interval '5 days', now() - interval '1 day'),
  ('5e550000-0000-0000-0000-000000000003', '5e550000-0000-0000-0000-00000000000b', now(), now());

SELECT _t.login('5e550000-0000-0000-0000-00000000000a', '5e550000-0000-0000-0000-000000000001');

SELECT is((SELECT count(*)::int FROM public.list_my_sessions()), 2, 'SES-01: A thấy đúng 2 phiên của mình');
SELECT ok(NOT EXISTS (SELECT 1 FROM public.list_my_sessions() WHERE id = '5e550000-0000-0000-0000-000000000003'),
          'SES-02: không thấy phiên của người khác');
SELECT is((SELECT id FROM public.list_my_sessions() WHERE is_current),
          '5e550000-0000-0000-0000-000000000001'::uuid, 'SES-03: đánh dấu phiên hiện tại');
SELECT is((SELECT id FROM public.list_my_sessions() LIMIT 1),
          '5e550000-0000-0000-0000-000000000001'::uuid, 'SES-04: phiên hiện tại đứng đầu');

SELECT throws_like($$ SELECT public.revoke_my_session('5e550000-0000-0000-0000-000000000001') $$,
                   'CANNOT_REVOKE_CURRENT%', 'SES-05: không đăng xuất phiên hiện tại qua RPC');
SELECT throws_like($$ SELECT public.revoke_my_session('5e550000-0000-0000-0000-000000000003') $$,
                   'SESSION_NOT_FOUND%', 'SES-06: không đăng xuất phiên của người khác');
SELECT lives_ok($$ SELECT public.revoke_my_session('5e550000-0000-0000-0000-000000000002') $$,
                'SES-07: đăng xuất máy khác của mình');
SELECT is((SELECT count(*)::int FROM public.list_my_sessions()), 1, 'SES-08: còn lại phiên hiện tại');

SELECT _t.as_anon();
SELECT throws_ok($$ SELECT * FROM public.list_my_sessions() $$, '42501', NULL, 'SES-09: anon không gọi được');

RESET role;
SELECT * FROM finish();
ROLLBACK;
