-- ============================================================
-- Phase 1: Accounts — Mở rộng schema cho quản lý tài khoản,
-- nhóm nâng cao, hoạt động, thông báo, push token.
-- ============================================================

BEGIN;

-- ============================
-- 1. HÀM HELPER: tạo mã user_code 8 ký tự
-- ============================

-- generate_user_code: tạo mã 8 ký tự (A-Z, 0-9), tự retry khi bị trùng
CREATE OR REPLACE FUNCTION public.generate_user_code()
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  _code TEXT;
  _exists BOOLEAN;
  _attempts INT := 0;
  _chars TEXT := 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  _i INT;
BEGIN
  LOOP
    _code := '';
    FOR _i IN 1..8 LOOP
      _code := _code || substr(_chars, floor(random() * 36 + 1)::int, 1);
    END LOOP;

    SELECT EXISTS (
      SELECT 1 FROM public.profiles WHERE user_code = _code
    ) INTO _exists;

    IF NOT _exists THEN
      RETURN _code;
    END IF;

    _attempts := _attempts + 1;
    IF _attempts >= 100 THEN
      RAISE EXCEPTION 'Không thể tạo mã user_code sau 100 lần thử';
    END IF;
  END LOOP;
END;
$$;

-- ============================
-- 2. PROFILES: thêm cột mới
-- ============================

-- user_code: mã 8 ký tự để tìm bạn bè
ALTER TABLE public.profiles ADD COLUMN user_code TEXT UNIQUE;
ALTER TABLE public.profiles ADD COLUMN avatar_path TEXT;
ALTER TABLE public.profiles ADD COLUMN searchable BOOLEAN DEFAULT true;
ALTER TABLE public.profiles ADD COLUMN deleted_at TIMESTAMPTZ;

-- Backfill: tạo user_code cho các profile đã tồn tại
UPDATE public.profiles
SET user_code = public.generate_user_code()
WHERE user_code IS NULL;

-- Sau khi backfill, bắt buộc NOT NULL
ALTER TABLE public.profiles ALTER COLUMN user_code SET NOT NULL;
ALTER TABLE public.profiles ALTER COLUMN user_code SET DEFAULT public.generate_user_code();

-- ============================
-- 3. CẬP NHẬT TRIGGER: thêm user_code khi đăng ký
-- ============================

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  INSERT INTO public.profiles (id, display_name, user_code)
  VALUES (
    NEW.id,
    COALESCE(NEW.raw_user_meta_data ->> 'display_name', ''),
    public.generate_user_code()
  );
  RETURN NEW;
END;
$$;

-- ============================
-- 4. GROUPS: thêm cột mới
-- ============================

ALTER TABLE public.groups ADD COLUMN description TEXT DEFAULT '';
ALTER TABLE public.groups ADD COLUMN avatar_path TEXT;
-- BR-09: tối ưu nợ
ALTER TABLE public.groups ADD COLUMN simplify_debts BOOLEAN NOT NULL DEFAULT true;
-- Trạng thái nhóm (ACTIVE / CLOSED)
ALTER TABLE public.groups ADD COLUMN status TEXT NOT NULL DEFAULT 'ACTIVE'
  CHECK (status IN ('ACTIVE', 'CLOSED'));

-- ============================
-- 5. GROUP_MEMBERS: thêm cột trạng thái (soft delete)
-- ============================

-- Trạng thái thành viên: ACTIVE / LEFT / REMOVED
ALTER TABLE public.group_members ADD COLUMN status TEXT NOT NULL DEFAULT 'ACTIVE'
  CHECK (status IN ('ACTIVE', 'LEFT', 'REMOVED'));
ALTER TABLE public.group_members ADD COLUMN left_at TIMESTAMPTZ;

-- ============================
-- 6. EXPENSES: thêm cột mới
-- ============================

ALTER TABLE public.expenses ADD COLUMN note TEXT DEFAULT '';
-- Phương thức chia: EQUAL / PERCENT / EXACT
ALTER TABLE public.expenses ADD COLUMN split_method TEXT NOT NULL DEFAULT 'EQUAL'
  CHECK (split_method IN ('EQUAL', 'PERCENT', 'EXACT'));
ALTER TABLE public.expenses ADD COLUMN receipt_path TEXT;
-- Phiên bản (optimistic locking)
ALTER TABLE public.expenses ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE public.expenses ADD COLUMN updated_at TIMESTAMPTZ DEFAULT now();
ALTER TABLE public.expenses ADD COLUMN cancelled_at TIMESTAMPTZ;

-- ============================
-- 7. EXPENSE_SHARES: thêm cột phần trăm (basis points)
-- ============================

-- 10000 bp = 100%
ALTER TABLE public.expense_shares ADD COLUMN percent_bp INTEGER;

-- ============================
-- 8. PAYMENTS: mở rộng CHECK cho status, thêm cột
-- ============================

-- Xóa constraint cũ, thêm constraint mới bao gồm DISPUTED và CANCELLED
ALTER TABLE public.payments DROP CONSTRAINT IF EXISTS payments_status_check;
ALTER TABLE public.payments ADD CONSTRAINT payments_status_check
  CHECK (status IN ('PENDING', 'CONFIRMED', 'REJECTED', 'DISPUTED', 'CANCELLED'));

-- Phương thức thanh toán
ALTER TABLE public.payments ADD COLUMN method TEXT DEFAULT 'CASH'
  CHECK (method IN ('CASH', 'BANK', 'OTHER'));
-- Lý do từ chối / tranh chấp
ALTER TABLE public.payments ADD COLUMN reason TEXT DEFAULT '';

-- ============================
-- 9. CẬP NHẬT is_member(): chỉ đếm thành viên ACTIVE
-- ============================

CREATE OR REPLACE FUNCTION public.is_member(_group_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER SET search_path = ''
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.group_members
    WHERE group_id = _group_id
      AND user_id = auth.uid()
      AND status = 'ACTIVE'
  );
$$;

-- ============================
-- 10. VIEW: group_balances — tổng hợp số dư theo nhóm
-- ============================

CREATE OR REPLACE VIEW public.group_balances
WITH (security_invoker = true)
AS
SELECT
  gm.group_id,
  gm.user_id,

  -- Tổng đã trả (là payer trong expense ACTIVE)
  COALESCE(paid.total, 0) AS paid,

  -- Tổng nợ (phần chia trong expense ACTIVE)
  COALESCE(owed.total, 0) AS owed,

  -- Thanh toán đã xác nhận (gửi đi)
  COALESCE(sent_c.total, 0) AS sent_confirmed,

  -- Thanh toán đã xác nhận (nhận về)
  COALESCE(recv_c.total, 0) AS received_confirmed,

  -- Thanh toán đang chờ (gửi đi)
  COALESCE(sent_p.total, 0) AS pending_sent,

  -- Thanh toán đang chờ (nhận về)
  COALESCE(recv_p.total, 0) AS pending_received,

  -- Số dư chính thức = paid - owed + sent_confirmed - received_confirmed
  (COALESCE(paid.total, 0)
    - COALESCE(owed.total, 0)
    + COALESCE(sent_c.total, 0)
    - COALESCE(recv_c.total, 0)
  ) AS official_balance,

  -- Số dư dự kiến = official_balance + pending_sent - pending_received
  (COALESCE(paid.total, 0)
    - COALESCE(owed.total, 0)
    + COALESCE(sent_c.total, 0)
    - COALESCE(recv_c.total, 0)
    + COALESCE(sent_p.total, 0)
    - COALESCE(recv_p.total, 0)
  ) AS projected_balance

FROM public.group_members gm

-- Tổng đã trả
LEFT JOIN LATERAL (
  SELECT SUM(e.amount) AS total
  FROM public.expenses e
  WHERE e.group_id = gm.group_id
    AND e.paid_by = gm.user_id
    AND e.status = 'ACTIVE'
) paid ON true

-- Tổng nợ (phần chia)
LEFT JOIN LATERAL (
  SELECT SUM(es.amount) AS total
  FROM public.expense_shares es
  JOIN public.expenses e ON e.id = es.expense_id
  WHERE e.group_id = gm.group_id
    AND es.user_id = gm.user_id
    AND e.status = 'ACTIVE'
) owed ON true

-- Thanh toán đã xác nhận (gửi)
LEFT JOIN LATERAL (
  SELECT SUM(p.amount) AS total
  FROM public.payments p
  WHERE p.group_id = gm.group_id
    AND p.from_id = gm.user_id
    AND p.status = 'CONFIRMED'
) sent_c ON true

-- Thanh toán đã xác nhận (nhận)
LEFT JOIN LATERAL (
  SELECT SUM(p.amount) AS total
  FROM public.payments p
  WHERE p.group_id = gm.group_id
    AND p.to_id = gm.user_id
    AND p.status = 'CONFIRMED'
) recv_c ON true

-- Thanh toán đang chờ (gửi)
LEFT JOIN LATERAL (
  SELECT SUM(p.amount) AS total
  FROM public.payments p
  WHERE p.group_id = gm.group_id
    AND p.from_id = gm.user_id
    AND p.status = 'PENDING'
) sent_p ON true

-- Thanh toán đang chờ (nhận)
LEFT JOIN LATERAL (
  SELECT SUM(p.amount) AS total
  FROM public.payments p
  WHERE p.group_id = gm.group_id
    AND p.to_id = gm.user_id
    AND p.status = 'PENDING'
) recv_p ON true

WHERE gm.status = 'ACTIVE';

-- ============================
-- 11. BẢNG: activity_logs — nhật ký hoạt động
-- ============================

CREATE TABLE IF NOT EXISTS public.activity_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id UUID REFERENCES public.groups(id) ON DELETE CASCADE,
  actor_id UUID NOT NULL REFERENCES public.profiles(id),
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id UUID,
  before JSONB,
  after JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.activity_logs ENABLE ROW LEVEL SECURITY;

-- Thành viên nhóm được đọc log
CREATE POLICY "Members can read activity_logs"
  ON public.activity_logs FOR SELECT
  USING (public.is_member(group_id));

-- Chỉ chèn qua RPC (SECURITY DEFINER), không cho client INSERT trực tiếp
-- Không tạo policy INSERT cho authenticated users

-- ============================
-- 12. BẢNG: notifications — thông báo
-- ============================

CREATE TABLE IF NOT EXISTS public.notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  group_id UUID REFERENCES public.groups(id) ON DELETE CASCADE,
  expense_id UUID REFERENCES public.expenses(id) ON DELETE CASCADE,
  payment_id UUID REFERENCES public.payments(id) ON DELETE CASCADE,
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;

-- User chỉ đọc thông báo của mình
CREATE POLICY "Users can read own notifications"
  ON public.notifications FOR SELECT
  USING (user_id = auth.uid());

-- User có thể cập nhật (đánh dấu đã đọc) thông báo của mình
CREATE POLICY "Users can update own notifications"
  ON public.notifications FOR UPDATE
  USING (user_id = auth.uid());

-- ============================
-- 13. BẢNG: push_tokens — token đẩy thông báo (Expo)
-- ============================

CREATE TABLE IF NOT EXISTS public.push_tokens (
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  expo_token TEXT NOT NULL,
  platform TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, expo_token)
);

ALTER TABLE public.push_tokens ENABLE ROW LEVEL SECURITY;

-- User quản lý token của mình
CREATE POLICY "Users can read own push_tokens"
  ON public.push_tokens FOR SELECT
  USING (user_id = auth.uid());

CREATE POLICY "Users can insert own push_tokens"
  ON public.push_tokens FOR INSERT
  WITH CHECK (user_id = auth.uid());

CREATE POLICY "Users can update own push_tokens"
  ON public.push_tokens FOR UPDATE
  USING (user_id = auth.uid());

CREATE POLICY "Users can delete own push_tokens"
  ON public.push_tokens FOR DELETE
  USING (user_id = auth.uid());

-- ============================
-- 14. STORAGE: bucket avatars (public)
-- ============================

-- Tạo bucket avatars (public để hiển thị ảnh đại diện)
INSERT INTO storage.buckets (id, name, public)
VALUES ('avatars', 'avatars', true)
ON CONFLICT (id) DO NOTHING;

-- User được upload vào folder của mình: avatars/<user_id>/...
CREATE POLICY "Users can upload own avatar"
  ON storage.objects FOR INSERT
  WITH CHECK (
    bucket_id = 'avatars'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

CREATE POLICY "Users can update own avatar"
  ON storage.objects FOR UPDATE
  USING (
    bucket_id = 'avatars'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

CREATE POLICY "Users can delete own avatar"
  ON storage.objects FOR DELETE
  USING (
    bucket_id = 'avatars'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

-- Ai cũng được đọc avatar (bucket public)
CREATE POLICY "Anyone can read avatars"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'avatars');

-- ============================
-- 15. INDEX bổ sung cho hiệu năng
-- ============================

CREATE INDEX IF NOT EXISTS idx_profiles_user_code ON public.profiles (user_code);
CREATE INDEX IF NOT EXISTS idx_notifications_user_id ON public.notifications (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_activity_logs_group_id ON public.activity_logs (group_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_group_members_status ON public.group_members (group_id, status);

COMMIT;
