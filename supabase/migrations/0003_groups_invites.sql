-- ============================================================
-- Phase 2: Groups & Members — Lời mời nhóm, quản lý thành viên,
-- chuyển quyền, rời nhóm, đóng nhóm.
-- ============================================================

BEGIN;

-- ============================
-- 1. BẢNG: group_invites — lời mời vào nhóm
-- ============================

CREATE TABLE IF NOT EXISTS public.group_invites (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id UUID NOT NULL REFERENCES public.groups(id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE,             -- mã mời 12 ký tự
  invited_user_id UUID REFERENCES public.profiles(id),  -- NULL = mời mở
  created_by UUID NOT NULL REFERENCES public.profiles(id),
  expires_at TIMESTAMPTZ NOT NULL,
  max_uses INTEGER NOT NULL DEFAULT 1,
  used_count INTEGER NOT NULL DEFAULT 0,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.group_invites ENABLE ROW LEVEL SECURITY;

-- Thành viên ACTIVE được đọc lời mời của nhóm mình
CREATE POLICY "Members can read group_invites"
  ON public.group_invites FOR SELECT
  USING (public.is_member(group_id));

-- Chỉ chèn / cập nhật qua RPC (SECURITY DEFINER)

CREATE INDEX IF NOT EXISTS idx_group_invites_token ON public.group_invites (token);
CREATE INDEX IF NOT EXISTS idx_group_invites_group_id ON public.group_invites (group_id);

-- ============================
-- 2. RPC: update_group — cập nhật thông tin nhóm
-- ============================

CREATE OR REPLACE FUNCTION public.update_group(
  _group_id UUID,
  _name TEXT,
  _description TEXT,
  _simplify_debts BOOLEAN
)
RETURNS public.groups
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  _group public.groups;
  _old_name TEXT;
  _old_desc TEXT;
  _old_simplify BOOLEAN;
BEGIN
  -- Lấy nhóm
  SELECT * INTO _group FROM public.groups WHERE id = _group_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Nhóm không tồn tại';
  END IF;

  -- Chỉ chủ nhóm mới được cập nhật
  IF _group.owner_id <> auth.uid() THEN
    RAISE EXCEPTION 'Chỉ chủ nhóm mới được cập nhật thông tin nhóm';
  END IF;

  -- Nhóm phải đang ACTIVE
  IF _group.status <> 'ACTIVE' THEN
    RAISE EXCEPTION 'Nhóm đã đóng, không thể cập nhật';
  END IF;

  -- Validate tên
  IF length(trim(_name)) = 0 THEN
    RAISE EXCEPTION 'Tên nhóm không được rỗng';
  END IF;

  -- Lưu giá trị cũ để ghi log
  _old_name := _group.name;
  _old_desc := _group.description;
  _old_simplify := _group.simplify_debts;

  -- Cập nhật
  UPDATE public.groups
  SET name = trim(_name),
      description = COALESCE(_description, ''),
      simplify_debts = _simplify_debts
  WHERE id = _group_id
  RETURNING * INTO _group;

  -- Ghi activity log
  INSERT INTO public.activity_logs (group_id, actor_id, action, entity_type, entity_id, before, after)
  VALUES (
    _group_id,
    auth.uid(),
    'UPDATE',
    'GROUP',
    _group_id,
    jsonb_build_object('name', _old_name, 'description', _old_desc, 'simplify_debts', _old_simplify),
    jsonb_build_object('name', _group.name, 'description', _group.description, 'simplify_debts', _group.simplify_debts)
  );

  RETURN _group;
END;
$$;

-- ============================
-- 3. RPC: create_invite — tạo lời mời vào nhóm
-- ============================

CREATE OR REPLACE FUNCTION public.create_invite(
  _group_id UUID,
  _invited_user_id UUID DEFAULT NULL,
  _expires_hours INTEGER DEFAULT 72,
  _max_uses INTEGER DEFAULT 1
)
RETURNS public.group_invites
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  _group public.groups;
  _invite public.group_invites;
  _token TEXT;
  _chars TEXT := 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  _i INT;
  _attempts INT := 0;
  _exists BOOLEAN;
BEGIN
  -- Kiểm tra nhóm
  SELECT * INTO _group FROM public.groups WHERE id = _group_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Nhóm không tồn tại';
  END IF;

  -- Nhóm phải đang ACTIVE
  IF _group.status <> 'ACTIVE' THEN
    RAISE EXCEPTION 'Nhóm đã đóng, không thể tạo lời mời';
  END IF;

  -- Người gọi phải là thành viên ACTIVE
  IF NOT EXISTS (
    SELECT 1 FROM public.group_members
    WHERE group_id = _group_id AND user_id = auth.uid() AND status = 'ACTIVE'
  ) THEN
    RAISE EXCEPTION 'Bạn không phải thành viên nhóm này';
  END IF;

  -- Tạo token 12 ký tự, retry nếu trùng
  LOOP
    _token := '';
    FOR _i IN 1..12 LOOP
      _token := _token || substr(_chars, floor(random() * 62 + 1)::int, 1);
    END LOOP;

    SELECT EXISTS (
      SELECT 1 FROM public.group_invites WHERE token = _token
    ) INTO _exists;

    IF NOT _exists THEN
      EXIT;
    END IF;

    _attempts := _attempts + 1;
    IF _attempts >= 100 THEN
      RAISE EXCEPTION 'Không thể tạo token sau 100 lần thử';
    END IF;
  END LOOP;

  -- Tạo lời mời
  INSERT INTO public.group_invites (group_id, token, invited_user_id, created_by, expires_at, max_uses)
  VALUES (
    _group_id,
    _token,
    _invited_user_id,
    auth.uid(),
    now() + (_expires_hours || ' hours')::interval,
    _max_uses
  )
  RETURNING * INTO _invite;

  -- Ghi activity log
  INSERT INTO public.activity_logs (group_id, actor_id, action, entity_type, entity_id, after)
  VALUES (
    _group_id,
    auth.uid(),
    'CREATE',
    'INVITE',
    _invite.id,
    jsonb_build_object(
      'invited_user_id', _invited_user_id,
      'max_uses', _max_uses,
      'expires_hours', _expires_hours
    )
  );

  RETURN _invite;
END;
$$;

-- ============================
-- 4. RPC: accept_invite — chấp nhận lời mời
-- ============================

CREATE OR REPLACE FUNCTION public.accept_invite(_token TEXT)
RETURNS public.groups
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  _invite public.group_invites;
  _group public.groups;
  _existing_member public.group_members;
  _caller UUID := auth.uid();
BEGIN
  -- Tìm lời mời theo token
  SELECT * INTO _invite FROM public.group_invites WHERE token = _token;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Lời mời không tồn tại';
  END IF;

  -- Kiểm tra đã bị thu hồi
  IF _invite.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'Lời mời đã bị thu hồi';
  END IF;

  -- Kiểm tra hết hạn
  IF _invite.expires_at < now() THEN
    RAISE EXCEPTION 'Lời mời đã hết hạn';
  END IF;

  -- Kiểm tra số lần sử dụng
  IF _invite.used_count >= _invite.max_uses THEN
    RAISE EXCEPTION 'Lời mời đã hết lượt sử dụng';
  END IF;

  -- Nếu là lời mời nhắm đến người cụ thể, kiểm tra caller
  IF _invite.invited_user_id IS NOT NULL AND _invite.invited_user_id <> _caller THEN
    RAISE EXCEPTION 'Lời mời này không dành cho bạn';
  END IF;

  -- Lấy nhóm
  SELECT * INTO _group FROM public.groups WHERE id = _invite.group_id;

  -- Kiểm tra nhóm phải ACTIVE
  IF _group.status <> 'ACTIVE' THEN
    RAISE EXCEPTION 'Nhóm đã đóng, không thể tham gia';
  END IF;

  -- Kiểm tra nếu đã là thành viên
  SELECT * INTO _existing_member
  FROM public.group_members
  WHERE group_id = _invite.group_id AND user_id = _caller;

  IF FOUND THEN
    -- Đã là thành viên ACTIVE → trả về nhóm (idempotent)
    IF _existing_member.status = 'ACTIVE' THEN
      RETURN _group;
    END IF;

    -- Từng là thành viên (LEFT/REMOVED) → kích hoạt lại
    UPDATE public.group_members
    SET status = 'ACTIVE', left_at = NULL, joined_at = now()
    WHERE group_id = _invite.group_id AND user_id = _caller;
  ELSE
    -- Thành viên mới
    INSERT INTO public.group_members (group_id, user_id, role)
    VALUES (_invite.group_id, _caller, 'member');
  END IF;

  -- Tăng số lần đã dùng
  UPDATE public.group_invites
  SET used_count = used_count + 1
  WHERE id = _invite.id;

  -- Thông báo cho chủ nhóm
  INSERT INTO public.notifications (user_id, type, group_id)
  VALUES (_group.owner_id, 'MEMBER_JOINED', _group.id);

  -- Ghi activity log
  INSERT INTO public.activity_logs (group_id, actor_id, action, entity_type, entity_id, after)
  VALUES (
    _group.id,
    _caller,
    'ACCEPT',
    'INVITE',
    _invite.id,
    jsonb_build_object('user_id', _caller)
  );

  RETURN _group;
END;
$$;

-- ============================
-- 5. RPC: revoke_invite — thu hồi lời mời
-- ============================

CREATE OR REPLACE FUNCTION public.revoke_invite(_invite_id UUID)
RETURNS public.group_invites
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  _invite public.group_invites;
  _group public.groups;
BEGIN
  -- Lấy lời mời
  SELECT * INTO _invite FROM public.group_invites WHERE id = _invite_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Lời mời không tồn tại';
  END IF;

  -- Đã thu hồi thì bỏ qua (idempotent)
  IF _invite.revoked_at IS NOT NULL THEN
    RETURN _invite;
  END IF;

  -- Lấy nhóm
  SELECT * INTO _group FROM public.groups WHERE id = _invite.group_id;

  -- Chỉ người tạo hoặc chủ nhóm mới được thu hồi
  IF auth.uid() <> _invite.created_by AND auth.uid() <> _group.owner_id THEN
    RAISE EXCEPTION 'Chỉ người tạo hoặc chủ nhóm mới được thu hồi lời mời';
  END IF;

  -- Thu hồi
  UPDATE public.group_invites
  SET revoked_at = now()
  WHERE id = _invite_id
  RETURNING * INTO _invite;

  RETURN _invite;
END;
$$;

-- ============================
-- 6. RPC: remove_member — xóa thành viên khỏi nhóm
-- ============================

CREATE OR REPLACE FUNCTION public.remove_member(_group_id UUID, _user_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  _group public.groups;
  _balance BIGINT;
  _has_pending BOOLEAN;
BEGIN
  -- Lấy nhóm
  SELECT * INTO _group FROM public.groups WHERE id = _group_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Nhóm không tồn tại';
  END IF;

  -- Nhóm phải đang ACTIVE
  IF _group.status <> 'ACTIVE' THEN
    RAISE EXCEPTION 'Nhóm đã đóng, không thể xóa thành viên';
  END IF;

  -- Chỉ chủ nhóm mới được xóa
  IF _group.owner_id <> auth.uid() THEN
    RAISE EXCEPTION 'Chỉ chủ nhóm mới được xóa thành viên';
  END IF;

  -- Không được tự xóa mình
  IF _user_id = auth.uid() THEN
    RAISE EXCEPTION 'Chủ nhóm không thể tự xóa chính mình';
  END IF;

  -- Kiểm tra thành viên có trong nhóm và ACTIVE
  IF NOT EXISTS (
    SELECT 1 FROM public.group_members
    WHERE group_id = _group_id AND user_id = _user_id AND status = 'ACTIVE'
  ) THEN
    RAISE EXCEPTION 'Người dùng không phải thành viên đang hoạt động trong nhóm';
  END IF;

  -- BR-11: Kiểm tra số dư chính thức phải = 0
  SELECT COALESCE(gb.official_balance, 0) INTO _balance
  FROM public.group_balances gb
  WHERE gb.group_id = _group_id AND gb.user_id = _user_id;

  IF _balance <> 0 THEN
    RAISE EXCEPTION 'Thành viên còn số dư chưa thanh toán (%), không thể xóa', _balance;
  END IF;

  -- BR-11: Kiểm tra không có thanh toán PENDING liên quan
  SELECT EXISTS (
    SELECT 1 FROM public.payments p
    WHERE p.group_id = _group_id
      AND p.status = 'PENDING'
      AND (p.from_id = _user_id OR p.to_id = _user_id)
  ) INTO _has_pending;

  IF _has_pending THEN
    RAISE EXCEPTION 'Thành viên còn thanh toán đang chờ xử lý, không thể xóa';
  END IF;

  -- Cập nhật trạng thái
  UPDATE public.group_members
  SET status = 'REMOVED', left_at = now()
  WHERE group_id = _group_id AND user_id = _user_id;

  -- Thông báo cho người bị xóa
  INSERT INTO public.notifications (user_id, type, group_id)
  VALUES (_user_id, 'MEMBER_REMOVED', _group_id);

  -- Ghi activity log
  INSERT INTO public.activity_logs (group_id, actor_id, action, entity_type, entity_id, after)
  VALUES (
    _group_id,
    auth.uid(),
    'REMOVE',
    'MEMBER',
    _user_id,
    jsonb_build_object('removed_user_id', _user_id)
  );
END;
$$;

-- ============================
-- 7. RPC: transfer_ownership — chuyển quyền chủ nhóm
-- ============================

CREATE OR REPLACE FUNCTION public.transfer_ownership(_group_id UUID, _new_owner_id UUID)
RETURNS public.groups
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  _group public.groups;
  _caller UUID := auth.uid();
BEGIN
  -- Lấy nhóm
  SELECT * INTO _group FROM public.groups WHERE id = _group_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Nhóm không tồn tại';
  END IF;

  -- Nhóm phải đang ACTIVE
  IF _group.status <> 'ACTIVE' THEN
    RAISE EXCEPTION 'Nhóm đã đóng, không thể chuyển quyền';
  END IF;

  -- Chỉ chủ nhóm hiện tại mới được chuyển
  IF _group.owner_id <> _caller THEN
    RAISE EXCEPTION 'Chỉ chủ nhóm mới được chuyển quyền';
  END IF;

  -- Không chuyển cho chính mình
  IF _new_owner_id = _caller THEN
    RAISE EXCEPTION 'Bạn đã là chủ nhóm';
  END IF;

  -- Người nhận phải là thành viên ACTIVE
  IF NOT EXISTS (
    SELECT 1 FROM public.group_members
    WHERE group_id = _group_id AND user_id = _new_owner_id AND status = 'ACTIVE'
  ) THEN
    RAISE EXCEPTION 'Người nhận không phải thành viên đang hoạt động trong nhóm';
  END IF;

  -- Cập nhật owner_id trên bảng groups
  UPDATE public.groups
  SET owner_id = _new_owner_id
  WHERE id = _group_id
  RETURNING * INTO _group;

  -- Cập nhật role: chủ cũ → member, chủ mới → owner
  UPDATE public.group_members
  SET role = 'member'
  WHERE group_id = _group_id AND user_id = _caller;

  UPDATE public.group_members
  SET role = 'owner'
  WHERE group_id = _group_id AND user_id = _new_owner_id;

  -- Thông báo cho chủ mới
  INSERT INTO public.notifications (user_id, type, group_id)
  VALUES (_new_owner_id, 'OWNERSHIP_RECEIVED', _group_id);

  -- Thông báo cho chủ cũ
  INSERT INTO public.notifications (user_id, type, group_id)
  VALUES (_caller, 'OWNERSHIP_TRANSFERRED', _group_id);

  -- Ghi activity log
  INSERT INTO public.activity_logs (group_id, actor_id, action, entity_type, entity_id, before, after)
  VALUES (
    _group_id,
    _caller,
    'TRANSFER_OWNERSHIP',
    'GROUP',
    _group_id,
    jsonb_build_object('owner_id', _caller),
    jsonb_build_object('owner_id', _new_owner_id)
  );

  RETURN _group;
END;
$$;

-- ============================
-- 8. RPC: leave_group — rời nhóm
-- ============================

CREATE OR REPLACE FUNCTION public.leave_group(_group_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  _group public.groups;
  _caller UUID := auth.uid();
  _balance BIGINT;
  _has_pending BOOLEAN;
BEGIN
  -- Lấy nhóm
  SELECT * INTO _group FROM public.groups WHERE id = _group_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Nhóm không tồn tại';
  END IF;

  -- Nhóm phải đang ACTIVE
  IF _group.status <> 'ACTIVE' THEN
    RAISE EXCEPTION 'Nhóm đã đóng';
  END IF;

  -- Kiểm tra người gọi là thành viên ACTIVE
  IF NOT EXISTS (
    SELECT 1 FROM public.group_members
    WHERE group_id = _group_id AND user_id = _caller AND status = 'ACTIVE'
  ) THEN
    RAISE EXCEPTION 'Bạn không phải thành viên nhóm này';
  END IF;

  -- Chủ nhóm phải chuyển quyền trước
  IF _group.owner_id = _caller THEN
    RAISE EXCEPTION 'Chủ nhóm phải chuyển quyền trước khi rời nhóm';
  END IF;

  -- BR-11: Kiểm tra số dư chính thức phải = 0
  SELECT COALESCE(gb.official_balance, 0) INTO _balance
  FROM public.group_balances gb
  WHERE gb.group_id = _group_id AND gb.user_id = _caller;

  IF _balance <> 0 THEN
    RAISE EXCEPTION 'Bạn còn số dư chưa thanh toán (%), không thể rời nhóm', _balance;
  END IF;

  -- BR-11: Kiểm tra không có thanh toán PENDING
  SELECT EXISTS (
    SELECT 1 FROM public.payments p
    WHERE p.group_id = _group_id
      AND p.status = 'PENDING'
      AND (p.from_id = _caller OR p.to_id = _caller)
  ) INTO _has_pending;

  IF _has_pending THEN
    RAISE EXCEPTION 'Bạn còn thanh toán đang chờ xử lý, không thể rời nhóm';
  END IF;

  -- Cập nhật trạng thái
  UPDATE public.group_members
  SET status = 'LEFT', left_at = now()
  WHERE group_id = _group_id AND user_id = _caller;

  -- Thông báo cho chủ nhóm
  INSERT INTO public.notifications (user_id, type, group_id)
  VALUES (_group.owner_id, 'MEMBER_LEFT', _group_id);

  -- Ghi activity log
  INSERT INTO public.activity_logs (group_id, actor_id, action, entity_type, entity_id, after)
  VALUES (
    _group_id,
    _caller,
    'LEAVE',
    'MEMBER',
    _caller,
    jsonb_build_object('user_id', _caller)
  );
END;
$$;

-- ============================
-- 9. RPC: close_group — đóng nhóm
-- ============================

CREATE OR REPLACE FUNCTION public.close_group(_group_id UUID)
RETURNS public.groups
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  _group public.groups;
  _nonzero_count INT;
  _has_pending BOOLEAN;
BEGIN
  -- Lấy nhóm
  SELECT * INTO _group FROM public.groups WHERE id = _group_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Nhóm không tồn tại';
  END IF;

  -- Đã đóng thì bỏ qua (idempotent)
  IF _group.status = 'CLOSED' THEN
    RETURN _group;
  END IF;

  -- Chỉ chủ nhóm mới được đóng
  IF _group.owner_id <> auth.uid() THEN
    RAISE EXCEPTION 'Chỉ chủ nhóm mới được đóng nhóm';
  END IF;

  -- Kiểm tra TẤT CẢ thành viên phải có số dư = 0
  SELECT COUNT(*) INTO _nonzero_count
  FROM public.group_balances gb
  WHERE gb.group_id = _group_id AND gb.official_balance <> 0;

  IF _nonzero_count > 0 THEN
    RAISE EXCEPTION 'Còn % thành viên chưa thanh toán hết, không thể đóng nhóm', _nonzero_count;
  END IF;

  -- Kiểm tra không có thanh toán PENDING trong nhóm
  SELECT EXISTS (
    SELECT 1 FROM public.payments p
    WHERE p.group_id = _group_id AND p.status = 'PENDING'
  ) INTO _has_pending;

  IF _has_pending THEN
    RAISE EXCEPTION 'Nhóm còn thanh toán đang chờ xử lý, không thể đóng';
  END IF;

  -- Đóng nhóm
  UPDATE public.groups
  SET status = 'CLOSED'
  WHERE id = _group_id
  RETURNING * INTO _group;

  -- Ghi activity log
  INSERT INTO public.activity_logs (group_id, actor_id, action, entity_type, entity_id)
  VALUES (
    _group_id,
    auth.uid(),
    'CLOSE',
    'GROUP',
    _group_id
  );

  RETURN _group;
END;
$$;

-- ============================
-- 10. CẬP NHẬT RPC: join_group — thêm kiểm tra ACTIVE,
--     xử lý thành viên đã rời, thông báo + log
-- ============================

CREATE OR REPLACE FUNCTION public.join_group(_code TEXT)
RETURNS public.groups
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  _group public.groups;
  _existing_member public.group_members;
  _caller UUID := auth.uid();
BEGIN
  -- Tìm nhóm theo mã mời
  SELECT * INTO _group FROM public.groups WHERE invite_code = upper(trim(_code));
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Mã mời không tồn tại';
  END IF;

  -- Nhóm phải đang ACTIVE
  IF _group.status <> 'ACTIVE' THEN
    RAISE EXCEPTION 'Nhóm đã đóng, không thể tham gia';
  END IF;

  -- Kiểm tra nếu đã là thành viên
  SELECT * INTO _existing_member
  FROM public.group_members
  WHERE group_id = _group.id AND user_id = _caller;

  IF FOUND THEN
    -- Đã là thành viên ACTIVE → trả về nhóm (idempotent)
    IF _existing_member.status = 'ACTIVE' THEN
      RETURN _group;
    END IF;

    -- Từng là thành viên (LEFT/REMOVED) → kích hoạt lại
    UPDATE public.group_members
    SET status = 'ACTIVE', left_at = NULL, joined_at = now()
    WHERE group_id = _group.id AND user_id = _caller;
  ELSE
    -- Thành viên mới
    INSERT INTO public.group_members (group_id, user_id, role)
    VALUES (_group.id, _caller, 'member');
  END IF;

  -- Thông báo cho chủ nhóm
  INSERT INTO public.notifications (user_id, type, group_id)
  VALUES (_group.owner_id, 'MEMBER_JOINED', _group.id);

  -- Ghi activity log
  INSERT INTO public.activity_logs (group_id, actor_id, action, entity_type, entity_id, after)
  VALUES (
    _group.id,
    _caller,
    'JOIN',
    'MEMBER',
    _caller,
    jsonb_build_object('user_id', _caller)
  );

  RETURN _group;
END;
$$;

COMMIT;
