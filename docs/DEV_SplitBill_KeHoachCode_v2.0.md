# Kế hoạch code bản đầy đủ — Split Bill App

21/10/2026 · Stack: React Native + Expo + Supabase · Không gắn hạn chót

Tài liệu nghiệp vụ: [BA_SplitBill_TatToanCongNo_v1.1.md](BA_SplitBill_TatToanCongNo_v1.1.md) và Đặc tả nghiệp vụ MVP v1.0. Kế hoạch này bao phủ toàn bộ 19 màn hình và các yêu cầu ACC, GRP, EXP, DEBT, PAY, NOTI, HIS, cùng chức năng đọc hóa đơn bằng AI (OCR-01 đến OCR-09, mục 10 tài liệu BA). Supabase là backend duy nhất, không dùng NestJS.

Quy ước mã: trong v1.0, mã nhóm GRP dùng cho cả màn hình (mục 3.2) lẫn yêu cầu (mục 4.2) với nghĩa khác nhau, nên tài liệu này ghi rõ "màn GRP-xx" hoặc "YC GRP-xx". Các mã khác dùng như trong v1.0.

## 1. Nguyên tắc kiến trúc

1. **Supabase là backend duy nhất:** Postgres, Auth, Row Level Security (RLS), hàm RPC, Storage, Edge Functions.
2. **Mọi thao tác ghi quan trọng đi qua RPC.** Mỗi hàm chạy trong một giao dịch và làm đủ 4 việc: kiểm tra quyền và dữ liệu, ghi dữ liệu, ghi nhật ký `activity_logs`, tạo `notifications`. App không ghi thẳng vào bảng tài chính.
3. **Số dư không lưu thành cột.** View `group_balances` tính số dư từ khoản chi và thanh toán (mục 4.5 của v1.0, BR-03).
4. **`settlement.ts` là một mã nguồn dùng chung** cho app và Edge Function (cả hai chạy TypeScript), không viết lại thuật toán.
5. **Màn hình không gọi Supabase trực tiếp.** Mọi lệnh gọi nằm trong `src/api/`. Logic tính tiền nằm trong `src/domain/`, viết bằng TypeScript thuần.
6. **Không xóa dữ liệu tài chính.** Khoản chi, thanh toán và tư cách thành viên chỉ đổi trạng thái. Nhật ký chỉ được thêm, không được sửa hay xóa.

## 2. Ánh xạ yêu cầu sang thành phần Supabase

| Nhu cầu | Thành phần | Yêu cầu liên quan |
| --- | --- | --- |
| Đăng ký, đăng nhập, quên mật khẩu | Supabase Auth (email + mật khẩu) | AUTH-01, AUTH-02, ACC-01 |
| Thu hồi phiên | `signOut({ scope: 'global' })`: đăng xuất khỏi mọi thiết bị | ACC-05 |
| Xóa tài khoản | Edge Function `delete-account`: ẩn danh hồ sơ, giữ lịch sử tài chính | ACC, chính sách cửa hàng ứng dụng |
| Phân quyền theo nhóm | RLS + hàm `is_member()`, `is_owner()` | YC GRP-04, mục 4.5 v1.0 |
| Ghi trong một giao dịch | Hàm RPC (plpgsql) | EXP-06, EXP-07, PAY-04 |
| Số dư chính thức và dự kiến | View `group_balances` (`security_invoker = true`) | DEBT-01, DEBT-02, BR-01, BR-06 |
| Gợi ý tất toán | `settlement.ts` trong app; Edge Function `settlements` để đối chiếu phía server | BR-04, BR-05 |
| Ảnh hóa đơn, ảnh đại diện | Storage: bucket `receipts` (riêng tư, theo nhóm), bucket `avatars` | EXP-08, màn GRP-03, ACC-02 |
| Mã mời và QR có hạn | Bảng `group_invites` (token, hạn, số lần dùng) | YC GRP-02, YC GRP-03 |
| Thông báo trong app | Bảng `notifications`, tạo trong RPC | NOTI-01 |
| Thông báo đẩy | Edge Function `send-push` gọi Expo Push API, kích hoạt bằng Database Webhook khi có thông báo mới | NOTI-01 |
| Nhật ký thao tác | Bảng `activity_logs`, ghi trong RPC | PAY-05, HIS-01, mục 4.5 v1.0 |
| Cập nhật tức thì (tùy chọn) | Realtime trên `expenses`, `payments` của nhóm đang mở | màn GRP-02 |
| Đọc hóa đơn bằng AI | ML Kit đọc chữ trên máy; Edge Function `parse-receipt` gọi Gemini gói miễn phí; bảng `ocr_usage` đếm lượt | OCR-01 đến OCR-09 |

## 3. Cơ sở dữ liệu

Tiền lưu `bigint` (số nguyên VND). Phần trăm lưu `integer` theo phần vạn (10000 = 100%) để tránh số thực. Mọi bảng bật RLS. Migration quản lý bằng Supabase CLI (`supabase/migrations/`), kiểu TypeScript sinh bằng `supabase gen types typescript`.

### 3.1. Bảng

| Bảng | Cột chính | Ghi chú |
| --- | --- | --- |
| `profiles` | `id`, `display_name`, `user_code`, `avatar_path`, `searchable`, `created_at`, `deleted_at` | `user_code` UNIQUE, dùng để tìm bạn; `searchable` = tùy chọn quyền riêng tư |
| `friendships` | `requester_id`, `addressee_id`, `status` (PENDING / ACCEPTED / DECLINED), `created_at`, `responded_at` | Mỗi cặp người chỉ có một dòng |
| `payment_handles` | `user_id`, `type` (BANK / EWALLET / OTHER), `display_text` | Phương thức thanh toán tham chiếu; chỉ thành viên chung nhóm xem được |
| `groups` | `id`, `name`, `description`, `avatar_path`, `owner_id`, `simplify_debts`, `status` (ACTIVE / CLOSED), `created_at` | `simplify_debts` mặc định `true` (BR-09) |
| `group_members` | `group_id`, `user_id`, `role` (OWNER / MEMBER), `status` (ACTIVE / LEFT / REMOVED), `joined_at`, `left_at` | Không xóa dòng khi rời nhóm, để giữ lịch sử |
| `group_invites` | `id`, `group_id`, `token`, `invited_user_id`, `created_by`, `expires_at`, `max_uses`, `used_count`, `revoked_at` | `invited_user_id` có giá trị khi mời đích danh một người |
| `expenses` | `id`, `group_id`, `paid_by`, `amount`, `description`, `note`, `split_method` (EQUAL / PERCENT / EXACT), `status` (ACTIVE / CANCELLED), `receipt_path`, `source` (MANUAL / OCR_AI), `version`, `created_by`, `idempotency_key`, `created_at`, `updated_at`, `cancelled_at` | `amount > 0`; `version` dùng để chặn hai người sửa cùng lúc; `source` đánh dấu khoản chi tạo từ AI (OCR-06) |
| `expense_shares` | `expense_id`, `user_id`, `amount`, `percent_bp` | Tổng `amount` = `expenses.amount` (kiểm tra trong RPC) |
| `payments` | `id`, `group_id`, `from_id`, `to_id`, `amount`, `method` (CASH / BANK / OTHER), `note`, `status` (PENDING / CONFIRMED / REJECTED / DISPUTED / CANCELLED), `reason`, `idempotency_key`, `created_at`, `decided_at` | `amount > 0`; `from_id <> to_id` |
| `notifications` | `id`, `user_id`, `type`, `group_id`, `expense_id`, `payment_id`, `read_at`, `created_at` | Có khóa trỏ tới đối tượng để mở đúng màn |
| `push_tokens` | `user_id`, `expo_token`, `platform`, `updated_at` | Một người có thể có nhiều thiết bị |
| `activity_logs` | `id`, `group_id`, `actor_id`, `action`, `entity_type`, `entity_id`, `before`, `after`, `created_at` | Chỉ thêm; `before`, `after` dạng jsonb |
| `ocr_usage` | `user_id`, `day`, `count` | Khóa chính (`user_id`, `day`); chỉ Edge Function ghi; dùng cho giới hạn lượt (OCR-08) |

`profiles` thêm cột `ocr_ai_enabled` (boolean) cho tùy chọn tắt gửi tới AI (OCR-09).

`idempotency_key` trên `expenses` và `payments` là UNIQUE.

### 3.2. View `group_balances`

Mỗi dòng là một thành viên trong một nhóm, gồm:

- `paid`, `owed`: tổng đã trả hộ và tổng phần phải chịu. Chỉ tính khoản chi ACTIVE.
- `sent_confirmed`, `received_confirmed`: thanh toán CONFIRMED đã gửi và đã nhận.
- `pending_sent`, `pending_received`: thanh toán PENDING đã gửi và đang chờ nhận.
- `official_balance` = `paid − owed + sent_confirmed − received_confirmed`.
- `projected_balance` = `official_balance + pending_sent − pending_received`.

Vì view đặt `security_invoker = true`, RLS vẫn áp dụng: người ngoài nhóm không đọc được số dư.

### 3.3. Quy tắc truy cập (RLS)

| Đối tượng | Đọc | Ghi |
| --- | --- | --- |
| Dữ liệu nhóm (`groups`, `group_members`, `expenses`, `expense_shares`, `payments`, `activity_logs`) | Thành viên nhóm, kể cả người đã rời, được xem lịch sử đến lúc rời | Chỉ qua RPC |
| Nhóm CLOSED | Thành viên được đọc | Mọi RPC ghi đều từ chối |
| `profiles` | Chính mình; người khác chỉ thấy `display_name`, `user_code`, ảnh đại diện; ẩn khỏi kết quả tìm kiếm khi `searchable = false` | Chính mình |
| `friendships` | Hai bên liên quan | Qua RPC |
| `payment_handles` | Chính mình và thành viên chung nhóm | Chính mình |
| `notifications`, `push_tokens` | Chính mình | Chính mình đánh dấu đã đọc; thông báo do RPC tạo |
| Storage `receipts` | Thành viên nhóm (đường dẫn `group_id/expense_id/...`) | Thành viên nhóm |

### 3.4. Hàm RPC

Mọi hàm kiểm tra người gọi là thành viên ACTIVE, nhóm đang ACTIVE, rồi ghi nhật ký và tạo thông báo cho người liên quan.

| Nhóm chức năng | Hàm | Kiểm tra chính |
| --- | --- | --- |
| Nhóm | `create_group`, `update_group` | Tên hợp lệ; chỉ chủ nhóm được sửa |
| Mời | `create_invite`, `revoke_invite`, `accept_invite(token)` | Token còn hạn, chưa thu hồi, chưa hết số lần dùng; mời đích danh thì đúng người (YC GRP-02, YC GRP-03) |
| Thành viên | `remove_member`, `transfer_ownership`, `leave_group` | Số dư chính thức bằng 0 và không còn thanh toán PENDING (BR-11); chủ nhóm phải chuyển quyền trước khi rời |
| Đóng nhóm | `close_group` | Mọi số dư bằng 0, không còn PENDING (YC GRP-06) |
| Khoản chi | `create_expense` | Người trả và người chịu là thành viên; tổng phần chia = tổng hóa đơn; trùng `idempotency_key` thì trả bản ghi cũ |
| | `update_expense(id, expected_version, ...)` | `version` khớp, nếu không thì báo xung đột; thay toàn bộ phần chia trong cùng giao dịch; nhật ký lưu trước và sau (EXP-06) |
| | `cancel_expense` | Người tạo hoặc chủ nhóm; đã hủy thì bỏ qua, không trừ lần hai (EXP-07) |
| Thanh toán | `create_payment` | Người gọi là `from_id`; người nhận là thành viên; trùng key thì trả bản ghi cũ |
| | `confirm_payment`, `reject_payment(reason)`, `dispute_payment(reason)` | Chỉ người nhận; chỉ khi đang PENDING (PAY-02, PAY-04, PAY-06) |
| | `cancel_payment` | Chỉ người gửi, chỉ khi đang PENDING. Bị báo sai lệch thì người gửi hủy rồi gửi lại số đúng |
| Bạn bè | `send_friend_request`, `respond_friend_request` | Không tự kết bạn với mình; không gửi trùng (ACC-04) |

### 3.5. Edge Functions

| Hàm | Kích hoạt | Việc làm |
| --- | --- | --- |
| `send-push` | Database Webhook khi thêm `notifications` | Lấy `push_tokens` của người nhận, gọi Expo Push API, xóa token đã hết hiệu lực |
| `settlements` | App gọi khi cần đối chiếu | Đọc `group_balances`, chạy `settlement.ts`, trả gợi ý. Dùng cho kiểm thử và khi cần kết quả phía server |
| `delete-account` | Người dùng yêu cầu từ màn Tài khoản | Chặn nếu còn số dư khác 0 ở bất kỳ nhóm nào; ẩn danh hồ sơ, xóa token và ảnh đại diện, xóa tài khoản Auth |
| `parse-receipt` | App gửi chữ đã che từ màn quét hóa đơn | Kiểm tra đăng nhập và lượt trong `ocr_usage`; gọi Gemini (model Flash có trong gói miễn phí) với khuôn JSON cố định; kiểm tra kết quả hợp lệ rồi trả về. Khóa API lưu trong secret của Edge Function. Hết lượt hoặc Gemini báo lỗi 429 thì trả mã lỗi để app chuyển sang đọc bằng quy tắc |

## 4. Logic trong app (`src/domain`)

| Module | Nội dung | Kiểm thử |
| --- | --- | --- |
| `settlement.ts` | `computeBalances`, `simplifyDebts` (đã có, đã kiểm thử) | Đã có: ví dụ A, B, C; ví dụ 2 và 3 của tài liệu BA; 3.000 ca ngẫu nhiên |
| `pairwise.ts` | Chế độ tắt bù trừ (BR-09): nợ ròng giữa từng cặp = phần người này chịu trong khoản người kia trả, trừ chiều ngược lại, trừ thanh toán đã xác nhận giữa hai người | Ví dụ AC-05.1: C→A 30.000đ, C→B 15.000đ, B→A 15.000đ |
| `split.ts` | Chia đều; theo phần trăm (phần vạn); theo số tiền. Phần dư sau làm tròn cộng từng 1đ theo `user_id` tăng dần | Tổng phần chia luôn bằng tổng hóa đơn với mọi số tiền và số người |
| `explain.ts` | Giải thích nguồn gốc gợi ý (BR-08): liệt kê phần của người dùng trong từng khoản chi và phần đã bù trừ | So với câu mẫu của AC-02.1 |
| `money.ts` | Định dạng `45.000đ`, đọc số tiền người dùng nhập | Kiểm tra trên Android và iOS thật |
| `receipt.ts` | Che thông tin cá nhân trong chữ đọc được (BR-15); tìm tổng tiền bằng quy tắc (OCR-07); chia theo món và phân bổ phí, thuế, giảm giá (BR-14); kiểm tra lệch tổng (BR-13) | Ví dụ mục 10.4 tài liệu BA: A 66.501đ, B 56.000đ, C 3.499đ; mẫu chữ có số điện thoại, email, số thẻ đều bị che |

## 5. Cấu trúc app

```
splitbill/
  app/                                   # Expo Router
    _layout.tsx                          # provider, kiểm tra phiên, deep link
    (auth)/sign-in.tsx                   # AUTH-02
    (auth)/sign-up.tsx                   # AUTH-01
    (auth)/forgot-password.tsx
    (tabs)/index.tsx                     # HOME-01
    (tabs)/groups.tsx                    # GRP-01
    (tabs)/contacts.tsx                  # CON-01
    (tabs)/account.tsx                   # ACC-01
    group/new.tsx                        # GRP-03 (tạo)
    group/[id]/index.tsx                 # GRP-02
    group/[id]/edit.tsx                  # GRP-03 (sửa)
    group/[id]/members.tsx               # vai trò, xóa thành viên, chuyển chủ nhóm
    group/[id]/invite.tsx                # GRP-04: mã mời, QR
    join/[token].tsx                     # mở từ QR hoặc liên kết mời
    group/[id]/expense/new.tsx           # EXP-01 → EXP-02 (hai bước)
    group/[id]/expense/scan.tsx          # OCR-01, OCR-02: chụp và đọc hóa đơn
    group/[id]/expense/assign-items.tsx  # OCR-03, OCR-04: gán món cho thành viên
    group/[id]/expense/[expenseId].tsx   # EXP-03
    group/[id]/expense/[expenseId]/edit.tsx
    group/[id]/debts.tsx                 # DEBT-01
    group/[id]/debts/[userId].tsx        # DEBT-02
    group/[id]/pay.tsx                   # PAY-01
    payment/[id].tsx                     # PAY-02
    contacts/add.tsx                     # CON-02: QR, mã người dùng
    user/[id].tsx                        # hồ sơ công khai
    notifications.tsx                    # NOTI-01
    history.tsx                          # HIS-01
    account/profile.tsx
    account/privacy.tsx
    account/payment-methods.tsx
    account/security.tsx                 # đổi mật khẩu, đăng xuất mọi thiết bị, xóa tài khoản
  src/
    lib/                                 # supabase client, query client
    domain/                              # mục 4
    api/                                 # mỗi đối tượng một file, chỉ nơi này gọi Supabase
    hooks/                               # TanStack Query theo từng màn
    offline/                             # hàng đợi ghi khi mất mạng
    components/
  supabase/
    migrations/
    functions/send-push/, settlements/, delete-account/, parse-receipt/
    tests/                               # kiểm thử RLS và RPC
```

**Đối chiếu với dự án `SplitBillApp` hiện có:**

- Dự án để route trong `src/app/` thay vì `app/`. Giữ nguyên cách này; các đường dẫn ở trên tương ứng với `src/app/...`.
- Đã có: đăng nhập, đăng ký, 3 tab (Home, Groups, Account), chi tiết nhóm, thêm khoản chi, thanh toán; `src/api/` (groups, expenses, payments); `src/domain/` (settlement, split, money); `src/lib/supabase.ts`; `supabase/migrations/0001_init.sql`.
- Chưa có: Jest và `settlement.test.ts` trong `src/domain/`. Làm ở giai đoạn 0.
- Phần còn lại là thêm mới, hoặc mở rộng migration bằng các file `0002_...sql` trở đi. Không sửa lại `0001_init.sql` nếu đã chạy trên Supabase.

**Thư viện chính:** `@supabase/supabase-js`, `@tanstack/react-query` (kèm persister để xem dữ liệu khi mất mạng), `expo-sqlite` (hàng đợi ghi), `expo-camera` (quét QR), `react-native-qrcode-svg` (tạo QR), `expo-image-picker`, `expo-notifications`, `expo-linking`, `@infinitered/react-native-mlkit-text-recognition` (đọc chữ trên máy bằng ML Kit; cần development build, không chạy trên Expo Go; kiểm tra tương thích với Expo SDK của dự án trước khi cài).

## 6. Mất mạng và thao tác lặp

1. App sinh `idempotency_key` ngay lúc người dùng bấm lưu hoặc gửi, trước khi gọi mạng.
2. Thao tác ghi vào hàng đợi trong `expo-sqlite` với trạng thái "Chưa đồng bộ" và hiện ngay trên màn hình.
3. Hàng đợi gửi lại khi có mạng, chờ lâu dần giữa các lần thử. Mỗi lần gửi lại dùng đúng key cũ, nên server trả bản ghi đã có thay vì tạo bản mới.
4. Khi server xác nhận, mục đó đổi thành "Đã lưu". Lỗi nghiệp vụ (ví dụ phần chia sai) thì báo người dùng sửa, không thử lại tự động.
5. Dữ liệu đọc được lưu cache để xem khi mất mạng, kèm thời điểm đồng bộ gần nhất.
6. Sửa khoản chi bị lệch `version` thì app tải bản mới nhất và yêu cầu người dùng sửa lại.

## 7. Giai đoạn triển khai

Thứ tự theo mục 8 của đặc tả v1.0: chốt quy tắc và dữ liệu trước, chức năng phụ trợ (QR, thông báo, Contacts) sau. Giai đoạn sau chỉ bắt đầu khi tiêu chí "xong khi" của giai đoạn trước đạt.

### Giai đoạn 0 — Nền tảng

- [ ] Dùng app Expo hiện có (`SplitBillApp`); tách hai project Supabase: dev và production.
- [ ] Supabase CLI: migration trong repo, sinh kiểu TypeScript, chạy Supabase trên máy để kiểm thử.
- [ ] Jest cho `src/domain`; chép `settlement.ts` và bộ kiểm thử vào.
- [ ] ESLint, Prettier; CI chạy kiểm thử khi đẩy code.
- [ ] `.env` cho URL và anon key; không commit khóa bí mật.

**Xong khi:** app chạy trên Expo Go, kiểm thử `settlement` qua trên CI.

### Giai đoạn 1 — Tài khoản

- [ ] Đăng ký, đăng nhập, quên mật khẩu, xử lý lỗi (AUTH-01, AUTH-02).
- [ ] Hồ sơ: tên, ảnh đại diện, `user_code` sinh tự động (ACC-02).
- [ ] Đổi mật khẩu, đăng xuất, đăng xuất khỏi mọi thiết bị (ACC-05).
- [ ] Xóa tài khoản qua `delete-account`.

**Xong khi:** đăng ký, đăng nhập, đăng xuất trên hai thiết bị; xóa tài khoản không làm mất lịch sử nhóm.

### Giai đoạn 2 — Nhóm và thành viên

- [ ] Danh sách, tìm kiếm, tạo, sửa nhóm (màn GRP-01, GRP-03; YC GRP-01).
- [ ] Mã mời, liên kết mời, QR có hạn; mời đích danh (màn GRP-04; YC GRP-02, YC GRP-03).
- [ ] Màn thành viên: vai trò, xóa thành viên, chuyển chủ nhóm (YC GRP-04).
- [ ] Kiểm thử RLS: người ngoài nhóm không đọc được, mã hết hạn bị từ chối.

**Xong khi:** người được mời vào đúng nhóm, đúng vai trò; người ngoài không xem được dữ liệu.

### Giai đoạn 3 — Khoản chi

- [ ] Thêm khoản chi hai bước: thông tin → cách chia (EXP-01, EXP-02).
- [ ] Ba cách chia: đều, phần trăm, số tiền; xem trước và báo lỗi khi tổng lệch (EXP-02 đến EXP-05).
- [ ] Chi tiết khoản chi: phần chia, lịch sử thay đổi, trạng thái (EXP-03).
- [ ] Sửa với kiểm tra `version`; hủy khoản chi (EXP-06, EXP-07).
- [ ] Ảnh hóa đơn và ghi chú (EXP-08).

**Xong khi:** tổng phần chia luôn bằng tổng hóa đơn ở cả ba cách; sửa, hủy không làm công nợ bị trừ hoặc cộng hai lần.

### Giai đoạn 4 — Công nợ và thanh toán

- [ ] View `group_balances`; màn Tổng quan công nợ với gợi ý tất toán và dòng "Đang chờ X xác nhận" (DEBT-01, BR-06).
- [ ] Chi tiết công nợ với phần giải thích nguồn gốc (DEBT-02, BR-08).
- [ ] Ghi nhận thanh toán: mở từ gợi ý thì điền sẵn, cho sửa, cảnh báo khi vượt mức (PAY-01, BR-07).
- [ ] Xác nhận, từ chối, báo sai lệch, hủy khi đang chờ (PAY-02, PAY-06).
- [ ] Thanh toán một phần; chống xác nhận hai lần (PAY-03, PAY-04).
- [ ] Công tắc "Đơn giản hóa công nợ" và chế độ theo cặp (BR-09, `pairwise.ts`).
- [ ] Rời nhóm, xóa thành viên, đóng nhóm theo điều kiện BR-11 (YC GRP-05, YC GRP-06).
- [ ] Edge Function `settlements`; kiểm thử kết quả app và server giống nhau.

**Xong khi:** đủ AC-01 đến AC-06 của tài liệu BA; ví dụ 1, 2, 3 ở mục 6 cho đúng kết quả.

### Giai đoạn 5 — Home và lịch sử

- [ ] Home: số dư theo dõi, tổng cần trả và cần thu, giao dịch gần đây, nhóm gần đây, nút thêm khoản chi, lọc theo thời gian (HOME-01, BR-10).
- [ ] Lịch sử hoạt động từ `activity_logs`: ai làm gì, lúc nào, số tiền, trạng thái (HIS-01, PAY-05).

**Xong khi:** số trên Home khớp tổng các nhóm; mỗi thao tác nhạy cảm đều có trong lịch sử.

### Giai đoạn 6 — Thông báo

- [ ] Tạo thông báo trong mọi RPC liên quan: khoản chi mới, sửa, hủy; yêu cầu thanh toán; xác nhận, từ chối; lời mời; gợi ý thay đổi.
- [ ] Màn danh sách thông báo, đánh dấu đã đọc (NOTI-01).
- [ ] Đăng ký `push_tokens`; Edge Function `send-push` + Database Webhook.
- [ ] Bấm thông báo mở đúng khoản chi, nhóm hoặc yêu cầu thanh toán (deep link qua Expo Router).

**Xong khi:** mọi loại thông báo đến đúng người và mở đúng màn, cả khi app đang tắt.

### Giai đoạn 7 — Contacts

- [ ] Tìm bạn theo tên hoặc `user_code`, tôn trọng `searchable` (ACC-03).
- [ ] Gửi, chấp nhận, từ chối lời mời kết bạn (ACC-04).
- [ ] QR kết bạn, hồ sơ công khai (CON-02).
- [ ] Mời bạn bè vào nhóm từ danh sách bạn.
- [ ] Tùy chọn quyền riêng tư; phương thức thanh toán tham chiếu hiển thị trong gợi ý tất toán.

**Xong khi:** tìm kiếm chỉ trả về thông tin được phép hiển thị.

### Giai đoạn 8 — Đọc hóa đơn bằng AI

- [ ] Thử nghiệm trước: chụp 10–20 hóa đơn tiếng Việt thật, đọc bằng ML Kit trên máy và ghi lại tỷ lệ đọc đúng tổng tiền, tên món, dấu tiếng Việt.
- [ ] Cài thư viện ML Kit, chuyển sang development build (`eas build --profile development`).
- [ ] `src/domain/receipt.ts` + kiểm thử: che thông tin cá nhân, tìm tổng tiền bằng quy tắc, chia theo món, phân bổ phí.
- [ ] Migration: cột `expenses.source`, `profiles.ocr_ai_enabled`, bảng `ocr_usage`.
- [ ] Edge Function `parse-receipt`: kiểm tra lượt, gọi Gemini với khuôn JSON, xử lý lỗi 429 và kết quả sai khuôn.
- [ ] Màn quét hóa đơn: chụp hoặc chọn ảnh, hiện dòng "Hóa đơn được đọc bằng AI, hãy kiểm tra lại trước khi lưu", điền sẵn form (OCR-01, OCR-02, OCR-05).
- [ ] Màn gán món: gán mỗi món cho một hoặc nhiều người, xem trước phần của từng người, cảnh báo lệch tổng (OCR-03, OCR-04, BR-13).
- [ ] Lưu khoản chi qua `create_expense` với `split_method = EXACT`, `source = OCR_AI`; ảnh lưu vào bucket `receipts`.
- [ ] Tùy chọn tắt gửi tới AI trong màn quyền riêng tư (OCR-09).

**Xong khi:** ví dụ mục 10.4 tài liệu BA cho đúng kết quả; tắt mạng hoặc hết lượt vẫn điền được tổng tiền; không có ảnh hay thông tin cá nhân nào được gửi tới Gemini (kiểm tra nội dung request trong log Edge Function).

### Giai đoạn 9 — Mất mạng và thao tác lặp

- [ ] Hàng đợi ghi `src/offline/` theo mục 6.
- [ ] Cache đọc dữ liệu, nhãn "Chưa đồng bộ" và "Đồng bộ lúc ...".
- [ ] Kiểm thử tắt mạng giữa chừng, bấm nhiều lần, gửi lại sau khi mở app.

**Xong khi:** tắt mạng rồi bật lại không tạo khoản chi hoặc thanh toán trùng.

### Giai đoạn 10 — Kiểm thử và bảo mật

- [ ] Kiểm thử RLS trong `supabase/tests/`: đăng nhập bằng từng vai trò (thành viên, người ngoài, người đã rời) và thử đọc, ghi.
- [ ] Kiểm thử đồng thời: hai người sửa cùng khoản chi, hai lần xác nhận cùng thanh toán.
- [ ] Chạy đủ 7 mục kiểm thử ở mục 7 của đặc tả v1.0 (mục 8 dưới đây).
- [ ] Rà soát: không có service role key trong app, không ghi thông tin cá nhân vào log.

**Xong khi:** cả 7 mục đạt, không còn lỗi nghiêm trọng.

### Giai đoạn 11 — Tạo file APK

- [ ] Điền `android.package` (ví dụ `com.<tên>.splitbill`), tên app, icon và màn hình chờ trong `app.json`.
- [ ] Khai báo URL và anon key của Supabase production làm biến môi trường của EAS cho bản build. Không đưa service role key vào app.
- [ ] Bật `autoIncrement` trong profile `preview` để EAS tự tăng mã phiên bản (`eas.json` đang dùng `appVersionSource: remote`).
- [ ] Build: `npx eas-cli@latest build -p android --profile preview`. Profile `preview` trong `eas.json` đã đặt `buildType: apk`.
- [ ] Tải APK từ trang build của EAS, cài lên điện thoại Android (cho phép cài ứng dụng từ nguồn ngoài).
- [ ] Chạy lại 7 kịch bản ở mục 8 trên bản APK.

**Xong khi:** file APK cài và chạy được trên điện thoại Android thật, kết nối được Supabase production.

## 8. Kiểm thử theo tiêu chí hoàn thành MVP

| # | Mục 7 của đặc tả v1.0 | Cách kiểm thử |
| --- | --- | --- |
| 1 | Tạo nhóm và mời thành viên | Kiểm thử RPC mời và tham gia; thủ công với 3 tài khoản |
| 2 | Chia hóa đơn theo cả 3 phương thức | Jest `split.ts` với số tiền lẻ và nhiều số người; kiểm thử RPC từ chối khi tổng lệch |
| 3 | Tính công nợ sau nhiều khoản chi | Jest `settlement.ts`; so view `group_balances` với kết quả tính trong app |
| 4 | Thanh toán một phần và xác nhận | Kiểm thử RPC: chỉ CONFIRMED làm giảm công nợ |
| 5 | Sửa hoặc hủy khoản chi | Kiểm thử RPC: hủy hai lần, sửa lệch `version` |
| 6 | Phân quyền và bảo vệ dữ liệu | Kiểm thử RLS trong `supabase/tests/` |
| 7 | Mất mạng và thao tác lặp | Gửi cùng `idempotency_key` nhiều lần; thủ công tắt mạng trên máy thật |

## 9. Câu hỏi mở cần chốt trước khi code

- [ ] Bật sẵn "Đơn giản hóa công nợ" cho mọi nhóm mới? BA đề xuất: có.
- [ ] Ai được bật, tắt công tắc: chỉ chủ nhóm hay mọi thành viên?
- [ ] Thanh toán vượt mức gợi ý: chỉ cảnh báo hay chặn?
- [ ] Gửi thông báo mỗi lần gợi ý thay đổi, hay chỉ khi số tiền phải trả tăng?
- [x] Nền tảng phát hành: file APK Android (đã chốt).
- [ ] Chủ nhóm xóa thành viên còn số dư khác 0: chặn hẳn (đề xuất hiện tại) hay cho phép kèm cảnh báo?
- [ ] Đọc hóa đơn bằng AI: số lượt mỗi ngày, mặc định bật hay tắt gửi tới AI, phương án khi gói miễn phí thay đổi (mục 10.6 tài liệu BA).
