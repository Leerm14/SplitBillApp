-- CFG-04: Database trigger to call send-push Edge Function when a new notification is inserted
-- Uses pg_net extension for async HTTP calls instead of Database Webhook configuration

-- Enable pg_net extension (if not already enabled)
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;

-- Function to trigger push notification via Edge Function
CREATE OR REPLACE FUNCTION public.trigger_push_notification()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _supabase_url text;
  _service_key text;
  _webhook_secret text;
BEGIN
  -- Get configuration from environment (Supabase vault or app settings)
  _supabase_url := current_setting('app.settings.supabase_url', true);
  _service_key := current_setting('app.settings.service_role_key', true);
  _webhook_secret := current_setting('app.settings.webhook_secret', true);

  -- If settings are not configured, skip silently
  IF _supabase_url IS NULL OR _service_key IS NULL THEN
    RETURN NEW;
  END IF;

  -- Call the send-push Edge Function asynchronously via pg_net
  PERFORM extensions.http_post(
    url := _supabase_url || '/functions/v1/send-push',
    body := json_build_object(
      'type', 'INSERT',
      'table', 'notifications',
      'record', json_build_object(
        'id', NEW.id,
        'user_id', NEW.user_id,
        'type', NEW.type,
        'group_id', NEW.group_id,
        'expense_id', NEW.expense_id,
        'payment_id', NEW.payment_id,
        'created_at', NEW.created_at
      )
    )::text,
    headers := json_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || _service_key,
      'x-webhook-secret', COALESCE(_webhook_secret, '')
    )::jsonb
  );

  RETURN NEW;
EXCEPTION
  WHEN OTHERS THEN
    -- Don't block notification insert if push fails
    RAISE WARNING 'Push notification trigger failed: %', SQLERRM;
    RETURN NEW;
END;
$$;

-- Create trigger on notifications table
DROP TRIGGER IF EXISTS on_notification_inserted ON public.notifications;
CREATE TRIGGER on_notification_inserted
  AFTER INSERT ON public.notifications
  FOR EACH ROW
  EXECUTE FUNCTION public.trigger_push_notification();

COMMENT ON FUNCTION public.trigger_push_notification() IS
  'CFG-04: Triggers push notification via send-push Edge Function when a notification row is inserted';

