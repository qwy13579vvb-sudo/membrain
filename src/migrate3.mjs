/** migrate3：给 node 加「替代链」与「证据标注」两种字段 */
import { DatabaseSync } from 'node:sqlite';

export function migrate3(db) {
  const cols = db.prepare('PRAGMA table_info(node)').all().map((c) => c.name);
  const add = (name, ddl) => { if (!cols.includes(name)) db.exec(`ALTER TABLE node ADD COLUMN ${ddl}`); };
  add('supersedes', 'supersedes INTEGER');                 // 我替代了哪一条
  add('superseded_by', 'superseded_by INTEGER');           // 我被哪一条替代
  add('confidence', 'confidence REAL DEFAULT 0.6');        // 可信度 0~1
  add('origin', "origin TEXT DEFAULT 'model'");            // user | model | web | file | tool
  db.exec('CREATE INDEX IF NOT EXISTS idx_node_sup ON node(superseded_by)');
  return true;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const db = new DatabaseSync(process.env.MG_DB || './memory.db');
  migrate3(db);
  const n = db.prepare('SELECT COUNT(*) c FROM node').get().c;
  console.log('✅ 字段已就绪 | 节点', n);
  db.close();
}
