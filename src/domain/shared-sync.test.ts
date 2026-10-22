/// <reference types="node" />
/**
 * BE-13: supabase/functions/_shared/*.ts phải đúng bằng bản sinh từ src/domain
 * (scripts/sync-shared-domain.js). Lệch → sửa src/domain rồi chạy `npm run sync:shared`.
 */
import fs from 'fs';
import path from 'path';

type SharedFile = { target: string; content: string };

// eslint-disable-next-line @typescript-eslint/no-require-imports
const sync = require('../../scripts/sync-shared-domain.js') as {
  generateSharedFiles: (root?: string) => SharedFile[];
  transform: (source: string, fileName: string) => string;
  MODULES: string[];
};

const ROOT = path.resolve(__dirname, '..', '..');

describe('shared domain sync (BE-13)', () => {
  const outputs = sync.generateSharedFiles(ROOT);

  test('covers settlement.ts and pairwise.ts', () => {
    expect(sync.MODULES).toEqual(expect.arrayContaining(['settlement.ts', 'pairwise.ts']));
    expect(outputs).toHaveLength(sync.MODULES.length);
  });

  test.each(outputs.map((o) => [path.relative(ROOT, o.target), o] as const))(
    '%s matches the generated copy',
    (_name, { target, content }) => {
      expect(fs.existsSync(target)).toBe(true);
      const actual = fs.readFileSync(target, 'utf8').replace(/\r\n/g, '\n');
      expect(actual).toBe(content);
    },
  );

  test('rewrites relative imports with the .ts extension Deno needs', () => {
    const out = sync.transform("import type { A } from './settlement';\n", 'pairwise.ts');
    expect(out).toContain("from './settlement.ts'");
    expect(out.startsWith('// generated — do not edit')).toBe(true);
  });

  test('rejects imports outside the shared modules', () => {
    expect(() => sync.transform("import { x } from './money';\n", 'settlement.ts')).toThrow(/money/);
  });
});
