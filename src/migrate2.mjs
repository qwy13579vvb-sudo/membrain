/** 第二批迁移：承诺/待办、钉子、时间解析所需字段 */
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync(process.env.MG_DB || 'memory.db');

const cols = db.prepare(`PRAGMA table_info(node)`).all().map((c) => c.name);
const add = (name, ddl) => {
  if (cols.includes(name)) { console.log('  已有', name); return; }
  db.exec(`ALTER TABLE node ADD COLUMN ${ddl}`);
  console.log('  + 新增', name);
};

add('pinned', 'pinned INTEGER DEFAULT 0');      // 1 = 永不衰减（承诺、身份、底线）
add('due', 'due INTEGER');                       // 承诺的截止时间
add('status', 'status TEXT');                    // open / done / dropped（承诺状态）
add('promise_of', 'promise_of TEXT');            // 承诺指向的对象（"生图"）

db.exec(`CREATE INDEX IF NOT EXISTS idx_node_pinned ON node(pinned)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_node_status ON node(status)`);
console.log('迁移完成');
