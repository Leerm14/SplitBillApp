-- ============================================================
-- Migration 0014: Chủ nhóm duyệt yêu cầu tham gia (join approval)
--   1. groups.require_approval (mặc định false — nhóm cũ giữ nguyên hành vi)
--   2. Bảng group_join_requests (RLS: người xin + chủ nhóm đọc; ghi chỉ qua RPC)
--   3. set_join_approval(_group_id, _required) — chủ nhóm bật / tắt duyệt
--   4. join_by_token / join_by_code / accept_invite_by_id_v2 → JSONB
--      {status: JOINED | PENDING | ALREADY_MEMBER, group_id, group_name, request_id}
--   5. accept_invite / join_group (bản app cũ): giữ chữ ký; khi cần duyệt →
--      'JOIN_APPROVAL_REQUIRED' (app cũ không vượt qua được bước duyệt).
--      accept_invite_by_id gọi accept_invite nên cũng vậy.
--   6. list_join_requests / my_join_request
--   7. approve_join_request / reject_join_request / cancel_join_request
--   8. Đóng nhóm → tự từ chối các yêu cầu đang chờ (trigger trên groups)
--   9. Realtime: group_join_requests vào publication supabase_realtime
--
-- Quy tắc vào nhóm (join_by_token / join_by_code / accept_invite_by_id_v2):
--   - Đang ACTIVE → ALREADY_MEMBER (không tốn lượt dùng lời mời).
--   - require_approval = false → vào ngay như 0011 (JOINED). REMOVED chỉ vào lại bằng
--     lời mời đích danh do chủ nhóm hiện tại tạo (BE-07), mã nhóm luôn chặn REMOVED.
--   - require_approval = true → vào ngay CHỈ KHI lời mời đích danh người gọi VÀ do chủ
--     nhóm hiện tại tạo. Ngược lại tạo (hoặc trả lại) yêu cầu PENDING; REMOVED cũng được
--     xin (chủ nhóm quyết).
--   - Lời mời token: used_count tăng NGAY KHI tạo yêu cầu (giữ chỗ). Từ chối / hủy yêu cầu
--     KHÔNG hoàn lượt. Gọi lại khi đã có yêu cầu PENDING → trả yêu cầu cũ, không tốn lượt.
--     Duyệt không kiểm tra lại lời mời (thu hồi / hết hạn sau khi xin không ảnh hưởng).
--   - Vào thẳng (JOINED) khi còn yêu cầu PENDING → yêu cầu đó thành CANCELLED.
--   - Tắt duyệt KHÔNG đụng yêu cầu đang chờ: chủ nhóm vẫn duyệt / từ chối được.
--
-- Thứ tự khóa (như 0011): groups → group_invites → khóa tư vấn (nhóm, người xin) →
-- group_join_requests. Duyệt / từ chối khóa groups FOR UPDATE trước yêu cầu FOR UPDATE.
--
-- KHÔNG sửa 0001–0013. File này chạy lại được nhiều lần (IF NOT EXISTS, DROP ... IF
-- EXISTS, CREATE OR REPLACE, khối DO). Mọi hàm: SECURITY DEFINER SET search_path = '',
-- tên đầy đủ schema, lỗi nghiệp vụ dạng 'CODE: message' (src/api/errors.ts).
-- ============================================================

BEGIN;

-- ============================================================
-- PART 1: Cột + bảng
-- ============================================================

ALTER TABLE public.groups
  ADD COLUMN IF NOT EXISTS require_approval BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS public.group_join_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id UUID NOT NULL REFERENCES public.groups(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES public.profiles(id),
  invite_id UUID REFERENCES public.group_invites(id) ON DELETE SET NULL,
  via TEXT CHECK (via IN ('INVITE', 'CODE')),
  status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED')),
  created_at TIMESTAMPTZ DEFAULT now(),
  decided_at TIMESTAMPTZ,
  decided_by UUID REFERENCES public.profiles(id),
  -- Lý do từ chối (tùy chọn, reject_join_request / tự từ chối khi đóng nhóm)
  reason TEXT CHECK (reason IS NULL OR char_length(reason) <= 500)
);

-- Mỗi (nhóm, người) chỉ một yêu cầu PENDING
CREATE UNIQUE INDEX IF NOT EXISTS uq_group_join_requests_pending
  ON public.group_join_requests (group_id, user_id)
  WHERE status = 'PENDING';

CREATE INDEX IF NOT EXISTS idx_group_join_requests_user
  ON public.group_join_requests (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_group_join_requests_group
  ON public.group_join_requests (group_id, created_at);

CREATE INDEX IF NOT EXISTS idx_group_join_requests_invite
  ON public.group_join_requests (invite_id)
  WHERE invite_id IS NOT NULL;

ALTER TABLE public.group_join_requests ENABLE ROW LEVEL SECURITY;

-- Người xin đọc yêu cầu của mình; chủ nhóm (hiện tại — is_owner đọc owner_id lúc truy
-- vấn, nên chuyển quyền chủ nhóm thì yêu cầu theo chủ mới) đọc yêu cầu của nhóm.
-- Thành viên khác không đọc được. Realtime lọc theo cùng policy.
DROP POLICY IF EXISTS "Requester can read own join requests" ON public.group_join_requests;
CREATE POLICY "Requester can read own join requests"
  ON public.group_join_requests FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());

DROP POLICY IF EXISTS "Owner can read group join requests" ON public.group_join_requests;
CREATE POLICY "Owner can read group join requests"
  ON public.group_join_requests FOR SELECT
  TO authenticated
  USING (public.is_owner(group_id));

-- Ghi chỉ qua RPC (SECURITY DEFINER)
REVOKE ALL ON public.group_join_requests FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.group_join_requests TO authenticated;


-- ============================================================
-- PART 2: process_join — lõi vào nhóm / tạo yêu cầu (NỘI BỘ, không cấp cho app)
-- ============================================================

-- _invite_id NULL = vào bằng mã nhóm (via CODE), khác NULL = lời mời (via INVITE).
-- Người gọi (join_by_token / join_by_code / accept_invite_by_id_v2) đã kiểm tra đăng
-- nhập và tra id KHÔNG khóa. Ở đây khóa groups FOR SHARE (set_join_approval /
-- approve / close_group / transfer_ownership giữ FOR UPDATE) rồi lời mời FOR UPDATE,
-- và kiểm tra mọi thứ trên bản đã khóa — cùng thứ tự lỗi với accept_invite (0011) /
-- join_group (0010).
CREATE OR REPLACE FUNCTION public.process_join(_group_id UUID, _invite_id UUID, _caller UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  _group public.groups;
  _invite public.group_invites;
  _has_invite BOOLEAN := _invite_id IS NOT NULL;
  _existing_member public.group_members;
  _is_existing BOOLEAN;
  _bypass BOOLEAN := false;
  _request public.group_join_requests;
BEGIN
  IF _caller IS NULL THEN
    RAISE EXCEPTION 'NOT_AUTHENTICATED: You must be logged in to perform this action.';
  END IF;

  -- 1. Khóa nhóm FOR SHARE
  SELECT * INTO _group FROM public.groups WHERE id = _group_id FOR SHARE;
  IF NOT FOUND THEN
    IF _has_invite THEN
      RAISE EXCEPTION 'INVITE_NOT_FOUND: Invite does not exist.';
    END IF;
    RAISE EXCEPTION 'INVITE_CODE_NOT_FOUND: Invalid invite code.';
  END IF;

  -- 2. Khóa lời mời (BE-06) rồi kiểm tra trên bản đã khóa
  IF _has_invite THEN
    SELECT * INTO _invite
    FROM public.group_invites
    WHERE id = _invite_id AND group_id = _group_id
    FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'INVITE_NOT_FOUND: Invite does not exist.';
    END IF;

    IF _invite.revoked_at IS NOT NULL THEN
      RAISE EXCEPTION 'INVITE_REVOKED: This invite has been revoked.';
    END IF;

    IF _invite.expires_at < now() THEN
      RAISE EXCEPTION 'INVITE_EXPIRED: This invite has expired.';
    END IF;

    IF _invite.invited_user_id IS NOT NULL AND _invite.invited_user_id IS DISTINCT FROM _caller THEN
      RAISE EXCEPTION 'INVITE_NOT_FOR_YOU: This invite is not intended for you.';
    END IF;

    -- Lời mời đích danh người gọi, do chủ nhóm HIỆN TẠI tạo
    _bypass := _invite.invited_user_id = _caller AND _invite.created_by = _group.owner_id;
  END IF;

  IF _group.status IS DISTINCT FROM 'ACTIVE' THEN
    RAISE EXCEPTION 'GROUP_CLOSED: Group is closed, cannot join.';
  END IF;

  SELECT * INTO _existing_member
  FROM public.group_members
  WHERE group_id = _group.id AND user_id = _caller;
  _is_existing := FOUND;

  IF _is_existing AND _existing_member.status = 'ACTIVE' THEN
    -- idempotent, không tốn lượt dùng
    RETURN jsonb_build_object('status', 'ALREADY_MEMBER', 'group_id', _group.id,
                              'group_name', _group.name, 'request_id', NULL);
  END IF;

  -- 3a. Cần chủ nhóm duyệt → yêu cầu PENDING
  IF _group.require_approval AND NOT COALESCE(_bypass, false) THEN
    -- Tuần tự hóa các lần xin của cùng một người vào cùng một nhóm (mã nhóm không có
    -- dòng lời mời để khóa). Chỉ mục duy nhất partial vẫn là lưới an toàn cuối.
    PERFORM pg_advisory_xact_lock(
      hashtextextended('join_request:' || _group.id::text || ':' || _caller::text, 0));

    SELECT * INTO _request
    FROM public.group_join_requests
    WHERE group_id = _group.id AND user_id = _caller AND status = 'PENDING';

    IF FOUND THEN
      -- Đã xin rồi: trả yêu cầu cũ, không tốn thêm lượt, không báo lại chủ nhóm
      RETURN jsonb_build_object('status', 'PENDING', 'group_id', _group.id,
                                'group_name', _group.name, 'request_id', _request.id);
    END IF;

    IF _has_invite AND _invite.used_count >= _invite.max_uses THEN
      RAISE EXCEPTION 'INVITE_EXHAUSTED: This invite has been fully used.';
    END IF;

    INSERT INTO public.group_join_requests (group_id, user_id, invite_id, via)
    VALUES (_group.id, _caller, _invite_id, CASE WHEN _has_invite THEN 'INVITE' ELSE 'CODE' END)
    RETURNING * INTO _request;

    -- Giữ chỗ: lượt dùng tính lúc xin (không hoàn khi từ chối / hủy)
    IF _has_invite THEN
      UPDATE public.group_invites
      SET used_count = used_count + 1
      WHERE id = _invite.id;
    END IF;

    INSERT INTO public.notifications (user_id, type, group_id, actor_id)
    VALUES (_group.owner_id, 'JOIN_REQUESTED', _group.id, _caller);

    INSERT INTO public.activity_logs (group_id, actor_id, action, entity_type, entity_id, after)
    VALUES (
      _group.id, _caller, 'REQUEST', 'JOIN_REQUEST', _request.id,
      jsonb_build_object('user_id', _caller, 'via', _request.via, 'invite_id', _invite_id,
                         'previous_status', _existing_member.status)
    );

    RETURN jsonb_build_object('status', 'PENDING', 'group_id', _group.id,
                              'group_name', _group.name, 'request_id', _request.id);
  END IF;

  -- 3b. Vào thẳng — giữ nguyên accept_invite (0011) / join_group (0010)
  IF _has_invite AND _invite.used_count >= _invite.max_uses THEN
    RAISE EXCEPTION 'INVITE_EXHAUSTED: This invite has been fully used.';
  END IF;

  IF _is_existing THEN
    -- BE-07: REMOVED chỉ vào lại bằng lời mời ĐÍCH DANH do chủ nhóm (hiện tại) tạo;
    -- mã nhóm luôn chặn REMOVED
    IF _existing_member.status = 'REMOVED' AND NOT COALESCE(_bypass, false) THEN
      RAISE EXCEPTION 'MEMBER_REMOVED: You were removed from this group and cannot rejoin.';
    END IF;

    UPDATE public.group_members
    SET status = 'ACTIVE', role = 'member', left_at = NULL, joined_at = now()
    WHERE group_id = _group.id AND user_id = _caller;
  ELSE
    INSERT INTO public.group_members (group_id, user_id, role)
    VALUES (_group.id, _caller, 'member');
  END IF;

  IF _has_invite THEN
    UPDATE public.group_invites
    SET used_count = used_count + 1
    WHERE id = _invite.id;
  END IF;

  -- Yêu cầu còn chờ (vd. xin trước khi chủ nhóm tắt duyệt) không còn ý nghĩa
  UPDATE public.group_join_requests
  SET status = 'CANCELLED', decided_at = now(), decided_by = _caller
  WHERE group_id = _group.id AND user_id = _caller AND status = 'PENDING';

  INSERT INTO public.notifications (user_id, type, group_id, actor_id)
  VALUES (_group.owner_id, 'MEMBER_JOINED', _group.id, _caller);

  IF _has_invite THEN
    INSERT INTO public.activity_logs (group_id, actor_id, action, entity_type, entity_id, after)
    VALUES (
      _group.id, _caller, 'ACCEPT', 'INVITE', _invite.id,
      jsonb_build_object('user_id', _caller, 'previous_status', _existing_member.status)
    );
  ELSE
    INSERT INTO public.activity_logs (group_id, actor_id, action, entity_type, entity_id, after)
    VALUES (_group.id, _caller, 'JOIN', 'MEMBER', _caller, jsonb_build_object('user_id', _caller));
  END IF;

  RETURN jsonb_build_object('status', 'JOINED', 'group_id', _group.id,
                            'group_name', _group.name, 'request_id', NULL);
END;
$$;


-- ============================================================
-- PART 3: RPC vào nhóm trả JSONB
-- ============================================================

-- Lời mời token (link / QR). Tra id KHÔNG khóa (token, group_id không bao giờ đổi).
CREATE OR REPLACE FUNCTION public.join_by_token(_token TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  _caller UUID;
  _invite_id UUID;
  _group_id UUID;
BEGIN
  _caller := public.assert_authenticated();

  SELECT gi.id, gi.group_id INTO _invite_id, _group_id
  FROM public.group_invites gi
  WHERE gi.token = _token;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'INVITE_NOT_FOUND: Invite does not exist.';
  END IF;

  RETURN public.process_join(_group_id, _invite_id, _caller);
END;
$$;

-- Mã nhóm tĩnh. Khóa FOR SHARE khi tra mã (như join_group) để mã vừa đổi
-- (rotate_invite_code giữ FOR UPDATE) không còn dùng được.
CREATE OR REPLACE FUNCTION public.join_by_code(_code TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  _caller UUID;
  _group_id UUID;
BEGIN
  _caller := public.assert_authenticated();

  SELECT g.id INTO _group_id
  FROM public.groups g
  WHERE g.invite_code = upper(trim(_code))
  FOR SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'INVITE_CODE_NOT_FOUND: Invalid invite code.';
  END IF;

  RETURN public.process_join(_group_id, NULL, _caller);
END;
$$;

-- Từ thông báo GROUP_INVITED (người được mời không đọc được token). Chỉ đúng người
-- được mời đích danh — kiểm tra như accept_invite_by_id (0012).
CREATE OR REPLACE FUNCTION public.accept_invite_by_id_v2(_invite_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  _caller UUID;
  _group_id UUID;
  _invited UUID;
BEGIN
  _caller := public.assert_authenticated();

  SELECT gi.group_id, gi.invited_user_id INTO _group_id, _invited
  FROM public.group_invites gi
  WHERE gi.id = _invite_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'INVITE_NOT_FOUND: Invite does not exist.';
  END IF;

  IF _invited IS NULL OR _invited IS DISTINCT FROM _caller THEN
    RAISE EXCEPTION 'INVITE_NOT_FOR_YOU: This invite is not intended for you.';
  END IF;

  RETURN public.process_join(_group_id, _invite_id, _caller);
END;
$$;


-- ============================================================
-- PART 4: RPC cũ — chặn vượt duyệt
-- ============================================================

-- Giữ nguyên 0011 (thứ tự khóa groups FOR SHARE → lời mời FOR UPDATE, thứ tự lỗi,
-- BE-07, used_count, thông báo, nhật ký). Thêm:
--   - nhóm cần duyệt và lời mời KHÔNG phải đích danh người gọi do chủ nhóm tạo →
--     'JOIN_APPROVAL_REQUIRED' (sau bước "đang ACTIVE thì trả nhóm"),
--   - vào thành công → hủy yêu cầu PENDING còn sót.
-- accept_invite_by_id (0012) gọi hàm này nên cũng chặn đúng như vậy.
CREATE OR REPLACE FUNCTION public.accept_invite(_token TEXT)
RETURNS public.groups
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  _invite public.group_invites;
  _invite_id UUID;
  _group_id UUID;
  _group public.groups;
  _existing_member public.group_members;
  _is_existing BOOLEAN;
  _caller UUID;
BEGIN
  _caller := public.assert_authenticated();

  -- 1. Không khóa
  SELECT gi.id, gi.group_id INTO _invite_id, _group_id
  FROM public.group_invites gi
  WHERE gi.token = _token;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'INVITE_NOT_FOUND: Invite does not exist.';
  END IF;

  -- 2. Khóa nhóm FOR SHARE (close_group / anonymize_account giữ FOR UPDATE)
  SELECT * INTO _group FROM public.groups WHERE id = _group_id FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'INVITE_NOT_FOUND: Invite does not exist.';
  END IF;

  -- 3. Khóa lời mời (BE-06) rồi kiểm tra trên bản đã khóa
  SELECT * INTO _invite
  FROM public.group_invites
  WHERE id = _invite_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'INVITE_NOT_FOUND: Invite does not exist.';
  END IF;

  IF _invite.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'INVITE_REVOKED: This invite has been revoked.';
  END IF;

  IF _invite.expires_at < now() THEN
    RAISE EXCEPTION 'INVITE_EXPIRED: This invite has expired.';
  END IF;

  IF _invite.invited_user_id IS NOT NULL AND _invite.invited_user_id IS DISTINCT FROM _caller THEN
    RAISE EXCEPTION 'INVITE_NOT_FOR_YOU: This invite is not intended for you.';
  END IF;

  IF _group.status IS DISTINCT FROM 'ACTIVE' THEN
    RAISE EXCEPTION 'GROUP_CLOSED: Group is closed, cannot join.';
  END IF;

  SELECT * INTO _existing_member
  FROM public.group_members
  WHERE group_id = _invite.group_id AND user_id = _caller;
  _is_existing := FOUND;

  IF _is_existing AND _existing_member.status = 'ACTIVE' THEN
    RETURN _group; -- idempotent, không tốn lượt dùng
  END IF;

  -- 0014: nhóm cần duyệt — chỉ lời mời đích danh do chủ nhóm tạo được vào thẳng
  IF _group.require_approval
     AND (_invite.invited_user_id IS DISTINCT FROM _caller
          OR _invite.created_by IS DISTINCT FROM _group.owner_id) THEN
    RAISE EXCEPTION 'JOIN_APPROVAL_REQUIRED: This group requires owner approval. Update the app to send a join request.';
  END IF;

  IF _invite.used_count >= _invite.max_uses THEN
    RAISE EXCEPTION 'INVITE_EXHAUSTED: This invite has been fully used.';
  END IF;

  IF _is_existing THEN
    -- BE-07: REMOVED chỉ vào lại bằng lời mời ĐÍCH DANH do chủ nhóm (hiện tại) tạo
    IF _existing_member.status = 'REMOVED'
       AND (_invite.invited_user_id IS DISTINCT FROM _caller
            OR _invite.created_by IS DISTINCT FROM _group.owner_id) THEN
      RAISE EXCEPTION 'MEMBER_REMOVED: You were removed from this group and cannot rejoin.';
    END IF;

    -- LEFT, hoặc REMOVED được chủ nhóm mời lại đích danh
    UPDATE public.group_members
    SET status = 'ACTIVE', role = 'member', left_at = NULL, joined_at = now()
    WHERE group_id = _invite.group_id AND user_id = _caller;
  ELSE
    INSERT INTO public.group_members (group_id, user_id, role)
    VALUES (_invite.group_id, _caller, 'member');
  END IF;

  UPDATE public.group_invites
  SET used_count = used_count + 1
  WHERE id = _invite.id;

  UPDATE public.group_join_requests
  SET status = 'CANCELLED', decided_at = now(), decided_by = _caller
  WHERE group_id = _group.id AND user_id = _caller AND status = 'PENDING';

  INSERT INTO public.notifications (user_id, type, group_id, actor_id)
  VALUES (_group.owner_id, 'MEMBER_JOINED', _group.id, _caller);

  INSERT INTO public.activity_logs (group_id, actor_id, action, entity_type, entity_id, after)
  VALUES (
    _group.id, _caller, 'ACCEPT', 'INVITE', _invite.id,
    jsonb_build_object('user_id', _caller, 'previous_status', _existing_member.status)
  );

  RETURN _group;
END;
$$;

-- Giữ nguyên 0010 (khóa FOR SHARE khi tra mã, REMOVED bị chặn). Mã nhóm không bao giờ
-- vượt duyệt → nhóm cần duyệt: 'JOIN_APPROVAL_REQUIRED' (trừ người đang ACTIVE).
CREATE OR REPLACE FUNCTION public.join_group(_code TEXT)
RETURNS public.groups
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  _group public.groups;
  _existing_member public.group_members;
  _is_existing BOOLEAN;
  _caller UUID;
BEGIN
  _caller := public.assert_authenticated();

  SELECT * INTO _group
  FROM public.groups
  WHERE invite_code = upper(trim(_code))
  FOR SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'INVITE_CODE_NOT_FOUND: Invalid invite code.';
  END IF;

  IF _group.status IS DISTINCT FROM 'ACTIVE' THEN
    RAISE EXCEPTION 'GROUP_CLOSED: Group is closed, cannot join.';
  END IF;

  SELECT * INTO _existing_member
  FROM public.group_members
  WHERE group_id = _group.id AND user_id = _caller;
  _is_existing := FOUND;

  IF _is_existing AND _existing_member.status = 'ACTIVE' THEN
    RETURN _group;
  END IF;

  IF _group.require_approval THEN
    RAISE EXCEPTION 'JOIN_APPROVAL_REQUIRED: This group requires owner approval. Update the app to send a join request.';
  END IF;

  IF _is_existing THEN
    IF _existing_member.status = 'REMOVED' THEN
      RAISE EXCEPTION 'MEMBER_REMOVED: You were removed from this group and cannot rejoin.';
    END IF;

    UPDATE public.group_members
    SET status = 'ACTIVE', left_at = NULL, joined_at = now()
    WHERE group_id = _group.id AND user_id = _caller;
  ELSE
    INSERT INTO public.group_members (group_id, user_id, role)
    VALUES (_group.id, _caller, 'member');
  END IF;

  UPDATE public.group_join_requests
  SET status = 'CANCELLED', decided_at = now(), decided_by = _caller
  WHERE group_id = _group.id AND user_id = _caller AND status = 'PENDING';

  INSERT INTO public.notifications (user_id, type, group_id, actor_id)
  VALUES (_group.owner_id, 'MEMBER_JOINED', _group.id, _caller);

  INSERT INTO public.activity_logs (group_id, actor_id, action, entity_type, entity_id, after)
  VALUES (_group.id, _caller, 'JOIN', 'MEMBER', _caller, jsonb_build_object('user_id', _caller));

  RETURN _group;
END;
$$;


-- ============================================================
-- PART 5: set_join_approval — chủ nhóm bật / tắt duyệt
-- ============================================================

-- Tắt duyệt không đụng yêu cầu đang chờ (chủ nhóm vẫn duyệt / từ chối được). Gọi lại
-- với cùng giá trị: trả nhóm, không ghi nhật ký.
CREATE OR REPLACE FUNCTION public.set_join_approval(_group_id UUID, _required BOOLEAN)
RETURNS public.groups
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  _group public.groups;
  _caller UUID;
  _old BOOLEAN;
BEGIN
  _caller := public.assert_authenticated();

  IF _required IS NULL THEN
    RAISE EXCEPTION 'INVALID_VALUE: _required must be true or false.';
  END IF;

  SELECT * INTO _group FROM public.groups WHERE id = _group_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'GROUP_NOT_FOUND: Group does not exist.';
  END IF;

  IF _caller IS DISTINCT FROM _group.owner_id THEN
    RAISE EXCEPTION 'NOT_OWNER: Only the group owner can change join approval.';
  END IF;

  IF _group.status IS DISTINCT FROM 'ACTIVE' THEN
    RAISE EXCEPTION 'GROUP_CLOSED: Group is closed, cannot update.';
  END IF;

  IF _group.require_approval = _required THEN
    RETURN _group;
  END IF;

  _old := _group.require_approval;

  UPDATE public.groups
  SET require_approval = _required
  WHERE id = _group_id
  RETURNING * INTO _group;

  INSERT INTO public.activity_logs (group_id, actor_id, action, entity_type, entity_id, before, after)
  VALUES (
    _group_id, _caller, 'UPDATE', 'GROUP', _group_id,
    jsonb_build_object('require_approval', _old),
    jsonb_build_object('require_approval', _group.require_approval)
  );

  RETURN _group;
END;
$$;


-- ============================================================
-- PART 6: Đọc yêu cầu
-- ============================================================

-- Chủ nhóm không đọc được hồ sơ người ngoài nhóm qua RLS (0009) → hàm này trả 4 cột
-- công khai của người xin. Chỉ PENDING, cũ nhất trước. Hồ sơ đã xóa vẫn hiện (tên bia
-- mộ) để chủ nhóm từ chối được.
DROP FUNCTION IF EXISTS public.list_join_requests(UUID);

CREATE OR REPLACE FUNCTION public.list_join_requests(_group_id UUID)
RETURNS TABLE (
  id UUID,
  user_id UUID,
  display_name TEXT,
  user_code TEXT,
  avatar_path TEXT,
  via TEXT,
  created_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  _caller UUID;
  _owner UUID;
BEGIN
  _caller := public.assert_authenticated();

  SELECT g.owner_id INTO _owner FROM public.groups g WHERE g.id = _group_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'GROUP_NOT_FOUND: Group does not exist.';
  END IF;

  IF _caller IS DISTINCT FROM _owner THEN
    RAISE EXCEPTION 'NOT_OWNER: Only the group owner can view join requests.';
  END IF;

  RETURN QUERY
  SELECT r.id, r.user_id, p.display_name, p.user_code, p.avatar_path, r.via, r.created_at
  FROM public.group_join_requests r
  JOIN public.profiles p ON p.id = r.user_id
  WHERE r.group_id = _group_id
    AND r.status = 'PENDING'
  ORDER BY r.created_at, r.id;
END;
$$;

-- Yêu cầu gần nhất của người gọi trong nhóm (PENDING ưu tiên) hoặc NULL.
CREATE OR REPLACE FUNCTION public.my_join_request(_group_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  _caller UUID;
  _request public.group_join_requests;
BEGIN
  _caller := public.assert_authenticated();

  SELECT * INTO _request
  FROM public.group_join_requests r
  WHERE r.group_id = _group_id AND r.user_id = _caller
  ORDER BY (r.status = 'PENDING') DESC,
           COALESCE(r.decided_at, r.created_at) DESC NULLS LAST,
           r.created_at DESC NULLS LAST
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  RETURN jsonb_build_object('status', _request.status, 'request_id', _request.id);
END;
$$;


-- ============================================================
-- PART 7: Duyệt / từ chối / hủy
-- ============================================================

-- Chủ nhóm (hiện tại) duyệt. Khóa groups FOR UPDATE trước, yêu cầu FOR UPDATE sau.
-- Thêm thành viên (mới, hoặc LEFT / REMOVED → ACTIVE). Báo người xin JOIN_APPROVED.
-- Không báo MEMBER_JOINED cho chủ nhóm (chính chủ nhóm vừa duyệt).
CREATE OR REPLACE FUNCTION public.approve_join_request(_request_id UUID)
RETURNS public.groups
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  _caller UUID;
  _group_id UUID;
  _group public.groups;
  _request public.group_join_requests;
  _member public.group_members;
  _is_existing BOOLEAN;
BEGIN
  _caller := public.assert_authenticated();

  -- 1. Không khóa (group_id không bao giờ đổi)
  SELECT r.group_id INTO _group_id FROM public.group_join_requests r WHERE r.id = _request_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'JOIN_REQUEST_NOT_FOUND: Join request does not exist.';
  END IF;

  -- 2. Khóa nhóm
  SELECT * INTO _group FROM public.groups WHERE id = _group_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'JOIN_REQUEST_NOT_FOUND: Join request does not exist.';
  END IF;

  IF _caller IS DISTINCT FROM _group.owner_id THEN
    RAISE EXCEPTION 'NOT_OWNER: Only the group owner can approve join requests.';
  END IF;

  IF _group.status IS DISTINCT FROM 'ACTIVE' THEN
    RAISE EXCEPTION 'GROUP_CLOSED: Group is closed, cannot approve join requests.';
  END IF;

  -- 3. Khóa yêu cầu rồi kiểm tra trên bản đã khóa
  SELECT * INTO _request FROM public.group_join_requests WHERE id = _request_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'JOIN_REQUEST_NOT_FOUND: Join request does not exist.';
  END IF;

  IF _request.status IS DISTINCT FROM 'PENDING' THEN
    RAISE EXCEPTION 'NOT_PENDING: Join request is no longer pending.';
  END IF;

  IF EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = _request.user_id AND p.deleted_at IS NOT NULL) THEN
    RAISE EXCEPTION 'INVALID_USER: The requester account has been deleted.';
  END IF;

  SELECT * INTO _member
  FROM public.group_members
  WHERE group_id = _group.id AND user_id = _request.user_id;
  _is_existing := FOUND;

  IF _is_existing THEN
    IF _member.status IS DISTINCT FROM 'ACTIVE' THEN
      UPDATE public.group_members
      SET status = 'ACTIVE', role = 'member', left_at = NULL, joined_at = now()
      WHERE group_id = _group.id AND user_id = _request.user_id;
    END IF;
  ELSE
    INSERT INTO public.group_members (group_id, user_id, role)
    VALUES (_group.id, _request.user_id, 'member');
  END IF;

  UPDATE public.group_join_requests
  SET status = 'APPROVED', decided_at = now(), decided_by = _caller
  WHERE id = _request_id
  RETURNING * INTO _request;

  INSERT INTO public.notifications (user_id, type, group_id, actor_id)
  VALUES (_request.user_id, 'JOIN_APPROVED', _group.id, _caller);

  INSERT INTO public.activity_logs (group_id, actor_id, action, entity_type, entity_id, after)
  VALUES (
    _group.id, _caller, 'APPROVE', 'JOIN_REQUEST', _request.id,
    jsonb_build_object('user_id', _request.user_id, 'via', _request.via,
                       'invite_id', _request.invite_id, 'previous_status', _member.status)
  );

  RETURN _group;
END;
$$;

-- Chủ nhóm (hiện tại) từ chối. _reason tùy chọn (≤ 500 ký tự, rỗng = NULL).
DROP FUNCTION IF EXISTS public.reject_join_request(UUID, TEXT);

CREATE OR REPLACE FUNCTION public.reject_join_request(_request_id UUID, _reason TEXT DEFAULT NULL)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  _caller UUID;
  _group_id UUID;
  _group public.groups;
  _request public.group_join_requests;
  _clean_reason TEXT := NULLIF(btrim(_reason), '');
BEGIN
  _caller := public.assert_authenticated();

  IF _clean_reason IS NOT NULL AND char_length(_clean_reason) > 500 THEN
    RAISE EXCEPTION 'INVALID_REASON: Reason must be at most 500 characters.';
  END IF;

  SELECT r.group_id INTO _group_id FROM public.group_join_requests r WHERE r.id = _request_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'JOIN_REQUEST_NOT_FOUND: Join request does not exist.';
  END IF;

  SELECT * INTO _group FROM public.groups WHERE id = _group_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'JOIN_REQUEST_NOT_FOUND: Join request does not exist.';
  END IF;

  IF _caller IS DISTINCT FROM _group.owner_id THEN
    RAISE EXCEPTION 'NOT_OWNER: Only the group owner can reject join requests.';
  END IF;

  SELECT * INTO _request FROM public.group_join_requests WHERE id = _request_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'JOIN_REQUEST_NOT_FOUND: Join request does not exist.';
  END IF;

  IF _request.status IS DISTINCT FROM 'PENDING' THEN
    RAISE EXCEPTION 'NOT_PENDING: Join request is no longer pending.';
  END IF;

  UPDATE public.group_join_requests
  SET status = 'REJECTED', decided_at = now(), decided_by = _caller, reason = _clean_reason
  WHERE id = _request_id
  RETURNING * INTO _request;

  INSERT INTO public.notifications (user_id, type, group_id, actor_id)
  VALUES (_request.user_id, 'JOIN_REJECTED', _group.id, _caller);

  INSERT INTO public.activity_logs (group_id, actor_id, action, entity_type, entity_id, after)
  VALUES (
    _group.id, _caller, 'REJECT', 'JOIN_REQUEST', _request.id,
    jsonb_build_object('user_id', _request.user_id, 'reason', _clean_reason)
  );
END;
$$;

-- Người xin tự hủy. Khóa nhóm FOR SHARE trước yêu cầu (cùng thứ tự với duyệt).
CREATE OR REPLACE FUNCTION public.cancel_join_request(_request_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  _caller UUID;
  _group_id UUID;
  _user_id UUID;
  _request public.group_join_requests;
BEGIN
  _caller := public.assert_authenticated();

  SELECT r.group_id, r.user_id INTO _group_id, _user_id
  FROM public.group_join_requests r
  WHERE r.id = _request_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'JOIN_REQUEST_NOT_FOUND: Join request does not exist.';
  END IF;

  IF _user_id IS DISTINCT FROM _caller THEN
    RAISE EXCEPTION 'NOT_AUTHORIZED: Only the requester can cancel this join request.';
  END IF;

  PERFORM 1 FROM public.groups WHERE id = _group_id FOR SHARE;

  SELECT * INTO _request FROM public.group_join_requests WHERE id = _request_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'JOIN_REQUEST_NOT_FOUND: Join request does not exist.';
  END IF;

  IF _request.status IS DISTINCT FROM 'PENDING' THEN
    RAISE EXCEPTION 'NOT_PENDING: Join request is no longer pending.';
  END IF;

  UPDATE public.group_join_requests
  SET status = 'CANCELLED', decided_at = now(), decided_by = _caller
  WHERE id = _request_id;

  INSERT INTO public.activity_logs (group_id, actor_id, action, entity_type, entity_id, after)
  VALUES (
    _request.group_id, _caller, 'CANCEL', 'JOIN_REQUEST', _request.id,
    jsonb_build_object('user_id', _caller)
  );
END;
$$;


-- ============================================================
-- PART 8: Đóng nhóm → tự từ chối yêu cầu đang chờ
-- ============================================================

-- Trigger thay vì sửa close_group (0007): chạy trong giao dịch close_group, lúc đang
-- giữ groups FOR UPDATE. Báo JOIN_REJECTED cho từng người xin (actor = chủ nhóm).
CREATE OR REPLACE FUNCTION public.reject_join_requests_on_close()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  _r RECORD;
BEGIN
  FOR _r IN
    UPDATE public.group_join_requests
    SET status = 'REJECTED', decided_at = now(), decided_by = NEW.owner_id, reason = 'GROUP_CLOSED'
    WHERE group_id = NEW.id AND status = 'PENDING'
    RETURNING id, user_id
  LOOP
    INSERT INTO public.notifications (user_id, type, group_id, actor_id)
    VALUES (_r.user_id, 'JOIN_REJECTED', NEW.id, NEW.owner_id);
  END LOOP;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_group_closed_reject_join_requests ON public.groups;
CREATE TRIGGER on_group_closed_reject_join_requests
  AFTER UPDATE OF status ON public.groups
  FOR EACH ROW
  WHEN (OLD.status IS DISTINCT FROM 'CLOSED' AND NEW.status = 'CLOSED')
  EXECUTE FUNCTION public.reject_join_requests_on_close();


-- ============================================================
-- PART 9: Realtime
-- ============================================================

-- Như 0013 (chạy lại được; tạo publication khi chạy trên Postgres thường). RLS SELECT
-- giới hạn sự kiện cho người xin + chủ nhóm.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    CREATE PUBLICATION supabase_realtime;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
     WHERE pubname = 'supabase_realtime' AND schemaname = 'public'
       AND tablename = 'group_join_requests'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.group_join_requests;
  END IF;
END $$;


-- ============================================================
-- PART 10: QUYỀN
-- ============================================================

-- Nội bộ: không cấp cho app
REVOKE EXECUTE ON FUNCTION public.process_join(UUID, UUID, UUID) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.reject_join_requests_on_close() FROM PUBLIC, anon, authenticated;

REVOKE EXECUTE ON FUNCTION public.join_by_token(TEXT) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.join_by_code(TEXT) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.accept_invite_by_id_v2(UUID) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.accept_invite(TEXT) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.join_group(TEXT) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.set_join_approval(UUID, BOOLEAN) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.list_join_requests(UUID) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.my_join_request(UUID) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.approve_join_request(UUID) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.reject_join_request(UUID, TEXT) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.cancel_join_request(UUID) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.join_by_token(TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.join_by_code(TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.accept_invite_by_id_v2(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.accept_invite(TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.join_group(TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_join_approval(UUID, BOOLEAN) TO authenticated;
GRANT EXECUTE ON FUNCTION public.list_join_requests(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.my_join_request(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.approve_join_request(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.reject_join_request(UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.cancel_join_request(UUID) TO authenticated;

COMMIT;
