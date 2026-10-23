# SplitBill 💰

Ứng dụng chia tiền nhóm được xây dựng bằng [Expo](https://expo.dev) + React Native, sử dụng [Supabase](https://supabase.com) làm backend và [Cloudinary](https://cloudinary.com) để lưu trữ ảnh.

## Yêu cầu hệ thống

- **Node.js** >= 18
- **npm** (đi kèm Node.js)
- **Expo Go** trên điện thoại ([Android](https://play.google.com/store/apps/details?id=host.exp.exponent) / [iOS](https://apps.apple.com/app/expo-go/id982107779)) — để test nhanh
- (Tùy chọn) Android Emulator hoặc iOS Simulator — để chạy development build

## Bắt đầu

### 1. Clone dự án

```bash
git clone <repo-url>
cd SplitBillApp
```

### 2. Cài đặt dependencies

```bash
npm install
```

### 3. Cấu hình biến môi trường

Tạo file `.env` trong thư mục `SplitBillApp` (file này không được commit lên Git):

```env
EXPO_PUBLIC_SUPABASE_URL=<supabase_url>
EXPO_PUBLIC_SUPABASE_ANON_KEY=<supabase_anon_key>
EXPO_PUBLIC_CLOUDINARY_CLOUD_NAME=<cloudinary_cloud_name>
```

> **Lưu ý:** Liên hệ team để lấy giá trị các biến môi trường.

### 4. Chạy ứng dụng

```bash
npx expo start
```

Sau khi chạy, terminal sẽ hiện QR code và các tùy chọn:

| Phím | Hành động                |
| ---- | ------------------------ |
| `a`  | Mở trên Android Emulator |
| `i`  | Mở trên iOS Simulator    |
| `w`  | Mở trên trình duyệt web  |

Hoặc mở app **Expo Go** trên điện thoại → quét QR code để chạy trực tiếp.

## Chạy trên thiết bị thật (Development Build)

Nếu cần sử dụng đầy đủ native module (camera, notifications, ...), bạn cần tạo development build:

```bash
# Android
npx expo run:android

# iOS (yêu cầu macOS + Xcode)
npx expo run:ios
```

## Chạy bằng Android Studio

Nếu muốn mở project trực tiếp bằng Android Studio thay vì dùng VS Code, cần thực hiện **2 bước đồng thời**:

### Bước 1: Chạy Metro bundler

Mở terminal (CMD, PowerShell, hoặc terminal trong Android Studio), chạy:

```bash
cd SplitBillApp
npx expo start
```

> **Quan trọng:** Metro bundler phải chạy nền trong suốt quá trình phát triển. Đây là server serve code JavaScript cho app — không thể bỏ qua.

### Bước 2: Mở và chạy project trong Android Studio

1. Mở **Android Studio**
2. Chọn **File → Open** → trỏ đến thư mục `SplitBillApp/android`
3. Đợi **Gradle sync** hoàn tất
4. Chọn emulator hoặc kết nối thiết bị thật
5. Nhấn **▶ Run** để build và cài app

> **Lưu ý:** React Native / Expo không giống app Android thuần. Code chính viết bằng TypeScript/JavaScript, Android Studio chỉ build phần native shell. Cả Metro bundler và Android Studio phải chạy đồng thời để app hoạt động.

## Các lệnh hữu ích

| Lệnh                    | Mô tả                               |
| ----------------------- | ----------------------------------- |
| `npm start`             | Khởi chạy Expo dev server           |
| `npm run android`       | Build và chạy trên Android          |
| `npm run ios`           | Build và chạy trên iOS              |
| `npm run web`           | Chạy trên trình duyệt               |
| `npm test`              | Chạy unit test                      |
| `npm run test:watch`    | Chạy unit test ở chế độ watch       |
| `npm run test:coverage` | Chạy unit test với báo cáo coverage |
| `npm run lint`          | Kiểm tra lỗi code với ESLint        |
| `npm run test:db`       | Chạy test database (Supabase)       |

## Cấu trúc dự án

```
SplitBillApp/
├── src/                # Mã nguồn chính
│   └── app/            # Các màn hình (file-based routing)
├── assets/             # Hình ảnh, font, ...
├── supabase/           # Supabase migrations & edge functions
├── scripts/            # Scripts hỗ trợ
├── android/            # Native Android project
├── app.json            # Cấu hình Expo
├── tsconfig.json       # Cấu hình TypeScript
└── package.json        # Dependencies & scripts
```

## Tài liệu tham khảo

- [Expo Documentation](https://docs.expo.dev/)
- [Supabase Documentation](https://supabase.com/docs)
- [React Native Documentation](https://reactnative.dev/docs/getting-started)

## Cấu trúc dự án

```
SplitBillApp/
├── src/                # Mã nguồn chính
│   └── app/            # Các màn hình (file-based routing)
├── assets/             # Hình ảnh, font, ...
├── supabase/           # Supabase migrations & edge functions
├── scripts/            # Scripts hỗ trợ
├── android/            # Native Android project
├── app.json            # Cấu hình Expo
├── tsconfig.json       # Cấu hình TypeScript
└── package.json        # Dependencies & scripts
```

## Tài liệu tham khảo

- [Expo Documentation](https://docs.expo.dev/)
- [Supabase Documentation](https://supabase.com/docs)
- [React Native Documentation](https://reactnative.dev/docs/getting-started)
