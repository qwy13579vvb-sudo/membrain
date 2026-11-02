/**
 * supersede.mjs —— 「谁替代了谁」
 * 同一件事（同 topic 或高相似）出现新版时：旧的标记 superseded_by，新的记下 supersedes。
 * 用法: node supersede.mjs [--dry]
 */
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { migrate3 } from './migrate3.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const DB = process.env.MG_DB || (process.env.MG_DB || path.join(process.cwd(), 'memory.db'));
const dry = process.argv.includes('--dry');

// 简易相似度：中文按 2-gram 交集
function grams(s) {
  const t = String(s).replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, '');
  const out = new Set();
  for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2));
  return out;
}
function jaccard(a, b) {
  const A = grams(a), B = grams(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

export function supersedeScan(db, { threshold = 0.9, kinds = ['fact', 'preference', 'rule', 'conclusion'] } = {}) {
  migrate3(db);
  const rows = db.prepare(`SELECT id, kind, text, topic, ts_from, superseded_by FROM node
    WHERE kind IN (${kinds.map(() => '?').join(',')}) ORDER BY ts_from ASC`).all(...kinds);
  const marks = [];
  for (let i = 0; i < rows.length; i++) {
    const older = rows[i];
    if (older.superseded_by) continue;
    for (let j = i + 1; j < rows.length; j++) {
      const newer = rows[j];
      if (newer.superseded_by) continue;
      // 同 topic 且话题明确 → 直接算替代
      const sameTopic = older.topic && newer.topic && older.topic === newer.topic;
      const sim = jaccard(older.text, newer.text);
      // 判定：同话题直接算；否则看相似度（跨类型要求更高）
      const need = older.kind === newer.kind ? threshold : Math.min(0.97, threshold + 0.08);
      if (!sameTopic && sim < need) continue;
      marks.push({ old: older.id, newer: newer.id, sim: +sim.toFixed(2), sameTopic: !!sameTopic });
      break;   // 只认最近的一条新版
    }
  }
  if (!dry) {
    const upd = db.prepare('UPDATE node SET superseded_by=? WHERE id=?');
    const upd2 = db.prepare('UPDATE node SET supersedes=? WHERE id=?');
    for (const m of marks) { upd.run(m.newer, m.old); upd2.run(m.old, m.newer); }
  }
  return marks;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const db = new DatabaseSync(DB);
  const marks = supersedeScan(db);
  console.log((dry ? '【试算】' : '') + '标记替代 ' + marks.length + ' 组');
  for (const m of marks.slice(0, 8)) console.log(`  #${m.old} → 被 #${m.newer} 替代（相似 ${m.sim}${m.sameTopic ? '，同话题' : ''}）`);
  db.close();
}
