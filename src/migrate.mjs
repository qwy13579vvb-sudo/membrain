/** schema v2 迁移：四层 + 艾宾浩斯 + 情绪（幂等） */
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';

export function migrate(dbPath, schemaPath) {
  const db = new DatabaseSync(dbPath);
  db.exec(fs.readFileSync(schemaPath, 'utf8'));

  const cols = db.prepare(`PRAGMA table_info(node)`).all().map((c) => c.name);
  const add = (name, ddl) => {
    if (!cols.includes(name)) { db.exec(`ALTER TABLE node ADD COLUMN ${ddl}`); return true; }
    return false;
  };
  const added = [];
  if (add('layer',     `layer INTEGER NOT NULL DEFAULT 1`)) added.push('layer');
  if (add('emotion',   `emotion REAL NOT NULL DEFAULT 0`)) added.push('emotion');      // -1..1 效价
  if (add('arousal',   `arousal REAL NOT NULL DEFAULT 0.3`)) added.push('arousal');    // 0..1 唤醒度
  if (add('strength',  `strength REAL NOT NULL DEFAULT 1`)) added.push('strength');    // 记忆强度 S
  if (add('last_review_at', `last_review_at INTEGER`)) added.push('last_review_at');
  if (add('review_count',   `review_count INTEGER NOT NULL DEFAULT 0`)) added.push('review_count');
  if (add('cold',      `cold INTEGER NOT NULL DEFAULT 0`)) added.push('cold');         // 冷库标记
  if (add('source_ids', `source_ids TEXT`)) added.push('source_ids');                  // 上层节点的来源
  if (add('topic',     `topic TEXT`)) added.push('topic');

  db.exec(`CREATE INDEX IF NOT EXISTS idx_node_layer ON node(layer)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_node_strength ON node(strength DESC)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_node_cold ON node(cold)`);

  db.exec(`CREATE TABLE IF NOT EXISTS layer_run (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    layer INTEGER NOT NULL,
    from_ts INTEGER, to_ts INTEGER,
    made INTEGER, ts INTEGER
  )`);

  db.exec(`CREATE TABLE IF NOT EXISTS emotion_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    node_id INTEGER, valence REAL, arousal REAL, ts INTEGER
  )`);

  return { db, added };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const r = migrate('memory.db', 'schema.sql');
  console.log('迁移完成，新增列:', r.added.join(', ') || '（无）');
  const c = r.db.prepare(`SELECT layer, COUNT(*) c FROM node GROUP BY layer`).all();
  console.log('层级分布:', c.map((x) => `L${x.layer} ${x.c}`).join(' / '));
}
