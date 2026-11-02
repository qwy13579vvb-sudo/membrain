#!/usr/bin/env node
/**
 * viz.mjs —— 四层记忆星海可视化服务（零依赖）
 *
 * 起在 127.0.0.1:4174
 *   GET /            单页应用
 *   GET /api/scene   四层节点 + 边 + 统计（含情绪、遗忘保留率）
 *
 * 视觉隐喻：
 *   越抽象越靠内 —— L4 画像在核心，L1 原始事件在最外层
 *   颜色 = 情绪（冷蓝负 / 暖粉正）
 *   亮度 = 艾宾浩斯保留率（快忘的会变暗、变冷）
 *   大小 = 重要度 × 记忆强度
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const PORT = Number(process.env.PORT || 4174);
const HERE = path.dirname(new URL(import.meta.url).pathname);
const DB = process.env.MG_DB || (process.env.MG_DB || path.join(process.cwd(), 'memory.db'));
const DAY = 86400000;

function scene() {
  const db = new DatabaseSync(DB);
  const now = Date.now();
  const rows = db.prepare(`SELECT id, kind, text, ts_from, layer, emotion, arousal, importance,
      strength, review_count, last_review_at, cold, topic, source, speaker, source_ref
      FROM node ORDER BY id`).all();

  const byLayer = {}, byKind = {};
  let sumV = 0, sumA = 0, n1 = 0;
  const points = rows.map((r, i) => {
    const last = r.last_review_at || r.ts_from || now;
    const dtDays = Math.max(0, (now - last) / DAY);
    const S = Math.max(0.2, r.strength || 1);
    const R = Math.exp(-dtDays / S);
    byLayer['L' + r.layer] = (byLayer['L' + r.layer] || 0) + 1;
    byKind[r.kind] = (byKind[r.kind] || 0) + 1;
    if (r.layer === 1) { sumV += r.emotion || 0; sumA += r.arousal || 0.3; n1++; }
    // 层级半径：L4 核心 0.18 → L1 外层 1.0
    const radius = { 4: 0.16, 3: 0.42, 2: 0.68, 1: 1.0 }[r.layer] ?? 1;
    return {
      id: r.id,
      kind: r.kind,
      text: (r.text || '').slice(0, 600),
      ts: r.ts_from,
      layer: r.layer,
      emotion: +(r.emotion || 0).toFixed(3),
      arousal: +(r.arousal || 0.3).toFixed(3),
      importance: +(r.importance || 0.5).toFixed(3),
      strength: +S.toFixed(2),
      retention: +R.toFixed(3),
      reviews: r.review_count || 0,
      lastReview: r.last_review_at || 0,
      cold: !!r.cold,
      topic: r.topic || null,
      source: r.source || null,
      speaker: r.speaker || null,
      radius,
      seed: i,
    };
  });

  const ids = new Map(points.map((p) => [p.id, p]));
  const edges = db.prepare(`SELECT src, dst, rel, weight FROM edge`).all()
    .filter((e) => ids.has(e.src) && ids.has(e.dst))
    .map((e) => ({ a: e.src, b: e.dst, w: +(e.weight || 0.5).toFixed(2), rel: e.rel }));

  const runs = db.prepare(`SELECT layer, made, ts FROM layer_run ORDER BY id DESC LIMIT 6`).all();

  return {
    ok: true,
    builtAt: now,
    stats: {
      total: points.length,
      edges: edges.length,
      byLayer,
      byKind,
      avgEmotion: n1 ? +(sumV / n1).toFixed(3) : 0,
      avgArousal: n1 ? +(sumA / n1).toFixed(3) : 0,
      cold: points.filter((p) => p.cold).length,
      span: points.length ? [Math.min(...points.map((p) => p.ts)), Math.max(...points.map((p) => p.ts))] : null,
    },
    runs,
    points,
    edges,
  };
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', 'http://localhost');
  if (url.pathname === '/api/search') {
    const q = (url.searchParams.get('q') || '').trim();
    try {
      const db2 = new DatabaseSync(DB);
      const rows = q
        ? db2.prepare(`SELECT id FROM node WHERE text LIKE ? ORDER BY importance DESC LIMIT 40`).all('%' + q + '%')
        : [];
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ ok: true, ids: rows.map((r) => r.id) }));
    } catch (err) {
      res.end(JSON.stringify({ ok: false, ids: [], error: String(err && err.message) }));
    }
    return;
  }

  if (url.pathname === '/api/scene') {
    try {
      const body = JSON.stringify(scene());
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(body);
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: String(err && err.message || err) }));
    }
    return;
  }
  if (url.pathname === '/' || url.pathname === '/index.html') {
    const p = path.join(HERE, 'viz', 'index.html');
    if (!fs.existsSync(p)) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('viz/index.html 不存在');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(fs.readFileSync(p));
    return;
  }
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('not found');
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[mg-viz] http://127.0.0.1:${PORT}`);
});
