# Kịch bản quay video demo — Split Bill App

23/10/2026 · Dữ liệu: `supabase/seed.sql` (4 tài khoản demo, 2 nhóm) · Thời lượng thành phẩm: 6–7 phút

Khác với [kịch bản demo trực tiếp](DEMO_SplitBill_KichBan_v1.0.md) (tạo dữ liệu từ đầu trước khán giả), video này **dùng dữ liệu seed có sẵn** để vào thẳng phần hay, rồi thao tác thêm vài bước "trực tiếp" trên nền đó. Mỗi cảnh quay riêng rồi ghép lại.

## 1. Chuẩn bị

### 1.1. Thiết bị và cách chạy app

| Hạng mục | Khuyến nghị |
| --- | --- |
| Thiết bị | 2 điện thoại: **Máy 1** đăng nhập An, **Máy 2** đổi giữa Bình / Dũng / Cường. Một máy cũng được nhưng phải đăng xuất – đăng nhập giữa các cảnh (cắt đi khi dựng) |
| Bản app | Ưu tiên **APK `preview`** (không có cảnh báo dev). Nếu dùng Expo Go: `npx expo start --tunnel ngrok --no-dev --minify` để tắt khung cảnh báo màu vàng/đỏ của chế độ dev |
| Ghi màn hình | iPhone: Trung tâm điều khiển → Ghi màn hình. Android: Cài đặt nhanh → Ghi màn hình (bật "hiện thao tác chạm" nếu có) |
| Trước mỗi lượt quay | Bật **Không làm phiền**, pin đầy, giờ hệ thống gọn (ví dụ 09:41), tắt thông báo app khác, tăng độ sáng |
| Thu tiếng | Lồng tiếng sau khi dựng (dễ sửa hơn nói trực tiếp); micro cài áo hoặc tai nghe có mic |
| Dựng | CapCut / DaVinci Resolve; xuất 1080p, 30 fps; phụ đề tiếng Việt |

### 1.2. Dữ liệu

1. Chạy lại toàn bộ `supabase/seed.sql` trong SQL Editor **trước mỗi lượt quay** — seed chạy lại được, đưa dữ liệu về đúng trạng thái ban đầu.
2. Tài khoản (mật khẩu ghi ở đầu `seed.sql`, không đưa lên video):

| Vai | Email | Ghi chú trong seed |
| --- | --- | --- |
| An | `demo@splitbill.test` | Chủ 2 nhóm; có phương thức thanh toán Vietcombank, MoMo (số giả) |
| Bình | `demo2@splitbill.test` | Đã trả An 200.000đ (đã xác nhận) |
| Cường | `demo3@splitbill.test` | Bạn của An |
| Dũng | `demo4@splitbill.test` | Đã gửi An 150.000đ (đang chờ xác nhận); đã gửi lời mời kết bạn cho An |

3. Chuẩn bị 1 ảnh hóa đơn quán cà phê **không có thông tin cá nhân** trong thư viện ảnh Máy 1.
4. Mọi số tài khoản, số điện thoại trong seed là số giả — giữ nguyên, không thay bằng số thật.

### 1.3. Số liệu sẽ xuất hiện (để kiểm tra khi quay)

**Nhóm "Đi Đà Lạt 🏔️"** — 3 khoản chi: Khách sạn 2.400.000đ (An trả), Lẩu bò 800.000đ (Bình trả), Thuê xe 600.000đ (Cường trả); mỗi người chịu 950.000đ.

| Thời điểm | An | Bình | Cường | Dũng | Gợi ý tất toán |
| --- | --- | --- | --- | --- | --- |
| Sau seed — chính thức | +1.250.000đ | +50.000đ | −350.000đ | −950.000đ | |
| Sau seed — dự kiến (tính khoản 150.000đ đang chờ) | +1.100.000đ | +50.000đ | −350.000đ | −800.000đ | **3 lần:** Dũng → An 800.000đ · Cường → An 300.000đ · Cường → Bình 50.000đ |
| Tắt "Đơn giản hóa công nợ" | | | | | **6 lần** (mọi cặp còn nợ nhau) |
| Sau khi An xác nhận 150.000đ của Dũng | +1.100.000đ | +50.000đ | −350.000đ | −800.000đ | Không đổi (vẫn 3 lần) |

**Nhóm "Ăn trưa Công ty 🍜"** — Bún bò 195.000đ (An trả), chia 3:

| Thời điểm | An | Bình | Cường | Gợi ý |
| --- | --- | --- | --- | --- |
| Sau seed | +130.000đ | −65.000đ | −65.000đ | Bình → An 65.000đ · Cường → An 65.000đ |
| Sau cảnh 5 (thêm "Cà phê sáng" 90.000đ, An trả) | +190.000đ | −95.000đ | −95.000đ | Bình → An 95.000đ · Cường → An 95.000đ |

**Home của An sau seed:** cần thu 1.380.000đ (1.250.000đ + 130.000đ — số dư chính thức, không bù trừ giữa hai nhóm).

Nếu số trên màn hình khác bảng này: dừng, chạy lại seed, quay lại cảnh đó.

## 2. Kịch bản phân cảnh

Ký hiệu: **M1** = Máy 1 (An), **M2** = Máy 2. Cột "Lời thoại" là lời lồng tiếng; cột "Chữ trên hình" là phụ đề / chú thích chèn khi dựng.

### Cảnh 0 — Mở đầu (0:00–0:25)

| Hình | Lời thoại | Chữ trên hình |
| --- | --- | --- |
| Màn hình tiêu đề (logo 💰 Split Bill trên nền xanh), sau đó cảnh minh họa nhóm bạn đi du lịch | "Đi chơi cùng nhau thì vui, nhưng chia tiền thì không. Bốn người, ba hóa đơn, mỗi người ứng một khoản — ai nợ ai bao nhiêu?" | **Split Bill** — Chia tiền nhóm, chuyển ít lần nhất |
| Bảng so sánh (làm trong phần mềm dựng): tính theo từng hóa đơn vs Split Bill | "Split Bill gộp mọi khoản lại, tính số dư ròng của từng người và gợi ý số lần chuyển tiền ít nhất." | Theo từng hóa đơn: nhiều lần chuyển → Split Bill: tối thiểu |

### Cảnh 1 — Đăng nhập và trang chủ (0:25–0:55)

| Thao tác | Lời thoại | Chữ trên hình |
| --- | --- | --- |
| **M1**: mở app → đăng nhập An (cắt phần gõ mật khẩu) | "An là người hay ứng tiền nhất nhóm." | |
| Home: chỉ vào ô **Cần thu 1.380.000đ**, danh sách 2 nhóm | "Trang chủ cho thấy An cần thu tổng cộng một triệu ba trăm tám mươi nghìn ở cả hai nhóm." | Tổng hợp mọi nhóm — không bù trừ chéo giữa các nhóm |
| Chạm bộ lọc **7 ngày / 30 ngày / Tất cả** ở "Giao dịch gần đây" | "Giao dịch gần đây lọc được theo thời gian." | |

### Cảnh 2 — Nhóm "Đi Đà Lạt" (0:55–1:25)

| Thao tác | Lời thoại | Chữ trên hình |
| --- | --- | --- |
| **M1**: mở nhóm **Đi Đà Lạt 🏔️**, cuộn qua ảnh thành viên và 3 khoản chi | "Chuyến Đà Lạt: An trả khách sạn 2,4 triệu, Bình trả lẩu 800 nghìn, Cường thuê xe 600 nghìn. Dũng chưa trả khoản nào." | Mỗi người chịu 950.000đ |
| Chạm khoản **Khách sạn Đà Lạt 2 đêm** → xem phần chia 4 × 600.000đ → quay lại | "Mỗi khoản chi ghi rõ ai trả, chia thế nào, mỗi người bao nhiêu." | Chia đều — tổng phần chia luôn bằng hóa đơn |

### Cảnh 3 — Gợi ý tất toán: 3 lần thay vì 6 (1:25–2:30)

| Thao tác | Lời thoại | Chữ trên hình |
| --- | --- | --- |
| **M1**: mở **Tổng quan công nợ** của nhóm Đà Lạt | "Đây là phần quan trọng nhất." | |
| Chỉ vào dòng số dư của An: cần thu, trong đó 150.000đ **chờ bạn xác nhận** | "Dũng đã chuyển trước 150 nghìn và đang chờ An xác nhận — app tách riêng khoản này, không tính hai lần." | Số dư chính thức vs dự kiến |
| Chỉ vào 3 gợi ý: Dũng → An 800.000đ, Cường → An 300.000đ, Cường → Bình 50.000đ | "Cả nhóm chỉ cần ba lần chuyển tiền là xong." | **3 lần chuyển** |
| Tắt công tắc **Đơn giản hóa công nợ** → danh sách thành 6 dòng | "Nếu tắt bù trừ — ai ứng thì người đó nhận đúng phần mình — nhóm sẽ phải chuyển sáu lần." | Tắt bù trừ: **6 lần** |
| Bật lại công tắc → về 3 dòng | "Bật lại: ba lần. Thuật toán luôn tìm số lần chuyển ít nhất có thể." | Chỉ chủ nhóm đổi được công tắc này |

### Cảnh 4 — Vì sao phải trả người này? (2:30–3:10)

| Thao tác | Lời thoại | Chữ trên hình |
| --- | --- | --- |
| **M2**: đăng nhập **Dũng** → nhóm Đà Lạt → gợi ý **Chuyển An 800.000đ** → chạm vào để xem **chi tiết công nợ** | "Dũng thắc mắc: mình ăn lẩu Bình trả, đi xe Cường thuê, sao lại chuyển hết cho An?" | |
| Cuộn phần giải thích: các khoản gốc (khách sạn, lẩu, xe), khoản 150.000đ đang chờ, phần đã bù trừ | "App giải thích từng khoản gốc và phần nào đã được bù trừ qua An. Không ai phải tin mù quáng vào con số." | Mỗi gợi ý đều giải thích được nguồn gốc |
| Chỉ vào phương thức thanh toán của An (Vietcombank, MoMo) + nút **sao chép** | "Thông tin chuyển khoản của người nhận hiện ngay đây, chạm để sao chép." | Số tài khoản giả dùng cho demo |

### Cảnh 5 — Xác nhận thanh toán (3:10–3:45)

| Thao tác | Lời thoại | Chữ trên hình |
| --- | --- | --- |
| **M1** (An): mở thông báo / thanh toán **150.000đ từ Dũng** đang chờ | "Bên An nhận được yêu cầu xác nhận." | |
| Bấm **Xác nhận** | "An kiểm tra tài khoản ngân hàng, thấy tiền về thì xác nhận. Từ lúc này khoản tiền mới được tính chính thức." | Chỉ người nhận xác nhận được — mỗi khoản chỉ tính một lần |
| Quay lại Tổng quan công nợ: dòng "chờ xác nhận" biến mất, gợi ý vẫn 3 lần | | |

### Cảnh 6 — Thêm khoản chi có ảnh hóa đơn (3:45–4:30)

| Thao tác | Lời thoại | Chữ trên hình |
| --- | --- | --- |
| **M1**: nhóm **Ăn trưa Công ty 🍜** → **Thêm khoản chi** | "Sáng hôm sau, An mời cả nhóm cà phê." | |
| Nhập "Cà phê sáng", **90000**, người trả An, chia đều 3 người → chỉ vào phần xem trước 30.000đ/người | "Nhập số tiền, chọn người cùng chịu, xem trước phần mỗi người." | Chia đều · theo % · theo số tiền |
| **Thêm ảnh hóa đơn** → chọn ảnh mẫu → **Lưu** | "Đính kèm ảnh hóa đơn làm bằng chứng — chỉ thành viên nhóm xem được." | |
| Tổng quan công nợ nhóm: Bình → An 95.000đ, Cường → An 95.000đ | "Gợi ý cập nhật ngay lập tức." | |

### Cảnh 7 — Mất mạng vẫn dùng được (4:30–5:10)

| Thao tác | Lời thoại | Chữ trên hình |
| --- | --- | --- |
| **M2**: đăng nhập **Bình** → bật **chế độ máy bay** (quay cả thao tác kéo trung tâm điều khiển) | "Bình đang ở chỗ không có sóng." | |
| Nhóm Ăn trưa → gợi ý **Chuyển An 95.000đ** → **Thanh toán** (đã điền sẵn) → gửi | "Bình vẫn ghi nhận thanh toán bình thường." | |
| Thanh trên cùng hiện **Chưa đồng bộ** | | Lưu tạm trên máy, có khóa chống trùng |
| Tắt chế độ máy bay → vài giây sau thanh biến mất; gợi ý của Bình thành **Đang chờ An xác nhận 95.000đ** | "Có mạng lại, app tự gửi đi — đúng một lần, không bao giờ trùng." | Không mất, không trùng dữ liệu |

### Cảnh 8 — Kết bạn bằng QR (5:10–5:50)

| Thao tác | Lời thoại | Chữ trên hình |
| --- | --- | --- |
| **M1**: tab **Danh bạ** → lời mời đang chờ từ **Dũng** → **Chấp nhận** | "Dũng đã gửi lời mời kết bạn — An chấp nhận." | |
| **M1**: nút **+** → màn Thêm bạn → chạm QR của An để phóng to | "Muốn kết bạn tại chỗ, chỉ cần đưa mã QR." | |
| **M2** (Bình): **Quét mã QR bạn bè** → quét QR trên M1 → hồ sơ An hiện ra (đã là bạn) | "Bên kia quét là mở ngay hồ sơ để gửi lời mời. Mã QR mời vào nhóm cũng quét bằng màn hình này." | QR kết bạn · QR mời nhóm |

Ghi chú: An và Bình đã là bạn trong seed, nên hồ sơ sẽ báo đã là bạn — đủ để minh họa. Muốn quay cảnh gửi lời mời mới thì cho **Bình quét QR của Dũng** (Bình – Dũng chưa là bạn).

### Cảnh 9 — Lịch sử và kết thúc (5:50–6:30)

| Thao tác | Lời thoại | Chữ trên hình |
| --- | --- | --- |
| **M1**: mở **Lịch sử** của nhóm Đà Lạt | "Mọi thao tác đều được ghi lại: ai làm gì, lúc nào, bao nhiêu tiền." | Nhật ký chỉ thêm, không sửa |
| Màn hình kết (logo + 3 ý chính) | "Split Bill: chuyển tiền ít lần nhất, giải thích được từng đồng, và không sai lệch kể cả khi mất mạng." | Ít lần chuyển nhất · Minh bạch · Dùng được khi mất mạng |
| Thông tin nhóm thực hiện | | Nhóm: Lê Duy Mạnh · Chu Hồng Đức · Minh Khôi |

## 3. Quay bổ sung (b-roll) và dựng

- **B-roll gợi ý:** cận cảnh tay chạm nút Xác nhận; hai điện thoại đặt cạnh nhau khi quét QR (quay bằng máy thứ ba); thao tác bật/tắt chế độ máy bay.
- **Hiệu ứng:** phóng to (zoom 120–150%) vào số tiền và dòng gợi ý khi lời thoại nhắc tới; khoanh đỏ công tắc "Đơn giản hóa công nợ".
- **Cắt bỏ:** đoạn gõ mật khẩu, màn hình tải, đăng xuất – đăng nhập giữa các tài khoản.
- **Nhạc nền:** nhạc không bản quyền, âm lượng thấp hơn lời thoại 15–20 dB.
- **Phụ đề:** đầy đủ lời thoại; định dạng tiền "1.250.000đ"; ngày theo DD/MM/YYYY.

## 4. Kiểm tra trước khi xuất bản

- [ ] Không lộ mật khẩu, email thật, số tài khoản thật, thông báo cá nhân trên thanh trạng thái.
- [ ] Mọi số tiền khớp mục 1.3.
- [ ] Không còn khung cảnh báo dev (màu vàng/đỏ) — nếu có, quay lại bằng APK hoặc `--no-dev`.
- [ ] Ghi chú cuối video: "Dữ liệu trong video là dữ liệu giả lập cho mục đích demo".
- [ ] Thời lượng 6–7 phút; bản rút gọn 60–90 giây (cảnh 0, 3, 4, 7, 9) nếu cần đăng mạng xã hội.

## 5. Khi quay gặp lỗi

| Tình huống | Xử lý |
| --- | --- |
| Số liệu khác mục 1.3 | Chạy lại `seed.sql`, quay lại từ cảnh 1 |
| Đăng nhập lỗi "Database error querying schema" | Dùng bản `seed.sql` mới nhất (đã đặt các cột token của `auth.users`), chạy lại |
| Expo Go báo "request timed out" | `npx expo start --tunnel ngrok`, chọn "Proceed anonymously" |
| Cảnh 7 không hiện "Chưa đồng bộ" | Đảm bảo bật chế độ máy bay **trước** khi bấm gửi; với Wi-Fi, tắt cả Wi-Fi |
| QR từ Expo Go không quét được giữa hai máy | Hai máy phải cùng nối một phiên `expo start`; hoặc dùng APK cho cả hai |
