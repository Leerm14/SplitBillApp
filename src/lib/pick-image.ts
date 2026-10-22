/**
 * Chọn / chụp ảnh dùng chung (ảnh đại diện, ảnh nhóm, ảnh hóa đơn) — có xử lý quyền:
 * bị từ chối hẳn (canAskAgain = false) thì đề nghị mở Cài đặt.
 */
import * as ImagePicker from 'expo-image-picker';
import * as Linking from 'expo-linking';
import { Alert, type AlertButton } from 'react-native';

export type PickSource = 'camera' | 'library';

function askOpenSettings(what: string): void {
  Alert.alert('Chưa có quyền', `Vui lòng cho phép truy cập ${what} trong Cài đặt.`, [
    { text: 'Để sau', style: 'cancel' },
    { text: 'Mở Cài đặt', onPress: () => Linking.openSettings().catch(() => {}) },
  ]);
}

/** Trả uri ảnh đã chọn, null nếu hủy / không có quyền. `square` = cắt vuông (ảnh đại diện, ảnh nhóm). */
export async function pickImage(source: PickSource, opts: { square?: boolean } = {}): Promise<string | null> {
  const perm =
    source === 'camera'
      ? await ImagePicker.requestCameraPermissionsAsync()
      : await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!perm.granted) {
    if (!perm.canAskAgain) askOpenSettings(source === 'camera' ? 'camera' : 'thư viện ảnh');
    else Alert.alert('Chưa có quyền', source === 'camera' ? 'Cần quyền camera để chụp ảnh.' : 'Cần quyền thư viện ảnh để chọn ảnh.');
    return null;
  }
  const options: ImagePicker.ImagePickerOptions = {
    mediaTypes: ['images'],
    quality: 1, // nén sau bằng compressImage (cạnh dài ≤ 1600, JPEG 0,7)
    ...(opts.square ? { allowsEditing: true, aspect: [1, 1] as [number, number] } : {}),
  };
  const result =
    source === 'camera' ? await ImagePicker.launchCameraAsync(options) : await ImagePicker.launchImageLibraryAsync(options);
  if (result.canceled || !result.assets?.[0]) return null;
  return result.assets[0].uri;
}

/** Hộp chọn: Chụp ảnh / Chọn từ thư viện / (Xóa ảnh) / Hủy. */
export function showImageActions(params: {
  title: string;
  square?: boolean;
  hasImage: boolean;
  onPicked: (uri: string) => void;
  onRemove?: () => void;
}): void {
  const run = (source: PickSource) => {
    pickImage(source, { square: params.square })
      .then((uri) => {
        if (uri) params.onPicked(uri);
      })
      .catch((e) => Alert.alert('Lỗi', (e as Error)?.message || 'Không mở được ảnh'));
  };
  const buttons: AlertButton[] = [
    { text: 'Chụp ảnh', onPress: () => run('camera') },
    { text: 'Chọn từ thư viện', onPress: () => run('library') },
  ];
  if (params.hasImage && params.onRemove) buttons.push({ text: 'Xóa ảnh', style: 'destructive', onPress: params.onRemove });
  buttons.push({ text: 'Hủy', style: 'cancel' });
  Alert.alert(params.title, undefined, buttons);
}
