#!/usr/bin/env node
/**
 * mg.mjs —— 记忆星图最小可用版（MVP）
 *
 * 设计约束（照用户要求）：
 *   · 存储 SQLite + FTS5 + 自算向量，不上 Neo4j
 *   · 节点带：重要度 / 时间 / 来源 / 置信度 / 访问频率 / 是否用户确认
 *   · 边带：关系类型 + 时间（可衰减，节点保留）
 *   · 写入异步 + 去重 + 冲突标记
 *   · 检索：多路召回 → 子图扩展 1~2 跳 → 重排 → 只注入子图
 *   · 禁止全图遍历、禁止全量注入
 *
 * 用法：
 *   node mg.mjs init
 *   node mg.mjs ingest memory      # 字条
 *   node mg.mjs ingest near        # 近况.md
 *   node mg.mjs ingest session <session.v4.jsonl|.zst>
 *   node mg.mjs drain              # 处理写队列
 *   node mg.mjs recall "生日 米饭"  # 召回 + 打印注入块
 *   node mg.mjs stats
 */

import { DatabaseSync } from 'node:sqlite';
import { NOTE_FILE } from './config.mjs';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { retention, review, initialStrength } from './ebbinghaus.mjs';
import { scoreEmotion } from './emotion.mjs';
import { migrate } from './migrate.mjs';

const HOME = path.resolve(path.dirname(new URL(import.meta.url).pathname));
const DB_PATH = process.env.MG_DB || path.join(HOME, 'memory.db');
const SCHEMA = path.join(HOME, 'schema.sql');

const DIM = 256;          // 向量维度
const RRF_K = 60;         // RRF 常数
const HOP_DECAY = 0.55;   // 每多一跳的分数折扣
const DEFAULT_BUDGET = 1800; // 注入字符预算

// ---------------------------------------------------------------- 向量
let IDF = new Map();       // 词 → idf，由全库统计刷新
let IDF_READY = false;

function bigrams(s) {
  const t = s.replace(/[\s\p{P}]+/gu, ' ').trim();
  const out = [];
  for (const chunk of t.split(' ')) {
    if (!chunk) continue;
    if (chunk.length === 1) { out.push(chunk); continue; }
    for (let i = 0; i < chunk.length - 1; i++) out.push(chunk.slice(i, i + 2));
  }
  return out;
}

function hash32(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

export function vecOf(text) {
  const v = new Float32Array(DIM);
  const grams = bigrams(text);
  if (!grams.length) return Buffer.from(v.buffer);
  for (const g of grams) {
    const idf = IDF_READY ? (IDF.get(g) ?? 3.5) : 1;
    const h = hash32(g);
    v[h % DIM] += Math.min(idf, 6);
  }
  let n = 0;
  for (let i = 0; i < DIM; i++) n += v[i] * v[i];
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < DIM; i++) v[i] /= n;
  return Buffer.from(v.buffer);
}

function cos(aBuf, bBuf) {
  if (!aBuf || !bBuf || aBuf.length !== bBuf.length) return 0;
  const a = new Float32Array(aBuf.buffer, aBuf.byteOffset, aBuf.length / 4);
  const b = new Float32Array(bBuf.buffer, bBuf.byteOffset, bBuf.length / 4);
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

// ---------------------------------------------------------------- 库
export function open(dbPath = DB_PATH) {
  migrate(dbPath, SCHEMA);
  const db = new DatabaseSync(dbPath);
  db.exec(fs.readFileSync(SCHEMA, 'utf8'));
  return db;
}

function uidOf(kind, text) {
  return crypto.createHash('sha1').update(kind + '|' + text.trim().slice(0, 400)).digest('hex').slice(0, 20);
}

function normText(s) {
  return String(s).replace(/\*\*|`/g, '').replace(/\s+/g, ' ').trim().slice(0, 800);
}

// ---------------------------------------------------------------- 写入（进队列）
export function queue(db, item) {
  db.prepare(`INSERT INTO write_queue(payload, created_at) VALUES(?, ?)`)
    .run(JSON.stringify(item), Date.now());
}

/** 处理写队列：去重、冲突标记、建边 */
export function drain(db, { limit = 5000, verbose = false } = {}) {
  refreshIdf(db);
  const rows = db.prepare(`SELECT id, payload FROM write_queue WHERE status='pending' ORDER BY id LIMIT ?`).all(limit);
  let added = 0, deduped = 0, linked = 0;

  const ins = db.prepare(`INSERT INTO node(uid, kind, text, summary, ts_from, ts_to, source, source_ref, speaker,
      importance, confidence, user_confirmed, vec, meta, created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const byUid = db.prepare(`SELECT id FROM node WHERE uid=?`);
  const updConf = db.prepare(`UPDATE node SET confidence=MAX(confidence,?), importance=MAX(importance,?), text=? WHERE id=?`);
  const link = db.prepare(`INSERT OR REPLACE INTO edge(src,dst,rel,weight,ts) VALUES(?,?,?,?,?)`);
  const lastN = db.prepare(`SELECT id, vec, text, ts_from FROM node ORDER BY id DESC LIMIT 40`);

  db.exec('BEGIN');
  try {
    for (const r of rows) {
      const it = JSON.parse(r.payload);
      const text = normText(it.text);
      if (text.length < 4) {
        db.prepare(`UPDATE write_queue SET status='failed', error='too short', done_at=? WHERE id=?`).run(Date.now(), r.id);
        continue;
      }
      const kind = it.kind || 'event';
      const uid = uidOf(kind, text);
      const hit = byUid.get(uid);
      if (hit) {
        // 去重：同一件事再次出现 → 抬置信度 + 刷新文本
        updConf.run(it.confidence ?? 0.9, it.importance ?? 0.5, text, hit.id);
        db.prepare(`UPDATE write_queue SET status='deduped', done_at=? WHERE id=?`).run(Date.now(), r.id);
        deduped++;
        continue;
      }
      const ts = it.ts ?? Date.now();
      const emo = it.emotion === undefined ? scoreEmotion(text) : { valence: it.emotion, arousal: it.arousal ?? 0.4 };
      const st = initialStrength({ arousal: emo.arousal, importance: it.importance ?? 0.5, emotion: emo.valence });
      const info = ins.run(uid, kind, text, it.summary ?? null, ts, it.tsTo ?? null,
        it.source ?? 'memory', it.sourceRef ?? null, it.speaker ?? null,
        it.importance ?? 0.5, it.confidence ?? 0.8, it.userConfirmed ? 1 : 0,
        vecOf(text), it.meta ? JSON.stringify(it.meta) : null, Date.now());
      const nid = info.lastInsertRowid;
      added++;

      // 建边：与最近 40 个点算相似（相似边）/ 同源相邻（follows）
      for (const o of lastN.all()) {
        if (o.id === nid) continue;
        const sim = cos(vecOf(text), o.vec);
        if (sim >= 0.42) { link.run(nid, o.id, 'similar', +sim.toFixed(3), ts); linked++; }
      }
      // 冲突标记：同 kind 且高度相似但内容互斥 → contradicts
      if (kind === 'fact' || kind === 'preference') {
        for (const o of lastN.all()) {
          if (o.id === nid) continue;
          const sim = cos(vecOf(text), o.vec);
          if (sim > 0.72 && /不再|已经改成|现在不是|作废|改成/.test(text)) {
            link.run(nid, o.id, 'supersedes', 0.8, ts);
            db.prepare(`UPDATE node SET decay_state='superseded' WHERE id=?`).run(o.id);
          }
        }
      }
      db.prepare(`UPDATE write_queue SET status='done', done_at=? WHERE id=?`).run(Date.now(), r.id);
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  if (verbose) console.log(`  +${added} 新节点 / ${deduped} 去重 / ${linked} 相似边`);
  return { added, deduped, linked };
}

/** 全库 IDF（只统计一次，够用） */
export function refreshIdf(db) {
  const rows = db.prepare(`SELECT text FROM node`).all();
  const df = new Map();
  let n = 0;
  for (const r of rows) {
    n++;
    for (const g of new Set(bigrams(r.text))) df.set(g, (df.get(g) || 0) + 1);
  }
  IDF = new Map();
  for (const [g, c] of df) IDF.set(g, Math.log((n + 1) / (c + 0.5)));
  IDF_READY = n > 20;
}

// ---------------------------------------------------------------- 召回
function parseTimeHint(q) {
  const now = Date.now(), D = 86400000;
  if (/今天/.test(q)) return [now - D, now];
  if (/昨天/.test(q)) return [now - 2 * D, now - D];
  if (/前天/.test(q)) return [now - 3 * D, now - 2 * D];
  if (/这周|本周/.test(q)) return [now - 7 * D, now];
  if (/上周/.test(q)) return [now - 14 * D, now - 7 * D];
  if (/这个月|本月/.test(q)) return [now - 30 * D, now];
  const m = q.match(/(\d{4})-(\d{2})(?:-(\d{2}))?/);
  if (m) {
    const y = +m[1], mo = +m[2] - 1, d = m[3] ? +m[3] : 1;
    const from = new Date(y, mo, d).getTime();
    const to = m[3] ? from + D : new Date(y, mo + 1, 1).getTime();
    return [from, to];
  }
  const m2 = q.match(/(\d{1,2})月(\d{1,2})日/);
  if (m2) {
    const y = new Date().getFullYear();
    const from = new Date(y, +m2[1] - 1, +m2[2]).getTime();
    return [from, from + D];
  }
  return null;
}

function ftsQuery(q) {
  const grams = [...new Set(bigrams(q))].filter((g) => g.length > 1).slice(0, 12);
  if (!grams.length) return null;
  return grams.map((g) => `"${g.replace(/"/g, '')}"`).join(' OR ');
}

/**
 * 多路召回 → RRF 融合 → 子图扩展 → 重排 → 预算装箱
 * @returns {{lines:string[], nodes:any[], stats:object}}
 */
export function recall(db, query, opts = {}) {
  const t0 = Date.now();
  const budget = opts.budget ?? DEFAULT_BUDGET;
  const now = Date.now();
  const channels = {};
  const fused = new Map();   // id → score
  const bump = (id, rank, w = 1) => fused.set(id, (fused.get(id) || 0) + w / (RRF_K + rank));

  // ① 实体通道：FTS5
  const fq = ftsQuery(query);
  if (fq) {
    try {
      const rows = db.prepare(`SELECT rowid AS id FROM node_fts WHERE node_fts MATCH ? LIMIT 60`).all(fq);
      channels.entity = rows.length;
      rows.forEach((r, i) => bump(r.id, i, 1.0));
    } catch { channels.entity = 0; }
  } else channels.entity = 0;

  // ② 时间通道
  const tr = parseTimeHint(query);
  if (tr) {
    const rows = db.prepare(`SELECT id FROM node WHERE ts_from BETWEEN ? AND ? ORDER BY importance DESC LIMIT 60`).all(tr[0], tr[1]);
    channels.time = rows.length;
    rows.forEach((r, i) => bump(r.id, i, 0.9));
  } else channels.time = 0;

  // ③ 语义通道：余弦
  const qv = vecOf(query);
  const all = db.prepare(`SELECT id, vec, ts_from, importance, access_count FROM node
      WHERE vec IS NOT NULL AND cold=0 LIMIT 20000`).all();
  const sims = all.map((n) => ({ n, s: cos(qv, n.vec) })).filter((x) => x.s > 0.18)
    .sort((a, b) => b.s - a.s).slice(0, 60);
  channels.semantic = sims.length;
  sims.forEach((x, i) => bump(x.n.id, i, 1.0));

  // ④ 重要度通道（带新鲜度）—— 只在前几路召回不足时才开，避免噪声灌满
  if (fused.size < 8) {
    const impRows = db.prepare(`SELECT id, importance, ts_from FROM node
        WHERE decay_state='active' ORDER BY importance DESC, ts_from DESC LIMIT 20`).all();
    channels.importance = impRows.length;
    impRows.forEach((r, i) => bump(r.id, i, 0.45));
  } else channels.importance = 0;

  if (!fused.size) return { lines: [], nodes: [], stats: { channels, total: 0, ms: Date.now() - t0 } };

  // ---- 子图扩展：1~2 跳，有度上限、有权重阈
  const seeds = [...fused.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
  const edgeOut = db.prepare(`SELECT dst AS id, rel, weight FROM edge WHERE src=? AND decayed_at IS NULL ORDER BY weight DESC LIMIT 6`);
  const edgeIn = db.prepare(`SELECT src AS id, rel, weight FROM edge WHERE dst=? AND decayed_at IS NULL ORDER BY weight DESC LIMIT 6`);
  const hopScore = new Map(seeds);
  for (const [sid, sscore] of seeds) {
    for (const nb of [...edgeOut.all(sid), ...edgeIn.all(sid)]) {
      if (hopScore.has(nb.id)) continue;
      if ((nb.weight ?? 0) < 0.35) continue;
      hopScore.set(nb.id, sscore * HOP_DECAY * (0.5 + (nb.weight ?? 0.5)));
    }
  }
  // 第二跳（只从第一跳里最强的 5 个扩）
  const firstHop = [...hopScore.entries()].filter(([id]) => !fused.has(id))
    .sort((a, b) => b[1] - a[1]).slice(0, 5);
  for (const [hid, hscore] of firstHop) {
    for (const nb of [...edgeOut.all(hid), ...edgeIn.all(hid)]) {
      if (hopScore.has(nb.id)) continue;
      hopScore.set(nb.id, hscore * HOP_DECAY);
    }
  }

  // ---- 重排
  const getRow = db.prepare(`SELECT id, kind, text, ts_from, source, speaker, importance, confidence, user_confirmed,
      access_count, last_access, decay_state, layer, emotion, arousal, strength, review_count, last_review_at, cold
      FROM node WHERE id=?`);
  const cand = [];
  for (const [id, score] of hopScore) {
    const n = getRow.get(id);
    if (!n) continue;
    if (n.decay_state === 'superseded') continue;       // 作废点不进注入
    if (n.cold) continue;                                // 冷库不进注入
    // 艾宾浩斯：保留率越低，越该被"想起来"
    const R = retention(n, now);
    if (R < 0.06) continue;
    // 层级权重：画像层给身份类问题加分，原始层给细节类问题加分
    const LAYER_W = { 1: 1.0, 2: 0.95, 3: 0.9, 4: 0.85 };
    const lw = LAYER_W[n.layer] ?? 1;
    const ageDays = (now - n.ts_from) / 86400000;
    const recency = Math.exp(-ageDays / 120);
    const sim = cos(qv, db.prepare(`SELECT vec FROM node WHERE id=?`).get(id)?.vec);
    // 类别权重：事实/结论/纠正/偏好 > 日记 > 普通事件 > 碎聊天
    const KIND_W = { fact: 1.15, conclusion: 1.2, correction: 1.25, preference: 1.12, plan: 1.1, diary: 1.05, quote: 0.9, event: 0.85 };
    const kw = KIND_W[n.kind] ?? 0.9;
    // 长度惩罚：4 个字的「那算了吧」不该压过一条真事实
    const lenW = Math.max(0.35, Math.min(1, n.text.length / 45));
    // 说话人权重：主人说的 > 我说的；系统/工具内容不参与注入
    const spk = n.speaker === 'owner' ? 1.0 : n.speaker === 'self' ? 0.78 : 0.9;
    if (n.source === 'tool') continue;
    const final = (0.42 * score
      + 0.22 * sim
      + 0.14 * n.importance
      + 0.10 * recency
      + 0.07 * Math.min(1, n.access_count / 10)
      + 0.05 * (n.user_confirmed ? 1 : 0)
      + 0.10 * (1 - R)) * kw * lenW * spk * lw;   // 遗忘驱动的"浮现"权重
    cand.push({ ...n, score: +final.toFixed(4), sim: +sim.toFixed(3) });
  }
  cand.sort((a, b) => b.score - a.score);

  // ---- 预算装箱（按字符，不做全量注入）
  const lines = [];
  let chars = 0, used = 0;
  const bumpAccess = db.prepare(`UPDATE node SET access_count=access_count+1, last_access=? WHERE id=?`);
  for (const n of cand) {
    const d = new Date(n.ts_from);
    const stamp = `${d.getMonth() + 1}/${d.getDate()}`;
    const line = `• [${stamp}·${n.kind}] ${n.text.slice(0, 160)}`;
    if (chars + line.length > budget) break;
    lines.push(line);
    chars += line.length + 1;
    used++;
    bumpAccess.run(now, n.id);
    const rv = review(n, now);
    db.prepare(`UPDATE node SET strength=?, last_review_at=?, review_count=? WHERE id=?`)
      .run(rv.strength, rv.last_review_at, rv.review_count, n.id);
    if (used >= (opts.maxNodes ?? 24)) break;
  }

  const stats = { channels, seeds: seeds.length, expanded: hopScore.size, candidates: cand.length,
    injected: used, chars, ms: Date.now() - t0 };
  db.prepare(`INSERT INTO recall_log(ts, query, channels, injected, chars, ms) VALUES(?,?,?,?,?,?)`)
    .run(now, query, JSON.stringify(channels), used, chars, stats.ms);
  return { lines, nodes: cand.slice(0, used), stats };
}

// ---------------------------------------------------------------- 采集器
const KIND_RULES = [
  [/生日|纪念日|端口|路径|包名|命令|版本|地址|API|凭证|权限|文件名|哈希/, 'fact'],
  [/教训|结论|别再|不要|应该|下次|踩坑|真因|必须|正确/, 'conclusion'],
  [/说好|约定|计划|提醒|打算|那天/, 'plan'],
  [/喜欢|讨厌|在意|偏好|心软|生气|撒娇|口味|爱吃/, 'preference'],
  [/纠正|其实不是|我说错|改成|作废/, 'correction'],
];

function kindOf(t) {
  for (const [re, k] of KIND_RULES) if (re.test(t)) return k;
  return 'event';
}
function importanceOf(kind, t) {
  let s = kind === 'fact' ? 0.75 : kind === 'conclusion' ? 0.8 : kind === 'correction' ? 0.9
    : kind === 'preference' ? 0.7 : kind === 'plan' ? 0.7 : 0.45;
  if (/米饭|生日|约定|名字/.test(t)) s = Math.min(1, s + 0.15);
  return +s.toFixed(2);
}

/** 字条：- YYYY-MM-DD：内容 */
export function collectMemory(db, file) {
  const txt = fs.readFileSync(file, 'utf8');
  let n = 0;
  txt.split('\n').forEach((line, i) => {
    const m = line.match(/^\s*-\s*(\d{4}-\d{2}-\d{2})[：:]\s*(.+)$/);
    if (!m) return;
    const text = normText(m[2]);
    if (text.length < 6) return;
    const ts = new Date(`${m[1]}T13:00:00+08:00`).getTime();
    const kind = kindOf(text);
    queue(db, { kind, text, ts, source: 'memory', sourceRef: `${path.basename(file)}:${i + 1}`,
      importance: importanceOf(kind, text), confidence: 0.9, userConfirmed: true });
    n++;
    for (const q of (m[2].match(/「([^」]{4,80})」/g) || [])) {
      const qt = normText(q.slice(1, -1));
      if (qt.length < 4) continue;
      queue(db, { kind: 'quote', text: qt, ts, source: 'memory', sourceRef: `${path.basename(file)}:${i + 1}`,
        speaker: 'owner', importance: 0.65, confidence: 0.95, userConfirmed: true });
      n++;
    }
  });
  return n;
}

/** 近况 / 任意 markdown 的日期行 → diary */
export function collectNear(db, file) {
  const txt = fs.readFileSync(file, 'utf8');
  let n = 0;
  txt.split('\n').forEach((line, i) => {
    const m = line.match(/^\s*-\s*(\d{4}-\d{2}-\d{2})[：:]\s*(.+)$/);
    if (!m) return;
    const text = normText(m[2]);
    if (text.length < 10) return;
    queue(db, { kind: 'diary', text, ts: new Date(`${m[1]}T21:00:00+08:00`).getTime(),
      source: 'diary', sourceRef: `${path.basename(file)}:${i + 1}`, importance: 0.55, confidence: 0.95 });
    n++;
  });
  return n;
}

/** 会话 jsonl（支持多帧 zstd） */
export function collectSession(db, file) {
  let raw;
  if (file.endsWith('.zst') || file.endsWith('.zstd')) raw = decodeFrames(fs.readFileSync(file));
  else raw = fs.readFileSync(file);
  const lines = raw.toString('utf8').split('\n');
  let n = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (o.type !== 'user/message' && o.type !== 'assistant/message') continue;
    const raw = extractText(o);
    const text = normText(raw);
    if (text.length < 4) continue;
    const isUser = o.type === 'user/message';
    // 过滤：工具日志 / 系统注入 / 代码块 / 大段英文，这些不是记忆
    if (/<system-reminder>|Progress:|^ok |Downloaded and extracted|```|\[stderr\]/i.test(raw)) continue;
    const ascii = (text.match(/[A-Za-z0-9\s]/g) || []).length / text.length;
    if (ascii > 0.72 && text.length > 40) continue;
    if (!isUser && text.length > 220) continue;   // 我的长回复不进图，只留对话
    // 任务指令不是记忆（「写个网页」「实现一个…」这类）
    if (isUser && /需求[:：]|要求[:：]|写一个|写个|实现一个|代码精简|函数|帮我做|请输出|用\s*HTML|Three\.js|MediaPipe/.test(text)) continue;
    const ts = typeof o.time === 'number' ? o.time : Date.now();
    const kind = isUser ? kindOf(text) : 'event';
    queue(db, { kind, text, ts, source: 'chat', sourceRef: `${path.basename(file)}`,
      speaker: isUser ? 'owner' : 'self',
      importance: isUser ? importanceOf(kind, text) : 0.35,
      confidence: 0.99, userConfirmed: isUser });
    n++;
  }
  return n;
}

function extractText(o) {
  const d = o.data ?? o;
  if (typeof d.text === 'string') return d.text;
  const c = d.content ?? d.message?.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((x) => (typeof x === 'string' ? x : x?.text ?? '')).join(' ');
  return '';
}

/** zstd 多帧（Node 整块解只吃第一帧） */
function decodeFrames(buf) {
  const MAG = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
  const offs = [];
  let i = 0;
  while ((i = buf.indexOf(MAG, i)) !== -1) { offs.push(i); i++; }
  if (!offs.length) return zlib.zstdDecompressSync(buf);
  const out = [];
  for (let k = 0; k < offs.length; k++) {
    const end = k + 1 < offs.length ? offs[k + 1] : buf.length;
    try { out.push(zlib.zstdDecompressSync(buf.subarray(offs[k], end))); } catch { /* 尾帧可能不完整 */ }
  }
  return Buffer.concat(out);
}

// ---------------------------------------------------------------- CLI
function stats(db) {
  const q = (s) => db.prepare(s).get();
  const total = q(`SELECT COUNT(*) c FROM node`).c;
  const edges = q(`SELECT COUNT(*) c FROM edge`).c;
  const sup = q(`SELECT COUNT(*) c FROM node WHERE decay_state='superseded'`).c;
  const pending = q(`SELECT COUNT(*) c FROM write_queue WHERE status='pending'`).c;
  const byKind = db.prepare(`SELECT kind, COUNT(*) c FROM node GROUP BY kind ORDER BY c DESC`).all();
  const byLayer = db.prepare(`SELECT layer, COUNT(*) c FROM node GROUP BY layer ORDER BY layer`).all();
  const cold = q(`SELECT COUNT(*) c FROM node WHERE cold=1`).c;
  const emo = q(`SELECT ROUND(AVG(emotion),3) v, ROUND(AVG(arousal),3) a FROM node WHERE layer=1`).v;
  console.log(`节点 ${total}  边 ${edges}  作废 ${sup}  冷库 ${cold}  待写 ${pending}`);
  console.log('层级: ' + byLayer.map((r) => `L${r.layer} ${r.c}`).join(' / '));
  console.log('类型: ' + byKind.map((r) => `${r.kind} ${r.c}`).join(' / '));
  console.log(`平均情绪 ${emo}（负=低落 正=愉快）`);
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  const db = open();
  if (cmd === 'init') { console.log('库已建:', DB_PATH); return; }
  if (cmd === 'ingest') {
    const what = args[0];
    let n = 0;
    if (what === 'memory') n = collectMemory(db, args[1] || NOTE_FILE);
    else if (what === 'near') n = collectNear(db, args[1] || path.join(process.cwd(), '近况.md'));
    else if (what === 'session') n = collectSession(db, args[1]);
    else { console.error('ingest memory|near|session <path>'); process.exit(1); }
    console.log(`已入队 ${n} 条`);
    const r = drain(db, { verbose: true });
    return;
  }
  if (cmd === 'drain') { console.log(drain(db, { verbose: true })); return; }
  if (cmd === 'recall') {
    const q = args.join(' ') || '米饭';
    refreshIdf(db);
    const r = recall(db, q);
    console.log(`\n[召回] "${q}"`);
    console.log(`  通道: ${JSON.stringify(r.stats.channels)}  候选 ${r.stats.candidates}  注入 ${r.stats.injected}  耗时 ${r.stats.ms}ms`);
    console.log('  ---- 注入块 ----');
    r.lines.forEach((l) => console.log('  ' + l));
    return;
  }
  if (cmd === 'remember') {
    refreshIdf(db);
    const [kind, importance, text] = [args[0] || 'event', Number(args[1] || 0.6), args.slice(2).join(' ')];
    if (!text.trim()) { console.error('用法: remember <kind> <importance> <文本>'); process.exit(1); }
    queue(db, { kind, text, ts: Date.now(), source: 'manual', importance, confidence: 1, userConfirmed: true });
    const r = drain(db, { verbose: false });
    // 写完立刻重建副库，否则新记忆要等 10 分钟才能被检索到
    try { const { build } = await import('./index.mjs'); build(); } catch (e) { /* 忽略 */ }
    const row = db.prepare(`SELECT id, layer, strength, emotion FROM node WHERE text LIKE ? ORDER BY id DESC LIMIT 1`)
      .get(text.slice(0, 40) + '%');
    console.log(`✅ 已写入 新增 ${r.added} 去重 ${r.deduped} 边 ${r.linked}` + (row ? `（id=${row.id} 强度=${row.strength} 情绪=${row.emotion}）` : ''));
    return;
  }
  if (cmd === 'search') {
    refreshIdf(db);
    const q = args.join(' ');
    const r = recall(db, q, { budget: 2400, maxNodes: 30 });
    console.log(JSON.stringify({ query: q, stats: r.stats, block: r.lines.join('\n') }, null, 1));
    return;
  }
  if (cmd === 'stats') { stats(db); return; }
  console.log('用法: init | ingest memory|near|session <path> | drain | recall <query> | stats');
}

if (import.meta.url === `file://${process.argv[1]}`) main();
