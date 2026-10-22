# Danh sách lỗi cần sửa — Split Bill App

22/10/2026 · Rà soát code (review tĩnh) · Phạm vi: `src/`, `supabase/`, cấu hình dự án

## 1. Thông tin tài liệu

| Mục | Nội dung |
| --- | --- |
| Đối chiếu với | [BA_SplitBill_TatToanCongNo_v1.1.md](BA_SplitBill_TatToanCongNo_v1.1.md), [DEV_SplitBill_KeHoachCode_v2.0.md](DEV_SplitBill_KeHoachCode_v2.0.md) |
| Cách rà | Đọc code, chạy `jest`, `tsc --noEmit`, `expo lint`. Chưa chạy app trên máy thật, chưa chạy Supabase local |
| Kết quả chạy | `jest`: 65/65 pass · `tsc`: lỗi · `expo lint`: 17 lỗi, 22 cảnh báo |
| Người đọc | Backend (Supabase), Mobile (Expo), QA |

**Lịch sử phiên bản**

| Phiên bản | Ngày | Thay đổi |
| --- | --- | --- |
| 1.4 | 22/10/2026 | Rà soát lại vòng sửa 3, sửa 30 lỗi mới tìm thấy (mục 12) |
| 1.3 | 22/10/2026 | Sửa toàn bộ lỗi còn mở ở mục 8–9 (mục 11) |
| 1.2 | 22/10/2026 | Sửa NEW-01, NEW-03, NEW-04, APP-04 (mục 10) |
| 1.1 | 22/10/2026 19:30 | Kiểm tra lại sau 6 commit sửa lỗi (`4f0db20`..`8572d91`). Trạng thái từng lỗi ở mục 8, lỗi mới phát sinh ở mục 9 |
| 1.0 | 22/10/2026 17:14 | Danh sách 60 lỗi ban đầu |

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

## 8. Kết quả kiểm tra lại — 22/10/2026 19:30

Đối chiếu code ở commit `8572d91` với từng lỗi trong mục 3–6. Cách kiểm: đọc code, chạy `jest` (65/65 pass), `tsc --noEmit` (sạch), `expo lint` (13 lỗi, 27 cảnh báo; trước là 17 lỗi). Chưa chạy migration trên Supabase thật, chưa chạy app trên máy.

**Trạng thái:** ✅ Đã sửa — đóng được tình huống gây lỗi · 🟡 Sửa một phần — còn khoảng trống ghi ở cột bên phải · ❌ Chưa sửa.

| Mức | ✅ | 🟡 | ❌ | Tổng |
| --- | --- | --- | --- | --- |
| Critical | 2 | 0 | 0 | 2 |
| High | 5 | 4 | 1 | 10 |
| Medium | 7 | 16 | 6 | 29 |
| Low | 12 | 4 | 3 | 19 |
| **Tổng** | **26** | **24** | **10** | **60** |

Ngoài ra có **10 lỗi mới** do chính các bản sửa gây ra (mục 9), trong đó 1 lỗi Critical làm hỏng hầu hết màn hình nhóm. M7 = `supabase/migrations/0007_security_fixes.sql`, M8 = `0008_push_notification_webhook.sql`.

### 8.1. Critical và High

| Mã | Trạng thái | Bằng chứng | Còn thiếu |
| --- | --- | --- | --- |
| SEC-01 | ✅ | M7:85 xóa đúng tên policy; RPC `create_payment` M7:91; `api/payments.ts:53` gọi RPC | Xem NEW-06 |
| SEC-02 | ✅ | 23 RPC dùng `assert_authenticated()` + `IS DISTINCT FROM`; M7:2125 `REVOKE ... FROM anon, public` | Không có `ALTER DEFAULT PRIVILEGES` → hàm tạo sau này lại có quyền PUBLIC. M7:2128 cấp cả hàm hỗ trợ `assert_active_member_of_active_group` cho authenticated (gọi được như RPC để dò nhóm có tồn tại không) |
| APP-01 | 🟡 | `api/groups.ts:67-72` lấy cả thành viên đã rời | Lỗi vẫn bị nuốt (`group/[id]/index.tsx:106-108`, `debts/index.tsx:99,117`, `(tabs)/index.tsx:82`); không log khi tổng số dư ≠ 0. Bản sửa gây NEW-03 |
| BE-01 | ✅ | `settlements/index.ts:45-49, 292-297` | — |
| SEC-03 | ✅ | `send-push/index.ts:77-83` kiểm tra secret; 98-103 đọc lại bản ghi từ DB | Push vẫn chưa chạy do CFG-04 |
| BE-02 | ✅ | M7:553-556 `FOR UPDATE`; M7:644-653 `version` trong `WHERE` | — |
| BE-03 | ✅ | Hàm kiểm tra chung M7:41-77 dùng cho mọi RPC ghi khoản chi, thanh toán | `revoke_invite` (M7:985) chưa kiểm tra nhóm ACTIVE và thành viên ACTIVE |
| BE-04 | ✅ | `delete-account/index.ts:206` đúng tên cột | Lỗi chỉ được log, hàm vẫn trả 200 |
| BE-05 | 🟡 | Chặn chủ nhóm (69-92); ẩn danh hồ sơ (153-169) | Vẫn còn `profiles → auth.users ON DELETE CASCADE` (0001:13): người có lịch sử bị lỗi FK khi `deleteUser`, hàm vẫn báo thành công, tài khoản vẫn đăng nhập được. Người không có lịch sử vẫn bị xóa cứng hồ sơ. Không chạy trong giao dịch |
| APP-02 | 🟡 | `use-auth.tsx:94-100` xóa cache đã lưu và hàng đợi khi `signOut` | Chưa `queryClient.clear()` → người sau vẫn thấy dữ liệu trong bộ nhớ, rồi persister ghi lại. `signOutAll` không xóa gì. Không gọi `removePushToken`. `user_id` chỉ có trong kiểu TS, bảng SQLite không có cột này. Query key chưa có user id |
| APP-03 | 🟡 | Khóa ở module (`use-offline-sync.tsx:22,43-63`); `safeMarkFailed` không đè SYNCED (`sync.ts:67-73`) | `create_expense` vẫn chưa bắt `unique_violation`. Mẫu `'CLOSED'` so với chuỗi đã chuyển chữ thường (`sync.ts:59-61`) nên không bao giờ khớp |
| APP-04 | ❌ | `(tabs)/index.tsx:101-103` đọc cột `balance` | View `group_balances` không có cột `balance`, chỉ có `official_balance`, `projected_balance` → query lỗi, phần tổng trên Home không bao giờ hiện. Không invalidate sau khi ghi |

### 8.2. Medium

| Mã | Trạng thái | Bằng chứng | Còn thiếu |
| --- | --- | --- | --- |
| BE-06 | ✅ | M7:1125-1128 | — |
| BE-07 | 🟡 | M7:1174, 1254 chặn REMOVED | Chưa có RPC đổi `invite_code`; chủ nhóm không còn cách mời lại người đã bị xóa |
| BE-08 | 🟡 | `leave_group`, `remove_member`, `close_group` khóa `groups` (M7:1309, 1394, 1484) | `create_expense`, `update_expense`, `create_payment`, `confirm_payment` không khóa dòng `groups` → khoản mới vẫn chen vào được sau bước kiểm tra BR-11 |
| BE-09 | 🟡 | Tra key theo `created_by` (M7:736-739) | UNIQUE trên `expenses.idempotency_key` vẫn toàn bảng (0001:45); index mới M7:2140 không UNIQUE; `create_expense` không bắt `unique_violation` → gọi đồng thời hoặc trùng key người khác ra lỗi 23505 |
| BE-10 | ✅ | `confirm_payment`, `reject_payment` M7:201-341 | — |
| BE-11 | ✅ | M7:396, M7:478 | App chưa theo kịp, xem NEW-07 |
| BE-12 | ✅ | M7:2016-2113, giới hạn theo `left_at` | Storage `receipts` vẫn dùng `is_member` (chỉ ACTIVE) nên người đã rời không xem được ảnh hóa đơn |
| SEC-04 | 🟡 | M7:1880 xóa policy cũ; view `public_profiles` M7:1891 | Gây NEW-01 và NEW-05 |
| SEC-05 | 🟡 | M7:1914 xóa policy UPDATE; RPC `update_profile` M7:1918 | App không gọi RPC, gây NEW-02. `COALESCE` khiến không xóa được `avatar_path` |
| BE-13 | 🟡 | Thêm chế độ theo cặp (`settlements/index.ts:172-217`) | Vẫn chép thuật toán thay vì dùng chung `src/domain/settlement.ts`. Gợi ý tính trên số dư chính thức (349-351) trái BR-06; chế độ theo cặp bỏ qua PENDING |
| APP-05 | ❌ | `expense/[expenseId]/edit.tsx:209-211` so mã `P0002` hoặc chữ thường `version`/`conflict` | RPC báo `VERSION_CONFLICT: ...` (M7:652) không có `ERRCODE` → mã là `P0001`, và so chuỗi phân biệt hoa thường → nhánh xung đột vẫn không chạy. Phần tải lại đã sửa đúng (220-225) |
| APP-06 | 🟡 | `pay.tsx:89-92`, `debts/index.tsx:106` theo công tắc | `group/[id]/index.tsx:102` và `debts/[userId].tsx:92` vẫn luôn gọi `simplifyDebts`; chưa có hàm dùng chung. Công tắc trên màn công nợ luôn lỗi, xem NEW-08 |
| APP-07 | 🟡 | Key giữ bằng `useRef`, chỉ đổi khi thành công (`pay.tsx:43,134`, `add-expense.tsx:41,164`) | Chưa chặn bấm hai lần bằng ref; bấm hai lần trên màn thêm khoản chi → `create_expense` ra 23505 (BE-09), người dùng thấy báo lỗi dù đã lưu |
| APP-08 | ❌ | Vẫn chỉ đưa vào hàng đợi khi lỗi chứa "network"/"fetch" (`pay.tsx:143`, `add-expense.tsx:171`) | Backoff vẫn tính từ `created_at` (`sync.ts:97-99`); không có `last_attempt_at`; sắp thứ tự không có `id` phụ (`queue.ts:60`); mục FAILED không hiện (`getFailedItems` không ai dùng); respond/dispute/cancel không được đưa vào hàng đợi; vẫn giới hạn 10 lần. Chỉ sửa được: lỗi 5xx và JWT nay được thử lại |
| APP-09 | 🟡 | Màn thêm dùng `splitPercent` (`add-expense.tsx:62-70`) | Không gửi `percentBp` (RPC đọc `_share->>'percentBp'`, M7:794) → vẫn lưu NULL. Màn sửa vẫn tự chia bằng `parseFloat`, phần dư dồn người đầu (`edit.tsx:90-112`), mở lại vẫn 0% (75-78) |
| APP-10 | 🟡 | Chờ có `user` mới đăng ký (`use-notifications.tsx:68-72`); xử lý mở từ thông báo khi app tắt (98) | `app.json` `extra.eas.projectId` còn là `"your-project-id-here"` |
| APP-11 | 🟡 | `_layout.tsx:47-72` lưu link khi app đang chạy | Mở link khi app đang tắt (không có `getInitialURL`) vẫn mất token; `join/[token].tsx:20-40` vẫn gọi `acceptInvite` không kiểm tra phiên |
| APP-12 | 🟡 | `gcTime` 24h, `maxAge` 24h, có `buster` | "Đồng bộ lúc" chỉ hiện khi có mục đang chờ (`sync-status-bar.tsx:16`), không gắn với thời điểm cache |
| APP-13 | 🟡 | 4 màn trong danh sách đã chuyển sang `api/auth.ts`, `api/profiles.ts` | Màn Home mới gọi Supabase trực tiếp (`(tabs)/index.tsx:24,101`) |
| DOM-01 | ❌ | `explain.ts:61-62` vẫn chỉ liệt kê khoản người nhận trả | Vẫn thiếu 15.000đ và câu "phần B ứng đã bù trừ qua A". Test khóa cứng kết quả sai (`explain.test.ts:41-42`: `totalOwedToRecipient = 30_000`, `toHaveLength(1)`) |
| APP-14 | 🟡 | `pay.tsx` chuyển sang `useEffect` (101-107) | `add-expense.tsx:49-56` nay gọi `setState` đồng bộ trong effect (lint báo lỗi) |
| APP-15 | 🟡 | privacy, profile, sửa nhóm đã sửa | Còn ở `expense/[expenseId]/edit.tsx:52-84`, `join/[token].tsx:20-24` và chỗ mới ở `add-expense.tsx` |
| CFG-01 | ✅ | `tsconfig.json` loại `supabase/functions` | — |
| CFG-02 | ✅ | `"types": ["jest"]`; `tsc` sạch | — |
| CFG-03 | ✅ | `eas.json` có `env`; `supabase.ts:9-14` báo lỗi khi thiếu biến | Chưa kiểm được EAS có thay `${SUPABASE_URL}` trong `eas.json` hay không; nên chạy thử một bản build |
| CFG-04 | ❌ | M8:30 gọi `extensions.http_post(url:=, body:=...::text, headers:=)` | Hàm của pg_net là `net.http_post(url, body jsonb, params, headers, timeout_milliseconds)` → lời gọi không tìm được hàm. M8:53-57 nuốt mọi lỗi thành WARNING; M8:25-27 lặng lẽ thoát khi chưa đặt `app.settings.*`, mà không migration nào đặt → không push nào được gửi, không ai biết |
| TST-01 | ❌ | Đã viết lại bằng pgTAP và `SET LOCAL role` | `rls.test.sql:296-297` dùng `PERFORM`/`EXECUTE` ngoài hàm → lỗi cú pháp, hủy giao dịch. TEST-RLS-11 (207-221) vẫn khẳng định người đã rời không đọc được nhóm, trái BE-12. Test 17-18 chạy bằng anon sẽ bị "permission denied" thay vì trả 0 dòng |
| TST-02 | ❌ | | Vẫn chạy tuần tự trong một phiên. `concurrency.test.sql:219,221` dùng `PERFORM` ngoài hàm. `throws_ok` chờ `P0002` nhưng `RAISE EXCEPTION` cho `P0001`. TEST-CONC-05 vẫn theo hành vi cũ của BE-11 và phần chuẩn bị (xác nhận rồi báo sai lệch) nay sẽ lỗi. Vẫn chưa test gọi bằng anon, chèn CONFIRMED trực tiếp, nhóm CLOSED, BR-11, Storage, Edge Function |
| CFG-05 | 🟡 | 7 commit theo giai đoạn, cây làm việc sạch | Chưa có CI (không có `.github/workflows`) |

### 8.3. Low

| Mã | Trạng thái | Bằng chứng | Còn thiếu |
| --- | --- | --- | --- |
| SEC-06 | ✅ | M7:1706-1714 (tối thiểu 2 ký tự, escape `\ % _`) | — |
| SEC-07 | ✅ | M7:1573-1591 | — |
| SEC-08 | ✅ | M7:2125 | — |
| SEC-09 | 🟡 | M7:1955-2004 | Điều kiện là "người gọi đã tạo một khoản chi bất kỳ trong nhóm" (thư mục cấp 1), không phải đúng khoản chi ở thư mục cấp 2 → ai từng tạo một khoản chi vẫn ghi đè, xóa được mọi ảnh trong nhóm. Thành viên chưa tạo khoản chi nào thì không tải ảnh lên được |
| SEC-10 | ✅ | `src/lib/supabase.ts:25` | — |
| BE-14 | ✅ | Mọi phản hồi có `corsHeaders` | — |
| BE-15 | ✅ | `send-push/index.ts:154-182` | — |
| APP-16 | ❌ | `debts/index.tsx:242-253` | Gợi ý giữa hai người khác vẫn mở cặp của chính mình |
| APP-17 | ❌ | `pay.tsx:233-235` | Vẫn không cảnh báo khi không có gợi ý hoặc người nhận khác người được gợi ý |
| APP-18 | 🟡 | groups, expenses, payments, profiles đã có kiểu | activity, contacts, notifications, `fetchInvites` vẫn `any`; chưa sinh kiểu bằng `supabase gen types` |
| APP-19 | 🟡 | Thêm trạng thái lỗi ở `group/[id]/index.tsx:174`, `pay.tsx:174`, `debts/[userId].tsx:133` | `debts/index.tsx`, `history.tsx` chưa có; gốc vẫn là `<Slot/>` (`_layout.tsx:116`) |
| APP-20 | ✅ | Chỉ còn `['unread-count']` | — |
| APP-21 | ❌ | `account/security.tsx:75,157` | Vẫn ghi "xóa vĩnh viễn" |
| DOM-02 | ✅ | `pairwise.ts:45,62` | — |
| DOM-03 | ✅ | `money.ts:30-46` | `"1,000,5"` vẫn thành 10005; chưa có test số thập phân và giới hạn |
| DOM-04 | 🟡 | `splitPercent` ở `split.ts:64` | Chưa có test; không kiểm tra tổng phần vạn bằng 10000 (thừa thì bị bỏ qua) |
| CFG-06 | ✅ | Chuyển vào `archive/` | — |
| CFG-07 | ✅ | Đã xóa file template (commit `8572d91`) | Script `reset-project` trong `package.json:53` trỏ tới file đã xóa; còn thư mục rỗng `src/components/ui`, `src/constants`, `scripts` |
| CFG-08 | ✅ | `@expo/ngrok` trong `devDependencies` | — |

### 8.4. Chức năng còn thiếu (mục 7)

| Hạng mục | Trạng thái |
| --- | --- |
| RPC thanh toán | `create_payment`, `confirm_payment`, `reject_payment` đã có; `is_owner()` chưa có |
| Tạo nhóm, QR, ảnh hóa đơn, phương thức thanh toán, Realtime, đọc hóa đơn bằng AI, CI | Chưa làm |
| Webhook thông báo | Có M8 nhưng không chạy được (CFG-04); không chỗ nào tạo thông báo `SUGGESTION_CHANGED` |

## 9. Lỗi mới phát sinh từ các bản sửa

| Mã | Mức | Đã kiểm | Vị trí | Lỗi | Tình huống gây lỗi | Hướng sửa |
| --- | --- | --- | --- | --- | --- | --- |
| NEW-01 | Critical | ✔ | M7:1880-1888; `api/groups.ts:70,79,95,104`, `api/expenses.ts:47-48,71-72`, `api/payments.ts:28-29,101-102`, `api/activity.ts:15,55`, `api/profiles.ts:38` | Bản sửa SEC-04 xóa policy cho người chung nhóm đọc hồ sơ nhau; chỉ còn đọc hồ sơ của chính mình. Mọi truy vấn nhúng `profiles:user_id(...)` trả `null` cho người khác; app không dùng view `public_profiles` | Nhóm có từ 2 người → `gm.profiles.id` ném TypeError → danh sách thành viên hỏng, kéo theo màn nhóm, thanh toán, công nợ, thêm khoản chi, thẻ nhóm trên Home. Tên người trả, người gửi, người làm trong lịch sử thành trống. Màn hồ sơ người khác lỗi | Thêm lại policy SELECT cho người chung nhóm (giới hạn cột bằng `GRANT SELECT (id, display_name, user_code, avatar_path)`), hoặc đổi mọi chỗ nhúng sang view `public_profiles` có `security_invoker` |
| NEW-02 | High | | M7:1914; `api/profiles.ts:53-58, 84-87, 108-111` | Bản sửa SEC-05 xóa policy UPDATE nhưng app vẫn UPDATE thẳng bảng | Đổi tên, bật tắt quyền riêng tư đều lỗi (`.single()` không có dòng). Tải và xóa ảnh đại diện báo thành công nhưng `avatar_path` không được lưu | Gọi RPC `update_profile`; sửa RPC để xóa được `avatar_path` |
| NEW-03 | High | ✔ | `api/groups.ts:67-72`, `add-expense.tsx:49-56`, `members.tsx:40` | Bản sửa APP-01 làm `fetchGroupMembers` trả cả người đã rời, và mọi màn đều dùng danh sách này | Nhóm có người rời → màn thêm khoản chi chọn sẵn cả người đó → RPC báo `SHARE_USER_NOT_MEMBER`. Người đã rời xuất hiện là người trả, người nhận thanh toán và thành viên hiện tại | Tách hai danh sách: người tham gia tính số dư (mọi trạng thái) và thành viên ACTIVE cho các form; `fetchActiveGroupMembers` đã có nhưng chưa dùng |
| NEW-04 | High | ✔ | `src/offline/sync.ts:16-17`, `pay.tsx:145-146` | Hàng đợi chuyển nguyên payload `{groupId, toId, amount, ...}` vào `rpc('create_payment')`, trong khi RPC nhận `_group_id`, `_to_id`, ... | Mọi thanh toán tạo khi mất mạng không bao giờ được gửi: thử 10 lần rồi FAILED, không hiện cho người dùng | Gọi `createPayment()` trong `api/payments.ts` thay vì gọi RPC trực tiếp |
| NEW-05 | Medium | ✔ | M7:1891-1911 | View `public_profiles` không đặt `security_invoker`, chủ view bỏ qua RLS | Bất kỳ người dùng đăng nhập nào (và anon nếu còn quyền mặc định trên view) liệt kê được mọi người dùng, kể cả người đặt `searchable = false` | Thêm `WITH (security_invoker = true)` và policy phù hợp, hoặc lọc theo người chung nhóm / `searchable` |
| NEW-06 | Medium | | M7:158-167 | `idempotency_key` của `payments` vẫn UNIQUE toàn bảng; khi trùng key của người khác, nhánh bắt lỗi tìm theo `from_id = _caller`, không thấy gì và trả JSON toàn `null` | App coi là gửi thành công trong khi không có thanh toán nào được tạo | Đổi UNIQUE thành `(from_id, idempotency_key)`; trong nhánh bắt lỗi, nếu không tìm thấy thì raise |
| NEW-07 | Medium | | `payment/[id].tsx:281` | Nút "Báo sai lệch" chỉ hiện khi CONFIRMED, nhưng RPC nay chỉ nhận PENDING (BE-11). Không có nút cho người gửi hủy khoản DISPUTED | Báo sai lệch luôn lỗi; người gửi kẹt với khoản DISPUTED | Hiện nút khi PENDING; thêm nút hủy cho người gửi khi DISPUTED |
| NEW-08 | Medium | | `debts/index.tsx:132`, `update_group` M7:915 | Công tắc trên màn công nợ gọi `updateGroup(id, { simplify_debts })` → gửi `_name = null`; RPC đặt `name = trim(NULL)`, vi phạm `NOT NULL` (0001:21) và xóa trắng mô tả | Bật tắt "Đơn giản hóa công nợ" từ màn công nợ luôn lỗi | Gửi đủ tên và mô tả hiện tại, hoặc thêm RPC `set_simplify_debts` |
| NEW-09 | Low | | M8:12, M8:21 | Hàm trigger SECURITY DEFINER đặt `search_path = public` (không phải `''`); thiết kế đòi lưu service role key trong cài đặt database `app.settings.service_role_key` | Ai đọc được cài đặt database sẽ thấy service role key | Đặt `search_path = ''`; dùng Supabase Vault hoặc webhook secret riêng thay cho service role key |
| NEW-10 | Low | | `package.json:53` | Script `reset-project` trỏ tới file đã xóa | `npm run reset-project` lỗi | Xóa script |

**Thứ tự sửa đề xuất cho vòng tiếp theo:** NEW-01, NEW-03, NEW-04, APP-04 (app gần như không dùng được nếu chưa sửa) → NEW-02, CFG-04, APP-05, BE-05 → TST-01, TST-02 (để kiểm thử backend chạy được) → các mục 🟡 còn lại.

## 10. Vòng sửa 2 — 22/10/2026

Đã sửa 4 lỗi ưu tiên cao nhất ở mục 9. Kiểm tra: `jest` 65/65 pass, `tsc --noEmit` sạch, `expo lint` 13 lỗi / 26 cảnh báo (13 lỗi đều có từ trước, thuộc APP-14, APP-15 và dấu ngoặc kép ở `group/[id]/index.tsx`). **Chưa chạy migration 0009 trên Supabase và chưa chạy app trên máy** — cần QA kiểm thử tay theo cột "Cách kiểm".

| Mã | Trạng thái | Thay đổi | Cách kiểm | Còn lại |
| --- | --- | --- | --- | --- |
| NEW-01 | ✅ (chưa chạy DB) | Migration mới `0009_profile_visibility.sql`: hàm `can_view_profile` (SECURITY DEFINER) cho xem hồ sơ của chính mình, người chung nhóm (người xem ACTIVE/LEFT, người được xem mọi trạng thái), hai bên lời mời kết bạn; policy SELECT dùng hàm này. Giữ SEC-04 bằng quyền cột: `authenticated` chỉ SELECT được `id, display_name, user_code, avatar_path`. Hồ sơ đầy đủ của mình đọc qua RPC mới `get_my_profile` (`api/profiles.ts` `fetchProfile`). `fetchUserProfile` chỉ chọn 4 cột. `fetchGroupMembers` lấy `id` từ `user_id` và không crash khi `profiles` null | Nhóm 3 người: mở màn nhóm, thanh toán, công nợ, thêm khoản chi → thấy đủ tên. Người ngoài nhóm gọi `/rest/v1/profiles?select=searchable` → bị từ chối. Màn Tài khoản, Quyền riêng tư vẫn hiện dữ liệu của mình | Không còn đọc `searchable`, `created_at` của người khác qua bảng — hiện không màn nào dùng |
| NEW-05 | ✅ (chưa chạy DB) | Xóa view `public_profiles` trong 0009 (app không dùng) | `/rest/v1/public_profiles` trả 404 | — |
| NEW-03 | ✅ | Thêm `isActiveMember` (`api/groups.ts`). Form thêm khoản chi, sửa khoản chi chỉ cho chọn thành viên ACTIVE; màn thanh toán chỉ cho trả người ACTIVE; danh sách thành viên và ảnh đại diện trên màn nhóm chỉ hiện ACTIVE. Phần tính số dư vẫn dùng toàn bộ danh sách (giữ sửa APP-01). Xóa `fetchActiveGroupMembers` không dùng | Nhóm có 1 người đã rời: thêm khoản chi chia đều → lưu được; người đã rời không hiện trong form và trong danh sách thành viên; công nợ vẫn tính đúng | Màn sửa khoản chi cũ có phần chia của người đã rời sẽ không hiện người đó; RPC `update_expense` vốn cũng từ chối người không ACTIVE |
| NEW-04 | ✅ | `offline/sync.ts`: handler `create_payment` gọi `createPayment()` và đổi payload camelCase sang tham số `_group_id`, `_to_id`, ... | Tắt mạng → gửi thanh toán → bật mạng → thanh toán xuất hiện ở trạng thái chờ xác nhận, không trùng | — |
| APP-04 | 🟡 | Thêm `fetchMyGroupBalances` (`api/groups.ts`) đọc `official_balance` từ `group_balances` cho mọi nhóm; Home dùng hàm này (bỏ gọi Supabase trực tiếp — một phần APP-13). Query key đổi thành `['groups', 'my-balances', userId]` để 14 chỗ invalidate `['groups']` sau khi ghi cũng làm mới số dư | Có 2 nhóm, chưa mở nhóm nào: Home hiện đúng tổng cần thu / cần trả; thêm khoản chi xong quay lại Home → số đổi theo | Thẻ từng nhóm trên Home vẫn tự tính từ cache + try/catch (nuốt lỗi) |

**Việc còn lại tiếp theo:** NEW-02 (cập nhật hồ sơ — nay `.update().select()` còn bị chặn thêm bởi quyền cột, nên phải chuyển sang RPC `update_profile`), CFG-04, APP-05, BE-05, TST-01, TST-02.

## 11. Vòng sửa 3 — 22/10/2026

Sửa mọi lỗi còn 🟡/❌ ở mục 8 và mọi lỗi NEW ở mục 9. Mục 7 (chức năng chưa làm: QR, ảnh hóa đơn, đọc hóa đơn AI, Realtime, màn tạo nhóm riêng, phương thức thanh toán, thông báo "gợi ý thay đổi") là tính năng mới, không nằm trong vòng này.

**Kết quả kiểm tra**

| Kiểm tra | Kết quả |
| --- | --- |
| `jest` | 108/108 pass, 9 bộ test (thêm `suggest`, `errors`, `offline/policy`, `shared-sync`; viết lại test `explain` theo AC-02.1) |
| `tsc --noEmit` | Sạch |
| `expo lint` | 0 lỗi, 0 cảnh báo (trước: 13 lỗi, 26 cảnh báo) |
| `npm run sync:shared:check` | `supabase/functions/_shared` khớp `src/domain` |
| Test SQL (pgTAP) | 181 assertion pass trên PostgreSQL 17 dựng tạm, migration 0001–0010; `auth`, `storage`, `vault`, `pg_net` là bản giả lập. **Chưa chạy trên Supabase thật** |
| Thiết bị thật | **Chưa chạy** |

### 11.1. Thay đổi chính

| Phần | File | Nội dung |
| --- | --- | --- |
| Migration | `supabase/migrations/0010_backend_fixes.sql` | Quyền mặc định không cấp EXECUTE cho PUBLIC/anon; thu quyền hàm nội bộ; `authenticated` không ghi thẳng bảng tài chính, `profiles`, chỉ sửa `notifications.read_at`. Khóa dòng `groups` (FOR SHARE khi ghi, FOR UPDATE khi rời/xóa/đóng). Idempotency UNIQUE theo người dùng. `update_profile` mới (`_clear_avatar`). `update_expense` báo xung đột mã `PT409`. `update_group` NULL = giữ nguyên. `anonymize_account`, `rotate_invite_code`, `is_owner`. Policy Storage `receipts` mới. Trigger push dùng `net.http_post` + Vault. Xóa `create_expense` 6 tham số cũ của 0001 |
| Edge Function | `delete-account`, `send-push`, `settlements`, `_shared/`, `supabase/config.toml` | `delete-account` gọi `anonymize_account` rồi xóa người dùng Auth, lỗi bước nào cũng trả non-2xx. `send-push` so secret thời gian hằng, không cần JWT. `settlements` dùng mã dùng chung sinh từ `src/domain`, gợi ý theo số dư dự kiến |
| Test SQL | `supabase/tests/00_security_audit` … `04_push_trigger` | Viết lại bằng pgTAP, theo spec hiện tại; thêm test gọi bằng anon, chèn thẳng CONFIRMED, nhóm CLOSED, BR-11, idempotency, quyền cột hồ sơ |
| App | `src/api/errors.ts`, `src/domain/suggest.ts`, `src/hooks/use-group-settlement.ts`, `src/offline/policy.ts`, `src/components/error-state.tsx` | Phân loại lỗi theo mã `CODE:` + thông báo tiếng Việt; một hàm gợi ý tất toán cho mọi màn; hàng đợi ghi trước rồi gửi, có `user_id`, `last_attempt_at`, danh sách mục lỗi để thử lại hoặc bỏ |
| Cấu hình | `package.json`, `scripts/sync-shared-domain.js`, `.github/workflows/ci.yml` | `sync:shared`, `sync:shared:check`, `test:db`; bỏ `reset-project`; CI chạy tsc, jest, kiểm tra mã dùng chung, lint |

### 11.2. Trạng thái từng lỗi

| Trạng thái | Mã |
| --- | --- |
| ✅ Đã sửa | SEC-02, SEC-03 (so secret thời gian hằng), SEC-04, SEC-05, SEC-09, BE-03, BE-04, BE-05, BE-07, BE-08, BE-09, BE-12, BE-13, CFG-04, TST-01, CFG-05, APP-01, APP-03, APP-04, APP-05, APP-06, APP-07, APP-08, APP-09, APP-11, APP-12, APP-13, APP-14, APP-15, APP-16, APP-17, APP-18, APP-19, APP-21, DOM-01, DOM-03, DOM-04, NEW-02, NEW-06, NEW-07, NEW-08, NEW-09, NEW-10 |
| 🟡 Còn phần nhỏ | APP-02, APP-10, TST-02 (chi tiết ở 11.3) |
| Đã ✅ từ trước | Các mục ✅ ở mục 8, và NEW-01, NEW-03, NEW-04, NEW-05 ở mục 10 |

Ngoài danh sách, khi ghép hai phần đã sửa thêm: màn sửa khoản chi gửi lại `receipt_path` (RPC `update_expense` ghi đè cột này, trước đó mỗi lần sửa sẽ xóa ảnh hóa đơn); app đọc mã lỗi trong body của `delete-account` để báo đúng lý do (ví dụ đang là chủ nhóm); thêm thông báo tiếng Việt cho 12 mã lỗi mới của 0010.

### 11.3. Còn lại và việc cần làm tay

| Mục | Còn lại | Ai làm |
| --- | --- | --- |
| APP-02 | Query key chưa có user id (đã bù bằng xóa toàn bộ cache khi đăng xuất). Đăng xuất lúc mất mạng thì không xóa được push token trên server — cần backend xóa token trùng của người khác khi đăng ký token | Dev, vòng sau |
| APP-10 | `app.json` `expo.extra.eas.projectId` vẫn là `"your-project-id-here"`; app bỏ qua đăng ký push kèm cảnh báo | Người dùng: chạy `npx eas-cli@latest init` hoặc điền ID dự án EAS |
| TST-02 | Chưa kiểm thử đồng thời thật (hai kết nối); `03_concurrency.test.sql` kiểm tra khóa tĩnh và chạy lại tình huống tuần tự | Dev: dùng `dblink` với dữ liệu đã commit, hoặc script Node mở hai kết nối |
| Thanh toán | RPC xác nhận/từ chối/báo sai lệch/hủy chưa có idempotency key; app xử lý gửi lại bằng cách đọc lại trạng thái thanh toán | Dev, vòng sau |
| Triển khai | 1) `supabase db push` (0009, 0010) trước khi deploy `delete-account` mới. 2) Tạo secret Vault: `supabase_url`, `webhook_secret`. 3) `supabase secrets set WEBHOOK_SECRET=<cùng giá trị>`. 4) Deploy Edge Function từ repo (`send-push` không kiểm JWT theo `config.toml`). 5) Chạy `supabase test db` trên project thật. 6) Commit `supabase/functions/_shared/*.ts`; chạy `npm run sync:shared` mỗi khi sửa `settlement.ts`, `pairwise.ts` | Người dùng / DevOps |
| Kiểm thử tay | Tắt mạng → gửi khoản chi, thanh toán → bật mạng; đăng xuất A, đăng nhập B trên cùng máy; mở link mời khi chưa đăng nhập và khi app đang tắt; Storage `receipts` dùng cột `storage.objects.owner` — kiểm tra còn được ghi trên project | QA |

## 12. Rà soát vòng 3 và vòng sửa 4 — 22/10/2026

Rà soát độc lập toàn bộ thay đổi từ commit `8572d91` theo 3 hướng: backend (migration 0009–0010, Edge Function, test, CI), offline/đăng nhập/điều hướng/push, màn hình và logic tính tiền. Trạng thái triển khai lúc rà soát: migration 0001–0010 đã `db push` lên Supabase, Vault đã có `supabase_url` và `webhook_secret`.

**Kết quả kiểm tra sau khi sửa**

| Kiểm tra | Kết quả |
| --- | --- |
| `jest` | 126/126 pass, 9 bộ test |
| `tsc --noEmit` | Sạch |
| `expo lint --max-warnings 0` | 0 lỗi, 0 cảnh báo |
| `npm run sync:shared:check` | Khớp |
| Test SQL (pgTAP) | 226/226 pass trên PostgreSQL 17 dựng tạm (auth, storage, vault, pg_net giả lập); 0001→0011, chạy 0011 lần hai không lỗi |
| Hợp đồng app ↔ backend | Mọi RPC app gọi đều có trong migration; tham số `register_push_token`, `unregister_push_token` khớp; cột view `group_balances` khớp |
| `deno check`, CI trên GitHub, thiết bị thật | **Chưa chạy** |

### 12.1. Lỗi tìm thấy và đã sửa

| Mã | Mức | Lỗi | Sửa |
| --- | --- | --- | --- |
| REV-S1 | High | Giải thích nợ mâu thuẫn số tiền gợi ý khi có nhiều chủ nợ, thanh toán bên thứ ba, PENDING, chế độ theo cặp, cặp đã cân bằng | `explain.ts` viết lại, nhận toàn bộ danh sách chuyển; tách "Tổng = A + B"; luôn báo chênh lệch; 6 test mới |
| REV-S2 | High | Màn Lịch sử luôn lỗi: chọn cột `metadata` không tồn tại; nhãn hành động sai | `activity.ts` đọc `before`/`after`; `history.tsx` ánh xạ đúng mã hành động, mở đúng màn |
| REV-A1 | High | Sau đăng xuất, kết quả rỗng của người chưa đăng nhập được cache và hiện ở lần đăng nhập sau | Query theo người dùng chờ có phiên; xóa cache khi người dùng khác đăng nhập; key danh sách nhóm có user id |
| REV-A2 | High | Vòng đồng bộ dùng ảnh chụp cũ: thao tác của A có thể gửi dưới phiên của B | Đọc lại từng mục trước khi gửi, kiểm tra `user_id` và phiên; bộ đếm thế hệ dừng vòng khi xóa hàng đợi |
| REV-S3 | Medium | Form sửa khoản chi mất dữ liệu đang nhập khi refetch nền lỗi hoặc có bản mới | Chỉ báo lỗi khi không có dữ liệu; có bản mới thì hiện banner "Tải lại" |
| REV-S4 | Medium | `fetchGroups` trả sai vai trò, liệt kê nhóm đã rời/đã đóng cùng nhóm đang hoạt động | Lọc theo người dùng hiện tại; mục "Đã lưu trữ"; nút thêm nhanh chỉ cho nhóm ACTIVE |
| REV-S5 | Medium | Người đã rời nhóm thấy số dư cũ như số hiện tại và các nút ghi | Trạng thái chỉ đọc "Bạn đã rời nhóm"; nhóm CLOSED ẩn nút ghi |
| REV-S6 | Medium | Thiếu "Bạn đã cân bằng" (AC-01.1), "Cần thu X, trong đó Y chờ bạn xác nhận" (BA §6 ví dụ 2); số dư không lấy từ view `group_balances` (BA §7) | Lấy số dư từ view, gợi ý tính trên số dư dự kiến của view; mất mạng thì tự tính kèm nhãn "Chưa đồng bộ" |
| REV-A3 | Medium | Mục lỗi tạm thời thử lại mãi, không bỏ được | FAILED sau 8 lần hoặc 24 giờ; bỏ được cả mục đang chờ |
| REV-A4 | Medium | Máy vẫn nhận push của tài khoản trước | RPC `register_push_token` (xóa token trùng của người khác), `unregister_push_token`; lưu token trong AsyncStorage |
| REV-A5 | Medium | Chuyển hướng đăng nhập không xóa ngăn xếp màn hình | Dùng `Stack.Protected` |
| REV-A6 | Medium | Thanh đồng bộ nằm dưới thanh trạng thái hệ thống | Thêm khoảng an toàn phía trên, không cộng hai lần |
| REV-B1 | Medium | `transfer_ownership` không khóa nhóm → chuyển chủ cho người vừa rời | Khóa `groups` FOR UPDATE trước khi kiểm tra |
| REV-B2 | Medium | Bạn bè không chung nhóm không xem được phương thức thanh toán | Policy mới cho bạn bè ACCEPTED |
| REV-S7 | Low | Giao dịch gần đây, huy hiệu chờ trên Home không cập nhật | `useQueries`; huy hiệu chỉ đếm thanh toán của mình |
| REV-S8 | Low | Người nhận, số tiền mặc định ở màn thanh toán đổi ngầm khi refetch | Giữ giá trị mặc định từ lần hiện đầu tiên |
| REV-S9 | Low | Chia phần trăm 3 người phải tự nhập 33,34 | Nút "Chia đều %" |
| REV-S10 | Low | Sửa, hủy khoản chi có người đã rời luôn lỗi | Ẩn nút kèm lý do |
| REV-S11 | Low | Một số màn không làm mới sau xác nhận thanh toán, đóng nhóm | Invalidate thêm `['payment', id]`, `['group', id]` |
| REV-A7 | Low | Nâng cấp app xóa mục hàng đợi cũ chưa có `user_id` | Gán cho người dùng hiện tại |
| REV-A8 | Low | Mở app từ thông báo khi app tắt: API cũ, có thể điều hướng hai lần, mất đích khi phải đăng nhập | API SDK 58, chờ đăng nhập và navigator, lưu đích qua đăng nhập |
| REV-A9 | Low | "Thử lại" có thể chờ tới 30 giây | Chạy ngay hoặc nối sau lượt đang chạy |
| REV-A10 | Low | Lỗi đăng xuất sau khi xóa tài khoản không được báo | Bắt lỗi, hiện thông báo |
| REV-A11 | Low | Thao tác thanh toán offline thiếu `groupId` khi chưa có cache | Tải thanh toán trước khi đưa vào hàng đợi |
| REV-B3 | Low | Deadlock giữa xóa tài khoản và nhận/thu hồi lời mời; giữa `anonymize_account` và RPC ghi | Thống nhất thứ tự khóa: nhóm trước, lời mời/hồ sơ sau; hồ sơ khóa FOR NO KEY UPDATE |
| REV-B4 | Low | Xóa người dùng từ Dashboard để lại thành viên "ma" | Trigger dọn thành viên, lời mời, bạn bè, phương thức thanh toán, token; không bao giờ báo lỗi; ghi log khi không an toàn |
| REV-B5 | Low | CI không chạy test backend | Job `supabase test db` và `deno check` |
| REV-B6 | Low | `supabase/.temp/` (project-ref, pooler URL) có thể bị commit | Thêm vào `.gitignore` |
| REV-B7 | Low | Test push đếm toàn bộ hàng đợi `pg_net` → chạy chập chờn trên project thật | Lọc theo id thông báo |
| REV-B8 | Low | Push thiếu nội dung cho nhiều loại thông báo | Nội dung tiếng Việt cho 16 loại |

Migration mới: `supabase/migrations/0011_review_fixes.sql` (chạy lại được). Test mới: `supabase/tests/05_review_fixes.test.sql`.

### 12.2. Còn lại

| Mục | Việc | Ai làm |
| --- | --- | --- |
| Triển khai | `npx supabase@latest db push` (0011) → `secrets set WEBHOOK_SECRET` → `functions deploy`. App bản mới cần 0011 cho push token | Người dùng |
| APP-10 | Điền `projectId` EAS (`npx eas-cli@latest init`) | Người dùng |
| TST-02 | Chưa kiểm thử đồng thời bằng hai kết nối trong pgTAP (đã thử tay hai phiên cho REV-B3) | Dev |
| Chưa chạy | `deno check`, CI trên GitHub (job mới có thể lộ lỗi kiểu có sẵn ở Edge Function), app trên thiết bị | Dev, QA |
| Commit | Toàn bộ thay đổi từ `8572d91` chưa commit | Người dùng quyết |
