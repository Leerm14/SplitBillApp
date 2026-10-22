import assert from 'node:assert/strict';
import { computeBalances, simplifyDebts, type Transfer } from './settlement.ts';

const fmt = (t: Transfer[]) => t.map((x) => `${x.from}→${x.to} ${x.amount.toLocaleString('vi-VN')}đ`).join(', ');

function assertSettles(bal: Map<string, number>, transfers: Transfer[]) {
  const after = new Map(bal);
  for (const t of transfers) {
    assert.ok(t.amount > 0 && Number.isInteger(t.amount));
    after.set(t.from, after.get(t.from)! + t.amount);
    after.set(t.to, after.get(t.to)! - t.amount);
  }
  for (const [id, v] of after) assert.equal(v, 0, `${id} còn ${v}`);
}

// 1. Ví dụ của người dùng: A trả bữa 90k (30k/người), B trả bữa 45k (15k/người).
{
  const bal = computeBalances(['A', 'B', 'C'], [
    { paidBy: 'A', status: 'ACTIVE', shares: [{ userId: 'A', amount: 30000 }, { userId: 'B', amount: 30000 }, { userId: 'C', amount: 30000 }] },
    { paidBy: 'B', status: 'ACTIVE', shares: [{ userId: 'A', amount: 15000 }, { userId: 'B', amount: 15000 }, { userId: 'C', amount: 15000 }] },
  ], []);
  const t = simplifyDebts(bal);
  console.log('Ví dụ ABC   :', Object.fromEntries(bal), '=>', fmt(t));
  assert.deepEqual(t, [{ from: 'C', to: 'A', amount: 45000 }]);
}

// 2. Ví dụ trong đặc tả + B đã trả A 200k (CONFIRMED), C gửi 300k nhưng đang PENDING.
{
  const exp = [{ paidBy: 'A', status: 'ACTIVE' as const, shares: ['A', 'B', 'C'].map((userId) => ({ userId, amount: 300000 })) }];
  const pays = [
    { fromId: 'B', toId: 'A', amount: 200000, status: 'CONFIRMED' as const },
    { fromId: 'C', toId: 'A', amount: 300000, status: 'PENDING' as const },
  ];
  const official = computeBalances(['A', 'B', 'C'], exp, pays);
  const projected = computeBalances(['A', 'B', 'C'], exp, pays, { includePending: true });
  console.log('Đặc tả (xác nhận):', fmt(simplifyDebts(official)));
  console.log('Đặc tả (dự kiến) :', fmt(simplifyDebts(projected)));
  assert.deepEqual(simplifyDebts(projected), [{ from: 'B', to: 'A', amount: 100000 }]);
}

// 3. Trường hợp tham lam thuần thất bại nhưng thuật toán chính xác vẫn tối ưu.
{
  const bal = new Map(Object.entries({ A: 4, B: 3, C: -2, D: -2, E: -3 }).map(([k, v]) => [k, v * 10000]));
  const t = simplifyDebts(bal);
  console.log("Tách nhóm 0 :", fmt(t), "(tham lam thuần cần 4 lần)");
  assert.equal(t.length, 3);
  assertSettles(bal, t);
}

// 4. Ngẫu nhiên: so với vét cạn mọi phân hoạch (n ≤ 8) và kiểm tra luôn tất toán đúng.
function bruteMinTransfers(vals: number[]): number {
  // n − (số nhóm tổng-0 nhiều nhất), vét cạn đệ quy
  const best = (rest: number[]): number => {
    if (rest.length === 0) return 0;
    const [first, ...others] = rest;
    let r = -Infinity;
    for (let m = 0; m < 1 << others.length; m++) {
      const pick = others.filter((_, i) => m & (1 << i));
      if (first + pick.reduce((s, x) => s + x, 0) !== 0) continue;
      r = Math.max(r, 1 + best(others.filter((_, i) => !(m & (1 << i)))));
    }
    return r;
  };
  return vals.length - best(vals);
}

let rand = 42;
const rnd = (k: number) => ((rand = (rand * 1103515245 + 12345) % 2 ** 31), rand % k);
let greedyWorse = 0;
for (let iter = 0; iter < 3000; iter++) {
  const n = 2 + rnd(7);
  const vals = Array.from({ length: n - 1 }, () => (rnd(11) - 5) * 1000).filter((v) => v !== 0);
  const last = -vals.reduce((s, x) => s + x, 0);
  if (last !== 0) vals.push(last);
  const bal = new Map(vals.map((v, i) => [`U${i}`, v]));
  const t = simplifyDebts(bal);
  assertSettles(bal, t);
  const opt = vals.length ? bruteMinTransfers(vals) : 0;
  assert.equal(t.length, opt, `không tối ưu với ${vals}`);
  if (vals.length && naiveGreedyCount(vals) > opt) greedyWorse++;
}
console.log(`Ngẫu nhiên  : 3000 ca đều tối ưu; tham lam thuần kém hơn ở ${greedyWorse} ca`);

function naiveGreedyCount(vals: number[]): number {
  const c = vals.filter((v) => v > 0);
  const d = vals.filter((v) => v < 0).map((v) => -v);
  let k = 0;
  while (c.length && d.length) {
    c.sort((a, b) => b - a);
    d.sort((a, b) => b - a);
    const m = Math.min(c[0], d[0]);
    c[0] -= m; d[0] -= m; k++;
    if (!c[0]) c.shift();
    if (!d[0]) d.shift();
  }
  return k;
}

// 5. Nhóm lớn (dùng nhánh gần tối ưu) vẫn tất toán đúng và ≤ n − 1 lần.
{
  const vals = Array.from({ length: 39 }, () => (rnd(201) - 100) * 1000);
  vals.push(-vals.reduce((s, x) => s + x, 0));
  const bal = new Map(vals.map((v, i) => [`M${String(i).padStart(2, '0')}`, v]));
  const t = simplifyDebts(bal);
  assertSettles(bal, t);
  assert.ok(t.length <= vals.filter((v) => v !== 0).length - 1);
  console.log(`Nhóm 40 người: ${t.length} lần chuyển`);
}

console.log('OK');
