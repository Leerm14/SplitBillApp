-- ============================================================
-- Push trigger (pgTAP) — CFG-04, NEW-09
-- Thêm notifications → trigger gọi net.http_post (pg_net) tới /functions/v1/send-push
-- với header x-webhook-secret lấy từ Vault, không có service role key / JWT.
-- pg_net chỉ gửi request sau khi COMMIT; file này ROLLBACK nên không có request thật.
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
CREATE TABLE _t.state (k TEXT PRIMARY KEY, n BIGINT);

INSERT INTO auth.users (id, aud, role, email, raw_user_meta_data, created_at, updated_at) VALUES
  ('a0000000-0000-4000-8000-00000000000a', 'authenticated', 'authenticated', 'push-a@test.local', '{"display_name":"A"}', now(), now()),
  ('b0000000-0000-4000-8000-00000000000b', 'authenticated', 'authenticated', 'push-b@test.local', '{"display_name":"B"}', now(), now());
INSERT INTO public.push_tokens (user_id, expo_token)
VALUES ('a0000000-0000-4000-8000-00000000000a', 'ExponentPushToken[push-test]');

-- Có sẵn cấu hình Vault trên máy này không?
INSERT INTO _t.state
SELECT 'configured', count(*) FROM vault.decrypted_secrets
WHERE name IN ('supabase_url', 'webhook_secret') AND COALESCE(decrypted_secret, '') <> '';

-- Chỉ đếm request của CHÍNH các thông báo trong file này (lọc theo id thông báo
-- trong body), không đếm cả hàng đợi pg_net — hàng đợi có thể đang có request khác
-- (worker pg_net, giao dịch khác) làm test chập chờn.
CREATE FUNCTION _t.queued_for(_notification_ids UUID[]) RETURNS BIGINT LANGUAGE sql AS $f$
  SELECT count(*) FROM net.http_request_queue q
  WHERE q.url LIKE '%/functions/v1/send-push'
    AND (convert_from(q.body, 'UTF8')::jsonb -> 'record' ->> 'id')::uuid = ANY (_notification_ids);
$f$;
CREATE FUNCTION _t.queued_for_user(_user_id UUID) RETURNS BIGINT LANGUAGE sql AS $f$
  SELECT _t.queued_for(ARRAY(SELECT id FROM public.notifications WHERE user_id = _user_id));
$f$;

-- Thiếu secret: thông báo vẫn được tạo (RAISE WARNING PUSH_NOT_CONFIGURED), không gọi HTTP
SELECT CASE WHEN (SELECT n FROM _t.state WHERE k = 'configured') = 2
  THEN skip('Vault secrets already configured on this database', 2)
  ELSE lives_ok(
    $q$INSERT INTO public.notifications (user_id, type) VALUES ('a0000000-0000-4000-8000-00000000000a', 'TEST_UNCONFIGURED')$q$,
    'PUSH-01: missing Vault secrets do not block the notification insert')
END;
SELECT CASE WHEN (SELECT n FROM _t.state WHERE k = 'configured') = 2
  THEN NULL
  ELSE is(_t.queued_for_user('a0000000-0000-4000-8000-00000000000a'), 0::bigint,
          'PUSH-02: no HTTP request is queued without configuration')
END;

-- Cấu hình (chỉ trong giao dịch test nếu chưa có)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM vault.decrypted_secrets WHERE name = 'supabase_url') THEN
    PERFORM vault.create_secret('http://push-test.local/', 'supabase_url');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM vault.decrypted_secrets WHERE name = 'webhook_secret') THEN
    PERFORM vault.create_secret('test-webhook-secret', 'webhook_secret');
  END IF;
END $$;

INSERT INTO public.notifications (id, user_id, type)
VALUES ('60000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-00000000000a', 'EXPENSE_CREATED');

SELECT is(_t.queued_for(ARRAY['60000000-0000-4000-8000-000000000001']::uuid[]), 1::bigint,
  'PUSH-03: notification insert queues exactly one pg_net request');

SELECT ok(
  EXISTS (
    SELECT 1 FROM net.http_request_queue q
    WHERE q.url LIKE '%/functions/v1/send-push'
      AND q.url NOT LIKE '%//functions/%'
      AND q.headers ->> 'x-webhook-secret' = (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'webhook_secret' LIMIT 1)
      AND NOT (q.headers ? 'Authorization')
      AND convert_from(q.body, 'UTF8')::jsonb -> 'record' ->> 'id' = '60000000-0000-4000-8000-000000000001'
  ),
  'PUSH-04: request targets send-push with the Vault webhook secret, no JWT, notification id in body');

INSERT INTO public.notifications (id, user_id, type)
VALUES ('60000000-0000-4000-8000-000000000002', 'b0000000-0000-4000-8000-00000000000b', 'EXPENSE_CREATED');
SELECT is(_t.queued_for(ARRAY['60000000-0000-4000-8000-000000000002']::uuid[]), 0::bigint,
  'PUSH-05: recipient without push tokens → no HTTP call');

SELECT * FROM finish();
ROLLBACK;
