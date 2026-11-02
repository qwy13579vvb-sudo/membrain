/** 清理：我自己的「导演注释」/ 大段英文草稿，不该进记忆海 */
import { DatabaseSync } from 'node:sqlite';

const db = new DatabaseSync(process.env.MG_DB || 'memory.db');
const starts = ['Short warm reply', 'User just says', 'User says', 'The user says', 'Keep it short',
  'Let me ', 'I need to ', 'Reply short', 'Short reply', '（点头', '（顿了顿', '（尾鳍', '（别过脸',
  '（很小声', '（沉默', '（停下', '（长出一口气', '（合上', '（转过来', '（盯着'];

const rows = db.prepare('SELECT id, text FROM node WHERE layer=1').all();
let n = 0;
db.exec('BEGIN');
for (const r of rows) {
  const t = (r.text || '').trim();
  if (!t) { db.prepare('DELETE FROM node WHERE id=?').run(r.id); n++; continue; }
  const asciiRatio = (t.match(/[A-Za-z]/g) || []).length / t.length;
  const isDraft = starts.some((p) => t.startsWith(p));
  const isEnglishDraft = asciiRatio > 0.55 && t.length > 30;
  if (isDraft || isEnglishDraft) { db.prepare('DELETE FROM node WHERE id=?').run(r.id); n++; }
}
db.exec('COMMIT');
db.exec('DELETE FROM edge WHERE src NOT IN (SELECT id FROM node) OR dst NOT IN (SELECT id FROM node)');
const left = db.prepare('SELECT COUNT(*) c FROM node').get().c;
const layers = db.prepare('SELECT layer, COUNT(*) c FROM node GROUP BY layer ORDER BY layer').all()
  .map((x) => `L${x.layer} ${x.c}`).join(' / ');
console.log(`清理 ${n} 条脏节点；剩余 ${left}（${layers}）`);
