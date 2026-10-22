/**
 * MVP-01: Ảnh hóa đơn — ô chọn ảnh (màn thêm / sửa khoản chi) và xem toàn màn hình.
 */
import { Image } from 'expo-image';
import React, { useState } from 'react';
import { ActivityIndicator, Modal, Pressable, StyleSheet, Text, View } from 'react-native';

import { showImageActions } from '@/lib/pick-image';

/** Xem ảnh toàn màn hình, chạm để đóng. */
export function ReceiptViewer({ uri, visible, onClose }: { uri: string | null; visible: boolean; onClose: () => void }) {
  return (
    <Modal visible={visible && !!uri} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.viewer} onPress={onClose} accessibilityLabel="Đóng ảnh hóa đơn">
        {uri ? <Image source={{ uri }} style={styles.viewerImage} contentFit="contain" /> : null}
        <Text style={styles.viewerHint}>Chạm để đóng</Text>
      </Pressable>
    </Modal>
  );
}

type PickerProps = {
  /** Ảnh mới chọn trên máy (chưa upload) */
  localUri: string | null;
  /** Ảnh hiện có (signed URL) */
  remoteUrl: string | null;
  /** Đang tải signed URL của ảnh hiện có */
  remoteLoading?: boolean;
  /** Có ảnh hiện có nhưng không tải được */
  remoteError?: boolean;
  disabled?: boolean;
  onPicked: (uri: string) => void;
  onRemove: () => void;
};

/** Ô "Thêm ảnh hóa đơn": chạm để chụp / chọn / xóa; chạm giữ để xem lớn. */
export function ReceiptPicker({ localUri, remoteUrl, remoteLoading, remoteError, disabled, onPicked, onRemove }: PickerProps) {
  const [viewing, setViewing] = useState(false);
  const shownUri = localUri ?? remoteUrl;
  const hasImage = !!localUri || !!remoteUrl || !!remoteError || !!remoteLoading;

  const openActions = () =>
    showImageActions({ title: 'Ảnh hóa đơn', hasImage, onPicked, onRemove });

  return (
    <>
      <Pressable
        style={styles.picker}
        onPress={openActions}
        onLongPress={() => shownUri && setViewing(true)}
        disabled={disabled}
        accessibilityRole="button"
        accessibilityLabel={hasImage ? 'Đổi hoặc xóa ảnh hóa đơn' : 'Thêm ảnh hóa đơn'}
      >
        {shownUri ? (
          <Image source={{ uri: shownUri }} style={styles.preview} contentFit="cover" />
        ) : remoteLoading ? (
          <View style={styles.placeholder}>
            <ActivityIndicator color="#8E8E93" />
          </View>
        ) : (
          <View style={styles.placeholder}>
            <Text style={styles.placeholderIcon}>📷</Text>
            <Text style={styles.placeholderText}>
              {remoteError ? 'Không tải được ảnh hiện có — chạm để thay hoặc xóa' : 'Thêm ảnh hóa đơn'}
            </Text>
          </View>
        )}
      </Pressable>
      {shownUri ? <Text style={styles.hint}>Chạm để đổi / xóa · Chạm giữ để xem lớn</Text> : null}
      <ReceiptViewer uri={shownUri} visible={viewing} onClose={() => setViewing(false)} />
    </>
  );
}

const styles = StyleSheet.create({
  picker: {
    borderRadius: 12,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: '#ddd',
    borderStyle: 'dashed',
    backgroundColor: '#fff',
  },
  preview: { width: '100%', height: 200 },
  placeholder: { height: 100, justifyContent: 'center', alignItems: 'center', backgroundColor: '#f9f9f9', gap: 4, padding: 8 },
  placeholderIcon: { fontSize: 24 },
  placeholderText: { fontSize: 14, color: '#8E8E93', textAlign: 'center' },
  hint: { fontSize: 12, color: '#8E8E93', marginTop: -4 },
  viewer: { flex: 1, backgroundColor: 'rgba(0,0,0,0.92)', justifyContent: 'center', alignItems: 'center' },
  viewerImage: { width: '94%', height: '78%' },
  viewerHint: { color: '#fff', fontSize: 15, marginTop: 16 },
});
