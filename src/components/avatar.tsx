/**
 * MVP-02 / MVP-03: Ảnh đại diện (người dùng hoặc nhóm) từ Cloudinary; chưa có ảnh hoặc tải lỗi
 * thì hiện chữ cái đầu trên nền màu.
 */
import { Image } from 'expo-image';
import React, { useState } from 'react';
import { PixelRatio, StyleSheet, Text, View, type ImageStyle, type StyleProp, type ViewStyle } from 'react-native';

import { imageUrl } from '@/api/images';

const COLORS = ['#007AFF', '#34C759', '#FF9500', '#AF52DE', '#FF2D55', '#5AC8FA', '#FF3B30', '#5856D6'];

/** Màu ổn định theo chuỗi (id / tên) để cùng một người luôn cùng màu. */
export function avatarColor(seed: string | null | undefined): string {
  const s = seed ?? '';
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return COLORS[Math.abs(h) % COLORS.length];
}

type Props = {
  name: string | null | undefined;
  /** public_id Cloudinary (profiles.avatar_path / groups.avatar_path) */
  path: string | null | undefined;
  size?: number;
  /** Màu nền khi hiện chữ cái đầu; mặc định theo seed */
  color?: string;
  seed?: string;
  /** Uri ảnh cục bộ (xem trước trước khi upload) — ưu tiên hơn path */
  localUri?: string | null;
  style?: StyleProp<ViewStyle>;
};

export function Avatar({ name, path, size = 40, color, seed, localUri, style }: Props) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const px = Math.min(1600, Math.round(size * PixelRatio.get()));
  const remote = imageUrl(path, { width: px });
  const uri = localUri ?? remote;
  const radius = size / 2;
  const letter = (name?.trim() || '?')[0].toUpperCase();

  if (uri && uri !== failedUrl) {
    return (
      <Image
        source={{ uri }}
        style={[{ width: size, height: size, borderRadius: radius, backgroundColor: '#E5E5EA' }, style as StyleProp<ImageStyle>]}
        contentFit="cover"
        cachePolicy="memory-disk"
        transition={150}
        onError={() => setFailedUrl(uri)}
        accessibilityLabel={name ?? undefined}
      />
    );
  }

  return (
    <View
      style={[
        styles.fallback,
        { width: size, height: size, borderRadius: radius, backgroundColor: color ?? avatarColor(seed ?? name) },
        style,
      ]}
    >
      <Text style={[styles.letter, { fontSize: Math.max(10, Math.round(size * 0.42)) }]}>{letter}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  fallback: { justifyContent: 'center', alignItems: 'center' },
  letter: { color: '#fff', fontWeight: '700' },
});
