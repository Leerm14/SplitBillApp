-- ============================================================
-- Migration 0009: Profile visibility
-- Fixes: NEW-01 (0007 chỉ cho đọc hồ sơ của chính mình → tên thành viên
--        khác trả null, màn nhóm lỗi), NEW-05 (view public_profiles bỏ qua RLS)
-- Giữ yêu cầu SEC-04: người khác chỉ thấy display_name, user_code, avatar_path.
-- ============================================================

BEGIN;

-- ============================================================
-- PART 1: Ai được xem hồ sơ của ai
-- ============================================================

-- Chính mình; người chung nhóm (người xem đang hoặc đã ở trong nhóm, người được
-- xem ở bất kỳ trạng thái nào — để lịch sử vẫn hiện tên người đã rời);
-- hai bên của một lời mời kết bạn.
-- SECURITY DEFINER để không bị RLS của group_members (chỉ ACTIVE) chặn.
CREATE OR REPLACE FUNCTION public.can_view_profile(_profile_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER SET search_path = ''
STABLE
AS $$
  SELECT _profile_id = auth.uid()
    OR EXISTS (
      SELECT 1
      FROM public.group_members me
      JOIN public.group_members other ON other.group_id = me.group_id
      WHERE me.user_id = auth.uid()
        AND me.status IN ('ACTIVE', 'LEFT')
        AND other.user_id = _profile_id
    )
    OR EXISTS (
      SELECT 1
      FROM public.friendships f
      WHERE (f.requester_id = auth.uid() AND f.addressee_id = _profile_id)
         OR (f.addressee_id = auth.uid() AND f.requester_id = _profile_id)
    );
$$;

DROP POLICY IF EXISTS "Users can read own profile" ON public.profiles;
DROP POLICY IF EXISTS "Users can read related profiles" ON public.profiles;
CREATE POLICY "Users can read related profiles"
  ON public.profiles FOR SELECT
  USING (public.can_view_profile(id));

-- ============================================================
-- PART 2: Giới hạn cột (SEC-04)
-- ============================================================

-- RLS lọc dòng, quyền cột lọc cột: qua API chỉ đọc được 4 cột công khai.
-- Các cột riêng (searchable, deleted_at, created_at, ...) của chính mình
-- đọc qua RPC get_my_profile.
REVOKE SELECT ON public.profiles FROM anon, authenticated;
GRANT SELECT (id, display_name, user_code, avatar_path) ON public.profiles TO authenticated;

CREATE OR REPLACE FUNCTION public.get_my_profile()
RETURNS public.profiles
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = ''
STABLE
AS $$
DECLARE
  _caller UUID := public.assert_authenticated();
  _profile public.profiles;
BEGIN
  SELECT * INTO _profile FROM public.profiles WHERE id = _caller;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PROFILE_NOT_FOUND: Profile does not exist.';
  END IF;
  RETURN _profile;
END;
$$;

-- ============================================================
-- PART 3: Bỏ view public_profiles (NEW-05)
-- ============================================================

-- View tạo ở 0007 chạy bằng quyền chủ view nên bỏ qua RLS và liệt kê mọi người
-- dùng, kể cả searchable = false. App không dùng view này.
DROP VIEW IF EXISTS public.public_profiles;

-- ============================================================
-- PART 4: Quyền gọi hàm
-- ============================================================

-- Hàm tạo sau REVOKE toàn cục của 0007 mặc định có quyền EXECUTE cho PUBLIC.
REVOKE EXECUTE ON FUNCTION public.can_view_profile(UUID) FROM anon, public;
REVOKE EXECUTE ON FUNCTION public.get_my_profile() FROM anon, public;
GRANT EXECUTE ON FUNCTION public.can_view_profile(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_my_profile() TO authenticated;

COMMIT;
