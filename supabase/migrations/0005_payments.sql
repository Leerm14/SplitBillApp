-- ============================
-- Migration 0005: Payment RPCs — dispute, cancel, and trigger
-- ============================

-- ============================
-- 1. RPC: dispute_payment — người nhận tranh chấp thanh toán đã xác nhận
-- ============================

CREATE OR REPLACE FUNCTION public.dispute_payment(_payment_id UUID, _reason TEXT)
RETURNS public.payments
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  _payment public.payments;
  _caller UUID := auth.uid();
BEGIN
  -- Lấy thông tin thanh toán
  SELECT * INTO _payment FROM public.payments WHERE id = _payment_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Thanh toán không tồn tại';
  END IF;

  -- Chỉ người nhận (to_id) mới được tranh chấp
  IF _caller <> _payment.to_id THEN
    RAISE EXCEPTION 'Chỉ người nhận mới được tranh chấp thanh toán';
  END IF;

  -- Chỉ tranh chấp khi đã CONFIRMED
  IF _payment.status <> 'CONFIRMED' THEN
    RAISE EXCEPTION 'Chỉ có thể tranh chấp thanh toán đã xác nhận';
  END IF;

  -- Kiểm tra lý do
  IF _reason IS NULL OR trim(_reason) = '' THEN
    RAISE EXCEPTION 'Vui lòng nhập lý do tranh chấp';
  END IF;

  -- Cập nhật trạng thái
  UPDATE public.payments
  SET status = 'DISPUTED',
      reason = trim(_reason),
      decided_at = now()
  WHERE id = _payment_id
  RETURNING * INTO _payment;

  -- Ghi activity log
  INSERT INTO public.activity_logs (group_id, actor_id, action, entity_type, entity_id, before, after)
  VALUES (
    _payment.group_id,
    _caller,
    'PAYMENT_DISPUTED',
    'PAYMENT',
    _payment.id,
    jsonb_build_object('status', 'CONFIRMED'),
    jsonb_build_object(
      'status', 'DISPUTED',
      'reason', trim(_reason),
      'amount', _payment.amount,
      'from_id', _payment.from_id,
      'to_id', _payment.to_id
    )
  );

  -- Thông báo cho người gửi
  INSERT INTO public.notifications (user_id, type, group_id, payment_id)
  VALUES (_payment.from_id, 'PAYMENT_DISPUTED', _payment.group_id, _payment.id);

  RETURN _payment;
END;
$$;

-- ============================
-- 2. RPC: cancel_payment — người gửi huỷ thanh toán đang chờ
-- ============================

CREATE OR REPLACE FUNCTION public.cancel_payment(_payment_id UUID)
RETURNS public.payments
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  _payment public.payments;
  _caller UUID := auth.uid();
BEGIN
  -- Lấy thông tin thanh toán
  SELECT * INTO _payment FROM public.payments WHERE id = _payment_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Thanh toán không tồn tại';
  END IF;

  -- Chỉ người gửi (from_id) mới được huỷ
  IF _caller <> _payment.from_id THEN
    RAISE EXCEPTION 'Chỉ người gửi mới được huỷ thanh toán';
  END IF;

  -- Chỉ huỷ khi đang PENDING
  IF _payment.status <> 'PENDING' THEN
    RAISE EXCEPTION 'Chỉ có thể huỷ thanh toán đang chờ xác nhận';
  END IF;

  -- Cập nhật trạng thái
  UPDATE public.payments
  SET status = 'CANCELLED',
      decided_at = now()
  WHERE id = _payment_id
  RETURNING * INTO _payment;

  -- Ghi activity log
  INSERT INTO public.activity_logs (group_id, actor_id, action, entity_type, entity_id, before, after)
  VALUES (
    _payment.group_id,
    _caller,
    'PAYMENT_CANCELLED',
    'PAYMENT',
    _payment.id,
    jsonb_build_object('status', 'PENDING'),
    jsonb_build_object(
      'status', 'CANCELLED',
      'amount', _payment.amount,
      'from_id', _payment.from_id,
      'to_id', _payment.to_id
    )
  );

  -- Thông báo cho người nhận
  INSERT INTO public.notifications (user_id, type, group_id, payment_id)
  VALUES (_payment.to_id, 'PAYMENT_CANCELLED', _payment.group_id, _payment.id);

  RETURN _payment;
END;
$$;

-- ============================
-- 3. TRIGGER: tự ghi log + thông báo khi tạo payment
-- ============================

CREATE OR REPLACE FUNCTION public.handle_payment_created()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  -- Ghi activity log
  INSERT INTO public.activity_logs (group_id, actor_id, action, entity_type, entity_id, after)
  VALUES (
    NEW.group_id,
    NEW.from_id,
    'PAYMENT_CREATED',
    'PAYMENT',
    NEW.id,
    jsonb_build_object(
      'amount', NEW.amount,
      'from_id', NEW.from_id,
      'to_id', NEW.to_id,
      'method', NEW.method,
      'note', NEW.note
    )
  );

  -- Thông báo cho người nhận
  INSERT INTO public.notifications (user_id, type, group_id, payment_id)
  VALUES (NEW.to_id, 'PAYMENT_CREATED', NEW.group_id, NEW.id);

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_payment_created ON public.payments;
CREATE TRIGGER on_payment_created
  AFTER INSERT ON public.payments
  FOR EACH ROW EXECUTE FUNCTION public.handle_payment_created();

-- ============================
-- 4. INDEXES: tối ưu truy vấn bảng payments
-- ============================

-- Truy vấn thanh toán theo nhóm, sắp xếp mới nhất
CREATE INDEX IF NOT EXISTS idx_payments_group_id
  ON public.payments (group_id, created_at DESC);

-- Truy vấn thanh toán người gửi
CREATE INDEX IF NOT EXISTS idx_payments_from_id
  ON public.payments (from_id, created_at DESC);

-- Truy vấn thanh toán người nhận
CREATE INDEX IF NOT EXISTS idx_payments_to_id
  ON public.payments (to_id, created_at DESC);

-- Lọc theo trạng thái (dùng cho dashboard, pending list)
CREATE INDEX IF NOT EXISTS idx_payments_status
  ON public.payments (status)
  WHERE status IN ('PENDING', 'DISPUTED');

-- Idempotency key lookup (đã có UNIQUE nhưng thêm explicit index cho rõ ràng)
-- Bỏ qua vì idempotency_key đã có UNIQUE constraint → tự có index
