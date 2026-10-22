# Danh sách lỗi cần sửa — Split Bill App

22/10/2026 · Rà soát code (review tĩnh) · Phạm vi: `src/`, `supabase/`, cấu hình dự án

## 1. Thông tin tài liệu

| Mục | Nội dung |
| --- | --- |
| Đối chiếu với | [BA_SplitBill_TatToanCongNo_v1.1.md](BA_SplitBill_TatToanCongNo_v1.1.md), [DEV_SplitBill_KeHoachCode_v2.0.md](DEV_SplitBill_KeHoachCode_v2.0.md) |
| Cách rà | Đọc code, chạy `jest`, `tsc --noEmit`, `expo lint`. Chưa chạy app trên máy thật, chưa chạy Supabase local |
| Kết quả chạy | `jest`: 65/65 pass · `tsc`: lỗi · `expo lint`: 17 lỗi, 22 cảnh báo |
| Người đọc | Backend (Supabase), Mobile (Expo), QA |

**Mức độ**

| Mức | Ý nghĩa |
| --- | --- |
| Critical | Sai tiền hoặc lộ quyền, khai thác được ngay. Sửa trước mọi việc khác |
| High | Chức năng chính hỏng, mất dữ liệu, hoặc lỗ hổng cần điều kiện |
| Medium | Sai spec, sai trong tình huống cụ thể |
| Low | Ảnh hưởng nhỏ, dọn dẹp |

Mã lỗi: `SEC` bảo mật, `BE` backend, `APP` app mobile, `DOM` logic `src/domain`, `TST` kiểm thử, `CFG` cấu hình. Dòng code ghi theo trạng thái ngày 22/10/2026. Các mục có dấu ✔ ở cột "Đã kiểm" đã được đọc lại code để xác nhận; các mục còn lại lấy từ lượt rà soát, nên tái hiện trước khi sửa.

## 2. Tổng hợp

| Mức | Số lỗi |
| --- | --- |
| Critical | 2 |
| High | 10 |
| Medium | 29 |
| Low | 19 |

Thứ tự sửa đề xuất: SEC-01, SEC-02 → các lỗi High → CFG-01, CFG-02 (để `tsc` và `lint` sạch) → Medium → Low. Không build APK (giai đoạn 11) trước khi hết Critical và High.

## 3. Critical

| Mã | Đã kiểm | Vị trí | Lỗi | Tình huống gây lỗi | Hướng sửa |
| --- | --- | --- | --- | --- | --- |
| SEC-01 | ✔ | `supabase/migrations/0001_init.sql:143-145`, `src/api/payments.ts:39` | Policy INSERT của `payments` chỉ kiểm tra `from_id = auth.uid()` và thành viên. App ghi thẳng vào bảng; không có RPC `create_payment` | Người nợ tự chèn thanh toán `status='CONFIRMED'` → xóa nợ của mình mà người nhận không biết. Cũng chèn được `to_id` không phải thành viên, `decided_at` tùy ý, nhóm CLOSED | Bỏ policy INSERT. Viết RPC `create_payment` (luôn tạo PENDING, kiểm tra người nhận là thành viên ACTIVE, nhóm ACTIVE, `from_id <> to_id`, idempotency). Sửa `api/payments.ts` gọi RPC |
| SEC-02 | ✔ | `0001_init.sql:316` (`respond_payment`), `0003_groups_invites.sql:323` (`revoke_invite`); cùng mẫu ở `update_group`, `remove_member`, `close_group`, `cancel_expense`, `dispute_payment`, `cancel_payment`, `transfer_ownership` | `IF auth.uid() <> x THEN RAISE` ra NULL khi gọi bằng anon key → không raise. Không migration nào có `GRANT`/`REVOKE`, nên `anon` gọi được mọi RPC | Người gửi biết id thanh toán của mình, gọi `/rpc/respond_payment` bằng anon key → tự xác nhận. Anon thu hồi được mọi mã mời | Đầu mỗi RPC: `IF auth.uid() IS NULL THEN RAISE`. Đổi so sánh thành `IS DISTINCT FROM`. `REVOKE EXECUTE ... FROM anon, public` rồi `GRANT ... TO authenticated` |

## 4. High

| Mã | Đã kiểm | Vị trí | Lỗi | Tình huống gây lỗi | Hướng sửa |
| --- | --- | --- | --- | --- | --- |
| APP-01 | ✔ | `src/api/groups.ts:45`, `src/domain/settlement.ts:40`; nơi nuốt lỗi: `group/[id]/index.tsx:106-108`, `debts/index.tsx:99,117`, `(tabs)/index.tsx:81` | `fetchGroupMembers` chỉ lấy thành viên ACTIVE, còn `computeBalances` throw khi gặp người không có trong danh sách. Màn hình bắt lỗi rồi hiện rỗng | A rời nhóm hợp lệ (số dư 0). Từ đó cả nhóm không thấy công nợ, gợi ý; Home bỏ qua nhóm; lỗi BR-02 bị nuốt không log | Truyền mọi người từng xuất hiện trong khoản chi/thanh toán (kể cả LEFT/REMOVED) vào `computeBalances`. Hiện thông báo lỗi thay vì màn rỗng; log khi tổng số dư ≠ 0 |
| BE-01 | | `supabase/functions/settlements/index.ts:241-248` | Cùng lỗi APP-01 ở server: `memberIds` chỉ có ACTIVE | Nhóm từng có người rời → Edge Function trả 500 | Như APP-01 |
| SEC-03 | | `supabase/functions/send-push/index.ts:38-45` | Không kiểm tra webhook secret hay xác thực | Ai có anon key cũng POST `{record:{user_id, group_id, type}}` → spam push tới bất kỳ ai, nội dung push lộ tên nhóm bất kỳ | Kiểm tra header secret do Database Webhook gửi; đọc lại bản ghi `notifications` từ DB theo id thay vì tin payload |
| BE-02 | | `0004_expenses.sql:164, 252-261` (`update_expense`) | Không `SELECT ... FOR UPDATE`, `version` không nằm trong `WHERE` của `UPDATE` | Hai người sửa cùng lúc với cùng `expected_version` → cả hai qua, bản sau ghi đè bản trước và phần chia | Khóa dòng `FOR UPDATE`, hoặc `UPDATE ... WHERE id = _id AND version = _expected_version` và báo xung đột khi 0 dòng |
| BE-03 | | `0004_expenses.sql:43-57, 337-342`; `respond_payment`, `dispute_payment`, `cancel_payment`; policy INSERT `payments` | Thiếu kiểm tra nhóm CLOSED và người gọi là thành viên ACTIVE trên các thao tác ghi | Người tạo đã rời nhóm vẫn hủy khoản chi sau khi nhóm đóng → số dư người LEFT khác 0 mà không ai thấy (`group_balances` lọc `status='ACTIVE'` ở `0002_accounts.sql:263`) | Thêm kiểm tra chung (hàm `assert_active_member_of_active_group`) đầu mọi RPC ghi |
| BE-04 | | `supabase/functions/delete-account/index.ts:149` | Lọc `friendships` theo `user_a`/`user_b` nhưng cột thật là `requester_id`/`addressee_id`; lỗi bị bỏ qua | Lời mời kết bạn của người đã xóa tài khoản vẫn còn | Sửa tên cột, kiểm tra `error` |
| BE-05 | | `delete-account/index.ts:136-143, 158-162`; `0001_init.sql:13` | `deleteUser` cascade xóa `profiles`, mà `profiles` được tham chiếu không `ON DELETE` từ expenses, shares, payments, activity_logs, `groups.owner_id` → lỗi FK, nhưng hàm vẫn trả thành công. Người không có lịch sử thì bị xóa cứng thay vì ẩn danh. Chủ nhóm không bị chặn: bị đặt LEFT, nhóm mồ côi. Không bước nào kiểm tra lỗi | Người dùng có lịch sử bấm xóa tài khoản → app báo đã xóa nhưng tài khoản vẫn còn | Ẩn danh `profiles` (không xóa dòng), bỏ cascade; chặn chủ nhóm chưa chuyển quyền; kiểm tra lỗi từng bước, chỉ trả thành công khi mọi bước xong |
| APP-02 | ✔ | `src/hooks/use-auth.tsx:92-105`, `src/lib/query-persister.ts:10`, `src/api/payments.ts:36-43` | Đăng xuất không xóa cache TanStack Query, cache đã lưu (`SPLITBILL_QUERY_CACHE`), hàng đợi offline, push token. Query key không có user id | Người B đăng nhập trên máy của A → thấy nhóm, số dư của A. Thanh toán A còn trong hàng đợi được gửi dưới tên B (vì `from_id` lấy từ `auth.getUser()`) | Khi đăng xuất: `queryClient.clear()`, xóa persister, xóa hoặc gắn user id vào hàng đợi, xóa push token. Lưu `user_id` trong mỗi mục hàng đợi và bỏ qua mục không khớp |
| APP-03 | | `src/hooks/use-offline-sync.tsx:30, 56, 70, 77`, `src/offline/sync.ts:78` | Cờ `isSyncing` đọc state cũ (closure của effect `[]`), không có khóa ở module. NetInfo và lần sync đầu cùng chạy `processQueue`. `create_expense` SELECT rồi INSERT, không bắt `unique_violation` | Hai lượt sync song song → lượt thua nhận 23505, bị coi là lỗi nghiệp vụ, `markFailed` ghi đè mục đã SYNCED | Khóa ở module (`let running: Promise \| null`). Trong RPC bắt `unique_violation` và trả bản ghi cũ. Không cho `markFailed` đè trạng thái SYNCED |
| APP-04 | | `src/app/(tabs)/index.tsx:101-104, 114` | "Cần thu / cần trả" chỉ cộng từ cache của các nhóm đã mở; deps của `useMemo` không theo dõi cache | Người dùng chưa mở nhóm X → Home thiếu số của nhóm X mà không báo | Lấy từ view `group_balances` cho mọi nhóm của người dùng (đúng BA mục 7, HOME-01) |

## 5. Medium

### 5.1. Backend

| Mã | Vị trí | Lỗi | Hướng sửa |
| --- | --- | --- | --- |
| BE-06 | `0003_groups_invites.sql:217, 233, 272` (`accept_invite`) | Không khóa dòng mã mời → nhiều người cùng dùng mã `max_uses = 1` | `SELECT ... FOR UPDATE` trên `group_invites` |
| BE-07 | `0003_groups_invites.sql:660-695` (`join_group`) | Thành viên đã bị REMOVED tự vào lại bằng `groups.invite_code` tĩnh; mã này không đổi được | Chặn REMOVED tự vào lại; cho chủ nhóm đổi mã |
| BE-08 | `0003_groups_invites.sql:544-562, 617-633` | Kiểm tra BR-11 (rời nhóm, xóa thành viên, đóng nhóm) đọc số dư và PENDING không khóa → khoản chi/thanh toán mới có thể chen vào ngay sau khi kiểm tra | Khóa dòng `groups` (`FOR UPDATE`) trong các RPC này và trong mọi RPC ghi khoản chi, thanh toán |
| BE-09 | `0004_expenses.sql:38-41` | Tra `idempotency_key` toàn hệ thống, trước khi kiểm tra thành viên → người ngoài gửi trùng key nhận về khoản chi của nhóm khác. Hai lần gọi đồng thời trùng key → lỗi `unique_violation` thay vì trả bản cũ | Kiểm tra quyền trước; tra key theo `(created_by, idempotency_key)`; bắt `unique_violation` |
| BE-10 | `0001_init.sql:305-330` (`respond_payment`) | Chưa nâng cấp từ 0001: không lưu lý do từ chối, không ghi `activity_logs`, không tạo thông báo → không có push xác nhận/từ chối. `UPDATE` thiếu `AND status = 'PENDING'` và không khóa → hủy và xác nhận đồng thời có thể biến CANCELLED thành CONFIRMED | Tách thành `confirm_payment`, `reject_payment(reason)` theo DEV mục 3.4; khóa dòng; ghi nhật ký và thông báo |
| BE-11 | `0005_payments.sql:30` (`dispute_payment`), `cancel_payment` | `dispute_payment` đòi trạng thái CONFIRMED, spec nói PENDING → người nhận đảo được thanh toán đã xác nhận bất cứ lúc nào. `cancel_payment` từ chối DISPUTED, trái spec "hủy rồi gửi lại" | Theo DEV mục 3.4: dispute chỉ khi PENDING; cho người gửi hủy khi DISPUTED |
| BE-12 | `0002_accounts.sql:157` (`is_member`) | Đòi ACTIVE → thành viên đã rời không đọc được lịch sử. Spec cho đọc đến lúc rời | Thêm hàm/policy cho LEFT đọc dữ liệu có `created_at <= left_at` |
| SEC-04 | `0001_init.sql:338-346` | Policy đọc `profiles` của người chung nhóm bỏ qua trạng thái → người đã rời vẫn đọc toàn bộ dòng (`searchable`, `deleted_at`, `created_at`). Spec chỉ cho `display_name`, `user_code`, ảnh | Tạo view công khai chỉ gồm 3 cột; policy chỉ cho chính mình đọc bảng gốc |
| SEC-05 | `0001_init.sql:116` | Policy UPDATE `profiles` không giới hạn cột → người dùng tự đặt `user_code`, `deleted_at`, `searchable` tùy ý | Cập nhật hồ sơ qua RPC, hoặc `REVOKE UPDATE` rồi `GRANT UPDATE (display_name, avatar_path, searchable)` |
| BE-13 | `settlements/index.ts:14-161, 297-298` | Chép lại thuật toán thay vì import `src/domain/settlement.ts` (trái DEV mục 1.4). `simplify = false` trả `[]` thay vì dùng `pairwise.ts`. Tính trên số dư chính thức, BR-06 yêu cầu số dư dự kiến. Không đọc `group_balances` | Import mã dùng chung; hỗ trợ chế độ theo cặp; tính gợi ý trên số dư dự kiến |

### 5.2. App mobile

| Mã | Vị trí | Lỗi | Hướng sửa |
| --- | --- | --- | --- |
| APP-05 | `src/app/group/[id]/expense/[expenseId]/edit.tsx:205, 214-215, 52-84` | RPC báo "Khoản chi đã được sửa bởi người khác..." nhưng app chỉ tìm chữ `version`/`conflict` → nhánh xử lý xung đột không bao giờ chạy. Khi chạy, `setLoaded(false); refetch()` lại nạp dữ liệu cũ trong cache → giữ `version` cũ, lần lưu sau vẫn lỗi | Cho RPC trả mã lỗi riêng (`ERRCODE`), app so theo mã. `await refetch()` rồi mới nạp lại form |
| APP-06 | `group/[id]/index.tsx:102`, `group/[id]/pay.tsx:79`, `debts/[userId].tsx:91`; `debts/index.tsx:154` vs `group/[id]/edit.tsx:39` | BR-09 chỉ áp ở `debts/index.tsx`; các màn khác luôn gọi `simplifyDebts`. `simplify_debts = null` được hiểu là bật ở màn công nợ nhưng là tắt ở màn sửa nhóm | Một hàm chung `suggestTransfers(group, ...)` chọn `simplifyDebts` hoặc `pairwiseDebts`; mặc định `true` thống nhất |
| APP-07 | `group/[id]/pay.tsx:106`, `group/[id]/add-expense.tsx:161` | `idempotency_key` sinh mỗi lần bấm trong handler, không giữ theo form → request bị timeout nhưng đã tới server, bấm lại tạo bản ghi trùng; bấm nhanh hai lần lọt qua `disabled={submitting}` | Sinh key một lần cho mỗi form bằng `useRef`, chỉ đổi khi lưu thành công; chặn bằng ref đồng bộ |
| APP-08 | `pay.tsx:123`, `add-expense.tsx:179`, `src/offline/sync.ts:56, 72`, `src/offline/queue.ts:58, 95` | Hàng đợi offline lệch DEV mục 6: chỉ đưa vào hàng đợi khi lỗi chứa "network"/"fetch"; không hiện "Chưa đồng bộ"; backoff tính từ `created_at` thay vì lần thử cuối; sau 10 lần lỗi mạng thì FAILED vĩnh viễn; mục FAILED không hiện (chỉ đếm PENDING) nên lỗi nghiệp vụ biến mất không báo; lỗi xác thực/5xx bị coi là lỗi nghiệp vụ, không thử lại; sắp thứ tự theo `created_at` độ phân giải 1 giây, không có `id` phụ; handler `respond`/`dispute`/`cancel_payment` có nhưng không chỗ nào đưa vào hàng đợi | Ghi vào hàng đợi trước rồi mới gửi; thêm `last_attempt_at`; hiện danh sách mục lỗi cho người dùng sửa; phân loại lỗi theo mã; sắp theo `(created_at, id)` |
| APP-09 | `add-expense.tsx:60-81`, `0004_expenses.sql:94`, `expense/[expenseId]/edit.tsx:76-78` | Chia phần trăm viết trong màn hình (trái DEV mục 1.5), dùng `parseFloat`, phần dư dồn cho người đầu tiên theo thứ tự chọn (không theo `user_id` như EXP-02). Không gửi `percent_bp` → lưu NULL; mở sửa thì mọi người 0%, lưu báo "Tổng phần trăm 0%" | Thêm `splitPercent(amount, {userId, bp}[])` vào `src/domain/split.ts` + test; gửi `percent_bp`; màn sửa đọc lại `percent_bp` |
| APP-10 | `src/hooks/use-notifications.tsx:112`, `src/app/_layout.tsx:48`, `src/api/notifications.ts:59`; `app.json` | Đăng ký push chạy một lần lúc mở app, trước khi đăng nhập → báo "Chưa đăng nhập" và không thử lại. `getExpoPushTokenAsync()` thiếu `projectId`, `app.json` không có `extra.eas.projectId`. Không xử lý mở app từ thông báo khi app đang tắt | Đăng ký lại khi có phiên; khai báo `projectId`; dùng `getLastNotificationResponseAsync` |
| APP-11 | `src/app/_layout.tsx:37-43`, `src/app/join/[token].tsx:29` | Mở link mời khi chưa đăng nhập → chuyển sang đăng nhập và mất `token`; đăng nhập xong về `/(tabs)`. Màn join có thể gọi `acceptInvite` trước khi chuyển hướng | Lưu đường dẫn đích, chuyển lại sau khi đăng nhập; chỉ gọi `acceptInvite` khi đã có phiên |
| APP-12 | `src/lib/query-persister.ts` | Persister không có `maxAge`, `buster`; `gcTime` mặc định 5 phút nên chỉ query vừa xem mới còn khi mất mạng. Không hiện "Đồng bộ lúc ..." | Đặt `gcTime` ≥ `maxAge`; hiện thời điểm đồng bộ gần nhất |
| APP-13 | `src/app/account/security.tsx:84-90`, `src/app/user/[id].tsx:38, 47`, `src/app/(tabs)/contacts.tsx:35`, `src/app/(auth)/forgot-password.tsx:30` | Màn hình gọi Supabase trực tiếp, trái DEV mục 1.5 | Chuyển vào `src/api/` |
| DOM-01 | `src/domain/explain.ts` | Chỉ liệt kê khoản chi do người nhận trả; không giải thích phần bù trừ qua người khác. Chưa đạt AC-02.1 (thiếu 15.000đ khoản B trả). Dùng `(e as any).description` vì `ExpenseInput` không có `description` | Liệt kê mọi khoản người trả có phần chịu, kèm câu "phần X ứng đã bù trừ qua Y"; thêm `description` vào kiểu; test so đúng câu mẫu AC-02.1 |
| APP-14 | `src/app/group/[id]/pay.tsx:88-90`, `add-expense.tsx:47-51` | Gọi `setState` trong `useMemo` (lint báo lỗi), rủi ro vòng lặp render khi bật `reactCompiler` | Chuyển sang tính dẫn xuất hoặc xử lý trong handler |
| APP-15 | `account/privacy.tsx:30`, `account/profile.tsx:39`, `group/[id]/edit.tsx:37`, `expense/[expenseId]/edit.tsx:55`, `join/[token].tsx:22`, `hooks/use-offline-sync.tsx:70` | Gọi `setState` đồng bộ trong `useEffect` (lint báo lỗi) | Khởi tạo state từ dữ liệu query, hoặc dùng `key` để reset form |

### 5.3. Cấu hình và kiểm thử

| Mã | Vị trí | Lỗi | Hướng sửa |
| --- | --- | --- | --- |
| CFG-01 | `tsconfig.json` | `include: **/*.ts` gom cả `supabase/functions` (Deno) → `tsc` báo lỗi `Deno`, import `https://esm.sh/...` | Thêm `"exclude": ["supabase/functions"]`; kiểm tra Edge Function bằng `deno check` |
| CFG-02 | `src/domain/split.test.ts` | `tsc` không thấy `describe`/`test`/`expect` | Thêm `"types": ["jest"]` cho file test trong `tsconfig.json`, hoặc import từ `@jest/globals` |
| CFG-03 | `eas.json`, `src/lib/supabase.ts:22` | `.env` bị gitignore, `eas.json` không có `env` → build trên EAS âm thầm dùng `https://placeholder.supabase.co` | Khai báo biến môi trường EAS; báo lỗi rõ khi thiếu biến thay vì dùng placeholder |
| CFG-04 | `supabase/migrations/` | Không có Database Webhook cho `send-push` → push không bao giờ được gửi | Thêm trigger `pg_net` hoặc cấu hình webhook kèm secret (xem SEC-03) |
| TST-01 | `supabase/tests/rls.test.sql:92, 102, 353-359` | Không dùng pgTAP; gọi `assert.ok` không tồn tại; `_test_set_user` là SECURITY DEFINER gọi `set_config('role', ...)` (Postgres không cho) → mọi test RLS lỗi; TEST-RLS-13 nuốt lỗi bằng `WHEN OTHERS` nên luôn pass | Viết lại bằng pgTAP + `supabase test db`; đặt role bằng `SET LOCAL role` và `request.jwt.claims` |
| TST-02 | `supabase/tests/concurrency.test.sql`, `rls.test.sql` TEST-RLS-12, TEST-CONC-05b | Test "đồng thời" chạy tuần tự trong một phiên. Một số test khóa cứng hành vi sai (BE-11, BE-12). Không test quyền RPC, gọi bằng anon, nhóm CLOSED, BR-11, Storage, Edge Function | Test đồng thời bằng hai kết nối; sửa test theo spec; thêm test cho SEC-01, SEC-02 |
| CFG-05 | Git | Chỉ có "Initial commit"; toàn bộ code mới chưa commit | Commit theo giai đoạn; bật CI chạy `jest`, `tsc`, `lint` (giai đoạn 0) |

## 6. Low

| Mã | Vị trí | Lỗi | Hướng sửa |
| --- | --- | --- | --- |
| SEC-06 | `0006_contacts.sql:241` (`search_users`) | Không escape `%`, `_`; không có độ dài tối thiểu → tìm `_` liệt kê người dùng | Escape ký tự LIKE; tối thiểu 2–3 ký tự |
| SEC-07 | `create_invite` | Không kiểm tra `_max_uses`, `_expires_hours`, `invited_user_id` | Ràng buộc khoảng giá trị hợp lệ |
| SEC-08 | `is_member`, `generate_user_code` | Anon gọi được | Gộp vào REVOKE của SEC-02 |
| SEC-09 | `0004_expenses.sql:405-418` | Mọi thành viên ghi đè, xóa được ảnh hóa đơn của người khác trong nhóm | Chỉ người tạo khoản chi hoặc chủ nhóm được ghi/xóa |
| SEC-10 | `src/lib/supabase.ts:20` | `console.log` tiền tố URL Supabase | Bỏ log |
| BE-14 | `settlements/index.ts`, `delete-account/index.ts` | Phản hồi lỗi không có header CORS | Thêm CORS cho mọi phản hồi |
| BE-15 | `send-push/index.ts` | Không chia request Expo Push quá 100 tin | Chia lô 100 |
| APP-16 | `debts/index.tsx:242` | Bấm gợi ý giữa hai người khác lại mở cặp của chính mình, hiện "Đã cân bằng" | Mở đúng cặp `from`/`to` của gợi ý |
| APP-17 | `pay.tsx:201` | Cảnh báo vượt mức (BR-07) không xét người nhận đang chọn, không hiện khi người dùng không có gợi ý | So với số dư dự kiến của người trả theo đúng người nhận |
| APP-18 | `src/api/*` (ví dụ `fetchGroupActivities`) | Trả về `any` | Sinh kiểu bằng `supabase gen types typescript` |
| APP-19 | Màn công nợ, màn nhóm; `history.tsx`, `group/[id]/index.tsx` | Lỗi query hiển thị như dữ liệu rỗng; thiếu nút quay lại dưới `<Slot/>` gốc | Thêm trạng thái lỗi; dùng Stack có header |
| APP-20 | Query key `['unread-count']` và `['notifications','unreadCount']` | Hai key cho cùng số chưa đọc | Gộp một key |
| APP-21 | Màn xóa tài khoản | Ghi "xóa vĩnh viễn", spec nói ẩn danh và giữ lịch sử | Sửa câu chữ theo spec |
| DOM-02 | `src/domain/pairwise.ts` | Sắp thứ tự bằng `localeCompare` (phụ thuộc locale/Hermes), `settlement.ts` dùng `<` | Dùng cùng một hàm so sánh mã để kết quả ổn định (BR-05) |
| DOM-03 | `src/domain/money.ts` (`parseVND`) | `"45,5"` thành 455; không chặn số vượt `Number.MAX_SAFE_INTEGER` | Từ chối dấu phẩy thập phân; kiểm tra giới hạn |
| DOM-04 | `src/domain/split.ts` | Chỉ có chia đều; chú thích đầu file lệch nội dung | Bổ sung `splitPercent` (xem APP-09) |
| CFG-06 | `../settlement.ts`, `../settlement.test.ts` (thư mục cha) | Bản cũ, khác `src/domain/settlement.ts` | Xóa hoặc chuyển vào lưu trữ |
| CFG-07 | `src/components/` (animated-icon, web-badge, hint-row, ui/collapsible, external-link, app-tabs, themed-*), `src/hooks/use-theme.ts`, `use-color-scheme*.ts`, `src/constants/theme.ts`, `src/global.css`, `scripts/reset-project.js`, `assets/images/` (react-logo, expo-logo, logo-glow, expo-badge, tutorial-web, tabIcons), `assets/expo.icon` | File thừa từ template Expo | Xóa; thay icon iOS trong `app.json` |
| CFG-08 | `package.json` | `@expo/ngrok` nằm trong `dependencies` | Chuyển sang `devDependencies` hoặc bỏ |

## 7. Chức năng còn thiếu so với kế hoạch

Không phải lỗi, nhưng cần làm để đạt tiêu chí "Xong khi" của từng giai đoạn trong [kế hoạch code](DEV_SplitBill_KeHoachCode_v2.0.md).

| Hạng mục | Giai đoạn | Còn thiếu |
| --- | --- | --- |
| RPC thanh toán | 4 | `create_payment`, `confirm_payment`, `reject_payment(reason)`; hàm `is_owner()` |
| Tạo nhóm | 2 | Màn `group/new.tsx` có công tắc "Đơn giản hóa công nợ" (hiện là modal trong `groups.tsx`, không có công tắc) |
| Thêm khoản chi | 3 | Luồng hai bước; ảnh hóa đơn EXP-08 (chưa có `expo-image-picker`) |
| QR | 2, 7 | Tạo QR (`contacts/add.tsx:152` đang để chỗ trống) và quét QR (chưa có `expo-camera`, `react-native-qrcode-svg`) |
| Phương thức thanh toán | 7 | Màn `account/payment-methods.tsx` |
| Thông báo | 6 | Webhook (CFG-04); xử lý thông báo "gợi ý thay đổi" |
| Cập nhật tức thì | 2 | Realtime trên `expenses`, `payments` |
| Đọc hóa đơn bằng AI | 8 | Toàn bộ: `receipt.ts`, `parse-receipt`, `ocr_usage`, `profiles.ocr_ai_enabled`, `expenses.source`, màn `scan` và `assign-items` |
| CI | 0 | Chạy kiểm thử khi đẩy code |
