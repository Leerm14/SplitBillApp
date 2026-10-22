import { CameraView, useCameraPermissions, type BarcodeScanningResult } from 'expo-camera';
import * as Linking from 'expo-linking';
import { useRouter } from 'expo-router';
import React, { useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { parseScannedAppLink } from '@/lib/app-link-url';
import { appLinkToRoute } from '@/lib/app-links';

/**
 * MVP-04 / MVP-05 / M6: Màn quét QR dùng chung (mời nhóm, mã nhóm, kết bạn).
 * Chỉ nhận liên kết do app tạo (Linking.createURL, scheme `splitbill`; khi dev cả dạng exp:// của
 * createURL) với đúng ba đường dẫn join/<token>, join-code/<code>, add-friend/<code>;
 * điều hướng nội bộ, không bao giờ mở trình duyệt.
 */
export default function ScanScreen() {
  const router = useRouter();
  const [permission, requestPermission] = useCameraPermissions();
  const [scanned, setScanned] = useState(false);
  // Camera gọi onBarcodeScanned liên tục — khóa đồng bộ để chỉ xử lý một mã mỗi lần
  const lockRef = useRef(false);

  const unlockLater = (ms: number) => {
    setTimeout(() => {
      lockRef.current = false;
      setScanned(false);
    }, ms);
  };

  const handleBarCodeScanned = ({ data }: BarcodeScanningResult) => {
    if (lockRef.current) return;
    lockRef.current = true;
    setScanned(true);

    const link = parseScannedAppLink(data);
    if (!link) {
      Alert.alert('Mã QR không hợp lệ', 'Mã QR không phải của Split Bill', [
        { text: 'Quét lại', onPress: () => unlockLater(300) },
      ]);
      return;
    }
    router.replace(appLinkToRoute(link) as any);
  };

  // Loading permission state
  if (!permission) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.center}>
          <ActivityIndicator size="large" color="#007AFF" />
          <Text style={styles.loadingText}>Đang kiểm tra quyền camera...</Text>
        </View>
      </SafeAreaView>
    );
  }

  // Permission not granted - show request UI
  if (!permission.granted) {
    // L6: bị từ chối hẳn (không hỏi lại được) → chỉ có thể bật trong Cài đặt
    const blocked = !permission.canAskAgain;
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.center}>
          <Text style={styles.permissionIcon}>📷</Text>
          <Text style={styles.permissionTitle}>Cần quyền truy cập Camera</Text>
          <Text style={styles.permissionDesc}>
            {blocked
              ? 'Bạn đã tắt quyền camera cho Split Bill. Hãy bật lại trong Cài đặt để quét mã QR.'
              : 'Ứng dụng cần quyền truy cập camera để quét mã QR mời nhóm và thêm bạn bè.'}
          </Text>
          {blocked ? (
            <Pressable style={styles.grantBtn} onPress={() => Linking.openSettings().catch(() => {})}>
              <Text style={styles.grantBtnText}>Mở Cài đặt</Text>
            </Pressable>
          ) : (
            <Pressable style={styles.grantBtn} onPress={requestPermission}>
              <Text style={styles.grantBtnText}>Cho phép truy cập Camera</Text>
            </Pressable>
          )}
          <Pressable style={styles.backBtn} onPress={() => router.back()}>
            <Text style={styles.backBtnText}>Quay lại</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <View style={styles.cameraContainer}>
      <CameraView
        style={StyleSheet.absoluteFill}
        barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
        onBarcodeScanned={scanned ? undefined : handleBarCodeScanned}
      />

      {/* Overlay */}
      <SafeAreaView style={styles.overlay}>
        {/* Top bar */}
        <View style={styles.topBar}>
          <Pressable style={styles.closeBtn} onPress={() => router.back()}>
            <Text style={styles.closeBtnText}>✕</Text>
          </Pressable>
          <Text style={styles.topTitle}>Quét mã QR</Text>
          <View style={styles.closeBtn} />
        </View>

        {/* Scan area frame */}
        <View style={styles.scanAreaWrapper}>
          <View style={styles.scanFrame}>
            {/* Corner decorations */}
            <View style={[styles.corner, styles.cornerTopLeft]} />
            <View style={[styles.corner, styles.cornerTopRight]} />
            <View style={[styles.corner, styles.cornerBottomLeft]} />
            <View style={[styles.corner, styles.cornerBottomRight]} />
          </View>
        </View>

        {/* Bottom hint */}
        <View style={styles.bottomHint}>
          <Text style={styles.hintText}>
            Đưa camera vào mã QR của Split Bill
          </Text>
          {scanned && (
            <View style={styles.processingRow}>
              <ActivityIndicator size="small" color="#fff" />
              <Text style={styles.processingText}>Đang xử lý...</Text>
            </View>
          )}
        </View>
      </SafeAreaView>
    </View>
  );
}

const SCAN_SIZE = 250;

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f2f2f7' },
  cameraContainer: { flex: 1, backgroundColor: '#000' },
  center: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 32,
    gap: 16,
  },
  loadingText: { fontSize: 15, color: '#8E8E93', marginTop: 8 },

  // Permission UI
  permissionIcon: { fontSize: 48, marginBottom: 8 },
  permissionTitle: { fontSize: 20, fontWeight: '700', color: '#1a1a1a', textAlign: 'center' },
  permissionDesc: { fontSize: 15, color: '#8E8E93', textAlign: 'center', lineHeight: 22 },
  grantBtn: {
    backgroundColor: '#007AFF',
    borderRadius: 12,
    paddingHorizontal: 24,
    paddingVertical: 14,
    marginTop: 8,
  },
  grantBtnText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  backBtn: { marginTop: 4 },
  backBtnText: { color: '#007AFF', fontSize: 15 },

  // Overlay
  overlay: {
    ...StyleSheet.absoluteFill,
    justifyContent: 'space-between',
  },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  closeBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  closeBtnText: { color: '#fff', fontSize: 20, fontWeight: '600' },
  topTitle: { color: '#fff', fontSize: 17, fontWeight: '600' },

  // Scan area
  scanAreaWrapper: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  scanFrame: {
    width: SCAN_SIZE,
    height: SCAN_SIZE,
    position: 'relative',
  },
  corner: {
    position: 'absolute',
    width: 30,
    height: 30,
    borderColor: '#007AFF',
  },
  cornerTopLeft: {
    top: 0,
    left: 0,
    borderTopWidth: 4,
    borderLeftWidth: 4,
    borderTopLeftRadius: 8,
  },
  cornerTopRight: {
    top: 0,
    right: 0,
    borderTopWidth: 4,
    borderRightWidth: 4,
    borderTopRightRadius: 8,
  },
  cornerBottomLeft: {
    bottom: 0,
    left: 0,
    borderBottomWidth: 4,
    borderLeftWidth: 4,
    borderBottomLeftRadius: 8,
  },
  cornerBottomRight: {
    bottom: 0,
    right: 0,
    borderBottomWidth: 4,
    borderRightWidth: 4,
    borderBottomRightRadius: 8,
  },

  // Bottom hint
  bottomHint: {
    alignItems: 'center',
    paddingBottom: 40,
    gap: 12,
  },
  hintText: { color: '#fff', fontSize: 15, textAlign: 'center' },
  processingRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  processingText: { color: '#fff', fontSize: 14 },
});
