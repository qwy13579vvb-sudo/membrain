/**
 * label.mjs —— 给每条记忆标注「出处」与「可信度」
 * 不是猜：按写入路径与说话人定。用户原话最高，模型归纳最低。
 */
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const DB = process.env.MG_DB || (process.env.MG_DB || path.join(process.cwd(), 'memory.db'));

const RULES = [
  // 用户原话：最高可信
  { test: (r) => r.source === 'chat' && r.speaker === 'owner', origin: 'user', conf: 0.92 },
  // 我自己的转述/整理
  { test: (r) => r.source === 'chat' && r.speaker === 'self', origin: 'model', conf: 0.68 },
  { test: (r) => r.source === 'manual', origin: 'model', conf: 0.8 },
  { test: (r) => r.source === 'memory', origin: 'model', conf: 0.75 },
  { test: (r) => r.source === 'layer', origin: 'model', conf: 0.7 },
  // 归纳出来的规则/偏好（最可能是过度概括）
  { test: (r) => r.source === 'distill', origin: 'model', conf: 0.55 },
  { test: (r) => r.source === 'induce' || r.kind === 'hypothesis', origin: 'model', conf: 0.45 },
  // 工具产出的确定性事实
  { test: (r) => r.source === 'caps' || r.kind === 'capability', origin: 'tool', conf: 0.85 },
  { test: (r) => r.source === 'plan', origin: 'tool', conf: 0.8 },
  { test: (r) => r.source === 'gap', origin: 'tool', conf: 0.7 },
  { test: (r) => r.source === 'propose.mjs', origin: 'model', conf: 0.65 },
  { test: (r) => /research/.test(r.source || ''), origin: 'web', conf: 0.5 },
];

export function labelAll(db) {
  const rows = db.prepare('SELECT id, kind, source, speaker, origin, confidence FROM node').all();
  const upd = db.prepare('UPDATE node SET origin=?, confidence=? WHERE id=?');
  let n = 0;
  for (const r of rows) {
    let hit = RULES.find((x) => x.test(r));
    const origin = hit ? hit.origin : 'model';
    const conf = hit ? hit.conf : 0.6;
    if (r.origin !== origin || Math.abs((r.confidence ?? 0) - conf) > 0.001) { upd.run(origin, conf, r.id); n++; }
  }
  return n;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const db = new DatabaseSync(DB);
  console.log('更新', labelAll(db), '条标注');
  console.log(JSON.stringify(db.prepare('SELECT origin, COUNT(*) c FROM node GROUP BY origin').all()));
  db.close();
}
