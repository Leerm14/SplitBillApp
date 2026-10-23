-- ============================================================
-- Migration 0016: Người thực hiện của thông báo
-- 1. Nhiều RPC (khoản chi, thanh toán, thành viên…) chèn thông báo không ghi actor_id → app không
--    hiện được "Ai đã làm gì". Thay vì sửa lại từng RPC, trigger BEFORE INSERT điền actor_id bằng
--    người đang gọi RPC (auth.uid() vẫn là người dùng bên trong hàm SECURITY DEFINER).
-- 2. Bỏ thông báo gửi cho chính người thực hiện (ví dụ OWNERSHIP_TRANSFERRED của transfer_ownership):
--    người bấm đã biết mình vừa làm gì; giữ lại chỉ làm danh sách thông báo trông như bị lặp.
-- Thông báo do hệ thống tạo (không có người dùng gọi, auth.uid() NULL) giữ nguyên.
-- Chạy lại được.
-- ============================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.fill_notification_actor()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  _caller UUID := auth.uid();
BEGIN
  IF NEW.actor_id IS NULL AND _caller IS NOT NULL THEN
    NEW.actor_id := _caller;
  END IF;
  -- Người thực hiện không cần thông báo về thao tác của chính mình
  IF _caller IS NOT NULL AND NEW.user_id = _caller THEN
    RETURN NULL;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_notification_fill_actor ON public.notifications;
CREATE TRIGGER on_notification_fill_actor
  BEFORE INSERT ON public.notifications
  FOR EACH ROW EXECUTE FUNCTION public.fill_notification_actor();

-- Hàm trigger nội bộ: không cho gọi như RPC
REVOKE EXECUTE ON FUNCTION public.fill_notification_actor() FROM PUBLIC, anon, authenticated;

COMMIT;
