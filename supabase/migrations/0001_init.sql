-- ============================================================
-- Split Bill App — Database Migration
-- Tất cả bảng, trigger, RLS, hàm RPC trong một file.
-- Chạy trong Supabase SQL Editor.
-- ============================================================

-- ============================
-- 1. BẢNG
-- ============================

-- profiles: thông tin user, tạo tự động khi đăng ký
CREATE TABLE IF NOT EXISTS public.profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  display_name TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- groups: nhóm chia tiền
CREATE TABLE IF NOT EXISTS public.groups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  owner_id UUID NOT NULL REFERENCES public.profiles(id),
  invite_code TEXT NOT NULL UNIQUE DEFAULT upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8)),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- group_members: quan hệ N-N giữa user và group
CREATE TABLE IF NOT EXISTS public.group_members (
  group_id UUID NOT NULL REFERENCES public.groups(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'member')),
  joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (group_id, user_id)
);

-- expenses: khoản chi
CREATE TABLE IF NOT EXISTS public.expenses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id UUID NOT NULL REFERENCES public.groups(id) ON DELETE CASCADE,
  paid_by UUID NOT NULL REFERENCES public.profiles(id),
  amount BIGINT NOT NULL CHECK (amount > 0),
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'CANCELLED')),
  created_by UUID NOT NULL REFERENCES public.profiles(id),
  idempotency_key TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- expense_shares: phần chia chi tiết
CREATE TABLE IF NOT EXISTS public.expense_shares (
  expense_id UUID NOT NULL REFERENCES public.expenses(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES public.profiles(id),
  amount BIGINT NOT NULL CHECK (amount >= 0),
  PRIMARY KEY (expense_id, user_id)
);

-- payments: thanh toán giữa các thành viên
CREATE TABLE IF NOT EXISTS public.payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id UUID NOT NULL REFERENCES public.groups(id) ON DELETE CASCADE,
  from_id UUID NOT NULL REFERENCES public.profiles(id),
  to_id UUID NOT NULL REFERENCES public.profiles(id),
  amount BIGINT NOT NULL CHECK (amount > 0),
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'CONFIRMED', 'REJECTED')),
  note TEXT NOT NULL DEFAULT '',
  idempotency_key TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at TIMESTAMPTZ,
  CHECK (from_id <> to_id)
);

-- ============================
-- 2. TRIGGER: tự tạo profile khi đăng ký
-- ============================

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  INSERT INTO public.profiles (id, display_name)
  VALUES (NEW.id, COALESCE(NEW.raw_user_meta_data ->> 'display_name', ''));
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- ============================
-- 3. HÀM HELPER: kiểm tra thành viên nhóm
-- ============================

CREATE OR REPLACE FUNCTION public.is_member(_group_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER SET search_path = ''
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.group_members
    WHERE group_id = _group_id AND user_id = auth.uid()
  );
$$;

-- ============================
-- 4. RLS (Row Level Security)
-- ============================

-- profiles
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can read own profile" ON public.profiles FOR SELECT USING (id = auth.uid());
CREATE POLICY "Users can update own profile" ON public.profiles FOR UPDATE USING (id = auth.uid());

-- groups
ALTER TABLE public.groups ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Members can read groups" ON public.groups FOR SELECT USING (public.is_member(id));

-- group_members
ALTER TABLE public.group_members ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Members can read group_members" ON public.group_members FOR SELECT USING (public.is_member(group_id));

-- expenses (chỉ đọc, ghi qua RPC)
ALTER TABLE public.expenses ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Members can read expenses" ON public.expenses FOR SELECT USING (public.is_member(group_id));

-- expense_shares (chỉ đọc, ghi qua RPC)
ALTER TABLE public.expense_shares ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Members can read expense_shares" ON public.expense_shares FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.expenses e
      WHERE e.id = expense_id AND public.is_member(e.group_id)
    )
  );

-- payments
ALTER TABLE public.payments ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Members can read payments" ON public.payments FOR SELECT USING (public.is_member(group_id));
CREATE POLICY "Sender can create payment" ON public.payments FOR INSERT WITH CHECK (
  from_id = auth.uid() AND public.is_member(group_id)
);

-- ============================
-- 5. HÀM RPC
-- ============================

-- 5.1 create_group: tạo nhóm, thêm người gọi làm owner
CREATE OR REPLACE FUNCTION public.create_group(_name TEXT)
RETURNS public.groups
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  _group public.groups;
BEGIN
  IF length(trim(_name)) = 0 THEN
    RAISE EXCEPTION 'Tên nhóm không được rỗng';
  END IF;

  INSERT INTO public.groups (name, owner_id)
  VALUES (trim(_name), auth.uid())
  RETURNING * INTO _group;

  INSERT INTO public.group_members (group_id, user_id, role)
  VALUES (_group.id, auth.uid(), 'owner');

  RETURN _group;
END;
$$;

-- 5.2 join_group: tham gia nhóm theo mã mời
CREATE OR REPLACE FUNCTION public.join_group(_code TEXT)
RETURNS public.groups
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  _group public.groups;
BEGIN
  SELECT * INTO _group FROM public.groups WHERE invite_code = upper(trim(_code));
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Mã mời không tồn tại';
  END IF;

  -- Đã là thành viên thì trả về nhóm luôn
  IF EXISTS (SELECT 1 FROM public.group_members WHERE group_id = _group.id AND user_id = auth.uid()) THEN
    RETURN _group;
  END IF;

  INSERT INTO public.group_members (group_id, user_id, role)
  VALUES (_group.id, auth.uid(), 'member');

  RETURN _group;
END;
$$;

-- 5.3 create_expense: ghi khoản chi và phần chia trong 1 giao dịch
CREATE OR REPLACE FUNCTION public.create_expense(
  _group_id UUID,
  _paid_by UUID,
  _amount BIGINT,
  _description TEXT,
  _shares JSONB,
  _idempotency_key TEXT
)
RETURNS public.expenses
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  _expense public.expenses;
  _share JSONB;
  _share_total BIGINT := 0;
  _share_user_id UUID;
  _share_amount BIGINT;
BEGIN
  -- Kiểm tra idempotency: trùng key thì trả bản ghi cũ
  SELECT * INTO _expense FROM public.expenses WHERE idempotency_key = _idempotency_key;
  IF FOUND THEN
    RETURN _expense;
  END IF;

  -- Kiểm tra người gọi là thành viên
  IF NOT EXISTS (SELECT 1 FROM public.group_members WHERE group_id = _group_id AND user_id = auth.uid()) THEN
    RAISE EXCEPTION 'Bạn không phải thành viên nhóm này';
  END IF;

  -- Kiểm tra người trả là thành viên
  IF NOT EXISTS (SELECT 1 FROM public.group_members WHERE group_id = _group_id AND user_id = _paid_by) THEN
    RAISE EXCEPTION 'Người trả không phải thành viên nhóm';
  END IF;

  -- Ghi khoản chi
  INSERT INTO public.expenses (group_id, paid_by, amount, description, created_by, idempotency_key)
  VALUES (_group_id, _paid_by, _amount, COALESCE(_description, ''), auth.uid(), _idempotency_key)
  RETURNING * INTO _expense;

  -- Ghi phần chia
  FOR _share IN SELECT * FROM jsonb_array_elements(_shares)
  LOOP
    _share_user_id := (_share ->> 'userId')::UUID;
    _share_amount := (_share ->> 'amount')::BIGINT;

    -- Kiểm tra người chịu là thành viên
    IF NOT EXISTS (SELECT 1 FROM public.group_members WHERE group_id = _group_id AND user_id = _share_user_id) THEN
      RAISE EXCEPTION 'Người chịu % không phải thành viên nhóm', _share_user_id;
    END IF;

    INSERT INTO public.expense_shares (expense_id, user_id, amount)
    VALUES (_expense.id, _share_user_id, _share_amount);

    _share_total := _share_total + _share_amount;
  END LOOP;

  -- Kiểm tra tổng phần chia = tổng khoản chi
  IF _share_total <> _amount THEN
    RAISE EXCEPTION 'Tổng phần chia (%) khác tổng khoản chi (%)', _share_total, _amount;
  END IF;

  RETURN _expense;
END;
$$;

-- 5.4 cancel_expense: hủy khoản chi
CREATE OR REPLACE FUNCTION public.cancel_expense(_expense_id UUID)
RETURNS public.expenses
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  _expense public.expenses;
  _group public.groups;
BEGIN
  SELECT * INTO _expense FROM public.expenses WHERE id = _expense_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Khoản chi không tồn tại';
  END IF;

  -- Đã hủy thì bỏ qua
  IF _expense.status = 'CANCELLED' THEN
    RETURN _expense;
  END IF;

  -- Chỉ người tạo hoặc chủ nhóm mới được hủy
  SELECT * INTO _group FROM public.groups WHERE id = _expense.group_id;
  IF auth.uid() <> _expense.created_by AND auth.uid() <> _group.owner_id THEN
    RAISE EXCEPTION 'Chỉ người tạo hoặc chủ nhóm mới được hủy khoản chi';
  END IF;

  UPDATE public.expenses SET status = 'CANCELLED' WHERE id = _expense_id
  RETURNING * INTO _expense;

  RETURN _expense;
END;
$$;

-- 5.5 respond_payment: xác nhận hoặc từ chối thanh toán
CREATE OR REPLACE FUNCTION public.respond_payment(_payment_id UUID, _accept BOOLEAN)
RETURNS public.payments
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  _payment public.payments;
BEGIN
  SELECT * INTO _payment FROM public.payments WHERE id = _payment_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Thanh toán không tồn tại';
  END IF;

  -- Chỉ người nhận mới được phản hồi
  IF auth.uid() <> _payment.to_id THEN
    RAISE EXCEPTION 'Chỉ người nhận mới được xác nhận hoặc từ chối';
  END IF;

  -- Chỉ khi đang PENDING
  IF _payment.status <> 'PENDING' THEN
    RAISE EXCEPTION 'Thanh toán không ở trạng thái chờ xác nhận';
  END IF;

  UPDATE public.payments
  SET status = CASE WHEN _accept THEN 'CONFIRMED' ELSE 'REJECTED' END,
      decided_at = now()
  WHERE id = _payment_id
  RETURNING * INTO _payment;

  RETURN _payment;
END;
$$;

-- ============================
-- 6. RLS cho profiles: thành viên cùng nhóm đọc được profile nhau
-- ============================
CREATE POLICY "Group members can read each others profiles" ON public.profiles FOR SELECT
  USING (
    id = auth.uid()
    OR EXISTS (
      SELECT 1 FROM public.group_members gm1
      JOIN public.group_members gm2 ON gm1.group_id = gm2.group_id
      WHERE gm1.user_id = auth.uid() AND gm2.user_id = profiles.id
    )
  );

