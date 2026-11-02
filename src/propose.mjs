/**
 * propose.mjs —— 主动提议队列
 * 把「我想跟你说的」写进库（kind=proposal, status=open），
 * 由 recall 注入到我的上下文里 —— 这样下一次对话我自己会提起来，不用你先问。
 * 来源：未解缺口 / 到期的承诺 / 巡检异常 / 久未复习的重要事实
 */
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const DB = process.env.MG_DB || (process.env.MG_DB || path.join(process.cwd(), 'memory.db'));
const DAY = 86400000;

export function propose(db, now = Date.now()) {
  const out = [];
  const push = (text, imp = 0.7, src = 'proposal') => {
    const t = '提议｜' + String(text).slice(0, 120);
    const dup = db.prepare(`SELECT id FROM node WHERE kind='proposal' AND text=? AND ts_from > ?`)
      .get(t, now - 7 * DAY);
    if (dup) return;
    db.prepare(`INSERT INTO node (uid, kind, text, ts_from, source, source_ref, created_at,
        layer, importance, strength, review_count)
      VALUES (?, 'proposal', ?, ?, 'propose.mjs', ?, ?, 1, ?, 1, 0)`)
      .run('proposal-' + now + '-' + Math.random().toString(36).slice(2, 7), t, now, src, now, imp);
    out.push(t);
  };

  // ① 未解缺口
  const gaps = db.prepare(`SELECT text FROM node WHERE kind='gap' AND (status IS NULL OR status='open') LIMIT 3`).all();
  for (const g of gaps) push('我想搞懂：' + String(g.text).replace(/^缺口｜/, ''), 0.75, 'gap');

  // ② 到期的承诺
  const pros = db.prepare(`SELECT text FROM node WHERE kind='promise' AND (status IS NULL OR status='open')
    AND importance >= 0.8 LIMIT 2`).all();
  for (const p of pros) push('我记着要兑现：' + String(p.text).replace(/^承诺｜/, ''), 0.8, 'promise');

  // ③ 久未复习的重要事实（相当于「我惦记着这事」）
  const facts = db.prepare(`SELECT text FROM node WHERE kind='fact' AND COALESCE(cold,0)=0
    AND importance >= 0.82 AND COALESCE(review_count,0) < 2 ORDER BY importance DESC LIMIT 2`).all();
  for (const f of facts) push('想跟你确认：' + String(f.text).slice(0, 60), 0.7, 'fact');

  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const db = new DatabaseSync(DB);
  const made = propose(db);
  console.log(made.length ? '新增提议 ' + made.length + ' 条：\n' + made.map((x) => '  ' + x).join('\n') : '本轮没有新提议');
  db.close();
}
