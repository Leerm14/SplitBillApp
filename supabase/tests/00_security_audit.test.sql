-- ============================================================
-- Security audit (pgTAP) — SEC-02, SEC-04, SEC-05, SEC-08, BE-05, BE-09, CFG-04
-- Chạy: supabase test db   (mỗi file một giao dịch, ROLLBACK ở cuối)
-- ============================================================

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;

-- 0010 thu hồi EXECUTE mặc định cho PUBLIC → cấp lại cho pgTAP trong giao dịch test
DO $$
DECLARE _s TEXT;
BEGIN
  SELECT n.nspname INTO _s
  FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace
  WHERE e.extname = 'pgtap';
  IF _s IS NOT NULL THEN
    EXECUTE format('GRANT USAGE ON SCHEMA %I TO anon, authenticated, service_role', _s);
    EXECUTE format('GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA %I TO anon, authenticated, service_role', _s);
  END IF;
END $$;

SELECT no_plan();

-- ------------------------------------------------------------
-- Bảng
-- ------------------------------------------------------------

SELECT is(
  ARRAY(SELECT tablename::text FROM pg_tables WHERE schemaname = 'public' AND NOT rowsecurity ORDER BY 1),
  ARRAY[]::text[],
  'AUDIT-01: every public table has RLS enabled'
);

SELECT is(
  ARRAY(
    SELECT c.relname::text FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'v', 'm')
      AND (has_table_privilege('anon', c.oid, 'SELECT')
           OR has_table_privilege('anon', c.oid, 'INSERT')
           OR has_table_privilege('anon', c.oid, 'UPDATE')
           OR has_table_privilege('anon', c.oid, 'DELETE'))
    ORDER BY 1
  ),
  ARRAY[]::text[],
  'AUDIT-02: anon has no privileges on public tables/views'
);

SELECT is(
  ARRAY(
    SELECT t || ':' || p FROM
      unnest(ARRAY['groups', 'group_members', 'group_invites', 'expenses', 'expense_shares',
                   'payments', 'activity_logs', 'friendships', 'profiles', 'notifications',
                   'group_join_requests']) t,
      unnest(ARRAY['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) p
    WHERE has_table_privilege('authenticated', ('public.' || t)::regclass, p)
    ORDER BY 1
  ),
  ARRAY[]::text[],
  'AUDIT-03: authenticated cannot write RPC-only tables directly (SEC-01, SEC-05)'
);

SELECT ok(
  NOT has_any_column_privilege('authenticated', 'public.profiles', 'UPDATE'),
  'AUDIT-04: authenticated cannot UPDATE any profiles column (SEC-05)'
);

SELECT ok(
  NOT has_column_privilege('authenticated', 'public.profiles', 'searchable', 'SELECT')
  AND NOT has_column_privilege('authenticated', 'public.profiles', 'deleted_at', 'SELECT')
  AND has_column_privilege('authenticated', 'public.profiles', 'display_name', 'SELECT'),
  'AUDIT-05: profiles column privileges — only public columns readable (SEC-04)'
);

SELECT ok(
  has_column_privilege('authenticated', 'public.notifications', 'read_at', 'UPDATE')
  AND NOT has_column_privilege('authenticated', 'public.notifications', 'user_id', 'UPDATE'),
  'AUDIT-06: notifications — only read_at is updatable'
);

-- ------------------------------------------------------------
-- Hàm
-- ------------------------------------------------------------

SELECT is(
  ARRAY(
    SELECT p.proname::text FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.prosecdef
      AND NOT EXISTS (
        SELECT 1 FROM unnest(COALESCE(p.proconfig, ARRAY[]::text[])) c
        WHERE c LIKE 'search_path=%' AND c NOT LIKE '%public%'
      )
    ORDER BY 1
  ),
  ARRAY[]::text[],
  'AUDIT-07: every SECURITY DEFINER function pins an empty search_path (NEW-09)'
);

SELECT is(
  ARRAY(
    SELECT DISTINCT p.proname::text FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND has_function_privilege('anon', p.oid, 'EXECUTE')
      AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')
    ORDER BY 1
  ),
  ARRAY[]::text[],
  'AUDIT-08: anon cannot execute any public function (SEC-02, SEC-08)'
);

-- Danh sách cho phép: RPC của app + hàm dùng trong RLS / policy Storage.
-- Thêm RPC mới → thêm vào đây (test sẽ báo nếu quên GRANT hoặc lộ hàm nội bộ).
SELECT is(
  ARRAY(
    SELECT DISTINCT p.proname::text FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND has_function_privilege('authenticated', p.oid, 'EXECUTE')
      AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')
    ORDER BY 1
  ),
  ARRAY[
    'accept_invite', 'accept_invite_by_id', 'accept_invite_by_id_v2', 'approve_join_request',
    'can_read_receipt', 'can_view_profile', 'can_write_receipt',
    'cancel_expense', 'cancel_join_request', 'cancel_payment', 'close_group', 'confirm_payment',
    'create_expense', 'create_group', 'create_invite', 'create_payment',
    'dispute_payment', 'find_user_by_code', 'get_my_profile', 'is_member', 'is_member_or_was_member',
    'is_owner', 'join_by_code', 'join_by_token', 'join_group', 'leave_group', 'list_join_requests',
    'list_my_sessions', 'my_join_request', 'register_push_token', 'reject_join_request', 'reject_payment', 'remove_member',
    'respond_friend_request', 'respond_payment', 'revoke_invite', 'revoke_my_session', 'rotate_invite_code',
    'search_users', 'send_friend_request', 'set_join_approval', 'transfer_ownership', 'unfriend',
    'unregister_push_token', 'update_expense', 'update_group', 'update_profile'
  ]::text[],
  'AUDIT-09: authenticated executes exactly the RPC allowlist (internal helpers hidden)'
);

SELECT ok(
  NOT has_function_privilege('authenticated', 'public.assert_active_member_of_active_group(uuid)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public.assert_authenticated()', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public.trigger_push_notification()', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public.handle_new_user()', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public.handle_auth_user_deleted()', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public.process_join(uuid,uuid,uuid)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public.reject_join_requests_on_close()', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public.fill_notification_actor()', 'EXECUTE'),
  'AUDIT-10: internal helpers / trigger functions are not callable by authenticated'
);

SELECT ok(
  has_function_privilege('service_role', 'public.anonymize_account(uuid)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public.anonymize_account(uuid)', 'EXECUTE'),
  'AUDIT-11: anonymize_account is service_role only (BE-05)'
);

-- ALTER DEFAULT PRIVILEGES: hàm tạo sau 0010 không tự có quyền cho PUBLIC / anon
CREATE FUNCTION public._audit_probe() RETURNS INT LANGUAGE sql AS 'SELECT 1';
SELECT ok(
  NOT has_function_privilege('anon', 'public._audit_probe()', 'EXECUTE'),
  'AUDIT-12: functions created later are not executable by anon/PUBLIC by default (SEC-02)'
);

SELECT ok(
  to_regprocedure('public.create_expense(uuid,uuid,bigint,text,jsonb,text)') IS NULL,
  'AUDIT-13: legacy 6-arg create_expense (global idempotency lookup) is dropped'
);

SELECT ok(
  to_regprocedure('public.update_profile(text,text,boolean)') IS NULL
  AND to_regprocedure('public.update_profile(text,text,boolean,boolean)') IS NOT NULL,
  'AUDIT-14: update_profile has the 4-arg contract signature only'
);

-- ------------------------------------------------------------
-- Ràng buộc
-- ------------------------------------------------------------

SELECT is(
  (SELECT count(*)::int FROM pg_constraint
   WHERE conrelid = 'public.profiles'::regclass AND contype = 'f'
     AND confrelid = 'auth.users'::regclass),
  0,
  'AUDIT-15: profiles no longer cascades from auth.users (BE-05 tombstone)'
);

SELECT is(
  ARRAY(
    SELECT conrelid::regclass::text || '(' ||
           array_to_string(ARRAY(
             SELECT a.attname::text FROM unnest(con.conkey) k
             JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k
           ), ',') || ')'
    FROM pg_constraint con
    WHERE con.contype = 'u'
      AND con.conrelid IN ('public.expenses'::regclass, 'public.payments'::regclass)
    ORDER BY 1
  ),
  ARRAY['expenses(created_by,idempotency_key)', 'payments(from_id,idempotency_key)']::text[],
  'AUDIT-16: idempotency keys are unique per creator, not globally (BE-09, NEW-06)'
);

-- ------------------------------------------------------------
-- Push trigger (CFG-04, NEW-09)
-- ------------------------------------------------------------

SELECT ok(
  EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'on_notification_inserted'
          AND tgrelid = 'public.notifications'::regclass AND NOT tgisinternal),
  'AUDIT-17: notifications insert trigger exists'
);

SELECT ok(
  pg_get_functiondef('public.trigger_push_notification()'::regprocedure) LIKE '%net.http_post%'
  AND pg_get_functiondef('public.trigger_push_notification()'::regprocedure) LIKE '%vault.decrypted_secrets%'
  AND pg_get_functiondef('public.trigger_push_notification()'::regprocedure) NOT LIKE '%service_role%',
  'AUDIT-18: push trigger uses pg_net + Vault, no service role key'
);

SELECT * FROM finish();
ROLLBACK;
