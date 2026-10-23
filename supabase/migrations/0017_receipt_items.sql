-- ============================================================
-- Migration 0017: Món trên hóa đơn đọc bằng ML Kit (OCR-01, OCR-02, OCR-06)
-- 1. expenses.source: MANUAL (nhập tay) / OCR (đọc trên máy bằng ML Kit) / OCR_AI (dành cho
--    parse-receipt gọi AI sau này). Mặc định MANUAL — khoản chi cũ không đổi.
-- 2. Bảng receipt_items: các dòng người dùng đã kiểm tra trên hóa đơn (món, phí, thuế, giảm giá).
--    Chỉ là bằng chứng / chi tiết; số tiền chính thức vẫn là expenses.amount + expense_shares
--    (BR-12, BR-13: tổng các dòng được phép lệch tổng khoản chi người dùng xác nhận).
-- 3. RPC set_expense_receipt_items(_expense_id, _items, _source): người tạo khoản chi ghi lại toàn bộ
--    danh sách dòng (thay thế) và đánh dấu source. Gọi lại bao nhiêu lần cũng ra cùng kết quả →
--    hàng đợi offline gửi lại an toàn sau create_expense.
-- Không sửa create_expense (giữ nguyên chữ ký đang chạy). Chạy lại được.
-- ============================================================

BEGIN;

-- ============================================================
-- PART 1: expenses.source
-- ============================================================

ALTER TABLE public.expenses ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'MANUAL';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'expenses_source_check' AND conrelid = 'public.expenses'::regclass
  ) THEN
    ALTER TABLE public.expenses
      ADD CONSTRAINT expenses_source_check CHECK (source IN ('MANUAL', 'OCR', 'OCR_AI'));
  END IF;
END $$;

-- ============================================================
-- PART 2: receipt_items
-- ============================================================

CREATE TABLE IF NOT EXISTS public.receipt_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  expense_id UUID NOT NULL REFERENCES public.expenses(id) ON DELETE CASCADE,
  position INTEGER NOT NULL CHECK (position >= 0),
  kind TEXT NOT NULL CHECK (kind IN ('ITEM', 'FEE', 'TAX', 'DISCOUNT')),
  name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
  quantity INTEGER NOT NULL DEFAULT 1 CHECK (quantity BETWEEN 1 AND 999),
  -- Thành tiền của dòng, VND; giảm giá lưu số dương
  amount BIGINT NOT NULL CHECK (amount >= 0 AND amount <= 100000000000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (expense_id, position)
);

CREATE INDEX IF NOT EXISTS receipt_items_expense_id_idx ON public.receipt_items (expense_id);

ALTER TABLE public.receipt_items ENABLE ROW LEVEL SECURITY;

-- Đọc được khi đọc được khoản chi (policy của expenses áp dụng trong truy vấn con:
-- thành viên ACTIVE, hoặc đã rời nhóm sau khi khoản chi được tạo — BE-12)
DROP POLICY IF EXISTS "Members can read receipt_items" ON public.receipt_items;
CREATE POLICY "Members can read receipt_items"
  ON public.receipt_items FOR SELECT
  USING (EXISTS (SELECT 1 FROM public.expenses e WHERE e.id = receipt_items.expense_id));

-- Chỉ ghi qua RPC (như expenses / expense_shares — 0010 §11.3)
REVOKE ALL ON public.receipt_items FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.receipt_items FROM authenticated;
GRANT SELECT ON public.receipt_items TO authenticated;

-- ============================================================
-- PART 3: set_expense_receipt_items
-- ============================================================

CREATE OR REPLACE FUNCTION public.set_expense_receipt_items(
  _expense_id UUID,
  _items JSONB,
  _source TEXT DEFAULT 'OCR'
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  _caller UUID;
  _expense public.expenses;
  _item JSONB;
  _pos INTEGER := 0;
  _name TEXT;
  _kind TEXT;
  _quantity INTEGER;
  _amount BIGINT;
BEGIN
  _caller := public.assert_authenticated();

  IF _source IS NULL OR _source NOT IN ('MANUAL', 'OCR', 'OCR_AI') THEN
    RAISE EXCEPTION 'INVALID_SOURCE: Invalid expense source: %', _source;
  END IF;

  IF _items IS NULL OR jsonb_typeof(_items) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'INVALID_RECEIPT_ITEMS: Items must be an array.';
  END IF;

  IF jsonb_array_length(_items) > 200 THEN
    RAISE EXCEPTION 'INVALID_RECEIPT_ITEMS: At most 200 receipt items.';
  END IF;

  -- Khóa dòng khoản chi: hai lần gửi đồng thời không xen kẽ DELETE / INSERT
  SELECT * INTO _expense FROM public.expenses WHERE id = _expense_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'EXPENSE_NOT_FOUND: Expense not found.';
  END IF;

  IF _expense.created_by IS DISTINCT FROM _caller THEN
    RAISE EXCEPTION 'NOT_EXPENSE_CREATOR: Only the expense creator can attach receipt items.';
  END IF;

  IF _expense.status <> 'ACTIVE' THEN
    RAISE EXCEPTION 'EXPENSE_NOT_ACTIVE: Expense is not active.';
  END IF;

  DELETE FROM public.receipt_items WHERE expense_id = _expense_id;

  FOR _item IN SELECT * FROM jsonb_array_elements(_items)
  LOOP
    _name := trim(COALESCE(_item ->> 'name', ''));
    _kind := COALESCE(_item ->> 'kind', 'ITEM');
    _quantity := COALESCE((_item ->> 'quantity')::INTEGER, 1);
    _amount := (_item ->> 'amount')::BIGINT;

    IF char_length(_name) NOT BETWEEN 1 AND 200 THEN
      RAISE EXCEPTION 'INVALID_RECEIPT_ITEMS: Item name must be 1-200 characters.';
    END IF;
    IF _kind NOT IN ('ITEM', 'FEE', 'TAX', 'DISCOUNT') THEN
      RAISE EXCEPTION 'INVALID_RECEIPT_ITEMS: Invalid item kind: %', _kind;
    END IF;
    IF _quantity NOT BETWEEN 1 AND 999 THEN
      RAISE EXCEPTION 'INVALID_RECEIPT_ITEMS: Quantity must be 1-999.';
    END IF;
    IF _amount IS NULL OR _amount < 0 OR _amount > 100000000000 THEN
      RAISE EXCEPTION 'INVALID_RECEIPT_ITEMS: Item amount must be a non-negative integer.';
    END IF;

    INSERT INTO public.receipt_items (expense_id, position, kind, name, quantity, amount)
    VALUES (_expense_id, _pos, _kind, _name, _quantity, _amount);
    _pos := _pos + 1;
  END LOOP;

  UPDATE public.expenses SET source = _source WHERE id = _expense_id AND source IS DISTINCT FROM _source;

  RETURN _pos;
END;
$$;

REVOKE ALL ON FUNCTION public.set_expense_receipt_items(UUID, JSONB, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_expense_receipt_items(UUID, JSONB, TEXT) TO authenticated;

COMMIT;
