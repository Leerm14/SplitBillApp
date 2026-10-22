-- ============================================================
-- Migration 0006: Contacts — Bạn bè & Thông tin thanh toán
-- ============================================================

-- ============================
-- 1. BẢNG: friendships — quan hệ bạn bè
-- ============================

CREATE TABLE IF NOT EXISTS public.friendships (
  requester_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  addressee_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'ACCEPTED', 'DECLINED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  responded_at TIMESTAMPTZ,
  PRIMARY KEY (requester_id, addressee_id),
  CHECK (requester_id <> addressee_id)
);

ALTER TABLE public.friendships ENABLE ROW LEVEL SECURITY;

-- Cả hai bên đều có thể xem friendships của mình
CREATE POLICY "Users can read own friendships"
  ON public.friendships FOR SELECT
  USING (requester_id = auth.uid() OR addressee_id = auth.uid());

-- Ghi chỉ qua RPC (SECURITY DEFINER) — không cho INSERT/UPDATE/DELETE trực tiếp

-- ============================
-- 2. BẢNG: payment_handles — thông tin thanh toán
-- ============================

CREATE TABLE IF NOT EXISTS public.payment_handles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('BANK', 'EWALLET', 'OTHER')),
  display_text TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.payment_handles ENABLE ROW LEVEL SECURITY;

-- Chủ sở hữu toàn quyền CRUD
CREATE POLICY "Owner can manage own payment_handles"
  ON public.payment_handles FOR ALL
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- Thành viên cùng nhóm (active) có thể xem
CREATE POLICY "Group co-members can read payment_handles"
  ON public.payment_handles FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.group_members gm1
      JOIN public.group_members gm2 ON gm1.group_id = gm2.group_id
      WHERE gm1.user_id = auth.uid()
        AND gm2.user_id = payment_handles.user_id
        AND gm1.status = 'ACTIVE'
        AND gm2.status = 'ACTIVE'
        AND gm1.user_id <> gm2.user_id
    )
  );

-- ============================
-- 3. ALTER: notifications — thêm cột actor_id cho friend notifications
-- ============================

ALTER TABLE public.notifications
  ADD COLUMN IF NOT EXISTS actor_id UUID REFERENCES public.profiles(id) ON DELETE SET NULL;

-- ============================
-- 4. INDEXES
-- ============================

CREATE INDEX IF NOT EXISTS idx_friendships_addressee
  ON public.friendships (addressee_id, status);

CREATE INDEX IF NOT EXISTS idx_friendships_requester
  ON public.friendships (requester_id, status);

CREATE INDEX IF NOT EXISTS idx_payment_handles_user
  ON public.payment_handles (user_id);

-- idx_profiles_user_code đã tồn tại từ 0002_accounts.sql

CREATE INDEX IF NOT EXISTS idx_profiles_searchable
  ON public.profiles (display_name)
  WHERE searchable = true AND deleted_at IS NULL;

-- ============================
-- 5. RPC: send_friend_request — gửi lời mời kết bạn
-- ============================

CREATE OR REPLACE FUNCTION public.send_friend_request(_addressee_id UUID)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  _caller UUID := auth.uid();
  _existing RECORD;
BEGIN
  -- Không thể tự gửi cho chính mình
  IF _caller = _addressee_id THEN
    RAISE EXCEPTION 'Không thể gửi lời mời kết bạn cho chính mình.';
  END IF;

  -- Kiểm tra người nhận tồn tại
  IF NOT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = _addressee_id AND deleted_at IS NULL
  ) THEN
    RAISE EXCEPTION 'Người dùng không tồn tại.';
  END IF;

  -- Kiểm tra friendship đã tồn tại (cả hai chiều)
  SELECT status, responded_at INTO _existing
  FROM public.friendships
  WHERE (requester_id = _caller AND addressee_id = _addressee_id)
     OR (requester_id = _addressee_id AND addressee_id = _caller)
  LIMIT 1;

  IF FOUND THEN
    IF _existing.status = 'PENDING' THEN
      RAISE EXCEPTION 'Lời mời kết bạn đang chờ xử lý.';
    END IF;

    IF _existing.status = 'ACCEPTED' THEN
      RAISE EXCEPTION 'Hai bạn đã là bạn bè rồi.';
    END IF;

    -- DECLINED: kiểm tra đã quá 7 ngày chưa
    IF _existing.status = 'DECLINED' THEN
      IF _existing.responded_at IS NOT NULL
         AND _existing.responded_at > now() - INTERVAL '7 days' THEN
        RAISE EXCEPTION 'Lời mời đã bị từ chối. Vui lòng thử lại sau 7 ngày.';
      END IF;

      -- Xoá bản ghi cũ để tạo mới
      DELETE FROM public.friendships
      WHERE (requester_id = _caller AND addressee_id = _addressee_id)
         OR (requester_id = _addressee_id AND addressee_id = _caller);
    END IF;
  END IF;

  -- Tạo friendship mới
  INSERT INTO public.friendships (requester_id, addressee_id, status)
  VALUES (_caller, _addressee_id, 'PENDING');

  -- Tạo thông báo cho người nhận
  INSERT INTO public.notifications (user_id, type, actor_id)
  VALUES (_addressee_id, 'FRIEND_REQUEST', _caller);
END;
$$;

-- ============================
-- 6. RPC: respond_friend_request — phản hồi lời mời kết bạn
-- ============================

CREATE OR REPLACE FUNCTION public.respond_friend_request(
  _requester_id UUID,
  _accept BOOLEAN
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  _caller UUID := auth.uid();
  _friendship RECORD;
BEGIN
  -- Caller phải là addressee
  SELECT * INTO _friendship
  FROM public.friendships
  WHERE requester_id = _requester_id
    AND addressee_id = _caller
    AND status = 'PENDING';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Không tìm thấy lời mời kết bạn đang chờ xử lý.';
  END IF;

  IF _accept THEN
    -- Chấp nhận
    UPDATE public.friendships
    SET status = 'ACCEPTED', responded_at = now()
    WHERE requester_id = _requester_id
      AND addressee_id = _caller;

    -- Thông báo cho người gửi
    INSERT INTO public.notifications (user_id, type, actor_id)
    VALUES (_requester_id, 'FRIEND_ACCEPTED', _caller);
  ELSE
    -- Từ chối
    UPDATE public.friendships
    SET status = 'DECLINED', responded_at = now()
    WHERE requester_id = _requester_id
      AND addressee_id = _caller;

    -- Thông báo cho người gửi
    INSERT INTO public.notifications (user_id, type, actor_id)
    VALUES (_requester_id, 'FRIEND_DECLINED', _caller);
  END IF;
END;
$$;

-- ============================
-- 7. RPC: search_users — tìm kiếm người dùng
-- ============================

CREATE OR REPLACE FUNCTION public.search_users(_query TEXT)
RETURNS TABLE (
  id UUID,
  display_name TEXT,
  user_code TEXT,
  avatar_path TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  _caller UUID := auth.uid();
  _sanitized TEXT;
BEGIN
  -- Chuẩn hoá query
  _sanitized := trim(_query);

  IF _sanitized = '' OR _sanitized IS NULL THEN
    RAISE EXCEPTION 'Từ khoá tìm kiếm không được để trống.';
  END IF;

  RETURN QUERY
  SELECT p.id, p.display_name, p.user_code, p.avatar_path
  FROM public.profiles p
  WHERE p.searchable = true
    AND p.deleted_at IS NULL
    AND p.id <> _caller
    AND (
      p.display_name ILIKE '%' || _sanitized || '%'
      OR p.user_code = _sanitized
    )
  ORDER BY
    -- Ưu tiên kết quả khớp chính xác user_code
    CASE WHEN p.user_code = _sanitized THEN 0 ELSE 1 END,
    p.display_name
  LIMIT 20;
END;
$$;

-- ============================
-- 8. RPC: unfriend — huỷ kết bạn
-- ============================

CREATE OR REPLACE FUNCTION public.unfriend(_friend_id UUID)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  _caller UUID := auth.uid();
  _deleted INT;
BEGIN
  -- Xoá friendship nếu caller là một trong hai bên
  DELETE FROM public.friendships
  WHERE (requester_id = _caller AND addressee_id = _friend_id)
     OR (requester_id = _friend_id AND addressee_id = _caller);

  GET DIAGNOSTICS _deleted = ROW_COUNT;

  IF _deleted = 0 THEN
    RAISE EXCEPTION 'Không tìm thấy quan hệ bạn bè với người dùng này.';
  END IF;
END;
$$;
