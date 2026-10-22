import { fitLongestEdge, JPEG_QUALITY, MAX_IMAGE_EDGE } from './image-sizing';

describe('fitLongestEdge (M2)', () => {
  test('ảnh ngang lớn → thu cạnh rộng về 1600', () => {
    expect(fitLongestEdge(4000, 3000)).toEqual({ width: 1600 });
  });

  test('ảnh dọc lớn → thu cạnh cao về 1600 (không ép chiều rộng)', () => {
    expect(fitLongestEdge(3000, 4000)).toEqual({ height: 1600 });
  });

  test('ảnh đã nhỏ hơn hoặc bằng giới hạn → không resize (không phóng to)', () => {
    expect(fitLongestEdge(1600, 900)).toBeNull();
    expect(fitLongestEdge(800, 1200)).toBeNull();
  });

  test('kích thước không hợp lệ → null', () => {
    expect(fitLongestEdge(0, 100)).toBeNull();
    expect(fitLongestEdge(Number.NaN, 100)).toBeNull();
  });

  test('hằng số theo spec', () => {
    expect(MAX_IMAGE_EDGE).toBe(1600);
    expect(JPEG_QUALITY).toBe(0.7);
  });
});
