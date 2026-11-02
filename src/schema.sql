-- 记忆星图 · schema v0.1
-- SQLite + FTS5 + 自算向量（不上 Neo4j）
-- 节点 = 一次经历/一条偏好/一个事实/一条纠正；边 = 关系（带类型和时间，可衰减）

PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;

-- ============ 节点 ============
CREATE TABLE IF NOT EXISTS node (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  uid           TEXT    NOT NULL UNIQUE,      -- 稳定指纹（kind + 归一化文本的 hash）
  kind          TEXT    NOT NULL,             -- event|preference|fact|correction|tool|plan|diary|quote|conclusion
  text          TEXT    NOT NULL,             -- 归一化全文（注入用）
  summary       TEXT,                         -- 可选短摘要

  ts_from       INTEGER NOT NULL,             -- 发生/首次提及（ms）
  ts_to         INTEGER,                      -- 结束时间（区间事件用）
  source        TEXT    NOT NULL,             -- memory|chat|near|tool|manual
  source_ref    TEXT,                         -- 文件路径:行号 / session:id / 工具名
  speaker       TEXT,                         -- owner|self|system

  importance    REAL    NOT NULL DEFAULT 0.5, -- 0..1 重要度
  confidence    REAL    NOT NULL DEFAULT 0.8, -- 0..1 置信度
  user_confirmed INTEGER NOT NULL DEFAULT 0,  -- 用户明确确认过？
  access_count  INTEGER NOT NULL DEFAULT 0,   -- 被召回次数
  last_access   INTEGER,                      -- 上次召回（ms）
  decay_state   TEXT    NOT NULL DEFAULT 'active', -- active|stale|superseded|expired

  vec           BLOB,                         -- Float32Array(256) 归一化
  meta          TEXT,                         -- 额外 JSON
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_node_kind   ON node(kind);
CREATE INDEX IF NOT EXISTS idx_node_ts     ON node(ts_from);
CREATE INDEX IF NOT EXISTS idx_node_imp    ON node(importance DESC, ts_from DESC);
CREATE INDEX IF NOT EXISTS idx_node_access ON node(access_count DESC);
CREATE INDEX IF NOT EXISTS idx_node_decay  ON node(decay_state);

-- ============ 边 ============
CREATE TABLE IF NOT EXISTS edge (
  src        INTEGER NOT NULL REFERENCES node(id) ON DELETE CASCADE,
  dst        INTEGER NOT NULL REFERENCES node(id) ON DELETE CASCADE,
  rel        TEXT    NOT NULL,   -- mentions|follows|similar|same_topic|corrects|supersedes|derived|tool_of|contradicts
  weight     REAL    NOT NULL DEFAULT 0.5,
  ts         INTEGER NOT NULL,   -- 关系建立时间
  decayed_at INTEGER,            -- 衰减/失效时间（NULL=有效）
  PRIMARY KEY (src, dst, rel)
);
CREATE INDEX IF NOT EXISTS idx_edge_src ON edge(src, weight DESC);
CREATE INDEX IF NOT EXISTS idx_edge_dst ON edge(dst, weight DESC);

-- ============ 全文索引 ============
CREATE VIRTUAL TABLE IF NOT EXISTS node_fts USING fts5(
  text,
  content='node',
  content_rowid='id',
  tokenize='unicode61'
);
CREATE TRIGGER IF NOT EXISTS node_ai AFTER INSERT ON node BEGIN
  INSERT INTO node_fts(rowid, text) VALUES (new.id, new.text);
END;
CREATE TRIGGER IF NOT EXISTS node_ad AFTER DELETE ON node BEGIN
  INSERT INTO node_fts(node_fts, rowid, text) VALUES ('delete', old.id, old.text);
END;
CREATE TRIGGER IF NOT EXISTS node_au AFTER UPDATE OF text ON node BEGIN
  INSERT INTO node_fts(node_fts, rowid, text) VALUES ('delete', old.id, old.text);
  INSERT INTO node_fts(rowid, text) VALUES (new.id, new.text);
END;

-- ============ 异步写入队列 ============
CREATE TABLE IF NOT EXISTS write_queue (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  payload    TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'pending', -- pending|done|failed|deduped
  error      TEXT,
  created_at INTEGER NOT NULL,
  done_at    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_wq_status ON write_queue(status, id);

-- ============ 召回日志（用来调参 / 看命中率）============
CREATE TABLE IF NOT EXISTS recall_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          INTEGER NOT NULL,
  query       TEXT NOT NULL,
  channels    TEXT,     -- 每个通道命中数
  injected    INTEGER,  -- 最终注入节点数
  chars       INTEGER,
  ms          INTEGER
);
