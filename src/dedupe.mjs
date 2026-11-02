/** dedupe.mjs —— 同类条目近重复清理（余弦≥0.86 视为重复，留置信高的） */
import { DatabaseSync } from 'node:sqlite';

const DIM = 256;
const h32 = (s) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };
function vec(text) {
  const v = new Float32Array(DIM);
  const t = String(text).replace(/[\s\p{P}]+/gu, '');
  for (let i = 0; i < t.length - 1; i++) v[h32(t.slice(i, i + 2)) % DIM] += 1;
  let n = 0; for (let i = 0; i < DIM; i++) n += v[i] * v[i];
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < DIM; i++) v[i] /= n;
  return v;
}
const cos = (a, b) => { let s = 0; for (let i = 0; i < DIM; i++) s += a[i] * b[i]; return s; };

export function dedupe(db, { kinds = ['rule', 'preference', 'promise', 'fact', 'conclusion'], threshold = 0.86 } = {}) {
  let removed = 0;
  for (const kind of kinds) {
    const rows = db.prepare(`SELECT id, text, confidence, importance, ts_from FROM node WHERE kind=?`).all(kind);
    if (rows.length < 2) continue;
    const vecs = rows.map((r) => vec(r.text));
    const dead = new Set();
    for (let i = 0; i < rows.length; i++) {
      if (dead.has(i)) continue;
      for (let j = i + 1; j < rows.length; j++) {
        if (dead.has(j)) continue;
        if (cos(vecs[i], vecs[j]) < threshold) continue;
        // 留置信更高 / 更早的那条
        const keepI = (rows[i].confidence || 0) >= (rows[j].confidence || 0);
        dead.add(keepI ? j : i);
        if (!keepI) break;
      }
    }
    for (const idx of dead) {
      db.prepare('DELETE FROM node WHERE id=?').run(rows[idx].id);
      removed++;
    }
    if (dead.size) console.log(`  ${kind}: ${rows.length} → ${rows.length - dead.size}`);
  }
  return { removed };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const db = new DatabaseSync(new URL('./memory.db', import.meta.url).pathname);
  const r = dedupe(db);
  console.log('去重删除:', r.removed, '条');
}
