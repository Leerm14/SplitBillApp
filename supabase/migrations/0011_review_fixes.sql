-- ============================================================
-- Migration 0011: Review fixes (vòng 4)
--   1. transfer_ownership khóa groups FOR UPDATE trước khi kiểm tra
--   2. Bạn bè (ACCEPTED) đọc được payment_handles của nhau
--   3. Thứ tự khóa accept_invite / revoke_invite: groups → group_invites
--      (cùng thứ tự với anonymize_account) — hết deadlock
--   4. handle_auth_user_deleted: dọn dữ liệu khi user Auth bị xóa ngoài app
--   5. Push token theo thiết bị: register_push_token / unregister_push_token
--   5b. anonymize_account khóa groups trước, hồ sơ FOR NO KEY UPDATE sau — hết
--      deadlock với RPC chèn dòng tham chiếu profiles khi giữ groups FOR SHARE
--
-- KHÔNG sửa 0001–0010 (đã chạy trên Supabase). File này chạy lại được nhiều lần
-- (CREATE OR REPLACE, DROP ... IF EXISTS trước CREATE) vì có lúc migration được
-- chạy tay qua SQL Editor. Mọi hàm: SECURITY DEFINER SET search_path = '', lỗi
-- nghiệp vụ dạng 'CODE: message' (src/api/errors.ts).
-- ============================================================

BEGIN;

-- ============================================================
-- PART 1: transfer_ownership — khóa nhóm (review #1)
-- ============================================================

-- 0007 đọc groups KHÔNG khóa: leave_group / remove_member / close_group /
-- anonymize_account (khóa groups FOR UPDATE) có thể chen vào giữa bước kiểm tra
-- người nhận ACTIVE và bước đổi owner_id → chủ mới là người vừa rời nhóm, hoặc nhóm
-- vừa đóng vẫn đổi chủ. Nay khóa groups FOR UPDATE trước mọi kiểm tra; mọi kiểm tra
-- (nhóm ACTIVE, người nhận ACTIVE) chạy SAU khi đã giữ khóa.
CREATE OR REPLACE FUNCTION public.transfer_ownership(_group_id UUID, _new_owner_id UUID)
RETURNS public.groups
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  _group public.groups;
  _caller UUID;
BEGIN
  _caller := public.assert_authenticated();

  SELECT * INTO _group
  FROM public.groups
  WHERE id = _group_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'GROUP_NOT_FOUND: Group does not exist.';
  END IF;

  IF _group.status IS DISTINCT FROM 'ACTIVE' THEN
    RAISE EXCEPTION 'GROUP_CLOSED: Group is closed, cannot transfer ownership.';
  END IF;

  IF _caller IS DISTINCT FROM _group.owner_id THEN
    RAISE EXCEPTION 'NOT_OWNER: Only the current owner can transfer ownership.';
  END IF;

  IF _new_owner_id IS NOT DISTINCT FROM _caller THEN
    RAISE EXCEPTION 'ALREADY_OWNER: You are already the owner.';
  END IF;

  -- Kiểm tra lại SAU khi khóa: người nhận ACTIVE và tài khoản chưa bị xóa
  IF NOT EXISTS (
    SELECT 1
    FROM public.group_members gm
    JOIN public.profiles p ON p.id = gm.user_id
    WHERE gm.group_id = _group_id
      AND gm.user_id = _new_owner_id
      AND gm.status = 'ACTIVE'
      AND p.deleted_at IS NULL
  ) THEN
    RAISE EXCEPTION 'TARGET_NOT_MEMBER: The target user is not an active member of this group.';
  END IF;

  UPDATE public.groups
  SET owner_id = _new_owner_id
  WHERE id = _group_id
  RETURNING * INTO _group;

  UPDATE public.group_members
  SET role = 'member'
  WHERE group_id = _group_id AND user_id = _caller;

  UPDATE public.group_members
  SET role = 'owner'
  WHERE group_id = _group_id AND user_id = _new_owner_id;

  INSERT INTO public.notifications (user_id, type, group_id, actor_id)
  VALUES (_new_owner_id, 'OWNERSHIP_RECEIVED', _group_id, _caller);

  INSERT INTO public.notifications (user_id, type, group_id, actor_id)
  VALUES (_caller, 'OWNERSHIP_TRANSFERRED', _group_id, _new_owner_id);

  INSERT INTO public.activity_logs (group_id, actor_id, action, entity_type, entity_id, before, after)
  VALUES (
    _group_id, _caller, 'TRANSFER_OWNERSHIP', 'GROUP', _group_id,
    jsonb_build_object('owner_id', _caller),
    jsonb_build_object('owner_id', _new_owner_id)
  );

  RETURN _group;
END;
$$;


-- ============================================================
-- PART 2: payment_handles — bạn bè đọc được (review #2)
-- ============================================================

-- Màn hồ sơ bạn bè (app user/[id].tsx) đọc phương thức thanh toán của bạn. 0006 chỉ
-- cho chủ sở hữu và thành viên cùng nhóm ACTIVE. Thêm: hai người có friendships
-- ACCEPTED (chiều nào cũng được). Giữ nguyên hai policy cũ.
-- Subquery trên friendships chạy dưới RLS của người gọi ("Users can read own
-- friendships") — đúng các dòng có auth.uid() ở một đầu.
DROP POLICY IF EXISTS "Friends can read payment_handles" ON public.payment_handles;
CREATE POLICY "Friends can read payment_handles"
  ON public.payment_handles FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.friendships f
      WHERE f.status = 'ACCEPTED'
        AND (
          (f.requester_id = auth.uid() AND f.addressee_id = payment_handles.user_id)
          OR (f.addressee_id = auth.uid() AND f.requester_id = payment_handles.user_id)
        )
    )
  );


-- ============================================================
-- PART 3: Thứ tự khóa lời mời (review #3)
-- ============================================================

-- Deadlock 0010: anonymize_account khóa groups FOR UPDATE rồi UPDATE group_invites;
-- accept_invite / revoke_invite khóa group_invites FOR UPDATE rồi groups FOR SHARE.
-- Nay mọi hàm khóa theo cùng thứ tự groups → group_invites:
--   1. tra group_id của lời mời KHÔNG khóa (group_id không bao giờ đổi),
--   2. khóa groups (FOR SHARE / assert_active_member_of_active_group),
--   3. khóa lời mời FOR UPDATE rồi kiểm tra lại (revoked_at, used_count, ... đọc
--      SAU khi khóa nên vẫn đúng khi có giao dịch khác vừa ghi).
-- Giữ nguyên hành vi 0010 (thứ tự lỗi, REMOVED vào lại bằng lời mời đích danh do chủ
-- nhóm tạo, used_count, thông báo, nhật ký).

CREATE OR REPLACE FUNCTION public.revoke_invite(_invite_id UUID)
RETURNS public.group_invites
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  _invite public.group_invites;
  _group public.groups;
  _group_id UUID;
  _caller UUID;
  _role TEXT;
BEGIN
  _caller := public.assert_authenticated();

  -- 1. Không khóa
  SELECT gi.group_id INTO _group_id FROM public.group_invites gi WHERE gi.id = _invite_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'INVITE_NOT_FOUND: Invite does not exist.';
  END IF;

  -- 2. Khóa groups FOR SHARE + nhóm ACTIVE + người gọi ACTIVE (BE-03)
  _role := public.assert_active_member_of_active_group(_group_id);

  -- 3. Khóa lời mời
  SELECT * INTO _invite FROM public.group_invites WHERE id = _invite_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'INVITE_NOT_FOUND: Invite does not exist.';
  END IF;

  SELECT * INTO _group FROM public.groups WHERE id = _invite.group_id;

  IF _caller IS DISTINCT FROM _invite.created_by AND _caller IS DISTINCT FROM _group.owner_id THEN
    RAISE EXCEPTION 'NOT_AUTHORIZED: Only the invite creator or group owner can revoke this invite.';
  END IF;

  IF _invite.revoked_at IS NOT NULL THEN
    RETURN _invite;
  END IF;

  UPDATE public.group_invites
  SET revoked_at = now()
  WHERE id = _invite_id
  RETURNING * INTO _invite;

  INSERT INTO public.activity_logs (group_id, actor_id, action, entity_type, entity_id)
  VALUES (_invite.group_id, _caller, 'REVOKE', 'INVITE', _invite.id);

  RETURN _invite;
END;
$$;

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


-- ============================================================
-- PART 4: Lưới an toàn khi xóa user Auth ngoài app (review #4)
-- ============================================================

-- QUAN TRỌNG: xóa tài khoản phải đi qua Edge Function delete-account của app
-- (anonymize_account kiểm tra chủ nhóm / số dư / thanh toán chờ và TỪ CHỐI nếu
-- chưa an toàn). Xóa user từ Supabase Dashboard / Admin API bỏ qua các kiểm tra đó.
--
-- Trigger này chỉ là lưới an toàn cho trường hợp đó. Nó KHÔNG BAO GIỜ được RAISE
-- (xóa trên Dashboard không được lỗi): mỗi bước chạy trong khối EXCEPTION riêng,
-- lỗi chỉ thành WARNING. lock_timeout giới hạn thời gian chờ khóa; hết giờ thì bỏ
-- qua bước dọn dẹp (WARNING) nhưng vẫn ẩn danh hồ sơ.
--
-- Làm phần an toàn của anonymize_account:
--   - thành viên ACTIVE → LEFT (left_at), nhật ký LEAVE, báo MEMBER_LEFT cho chủ nhóm,
--   - thu hồi lời mời do người này tạo / mời đích danh người này,
--   - xóa friendships, payment_handles, notifications, push_tokens,
--   - ẩn danh hồ sơ (bia mộ).
-- Nếu người này còn là chủ nhóm ACTIVE, số dư ≠ 0 hoặc còn thanh toán PENDING: vẫn
-- làm như trên nhưng ghi activity_logs action = 'ACCOUNT_DELETED_UNSAFE' (một dòng mỗi
-- nhóm, after.reasons) và RAISE WARNING để quản trị xử lý tay. Bước dọn dẹp lỗi (vd.
-- hết lock_timeout) → action = 'ACCOUNT_DELETED_CLEANUP_FAILED' (group_id NULL):
--   SELECT * FROM public.activity_logs
--   WHERE action IN ('ACCOUNT_DELETED_UNSAFE', 'ACCOUNT_DELETED_CLEANUP_FAILED');
-- Không khóa groups FOR UPDATE (khác anonymize_account): trigger chạy trong giao dịch
-- của GoTrue, không được chờ lâu / deadlock với RPC ghi đang giữ FOR SHARE.
-- Thứ tự: thành viên → lời mời → bạn bè / token / thông báo → hồ sơ (cuối cùng, vì
-- RPC khác có thể chờ khóa KEY SHARE trên hồ sơ trong khi giữ khóa lời mời).
CREATE OR REPLACE FUNCTION public.handle_auth_user_deleted()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = '' SET lock_timeout = '5s'
AS $$
DECLARE
  _already BOOLEAN;
  _r RECORD;
  _reasons TEXT[];
BEGIN
  BEGIN
    SELECT p.deleted_at IS NOT NULL INTO _already
    FROM public.profiles p
    WHERE p.id = OLD.id;
  EXCEPTION
    WHEN OTHERS THEN
      RAISE WARNING 'AUTH_USER_DELETE_LOOKUP_FAILED: user % — % (SQLSTATE %)', OLD.id, SQLERRM, SQLSTATE;
      _already := NULL;
  END;

  -- _already NULL: không có hồ sơ (hoặc lỗi đọc) → chỉ dọn token ở bước cuối.
  -- _already true: đã ẩn danh qua anonymize_account (luồng delete-account) → bỏ qua.
  IF _already IS NOT NULL AND NOT _already THEN
    -- Bước 1: ghi nhận trường hợp không an toàn (khối riêng: dọn dẹp lỗi vẫn giữ nhật ký)
    BEGIN
      FOR _r IN
        SELECT g.id AS group_id,
               g.status AS group_status,
               g.owner_id,
               COALESCE(gb.official_balance, 0) AS balance,
               (SELECT count(*) FROM public.payments p
                WHERE p.group_id = g.id AND p.status = 'PENDING'
                  AND (p.from_id = OLD.id OR p.to_id = OLD.id)) AS pending
        FROM public.group_members gm
        JOIN public.groups g ON g.id = gm.group_id
        LEFT JOIN public.group_balances gb ON gb.group_id = gm.group_id AND gb.user_id = gm.user_id
        WHERE gm.user_id = OLD.id AND gm.status = 'ACTIVE'
        ORDER BY g.id
      LOOP
        _reasons := ARRAY[]::TEXT[];
        IF _r.owner_id = OLD.id AND _r.group_status = 'ACTIVE' THEN
          _reasons := _reasons || 'OWNER_OF_ACTIVE_GROUP'::TEXT;
        END IF;
        IF _r.balance <> 0 THEN
          _reasons := _reasons || 'NONZERO_BALANCE'::TEXT;
        END IF;
        IF _r.pending > 0 THEN
          _reasons := _reasons || 'PENDING_PAYMENTS'::TEXT;
        END IF;

        IF cardinality(_reasons) > 0 THEN
          INSERT INTO public.activity_logs (group_id, actor_id, action, entity_type, entity_id, after)
          VALUES (
            _r.group_id, OLD.id, 'ACCOUNT_DELETED_UNSAFE', 'MEMBER', OLD.id,
            jsonb_build_object(
              'user_id', OLD.id,
              'reasons', to_jsonb(_reasons),
              'balance', _r.balance,
              'pending_payments', _r.pending,
              'source', 'AUTH_USER_DELETED'
            )
          );
          RAISE WARNING 'ACCOUNT_DELETED_UNSAFE: Auth user % deleted outside delete-account; group % needs admin attention (%).',
            OLD.id, _r.group_id, array_to_string(_reasons, ', ');
        END IF;
      END LOOP;
    EXCEPTION
      WHEN OTHERS THEN
        RAISE WARNING 'ACCOUNT_DELETED_UNSAFE_CHECK_FAILED: user % — % (SQLSTATE %)', OLD.id, SQLERRM, SQLSTATE;
    END;

    -- Bước 2: dọn dẹp
    BEGIN
      FOR _r IN
        SELECT gm.group_id, g.owner_id, g.status AS group_status
        FROM public.group_members gm
        JOIN public.groups g ON g.id = gm.group_id
        WHERE gm.user_id = OLD.id AND gm.status = 'ACTIVE'
        ORDER BY gm.group_id
      LOOP
        UPDATE public.group_members
        SET status = 'LEFT', left_at = now()
        WHERE group_id = _r.group_id AND user_id = OLD.id;

        INSERT INTO public.activity_logs (group_id, actor_id, action, entity_type, entity_id, after)
        VALUES (_r.group_id, OLD.id, 'LEAVE', 'MEMBER', OLD.id,
                jsonb_build_object('user_id', OLD.id, 'reason', 'ACCOUNT_DELETED',
                                   'source', 'AUTH_USER_DELETED'));

        IF _r.group_status = 'ACTIVE' AND _r.owner_id IS DISTINCT FROM OLD.id THEN
          INSERT INTO public.notifications (user_id, type, group_id, actor_id)
          VALUES (_r.owner_id, 'MEMBER_LEFT', _r.group_id, OLD.id);
        END IF;
      END LOOP;

      UPDATE public.group_invites
      SET revoked_at = now()
      WHERE revoked_at IS NULL
        AND (created_by = OLD.id OR invited_user_id = OLD.id);

      DELETE FROM public.friendships WHERE requester_id = OLD.id OR addressee_id = OLD.id;
      DELETE FROM public.payment_handles WHERE user_id = OLD.id;
      DELETE FROM public.notifications WHERE user_id = OLD.id;
    EXCEPTION
      WHEN OTHERS THEN
        RAISE WARNING 'AUTH_USER_DELETE_CLEANUP_FAILED: user % — % (SQLSTATE %). Memberships/invites/friendships were NOT cleaned up.',
          OLD.id, SQLERRM, SQLSTATE;
        -- Dấu vết cho quản trị (group_id NULL: không thành viên nào đọc được qua RLS)
        BEGIN
          INSERT INTO public.activity_logs (group_id, actor_id, action, entity_type, entity_id, after)
          VALUES (NULL, OLD.id, 'ACCOUNT_DELETED_CLEANUP_FAILED', 'MEMBER', OLD.id,
                  jsonb_build_object('user_id', OLD.id, 'error', SQLERRM, 'sqlstate', SQLSTATE,
                                     'source', 'AUTH_USER_DELETED'));
        EXCEPTION
          WHEN OTHERS THEN
            NULL; -- đã có WARNING ở trên
        END;
    END;
  END IF;

  -- Bước 3: token đẩy + bia mộ (như 0010)
  BEGIN
    DELETE FROM public.push_tokens WHERE user_id = OLD.id;

    UPDATE public.profiles
    SET display_name = 'Người dùng đã xóa',
        avatar_path = NULL,
        searchable = false,
        user_code = CASE WHEN deleted_at IS NULL
                         THEN 'DEL' || replace(OLD.id::text, '-', '')
                         ELSE user_code END,
        deleted_at = COALESCE(deleted_at, now())
    WHERE id = OLD.id;
  EXCEPTION
    WHEN OTHERS THEN
      RAISE WARNING 'AUTH_USER_DELETE_ANONYMIZE_FAILED: user % — % (SQLSTATE %)', OLD.id, SQLERRM, SQLSTATE;
  END;

  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_deleted ON auth.users;
CREATE TRIGGER on_auth_user_deleted
  AFTER DELETE ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_auth_user_deleted();


-- ============================================================
-- PART 5: Push token theo thiết bị (review #5)
-- ============================================================

-- push_tokens (0002): PRIMARY KEY (user_id, expo_token), platform, updated_at.
-- Một thiết bị (expo_token) chỉ thuộc MỘT người: đăng nhập tài khoản B trên máy của
-- A thì token chuyển sang B, A không còn nhận push của mình trên máy đó.
-- Không thêm UNIQUE (expo_token) vì bản app cũ còn upsert thẳng vào bảng.

CREATE OR REPLACE FUNCTION public.register_push_token(_expo_token TEXT, _platform TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  _caller UUID;
  _token TEXT := NULLIF(trim(_expo_token), '');
  _plat TEXT := NULLIF(trim(_platform), '');
BEGIN
  _caller := public.assert_authenticated();

  IF _token IS NULL OR length(_token) > 512 THEN
    RAISE EXCEPTION 'INVALID_PUSH_TOKEN: Push token is required (max 512 characters).';
  END IF;

  IF _plat IS NOT NULL AND length(_plat) > 32 THEN
    RAISE EXCEPTION 'INVALID_PLATFORM: Platform must be at most 32 characters.';
  END IF;

  -- Hai tài khoản đăng ký cùng token đồng thời: tuần tự hóa theo token
  PERFORM pg_advisory_xact_lock(hashtextextended('push_token:' || _token, 0));

  DELETE FROM public.push_tokens
  WHERE expo_token = _token
    AND user_id <> _caller;

  INSERT INTO public.push_tokens (user_id, expo_token, platform, updated_at)
  VALUES (_caller, _token, _plat, now())
  ON CONFLICT (user_id, expo_token)
  DO UPDATE SET platform = EXCLUDED.platform,
                updated_at = now();
END;
$$;

-- Đăng xuất: bỏ token của thiết bị này khỏi tài khoản người gọi. Không chặn tài khoản
-- đã ẩn danh (xóa token của chính mình luôn vô hại).
CREATE OR REPLACE FUNCTION public.unregister_push_token(_expo_token TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  _caller UUID := auth.uid();
BEGIN
  IF _caller IS NULL THEN
    RAISE EXCEPTION 'NOT_AUTHENTICATED: You must be logged in to perform this action.';
  END IF;

  DELETE FROM public.push_tokens
  WHERE user_id = _caller
    AND expo_token = trim(_expo_token);
END;
$$;


-- ============================================================
-- PART 5b: anonymize_account — thứ tự khóa groups → profiles
-- ============================================================

-- Deadlock 0010: anonymize_account khóa profiles FOR UPDATE rồi mới khóa groups
-- FOR UPDATE. RPC ghi (create_expense, accept_invite, create_payment, ...) khóa
-- groups FOR SHARE rồi INSERT dòng tham chiếu profiles (notifications.user_id,
-- expense_shares.user_id, ...) → kiểm tra FK lấy FOR KEY SHARE trên hồ sơ, xung đột
-- với FOR UPDATE → hai bên chờ nhau.
-- Nay:
--   1. đọc hồ sơ KHÔNG khóa (PROFILE_NOT_FOUND / already_anonymized như cũ),
--   2. khóa groups FOR UPDATE (thứ tự id) — cùng thứ tự groups → profiles với RPC,
--   3. khóa hồ sơ FOR NO KEY UPDATE (không xung đột FOR KEY SHARE của FK) rồi kiểm
--      tra lại deleted_at (lần gọi đồng thời thứ hai trả already_anonymized).
-- Bước UPDATE cuối đổi user_code (UNIQUE) nên vẫn nâng lên khóa FOR UPDATE, nhưng lúc
-- đó đã giữ khóa mọi nhóm của user: không giao dịch nào đang giữ FOR SHARE các nhóm đó
-- để chờ ngược lại. Giữ nguyên mọi hành vi khác của 0010.
CREATE OR REPLACE FUNCTION public.anonymize_account(_user_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  _profile public.profiles;
  _count INT;
  _left INT := 0;
  _gid UUID;
  _owner UUID;
  _gstatus TEXT;
BEGIN
  IF _user_id IS NULL THEN
    RAISE EXCEPTION 'INVALID_USER: user id is required.';
  END IF;

  -- 1. Không khóa
  SELECT * INTO _profile FROM public.profiles WHERE id = _user_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PROFILE_NOT_FOUND: Profile does not exist.';
  END IF;

  IF _profile.deleted_at IS NOT NULL THEN
    RETURN jsonb_build_object('already_anonymized', true, 'left_groups', 0);
  END IF;

  -- 2. BE-08: khóa mọi nhóm user đang ACTIVE (thứ tự id cố định, tránh deadlock) để
  -- không khoản chi / thanh toán nào chen vào sau bước kiểm tra số dư.
  PERFORM 1
  FROM public.groups g
  WHERE g.id IN (
    SELECT gm.group_id FROM public.group_members gm
    WHERE gm.user_id = _user_id AND gm.status = 'ACTIVE'
  )
  ORDER BY g.id
  FOR UPDATE;

  -- 3. Khóa hồ sơ SAU nhóm, mức NO KEY UPDATE; kiểm tra lại trên bản đã khóa
  SELECT * INTO _profile FROM public.profiles WHERE id = _user_id FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PROFILE_NOT_FOUND: Profile does not exist.';
  END IF;

  IF _profile.deleted_at IS NOT NULL THEN
    RETURN jsonb_build_object('already_anonymized', true, 'left_groups', 0);
  END IF;

  SELECT count(*) INTO _count
  FROM public.groups g
  WHERE g.owner_id = _user_id AND g.status = 'ACTIVE';
  IF _count > 0 THEN
    RAISE EXCEPTION 'OWNER_OF_ACTIVE_GROUP: Transfer ownership of % active group(s) before deleting the account.', _count;
  END IF;

  SELECT count(*) INTO _count
  FROM public.group_balances gb
  WHERE gb.user_id = _user_id AND gb.official_balance <> 0;
  IF _count > 0 THEN
    RAISE EXCEPTION 'NONZERO_BALANCE: Unsettled balance in % group(s).', _count;
  END IF;

  SELECT count(*) INTO _count
  FROM public.payments p
  WHERE p.status = 'PENDING' AND (p.from_id = _user_id OR p.to_id = _user_id);
  IF _count > 0 THEN
    RAISE EXCEPTION 'PENDING_PAYMENTS: % payment(s) are still pending.', _count;
  END IF;

  -- Rời mọi nhóm (giữ dòng group_members để lịch sử vẫn hiện người này)
  FOR _gid, _owner, _gstatus IN
    SELECT gm.group_id, g.owner_id, g.status
    FROM public.group_members gm
    JOIN public.groups g ON g.id = gm.group_id
    WHERE gm.user_id = _user_id AND gm.status = 'ACTIVE'
    ORDER BY gm.group_id
  LOOP
    UPDATE public.group_members
    SET status = 'LEFT', left_at = now()
    WHERE group_id = _gid AND user_id = _user_id;

    INSERT INTO public.activity_logs (group_id, actor_id, action, entity_type, entity_id, after)
    VALUES (_gid, _user_id, 'LEAVE', 'MEMBER', _user_id,
            jsonb_build_object('user_id', _user_id, 'reason', 'ACCOUNT_DELETED'));

    IF _gstatus = 'ACTIVE' THEN
      INSERT INTO public.notifications (user_id, type, group_id, actor_id)
      VALUES (_owner, 'MEMBER_LEFT', _gid, _user_id);
    END IF;

    _left := _left + 1;
  END LOOP;

  -- Lời mời do người này tạo hoặc mời đích danh người này: thu hồi
  UPDATE public.group_invites
  SET revoked_at = now()
  WHERE revoked_at IS NULL
    AND (created_by = _user_id OR invited_user_id = _user_id);

  -- BE-04: đúng tên cột requester_id / addressee_id
  DELETE FROM public.friendships WHERE requester_id = _user_id OR addressee_id = _user_id;
  DELETE FROM public.push_tokens WHERE user_id = _user_id;
  DELETE FROM public.payment_handles WHERE user_id = _user_id;
  DELETE FROM public.notifications WHERE user_id = _user_id;

  UPDATE public.profiles
  SET display_name = 'Người dùng đã xóa',
      avatar_path = NULL,
      searchable = false,
      user_code = 'DEL' || replace(_user_id::text, '-', ''),
      deleted_at = now()
  WHERE id = _user_id;

  RETURN jsonb_build_object('already_anonymized', false, 'left_groups', _left);
END;
$$;


-- ============================================================
-- PART 6: QUYỀN
-- ============================================================

-- 0010 đã đặt ALTER DEFAULT PRIVILEGES (hàm mới không có EXECUTE cho PUBLIC / anon);
-- vẫn thu hồi tường minh để chạy đúng cả trên database chưa có 0010 PART 11.
REVOKE EXECUTE ON FUNCTION public.transfer_ownership(UUID, UUID) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.revoke_invite(UUID) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.accept_invite(TEXT) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.register_push_token(TEXT, TEXT) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.unregister_push_token(TEXT) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.handle_auth_user_deleted() FROM PUBLIC, anon, authenticated;

-- Xóa tài khoản: chỉ Edge Function delete-account (service_role), như 0010
REVOKE EXECUTE ON FUNCTION public.anonymize_account(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.anonymize_account(UUID) TO service_role;

GRANT EXECUTE ON FUNCTION public.transfer_ownership(UUID, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.revoke_invite(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.accept_invite(TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.register_push_token(TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.unregister_push_token(TEXT) TO authenticated;

COMMIT;
