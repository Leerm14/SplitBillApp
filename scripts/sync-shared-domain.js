#!/usr/bin/env node
/**
 * BE-13 (DEV mục 1.4 — "không viết lại thuật toán"):
 * Chép mã nguồn chung src/domain/*.ts sang supabase/functions/_shared/ cho Edge Function (Deno).
 *
 * - Sửa import tương đối: './settlement' → './settlement.ts' (Deno bắt buộc có đuôi file).
 * - Thêm dòng đầu "generated — do not edit".
 * - Chuẩn hóa xuống dòng LF để kết quả giống nhau trên Windows và CI.
 *
 * Dùng:
 *   npm run sync:shared            # ghi lại các file trong _shared
 *   node scripts/sync-shared-domain.js --check   # chỉ kiểm tra, exit 1 nếu lệch
 *
 * src/domain/shared-sync.test.ts (jest) gọi generateSharedFiles() để bắt lỗi quên đồng bộ.
 */
/* global __dirname */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SOURCE_DIR = 'src/domain';
const TARGET_DIR = 'supabase/functions/_shared';

/** Các module dùng chung. Import tương đối chỉ được trỏ tới module trong danh sách này. */
const MODULES = ['settlement.ts', 'pairwise.ts'];

const RELATIVE_IMPORT_RE = /(\bfrom\s+|\bimport\s+|\bimport\s*\(\s*)(['"])(\.{1,2}\/[^'"]+)\2/g;

function header(sourceRel) {
  return [
    `// generated — do not edit. Source: ${sourceRel}`,
    '// Sửa file gốc trong src/domain rồi chạy `npm run sync:shared`.',
    '',
  ].join('\n');
}

/** Chuyển nội dung một file src/domain sang bản Deno. */
function transform(source, fileName) {
  const normalized = source.replace(/\r\n/g, '\n');
  const body = normalized.replace(RELATIVE_IMPORT_RE, (_match, prefix, quote, specifier) => {
    let target = specifier;
    if (!/\.(ts|js|mjs|json)$/.test(target)) target += '.ts';
    const base = path.posix.basename(target);
    if (!specifier.startsWith('./') || !MODULES.includes(base)) {
      throw new Error(
        `${fileName}: import '${specifier}' trỏ ra ngoài các module dùng chung (${MODULES.join(', ')}). ` +
          'Thêm module đó vào MODULES trong scripts/sync-shared-domain.js.',
      );
    }
    return `${prefix}${quote}${target}${quote}`;
  });
  return header(`${SOURCE_DIR}/${fileName}`) + body;
}

/** Danh sách { target (đường dẫn tuyệt đối), content } cần có trong _shared. */
function generateSharedFiles(root = ROOT) {
  return MODULES.map((fileName) => {
    const sourcePath = path.join(root, SOURCE_DIR, fileName);
    const source = fs.readFileSync(sourcePath, 'utf8');
    return {
      target: path.join(root, TARGET_DIR, fileName),
      content: transform(source, fileName),
    };
  });
}

function main(argv) {
  const check = argv.includes('--check');
  const outputs = generateSharedFiles();
  const stale = [];

  for (const { target, content } of outputs) {
    const current = fs.existsSync(target) ? fs.readFileSync(target, 'utf8').replace(/\r\n/g, '\n') : null;
    if (current === content) continue;
    stale.push(path.relative(ROOT, target));
    if (!check) {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content, 'utf8');
    }
  }

  if (check) {
    if (stale.length) {
      console.error(`Lệch với src/domain: ${stale.join(', ')}. Chạy: npm run sync:shared`);
      return 1;
    }
    console.log('supabase/functions/_shared khớp với src/domain.');
    return 0;
  }

  console.log(stale.length ? `Đã cập nhật: ${stale.join(', ')}` : 'Không có thay đổi.');
  return 0;
}

module.exports = { generateSharedFiles, transform, MODULES, SOURCE_DIR, TARGET_DIR };

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}
