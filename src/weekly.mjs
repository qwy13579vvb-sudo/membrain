/** 周摘要：L1/L2 → 每周一条（layer 2），补上「只有按天归纳」的缺口 */
import { DatabaseSync } from 'node:sqlite';
const DAY = 86400000;
const SH = 8 * 3600000;

function weekKey(ts) {
  const d = new Date(ts + SH);
  const day = (d.getUTCDay() + 6) % 7;          // 周一=0
  const monday = startOfDay(ts) - day * DAY;
  const y = new Date(monday + SH).getUTCFullYear();
  const wk = Math.floor((monday - Date.UTC(y, 0, 1)) / (7 * DAY)) + 1;
  return `${y}-W${String(wk).padStart(2, '0')}`;
}
function startOfDay(ts) {
  const d = new Date(ts + SH);
  d.setUTCHours(0, 0, 0, 0);
  return d.getTime() - SH;
}

export function consolidateWeek(db) {
  const rows = db.prepare(`SELECT id, ts_from, kind, emotion, importance, text FROM node
    WHERE layer BETWEEN 1 AND 2 AND uid != 'L4-profile'`).all();
  const buckets = new Map();
  for (const r of rows) {
    const k = weekKey(r.ts_from);
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(r);
  }
  let made = 0;
  const ins = db.prepare(`INSERT OR REPLACE INTO node
    (uid, kind, text, ts_from, ts_to, source, source_ref, speaker, importance, confidence,
     user_confirmed, layer, emotion, arousal, strength, source_ids, topic, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  for (const [wk, items] of buckets) {
    if (items.length < 3) continue;
    const ref = `W:${wk}`;
    const dup = db.prepare(`SELECT id FROM node WHERE source_ref=?`).get(ref);
    const ts0 = Math.min(...items.map((x) => x.ts_from));
    const ts1 = Math.max(...items.map((x) => x.ts_from));
    const emo = items.reduce((a, x) => a + (x.emotion || 0), 0) / items.length;
    const kinds = {};
    for (const x of items) kinds[x.kind] = (kinds[x.kind] || 0) + 1;
    const top = items.slice().sort((a, b) => b.importance - a.importance).slice(0, 12)
      .map((x) => String(x.text).slice(0, 40)).join(' ／ ');
    const text = `${wk} 周纪要｜共 ${items.length} 件事（${Object.entries(kinds).map(([k, v]) => `${k}${v}`).join(' ')}），`
      + `情绪基调 ${emo > 0.15 ? '偏暖' : emo < -0.15 ? '偏低' : '平稳'}。要点：${top}`;
    ins.run('default', 'conclusion', text, ts0, ts1, 'weekly', ref, 'system',
      0.75, 0.9, 1, 2, +emo.toFixed(3), 0.3, 1.2,
      JSON.stringify(items.map((x) => x.id)), '周摘要', Date.now());
    made += dup ? 0 : 1;
  }
  return { made, weeks: buckets.size };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const db = new DatabaseSync(process.env.MG_DB || 'memory.db');
  const r = consolidateWeek(db);
  console.log(`周摘要：新建 ${r.made} 条 / 覆盖 ${r.weeks} 周`);
}
