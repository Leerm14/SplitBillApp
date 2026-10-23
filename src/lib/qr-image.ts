/**
 * Lưu mã QR (react-native-qrcode-svg) thành ảnh PNG trong thư viện ảnh — để người trả dùng chính
 * điện thoại này mở app ngân hàng → Quét QR → chọn ảnh.
 * Dùng API File / Paths của expo-file-system và Asset của expo-media-library SDK 58.
 */
import * as Crypto from 'expo-crypto';
import { File, Paths } from 'expo-file-system';
import { Asset, requestPermissionsAsync } from 'expo-media-library';

/** Cạnh ảnh xuất ra (px) — đủ nét để app ngân hàng đọc từ ảnh */
const EXPORT_SIZE = 720;

/** Ref của <Svg> mà QRCode trả qua getRef */
export type QRSvgRef = {
  toDataURL: (callback: (base64: string) => void, options?: { width?: number; height?: number }) => void;
};

export type SaveQRResult = 'saved' | 'denied';

function svgToBase64(svg: QRSvgRef): Promise<string> {
  return new Promise((resolve, reject) => {
    try {
      svg.toDataURL((data) => (data ? resolve(data) : reject(new Error('Không xuất được ảnh QR'))), {
        width: EXPORT_SIZE,
        height: EXPORT_SIZE,
      });
    } catch (err) {
      reject(err);
    }
  });
}

/** Ghi PNG tạm vào cache rồi thêm vào thư viện ảnh (chỉ xin quyền ghi). File tạm xóa sau khi lưu. */
export async function saveQRToLibrary(svg: QRSvgRef): Promise<SaveQRResult> {
  const { status } = await requestPermissionsAsync(true, ['photo']);
  if (status !== 'granted') return 'denied';

  const file = new File(Paths.cache, `vietqr-${Crypto.randomUUID()}.png`);
  try {
    await file.write(await svgToBase64(svg), { encoding: 'base64' });
    await Asset.create(file.uri);
    return 'saved';
  } finally {
    try {
      if (file.exists) file.delete();
    } catch {
      // best-effort: thư mục cache, hệ điều hành tự dọn
    }
  }
}
