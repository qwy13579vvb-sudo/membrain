/**
 * gap.mjs —— 认知缺口与自主议程
 *
 * 三条来源记「我不知道什么」：
 *   1) 检索空手而归（问了但库里没有）
 *   2) 出现陌生术语（大写英文/新包名/没见过的词）
 *   3) 被用户纠正（我说错了）
 * 议程：open gap + 未完成承诺 → 每轮顶部注入「今天我缺什么」。
 */
import { DatabaseSync } from 'node:sqlite';

const now = () => Date.now();

export function addGap(db, { kind = 'unknown', topic, detail = '', weight = 0.5 }) {
  const key = `${kind}:${String(topic).slice(0, 40)}`;
  const dup = db.prepare(`SELECT id, access_count FROM node WHERE kind='gap' AND source_ref=?`).get(key);
  if (dup) {
    db.prepare(`UPDATE node SET access_count=access_count+1, last_access=?, importance=MIN(1, importance+0.05) WHERE id=?`)
      .run(now(), dup.id);
    return { id: dup.id, dup: true };
  }
  const label = kind === 'miss' ? '库里没有：' : kind === 'term' ? '遇到陌生的东西：' : kind === 'wrong' ? '教训（曾经搞错）：' : '';
  const text = `缺口｜${label}${String(topic).slice(0, 60)}`
    + (detail ? `（${String(detail).slice(0, 60)}）` : '');
  const info = db.prepare(`INSERT INTO node (uid, kind, text, ts_from, ts_to, source, source_ref, speaker,
      importance, confidence, user_confirmed, layer, emotion, arousal, strength, status, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(`gap-${now()}-${Math.random().toString(36).slice(2, 6)}`, 'gap', text, now(), now(),
      'gap', key, 'system', weight, 0.5, 0, 2, 0, 0.4, 8, 'open', now());
  return { id: Number(info.lastInsertRowid), dup: false };
}

export function listGaps(db, { limit = 5 } = {}) {
  return db.prepare(`SELECT id, text, importance, access_count, ts_from FROM node
    WHERE kind='gap' AND (status IS NULL OR status='open')
    ORDER BY (access_count * 0.3 + importance) DESC LIMIT ?`).all(limit);
}

export function resolveGap(db, id, how = '') {
  db.prepare(`UPDATE node SET status='resolved', text = text || ?, importance=MAX(importance,0.6) WHERE id=?`)
    .run(how ? `（已补：${String(how).slice(0, 50)}）` : '（已补）', id);
}

/** 今日议程：缺口 + 未完成承诺 */
export function buildAgenda(db, { maxGaps = 2, maxPromises = 2 } = {}) {
  const gaps = listGaps(db, { limit: maxGaps });
  const promises = db.prepare(`SELECT text, ts_from FROM node
    WHERE kind='promise' AND (status IS NULL OR status='open') ORDER BY importance DESC LIMIT ?`).all(maxPromises);
  if (!gaps.length && !promises.length) return '';
  const lines = [];
  if (gaps.length) {
    lines.push('🎯 我还不懂：' + gaps.map((g) => String(g.text).replace(/^缺口｜/, '').slice(0, 40)).join('；'));
  }
  if (promises.length) {
    lines.push('📌 欠着的承诺：' + promises.map((p) => String(p.text).replace(/^承诺｜/, '').slice(0, 40)).join('；'));
  }
  return lines.join('\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const db = new DatabaseSync(new URL('./memory.db', import.meta.url).pathname);
  const cmd = process.argv[2];
  if (cmd === 'add') addGap(db, { topic: process.argv.slice(3).join(' ') || '测试缺口' });
  else console.log('缺口:', listGaps(db).map((g) => g.text), '\n议程:\n' + (buildAgenda(db) || '（空）'));
}
