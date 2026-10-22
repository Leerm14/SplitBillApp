-- ============================================================
-- Security Audit — Rà soát bảo mật database
-- Chạy trong SQL Editor để kiểm tra cấu hình RLS
-- ============================================================

-- ============================
-- AUDIT-01: Tất cả bảng public phải bật RLS
-- ============================
DO $$
DECLARE
  _table RECORD;
  _missing TEXT := '';
BEGIN
  FOR _table IN
    SELECT tablename
    FROM pg_tables
    WHERE schemaname = 'public'
      AND tablename NOT IN ('schema_migrations')
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relname = _table.tablename
        AND c.relrowsecurity = true
    ) THEN
      _missing := _missing || _table.tablename || ', ';
    END IF;
  END LOOP;

  IF _missing = '' THEN
    RAISE NOTICE 'AUDIT-01 PASSED: All public tables have RLS enabled ✅';
  ELSE
    RAISE WARNING 'AUDIT-01 FAILED: Tables WITHOUT RLS: % ⚠️', rtrim(_missing, ', ');
  END IF;
END $$;

-- ============================
-- AUDIT-02: Kiểm tra SECURITY DEFINER functions
-- Tất cả RPCs phải có SET search_path = ''
-- ============================
DO $$
DECLARE
  _func RECORD;
  _unsafe TEXT := '';
BEGIN
  FOR _func IN
    SELECT p.proname, p.prosecdef, p.proconfig
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.prosecdef = true
  LOOP
    -- Kiểm tra có set search_path trong proconfig
    IF _func.proconfig IS NULL
       OR NOT EXISTS (
         SELECT 1 FROM unnest(_func.proconfig) c
         WHERE c LIKE 'search_path=%'
       )
    THEN
      _unsafe := _unsafe || _func.proname || ', ';
    END IF;
  END LOOP;

  IF _unsafe = '' THEN
    RAISE NOTICE 'AUDIT-02 PASSED: All SECURITY DEFINER functions have search_path set ✅';
  ELSE
    RAISE WARNING 'AUDIT-02 FAILED: Functions WITHOUT search_path: % ⚠️', rtrim(_unsafe, ', ');
  END IF;
END $$;

-- ============================
-- AUDIT-03: Kiểm tra không có bảng công khai (không có RLS policy)
-- Tất cả bảng có RLS phải có ít nhất 1 policy
-- ============================
DO $$
DECLARE
  _table RECORD;
  _no_policy TEXT := '';
BEGIN
  FOR _table IN
    SELECT c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind = 'r'
      AND c.relrowsecurity = true
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = 'public' AND tablename = _table.relname
    ) THEN
      _no_policy := _no_policy || _table.relname || ', ';
    END IF;
  END LOOP;

  IF _no_policy = '' THEN
    RAISE NOTICE 'AUDIT-03 PASSED: All RLS-enabled tables have at least 1 policy ✅';
  ELSE
    RAISE WARNING 'AUDIT-03 FAILED: RLS tables WITHOUT policies: % ⚠️', rtrim(_no_policy, ', ');
  END IF;
END $$;

-- ============================
-- AUDIT-04: Liệt kê tất cả RLS policies (cho review thủ công)
-- ============================
SELECT
  schemaname,
  tablename,
  policyname,
  permissive,
  roles,
  cmd,
  qual,
  with_check
FROM pg_policies
WHERE schemaname = 'public'
ORDER BY tablename, policyname;

-- ============================
-- AUDIT-05: Kiểm tra tất cả functions public (liệt kê cho review)
-- ============================
SELECT
  p.proname AS function_name,
  p.prosecdef AS security_definer,
  p.proconfig AS config,
  pg_get_function_arguments(p.oid) AS arguments
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
ORDER BY p.proname;

-- ============================
-- SUMMARY
-- ============================
DO $$
BEGIN
  RAISE NOTICE '============================================';
  RAISE NOTICE '  Security Audit Complete';
  RAISE NOTICE '  Review AUDIT-04 and AUDIT-05 output manually';
  RAISE NOTICE '============================================';
END $$;

