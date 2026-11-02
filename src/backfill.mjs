/** 给存量 L1 节点补情绪分 + 初始记忆强度 */
import { DatabaseSync } from 'node:sqlite';
import { scoreEmotion } from './emotion.mjs';
import { initialStrength } from './ebbinghaus.mjs';

const db = new DatabaseSync(process.env.MG_DB || 'memory.db');
const rows = db.prepare(`SELECT id, text, importance FROM node WHERE layer=1 AND (emotion=0 AND arousal=0.3)`).all();
const upd = db.prepare(`UPDATE node SET emotion=?, arousal=?, strength=?, last_review_at=? WHERE id=?`);
let n = 0;
db.exec('BEGIN');
for (const r of rows) {
  const e = scoreEmotion(r.text);
  const st = initialStrength({ arousal: e.arousal, importance: r.importance, emotion: e.valence });
  upd.run(e.valence, e.arousal, st, Date.now(), r.id);
  n++;
}
db.exec('COMMIT');
console.log('回填', n, '条');
const s = db.prepare(`SELECT ROUND(AVG(emotion),3) v, ROUND(AVG(arousal),3) a, ROUND(AVG(strength),2) st FROM node WHERE layer=1`).get();
console.log('均值 情绪', s.v, '唤醒', s.a, '强度', s.st);
console.log('情绪最强的 3 条:');
for (const x of db.prepare(`SELECT text, emotion, arousal FROM node WHERE layer=1 ORDER BY ABS(emotion) DESC LIMIT 3`).all()) {
  console.log('  %s  %s', x.emotion.toFixed(2), x.text.slice(0, 58));
}
