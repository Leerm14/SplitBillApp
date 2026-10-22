-- ============================================================
-- Migration 0012: MVP features (docs/DEV_SplitBill_MVPConThieu_v1.0.md)
--   1. create_group(_name, _description, _simplify_debts) — tạo nhóm đầy đủ một lần (MVP-03)
--   2. update_group(..., _avatar_path, _clear_avatar) — ảnh nhóm trên Cloudinary (MVP-03)
--   3. find_user_by_code(_code) — QR kết bạn, không lọc searchable (MVP-05)
--   4. notifications.invite_id + create_invite báo GROUP_INVITED cho người được mời (MVP-06)
--   5. accept_invite_by_id(_invite_id) — người được mời chấp nhận từ thông báo (MVP-06)
--   6. payment_handles: giới hạn độ dài display_text, xác nhận quyền ghi của chủ (MVP-07)
--
-- Phương án A (mục 4.3): ảnh đại diện + ảnh nhóm lên Cloudinary (public_id lưu vào
-- avatar_path), ảnh hóa đơn giữ Supabase Storage bucket `receipts` — không đổi gì ở đây.
--
-- KHÔNG sửa 0001–0011 (đã chạy trên Supabase). File này chạy lại được nhiều lần
-- (CREATE OR REPLACE, DROP ... IF EXISTS trước CREATE, khối DO kiểm tra catalog) vì có
-- lúc migration được chạy tay qua SQL Editor. Mọi hàm: SECURITY DEFINER SET
-- search_path = '', tên đầy đủ schema, lỗi nghiệp vụ dạng 'CODE: message'
-- (src/api/errors.ts).
-- ============================================================

BEGIN;

-- ============================================================
-- PART 1: create_group — tên, mô tả, công tắc đơn giản hóa (MVP-03, GRP-03, BR-09)
-- ============================================================

-- Bản 1 tham số (0007) bị thay hoàn toàn. Gọi create_group('Tên') vẫn chạy nhờ DEFAULT.
-- Ảnh nhóm không nhận ở đây: public_id phải bắt đầu bằng '<group_id>/' nên chỉ có sau
-- khi nhóm đã tạo → app tạo nhóm, upload, rồi update_group(_avatar_path).
DROP FUNCTION IF EXISTS public.create_group(TEXT);

CREATE OR REPLACE FUNCTION public.create_group(
  _name TEXT,
  _description TEXT DEFAULT '',
  _simplify_debts BOOLEAN DEFAULT true
)
RETURNS public.groups
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  _group public.groups;
  _caller UUID;
  _clean_name TEXT := trim(_name);
BEGIN
  _caller := public.assert_authenticated();

  IF _clean_name IS NULL OR _clean_name = '' THEN
    RAISE EXCEPTION 'INVALID_NAME: Group name cannot be empty.';
  END IF;

  -- invite_code: DEFAULT của cột (0001); status: DEFAULT 'ACTIVE' (0002)
  INSERT INTO public.groups (name, owner_id, description, simplify_debts)
  VALUES (_clean_name, _caller, COALESCE(_description, ''), COALESCE(_simplify_debts, true))
  RETURNING * INTO _group;

  INSERT INTO public.group_members (group_id, user_id, role)
  VALUES (_group.id, _caller, 'owner');

  INSERT INTO public.activity_logs (group_id, actor_id, action, entity_type, entity_id, after)
  VALUES (
    _group.id, _caller, 'CREATE', 'GROUP', _group.id,
    jsonb_build_object('name', _group.name, 'description', _group.description,
                       'simplify_debts', _group.simplify_debts)
  );

  RETURN _group;
END;
$$;


-- ============================================================
-- PART 2: update_group — ảnh nhóm (MVP-03)
-- ============================================================

-- Giữ nguyên hành vi 0010 (NULL = giữ giá trị hiện tại, khóa FOR UPDATE, chỉ chủ nhóm,
-- nhóm ACTIVE). Thêm:
--   _avatar_path: public_id Cloudinary, bắt buộc '<group_id>/...' (cloudinary-sign đặt
--                 '<group_id>/group_<timestamp>').
--   _clear_avatar = true → avatar_path = NULL (ưu tiên hơn _avatar_path).
DROP FUNCTION IF EXISTS public.update_group(UUID, TEXT, TEXT, BOOLEAN);

CREATE OR REPLACE FUNCTION public.update_group(
  _group_id UUID,
  _name TEXT,
  _description TEXT,
  _simplify_debts BOOLEAN,
  _avatar_path TEXT DEFAULT NULL,
  _clear_avatar BOOLEAN DEFAULT false
)
RETURNS public.groups
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  _group public.groups;
  _old public.groups;
  _caller UUID;
  _clear BOOLEAN := COALESCE(_clear_avatar, false);
BEGIN
  _caller := public.assert_authenticated();

  SELECT * INTO _group FROM public.groups WHERE id = _group_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'GROUP_NOT_FOUND: Group does not exist.';
  END IF;

  IF _caller IS DISTINCT FROM _group.owner_id THEN
    RAISE EXCEPTION 'NOT_OWNER: Only the group owner can update group settings.';
  END IF;

  IF _group.status IS DISTINCT FROM 'ACTIVE' THEN
    RAISE EXCEPTION 'GROUP_CLOSED: Group is closed, cannot update.';
  END IF;

  IF _name IS NOT NULL AND trim(_name) = '' THEN
    RAISE EXCEPTION 'INVALID_NAME: Group name cannot be empty.';
  END IF;

  IF _avatar_path IS NOT NULL AND NOT _clear THEN
    IF left(_avatar_path, length(_group_id::text) + 1) IS DISTINCT FROM _group_id::text || '/'
       OR length(_avatar_path) <= length(_group_id::text) + 1
       OR length(_avatar_path) > 255
       OR position('..' IN _avatar_path) > 0 THEN
      RAISE EXCEPTION 'INVALID_AVATAR_PATH: Group image must be stored under the group folder (<group_id>/...).';
    END IF;
  END IF;

  _old := _group;

  UPDATE public.groups
  SET name = COALESCE(trim(_name), name),
      description = COALESCE(_description, description),
      simplify_debts = COALESCE(_simplify_debts, simplify_debts),
      avatar_path = CASE
                      WHEN _clear THEN NULL
                      ELSE COALESCE(_avatar_path, avatar_path)
                    END
  WHERE id = _group_id
  RETURNING * INTO _group;

  INSERT INTO public.activity_logs (group_id, actor_id, action, entity_type, entity_id, before, after)
  VALUES (
    _group_id, _caller, 'UPDATE', 'GROUP', _group_id,
    jsonb_build_object('name', _old.name, 'description', _old.description,
                       'simplify_debts', _old.simplify_debts, 'avatar_path', _old.avatar_path),
    jsonb_build_object('name', _group.name, 'description', _group.description,
                       'simplify_debts', _group.simplify_debts, 'avatar_path', _group.avatar_path)
  );

  RETURN _group;
END;
$$;


-- ============================================================
-- PART 3: find_user_by_code — QR kết bạn (MVP-05, CON-02)
-- ============================================================

-- Khớp CHÍNH XÁC user_code (generate_user_code: 8 ký tự A-Z0-9, viết hoa → so sánh với
-- upper(trim(_code))). KHÔNG lọc searchable: chủ mã tự đưa QR / mã cho người khác quét
-- (khác search_users tìm theo tên). Loại hồ sơ đã xóa (bia mộ 'DEL...') và chính người gọi.
-- Không tìm thấy → 0 dòng (không lỗi). Chỉ trả 4 cột công khai (SEC-04).
DROP FUNCTION IF EXISTS public.find_user_by_code(TEXT);

CREATE OR REPLACE FUNCTION public.find_user_by_code(_code TEXT)
RETURNS TABLE (
  id UUID,
  display_name TEXT,
  user_code TEXT,
  avatar_path TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  _caller UUID;
  _clean TEXT := upper(trim(_code));
BEGIN
  _caller := public.assert_authenticated();

  IF _clean IS NULL OR _clean = '' OR length(_clean) > 64 THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT p.id, p.display_name, p.user_code, p.avatar_path
  FROM public.profiles p
  WHERE p.user_code = _clean
    AND p.deleted_at IS NULL
    AND p.id <> _caller;
END;
$$;


-- ============================================================
-- PART 4: Thông báo lời mời đích danh (MVP-06)
-- ============================================================

-- invite_id: thông báo GROUP_INVITED trỏ tới lời mời (người được mời chưa là thành viên
-- nên KHÔNG đọc được group_invites / token qua RLS → chấp nhận bằng accept_invite_by_id).
-- Xóa lời mời (xóa nhóm) → xóa luôn thông báo.
ALTER TABLE public.notifications
  ADD COLUMN IF NOT EXISTS invite_id UUID REFERENCES public.group_invites(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_notifications_invite_id
  ON public.notifications (invite_id)
  WHERE invite_id IS NOT NULL;

-- Giữ nguyên hành vi 0010 (0011 không đổi create_invite): assert_active_member_of_active_group
-- (khóa groups FOR SHARE), kiểm tra max_uses / expires_hours, người được mời tồn tại và
-- chưa xóa, BE-07 (mời lại người REMOVED chỉ chủ nhóm), token 12 ký tự, nhật ký CREATE.
-- Thêm: _invited_user_id khác NULL → thông báo GROUP_INVITED cho người được mời
-- (actor_id = người mời, group_id, invite_id). Bỏ qua khi tự mời chính mình hoặc người
-- được mời đang là thành viên ACTIVE (không có gì để chấp nhận).
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
  _invite public.group_invites;
  _token TEXT;
  _chars TEXT := 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  _i INT;
  _attempts INT := 0;
  _caller UUID;
  _role TEXT;
BEGIN
  _caller := public.assert_authenticated();
  _role := public.assert_active_member_of_active_group(_group_id);

  IF _max_uses IS NULL OR _max_uses < 1 OR _max_uses > 100 THEN
    RAISE EXCEPTION 'INVALID_MAX_USES: max_uses must be between 1 and 100.';
  END IF;

  IF _expires_hours IS NULL OR _expires_hours < 1 OR _expires_hours > 8760 THEN
    RAISE EXCEPTION 'INVALID_EXPIRES_HOURS: expires_hours must be between 1 and 8760.';
  END IF;

  IF _invited_user_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.profiles
      WHERE id = _invited_user_id AND deleted_at IS NULL
    ) THEN
      RAISE EXCEPTION 'INVALID_USER: The invited user does not exist.';
    END IF;

    IF EXISTS (
      SELECT 1 FROM public.group_members
      WHERE group_id = _group_id AND user_id = _invited_user_id AND status = 'REMOVED'
    ) AND NOT public.is_owner(_group_id) THEN
      RAISE EXCEPTION 'NOT_OWNER: Only the group owner can re-invite a removed member.';
    END IF;
  END IF;

  LOOP
    _token := '';
    FOR _i IN 1..12 LOOP
      _token := _token || substr(_chars, floor(random() * 62 + 1)::int, 1);
    END LOOP;

    EXIT WHEN NOT EXISTS (SELECT 1 FROM public.group_invites WHERE token = _token);

    _attempts := _attempts + 1;
    IF _attempts >= 100 THEN
      RAISE EXCEPTION 'TOKEN_GENERATION_FAILED: Could not generate unique token after 100 attempts.';
    END IF;
  END LOOP;

  INSERT INTO public.group_invites (group_id, token, invited_user_id, created_by, expires_at, max_uses)
  VALUES (
    _group_id, _token, _invited_user_id, _caller,
    now() + make_interval(hours => _expires_hours),
    _max_uses
  )
  RETURNING * INTO _invite;

  INSERT INTO public.activity_logs (group_id, actor_id, action, entity_type, entity_id, after)
  VALUES (
    _group_id, _caller, 'CREATE', 'INVITE', _invite.id,
    jsonb_build_object(
      'invited_user_id', _invited_user_id,
      'max_uses', _max_uses,
      'expires_hours', _expires_hours
    )
  );

  -- MVP-06: báo người được mời (push qua trigger on_notification_inserted → send-push)
  IF _invited_user_id IS NOT NULL
     AND _invited_user_id IS DISTINCT FROM _caller
     AND NOT EXISTS (
       SELECT 1 FROM public.group_members
       WHERE group_id = _group_id AND user_id = _invited_user_id AND status = 'ACTIVE'
     ) THEN
    INSERT INTO public.notifications (user_id, type, group_id, actor_id, invite_id)
    VALUES (_invited_user_id, 'GROUP_INVITED', _group_id, _caller, _invite.id);
  END IF;

  RETURN _invite;
END;
$$;


-- ============================================================
-- PART 5: accept_invite_by_id — chấp nhận từ thông báo GROUP_INVITED (MVP-06)
-- ============================================================

-- Người được mời không đọc được token (group_invites chỉ thành viên đọc được). Hàm này
-- chỉ cho đúng người được mời đích danh (invited_user_id = người gọi), rồi chạy NGUYÊN
-- logic accept_invite(token) (0011: khóa groups FOR SHARE trước, lời mời FOR UPDATE sau,
-- kiểm tra revoked / expired / closed / used_count / BE-07 trên bản đã khóa).
-- Đọc token + invited_user_id KHÔNG khóa: hai cột này không bao giờ đổi sau khi tạo.
DROP FUNCTION IF EXISTS public.accept_invite_by_id(UUID);

CREATE OR REPLACE FUNCTION public.accept_invite_by_id(_invite_id UUID)
RETURNS public.groups
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  _caller UUID;
  _token TEXT;
  _invited UUID;
BEGIN
  _caller := public.assert_authenticated();

  SELECT gi.token, gi.invited_user_id INTO _token, _invited
  FROM public.group_invites gi
  WHERE gi.id = _invite_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'INVITE_NOT_FOUND: Invite does not exist.';
  END IF;

  IF _invited IS NULL OR _invited IS DISTINCT FROM _caller THEN
    RAISE EXCEPTION 'INVITE_NOT_FOR_YOU: This invite is not intended for you.';
  END IF;

  RETURN public.accept_invite(_token);
END;
$$;


-- ============================================================
-- PART 6: payment_handles (MVP-07)
-- ============================================================

-- display_text: 1..200 ký tự, không chỉ khoảng trắng. Thêm NOT VALID (không quét bảng
-- khi thêm), rồi VALIDATE chỉ khi không có dòng cũ vi phạm; có dòng vi phạm → WARNING,
-- ràng buộc vẫn áp cho mọi INSERT/UPDATE mới. Không tự sửa dữ liệu người dùng.
DO $$
DECLARE
  _bad INT;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.payment_handles'::regclass
      AND conname = 'payment_handles_display_text_length'
  ) THEN
    ALTER TABLE public.payment_handles
      ADD CONSTRAINT payment_handles_display_text_length
      CHECK (char_length(display_text) <= 200 AND char_length(btrim(display_text)) >= 1)
      NOT VALID;
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.payment_handles'::regclass
      AND conname = 'payment_handles_display_text_length'
      AND NOT convalidated
  ) THEN
    SELECT count(*) INTO _bad
    FROM public.payment_handles
    WHERE NOT (char_length(display_text) <= 200 AND char_length(btrim(display_text)) >= 1);

    IF _bad = 0 THEN
      ALTER TABLE public.payment_handles VALIDATE CONSTRAINT payment_handles_display_text_length;
    ELSE
      RAISE WARNING 'PAYMENT_HANDLES_INVALID_ROWS: % existing payment_handles row(s) violate the display_text length check; constraint left NOT VALID (new writes are still checked).', _bad;
    END IF;
  END IF;
END $$;

-- Chủ sở hữu thêm / sửa / xóa trực tiếp qua bảng (policy "Owner can manage own
-- payment_handles" của 0006, USING + WITH CHECK user_id = auth.uid()). 0010 PART 11
-- không thu hồi quyền ghi bảng này; cấp lại tường minh để không phụ thuộc quyền mặc
-- định của Supabase. TRUNCATE / REFERENCES / TRIGGER vẫn bị thu hồi (0010).
GRANT SELECT, INSERT, UPDATE, DELETE ON public.payment_handles TO authenticated;


-- ============================================================
-- PART 7: QUYỀN
-- ============================================================

-- 0010 đã đặt ALTER DEFAULT PRIVILEGES; vẫn thu hồi tường minh (giống 0011).
REVOKE EXECUTE ON FUNCTION public.create_group(TEXT, TEXT, BOOLEAN) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.update_group(UUID, TEXT, TEXT, BOOLEAN, TEXT, BOOLEAN) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.find_user_by_code(TEXT) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.create_invite(UUID, UUID, INTEGER, INTEGER) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.accept_invite_by_id(UUID) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.create_group(TEXT, TEXT, BOOLEAN) TO authenticated;
GRANT EXECUTE ON FUNCTION public.update_group(UUID, TEXT, TEXT, BOOLEAN, TEXT, BOOLEAN) TO authenticated;
GRANT EXECUTE ON FUNCTION public.find_user_by_code(TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.create_invite(UUID, UUID, INTEGER, INTEGER) TO authenticated;
GRANT EXECUTE ON FUNCTION public.accept_invite_by_id(UUID) TO authenticated;

COMMIT;
