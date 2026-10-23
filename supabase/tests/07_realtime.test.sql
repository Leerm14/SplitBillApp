-- ============================================================
-- Realtime (pgTAP) — migration 0013
--   RT-01..05  các bảng app nghe thay đổi nằm trong publication supabase_realtime
--   RT-06      không đưa bảng hồ sơ / bảng nhạy cảm vào publication
-- ============================================================

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;

SELECT no_plan();

SELECT ok(
  EXISTS (SELECT 1 FROM pg_publication_tables
           WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = t),
  'RT: public.' || t || ' có trong supabase_realtime'
)
FROM unnest(ARRAY['notifications', 'expenses', 'payments', 'group_members', 'groups']) AS t;

SELECT ok(
  NOT EXISTS (SELECT 1 FROM pg_publication_tables
               WHERE pubname = 'supabase_realtime' AND schemaname = 'public'
                 AND tablename IN ('profiles', 'push_tokens', 'payment_handles', 'activity_logs')),
  'RT-06: không phát hồ sơ, push token, phương thức thanh toán, nhật ký qua Realtime'
);

SELECT * FROM finish();
ROLLBACK;
