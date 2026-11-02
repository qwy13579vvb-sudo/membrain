/**
 * index.mjs —— 副库（精简索引层）
 *
 * 双库架构：
 *   主库 memory.db     完整记忆（原始全文 + 四层 + 艾宾浩斯 + 情绪）
 *   副库 index.json    几十 KB：只有 id / 标签 / 摘要片段 / 权重 / 时间
 *
 * 检索两步走：
 *   1) 副库定位（便宜：几十 KB，纯字符串匹配）
 *   2) 按副库给的 id 去主库取原文（只取命中的那几条）
 * 这样永远不会把主库整个过一遍。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parseTimeRange } from './timeparse.mjs';
import { reviewStrength, graduates } from './spacing.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname);
export const INDEX_PATH = process.env.MG_INDEX || (process.env.MG_INDEX || path.join(process.cwd(), 'index.json'));

const DAY = 86400000;

// 虚词/无信息标签，不进索引（实测「10」「我要」「一个」「这个」占满高频位）
const STOP = new Set(['一个','这个','那个','我要','我们','你们','他们','就是','可以','不是','没有',
  '什么','怎么','现在','已经','还是','这样','那样','因为','所以','但是','然后','如果','只是',
  '一下','这些','那些','自己','时候','东西','地方','问题','因为','不过','真的','其实','感觉']);

function bigrams(s) {
  const t = String(s).replace(/[\s\p{P}]+/gu, ' ').trim();
  const out = new Set();
  for (const c of t.split(' ')) {
    if (!c) continue;
    if (c.length === 1) { out.add(c); continue; }
    for (let i = 0; i < c.length - 1; i++) out.add(c.slice(i, i + 2));
  }
  return out;
}

/** 从主库重建副库 */
export function build(dbPath = (process.env.MG_DB || path.join(process.cwd(), 'memory.db'))) {
  const db = new DatabaseSync(dbPath);
  const now = Date.now();
  const rows = db.prepare(`SELECT id, kind, text, ts_from, layer, emotion, arousal, importance,
      strength, review_count, last_review_at, cold, topic, speaker, source, access_count, pinned, status, promise_of
      FROM node WHERE cold = 0`).all();

  const entries = [];
  const tagCount = new Map();

  for (const r of rows) {
    // 摘要片段：L1 取前 46 字；上层取前 90 字（上层本身就是浓缩过的）
    const snipLen = r.layer >= 3 ? 90 : 46;
    const snippet = (r.text || '').replace(/\s+/g, ' ').slice(0, snipLen);
    const tags = [...bigrams(r.text)]
      .filter((g) => g.length === 2 && !STOP.has(g) && !/^\d+$/.test(g))
      .slice(0, 12);
    for (const t of tags) tagCount.set(t, (tagCount.get(t) || 0) + 1);

    const last = r.last_review_at || r.ts_from;
    const S = Math.max(0.2, r.strength || 1);
    const R = Math.exp(-Math.max(0, (now - last) / DAY) / S);
    // 索引权重：重要度为主，层级与保留率为辅
    const heat = Math.min(1, (r.access_count || 0) / 8);
    const pinned = r.pinned ? 1 : 0;   // 被查过几次
    const arousal = Math.min(1, Math.max(0, r.arousal || 0));
    const weight = +(0.40 * (r.importance || 0.5)
      + 0.20 * ({ 4: 1, 3: 0.8, 2: 0.6, 1: 0.4 }[r.layer] ?? 0.4)
      + 0.20 * R
      + 0.20 * heat
      + 0.00 * arousal).toFixed(4);   // 情绪不压权重，只在检索时加成
    const wFinal = pinned ? Math.max(weight, 0.95) : weight;

    entries.push({
      i: r.id, l: r.layer, k: r.kind, t: r.ts_from, w: wFinal,
      p: pinned || undefined, st: r.status || undefined, po: r.promise_of || undefined,
      e: +(r.emotion || 0).toFixed(2), a: arousal, s: snippet,
      g: tags.slice(0, 8),           // 标签（词）
    });
  }

  // 多线性标签：出现 >=3 次的词，连到用到它的条目（反向索引）
  const tagIndex = {};
  for (const e of entries) {
    for (const g of e.g) {
      if ((tagCount.get(g) || 0) < 3) continue;
      (tagIndex[g] ||= []).push(e.i);
    }
  }

  const payload = {
    builtAt: now,
    counts: { total: entries.length, byLayer: entries.reduce((a, e) => (a['L' + e.l] = (a['L' + e.l] || 0) + 1, a), {}) },
    tags: tagIndex,
    entries,
  };
  fs.writeFileSync(INDEX_PATH, JSON.stringify(payload), 'utf-8');
  const bytes = fs.statSync(INDEX_PATH).size;
  return { entries: entries.length, tags: Object.keys(tagIndex).length, bytes };
}

export function load() {
  return JSON.parse(fs.readFileSync(INDEX_PATH, 'utf-8'));
}

/** 第一步：只在副库里定位（不动主库） */
export function locate(query, { limit = 24, range = null } = {}) {
  // 查询本身带不带情绪？带情绪时，情绪强烈的记忆更容易被想起
  const qArousal = /[！!？?]|太|真的|居然|竟然|好|痛|怕|气|喜|哭|笑|爱|恨|难过|开心|激动/.test(query) ? 0.6 : 0.2;
  const idx = load();
  const grams = [...bigrams(query)];
  if (!grams.length) return { hits: [], idx };

  const scored = [];
  for (const e of idx.entries) {
    if (range && (e.t < range.since || e.t > range.until)) continue;
    let sc = 0;
    for (const g of grams) {
      if (e.s.includes(g)) sc += 2;
      if (e.g.includes(g)) sc += 3;   // 标签命中更可信
    }
    if (!sc) continue;
    const emoBoost = 1 + 0.35 * qArousal * (e.a || 0);   // 情绪加权
    scored.push({ e, sc: sc * (0.4 + e.w) * emoBoost });
  }
  // 有明确时间词时，允许「按时间列」补位（不要求关键词命中）
  if (range) {
    const inRange = idx.entries.filter((e) => e.t >= range.since && e.t <= range.until);
    if (inRange.length) {
      const seen = new Set(scored.map((x) => x.e.i));
      const fill = inRange
        .filter((e) => !seen.has(e.i))
        .sort((a, b) => (b.p ? 1 : 0) - (a.p ? 1 : 0) || b.w - a.w)
        .slice(0, Math.max(6, limit - scored.length))
        .map((e) => ({ e, sc: 0.5 + e.w }));
      scored.push(...fill);
    }
  }
  scored.sort((a, b) => b.sc - a.sc);

  // 标签扩展：命中的条目里，高频共同标签的其他条目也算（多线性）
  const hitIds = new Set(scored.slice(0, limit).map((x) => x.e.i));
  const expand = new Map();
  for (const e of scored.slice(0, 6).map((x) => x.e)) {
    for (const g of e.g) {
      for (const id of (idx.tags[g] || [])) {
        if (hitIds.has(id)) continue;
        expand.set(id, (expand.get(id) || 0) + 1);
      }
    }
  }
  const expanded = [...expand.entries()]
    .filter(([, c]) => c >= 2)
    .sort((a, b) => b[1] - a[1]).slice(0, 8)
    .map(([id]) => idx.entries.find((e) => e.i === id)).filter(Boolean);

  return { hits: scored.slice(0, limit).map((x) => x.e), expanded, idx };
}

/** 第二步：按 id 去主库取原文 */
export function fetchFull(ids, dbPath = (process.env.MG_DB || path.join(process.cwd(), 'memory.db'))) {
  if (!ids.length) return [];
  const db = new DatabaseSync(dbPath);
  const out = [];
  for (const id of ids) {
    const r = db.prepare(`SELECT id, kind, text, ts_from, layer, emotion, arousal, importance,
      strength, review_count, last_review_at, pinned FROM node WHERE id = ?`).get(id);
    if (r) out.push(r);
  }
  return out;
}

/** 沿主库边走一跳：词图联想 */
function hop(db, ids, k = 6) {
  if (!ids.length) return [];
  const out = new Map();
  const st = db.prepare(`SELECT dst AS other, weight FROM edge WHERE src=? UNION
                         SELECT src AS other, weight FROM edge WHERE dst=?`);
  for (const id of ids.slice(0, 12)) {
    for (const r of st.all(id, id)) {
      if (ids.includes(r.other)) continue;
      out.set(r.other, Math.max(out.get(r.other) || 0, r.weight || 0));
    }
  }
  return [...out.entries()].sort((a, b) => b[1] - a[1]).slice(0, k).map(([id]) => id);
}

/** 两步检索：副库定位 → 主库取片段 → 预算装箱 */
export function search2(query, { maxChars = 2400, maxItems = 24, graphHop = true } = {}) {
  const t0 = Date.now();
  const range = parseTimeRange(query);
  const { hits, expanded, idx } = locate(query, { range });
  let ids = [...hits.map((h) => h.i), ...expanded.map((h) => h.i)];
  const db = new DatabaseSync((process.env.MG_DB || path.join(process.cwd(), 'memory.db')));
  let hopped = 0;
  if (graphHop) {
    const extra = hop(db, ids, 6);
    if (extra.length) { ids = [...ids, ...extra]; hopped = extra.length; }
  }
  const rows = fetchFull(ids);
  // 命中即复习：真的走一遍遗忘曲线（强度上调、复习次数 +1）
  if (rows.length) {
    try {
      const now = Date.now();
      const DAY = 86400000;
      for (const r of rows) {
        const S2 = reviewStrength(r, 'recall', now);   // 测试效应：被动再认 k=1.0
        const grad = graduates({ ...r, review_count: r.review_count || 0 }, S2) ? 1 : 0;
        db.prepare(`UPDATE node SET access_count=access_count+1, last_access=?,
          review_count=review_count+1, last_review_at=?, strength=?, pinned=MAX(pinned, ?) WHERE id=?`)
          .run(now, now, S2, grad, r.id);
      }
    } catch { /* 忽略 */ }
  }

  const lines = [];
  let chars = 0;
  for (const r of rows) {
    const d = new Date(r.ts_from);
    const stamp = `${d.getMonth() + 1}/${d.getDate()}`;
    const line = `• [${stamp}·L${r.layer}·${r.kind}] ${(r.text || '').slice(0, 180)}`;
    if (chars + line.length > maxChars) break;
    lines.push(line);
    chars += line.length + 1;
    if (lines.length >= maxItems) break;
  }
  return {
    query, lines, chars, ms: Date.now() - t0,
    indexBytes: fs.statSync(INDEX_PATH).size,
    indexEntries: idx.entries.length,
    range: range ? range.label : null,
    located: hits.length, expanded: expanded.length, hopped, fetched: rows.length,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const cmd = process.argv[2];
  if (cmd === 'build') {
    const r = build();
    console.log(`副库已重建：${r.entries} 条 / ${r.tags} 个标签 / ${(r.bytes/1024).toFixed(1)} KB`);
  } else if (cmd === 'search') {
    const q = process.argv.slice(3).join(' ');
    const r = search2(q);
    console.log(`查询: ${q}`);
    if (r.range) console.log(`时间过滤: ${r.range}`);
    console.log(`副库 ${(r.indexBytes/1024).toFixed(1)}KB → 定位 ${r.located} + 标签扩展 ${r.expanded} + 图联想 ${r.hopped} → 取原文 ${r.fetched} → 注入 ${r.lines.length} 行 / ${r.chars} 字 / ${r.ms}ms`);
    console.log(r.lines.join('\n'));
  } else {
    console.log('用法: node index.mjs build | node index.mjs search "词 词"');
  }
}
