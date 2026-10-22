import { buildReceiptPath, isUuid, isValidReceiptPath, resolveReceiptPathForUpdate } from './receipt-path';

const G = '11111111-2222-4333-8444-555555555555';
const E = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const F = '99999999-8888-4777-8666-555555555555';

describe('buildReceiptPath (C1)', () => {
  test('dạng <group>/<uuid>/<uuid>.jpg — đủ 3 đoạn cho policy can_write_receipt', () => {
    const path = buildReceiptPath(G, E, F);
    expect(path).toBe(`${G}/${E}/${F}.jpg`);
    expect(path.split('/')).toHaveLength(3);
    expect(path.startsWith(`${G}/`)).toBe(true);
  });

  test('từ chối id không phải UUID', () => {
    expect(() => buildReceiptPath('group-1', E, F)).toThrow(/INVALID_RECEIPT_PATH/);
    expect(() => buildReceiptPath(G, 'tmp', F)).toThrow(/INVALID_RECEIPT_PATH/);
    expect(() => buildReceiptPath(G, E, '../x')).toThrow(/INVALID_RECEIPT_PATH/);
  });
});

describe('isValidReceiptPath', () => {
  test('đường dẫn do buildReceiptPath tạo là hợp lệ', () => {
    expect(isValidReceiptPath(buildReceiptPath(G, E, F), G)).toBe(true);
  });

  test('dạng cũ 2 đoạn (<group>/<uuid>.jpg) bị policy từ chối', () => {
    expect(isValidReceiptPath(`${G}/${F}.jpg`, G)).toBe(false);
  });

  test('nhóm khác, đoạn 2 không phải UUID, tên file rỗng', () => {
    expect(isValidReceiptPath(`${E}/${E}/${F}.jpg`, G)).toBe(false);
    expect(isValidReceiptPath(`${G}/tmp/${F}.jpg`, G)).toBe(false);
    expect(isValidReceiptPath(`${G}/${E}/`, G)).toBe(false);
    expect(isValidReceiptPath(null, G)).toBe(false);
  });

  test('isUuid', () => {
    expect(isUuid(G)).toBe(true);
    expect(isUuid(G.toUpperCase())).toBe(true);
    expect(isUuid('abc')).toBe(false);
    expect(isUuid(undefined)).toBe(false);
  });
});

describe('resolveReceiptPathForUpdate (update_expense ghi đè receipt_path)', () => {
  const existing = `${G}/${E}/${F}.jpg`;
  const uploaded = `${G}/${E}/${G}.jpg`;

  test('không đổi → gửi lại đường dẫn hiện có (không bị xóa ngầm)', () => {
    expect(resolveReceiptPathForUpdate({ existing, uploadedPath: null, removed: false })).toBe(existing);
  });

  test('chưa từng có ảnh → null', () => {
    expect(resolveReceiptPathForUpdate({ existing: null, uploadedPath: null, removed: false })).toBeNull();
  });

  test('xóa ảnh → null', () => {
    expect(resolveReceiptPathForUpdate({ existing, uploadedPath: null, removed: true })).toBeNull();
  });

  test('ảnh mới → đường dẫn mới (kể cả sau khi bấm xóa ảnh cũ)', () => {
    expect(resolveReceiptPathForUpdate({ existing, uploadedPath: uploaded, removed: false })).toBe(uploaded);
    expect(resolveReceiptPathForUpdate({ existing, uploadedPath: uploaded, removed: true })).toBe(uploaded);
  });
});
