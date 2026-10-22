-- ============================================================
-- Migration 0007: Security & Concurrency Fixes
-- Fixes: SEC-01, SEC-02, SEC-04, SEC-05, SEC-06, SEC-07,
--        SEC-08, SEC-09, BE-02, BE-03, BE-06, BE-07, BE-08,
--        BE-09, BE-10, BE-11, BE-12
-- ============================================================

BEGIN;

-- ============================================================
-- PART 0: SCHEMA ADDITIONS
-- ============================================================

-- payments.decided_by — tracks who confirmed/rejected/disputed
ALTER TABLE public.payments
  ADD COLUMN IF NOT EXISTS decided_by UUID REFERENCES public.profiles(id);

-- ============================================================
-- PART 1: HELPER FUNCTIONS  (SEC-02)
-- ============================================================

-- SEC-02: assert_authenticated — reusable guard against NULL auth.uid()
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
  RETURN _uid;
END;
$$;

-- SEC-02 + BE-03: assert_active_member_of_active_group
-- Checks auth, group ACTIVE status, and ACTIVE membership.
-- Returns the caller's role for permission checks downstream.
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
  -- Check group exists and is ACTIVE
  SELECT status INTO _group_status
  FROM public.groups
  WHERE id = _group_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'GROUP_NOT_FOUND: Group does not exist.';
  END IF;

  IF _group_status IS DISTINCT FROM 'ACTIVE' THEN
    RAISE EXCEPTION 'GROUP_CLOSED: Group is closed. No write operations allowed.';
  END IF;

  -- Check caller is ACTIVE member
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


-- ============================================================
-- PART 2: DROP PAYMENT INSERT POLICY + CREATE create_payment RPC  (SEC-01)
-- ============================================================

-- SEC-01: Remove the INSERT policy that allowed direct client inserts
DROP POLICY IF EXISTS "Sender can create payment" ON public.payments;

-- SEC-01: Drop the trigger that relied on direct INSERT (we do it in-RPC now)
DROP TRIGGER IF EXISTS on_payment_created ON public.payments;

-- SEC-01: RPC create_payment — all payment creation goes through here
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
  _payment public.payments;
  _result JSONB;
BEGIN
  -- SEC-02: auth check
  _caller := public.assert_authenticated();

  -- BE-03: group ACTIVE + membership check
  _role := public.assert_active_member_of_active_group(_group_id);

  -- Cannot pay yourself
  IF _caller = _to_id THEN
    RAISE EXCEPTION 'SELF_PAYMENT: Cannot create a payment to yourself.';
  END IF;

  -- Amount must be positive
  IF _amount IS NULL OR _amount <= 0 THEN
    RAISE EXCEPTION 'INVALID_AMOUNT: Amount must be a positive integer.';
  END IF;

  -- Receiver must be ACTIVE member of the group
  IF NOT EXISTS (
    SELECT 1 FROM public.group_members
    WHERE group_id = _group_id AND user_id = _to_id AND status = 'ACTIVE'
  ) THEN
    RAISE EXCEPTION 'RECEIVER_NOT_MEMBER: Receiver is not an active member of this group.';
  END IF;

  -- Idempotency: if key provided, check for existing payment from same sender
  IF _idempotency_key IS NOT NULL THEN
    SELECT * INTO _payment
    FROM public.payments
    WHERE from_id = _caller
      AND idempotency_key = _idempotency_key;

    IF FOUND THEN
      SELECT to_jsonb(_payment) INTO _result;
      RETURN _result;
    END IF;
  END IF;

  -- Insert with status always = PENDING
  BEGIN
    INSERT INTO public.payments (group_id, from_id, to_id, amount, status, note, idempotency_key)
    VALUES (
      _group_id,
      _caller,
      _to_id,
      _amount,
      'PENDING',
      COALESCE(_note, ''),
      _idempotency_key
    )
    RETURNING * INTO _payment;
  EXCEPTION
    WHEN unique_violation THEN
      -- Idempotency: catch unique constraint on idempotency_key
      SELECT * INTO _payment
      FROM public.payments
      WHERE from_id = _caller
        AND idempotency_key = _idempotency_key;

      SELECT to_jsonb(_payment) INTO _result;
      RETURN _result;
  END;

  -- Activity log
  INSERT INTO public.activity_logs (group_id, actor_id, action, entity_type, entity_id, after)
  VALUES (
    _group_id,
    _caller,
    'PAYMENT_CREATED',
    'PAYMENT',
    _payment.id,
    jsonb_build_object(
      'amount', _payment.amount,
      'from_id', _caller,
      'to_id', _to_id,
      'note', _payment.note
    )
  );

  -- Notification for receiver
  INSERT INTO public.notifications (user_id, type, group_id, payment_id)
  VALUES (_to_id, 'PAYMENT_CREATED', _group_id, _payment.id);

  SELECT to_jsonb(_payment) INTO _result;
  RETURN _result;
END;
$$;


-- ============================================================
-- PART 3: SPLIT respond_payment → confirm_payment + reject_payment  (SEC-02, BE-10)
-- ============================================================

-- SEC-02 / BE-10: confirm_payment — receiver confirms a PENDING payment
CREATE OR REPLACE FUNCTION public.confirm_payment(_payment_id UUID)
RETURNS public.payments
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  _caller UUID;
  _payment public.payments;
  _role TEXT;
BEGIN
  _caller := public.assert_authenticated();

  -- Lock payment row FOR UPDATE to prevent races
  SELECT * INTO _payment
  FROM public.payments
  WHERE id = _payment_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'PAYMENT_NOT_FOUND: Payment does not exist.';
  END IF;

  -- BE-03: group + membership check
  _role := public.assert_active_member_of_active_group(_payment.group_id);

  -- Only receiver can confirm (NULL-safe with IS DISTINCT FROM)
  IF _caller IS DISTINCT FROM _payment.to_id THEN
    RAISE EXCEPTION 'NOT_RECEIVER: Only the receiver can confirm a payment.';
  END IF;

  -- Must be PENDING
  IF _payment.status IS DISTINCT FROM 'PENDING' THEN
    RAISE EXCEPTION 'NOT_PENDING: Payment is not in PENDING status (current: %).', _payment.status;
  END IF;

  -- Update
  UPDATE public.payments
  SET status = 'CONFIRMED',
      decided_at = now(),
      decided_by = _caller
  WHERE id = _payment_id
  RETURNING * INTO _payment;

  -- Activity log
  INSERT INTO public.activity_logs (group_id, actor_id, action, entity_type, entity_id, before, after)
  VALUES (
    _payment.group_id,
    _caller,
    'PAYMENT_CONFIRMED',
    'PAYMENT',
    _payment.id,
    jsonb_build_object('status', 'PENDING'),
    jsonb_build_object(
      'status', 'CONFIRMED',
      'amount', _payment.amount,
      'from_id', _payment.from_id,
      'to_id', _payment.to_id
    )
  );

  -- Notify sender
  INSERT INTO public.notifications (user_id, type, group_id, payment_id)
  VALUES (_payment.from_id, 'PAYMENT_CONFIRMED', _payment.group_id, _payment.id);

  RETURN _payment;
END;
$$;

-- SEC-02 / BE-10: reject_payment — receiver rejects a PENDING payment
CREATE OR REPLACE FUNCTION public.reject_payment(
  _payment_id UUID,
  _reason TEXT DEFAULT NULL
)
RETURNS public.payments
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  _caller UUID;
  _payment public.payments;
  _role TEXT;
BEGIN
  _caller := public.assert_authenticated();

  -- Lock payment row FOR UPDATE
  SELECT * INTO _payment
  FROM public.payments
  WHERE id = _payment_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'PAYMENT_NOT_FOUND: Payment does not exist.';
  END IF;

  -- BE-03: group + membership check
  _role := public.assert_active_member_of_active_group(_payment.group_id);

  -- Only receiver can reject (NULL-safe)
  IF _caller IS DISTINCT FROM _payment.to_id THEN
    RAISE EXCEPTION 'NOT_RECEIVER: Only the receiver can reject a payment.';
  END IF;

  -- Must be PENDING
  IF _payment.status IS DISTINCT FROM 'PENDING' THEN
    RAISE EXCEPTION 'NOT_PENDING: Payment is not in PENDING status (current: %).', _payment.status;
  END IF;

  -- Update
  UPDATE public.payments
  SET status = 'REJECTED',
      decided_at = now(),
      decided_by = _caller,
      reason = COALESCE(trim(_reason), '')
  WHERE id = _payment_id
  RETURNING * INTO _payment;

  -- Activity log
  INSERT INTO public.activity_logs (group_id, actor_id, action, entity_type, entity_id, before, after)
  VALUES (
    _payment.group_id,
    _caller,
    'PAYMENT_REJECTED',
    'PAYMENT',
    _payment.id,
    jsonb_build_object('status', 'PENDING'),
    jsonb_build_object(
      'status', 'REJECTED',
      'amount', _payment.amount,
      'from_id', _payment.from_id,
      'to_id', _payment.to_id,
      'reason', COALESCE(trim(_reason), '')
    )
  );

  -- Notify sender
  INSERT INTO public.notifications (user_id, type, group_id, payment_id)
  VALUES (_payment.from_id, 'PAYMENT_REJECTED', _payment.group_id, _payment.id);

  RETURN _payment;
END;
$$;

-- Keep respond_payment as a thin wrapper for backward compat, but it now delegates
CREATE OR REPLACE FUNCTION public.respond_payment(_payment_id UUID, _accept BOOLEAN)
RETURNS public.payments
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  IF _accept THEN
    RETURN public.confirm_payment(_payment_id);
  ELSE
    RETURN public.reject_payment(_payment_id, NULL);
  END IF;
END;
$$;


-- ============================================================
-- PART 4: FIX dispute_payment  (SEC-02, BE-11)
-- ============================================================

-- BE-11: dispute should only work on PENDING (not CONFIRMED)
-- SEC-02: add auth check, FOR UPDATE lock
CREATE OR REPLACE FUNCTION public.dispute_payment(_payment_id UUID, _reason TEXT)
RETURNS public.payments
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  _payment public.payments;
  _caller UUID;
  _role TEXT;
BEGIN
  _caller := public.assert_authenticated();

  -- Lock payment row FOR UPDATE
  SELECT * INTO _payment
  FROM public.payments
  WHERE id = _payment_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'PAYMENT_NOT_FOUND: Payment does not exist.';
  END IF;

  -- BE-03: group + membership check
  _role := public.assert_active_member_of_active_group(_payment.group_id);

  -- Only receiver (to_id) can dispute (NULL-safe)
  IF _caller IS DISTINCT FROM _payment.to_id THEN
    RAISE EXCEPTION 'NOT_RECEIVER: Only the receiver can dispute a payment.';
  END IF;

  -- BE-11: Only dispute when PENDING (was incorrectly CONFIRMED before)
  IF _payment.status IS DISTINCT FROM 'PENDING' THEN
    RAISE EXCEPTION 'NOT_PENDING: Can only dispute a PENDING payment (current: %).', _payment.status;
  END IF;

  -- Validate reason
  IF _reason IS NULL OR trim(_reason) = '' THEN
    RAISE EXCEPTION 'REASON_REQUIRED: A reason is required when disputing a payment.';
  END IF;

  -- Update
  UPDATE public.payments
  SET status = 'DISPUTED',
      reason = trim(_reason),
      decided_at = now(),
      decided_by = _caller
  WHERE id = _payment_id
  RETURNING * INTO _payment;

  -- Activity log
  INSERT INTO public.activity_logs (group_id, actor_id, action, entity_type, entity_id, before, after)
  VALUES (
    _payment.group_id,
    _caller,
    'PAYMENT_DISPUTED',
    'PAYMENT',
    _payment.id,
    jsonb_build_object('status', 'PENDING'),
    jsonb_build_object(
      'status', 'DISPUTED',
      'reason', trim(_reason),
      'amount', _payment.amount,
      'from_id', _payment.from_id,
      'to_id', _payment.to_id
    )
  );

  -- Notify sender
  INSERT INTO public.notifications (user_id, type, group_id, payment_id)
  VALUES (_payment.from_id, 'PAYMENT_DISPUTED', _payment.group_id, _payment.id);

  RETURN _payment;
END;
$$;


-- ============================================================
-- PART 5: FIX cancel_payment  (SEC-02)
-- ============================================================

-- SEC-02: Allow cancel when PENDING or DISPUTED, only sender, with FOR UPDATE lock
CREATE OR REPLACE FUNCTION public.cancel_payment(_payment_id UUID)
RETURNS public.payments
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  _payment public.payments;
  _caller UUID;
  _role TEXT;
  _old_status TEXT;
BEGIN
  _caller := public.assert_authenticated();

  -- Lock payment row FOR UPDATE
  SELECT * INTO _payment
  FROM public.payments
  WHERE id = _payment_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'PAYMENT_NOT_FOUND: Payment does not exist.';
  END IF;

  -- BE-03: group + membership check
  _role := public.assert_active_member_of_active_group(_payment.group_id);

  -- Only sender can cancel (NULL-safe)
  IF _caller IS DISTINCT FROM _payment.from_id THEN
    RAISE EXCEPTION 'NOT_SENDER: Only the sender can cancel a payment.';
  END IF;

  -- Allow cancel when PENDING or DISPUTED
  IF _payment.status NOT IN ('PENDING', 'DISPUTED') THEN
    RAISE EXCEPTION 'INVALID_STATUS: Can only cancel PENDING or DISPUTED payments (current: %).', _payment.status;
  END IF;

  _old_status := _payment.status;

  -- Update
  UPDATE public.payments
  SET status = 'CANCELLED',
      decided_at = now(),
      decided_by = _caller
  WHERE id = _payment_id
  RETURNING * INTO _payment;

  -- Activity log
  INSERT INTO public.activity_logs (group_id, actor_id, action, entity_type, entity_id, before, after)
  VALUES (
    _payment.group_id,
    _caller,
    'PAYMENT_CANCELLED',
    'PAYMENT',
    _payment.id,
    jsonb_build_object('status', _old_status),
    jsonb_build_object(
      'status', 'CANCELLED',
      'amount', _payment.amount,
      'from_id', _payment.from_id,
      'to_id', _payment.to_id
    )
  );

  -- Notify receiver
  INSERT INTO public.notifications (user_id, type, group_id, payment_id)
  VALUES (_payment.to_id, 'PAYMENT_CANCELLED', _payment.group_id, _payment.id);

  RETURN _payment;
END;
$$;


-- ============================================================
-- PART 6: FIX update_expense — row locking + version in WHERE  (BE-02)
-- ============================================================

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

  -- BE-02: Lock expense row FOR UPDATE to prevent concurrent edits
  SELECT * INTO _expense
  FROM public.expenses
  WHERE id = _expense_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'EXPENSE_NOT_FOUND: Expense does not exist.';
  END IF;

  -- Kiểm tra khoản chi đang ACTIVE
  IF _expense.status IS DISTINCT FROM 'ACTIVE' THEN
    RAISE EXCEPTION 'EXPENSE_CANCELLED: Expense is cancelled, cannot edit.';
  END IF;

  -- BE-03: group + membership check
  _role := public.assert_active_member_of_active_group(_expense.group_id);

  -- Lấy nhóm (for owner check)
  SELECT * INTO _group FROM public.groups WHERE id = _expense.group_id;

  -- Chỉ người tạo hoặc chủ nhóm mới được sửa (NULL-safe)
  IF _caller IS DISTINCT FROM _expense.created_by AND _caller IS DISTINCT FROM _group.owner_id THEN
    RAISE EXCEPTION 'NOT_AUTHORIZED: Only the creator or group owner can edit this expense.';
  END IF;

  -- Kiểm tra người trả mới là thành viên ACTIVE
  IF NOT EXISTS (
    SELECT 1 FROM public.group_members
    WHERE group_id = _expense.group_id AND user_id = _paid_by AND status = 'ACTIVE'
  ) THEN
    RAISE EXCEPTION 'PAYER_NOT_MEMBER: Payer is not an active member of this group.';
  END IF;

  -- Validate split_method
  IF _split_method NOT IN ('EQUAL', 'PERCENT', 'EXACT') THEN
    RAISE EXCEPTION 'INVALID_SPLIT_METHOD: Invalid split method: %', _split_method;
  END IF;

  -- Validate _amount
  IF _amount IS NULL OR _amount <= 0 THEN
    RAISE EXCEPTION 'INVALID_AMOUNT: Amount must be a positive integer.';
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
      RAISE EXCEPTION 'SHARE_USER_NOT_MEMBER: User % is not an active member of this group.', _share_user_id;
    END IF;

    _share_total := _share_total + _share_amount;
  END LOOP;

  -- Kiểm tra tổng phần chia = tổng khoản chi
  IF _share_total <> _amount THEN
    RAISE EXCEPTION 'SHARE_MISMATCH: Total shares (%) does not equal expense amount (%)', _share_total, _amount;
  END IF;

  -- BE-02: Use version in WHERE clause for optimistic locking
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
    AND version = _expected_version;

  GET DIAGNOSTICS _update_count = ROW_COUNT;

  -- BE-02: If 0 rows affected, version has changed between our SELECT FOR UPDATE and now
  -- (should not happen due to FOR UPDATE, but defensive check)
  IF _update_count = 0 THEN
    RAISE EXCEPTION 'VERSION_CONFLICT: Expense was modified concurrently. Please reload and retry.';
  END IF;

  -- Re-read updated row
  SELECT * INTO _expense FROM public.expenses WHERE id = _expense_id;

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


-- ============================================================
-- PART 7: FIX create_expense — idempotency scoped to user (BE-09) + group check (BE-03)
-- ============================================================

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

  -- BE-09: Idempotency scoped to (created_by, idempotency_key)
  SELECT * INTO _expense
  FROM public.expenses
  WHERE created_by = _caller
    AND idempotency_key = _idempotency_key;
  IF FOUND THEN
    RETURN _expense;
  END IF;

  -- BE-03: group ACTIVE + membership check
  _role := public.assert_active_member_of_active_group(_group_id);

  -- Kiểm tra người trả là thành viên ACTIVE
  IF NOT EXISTS (
    SELECT 1 FROM public.group_members
    WHERE group_id = _group_id AND user_id = _paid_by AND status = 'ACTIVE'
  ) THEN
    RAISE EXCEPTION 'PAYER_NOT_MEMBER: Payer is not an active member of this group.';
  END IF;

  -- Validate split_method
  IF _split_method NOT IN ('EQUAL', 'PERCENT', 'EXACT') THEN
    RAISE EXCEPTION 'INVALID_SPLIT_METHOD: Invalid split method: %', _split_method;
  END IF;

  -- Validate _amount
  IF _amount IS NULL OR _amount <= 0 THEN
    RAISE EXCEPTION 'INVALID_AMOUNT: Amount must be a positive integer.';
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
      RAISE EXCEPTION 'SHARE_USER_NOT_MEMBER: User % is not an active member of this group.', _share_user_id;
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
    RAISE EXCEPTION 'SHARE_MISMATCH: Total shares (%) does not equal expense amount (%)', _share_total, _amount;
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


-- ============================================================
-- PART 8: FIX cancel_expense — add auth + group check (SEC-02, BE-03)
-- ============================================================

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

  -- Lấy khoản chi
  SELECT * INTO _expense FROM public.expenses WHERE id = _expense_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'EXPENSE_NOT_FOUND: Expense does not exist.';
  END IF;

  -- Đã hủy thì bỏ qua (idempotent)
  IF _expense.status = 'CANCELLED' THEN
    RETURN _expense;
  END IF;

  -- BE-03: group + membership check
  _role := public.assert_active_member_of_active_group(_expense.group_id);

  -- Lấy nhóm
  SELECT * INTO _group FROM public.groups WHERE id = _expense.group_id;

  -- Chỉ người tạo hoặc chủ nhóm mới được hủy (NULL-safe)
  IF _caller IS DISTINCT FROM _expense.created_by AND _caller IS DISTINCT FROM _group.owner_id THEN
    RAISE EXCEPTION 'NOT_AUTHORIZED: Only the creator or group owner can cancel this expense.';
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


-- ============================================================
-- PART 9: FIX update_group, revoke_invite, transfer_ownership — add assert_authenticated  (SEC-02)
-- ============================================================

-- SEC-02: update_group
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
  _caller UUID;
BEGIN
  _caller := public.assert_authenticated();

  -- Lấy nhóm
  SELECT * INTO _group FROM public.groups WHERE id = _group_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'GROUP_NOT_FOUND: Group does not exist.';
  END IF;

  -- Chỉ chủ nhóm mới được cập nhật (NULL-safe)
  IF _caller IS DISTINCT FROM _group.owner_id THEN
    RAISE EXCEPTION 'NOT_OWNER: Only the group owner can update group settings.';
  END IF;

  -- Nhóm phải đang ACTIVE
  IF _group.status IS DISTINCT FROM 'ACTIVE' THEN
    RAISE EXCEPTION 'GROUP_CLOSED: Group is closed, cannot update.';
  END IF;

  -- Validate tên
  IF length(trim(_name)) = 0 THEN
    RAISE EXCEPTION 'INVALID_NAME: Group name cannot be empty.';
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
    _caller,
    'UPDATE',
    'GROUP',
    _group_id,
    jsonb_build_object('name', _old_name, 'description', _old_desc, 'simplify_debts', _old_simplify),
    jsonb_build_object('name', _group.name, 'description', _group.description, 'simplify_debts', _group.simplify_debts)
  );

  RETURN _group;
END;
$$;

-- SEC-02: revoke_invite — fix NULL auth.uid() bypass
CREATE OR REPLACE FUNCTION public.revoke_invite(_invite_id UUID)
RETURNS public.group_invites
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  _invite public.group_invites;
  _group public.groups;
  _caller UUID;
BEGIN
  _caller := public.assert_authenticated();

  -- Lấy lời mời
  SELECT * INTO _invite FROM public.group_invites WHERE id = _invite_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'INVITE_NOT_FOUND: Invite does not exist.';
  END IF;

  -- Đã thu hồi thì bỏ qua (idempotent)
  IF _invite.revoked_at IS NOT NULL THEN
    RETURN _invite;
  END IF;

  -- Lấy nhóm
  SELECT * INTO _group FROM public.groups WHERE id = _invite.group_id;

  -- Chỉ người tạo hoặc chủ nhóm mới được thu hồi (NULL-safe)
  IF _caller IS DISTINCT FROM _invite.created_by AND _caller IS DISTINCT FROM _group.owner_id THEN
    RAISE EXCEPTION 'NOT_AUTHORIZED: Only the invite creator or group owner can revoke this invite.';
  END IF;

  -- Thu hồi
  UPDATE public.group_invites
  SET revoked_at = now()
  WHERE id = _invite_id
  RETURNING * INTO _invite;

  RETURN _invite;
END;
$$;

-- SEC-02: transfer_ownership — fix NULL auth.uid() bypass
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

  -- Lấy nhóm
  SELECT * INTO _group FROM public.groups WHERE id = _group_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'GROUP_NOT_FOUND: Group does not exist.';
  END IF;

  -- Nhóm phải đang ACTIVE
  IF _group.status IS DISTINCT FROM 'ACTIVE' THEN
    RAISE EXCEPTION 'GROUP_CLOSED: Group is closed, cannot transfer ownership.';
  END IF;

  -- Chỉ chủ nhóm hiện tại mới được chuyển (NULL-safe)
  IF _caller IS DISTINCT FROM _group.owner_id THEN
    RAISE EXCEPTION 'NOT_OWNER: Only the current owner can transfer ownership.';
  END IF;

  -- Không chuyển cho chính mình
  IF _new_owner_id = _caller THEN
    RAISE EXCEPTION 'ALREADY_OWNER: You are already the owner.';
  END IF;

  -- Người nhận phải là thành viên ACTIVE
  IF NOT EXISTS (
    SELECT 1 FROM public.group_members
    WHERE group_id = _group_id AND user_id = _new_owner_id AND status = 'ACTIVE'
  ) THEN
    RAISE EXCEPTION 'TARGET_NOT_MEMBER: The target user is not an active member of this group.';
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


-- ============================================================
-- PART 10: FIX accept_invite — row lock (BE-06), block REMOVED (BE-07)
-- ============================================================

CREATE OR REPLACE FUNCTION public.accept_invite(_token TEXT)
RETURNS public.groups
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  _invite public.group_invites;
  _group public.groups;
  _existing_member public.group_members;
  _caller UUID;
BEGIN
  _caller := public.assert_authenticated();

  -- BE-06: Lock invite row FOR UPDATE to prevent race on used_count
  SELECT * INTO _invite
  FROM public.group_invites
  WHERE token = _token
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'INVITE_NOT_FOUND: Invite does not exist.';
  END IF;

  -- Kiểm tra đã bị thu hồi
  IF _invite.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'INVITE_REVOKED: This invite has been revoked.';
  END IF;

  -- Kiểm tra hết hạn
  IF _invite.expires_at < now() THEN
    RAISE EXCEPTION 'INVITE_EXPIRED: This invite has expired.';
  END IF;

  -- Kiểm tra số lần sử dụng
  IF _invite.used_count >= _invite.max_uses THEN
    RAISE EXCEPTION 'INVITE_EXHAUSTED: This invite has been fully used.';
  END IF;

  -- Nếu là lời mời nhắm đến người cụ thể, kiểm tra caller (NULL-safe)
  IF _invite.invited_user_id IS NOT NULL AND _invite.invited_user_id IS DISTINCT FROM _caller THEN
    RAISE EXCEPTION 'INVITE_NOT_FOR_YOU: This invite is not intended for you.';
  END IF;

  -- Lấy nhóm
  SELECT * INTO _group FROM public.groups WHERE id = _invite.group_id;

  -- Kiểm tra nhóm phải ACTIVE
  IF _group.status IS DISTINCT FROM 'ACTIVE' THEN
    RAISE EXCEPTION 'GROUP_CLOSED: Group is closed, cannot join.';
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

    -- BE-07: REMOVED members cannot rejoin
    IF _existing_member.status = 'REMOVED' THEN
      RAISE EXCEPTION 'MEMBER_REMOVED: You were removed from this group and cannot rejoin.';
    END IF;

    -- LEFT members can rejoin → reactivate
    IF _existing_member.status = 'LEFT' THEN
      UPDATE public.group_members
      SET status = 'ACTIVE', left_at = NULL, joined_at = now()
      WHERE group_id = _invite.group_id AND user_id = _caller;
    END IF;
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


-- ============================================================
-- PART 11: FIX join_group — block REMOVED (BE-07) + auth check (SEC-02)
-- ============================================================

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

  -- Tìm nhóm theo mã mời
  SELECT * INTO _group FROM public.groups WHERE invite_code = upper(trim(_code));
  IF NOT FOUND THEN
    RAISE EXCEPTION 'INVITE_CODE_NOT_FOUND: Invalid invite code.';
  END IF;

  -- Nhóm phải đang ACTIVE
  IF _group.status IS DISTINCT FROM 'ACTIVE' THEN
    RAISE EXCEPTION 'GROUP_CLOSED: Group is closed, cannot join.';
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

    -- BE-07: REMOVED members cannot rejoin via invite_code
    IF _existing_member.status = 'REMOVED' THEN
      RAISE EXCEPTION 'MEMBER_REMOVED: You were removed from this group and cannot rejoin.';
    END IF;

    -- LEFT → kích hoạt lại
    IF _existing_member.status = 'LEFT' THEN
      UPDATE public.group_members
      SET status = 'ACTIVE', left_at = NULL, joined_at = now()
      WHERE group_id = _group.id AND user_id = _caller;
    END IF;
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


-- ============================================================
-- PART 12: FIX leave_group, remove_member, close_group — row lock (BE-08) + auth (SEC-02)
-- ============================================================

-- BE-08 + SEC-02: leave_group — lock groups row
CREATE OR REPLACE FUNCTION public.leave_group(_group_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  _group public.groups;
  _caller UUID;
  _balance BIGINT;
  _has_pending BOOLEAN;
BEGIN
  _caller := public.assert_authenticated();

  -- BE-08: Lock groups row FOR UPDATE to prevent race conditions
  SELECT * INTO _group
  FROM public.groups
  WHERE id = _group_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'GROUP_NOT_FOUND: Group does not exist.';
  END IF;

  -- Nhóm phải đang ACTIVE
  IF _group.status IS DISTINCT FROM 'ACTIVE' THEN
    RAISE EXCEPTION 'GROUP_CLOSED: Group is closed.';
  END IF;

  -- Kiểm tra người gọi là thành viên ACTIVE
  IF NOT EXISTS (
    SELECT 1 FROM public.group_members
    WHERE group_id = _group_id AND user_id = _caller AND status = 'ACTIVE'
  ) THEN
    RAISE EXCEPTION 'NOT_MEMBER: You are not an active member of this group.';
  END IF;

  -- Chủ nhóm phải chuyển quyền trước
  IF _group.owner_id = _caller THEN
    RAISE EXCEPTION 'OWNER_CANNOT_LEAVE: Owner must transfer ownership before leaving.';
  END IF;

  -- BR-11: Kiểm tra số dư chính thức phải = 0
  SELECT COALESCE(gb.official_balance, 0) INTO _balance
  FROM public.group_balances gb
  WHERE gb.group_id = _group_id AND gb.user_id = _caller;

  IF _balance <> 0 THEN
    RAISE EXCEPTION 'NONZERO_BALANCE: You have an unsettled balance (%), cannot leave.', _balance;
  END IF;

  -- BR-11: Kiểm tra không có thanh toán PENDING
  SELECT EXISTS (
    SELECT 1 FROM public.payments p
    WHERE p.group_id = _group_id
      AND p.status = 'PENDING'
      AND (p.from_id = _caller OR p.to_id = _caller)
  ) INTO _has_pending;

  IF _has_pending THEN
    RAISE EXCEPTION 'PENDING_PAYMENTS: You have pending payments, cannot leave.';
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

-- BE-08 + SEC-02: remove_member — lock groups row
CREATE OR REPLACE FUNCTION public.remove_member(_group_id UUID, _user_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  _group public.groups;
  _caller UUID;
  _balance BIGINT;
  _has_pending BOOLEAN;
BEGIN
  _caller := public.assert_authenticated();

  -- BE-08: Lock groups row FOR UPDATE
  SELECT * INTO _group
  FROM public.groups
  WHERE id = _group_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'GROUP_NOT_FOUND: Group does not exist.';
  END IF;

  -- Nhóm phải đang ACTIVE
  IF _group.status IS DISTINCT FROM 'ACTIVE' THEN
    RAISE EXCEPTION 'GROUP_CLOSED: Group is closed, cannot remove members.';
  END IF;

  -- Chỉ chủ nhóm mới được xóa (NULL-safe)
  IF _caller IS DISTINCT FROM _group.owner_id THEN
    RAISE EXCEPTION 'NOT_OWNER: Only the group owner can remove members.';
  END IF;

  -- Không được tự xóa mình
  IF _user_id = _caller THEN
    RAISE EXCEPTION 'CANNOT_REMOVE_SELF: Owner cannot remove themselves.';
  END IF;

  -- Kiểm tra thành viên có trong nhóm và ACTIVE
  IF NOT EXISTS (
    SELECT 1 FROM public.group_members
    WHERE group_id = _group_id AND user_id = _user_id AND status = 'ACTIVE'
  ) THEN
    RAISE EXCEPTION 'TARGET_NOT_MEMBER: User is not an active member of this group.';
  END IF;

  -- BR-11: Kiểm tra số dư chính thức phải = 0
  SELECT COALESCE(gb.official_balance, 0) INTO _balance
  FROM public.group_balances gb
  WHERE gb.group_id = _group_id AND gb.user_id = _user_id;

  IF _balance <> 0 THEN
    RAISE EXCEPTION 'NONZERO_BALANCE: Member has an unsettled balance (%), cannot remove.', _balance;
  END IF;

  -- BR-11: Kiểm tra không có thanh toán PENDING liên quan
  SELECT EXISTS (
    SELECT 1 FROM public.payments p
    WHERE p.group_id = _group_id
      AND p.status = 'PENDING'
      AND (p.from_id = _user_id OR p.to_id = _user_id)
  ) INTO _has_pending;

  IF _has_pending THEN
    RAISE EXCEPTION 'PENDING_PAYMENTS: Member has pending payments, cannot remove.';
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
    _caller,
    'REMOVE',
    'MEMBER',
    _user_id,
    jsonb_build_object('removed_user_id', _user_id)
  );
END;
$$;

-- BE-08 + SEC-02: close_group — lock groups row
CREATE OR REPLACE FUNCTION public.close_group(_group_id UUID)
RETURNS public.groups
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  _group public.groups;
  _caller UUID;
  _nonzero_count INT;
  _has_pending BOOLEAN;
BEGIN
  _caller := public.assert_authenticated();

  -- BE-08: Lock groups row FOR UPDATE
  SELECT * INTO _group
  FROM public.groups
  WHERE id = _group_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'GROUP_NOT_FOUND: Group does not exist.';
  END IF;

  -- Đã đóng thì bỏ qua (idempotent)
  IF _group.status = 'CLOSED' THEN
    RETURN _group;
  END IF;

  -- Chỉ chủ nhóm mới được đóng (NULL-safe)
  IF _caller IS DISTINCT FROM _group.owner_id THEN
    RAISE EXCEPTION 'NOT_OWNER: Only the group owner can close the group.';
  END IF;

  -- Kiểm tra TẤT CẢ thành viên phải có số dư = 0
  SELECT COUNT(*) INTO _nonzero_count
  FROM public.group_balances gb
  WHERE gb.group_id = _group_id AND gb.official_balance <> 0;

  IF _nonzero_count > 0 THEN
    RAISE EXCEPTION 'UNSETTLED_BALANCES: % members still have unsettled balances.', _nonzero_count;
  END IF;

  -- Kiểm tra không có thanh toán PENDING trong nhóm
  SELECT EXISTS (
    SELECT 1 FROM public.payments p
    WHERE p.group_id = _group_id AND p.status = 'PENDING'
  ) INTO _has_pending;

  IF _has_pending THEN
    RAISE EXCEPTION 'PENDING_PAYMENTS: Group has pending payments, cannot close.';
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
    _caller,
    'CLOSE',
    'GROUP',
    _group_id
  );

  RETURN _group;
END;
$$;


-- ============================================================
-- PART 13: FIX create_invite — add auth check + validation (SEC-02, SEC-07)
-- ============================================================

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
  _caller UUID;
  _role TEXT;
BEGIN
  _caller := public.assert_authenticated();

  -- BE-03: group + membership check
  _role := public.assert_active_member_of_active_group(_group_id);

  -- SEC-07: validate _max_uses (1-100)
  IF _max_uses IS NULL OR _max_uses < 1 OR _max_uses > 100 THEN
    RAISE EXCEPTION 'INVALID_MAX_USES: max_uses must be between 1 and 100.';
  END IF;

  -- SEC-07: validate _expires_hours (1-8760 = 1 year)
  IF _expires_hours IS NULL OR _expires_hours < 1 OR _expires_hours > 8760 THEN
    RAISE EXCEPTION 'INVALID_EXPIRES_HOURS: expires_hours must be between 1 and 8760.';
  END IF;

  -- SEC-07: validate invited_user_id if provided
  IF _invited_user_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.profiles
      WHERE id = _invited_user_id AND deleted_at IS NULL
    ) THEN
      RAISE EXCEPTION 'INVALID_USER: The invited user does not exist.';
    END IF;
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
      RAISE EXCEPTION 'TOKEN_GENERATION_FAILED: Could not generate unique token after 100 attempts.';
    END IF;
  END LOOP;

  -- Tạo lời mời
  INSERT INTO public.group_invites (group_id, token, invited_user_id, created_by, expires_at, max_uses)
  VALUES (
    _group_id,
    _token,
    _invited_user_id,
    _caller,
    now() + (_expires_hours || ' hours')::interval,
    _max_uses
  )
  RETURNING * INTO _invite;

  -- Ghi activity log
  INSERT INTO public.activity_logs (group_id, actor_id, action, entity_type, entity_id, after)
  VALUES (
    _group_id,
    _caller,
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


-- ============================================================
-- PART 14: FIX create_group — add auth check (SEC-02)
-- ============================================================

CREATE OR REPLACE FUNCTION public.create_group(_name TEXT)
RETURNS public.groups
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  _group public.groups;
  _caller UUID;
BEGIN
  _caller := public.assert_authenticated();

  IF length(trim(_name)) = 0 THEN
    RAISE EXCEPTION 'INVALID_NAME: Group name cannot be empty.';
  END IF;

  INSERT INTO public.groups (name, owner_id)
  VALUES (trim(_name), _caller)
  RETURNING * INTO _group;

  INSERT INTO public.group_members (group_id, user_id, role)
  VALUES (_group.id, _caller, 'owner');

  RETURN _group;
END;
$$;


-- ============================================================
-- PART 15: FIX search_users — escape LIKE chars + min length (SEC-06)
-- ============================================================

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
  _caller UUID;
  _sanitized TEXT;
  _like_pattern TEXT;
BEGIN
  _caller := public.assert_authenticated();

  -- Chuẩn hoá query
  _sanitized := trim(_query);

  IF _sanitized IS NULL OR _sanitized = '' THEN
    RAISE EXCEPTION 'EMPTY_QUERY: Search query cannot be empty.';
  END IF;

  -- SEC-06: Require minimum 2 characters
  IF length(_sanitized) < 2 THEN
    RAISE EXCEPTION 'QUERY_TOO_SHORT: Search query must be at least 2 characters.';
  END IF;

  -- SEC-06: Escape LIKE special characters: % _ \
  _like_pattern := '%'
    || replace(replace(replace(_sanitized, '\', '\\'), '%', '\%'), '_', '\_')
    || '%';

  RETURN QUERY
  SELECT p.id, p.display_name, p.user_code, p.avatar_path
  FROM public.profiles p
  WHERE p.searchable = true
    AND p.deleted_at IS NULL
    AND p.id <> _caller
    AND (
      p.display_name ILIKE _like_pattern
      OR p.user_code = _sanitized
    )
  ORDER BY
    -- Ưu tiên kết quả khớp chính xác user_code
    CASE WHEN p.user_code = _sanitized THEN 0 ELSE 1 END,
    p.display_name
  LIMIT 20;
END;
$$;


-- ============================================================
-- PART 16: FIX friend RPCs — add auth check (SEC-02)
-- ============================================================

CREATE OR REPLACE FUNCTION public.send_friend_request(_addressee_id UUID)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  _caller UUID;
  _existing RECORD;
BEGIN
  _caller := public.assert_authenticated();

  -- Không thể tự gửi cho chính mình
  IF _caller = _addressee_id THEN
    RAISE EXCEPTION 'SELF_REQUEST: Cannot send a friend request to yourself.';
  END IF;

  -- Kiểm tra người nhận tồn tại
  IF NOT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = _addressee_id AND deleted_at IS NULL
  ) THEN
    RAISE EXCEPTION 'USER_NOT_FOUND: User does not exist.';
  END IF;

  -- Kiểm tra friendship đã tồn tại (cả hai chiều)
  SELECT status, responded_at INTO _existing
  FROM public.friendships
  WHERE (requester_id = _caller AND addressee_id = _addressee_id)
     OR (requester_id = _addressee_id AND addressee_id = _caller)
  LIMIT 1;

  IF FOUND THEN
    IF _existing.status = 'PENDING' THEN
      RAISE EXCEPTION 'ALREADY_PENDING: A friend request is already pending.';
    END IF;

    IF _existing.status = 'ACCEPTED' THEN
      RAISE EXCEPTION 'ALREADY_FRIENDS: You are already friends.';
    END IF;

    -- DECLINED: kiểm tra đã quá 7 ngày chưa
    IF _existing.status = 'DECLINED' THEN
      IF _existing.responded_at IS NOT NULL
         AND _existing.responded_at > now() - INTERVAL '7 days' THEN
        RAISE EXCEPTION 'DECLINED_COOLDOWN: Request was declined. Please try again after 7 days.';
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
  _caller UUID;
  _friendship RECORD;
BEGIN
  _caller := public.assert_authenticated();

  -- Caller phải là addressee
  SELECT * INTO _friendship
  FROM public.friendships
  WHERE requester_id = _requester_id
    AND addressee_id = _caller
    AND status = 'PENDING';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'REQUEST_NOT_FOUND: No pending friend request found.';
  END IF;

  IF _accept THEN
    UPDATE public.friendships
    SET status = 'ACCEPTED', responded_at = now()
    WHERE requester_id = _requester_id
      AND addressee_id = _caller;

    INSERT INTO public.notifications (user_id, type, actor_id)
    VALUES (_requester_id, 'FRIEND_ACCEPTED', _caller);
  ELSE
    UPDATE public.friendships
    SET status = 'DECLINED', responded_at = now()
    WHERE requester_id = _requester_id
      AND addressee_id = _caller;

    INSERT INTO public.notifications (user_id, type, actor_id)
    VALUES (_requester_id, 'FRIEND_DECLINED', _caller);
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.unfriend(_friend_id UUID)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  _caller UUID;
  _deleted INT;
BEGIN
  _caller := public.assert_authenticated();

  DELETE FROM public.friendships
  WHERE (requester_id = _caller AND addressee_id = _friend_id)
     OR (requester_id = _friend_id AND addressee_id = _caller);

  GET DIAGNOSTICS _deleted = ROW_COUNT;

  IF _deleted = 0 THEN
    RAISE EXCEPTION 'FRIENDSHIP_NOT_FOUND: No friendship found with this user.';
  END IF;
END;
$$;


-- ============================================================
-- PART 17: PROFILES POLICY FIX + public_profiles VIEW  (SEC-04, SEC-05)
-- ============================================================

-- SEC-04: Drop the overly-broad profile read policy
DROP POLICY IF EXISTS "Group members can read each others profiles" ON public.profiles;

-- SEC-04: Create restrictive policy — users can only read their own full profile
-- (The original "Users can read own profile" from 0001_init.sql already exists,
-- but we re-create it to be safe / idempotent)
DROP POLICY IF EXISTS "Users can read own profile" ON public.profiles;
CREATE POLICY "Users can read own profile"
  ON public.profiles FOR SELECT
  USING (id = auth.uid());

-- SEC-04: Create public_profiles view with limited columns
CREATE OR REPLACE VIEW public.public_profiles AS
SELECT
  p.id,
  p.display_name,
  p.user_code,
  p.avatar_path
FROM public.profiles p
WHERE p.deleted_at IS NULL;

-- Grant SELECT on the view to authenticated (will be covered by global GRANT below)
-- The view uses security_invoker by default in newer PG, but we rely on
-- the underlying table's RLS. Since this is SECURITY INVOKER, the user's
-- SELECT policies on profiles apply. But we want broader read here,
-- so we need a policy that allows reading any non-deleted profile via the view.
-- However, to keep direct table access restricted while allowing view access,
-- we create a function-based approach instead.

-- Actually, for Supabase (PostgREST), views bypass RLS by default when owned by
-- a superuser. We can make the view available. But if we want to ensure
-- the view is queryable by authenticated users:
GRANT SELECT ON public.public_profiles TO authenticated;

-- SEC-05: Drop old UPDATE policy, replace with RPC
DROP POLICY IF EXISTS "Users can update own profile" ON public.profiles;

-- SEC-05: Prevent direct UPDATE — no UPDATE policy at all now
-- All profile updates go through this RPC:
CREATE OR REPLACE FUNCTION public.update_profile(
  _display_name TEXT DEFAULT NULL,
  _avatar_path TEXT DEFAULT NULL,
  _searchable BOOLEAN DEFAULT NULL
)
RETURNS public.profiles
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  _caller UUID;
  _profile public.profiles;
BEGIN
  _caller := public.assert_authenticated();

  SELECT * INTO _profile FROM public.profiles WHERE id = _caller;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PROFILE_NOT_FOUND: Profile not found.';
  END IF;

  UPDATE public.profiles
  SET display_name = COALESCE(_display_name, display_name),
      avatar_path = COALESCE(_avatar_path, avatar_path),
      searchable = COALESCE(_searchable, searchable)
  WHERE id = _caller
  RETURNING * INTO _profile;

  RETURN _profile;
END;
$$;


-- ============================================================
-- PART 18: RECEIPT STORAGE POLICY FIX  (SEC-09)
-- ============================================================

-- SEC-09: Drop overly broad upload/update/delete policies for receipts
DROP POLICY IF EXISTS "Group members can upload receipts" ON storage.objects;
DROP POLICY IF EXISTS "Group members can update receipts" ON storage.objects;
DROP POLICY IF EXISTS "Group members can delete receipts" ON storage.objects;

-- SEC-09: Only expense creator or group owner can upload receipts
-- Path format: receipts/{group_id}/{expense_id}/filename
CREATE POLICY "Expense creator or owner can upload receipts"
  ON storage.objects FOR INSERT
  WITH CHECK (
    bucket_id = 'receipts'
    AND (
      -- User is the expense creator
      EXISTS (
        SELECT 1 FROM public.expenses e
        JOIN public.groups g ON g.id = e.group_id
        WHERE e.group_id = ((storage.foldername(name))[1])::UUID
          AND (e.created_by = auth.uid() OR g.owner_id = auth.uid())
      )
    )
  );

-- SEC-09: Only expense creator or group owner can update receipts
CREATE POLICY "Expense creator or owner can update receipts"
  ON storage.objects FOR UPDATE
  USING (
    bucket_id = 'receipts'
    AND (
      EXISTS (
        SELECT 1 FROM public.expenses e
        JOIN public.groups g ON g.id = e.group_id
        WHERE e.group_id = ((storage.foldername(name))[1])::UUID
          AND (e.created_by = auth.uid() OR g.owner_id = auth.uid())
      )
    )
  );

-- SEC-09: Only expense creator or group owner can delete receipts
CREATE POLICY "Expense creator or owner can delete receipts"
  ON storage.objects FOR DELETE
  USING (
    bucket_id = 'receipts'
    AND (
      EXISTS (
        SELECT 1 FROM public.expenses e
        JOIN public.groups g ON g.id = e.group_id
        WHERE e.group_id = ((storage.foldername(name))[1])::UUID
          AND (e.created_by = auth.uid() OR g.owner_id = auth.uid())
      )
    )
  );


-- ============================================================
-- PART 19: LEFT MEMBERS CAN READ HISTORY  (BE-12)
-- ============================================================

-- BE-12: Update is_member to also return true for LEFT members
-- But we want a separate function for read access vs write access.
-- The current is_member is used for RLS SELECT policies and only checks ACTIVE.
-- We create a broader check for read access:

CREATE OR REPLACE FUNCTION public.is_member_or_was_member(_group_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER SET search_path = ''
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.group_members
    WHERE group_id = _group_id
      AND user_id = auth.uid()
      AND status IN ('ACTIVE', 'LEFT')
  );
$$;

-- BE-12: expenses — LEFT members can read expenses created before they left
DROP POLICY IF EXISTS "Members can read expenses" ON public.expenses;
CREATE POLICY "Members can read expenses"
  ON public.expenses FOR SELECT
  USING (
    public.is_member(group_id)
    OR (
      -- LEFT members: can read expenses created before they left
      EXISTS (
        SELECT 1 FROM public.group_members gm
        WHERE gm.group_id = expenses.group_id
          AND gm.user_id = auth.uid()
          AND gm.status = 'LEFT'
          AND expenses.created_at <= gm.left_at
      )
    )
  );

-- BE-12: expense_shares — LEFT members can read shares for expenses they can see
DROP POLICY IF EXISTS "Members can read expense_shares" ON public.expense_shares;
CREATE POLICY "Members can read expense_shares"
  ON public.expense_shares FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.expenses e
      WHERE e.id = expense_shares.expense_id
        AND (
          public.is_member(e.group_id)
          OR EXISTS (
            SELECT 1 FROM public.group_members gm
            WHERE gm.group_id = e.group_id
              AND gm.user_id = auth.uid()
              AND gm.status = 'LEFT'
              AND e.created_at <= gm.left_at
          )
        )
    )
  );

-- BE-12: payments — LEFT members can read payments created before they left
DROP POLICY IF EXISTS "Members can read payments" ON public.payments;
CREATE POLICY "Members can read payments"
  ON public.payments FOR SELECT
  USING (
    public.is_member(group_id)
    OR (
      EXISTS (
        SELECT 1 FROM public.group_members gm
        WHERE gm.group_id = payments.group_id
          AND gm.user_id = auth.uid()
          AND gm.status = 'LEFT'
          AND payments.created_at <= gm.left_at
      )
    )
  );

-- BE-12: activity_logs — LEFT members can read logs created before they left
DROP POLICY IF EXISTS "Members can read activity_logs" ON public.activity_logs;
CREATE POLICY "Members can read activity_logs"
  ON public.activity_logs FOR SELECT
  USING (
    public.is_member(group_id)
    OR (
      EXISTS (
        SELECT 1 FROM public.group_members gm
        WHERE gm.group_id = activity_logs.group_id
          AND gm.user_id = auth.uid()
          AND gm.status = 'LEFT'
          AND activity_logs.created_at <= gm.left_at
      )
    )
  );

-- BE-12: groups — LEFT members can still read the group info
DROP POLICY IF EXISTS "Members can read groups" ON public.groups;
CREATE POLICY "Members can read groups"
  ON public.groups FOR SELECT
  USING (public.is_member_or_was_member(id));

-- BE-12: group_members — LEFT members can read member list
DROP POLICY IF EXISTS "Members can read group_members" ON public.group_members;
CREATE POLICY "Members can read group_members"
  ON public.group_members FOR SELECT
  USING (public.is_member_or_was_member(group_id));

-- BE-12: group_invites — keep ACTIVE-only for invites (no change needed for LEFT)
-- LEFT members should not see current invites


-- ============================================================
-- PART 20: GLOBAL GRANT/REVOKE  (SEC-02, SEC-08)
-- ============================================================

-- SEC-02 / SEC-08: Revoke all function execute from anon and public
-- This prevents unauthenticated users from calling any RPC
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM anon, public;

-- SEC-02: Grant execute to authenticated only
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO authenticated;

-- Ensure the trigger function can still be called by the trigger system
-- (triggers run as the table owner, which is typically the superuser,
-- so no explicit grant is needed for trigger functions)


-- ============================================================
-- PART 21: INDEXES for new patterns
-- ============================================================

-- Index to support idempotency scoped to (created_by, idempotency_key)
CREATE INDEX IF NOT EXISTS idx_expenses_created_by_idempotency
  ON public.expenses (created_by, idempotency_key);

-- Index to support idempotency for payments scoped to (from_id, idempotency_key)
CREATE INDEX IF NOT EXISTS idx_payments_from_id_idempotency
  ON public.payments (from_id, idempotency_key);


COMMIT;
