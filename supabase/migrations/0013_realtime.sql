-- ============================================================
-- Migration 0013: Realtime
-- Bật Supabase Realtime (postgres_changes) cho các bảng app cần cập nhật tức thì.
-- Realtime kiểm tra RLS SELECT của từng người nghe, nên chỉ thành viên nhóm nhận được
-- thay đổi của nhóm đó và mỗi người chỉ nhận thông báo của chính mình.
-- Chạy lại được: chỉ thêm bảng chưa có trong publication.
-- ============================================================

BEGIN;

DO $$
DECLARE
  _t TEXT;
BEGIN
  -- Project Supabase luôn có sẵn publication này; tạo khi chạy trên Postgres thường (test cục bộ)
  IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    CREATE PUBLICATION supabase_realtime;
  END IF;

  FOREACH _t IN ARRAY ARRAY['notifications', 'expenses', 'payments', 'group_members', 'groups']
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
       WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = _t
    ) THEN
      EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', _t);
    END IF;
  END LOOP;
END $$;

COMMIT;
