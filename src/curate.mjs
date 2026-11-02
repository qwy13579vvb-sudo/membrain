/** curate.mjs —— 让模型当编辑，砍重复/低价值/错分类的条目 */
import { DatabaseSync } from 'node:sqlite';
import { chatJSON } from './llm.mjs';

export async function curate(db, { kinds = ['preference'], batch = 40, maxDropRatio = 0.2 } = {}) {
  let dropped = 0;
  for (const kind of kinds) {
    const rows = db.prepare(`SELECT id, text FROM node WHERE kind=? ORDER BY id`).all(kind);
    if (rows.length < 3) continue;
    for (let i = 0; i < rows.length; i += batch) {
      const chunk = rows.slice(i, i + batch);
      const list = chunk.map((r) => `#${r.id} ${String(r.text).slice(0, 110)}`).join('\n');
      let out = null;
      try {
        out = await chatJSON({
          system: '你是记忆库编辑。只输出 JSON {"drop":[id,...]}。判据：①语义重复只留一条（留信息更全的）②不是「规则/偏好」而是一句闲聊或任务指令 ③空泛到没有行动指导。最多删 40%，不确定的不要删。',
          user: `类型：${kind}\n${list}`,
          maxTokens: 500,
        });
      } catch (e) { console.log('  编辑失败:', e.message); break; }
      let drop = (out?.drop || []).map(Number).filter((n) => chunk.some((c) => c.id === n));
      // 硬护栏：单批最多删 20%，且规则类永不自动删
      const cap = Math.max(1, Math.floor(chunk.length * maxDropRatio));
      if (drop.length > cap) drop = drop.slice(0, cap);
      if (kind === 'rule') drop = [];
      for (const id of drop) { db.prepare('DELETE FROM node WHERE id=?').run(id); dropped++; }
      if (drop.length) console.log(`  ${kind} 删除 ${drop.length} 条`);
    }
  }
  return { dropped };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const db = new DatabaseSync(new URL('./memory.db', import.meta.url).pathname);
  const r = await curate(db);
  console.log('共删', r.dropped, '条');
  for (const k of ['rule', 'preference']) console.log(' 剩余', k, db.prepare('SELECT COUNT(*) c FROM node WHERE kind=?').get(k).c);
}
