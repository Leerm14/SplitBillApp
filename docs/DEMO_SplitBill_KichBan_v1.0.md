# Kịch bản demo — Split Bill App

23/10/2026 · Bản APK `preview` build từ commit `6dc0c84` · Thời lượng chính: 20 phút + 5 phút hỏi đáp

## 1. Mục tiêu demo

Cho người xem thấy trong 20 phút: một nhóm 3 người đi ăn 2 bữa chỉ cần **1 lần chuyển tiền** thay vì 4, app giải thích được vì sao, và số liệu vẫn đúng khi mất mạng hay bấm hai lần.

| Thông điệp | Quy tắc / tiêu chí chứng minh | Cảnh |
| --- | --- | --- |
| Ít lần chuyển tiền nhất | BR-03, BR-04, AC-01.1 | 3 |
| Giải thích được nguồn gốc số nợ | BR-08, AC-02.1 | 4 |
| Không bị nhắc trả lại khoản đang chờ | BR-06, AC-03.1, AC-03.2 | 5 |
| Tắt bù trừ khi nhóm muốn | BR-09, AC-05.1 | 6 |
| Mất mạng không mất, không trùng dữ liệu | DEV §6, AC-04.2 | 7 |
| Dễ vào nhóm, dễ trả tiền | GRP-04, EXP-08, MVP-07 | 2, 5, 8 |

Người xem: Product Owner, BA, QA, đội phát triển.

## 2. Chuẩn bị (làm trước buổi demo ít nhất 1 ngày)

### 2.1. Thiết bị và tài khoản

| Vai | Thiết bị | Tài khoản thử | Ghi chú |
| --- | --- | --- | --- |
| **An** (A) — người trình bày chính | Điện thoại Android 1, chiếu màn hình | `demo.an@<domain thử>` | Chủ nhóm |
| **Bình** (B) | Điện thoại Android 2 | `demo.binh@<domain thử>` | Có thể do trợ lý cầm |
| **Chi** (C) | Điện thoại Android 3 (hoặc máy ảo Android Studio) | `demo.chi@<domain thử>` | Thiết bị dùng cho cảnh mất mạng |

- Chỉ dùng **tài khoản thử, tên giả**, không dùng email, số điện thoại, số tài khoản thật của ai trên màn hình chiếu.
- Mật khẩu tài khoản thử ghi trong kênh nội bộ của đội, **không** ghi vào tài liệu này.
- Cài APK `preview` mới nhất lên cả 3 máy; đăng nhập sẵn; cho phép thông báo và camera.
- Trên máy An: Cài đặt → Hiển thị → tắt khóa màn hình tự động trong lúc demo.

### 2.2. Dữ liệu dựng sẵn

| Việc | Ai làm | Để làm gì |
| --- | --- | --- |
| An, Bình, Chi kết bạn với nhau | Cả 3 | Cảnh 2, 8 |
| An đặt ảnh đại diện; Bình, Chi để trống | An | Thấy ảnh và chữ cái đầu cùng lúc |
| Chi thêm phương thức thanh toán: `Ngân hàng thử — 0000 0000 0000 — DEMO CHI` | Chi | Cảnh 5, 8 |
| An thêm phương thức thanh toán: `Ví điện tử thử — 0900 000 000 — DEMO AN` | An | Cảnh 5 |
| Chuẩn bị 1 ảnh hóa đơn mẫu **không có thông tin cá nhân** (in tên quán, món, tổng tiền) | An | Cảnh 3 |
| Nhóm dự phòng "Demo dự phòng" đã có sẵn đúng dữ liệu sau cảnh 3 | An | Dùng nếu cảnh 2–3 lỗi |

Không tạo trước nhóm chính "Ăn trưa thứ Sáu" — tạo trực tiếp trong cảnh 1.

### 2.3. Kiểm tra 30 phút trước giờ demo

- [ ] Cả 3 máy có mạng ổn định (Wi-Fi riêng của phòng, có 4G dự phòng).
- [ ] Mở app trên cả 3 máy, kéo xuống làm mới, không có thanh "Chưa đồng bộ".
- [ ] Gửi thử một thông báo (An mời Bình vào nhóm dự phòng) → Bình nhận push.
- [ ] Màn chiếu thấy rõ chữ; tăng cỡ chữ hệ thống nếu cần.
- [ ] Bản in mục 4 (bảng số liệu mong đợi) để người trình bày đối chiếu.

## 3. Kịch bản

Ký hiệu: 🅰 máy An · 🅱 máy Bình · 🅲 máy Chi · 💬 lời dẫn · ✅ kết quả phải thấy.

### Cảnh 0 — Mở đầu (1 phút)

💬 "Ba bạn An, Bình, Chi đi ăn trưa hai bữa. An trả bữa đầu 90.000đ, Bình trả bữa sau 45.000đ, Chi chưa trả bữa nào. Nếu tính theo từng hóa đơn, cả nhóm phải chuyển qua lại **4 lần**. Chúng ta xem app làm thế nào."

Chiếu bảng so sánh ở BA mục 2 (4 lần → 3 lần → 1 lần).

### Cảnh 1 — Tạo nhóm (1,5 phút)

1. 🅰 Tab **Nhóm** → **Tạo nhóm**.
2. Nhập tên `Ăn trưa thứ Sáu`, mô tả `Demo`, chọn ảnh nhóm.
3. Chỉ vào công tắc **Đơn giản hóa công nợ** đang bật sẵn.
   💬 "Mặc định bật: app sẽ bù trừ để mỗi người chuyển ít lần nhất. Cảnh 6 sẽ tắt thử."
4. Bấm tạo.

✅ Vào màn nhóm mới, có ảnh nhóm, 1 thành viên (An).

### Cảnh 2 — Mời thành viên bằng QR và từ danh sách bạn (2 phút)

1. 🅰 Màn nhóm → **Mời** → hiện **QR**.
2. 🅱 Tab Nhóm → **Quét mã** → quét QR trên máy An.
   ✅ Bình vào thẳng nhóm.
3. 🅰 Ở màn mời, chọn **Chi** trong danh sách bạn bè → **Mời**.
   ✅ 🅲 nhận thông báo "Lời mời vào nhóm"; Chi chạm → xác nhận → vào nhóm.
4. 🅰 Màn nhóm hiện 3 thành viên.

💬 "Mã QR và lời mời có hạn dùng, chủ nhóm thu hồi được bất cứ lúc nào."

**Nếu lỗi:** camera không quét được → Bình nhập mã mời in dưới QR. Push không đến → Chi mở tab Thông báo trong app.

### Cảnh 3 — Thêm hai khoản chi (3 phút)

1. 🅰 **Thêm khoản chi**:
   - Mô tả `Bữa trưa`, số tiền `90000`, người trả **An**, chia đều 3 người.
   - Đính kèm ảnh hóa đơn mẫu.
   💬 Chỉ vào phần xem trước: 30.000đ mỗi người.
2. 🅱 **Thêm khoản chi**: mô tả `Cà phê`, `45000`, người trả **Bình**, chia đều 3 người.
3. 🅲 Mở nhóm → **Tổng quan công nợ**.

✅ Chi thấy **đúng một** gợi ý: **Chuyển An 45.000đ** (AC-01.1).
✅ 🅱 Bình thấy **Bạn đã cân bằng** — không phải chuyển, không được nhận.
✅ 🅰 An thấy cần thu 45.000đ.

💬 "Bình vừa ứng tiền cà phê, vừa nợ An bữa trưa — hai khoản triệt tiêu nhau. Thay vì 4 lần chuyển, chỉ còn 1."

### Cảnh 4 — Vì sao Chi trả An mà không trả Bình? (2 phút)

1. 🅲 Chạm vào gợi ý "Chuyển An 45.000đ" → **Chi tiết công nợ**.

✅ Thấy danh sách: **30.000đ** Bữa trưa (An trả) **+ 15.000đ** Cà phê (Bình trả), kèm câu giải thích phần Bình ứng đã được **bù trừ qua An** (AC-02.1).

💬 "Người dùng hay thắc mắc 'tôi uống cà phê của Bình sao lại trả An'. App trả lời ngay trên màn hình."

2. 🅰 Mở chi tiết khoản `Bữa trưa` → chạm ảnh hóa đơn → xem lớn.
   💬 "Ảnh hóa đơn chỉ thành viên nhóm xem được."

### Cảnh 5 — Chi trả tiền, chờ xác nhận, An xác nhận (3 phút)

1. 🅲 Ở gợi ý, chỉ vào **phương thức thanh toán của An** hiện ngay bên dưới, bấm **sao chép**.
   💬 "Không cần hỏi lại số tài khoản."
2. 🅲 Bấm **Thanh toán** → người nhận An, số tiền 45.000đ đã điền sẵn → gửi.

✅ 🅲 Gợi ý chuyển biến mất, thay bằng **Đang chờ An xác nhận 45.000đ** (AC-03.1). Công nợ chính thức của Chi vẫn −45.000đ.
✅ 🅰 An nhận thông báo yêu cầu xác nhận; màn công nợ ghi cần thu 45.000đ, trong đó 45.000đ **chờ bạn xác nhận**.

3. 🅰 Mở yêu cầu → **Xác nhận**.

✅ Cả 3 máy: mọi người **đã cân bằng**; Chi nhận thông báo đã xác nhận.

💬 "Xác nhận chỉ tính một lần — bấm lại hay mạng chập chờn cũng không trừ hai lần (AC-04.2)."

**Biến thể (nếu còn thời gian, 1 phút):** trước bước 3, An bấm **Từ chối** → ✅ Chi nhận thông báo, gợi ý "Chuyển An 45.000đ" xuất hiện lại (AC-03.2). Sau đó Chi gửi lại, An xác nhận.

### Cảnh 6 — Tắt "Đơn giản hóa công nợ" (2 phút)

Cần số dư khác 0 để thấy khác biệt, nên làm trên **nhóm dự phòng** (đã có đúng 2 khoản chi của cảnh 3, chưa thanh toán).

1. 🅰 Nhóm "Demo dự phòng" → sửa nhóm → tắt **Đơn giản hóa công nợ**.
2. 🅲 Mở Tổng quan công nợ của nhóm dự phòng.

✅ Gợi ý thành **3 lần chuyển**: Chi → An 30.000đ, Chi → Bình 15.000đ, Bình → An 15.000đ (AC-05.1).

💬 "Có nhóm muốn 'ai ứng thì người đó nhận đúng phần mình'. Chỉ chủ nhóm đổi được công tắc này."

3. 🅰 Bật lại công tắc → quay về 1 lần chuyển.

### Cảnh 7 — Mất mạng (3 phút)

1. 🅲 Bật **chế độ máy bay**.
2. 🅲 Nhóm "Ăn trưa thứ Sáu" → thêm khoản chi `Trà sữa`, `60000`, người trả **Chi**, chia đều 3 người → lưu.

✅ Khoản chi hiện ngay, thanh trên cùng báo **Chưa đồng bộ**.

3. 🅲 Bấm nút lưu thêm lần nữa / thoát vào lại màn hình.
   💬 "Mỗi thao tác có một mã chống trùng tạo ngay lúc bấm."
4. 🅲 Tắt chế độ máy bay, đợi vài giây.

✅ Thanh "Chưa đồng bộ" biến mất; 🅰 🅱 nhận thông báo khoản chi mới; trong nhóm chỉ có **một** khoản `Trà sữa`.
✅ Gợi ý mới: An → Chi 20.000đ, Bình → Chi 20.000đ.

**Nếu lỗi:** sau 30 giây vẫn "Chưa đồng bộ" → chạm thanh trạng thái → **Thử lại**.

### Cảnh 8 — Home và lịch sử (1,5 phút)

1. 🅰 Tab **Home**: tổng cần thu / cần trả của mọi nhóm; giao dịch gần đây.
2. Chuyển bộ lọc **7 ngày / 30 ngày / Tháng này / Tất cả**.
   ✅ Danh sách đổi, **tổng không đổi** (BR-10: tổng là số dư hiện tại).
3. 🅰 Mở **Lịch sử** của nhóm: thấy ai tạo, xác nhận, lúc nào, bao nhiêu.

### Cảnh 9 — Kết (1 phút)

💬 Tóm lại 3 ý: ít lần chuyển nhất, giải thích được, không sai khi mất mạng. Nêu phần chưa có trong bản này (mục 6).

## 4. Số liệu mong đợi để đối chiếu

| Thời điểm | An | Bình | Chi | Gợi ý tất toán |
| --- | --- | --- | --- | --- |
| Sau cảnh 3 | +45.000đ | 0đ | −45.000đ | Chi → An 45.000đ |
| Cảnh 5, Chi đã gửi, chưa xác nhận | chính thức +45.000đ, dự kiến 0đ | 0đ | chính thức −45.000đ, dự kiến 0đ | Không có gợi ý; "Đang chờ An xác nhận 45.000đ" |
| Sau cảnh 5 (An xác nhận) | 0đ | 0đ | 0đ | Không có |
| Cảnh 6, công tắc tắt (nhóm dự phòng) | +45.000đ | 0đ | −45.000đ | Chi → An 30.000đ, Chi → Bình 15.000đ, Bình → An 15.000đ |
| Sau cảnh 7 (Trà sữa 60.000đ, Chi trả) | −20.000đ | −20.000đ | +40.000đ | An → Chi 20.000đ, Bình → Chi 20.000đ |

Tổng số dư mỗi dòng luôn bằng 0 (BR-02). Nếu màn hình ra khác bảng này: dừng cảnh đó, chuyển sang nhóm dự phòng, ghi lại để QA xem sau.

## 5. Phương án dự phòng

| Sự cố | Xử lý |
| --- | --- |
| Không có mạng cả phòng | Dùng 4G của điện thoại; cảnh 7 vẫn làm được |
| Push không đến | Mở tab Thông báo trong app (dữ liệu vẫn có, chỉ push bị chậm) |
| Camera không quét QR | Nhập mã mời in dưới QR |
| Số liệu lệch, app lỗi giữa chừng | Chuyển sang nhóm "Demo dự phòng" |
| Máy hết pin, treo | Máy Chi có thể thay bằng máy ảo Android Studio trên laptop trình chiếu |

## 6. Ngoài phạm vi bản demo

Nói rõ nếu được hỏi:

- Đọc hóa đơn bằng AI (OCR) — chưa làm, thuộc giai đoạn 8.
- Bù trừ công nợ giữa nhiều nhóm, nhiều loại tiền — ngoài MVP (BA §8).
- Cập nhật tức thì không cần kéo làm mới (Realtime) — chưa làm.
- Thông báo riêng "gợi ý của bạn đã thay đổi" — chờ Product Owner chốt (BA §8).
- Bản iOS — phạm vi hiện tại là APK Android.

## 7. Sau buổi demo

- [ ] Ghi lại câu hỏi, góp ý; câu hỏi mở chuyển cho Product Owner (BA §8, DEV MVP §5).
- [ ] Lỗi phát hiện trong demo → thêm vào [danh sách lỗi QA](QA_SplitBill_DanhSachLoi_v1.4.md).
- [ ] Xóa dữ liệu demo nếu dùng project Supabase production: rời / đóng nhóm "Ăn trưa thứ Sáu" và "Demo dự phòng" sau khi tất toán (BR-11), hoặc xóa các tài khoản thử từ màn Tài khoản → Bảo mật.
