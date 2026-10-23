-- ============================================================
-- Seed Data: Tạo tài khoản mockup với dữ liệu mẫu
-- Chạy sau khi đã apply tất cả migration.
--
-- Cách chạy (Supabase Dashboard → SQL Editor → paste & run):
--   Hoặc qua CLI: supabase db reset (sẽ tự chạy seed.sql)
--
-- Tài khoản test:
--   1. demo@splitbill.test / Demo123!  (Nguyễn Văn An - chủ nhóm)
--   2. demo2@splitbill.test / Demo123! (Trần Thị Bình)
--   3. demo3@splitbill.test / Demo123! (Lê Hoàng Cường)
--   4. demo4@splitbill.test / Demo123! (Phạm Minh Dũng)
-- ============================================================

-- Chạy dưới quyền service_role (bỏ qua RLS)
-- Supabase SQL Editor chạy với quyền postgres, OK.

DO $$
DECLARE
  -- User IDs (cố định để dễ tham chiếu)
  _user1_id UUID := 'a1111111-1111-1111-1111-111111111111';
  _user2_id UUID := 'a2222222-2222-2222-2222-222222222222';
  _user3_id UUID := 'a3333333-3333-3333-3333-333333333333';
  _user4_id UUID := 'a4444444-4444-4444-4444-444444444444';

  -- Group IDs
  _group1_id UUID := 'b1111111-1111-1111-1111-111111111111';
  _group2_id UUID := 'b2222222-2222-2222-2222-222222222222';

  -- Expense IDs
  _exp1_id UUID := 'c1111111-1111-1111-1111-111111111111';
  _exp2_id UUID := 'c2222222-2222-2222-2222-222222222222';
  _exp3_id UUID := 'c3333333-3333-3333-3333-333333333333';
  _exp4_id UUID := 'c4444444-4444-4444-4444-444444444444';

  -- Payment IDs
  _pay1_id UUID := 'd1111111-1111-1111-1111-111111111111';
  _pay2_id UUID := 'd2222222-2222-2222-2222-222222222222';

  _users UUID[];
  _groups UUID[];
  _col TEXT;

BEGIN
  _users := ARRAY[_user1_id, _user2_id, _user3_id, _user4_id];
  _groups := ARRAY[_group1_id, _group2_id];

  -- ============================
  -- 0. DỌN DỮ LIỆU DEMO CŨ (chạy lại được)
  -- ============================
  -- Từ migration 0010, xóa auth.users KHÔNG còn xóa dây chuyền public.profiles: trigger
  -- on_auth_user_deleted chỉ ẩn danh hồ sơ và giữ lại làm "bia mộ". Nếu chỉ xóa auth.users rồi
  -- tạo lại, handle_new_user sẽ chèn trùng khóa profiles_pkey. Vì vậy dọn theo thứ tự phụ thuộc,
  -- rồi xóa auth.users, cuối cùng xóa hẳn hồ sơ demo.
  -- Lưu ý: xóa cả dữ liệu tài khoản demo đã tạo ở nhóm khác (khoản chi, thanh toán, thành viên).
  -- Chỉ chạy trên project dev/demo, không dùng tài khoản demo trong nhóm thật.
  DELETE FROM public.notifications
   WHERE user_id = ANY(_users) OR actor_id = ANY(_users) OR group_id = ANY(_groups);
  DELETE FROM public.activity_logs
   WHERE actor_id = ANY(_users) OR group_id = ANY(_groups);
  DELETE FROM public.payments
   WHERE group_id = ANY(_groups) OR from_id = ANY(_users) OR to_id = ANY(_users) OR decided_by = ANY(_users);
  DELETE FROM public.expense_shares
   WHERE user_id = ANY(_users)
      OR expense_id IN (SELECT id FROM public.expenses
                         WHERE group_id = ANY(_groups) OR paid_by = ANY(_users) OR created_by = ANY(_users));
  DELETE FROM public.expenses
   WHERE group_id = ANY(_groups) OR paid_by = ANY(_users) OR created_by = ANY(_users);
  DELETE FROM public.group_invites
   WHERE group_id = ANY(_groups) OR created_by = ANY(_users) OR invited_user_id = ANY(_users);
  DELETE FROM public.group_members
   WHERE group_id = ANY(_groups) OR user_id = ANY(_users);
  DELETE FROM public.groups
   WHERE id = ANY(_groups) OR owner_id = ANY(_users);
  DELETE FROM public.friendships
   WHERE requester_id = ANY(_users) OR addressee_id = ANY(_users);
  DELETE FROM public.payment_handles WHERE user_id = ANY(_users);
  DELETE FROM public.push_tokens WHERE user_id = ANY(_users);

  DELETE FROM auth.identities WHERE user_id = ANY(_users);
  DELETE FROM auth.users WHERE id = ANY(_users);
  -- Hồ sơ "bia mộ" còn lại sau khi xóa auth.users
  DELETE FROM public.profiles WHERE id = ANY(_users);

  -- ============================
  -- 1. TẠO AUTH USERS (dùng hàm nội bộ Supabase)
  -- ============================

  -- User 1: Nguyễn Văn An
  INSERT INTO auth.users (
    id, instance_id, email, encrypted_password, email_confirmed_at,
    raw_app_meta_data, raw_user_meta_data, aud, role, created_at, updated_at
  ) VALUES (
    _user1_id, '00000000-0000-0000-0000-000000000000',
    'demo@splitbill.test',
    crypt('Demo123!', gen_salt('bf')),
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"display_name":"Nguyễn Văn An"}'::jsonb,
    'authenticated', 'authenticated', now(), now()
  );

  INSERT INTO auth.identities (id, user_id, identity_data, provider, provider_id, last_sign_in_at, created_at, updated_at)
  VALUES (
    gen_random_uuid(), _user1_id,
    jsonb_build_object('sub', _user1_id::text, 'email', 'demo@splitbill.test'),
    'email', _user1_id::text, now(), now(), now()
  );

  -- User 2: Trần Thị Bình
  INSERT INTO auth.users (
    id, instance_id, email, encrypted_password, email_confirmed_at,
    raw_app_meta_data, raw_user_meta_data, aud, role, created_at, updated_at
  ) VALUES (
    _user2_id, '00000000-0000-0000-0000-000000000000',
    'demo2@splitbill.test',
    crypt('Demo123!', gen_salt('bf')),
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"display_name":"Trần Thị Bình"}'::jsonb,
    'authenticated', 'authenticated', now(), now()
  );

  INSERT INTO auth.identities (id, user_id, identity_data, provider, provider_id, last_sign_in_at, created_at, updated_at)
  VALUES (
    gen_random_uuid(), _user2_id,
    jsonb_build_object('sub', _user2_id::text, 'email', 'demo2@splitbill.test'),
    'email', _user2_id::text, now(), now(), now()
  );

  -- User 3: Lê Hoàng Cường
  INSERT INTO auth.users (
    id, instance_id, email, encrypted_password, email_confirmed_at,
    raw_app_meta_data, raw_user_meta_data, aud, role, created_at, updated_at
  ) VALUES (
    _user3_id, '00000000-0000-0000-0000-000000000000',
    'demo3@splitbill.test',
    crypt('Demo123!', gen_salt('bf')),
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"display_name":"Lê Hoàng Cường"}'::jsonb,
    'authenticated', 'authenticated', now(), now()
  );

  INSERT INTO auth.identities (id, user_id, identity_data, provider, provider_id, last_sign_in_at, created_at, updated_at)
  VALUES (
    gen_random_uuid(), _user3_id,
    jsonb_build_object('sub', _user3_id::text, 'email', 'demo3@splitbill.test'),
    'email', _user3_id::text, now(), now(), now()
  );

  -- User 4: Phạm Minh Dũng
  INSERT INTO auth.users (
    id, instance_id, email, encrypted_password, email_confirmed_at,
    raw_app_meta_data, raw_user_meta_data, aud, role, created_at, updated_at
  ) VALUES (
    _user4_id, '00000000-0000-0000-0000-000000000000',
    'demo4@splitbill.test',
    crypt('Demo123!', gen_salt('bf')),
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"display_name":"Phạm Minh Dũng"}'::jsonb,
    'authenticated', 'authenticated', now(), now()
  );

  INSERT INTO auth.identities (id, user_id, identity_data, provider, provider_id, last_sign_in_at, created_at, updated_at)
  VALUES (
    gen_random_uuid(), _user4_id,
    jsonb_build_object('sub', _user4_id::text, 'email', 'demo4@splitbill.test'),
    'email', _user4_id::text, now(), now(), now()
  );

  -- Supabase Auth (GoTrue) đọc các cột token này như chuỗi: NULL làm đăng nhập lỗi
  -- "Database error querying schema". Đăng ký qua API thì chúng là '', chèn tay thì phải tự đặt.
  -- Chỉ cập nhật cột có thật trong bản auth.users của project (khác nhau theo phiên bản).
  FOR _col IN
    SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'auth' AND table_name = 'users'
       AND column_name IN ('confirmation_token', 'recovery_token', 'email_change_token_new',
                           'email_change_token_current', 'email_change', 'phone_change',
                           'phone_change_token', 'reauthentication_token')
  LOOP
    EXECUTE format('UPDATE auth.users SET %1$I = '''' WHERE id = ANY($1) AND %1$I IS NULL', _col)
      USING _users;
  END LOOP;

  -- ============================
  -- 2. PROFILES (trigger handle_new_user đã tạo, nhưng ta cập nhật thêm)
  -- ============================

  -- Đợi trigger tạo profiles xong, rồi cập nhật user_code cố định
  UPDATE public.profiles SET user_code = 'DEMO0001' WHERE id = _user1_id;
  UPDATE public.profiles SET user_code = 'DEMO0002' WHERE id = _user2_id;
  UPDATE public.profiles SET user_code = 'DEMO0003' WHERE id = _user3_id;
  UPDATE public.profiles SET user_code = 'DEMO0004' WHERE id = _user4_id;

  -- ============================
  -- 3. NHÓM 1: Đi Đà Lạt 🏔️ (4 thành viên)
  -- ============================

  INSERT INTO public.groups (id, name, owner_id, invite_code, description, simplify_debts, status)
  VALUES (
    _group1_id,
    'Đi Đà Lạt 🏔️',
    _user1_id,
    'DALAT2024',
    'Chuyến đi Đà Lạt tháng 10/2024 - 3 ngày 2 đêm',
    true,
    'ACTIVE'
  );

  INSERT INTO public.group_members (group_id, user_id, role) VALUES
    (_group1_id, _user1_id, 'owner'),
    (_group1_id, _user2_id, 'member'),
    (_group1_id, _user3_id, 'member'),
    (_group1_id, _user4_id, 'member');

  -- ============================
  -- 4. NHÓM 2: Ăn trưa Công ty 🍜 (3 thành viên)
  -- ============================

  INSERT INTO public.groups (id, name, owner_id, invite_code, description, simplify_debts, status)
  VALUES (
    _group2_id,
    'Ăn trưa Công ty 🍜',
    _user1_id,
    'LUNCH001',
    'Nhóm chia tiền ăn trưa hàng ngày',
    true,
    'ACTIVE'
  );

  INSERT INTO public.group_members (group_id, user_id, role) VALUES
    (_group2_id, _user1_id, 'owner'),
    (_group2_id, _user2_id, 'member'),
    (_group2_id, _user3_id, 'member');

  -- ============================
  -- 5. KHOẢN CHI - Nhóm 1 (Đà Lạt)
  -- ============================

  -- Expense 1: An trả tiền khách sạn 2.400.000đ, chia đều 4 người
  INSERT INTO public.expenses (id, group_id, paid_by, amount, description, created_by, idempotency_key, split_method, note)
  VALUES (
    _exp1_id, _group1_id, _user1_id, 2400000,
    'Khách sạn Đà Lạt 2 đêm',
    _user1_id, 'seed-exp-1', 'EQUAL',
    'Khách sạn view đồi thông, 2 phòng đôi'
  );

  INSERT INTO public.expense_shares (expense_id, user_id, amount) VALUES
    (_exp1_id, _user1_id, 600000),
    (_exp1_id, _user2_id, 600000),
    (_exp1_id, _user3_id, 600000),
    (_exp1_id, _user4_id, 600000);

  -- Expense 2: Bình trả tiền ăn tối 800.000đ, chia đều 4 người
  INSERT INTO public.expenses (id, group_id, paid_by, amount, description, created_by, idempotency_key, split_method)
  VALUES (
    _exp2_id, _group1_id, _user2_id, 800000,
    'Ăn tối lẩu bò Đà Lạt',
    _user2_id, 'seed-exp-2', 'EQUAL'
  );

  INSERT INTO public.expense_shares (expense_id, user_id, amount) VALUES
    (_exp2_id, _user1_id, 200000),
    (_exp2_id, _user2_id, 200000),
    (_exp2_id, _user3_id, 200000),
    (_exp2_id, _user4_id, 200000);

  -- Expense 3: Cường trả tiền thuê xe máy 600.000đ, chia đều 4 người
  INSERT INTO public.expenses (id, group_id, paid_by, amount, description, created_by, idempotency_key, split_method, note)
  VALUES (
    _exp3_id, _group1_id, _user3_id, 600000,
    'Thuê 2 xe máy',
    _user3_id, 'seed-exp-3', 'EQUAL',
    'Honda Winner + Vision, 2 ngày'
  );

  INSERT INTO public.expense_shares (expense_id, user_id, amount) VALUES
    (_exp3_id, _user1_id, 150000),
    (_exp3_id, _user2_id, 150000),
    (_exp3_id, _user3_id, 150000),
    (_exp3_id, _user4_id, 150000);

  -- ============================
  -- 6. KHOẢN CHI - Nhóm 2 (Ăn trưa)
  -- ============================

  -- Expense 4: An trả bún bò 195.000đ, chia đều 3 người
  INSERT INTO public.expenses (id, group_id, paid_by, amount, description, created_by, idempotency_key, split_method)
  VALUES (
    _exp4_id, _group2_id, _user1_id, 195000,
    'Bún bò Huế - quán cô Ba',
    _user1_id, 'seed-exp-4', 'EQUAL'
  );

  INSERT INTO public.expense_shares (expense_id, user_id, amount) VALUES
    (_exp4_id, _user1_id, 65000),
    (_exp4_id, _user2_id, 65000),
    (_exp4_id, _user3_id, 65000);

  -- ============================
  -- 7. THANH TOÁN
  -- ============================

  -- Payment 1: Dũng thanh toán cho An 150.000đ (PENDING)
  INSERT INTO public.payments (id, group_id, from_id, to_id, amount, status, note, idempotency_key, method)
  VALUES (
    _pay1_id, _group1_id, _user4_id, _user1_id, 150000,
    'PENDING', 'Phần tiền xe máy', 'seed-pay-1', 'BANK'
  );

  -- Payment 2: Bình thanh toán cho An 200.000đ (CONFIRMED)
  INSERT INTO public.payments (id, group_id, from_id, to_id, amount, status, note, idempotency_key, method, decided_at)
  VALUES (
    _pay2_id, _group1_id, _user2_id, _user1_id, 200000,
    'CONFIRMED', 'Tiền khách sạn', 'seed-pay-2', 'BANK', now()
  );

  -- ============================
  -- 8. BẠN BÈ
  -- ============================

  -- An và Bình là bạn bè
  INSERT INTO public.friendships (requester_id, addressee_id, status, responded_at)
  VALUES (_user1_id, _user2_id, 'ACCEPTED', now());

  -- An và Cường là bạn bè
  INSERT INTO public.friendships (requester_id, addressee_id, status, responded_at)
  VALUES (_user1_id, _user3_id, 'ACCEPTED', now());

  -- Dũng gửi lời mời kết bạn cho An (đang chờ)
  INSERT INTO public.friendships (requester_id, addressee_id, status)
  VALUES (_user4_id, _user1_id, 'PENDING');

  -- ============================
  -- 9. THÔNG TIN THANH TOÁN
  -- ============================

  INSERT INTO public.payment_handles (user_id, type, display_text) VALUES
    (_user1_id, 'BANK', 'Vietcombank - 1234567890 - NGUYEN VAN AN'),
    (_user1_id, 'EWALLET', 'MoMo - 0901234567'),
    (_user2_id, 'BANK', 'Techcombank - 9876543210 - TRAN THI BINH'),
    (_user3_id, 'BANK', 'MB Bank - 1122334455 - LE HOANG CUONG');

  -- ============================
  -- 10. NHẬT KÝ HOẠT ĐỘNG (một số mẫu)
  -- ============================

  INSERT INTO public.activity_logs (group_id, actor_id, action, entity_type, entity_id, after) VALUES
    (_group1_id, _user1_id, 'CREATE', 'GROUP', _group1_id,
     jsonb_build_object('name', 'Đi Đà Lạt 🏔️')),
    (_group1_id, _user1_id, 'EXPENSE_CREATED', 'EXPENSE', _exp1_id,
     jsonb_build_object('amount', 2400000, 'description', 'Khách sạn Đà Lạt 2 đêm', 'paid_by', _user1_id)),
    (_group1_id, _user2_id, 'EXPENSE_CREATED', 'EXPENSE', _exp2_id,
     jsonb_build_object('amount', 800000, 'description', 'Ăn tối lẩu bò Đà Lạt', 'paid_by', _user2_id));

  RAISE NOTICE '✅ Seed data created successfully!';
  RAISE NOTICE '📧 Tài khoản test:';
  RAISE NOTICE '   demo@splitbill.test  / Demo123! (Nguyễn Văn An)';
  RAISE NOTICE '   demo2@splitbill.test / Demo123! (Trần Thị Bình)';
  RAISE NOTICE '   demo3@splitbill.test / Demo123! (Lê Hoàng Cường)';
  RAISE NOTICE '   demo4@splitbill.test / Demo123! (Phạm Minh Dũng)';

END $$;

