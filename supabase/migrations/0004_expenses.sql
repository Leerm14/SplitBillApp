-- ============================================================
-- Phase 3: Expenses — Cập nhật RPC tạo/hủy khoản chi,
-- thêm RPC sửa khoản chi, storage bucket receipts.
-- ============================================================

BEGIN;

-- ============================
-- 1. CẬP NHẬT RPC: create_expense — thêm split_method, note,
--    receipt_path, ghi activity_logs + notifications
-- ============================

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
  _caller UUID := auth.uid();
  _member RECORD;
BEGIN
  -- Kiểm tra idempotency: trùng key thì trả bản ghi cũ
  SELECT * INTO _expense FROM public.expenses WHERE idempotency_key = _idempotency_key;
  IF FOUND THEN
    RETURN _expense;
  END IF;

  -- Kiểm tra người gọi là thành viên ACTIVE
  IF NOT EXISTS (
    SELECT 1 FROM public.group_members
    WHERE group_id = _group_id AND user_id = _caller AND status = 'ACTIVE'
  ) THEN
    RAISE EXCEPTION 'Bạn không phải thành viên nhóm này';
  END IF;

  -- Kiểm tra người trả là thành viên ACTIVE
  IF NOT EXISTS (
    SELECT 1 FROM public.group_members
    WHERE group_id = _group_id AND user_id = _paid_by AND status = 'ACTIVE'
  ) THEN
    RAISE EXCEPTION 'Người trả không phải thành viên nhóm';
  END IF;

  -- Validate split_method
  IF _split_method NOT IN ('EQUAL', 'PERCENT', 'EXACT') THEN
    RAISE EXCEPTION 'Phương thức chia không hợp lệ: %', _split_method;
  END IF;

  -- Ghi khoản chi
  INSERT INTO public.expenses (
    group_id, paid_by, amount, description, created_by, idempotency_key,
    split_method, note, receipt_path
  )
  VALUES (
    _group_id, _paid_by, _amount, COALESCE(_description, ''), _caller, _idempotency_key,
    _split_method, COALESCE(_note, ''), _receipt_path
  )
  RETURNING * INTO _expense;

  -- Ghi phần chia
  FOR _share IN SELECT * FROM jsonb_array_elements(_shares)
  LOOP
    _share_user_id := (_share ->> 'userId')::UUID;
    _share_amount := (_share ->> 'amount')::BIGINT;

    -- Kiểm tra người chịu là thành viên ACTIVE
    IF NOT EXISTS (
      SELECT 1 FROM public.group_members
      WHERE group_id = _group_id AND user_id = _share_user_id AND status = 'ACTIVE'
    ) THEN
      RAISE EXCEPTION 'Người chịu % không phải thành viên đang hoạt động trong nhóm', _share_user_id;
    END IF;

    INSERT INTO public.expense_shares (expense_id, user_id, amount, percent_bp)
    VALUES (
      _expense.id,
      _share_user_id,
      _share_amount,
      (_share ->> 'percentBp')::INTEGER
    );

    _share_total := _share_total + _share_amount;
  END LOOP;

  -- Kiểm tra tổng phần chia = tổng khoản chi
  IF _share_total <> _amount THEN
    RAISE EXCEPTION 'Tổng phần chia (%) khác tổng khoản chi (%)', _share_total, _amount;
  END IF;

  -- Ghi activity log
  INSERT INTO public.activity_logs (group_id, actor_id, action, entity_type, entity_id, after)
  VALUES (
    _group_id,
    _caller,
    'EXPENSE_CREATED',
    'EXPENSE',
    _expense.id,
    jsonb_build_object(
      'amount', _amount,
      'description', _expense.description,
      'paid_by', _paid_by,
      'split_method', _split_method
    )
  );

  -- Thông báo cho tất cả thành viên ACTIVE trừ người tạo
  INSERT INTO public.notifications (user_id, type, group_id, expense_id)
  SELECT gm.user_id, 'EXPENSE_CREATED', _group_id, _expense.id
  FROM public.group_members gm
  WHERE gm.group_id = _group_id
    AND gm.status = 'ACTIVE'
    AND gm.user_id <> _caller;

  RETURN _expense;
END;
$$;

-- ============================
-- 2. RPC: update_expense — sửa khoản chi (optimistic locking)
-- ============================

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
  _caller UUID := auth.uid();
  _share JSONB;
  _share_total BIGINT := 0;
  _share_user_id UUID;
  _share_amount BIGINT;
  _before JSONB;
  _old_shares JSONB;
BEGIN
  -- Lấy khoản chi
  SELECT * INTO _expense FROM public.expenses WHERE id = _expense_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Khoản chi không tồn tại';
  END IF;

  -- Kiểm tra khoản chi đang ACTIVE
  IF _expense.status <> 'ACTIVE' THEN
    RAISE EXCEPTION 'Khoản chi đã bị hủy, không thể sửa';
  END IF;

  -- Kiểm tra optimistic locking
  IF _expense.version <> _expected_version THEN
    RAISE EXCEPTION 'Khoản chi đã được sửa bởi người khác. Vui lòng tải lại.';
  END IF;

  -- Lấy nhóm
  SELECT * INTO _group FROM public.groups WHERE id = _expense.group_id;

  -- Kiểm tra người gọi là thành viên ACTIVE
  IF NOT EXISTS (
    SELECT 1 FROM public.group_members
    WHERE group_id = _expense.group_id AND user_id = _caller AND status = 'ACTIVE'
  ) THEN
    RAISE EXCEPTION 'Bạn không phải thành viên nhóm này';
  END IF;

  -- Chỉ người tạo hoặc chủ nhóm mới được sửa
  IF _caller <> _expense.created_by AND _caller <> _group.owner_id THEN
    RAISE EXCEPTION 'Chỉ người tạo hoặc chủ nhóm mới được sửa khoản chi';
  END IF;

  -- Kiểm tra người trả mới là thành viên ACTIVE
  IF NOT EXISTS (
    SELECT 1 FROM public.group_members
    WHERE group_id = _expense.group_id AND user_id = _paid_by AND status = 'ACTIVE'
  ) THEN
    RAISE EXCEPTION 'Người trả không phải thành viên đang hoạt động trong nhóm';
  END IF;

  -- Validate split_method
  IF _split_method NOT IN ('EQUAL', 'PERCENT', 'EXACT') THEN
    RAISE EXCEPTION 'Phương thức chia không hợp lệ: %', _split_method;
  END IF;

  -- Validate _amount
  IF _amount <= 0 THEN
    RAISE EXCEPTION 'Số tiền phải lớn hơn 0';
  END IF;

  -- Lưu trạng thái cũ (before) để ghi log
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

  -- Validate phần chia mới: kiểm tra từng user + tính tổng
  FOR _share IN SELECT * FROM jsonb_array_elements(_shares)
  LOOP
    _share_user_id := (_share ->> 'userId')::UUID;
    _share_amount := (_share ->> 'amount')::BIGINT;

    -- Kiểm tra người chịu là thành viên ACTIVE
    IF NOT EXISTS (
      SELECT 1 FROM public.group_members
      WHERE group_id = _expense.group_id AND user_id = _share_user_id AND status = 'ACTIVE'
    ) THEN
      RAISE EXCEPTION 'Người chịu % không phải thành viên đang hoạt động trong nhóm', _share_user_id;
    END IF;

    _share_total := _share_total + _share_amount;
  END LOOP;

  -- Kiểm tra tổng phần chia = tổng khoản chi
  IF _share_total <> _amount THEN
    RAISE EXCEPTION 'Tổng phần chia (%) khác tổng khoản chi (%)', _share_total, _amount;
  END IF;

  -- Cập nhật khoản chi
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
  RETURNING * INTO _expense;

  -- Xóa phần chia cũ, chèn phần chia mới
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

  -- Ghi activity log (before/after)
  INSERT INTO public.activity_logs (group_id, actor_id, action, entity_type, entity_id, before, after)
  VALUES (
    _expense.group_id,
    _caller,
    'EXPENSE_UPDATED',
    'EXPENSE',
    _expense_id,
    _before,
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

  -- Thông báo cho tất cả thành viên ACTIVE trừ người sửa
  INSERT INTO public.notifications (user_id, type, group_id, expense_id)
  SELECT gm.user_id, 'EXPENSE_UPDATED', _expense.group_id, _expense_id
  FROM public.group_members gm
  WHERE gm.group_id = _expense.group_id
    AND gm.status = 'ACTIVE'
    AND gm.user_id <> _caller;

  RETURN _expense;
END;
$$;

-- ============================
-- 3. CẬP NHẬT RPC: cancel_expense — thêm cancelled_at,
--    ghi activity_logs + notifications
-- ============================

CREATE OR REPLACE FUNCTION public.cancel_expense(_expense_id UUID)
RETURNS public.expenses
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  _expense public.expenses;
  _group public.groups;
  _caller UUID := auth.uid();
BEGIN
  -- Lấy khoản chi
  SELECT * INTO _expense FROM public.expenses WHERE id = _expense_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Khoản chi không tồn tại';
  END IF;

  -- Đã hủy thì bỏ qua (idempotent)
  IF _expense.status = 'CANCELLED' THEN
    RETURN _expense;
  END IF;

  -- Lấy nhóm
  SELECT * INTO _group FROM public.groups WHERE id = _expense.group_id;

  -- Chỉ người tạo hoặc chủ nhóm mới được hủy
  IF _caller <> _expense.created_by AND _caller <> _group.owner_id THEN
    RAISE EXCEPTION 'Chỉ người tạo hoặc chủ nhóm mới được hủy khoản chi';
  END IF;

  -- Hủy khoản chi + set cancelled_at
  UPDATE public.expenses
  SET status = 'CANCELLED',
      cancelled_at = now(),
      updated_at = now()
  WHERE id = _expense_id
  RETURNING * INTO _expense;

  -- Ghi activity log
  INSERT INTO public.activity_logs (group_id, actor_id, action, entity_type, entity_id, after)
  VALUES (
    _expense.group_id,
    _caller,
    'EXPENSE_CANCELLED',
    'EXPENSE',
    _expense_id,
    jsonb_build_object(
      'amount', _expense.amount,
      'description', _expense.description,
      'paid_by', _expense.paid_by
    )
  );

  -- Thông báo cho tất cả thành viên ACTIVE trừ người hủy
  INSERT INTO public.notifications (user_id, type, group_id, expense_id)
  SELECT gm.user_id, 'EXPENSE_CANCELLED', _expense.group_id, _expense_id
  FROM public.group_members gm
  WHERE gm.group_id = _expense.group_id
    AND gm.status = 'ACTIVE'
    AND gm.user_id <> _caller;

  RETURN _expense;
END;
$$;

-- ============================
-- 4. STORAGE: bucket receipts (private)
-- ============================

-- Tạo bucket receipts (private — không public)
INSERT INTO storage.buckets (id, name, public)
VALUES ('receipts', 'receipts', false)
ON CONFLICT (id) DO NOTHING;

-- Thành viên ACTIVE của nhóm được đọc receipts trong folder nhóm
CREATE POLICY "Group members can read receipts"
  ON storage.objects FOR SELECT
  USING (
    bucket_id = 'receipts'
    AND public.is_member(((storage.foldername(name))[1])::UUID)
  );

-- Thành viên ACTIVE được upload vào folder nhóm mình: receipts/{group_id}/...
CREATE POLICY "Group members can upload receipts"
  ON storage.objects FOR INSERT
  WITH CHECK (
    bucket_id = 'receipts'
    AND public.is_member(((storage.foldername(name))[1])::UUID)
  );

-- Thành viên ACTIVE được cập nhật file trong folder nhóm mình
CREATE POLICY "Group members can update receipts"
  ON storage.objects FOR UPDATE
  USING (
    bucket_id = 'receipts'
    AND public.is_member(((storage.foldername(name))[1])::UUID)
  );

-- Thành viên ACTIVE được xóa file trong folder nhóm mình
CREATE POLICY "Group members can delete receipts"
  ON storage.objects FOR DELETE
  USING (
    bucket_id = 'receipts'
    AND public.is_member(((storage.foldername(name))[1])::UUID)
  );

-- ============================
-- 5. INDEX bổ sung cho hiệu năng
-- ============================

CREATE INDEX IF NOT EXISTS idx_expenses_group_status ON public.expenses (group_id, status);
CREATE INDEX IF NOT EXISTS idx_expenses_idempotency ON public.expenses (idempotency_key);
CREATE INDEX IF NOT EXISTS idx_expense_shares_user ON public.expense_shares (user_id);

COMMIT;
