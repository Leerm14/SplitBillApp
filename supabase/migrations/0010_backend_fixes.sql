-- ============================================================
-- Migration 0010: Backend fixes (vòng 3)
-- Fixes: SEC-02, SEC-05 / NEW-02, SEC-09, BE-03, BE-04/BE-05, BE-07,
--        BE-08, BE-09 / NEW-06, BE-12, CFG-04 / NEW-09, NEW-08,
--        APP-05 (server: ERRCODE PT409), §7 is_owner()
--
-- Không sửa 0001–0009 (có thể đã chạy trên Supabase). Mọi hàm ở đây:
-- SECURITY DEFINER SET search_path = '' và lỗi nghiệp vụ dạng 'CODE: message'
-- (app phân loại lỗi theo tiền tố này — src/api/errors.ts).
-- ============================================================

BEGIN;

-- ============================================================
-- PART 0: EXTENSIONS
-- ============================================================

-- CFG-04: trigger push gọi net.http_post (pg_net). 0008 đã tạo, lặp lại cho chắc.
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;


-- ============================================================
-- PART 1: SCHEMA — idempotency theo người gọi (BE-09, NEW-06)
-- ============================================================

-- UNIQUE toàn bảng trên idempotency_key (0001) làm hai người khác nhau trùng key
-- thì người sau nhận 23505 (expenses) hoặc JSON toàn null (payments).
-- Đổi thành UNIQUE theo (người tạo, key). Tìm constraint theo cột thay vì đoán tên.
DO $$
DECLARE
  _c RECORD;
BEGIN
  FOR _c IN
    SELECT con.conname, con.conrelid::regclass AS tbl
    FROM pg_constraint con
    WHERE con.contype = 'u'
      AND con.conrelid IN ('public.expenses'::regclass, 'public.payments'::regclass)
      AND con.conkey = ARRAY[(
        SELECT a.attnum FROM pg_attribute a
        WHERE a.attrelid = con.conrelid AND a.attname = 'idempotency_key'
      )]::int2[]
  LOOP
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', _c.tbl, _c.conname);
  END LOOP;
END $$;

-- Chạy lại được: database từng chạy dở 0010 qua SQL Editor có thể đã có constraint
-- (hoặc chỉ còn index cùng tên) → bỏ qua nếu đã có constraint, bỏ index mồ côi rồi tạo.
DO $$
DECLARE
  _t RECORD;
BEGIN
  FOR _t IN
    SELECT * FROM (VALUES
      ('public.expenses'::regclass, 'expenses_created_by_idempotency_key_key', 'created_by'),
      ('public.payments'::regclass, 'payments_from_id_idempotency_key_key', 'from_id')
    ) AS v(tbl, conname, owner_col)
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint WHERE conrelid = _t.tbl AND conname = _t.conname
    ) THEN
      EXECUTE format('DROP INDEX IF EXISTS public.%I', _t.conname);
      EXECUTE format('ALTER TABLE %s ADD CONSTRAINT %I UNIQUE (%I, idempotency_key)',
                     _t.tbl, _t.conname, _t.owner_col);
    END IF;
  END LOOP;
END $$;

-- Index cũ không UNIQUE (0004, 0007) nay thừa — UNIQUE ở trên đã tạo index.
DROP INDEX IF EXISTS public.idx_expenses_idempotency;
DROP INDEX IF EXISTS public.idx_expenses_created_by_idempotency;
DROP INDEX IF EXISTS public.idx_payments_from_id_idempotency;


-- ============================================================
-- PART 2: SCHEMA — profiles là "bia mộ" khi xóa tài khoản (BE-05)
-- ============================================================

-- 0001: profiles.id → auth.users ON DELETE CASCADE. Xóa user Auth sẽ xóa hồ sơ, mà
-- hồ sơ được expenses, payments, activity_logs, groups.owner_id tham chiếu không
-- ON DELETE → lỗi FK, tài khoản không xóa được. Bỏ FK: hồ sơ ẩn danh ở lại làm bia mộ.
DO $$
DECLARE
  _c RECORD;
BEGIN
  FOR _c IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'public.profiles'::regclass
      AND contype = 'f'
      AND confrelid = 'auth.users'::regclass
  LOOP
    EXECUTE format('ALTER TABLE public.profiles DROP CONSTRAINT %I', _c.conname);
  END LOOP;
END $$;

-- Lưới an toàn: user Auth bị xóa ngoài luồng delete-account (vd. từ Dashboard) thì
-- hồ sơ vẫn được ẩn danh, không bao giờ bị xóa cứng.
CREATE OR REPLACE FUNCTION public.handle_auth_user_deleted()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  UPDATE public.profiles
  SET display_name = 'Người dùng đã xóa',
      avatar_path = NULL,
      searchable = false,
      user_code = CASE WHEN deleted_at IS NULL
                       THEN 'DEL' || replace(OLD.id::text, '-', '')
                       ELSE user_code END,
      deleted_at = COALESCE(deleted_at, now())
  WHERE id = OLD.id;

  DELETE FROM public.push_tokens WHERE user_id = OLD.id;
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_deleted ON auth.users;
CREATE TRIGGER on_auth_user_deleted
  AFTER DELETE ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_auth_user_deleted();

-- Hàm trigger từ 0005. 0007 đã bỏ trigger, nhưng có database vẫn còn trigger
-- (ví dụ 0005 được chạy lại sau 0007) → bỏ trigger trước rồi mới bỏ hàm.
-- Trigger này tạo thông báo khi INSERT payment; create_payment (0007) đã tự tạo
-- thông báo, giữ trigger sẽ gửi trùng.
DROP TRIGGER IF EXISTS on_payment_created ON public.payments;
DROP FUNCTION IF EXISTS public.handle_payment_created();

-- Bản create_expense 6 tham số của 0001 vẫn còn song song với bản 9 tham số:
-- không kiểm tra đăng nhập, tra idempotency toàn hệ thống (lộ khoản chi nhóm khác),
-- không chặn nhóm CLOSED. Bỏ hẳn.
DROP FUNCTION IF EXISTS public.create_expense(UUID, UUID, BIGINT, TEXT, JSONB, TEXT);


-- ============================================================
-- PART 3: HELPERS (SEC-02, BE-03, BE-08, §7)
-- ============================================================

-- SEC-02: chặn cả tài khoản đã ẩn danh (giữa lúc ẩn danh và lúc xóa user Auth,
-- token cũ vẫn còn hạn).
CREATE OR REPLACE FUNCTION public.assert_authenticated()
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  _uid UUID := auth.uid();
BEGIN
  IF _uid IS NULL THEN
    RAISE EXCEPTION 'NOT_AUTHENTICATED: You must be logged in to perform this action.';
  END IF;

  IF EXISTS (SELECT 1 FROM public.profiles WHERE id = _uid AND deleted_at IS NOT NULL) THEN
    RAISE EXCEPTION 'ACCOUNT_DELETED: This account has been deleted.';
  END IF;

  RETURN _uid;
END;
$$;

-- BE-03 + BE-08: kiểm tra nhóm ACTIVE + người gọi là thành viên ACTIVE, và
-- KHÓA dòng groups FOR SHARE tới hết giao dịch.
-- leave_group / remove_member / close_group / anonymize_account khóa cùng dòng
-- FOR UPDATE (xung đột với FOR SHARE) → mọi RPC ghi khoản chi / thanh toán
-- (create_expense, update_expense, cancel_expense, create_payment, confirm_payment,
-- reject_payment, dispute_payment, cancel_payment, create_invite, revoke_invite)
-- chạy tuần tự với bước kiểm tra BR-11, không chen vào giữa được. Các RPC ghi
-- giữ FOR SHARE với nhau nên không chặn lẫn nhau.
CREATE OR REPLACE FUNCTION public.assert_active_member_of_active_group(_group_id UUID)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  _uid UUID := public.assert_authenticated();
  _group_status TEXT;
  _member_role TEXT;
BEGIN
  SELECT status INTO _group_status
  FROM public.groups
  WHERE id = _group_id
  FOR SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'GROUP_NOT_FOUND: Group does not exist.';
  END IF;

  IF _group_status IS DISTINCT FROM 'ACTIVE' THEN
    RAISE EXCEPTION 'GROUP_CLOSED: Group is closed. No write operations allowed.';
  END IF;

  SELECT gm.role INTO _member_role
  FROM public.group_members gm
  WHERE gm.group_id = _group_id
    AND gm.user_id = _uid
    AND gm.status = 'ACTIVE';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'NOT_MEMBER: You are not an active member of this group.';
  END IF;

  RETURN _member_role;
END;
$$;

-- §7 (DEV mục 2): is_owner() — dùng trong RPC và policy Storage.
CREATE OR REPLACE FUNCTION public.is_owner(_group_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER SET search_path = ''
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.groups g
    WHERE g.id = _group_id
      AND g.owner_id = auth.uid()
  );
$$;


-- ============================================================
-- PART 4: KHOẢN CHI (BE-08, BE-09, APP-05, SEC-09)
-- ============================================================

-- BE-09: idempotency theo (created_by, key) + bắt unique_violation khi hai lần gọi
-- đồng thời cùng key (lần thua trả bản ghi của lần thắng thay vì lỗi 23505).
-- BE-08: khóa groups FOR SHARE qua assert_active_member_of_active_group.
CREATE OR REPLACE FUNCTION public.create_expense(
  _group_id UUID,
  _paid_by UUID,
  _amount BIGINT,
  _description TEXT,
  _shares JSONB,
  _idempotency_key TEXT,
  _split_method TEXT DEFAULT 'EQUAL',
  _note TEXT DEFAULT '',
  _receipt_path TEXT DEFAULT NULL
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
  _caller UUID;
  _role TEXT;
BEGIN
  _caller := public.assert_authenticated();

  IF _idempotency_key IS NULL OR trim(_idempotency_key) = '' THEN
    RAISE EXCEPTION 'INVALID_IDEMPOTENCY_KEY: idempotency_key is required.';
  END IF;

  -- BE-09: chỉ tra trong khoản chi do CHÍNH người gọi tạo → không lộ dữ liệu nhóm khác.
  -- Tra trước kiểm tra thành viên để lần gửi lại từ hàng đợi offline vẫn nhận bản cũ.
  SELECT * INTO _expense
  FROM public.expenses
  WHERE created_by = _caller
    AND idempotency_key = _idempotency_key;
  IF FOUND THEN
    IF _expense.group_id IS DISTINCT FROM _group_id THEN
      RAISE EXCEPTION 'IDEMPOTENCY_KEY_REUSED: This idempotency key was already used for another expense.';
    END IF;
    RETURN _expense;
  END IF;

  -- BE-03 + BE-08: nhóm ACTIVE, người gọi ACTIVE, khóa groups FOR SHARE
  _role := public.assert_active_member_of_active_group(_group_id);

  IF NOT EXISTS (
    SELECT 1 FROM public.group_members
    WHERE group_id = _group_id AND user_id = _paid_by AND status = 'ACTIVE'
  ) THEN
    RAISE EXCEPTION 'PAYER_NOT_MEMBER: Payer is not an active member of this group.';
  END IF;

  IF _split_method IS NULL OR _split_method NOT IN ('EQUAL', 'PERCENT', 'EXACT') THEN
    RAISE EXCEPTION 'INVALID_SPLIT_METHOD: Invalid split method: %', _split_method;
  END IF;

  IF _amount IS NULL OR _amount <= 0 THEN
    RAISE EXCEPTION 'INVALID_AMOUNT: Amount must be a positive integer.';
  END IF;

  IF _shares IS NULL OR jsonb_typeof(_shares) IS DISTINCT FROM 'array' OR jsonb_array_length(_shares) = 0 THEN
    RAISE EXCEPTION 'INVALID_SHARES: Shares must be a non-empty array.';
  END IF;

  IF (SELECT count(DISTINCT s ->> 'userId') FROM jsonb_array_elements(_shares) s) <> jsonb_array_length(_shares) THEN
    RAISE EXCEPTION 'DUPLICATE_SHARE_USER: Each user can appear only once in shares.';
  END IF;

  -- SEC-09: ảnh hóa đơn phải nằm trong thư mục của nhóm
  IF _receipt_path IS NOT NULL
     AND left(_receipt_path, length(_group_id::text) + 1) IS DISTINCT FROM _group_id::text || '/' THEN
    RAISE EXCEPTION 'INVALID_RECEIPT_PATH: Receipt must be stored under the group folder.';
  END IF;

  -- BE-09: lần gọi đồng thời cùng key → 23505 ở đây; trả bản ghi đã có
  BEGIN
    INSERT INTO public.expenses (
      group_id, paid_by, amount, description, created_by, idempotency_key,
      split_method, note, receipt_path
    )
    VALUES (
      _group_id, _paid_by, _amount, COALESCE(_description, ''), _caller, _idempotency_key,
      _split_method, COALESCE(_note, ''), _receipt_path
    )
    RETURNING * INTO _expense;
  EXCEPTION
    WHEN unique_violation THEN
      SELECT * INTO _expense
      FROM public.expenses
      WHERE created_by = _caller
        AND idempotency_key = _idempotency_key;

      IF NOT FOUND THEN
        RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT: Could not create or find the expense for this idempotency key.';
      END IF;
      IF _expense.group_id IS DISTINCT FROM _group_id THEN
        RAISE EXCEPTION 'IDEMPOTENCY_KEY_REUSED: This idempotency key was already used for another expense.';
      END IF;
      RETURN _expense;
  END;

  FOR _share IN SELECT * FROM jsonb_array_elements(_shares)
  LOOP
    _share_user_id := (_share ->> 'userId')::UUID;
    _share_amount := (_share ->> 'amount')::BIGINT;

    IF _share_amount IS NULL OR _share_amount < 0 THEN
      RAISE EXCEPTION 'INVALID_SHARE_AMOUNT: Share amounts must be non-negative integers.';
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM public.group_members
      WHERE group_id = _group_id AND user_id = _share_user_id AND status = 'ACTIVE'
    ) THEN
      RAISE EXCEPTION 'SHARE_USER_NOT_MEMBER: User % is not an active member of this group.', _share_user_id;
    END IF;

    INSERT INTO public.expense_shares (expense_id, user_id, amount, percent_bp)
    VALUES (_expense.id, _share_user_id, _share_amount, (_share ->> 'percentBp')::INTEGER);

    _share_total := _share_total + _share_amount;
  END LOOP;

  IF _share_total <> _amount THEN
    RAISE EXCEPTION 'SHARE_MISMATCH: Total shares (%) does not equal expense amount (%)', _share_total, _amount;
  END IF;

  INSERT INTO public.activity_logs (group_id, actor_id, action, entity_type, entity_id, after)
  VALUES (
    _group_id, _caller, 'EXPENSE_CREATED', 'EXPENSE', _expense.id,
    jsonb_build_object(
      'amount', _amount,
      'description', _expense.description,
      'paid_by', _paid_by,
      'split_method', _split_method
    )
  );

  INSERT INTO public.notifications (user_id, type, group_id, expense_id)
  SELECT gm.user_id, 'EXPENSE_CREATED', _group_id, _expense.id
  FROM public.group_members gm
  WHERE gm.group_id = _group_id
    AND gm.status = 'ACTIVE'
    AND gm.user_id <> _caller;

  RETURN _expense;
END;
$$;

-- APP-05: xung đột version báo ERRCODE 'PT409' (PostgREST trả HTTP 409) kèm tiền tố
-- 'VERSION_CONFLICT:' — cả khi kiểm tra tường minh lẫn khi UPDATE ... WHERE version trượt.
-- BE-08: khóa groups FOR SHARE. BE-03: không sửa khoản chi có người đã rời nhóm
-- (đổi phần chia sẽ đổi số dư của người LEFT mà không ai thấy).
CREATE OR REPLACE FUNCTION public.update_expense(
  _expense_id UUID,
  _expected_version INTEGER,
  _paid_by UUID,
  _amount BIGINT,
  _description TEXT,
  _split_method TEXT,
  _note TEXT,
  _shares JSONB,
  _receipt_path TEXT DEFAULT NULL
)
RETURNS public.expenses
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  _expense public.expenses;
  _group public.groups;
  _caller UUID;
  _role TEXT;
  _share JSONB;
  _share_total BIGINT := 0;
  _share_user_id UUID;
  _share_amount BIGINT;
  _before JSONB;
  _old_shares JSONB;
  _update_count INT;
BEGIN
  _caller := public.assert_authenticated();

  -- BE-02: khóa dòng khoản chi
  SELECT * INTO _expense
  FROM public.expenses
  WHERE id = _expense_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'EXPENSE_NOT_FOUND: Expense does not exist.';
  END IF;

  -- BE-03 + BE-08
  _role := public.assert_active_member_of_active_group(_expense.group_id);

  SELECT * INTO _group FROM public.groups WHERE id = _expense.group_id;

  IF _caller IS DISTINCT FROM _expense.created_by AND _caller IS DISTINCT FROM _group.owner_id THEN
    RAISE EXCEPTION 'NOT_AUTHORIZED: Only the creator or group owner can edit this expense.';
  END IF;

  IF _expense.status IS DISTINCT FROM 'ACTIVE' THEN
    RAISE EXCEPTION 'EXPENSE_CANCELLED: Expense is cancelled, cannot edit.';
  END IF;

  -- APP-05: kiểm tra version tường minh
  IF _expected_version IS NULL OR _expense.version IS DISTINCT FROM _expected_version THEN
    RAISE EXCEPTION 'VERSION_CONFLICT: Expense was modified by someone else (expected version %, current %). Please reload and retry.',
      _expected_version, _expense.version
      USING ERRCODE = 'PT409';
  END IF;

  -- Người trả cũ và mọi người chịu cũ phải còn ACTIVE
  IF EXISTS (
    SELECT 1
    FROM (
      SELECT _expense.paid_by AS uid
      UNION
      SELECT es.user_id FROM public.expense_shares es WHERE es.expense_id = _expense_id
    ) p
    WHERE NOT EXISTS (
      SELECT 1 FROM public.group_members gm
      WHERE gm.group_id = _expense.group_id AND gm.user_id = p.uid AND gm.status = 'ACTIVE'
    )
  ) THEN
    RAISE EXCEPTION 'PARTICIPANT_NOT_ACTIVE: Someone in this expense has left the group; it can no longer be changed.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.group_members
    WHERE group_id = _expense.group_id AND user_id = _paid_by AND status = 'ACTIVE'
  ) THEN
    RAISE EXCEPTION 'PAYER_NOT_MEMBER: Payer is not an active member of this group.';
  END IF;

  IF _split_method IS NULL OR _split_method NOT IN ('EQUAL', 'PERCENT', 'EXACT') THEN
    RAISE EXCEPTION 'INVALID_SPLIT_METHOD: Invalid split method: %', _split_method;
  END IF;

  IF _amount IS NULL OR _amount <= 0 THEN
    RAISE EXCEPTION 'INVALID_AMOUNT: Amount must be a positive integer.';
  END IF;

  IF _shares IS NULL OR jsonb_typeof(_shares) IS DISTINCT FROM 'array' OR jsonb_array_length(_shares) = 0 THEN
    RAISE EXCEPTION 'INVALID_SHARES: Shares must be a non-empty array.';
  END IF;

  IF (SELECT count(DISTINCT s ->> 'userId') FROM jsonb_array_elements(_shares) s) <> jsonb_array_length(_shares) THEN
    RAISE EXCEPTION 'DUPLICATE_SHARE_USER: Each user can appear only once in shares.';
  END IF;

  IF _receipt_path IS NOT NULL
     AND left(_receipt_path, length(_expense.group_id::text) + 1) IS DISTINCT FROM _expense.group_id::text || '/' THEN
    RAISE EXCEPTION 'INVALID_RECEIPT_PATH: Receipt must be stored under the group folder.';
  END IF;

  SELECT jsonb_agg(jsonb_build_object('userId', es.user_id, 'amount', es.amount, 'percentBp', es.percent_bp))
  INTO _old_shares
  FROM public.expense_shares es
  WHERE es.expense_id = _expense_id;

  _before := jsonb_build_object(
    'amount', _expense.amount,
    'description', _expense.description,
    'paid_by', _expense.paid_by,
    'split_method', _expense.split_method,
    'note', _expense.note,
    'receipt_path', _expense.receipt_path,
    'shares', COALESCE(_old_shares, '[]'::jsonb)
  );

  FOR _share IN SELECT * FROM jsonb_array_elements(_shares)
  LOOP
    _share_user_id := (_share ->> 'userId')::UUID;
    _share_amount := (_share ->> 'amount')::BIGINT;

    IF _share_amount IS NULL OR _share_amount < 0 THEN
      RAISE EXCEPTION 'INVALID_SHARE_AMOUNT: Share amounts must be non-negative integers.';
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM public.group_members
      WHERE group_id = _expense.group_id AND user_id = _share_user_id AND status = 'ACTIVE'
    ) THEN
      RAISE EXCEPTION 'SHARE_USER_NOT_MEMBER: User % is not an active member of this group.', _share_user_id;
    END IF;

    _share_total := _share_total + _share_amount;
  END LOOP;

  IF _share_total <> _amount THEN
    RAISE EXCEPTION 'SHARE_MISMATCH: Total shares (%) does not equal expense amount (%)', _share_total, _amount;
  END IF;

  UPDATE public.expenses
  SET paid_by = _paid_by,
      amount = _amount,
      description = COALESCE(_description, ''),
      split_method = _split_method,
      note = COALESCE(_note, ''),
      receipt_path = _receipt_path,
      version = version + 1,
      updated_at = now()
  WHERE id = _expense_id
    AND version = _expected_version
  RETURNING * INTO _expense;

  GET DIAGNOSTICS _update_count = ROW_COUNT;
  IF _update_count = 0 THEN
    RAISE EXCEPTION 'VERSION_CONFLICT: Expense was modified concurrently. Please reload and retry.'
      USING ERRCODE = 'PT409';
  END IF;

  DELETE FROM public.expense_shares WHERE expense_id = _expense_id;

  FOR _share IN SELECT * FROM jsonb_array_elements(_shares)
  LOOP
    INSERT INTO public.expense_shares (expense_id, user_id, amount, percent_bp)
    VALUES (
      _expense_id,
      (_share ->> 'userId')::UUID,
      (_share ->> 'amount')::BIGINT,
      (_share ->> 'percentBp')::INTEGER
    );
  END LOOP;

  INSERT INTO public.activity_logs (group_id, actor_id, action, entity_type, entity_id, before, after)
  VALUES (
    _expense.group_id, _caller, 'EXPENSE_UPDATED', 'EXPENSE', _expense_id, _before,
    jsonb_build_object(
      'amount', _amount,
      'description', _expense.description,
      'paid_by', _paid_by,
      'split_method', _split_method,
      'note', _expense.note,
      'receipt_path', _receipt_path,
      'shares', _shares
    )
  );

  INSERT INTO public.notifications (user_id, type, group_id, expense_id)
  SELECT gm.user_id, 'EXPENSE_UPDATED', _expense.group_id, _expense_id
  FROM public.group_members gm
  WHERE gm.group_id = _expense.group_id
    AND gm.status = 'ACTIVE'
    AND gm.user_id <> _caller;

  RETURN _expense;
END;
$$;

-- BE-08: khóa khoản chi FOR UPDATE (hai lần hủy đồng thời không ghi nhật ký hai lần)
-- và khóa groups FOR SHARE. BE-03: kiểm tra quyền trước khi trả kết quả idempotent;
-- không hủy khoản chi có người đã rời nhóm.
CREATE OR REPLACE FUNCTION public.cancel_expense(_expense_id UUID)
RETURNS public.expenses
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  _expense public.expenses;
  _group public.groups;
  _caller UUID;
  _role TEXT;
BEGIN
  _caller := public.assert_authenticated();

  SELECT * INTO _expense
  FROM public.expenses
  WHERE id = _expense_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'EXPENSE_NOT_FOUND: Expense does not exist.';
  END IF;

  _role := public.assert_active_member_of_active_group(_expense.group_id);

  SELECT * INTO _group FROM public.groups WHERE id = _expense.group_id;

  IF _caller IS DISTINCT FROM _expense.created_by AND _caller IS DISTINCT FROM _group.owner_id THEN
    RAISE EXCEPTION 'NOT_AUTHORIZED: Only the creator or group owner can cancel this expense.';
  END IF;

  -- EXP-07: đã hủy thì bỏ qua, không trừ lần hai
  IF _expense.status = 'CANCELLED' THEN
    RETURN _expense;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM (
      SELECT _expense.paid_by AS uid
      UNION
      SELECT es.user_id FROM public.expense_shares es WHERE es.expense_id = _expense_id
    ) p
    WHERE NOT EXISTS (
      SELECT 1 FROM public.group_members gm
      WHERE gm.group_id = _expense.group_id AND gm.user_id = p.uid AND gm.status = 'ACTIVE'
    )
  ) THEN
    RAISE EXCEPTION 'PARTICIPANT_NOT_ACTIVE: Someone in this expense has left the group; it can no longer be changed.';
  END IF;

  UPDATE public.expenses
  SET status = 'CANCELLED',
      cancelled_at = now(),
      updated_at = now()
  WHERE id = _expense_id
  RETURNING * INTO _expense;

  INSERT INTO public.activity_logs (group_id, actor_id, action, entity_type, entity_id, after)
  VALUES (
    _expense.group_id, _caller, 'EXPENSE_CANCELLED', 'EXPENSE', _expense_id,
    jsonb_build_object(
      'amount', _expense.amount,
      'description', _expense.description,
      'paid_by', _expense.paid_by
    )
  );

  INSERT INTO public.notifications (user_id, type, group_id, expense_id)
  SELECT gm.user_id, 'EXPENSE_CANCELLED', _expense.group_id, _expense_id
  FROM public.group_members gm
  WHERE gm.group_id = _expense.group_id
    AND gm.status = 'ACTIVE'
    AND gm.user_id <> _caller;

  RETURN _expense;
END;
$$;


-- ============================================================
-- PART 5: THANH TOÁN (BE-08, BE-09 / NEW-06)
-- ============================================================

-- NEW-06: UNIQUE (from_id, idempotency_key); nhánh bắt unique_violation không tìm
-- thấy bản ghi thì RAISE (trước đây trả JSON toàn null → app tưởng đã gửi).
-- Key trùng nhưng khác nhóm / người nhận / số tiền → IDEMPOTENCY_KEY_REUSED.
-- BE-08: khóa groups FOR SHARE (confirm/reject/dispute/cancel_payment khóa qua
-- assert_active_member_of_active_group, không cần định nghĩa lại).
CREATE OR REPLACE FUNCTION public.create_payment(
  _group_id UUID,
  _to_id UUID,
  _amount BIGINT,
  _note TEXT DEFAULT NULL,
  _idempotency_key TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  _caller UUID;
  _role TEXT;
  _key TEXT;
  _payment public.payments;
BEGIN
  _caller := public.assert_authenticated();
  _key := NULLIF(trim(_idempotency_key), '');

  -- Chỉ tra thanh toán do chính người gọi gửi (không lộ dữ liệu người khác)
  IF _key IS NOT NULL THEN
    SELECT * INTO _payment
    FROM public.payments
    WHERE from_id = _caller
      AND idempotency_key = _key;

    IF FOUND THEN
      IF _payment.group_id IS DISTINCT FROM _group_id
         OR _payment.to_id IS DISTINCT FROM _to_id
         OR _payment.amount IS DISTINCT FROM _amount THEN
        RAISE EXCEPTION 'IDEMPOTENCY_KEY_REUSED: This idempotency key was already used for another payment.';
      END IF;
      RETURN to_jsonb(_payment);
    END IF;
  END IF;

  -- BE-03 + BE-08
  _role := public.assert_active_member_of_active_group(_group_id);

  IF _caller IS NOT DISTINCT FROM _to_id THEN
    RAISE EXCEPTION 'SELF_PAYMENT: Cannot create a payment to yourself.';
  END IF;

  IF _amount IS NULL OR _amount <= 0 THEN
    RAISE EXCEPTION 'INVALID_AMOUNT: Amount must be a positive integer.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.group_members
    WHERE group_id = _group_id AND user_id = _to_id AND status = 'ACTIVE'
  ) THEN
    RAISE EXCEPTION 'RECEIVER_NOT_MEMBER: Receiver is not an active member of this group.';
  END IF;

  -- payments.idempotency_key NOT NULL (0001): không có key thì sinh key riêng
  -- (không idempotent, nhưng không lỗi 23502).
  IF _key IS NULL THEN
    _key := gen_random_uuid()::text;
  END IF;

  BEGIN
    INSERT INTO public.payments (group_id, from_id, to_id, amount, status, note, idempotency_key)
    VALUES (_group_id, _caller, _to_id, _amount, 'PENDING', COALESCE(_note, ''), _key)
    RETURNING * INTO _payment;
  EXCEPTION
    WHEN unique_violation THEN
      SELECT * INTO _payment
      FROM public.payments
      WHERE from_id = _caller
        AND idempotency_key = _key;

      IF NOT FOUND THEN
        RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT: Could not create or find the payment for this idempotency key.';
      END IF;
      IF _payment.group_id IS DISTINCT FROM _group_id
         OR _payment.to_id IS DISTINCT FROM _to_id
         OR _payment.amount IS DISTINCT FROM _amount THEN
        RAISE EXCEPTION 'IDEMPOTENCY_KEY_REUSED: This idempotency key was already used for another payment.';
      END IF;
      RETURN to_jsonb(_payment);
  END;

  INSERT INTO public.activity_logs (group_id, actor_id, action, entity_type, entity_id, after)
  VALUES (
    _group_id, _caller, 'PAYMENT_CREATED', 'PAYMENT', _payment.id,
    jsonb_build_object(
      'amount', _payment.amount,
      'from_id', _caller,
      'to_id', _to_id,
      'note', _payment.note
    )
  );

  INSERT INTO public.notifications (user_id, type, group_id, payment_id)
  VALUES (_to_id, 'PAYMENT_CREATED', _group_id, _payment.id);

  RETURN to_jsonb(_payment);
END;
$$;


-- ============================================================
-- PART 6: NHÓM VÀ LỜI MỜI (NEW-08, BE-03, BE-07)
-- ============================================================

-- NEW-08 (contract #3): tham số NULL = giữ giá trị hiện tại.
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
  _old public.groups;
  _caller UUID;
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

  _old := _group;

  UPDATE public.groups
  SET name = COALESCE(trim(_name), name),
      description = COALESCE(_description, description),
      simplify_debts = COALESCE(_simplify_debts, simplify_debts)
  WHERE id = _group_id
  RETURNING * INTO _group;

  INSERT INTO public.activity_logs (group_id, actor_id, action, entity_type, entity_id, before, after)
  VALUES (
    _group_id, _caller, 'UPDATE', 'GROUP', _group_id,
    jsonb_build_object('name', _old.name, 'description', _old.description, 'simplify_debts', _old.simplify_debts),
    jsonb_build_object('name', _group.name, 'description', _group.description, 'simplify_debts', _group.simplify_debts)
  );

  RETURN _group;
END;
$$;

-- BE-03: chỉ thành viên ACTIVE của nhóm ACTIVE mới thu hồi được lời mời
-- (kiểm tra trước nhánh idempotent để người ngoài không dò được lời mời).
CREATE OR REPLACE FUNCTION public.revoke_invite(_invite_id UUID)
RETURNS public.group_invites
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  _invite public.group_invites;
  _group public.groups;
  _caller UUID;
  _role TEXT;
BEGIN
  _caller := public.assert_authenticated();

  SELECT * INTO _invite FROM public.group_invites WHERE id = _invite_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'INVITE_NOT_FOUND: Invite does not exist.';
  END IF;

  _role := public.assert_active_member_of_active_group(_invite.group_id);

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

-- BE-07: lời mời đích danh một người đã bị REMOVED chỉ chủ nhóm được tạo.
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

  RETURN _invite;
END;
$$;

-- BE-07: người REMOVED vào lại được khi dùng lời mời ĐÍCH DANH họ, do chủ nhóm
-- (hiện tại) tạo. Lời mời mở và mã nhóm vẫn bị chặn. Khóa groups FOR SHARE để
-- không vào được nhóm đang đóng (close_group giữ FOR UPDATE).
CREATE OR REPLACE FUNCTION public.accept_invite(_token TEXT)
RETURNS public.groups
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  _invite public.group_invites;
  _group public.groups;
  _existing_member public.group_members;
  _is_existing BOOLEAN;
  _caller UUID;
BEGIN
  _caller := public.assert_authenticated();

  -- BE-06: khóa lời mời
  SELECT * INTO _invite
  FROM public.group_invites
  WHERE token = _token
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

  SELECT * INTO _group FROM public.groups WHERE id = _invite.group_id FOR SHARE;

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

-- BE-07: mã nhóm tĩnh vẫn chặn REMOVED; thêm khóa FOR SHARE như accept_invite.
CREATE OR REPLACE FUNCTION public.join_group(_code TEXT)
RETURNS public.groups
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  _group public.groups;
  _existing_member public.group_members;
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

  IF FOUND THEN
    IF _existing_member.status = 'ACTIVE' THEN
      RETURN _group;
    END IF;

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

  INSERT INTO public.notifications (user_id, type, group_id, actor_id)
  VALUES (_group.owner_id, 'MEMBER_JOINED', _group.id, _caller);

  INSERT INTO public.activity_logs (group_id, actor_id, action, entity_type, entity_id, after)
  VALUES (_group.id, _caller, 'JOIN', 'MEMBER', _caller, jsonb_build_object('user_id', _caller));

  RETURN _group;
END;
$$;

-- BE-07: chủ nhóm đổi mã nhóm (mã cũ bị lộ / người bị xóa còn giữ mã).
CREATE OR REPLACE FUNCTION public.rotate_invite_code(_group_id UUID)
RETURNS public.groups
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  _group public.groups;
  _caller UUID;
  _new_code TEXT;
  _attempts INT := 0;
BEGIN
  _caller := public.assert_authenticated();

  SELECT * INTO _group FROM public.groups WHERE id = _group_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'GROUP_NOT_FOUND: Group does not exist.';
  END IF;

  IF NOT public.is_owner(_group_id) THEN
    RAISE EXCEPTION 'NOT_OWNER: Only the group owner can change the invite code.';
  END IF;

  IF _group.status IS DISTINCT FROM 'ACTIVE' THEN
    RAISE EXCEPTION 'GROUP_CLOSED: Group is closed, cannot change the invite code.';
  END IF;

  LOOP
    _new_code := upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8));
    EXIT WHEN _new_code IS DISTINCT FROM _group.invite_code
      AND NOT EXISTS (SELECT 1 FROM public.groups WHERE invite_code = _new_code);

    _attempts := _attempts + 1;
    IF _attempts >= 20 THEN
      RAISE EXCEPTION 'CODE_GENERATION_FAILED: Could not generate a unique invite code.';
    END IF;
  END LOOP;

  UPDATE public.groups
  SET invite_code = _new_code
  WHERE id = _group_id
  RETURNING * INTO _group;

  -- Không ghi mã vào nhật ký (thành viên LEFT vẫn đọc được nhật ký cũ)
  INSERT INTO public.activity_logs (group_id, actor_id, action, entity_type, entity_id)
  VALUES (_group_id, _caller, 'ROTATE_INVITE_CODE', 'GROUP', _group_id);

  RETURN _group;
END;
$$;


-- ============================================================
-- PART 7: HỒ SƠ (SEC-05, NEW-02 — contract #1)
-- ============================================================

DROP FUNCTION IF EXISTS public.update_profile(TEXT, TEXT, BOOLEAN);

-- NULL = giữ nguyên. _clear_avatar = true → avatar_path = NULL (ưu tiên hơn _avatar_path).
-- _avatar_path phải nằm trong thư mục '<uid>/' của bucket avatars.
CREATE OR REPLACE FUNCTION public.update_profile(
  _display_name TEXT DEFAULT NULL,
  _avatar_path TEXT DEFAULT NULL,
  _searchable BOOLEAN DEFAULT NULL,
  _clear_avatar BOOLEAN DEFAULT false
)
RETURNS public.profiles
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  _caller UUID;
  _profile public.profiles;
  _name TEXT;
BEGIN
  _caller := public.assert_authenticated();

  SELECT * INTO _profile FROM public.profiles WHERE id = _caller FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PROFILE_NOT_FOUND: Profile not found.';
  END IF;

  IF _display_name IS NOT NULL THEN
    _name := trim(_display_name);
    IF _name = '' THEN
      RAISE EXCEPTION 'INVALID_DISPLAY_NAME: Display name cannot be empty.';
    END IF;
    IF length(_name) > 100 THEN
      RAISE EXCEPTION 'INVALID_DISPLAY_NAME: Display name must be at most 100 characters.';
    END IF;
  END IF;

  IF _avatar_path IS NOT NULL AND NOT COALESCE(_clear_avatar, false) THEN
    IF left(_avatar_path, length(_caller::text) + 1) IS DISTINCT FROM _caller::text || '/'
       OR length(_avatar_path) <= length(_caller::text) + 1
       OR position('..' IN _avatar_path) > 0 THEN
      RAISE EXCEPTION 'INVALID_AVATAR_PATH: Avatar must be stored under your own folder.';
    END IF;
  END IF;

  UPDATE public.profiles
  SET display_name = COALESCE(_name, display_name),
      avatar_path = CASE
                      WHEN COALESCE(_clear_avatar, false) THEN NULL
                      ELSE COALESCE(_avatar_path, avatar_path)
                    END,
      searchable = COALESCE(_searchable, searchable)
  WHERE id = _caller
  RETURNING * INTO _profile;

  RETURN _profile;
END;
$$;


-- ============================================================
-- PART 8: XÓA TÀI KHOẢN (BE-04, BE-05)
-- ============================================================

-- Mọi bước DB của delete-account trong MỘT giao dịch. Bước nào lỗi → RAISE → rollback
-- toàn bộ, Edge Function trả non-2xx. Chỉ service_role gọi được (cấp quyền ở PART 11).
-- Hồ sơ luôn được ẩn danh (kể cả người không có lịch sử), không bao giờ xóa dòng.
-- Gọi lại sau khi đã ẩn danh (lần trước lỗi ở bước xóa user Auth) → trả
-- already_anonymized = true để Edge Function làm tiếp.
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

  SELECT * INTO _profile FROM public.profiles WHERE id = _user_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PROFILE_NOT_FOUND: Profile does not exist.';
  END IF;

  IF _profile.deleted_at IS NOT NULL THEN
    RETURN jsonb_build_object('already_anonymized', true, 'left_groups', 0);
  END IF;

  -- BE-08: khóa mọi nhóm user đang ACTIVE (thứ tự id cố định, tránh deadlock) để
  -- không khoản chi / thanh toán nào chen vào sau bước kiểm tra số dư.
  PERFORM 1
  FROM public.groups g
  WHERE g.id IN (
    SELECT gm.group_id FROM public.group_members gm
    WHERE gm.user_id = _user_id AND gm.status = 'ACTIVE'
  )
  ORDER BY g.id
  FOR UPDATE;

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
-- PART 9: STORAGE receipts (BE-12, SEC-09)
-- ============================================================

-- Đường dẫn: receipts/<group_id>/<expense_id>/<file>.
--
-- ĐỌC (BE-12):
--   - Thành viên ACTIVE của nhóm: mọi ảnh trong thư mục nhóm.
--   - Thành viên LEFT: chỉ ảnh của khoản chi tạo trước lúc rời (created_at <= left_at),
--     khoản chi xác định theo thư mục <expense_id> HOẶC expenses.receipt_path = đường dẫn.
--   - REMOVED / người ngoài: không.
--
-- GHI (SEC-09) — mọi trường hợp đều đòi nhóm ACTIVE và người gọi là thành viên ACTIVE:
--   - Đã có khoản chi gắn với ảnh (id = <expense_id>, hoặc receipt_path = đường dẫn):
--     chỉ người tạo khoản chi đó hoặc chủ nhóm được tải lên / ghi đè / xóa.
--     <expense_id> trỏ tới khoản chi của NHÓM KHÁC → từ chối.
--   - Chưa có khoản chi (app tải ảnh lên trước rồi mới gọi create_expense, id khoản chi
--     do server sinh nên thư mục là id tạm): mọi thành viên ACTIVE được tải lên;
--     ghi đè / xóa chỉ người đã tải lên (storage.objects.owner) hoặc chủ nhóm.
--   create_expense / update_expense chỉ nhận receipt_path nằm dưới '<group_id>/'.
--   → Không ai ghi đè, xóa được ảnh của khoản chi người khác (lỗ hổng 0007: điều kiện
--     là "đã tạo một khoản chi bất kỳ trong nhóm").

CREATE OR REPLACE FUNCTION public.can_read_receipt(_object_name TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = ''
STABLE
AS $$
DECLARE
  _uid UUID := auth.uid();
  _parts TEXT[] := string_to_array(_object_name, '/');
  _uuid_re CONSTANT TEXT := '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
  _gid UUID;
  _eid UUID;
BEGIN
  IF _uid IS NULL OR COALESCE(array_length(_parts, 1), 0) < 3
     OR _parts[1] !~ _uuid_re OR _parts[2] !~ _uuid_re THEN
    RETURN false;
  END IF;
  _gid := _parts[1]::UUID;
  _eid := _parts[2]::UUID;

  IF EXISTS (
    SELECT 1 FROM public.group_members
    WHERE group_id = _gid AND user_id = _uid AND status = 'ACTIVE'
  ) THEN
    RETURN true;
  END IF;

  RETURN EXISTS (
    SELECT 1
    FROM public.group_members gm
    JOIN public.expenses e ON e.group_id = gm.group_id
    WHERE gm.group_id = _gid
      AND gm.user_id = _uid
      AND gm.status = 'LEFT'
      AND (e.id = _eid OR e.receipt_path = _object_name)
      AND e.created_at <= gm.left_at
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.can_write_receipt(
  _object_name TEXT,
  _object_owner UUID,
  _is_insert BOOLEAN
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = ''
STABLE
AS $$
DECLARE
  _uid UUID := auth.uid();
  _parts TEXT[] := string_to_array(_object_name, '/');
  _uuid_re CONSTANT TEXT := '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
  _gid UUID;
  _eid UUID;
  _owner BOOLEAN;
  _expense public.expenses;
BEGIN
  IF _uid IS NULL OR COALESCE(array_length(_parts, 1), 0) < 3
     OR _parts[1] !~ _uuid_re OR _parts[2] !~ _uuid_re
     OR COALESCE(_parts[array_length(_parts, 1)], '') = '' THEN
    RETURN false;
  END IF;
  _gid := _parts[1]::UUID;
  _eid := _parts[2]::UUID;

  -- Nhóm ACTIVE + người gọi ACTIVE
  IF NOT EXISTS (
    SELECT 1
    FROM public.groups g
    JOIN public.group_members gm ON gm.group_id = g.id
    WHERE g.id = _gid AND g.status = 'ACTIVE'
      AND gm.user_id = _uid AND gm.status = 'ACTIVE'
  ) THEN
    RETURN false;
  END IF;

  _owner := public.is_owner(_gid);

  SELECT * INTO _expense FROM public.expenses WHERE id = _eid;
  IF FOUND THEN
    IF _expense.group_id IS DISTINCT FROM _gid THEN
      RETURN false;
    END IF;
    RETURN _owner OR _expense.created_by = _uid;
  END IF;

  SELECT * INTO _expense
  FROM public.expenses
  WHERE group_id = _gid AND receipt_path = _object_name
  ORDER BY created_at
  LIMIT 1;
  IF FOUND THEN
    RETURN _owner OR _expense.created_by = _uid;
  END IF;

  -- Chưa có khoản chi
  IF COALESCE(_is_insert, false) THEN
    RETURN true;
  END IF;
  RETURN _owner OR _object_owner IS NOT DISTINCT FROM _uid;
END;
$$;

DROP POLICY IF EXISTS "Group members can read receipts" ON storage.objects;
DROP POLICY IF EXISTS "Expense creator or owner can upload receipts" ON storage.objects;
DROP POLICY IF EXISTS "Expense creator or owner can update receipts" ON storage.objects;
DROP POLICY IF EXISTS "Expense creator or owner can delete receipts" ON storage.objects;
DROP POLICY IF EXISTS "Receipts read: members, LEFT up to left_at" ON storage.objects;
DROP POLICY IF EXISTS "Receipts upload: expense creator or owner" ON storage.objects;
DROP POLICY IF EXISTS "Receipts update: expense creator or owner" ON storage.objects;
DROP POLICY IF EXISTS "Receipts delete: expense creator or owner" ON storage.objects;

CREATE POLICY "Receipts read: members, LEFT up to left_at"
  ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'receipts' AND public.can_read_receipt(name));

CREATE POLICY "Receipts upload: expense creator or owner"
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'receipts' AND public.can_write_receipt(name, NULL, true));

CREATE POLICY "Receipts update: expense creator or owner"
  ON storage.objects FOR UPDATE TO authenticated
  USING (bucket_id = 'receipts' AND public.can_write_receipt(name, owner, false))
  WITH CHECK (bucket_id = 'receipts' AND public.can_write_receipt(name, owner, false));

CREATE POLICY "Receipts delete: expense creator or owner"
  ON storage.objects FOR DELETE TO authenticated
  USING (bucket_id = 'receipts' AND public.can_write_receipt(name, owner, false));


-- ============================================================
-- PART 10: PUSH TRIGGER (CFG-04, NEW-09)
-- ============================================================

-- Sửa 0008:
--   - Gọi đúng hàm pg_net: net.http_post(url, body jsonb, params jsonb, headers jsonb,
--     timeout_milliseconds) (0008 gọi extensions.http_post với body text → không tồn tại).
--   - Không dùng service role key. URL và webhook secret đọc từ Supabase Vault:
--       select vault.create_secret('https://<project-ref>.supabase.co', 'supabase_url');
--       select vault.create_secret('<chuỗi ngẫu nhiên>', 'webhook_secret');
--     webhook_secret phải bằng secret WEBHOOK_SECRET của Edge Function send-push
--     (send-push deploy với verify_jwt = false — supabase/config.toml).
--   - search_path = ''.
--   - Thiếu cấu hình → RAISE WARNING (không im lặng). Lỗi khác cũng chỉ WARNING kèm
--     SQLSTATE: push là phụ, không được làm hỏng giao dịch tài chính đã tạo thông báo.
--   - Chỉ gửi id thông báo; send-push đọc lại bản ghi từ DB (SEC-03).
CREATE OR REPLACE FUNCTION public.trigger_push_notification()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  _supabase_url TEXT;
  _webhook_secret TEXT;
BEGIN
  -- Người nhận chưa đăng ký thiết bị nào → không cần gọi HTTP
  IF NOT EXISTS (SELECT 1 FROM public.push_tokens WHERE user_id = NEW.user_id) THEN
    RETURN NEW;
  END IF;

  BEGIN
    SELECT ds.decrypted_secret INTO _supabase_url
    FROM vault.decrypted_secrets ds
    WHERE ds.name = 'supabase_url'
    LIMIT 1;

    SELECT ds.decrypted_secret INTO _webhook_secret
    FROM vault.decrypted_secrets ds
    WHERE ds.name = 'webhook_secret'
    LIMIT 1;

    IF COALESCE(_supabase_url, '') = '' OR COALESCE(_webhook_secret, '') = '' THEN
      RAISE WARNING 'PUSH_NOT_CONFIGURED: Vault secrets "supabase_url" and/or "webhook_secret" are missing; push for notification % was not sent.', NEW.id;
      RETURN NEW;
    END IF;

    PERFORM net.http_post(
      url := rtrim(_supabase_url, '/') || '/functions/v1/send-push',
      body := jsonb_build_object(
        'type', 'INSERT',
        'table', 'notifications',
        'record', jsonb_build_object('id', NEW.id)
      ),
      params := '{}'::jsonb,
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-webhook-secret', _webhook_secret
      ),
      timeout_milliseconds := 5000
    );
  EXCEPTION
    WHEN OTHERS THEN
      RAISE WARNING 'PUSH_TRIGGER_FAILED: notification % — % (SQLSTATE %)', NEW.id, SQLERRM, SQLSTATE;
  END;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_notification_inserted ON public.notifications;
CREATE TRIGGER on_notification_inserted
  AFTER INSERT ON public.notifications
  FOR EACH ROW
  EXECUTE FUNCTION public.trigger_push_notification();


-- ============================================================
-- PART 11: QUYỀN (SEC-02, SEC-05, SEC-08)
-- ============================================================

-- 11.1 Hàm tạo SAU migration này: không tự có quyền EXECUTE cho PUBLIC / anon.
-- Lưu ý: quyền mặc định theo schema chỉ CỘNG thêm vào quyền mặc định toàn cục, nên
-- REVOKE ... FROM PUBLIC phải ở dạng toàn cục (không IN SCHEMA) mới có tác dụng. Áp
-- dụng cho hàm do role chạy migration (postgres) tạo ở mọi schema → hàm mới cần
-- GRANT tường minh. Supabase còn cấp riêng cho anon trong schema public → thu hồi.
ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC, anon;

-- 11.2 Hàm hiện có (gồm 0008, 0009, 0010)
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC, anon;

-- Hàm nội bộ / trigger: authenticated không gọi trực tiếp được (assert_* trước đây
-- gọi được như RPC để dò nhóm có tồn tại không). Hàm SECURITY DEFINER gọi chúng
-- chạy bằng quyền owner nên không bị ảnh hưởng; trigger không kiểm tra EXECUTE.
REVOKE EXECUTE ON FUNCTION public.assert_authenticated() FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.assert_active_member_of_active_group(UUID) FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.generate_user_code() FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.handle_new_user() FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.handle_auth_user_deleted() FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.trigger_push_notification() FROM authenticated;

-- Xóa tài khoản: chỉ Edge Function (service_role)
REVOKE EXECUTE ON FUNCTION public.anonymize_account(UUID) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.anonymize_account(UUID) TO service_role;

-- RPC mới / tạo lại trong 0010 + hàm dùng trong RLS và policy Storage
GRANT EXECUTE ON FUNCTION public.is_owner(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.can_read_receipt(TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.can_write_receipt(TEXT, UUID, BOOLEAN) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rotate_invite_code(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.update_profile(TEXT, TEXT, BOOLEAN, BOOLEAN) TO authenticated;
GRANT EXECUTE ON FUNCTION public.create_expense(UUID, UUID, BIGINT, TEXT, JSONB, TEXT, TEXT, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.update_expense(UUID, INTEGER, UUID, BIGINT, TEXT, TEXT, TEXT, JSONB, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.cancel_expense(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.create_payment(UUID, UUID, BIGINT, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.update_group(UUID, TEXT, TEXT, BOOLEAN) TO authenticated;
GRANT EXECUTE ON FUNCTION public.revoke_invite(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.create_invite(UUID, UUID, INTEGER, INTEGER) TO authenticated;
GRANT EXECUTE ON FUNCTION public.accept_invite(TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.join_group(TEXT) TO authenticated;

-- 11.3 Bảng: anon không đọc / ghi gì trong public (app luôn đăng nhập). Trước đây anon
-- SELECT bảng có policy gọi is_member → "permission denied for function" thay vì
-- từ chối rõ ràng; nay bị chặn ngay ở quyền bảng.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon;

-- TRUNCATE / REFERENCES / TRIGGER bỏ qua RLS — authenticated không cần.
REVOKE TRUNCATE, REFERENCES, TRIGGER ON ALL TABLES IN SCHEMA public FROM authenticated;

-- Dữ liệu ghi qua RPC: authenticated chỉ đọc (RLS vẫn lọc dòng). Chặn cả ở quyền
-- bảng để một policy INSERT/UPDATE thêm nhầm sau này cũng không mở lại SEC-01.
REVOKE INSERT, UPDATE, DELETE ON
  public.groups, public.group_members, public.group_invites,
  public.expenses, public.expense_shares, public.payments,
  public.activity_logs, public.friendships
FROM authenticated;

-- SEC-05: hồ sơ chỉ sửa qua update_profile (user_code, deleted_at, ... không sửa được).
REVOKE INSERT, UPDATE, DELETE ON public.profiles FROM authenticated;

-- notifications: chỉ đánh dấu đã đọc (policy UPDATE không có WITH CHECK → trước đây
-- đổi được user_id / type).
REVOKE INSERT, UPDATE, DELETE ON public.notifications FROM authenticated;
GRANT UPDATE (read_at) ON public.notifications TO authenticated;

COMMIT;
