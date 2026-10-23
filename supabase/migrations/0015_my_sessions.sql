-- ============================================================
-- Migration 0015: Thiết bị đang đăng nhập
-- Màn Bảo mật liệt kê các phiên đăng nhập (auth.sessions) của chính người dùng và cho đăng xuất
-- từng thiết bị. Client không đọc được schema auth → hai RPC SECURITY DEFINER, chỉ trả phiên của
-- người gọi. Chạy lại được (CREATE OR REPLACE).
--
-- Ghi chú: xóa một phiên xóa luôn refresh token của nó (khóa ngoại ON DELETE CASCADE trong auth),
-- nên thiết bị đó không làm mới được phiên nữa; access token đang cầm vẫn dùng được tới khi hết hạn
-- (mặc định 1 giờ).
-- ============================================================

BEGIN;

-- Đọc cột qua to_jsonb: user_agent / ip / refreshed_at có ở GoTrue mới; bản cũ thiếu cột thì trả NULL
-- thay vì lỗi biên dịch hàm.
CREATE OR REPLACE FUNCTION public.list_my_sessions()
RETURNS TABLE (
  id UUID,
  created_at TIMESTAMPTZ,
  last_active_at TIMESTAMPTZ,
  user_agent TEXT,
  ip TEXT,
  is_current BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = ''
STABLE
AS $$
DECLARE
  _caller UUID := public.assert_authenticated();
  _current TEXT := auth.jwt() ->> 'session_id';
BEGIN
  RETURN QUERY
  SELECT
    s.id,
    s.created_at,
    COALESCE((to_jsonb(s) ->> 'refreshed_at')::timestamptz, s.updated_at, s.created_at) AS last_active_at,
    NULLIF(to_jsonb(s) ->> 'user_agent', '') AS user_agent,
    NULLIF(to_jsonb(s) ->> 'ip', '') AS ip,
    (s.id::text = _current) AS is_current
  FROM auth.sessions s
  WHERE s.user_id = _caller
    AND (to_jsonb(s) ->> 'not_after' IS NULL OR (to_jsonb(s) ->> 'not_after')::timestamptz > now())
  ORDER BY (s.id::text = _current) DESC,
           COALESCE((to_jsonb(s) ->> 'refreshed_at')::timestamptz, s.updated_at, s.created_at) DESC NULLS LAST;
END;
$$;

CREATE OR REPLACE FUNCTION public.revoke_my_session(_session_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  _caller UUID := public.assert_authenticated();
BEGIN
  IF _session_id IS NULL THEN
    RAISE EXCEPTION 'SESSION_NOT_FOUND: Session does not exist.';
  END IF;

  -- Thiết bị đang dùng thì đăng xuất bằng nút Đăng xuất (xóa cả dữ liệu trên máy), không qua đây
  IF _session_id::text = auth.jwt() ->> 'session_id' THEN
    RAISE EXCEPTION 'CANNOT_REVOKE_CURRENT: Use sign out to end the current session.';
  END IF;

  DELETE FROM auth.sessions WHERE id = _session_id AND user_id = _caller;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'SESSION_NOT_FOUND: Session does not exist.';
  END IF;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.list_my_sessions() FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.revoke_my_session(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.list_my_sessions() TO authenticated;
GRANT EXECUTE ON FUNCTION public.revoke_my_session(UUID) TO authenticated;

COMMIT;
