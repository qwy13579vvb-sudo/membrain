/**
 * spacing.mjs —— 间隔重复 / 半衰期 / 测试效应 / 记忆巩固
 *
 * 模型：R(t) = e^(-t / S)   →  半衰期 t½ = S · ln2（天）
 * 复习（测试效应）：S' = S · (1 + k·(1-R))
 *      k_recall  被检索命中（被动再认）     1.0
 *      k_write   主动写出 / 用户确认        1.4
 *      k_fix     被纠正（冲突修正，最强）    1.8
 * 巩固（毕业）：review_count ≥ 4 且 S ≥ 8 → pinned，脱离遗忘
 * 排期：下次复习 = last_review + S·ln2·0.9（到期时 R≈0.53，符合间隔重复）
 */
export const DAY = 86400000;
export const K = { recall: 1.0, write: 1.4, fix: 1.8 };

export function retention(row, now = Date.now()) {
  const S = Math.max(0.2, Number(row.strength) || 1);
  const last = row.last_review_at || row.ts_from || now;
  const dt = Math.max(0, (now - last) / DAY);
  return { R: Math.exp(-dt / S), S, dt };
}

export function halfLifeDays(row) {
  return (Math.max(0.2, Number(row.strength) || 1) * Math.LN2);
}

export function dueAt(row) {
  const S = Math.max(0.2, Number(row.strength) || 1);
  const last = row.last_review_at || row.ts_from || Date.now();
  return last + S * Math.LN2 * 0.9 * DAY;
}

export function isDue(row, now = Date.now()) {
  if (row.pinned) return false;
  return dueAt(row) <= now;
}

/** 复习一次后的新强度 */
export function reviewStrength(row, kind = 'recall', now = Date.now()) {
  const { R, S } = retention(row, now);
  const k = K[kind] ?? K.recall;
  // 间隔重复：间隔本身要扩张，否则半衰期永远停在几天
  const grow = 1 + k * (1 - R);
  const spacingMul = 1.6;
  return +Math.min(365, S * grow * spacingMul).toFixed(3);
}

/** 是否达到「毕业」（可巩固为永不衰减） */
export function graduates(row, newStrength) {
  const rc = (Number(row.review_count) || 0) + 1;
  return rc >= 4 && newStrength >= 8 && (Number(row.importance) || 0) >= 0.6;
}

/** CLI：列出今天到期的记忆（间隔重复队列） */
if (import.meta.url === `file://${process.argv[1]}`) {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(new URL('./memory.db', import.meta.url).pathname);
  const now = Date.now();
  const rows = db.prepare(`SELECT id, kind, text, strength, last_review_at, ts_from, review_count, importance, pinned, strength FROM node WHERE cold=0`).all();
  const due = rows.filter((r) => isDue(r, now)).sort((a, b) => dueAt(a) - dueAt(b));
  console.log(`到期复习: ${due.length} / ${rows.length}`);
  for (const r of due.slice(0, 12)) {
    const d = new Date(dueAt(r));
    console.log(`  ${d.toLocaleDateString('zh-CN')} | 半衰期 ${halfLifeDays(r).toFixed(1)}天 | ${String(r.text).slice(0, 40)}`);
  }
  const grad = rows.filter((r) => (r.review_count || 0) >= 4 && (r.strength || 0) >= 8 && !r.pinned);
  console.log(`可毕业: ${grad.length}`);
}

/**
 * 后台巩固（类似睡眠期的重放）
 * 只处理「到期且重要度 ≥0.45」的节点，强度增长压到 k=0.35，避免把所有记忆都变强。
 * 每轮回写 last_review_at（间隔因此自然扩张），达标者毕业成钉子，太弱的下沉冷库。
 */
export function replayDue(db, { limit = 40, now = Date.now(), coldThreshold = 0.12 } = {}) {
  const DAYMs = 86400000;
  const rows = db.prepare(`SELECT id, kind, text, strength, last_review_at, ts_from, review_count,
      importance, pinned, cold FROM node WHERE cold=0 AND pinned=0 AND importance >= 0.45`).all();
  const due = rows.filter((r) => isDue(r, now))
    .sort((a, b) => dueAt(a) - dueAt(b))
    .slice(0, limit);

  const upd = db.prepare(`UPDATE node SET strength=?, last_review_at=?, pinned=MAX(pinned, ?) WHERE id=?`);
  const coldUpd = db.prepare(`UPDATE node SET cold=1 WHERE id=?`);

  let replayed = 0, graduated = 0, sank = 0;
  db.exec('BEGIN');
  for (const r of due) {
    const { R, S } = retention(r, now);
    if (R < coldThreshold) { coldUpd.run(r.id); sank++; continue; }
    const S2 = +(Math.min(365, S * (1 + 0.35 * (1 - R)) * 1.15)).toFixed(3);
    const rc = Number(r.review_count) || 0;
    const grad = rc >= 4 && S2 >= 8 && (Number(r.importance) || 0) >= 0.6 ? 1 : 0;
    upd.run(S2, now, grad, r.id);
    replayed++; if (grad) graduated++;
  }
  db.exec('COMMIT');
  return { replayed, graduated, sank, checked: due.length, scanned: rows.length };
}

if (import.meta.url === `file://${process.argv[1]}` && process.argv.includes('--replay')) {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(new URL('./memory.db', import.meta.url).pathname);
  const r = replayDue(db);
  console.log(`后台巩固：检查 ${r.checked} / 重放 ${r.replayed} / 毕业 ${r.graduated} / 下沉 ${r.sank}`);
}
