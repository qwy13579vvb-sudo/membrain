#!/usr/bin/env node
/**
 * build-star-map.mjs —— 把记忆库导出成「单文件记忆星图」
 * 按用户给的施工说明：纯 canvas 2D、零依赖、不联网、数据内联。
 * 用法: node build-star-map.mjs [输出路径]
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const DB = process.env.MG_DB || path.join(process.cwd(), 'memory.db');
const OUT = process.argv[2] || path.join(process.cwd(), 'star-map.html');

const db = new DatabaseSync(DB);

// 1) 记忆节点 → memories[]
const rows = db.prepare(`SELECT id, kind, text, ts_from, layer, importance, emotion, arousal, topic
  FROM node WHERE text IS NOT NULL AND length(text) > 1
  ORDER BY ts_from ASC`).all();

const catOf = (r) => {
  if (Math.abs(r.emotion || 0) >= 0.35) return 'emotion';
  if (['event', 'quote', 'diary', 'gap', 'proposal'].includes(r.kind)) return 'event';
  return 'stable_profile';
};
const tagsOf = (r) => {
  const out = ['L' + (r.layer || 1)];
  if (r.kind) out.push(r.kind);
  if (r.topic) out.push(String(r.topic).slice(0, 12));
  return out;
};

// 2) 边 → related
const edgeRows = db.prepare('SELECT src, dst, weight FROM edge ORDER BY weight DESC').all();
const relMap = new Map();
for (const e of edgeRows) {
  if (!relMap.has(e.src)) relMap.set(e.src, []);
  if (!relMap.has(e.dst)) relMap.set(e.dst, []);
  if (relMap.get(e.src).length < 4) relMap.get(e.src).push(e.dst);
  if (relMap.get(e.dst).length < 4) relMap.get(e.dst).push(e.src);
}

const memories = rows.map((r) => ({
  id: 'm' + r.id,
  text: String(r.text).slice(0, 900),
  imp: Math.max(0.08, Math.min(1, r.importance || 0.5)),
  at: new Date(r.ts_from || Date.now()).toISOString(),
  cat: catOf(r),
  tags: tagsOf(r),
  related: (relMap.get(r.id) || []).map((x) => 'm' + x),
  key: r.topic ? String(r.topic).slice(0, 24) : null,
}));
db.close();

const data = { self: '米饭', user: '他', memories };
const json = JSON.stringify(data);
console.log('节点:', memories.length, '| JSON:', (json.length / 1024).toFixed(0) + 'KB');

const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>记忆星图 · Memory Galaxy</title>
<style>
  *{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
  html,body{margin:0;height:100%;background:#05040a;color:#e9e6f5;overflow:hidden;
    font:14px/1.6 -apple-system,"PingFang SC","Microsoft YaHei",system-ui,sans-serif;-webkit-font-smoothing:antialiased}
  #cv{position:fixed;inset:0;width:100%;height:100%;display:block;touch-action:none;cursor:grab}
  #cv.drag{cursor:grabbing}
  .hud{position:fixed;left:0;right:0;top:0;z-index:5;pointer-events:none;padding:18px 20px;
    display:flex;align-items:flex-start;justify-content:space-between}
  .title{font-family:"Times New Roman",Georgia,serif;font-style:italic;font-size:22px;letter-spacing:.06em;
    color:#fff;text-shadow:0 0 24px rgba(200,170,255,.85);transition:opacity 1.4s ease}
  .title.hide{opacity:.22}
  .sub{margin-top:4px;font-size:10px;letter-spacing:.34em;color:#8f83ac}
  .meta{margin-top:10px;font:9.5px/1.7 ui-monospace,Menlo,monospace;letter-spacing:.08em;color:#7d739a;opacity:.9}
  #panel{position:fixed;left:0;right:0;bottom:0;z-index:8;transform:translateY(102%);
    transition:transform .34s cubic-bezier(.22,.9,.24,1);
    background:linear-gradient(180deg,rgba(18,14,32,.97),rgba(8,6,14,.99));
    border-top:1px solid rgba(170,150,220,.25);border-radius:24px 24px 0 0;
    box-shadow:0 -20px 60px rgba(0,0,0,.7);padding:10px 20px calc(20px + env(safe-area-inset-bottom))}
  #panel.open{transform:translateY(0)}
  #panel .grip{width:42px;height:4px;border-radius:2px;margin:2px auto 12px;background:rgba(180,160,220,.3)}
  #panel .eyebrow{font-size:9.5px;letter-spacing:.24em;text-transform:uppercase;color:#b9a6e8}
  #panel h2{margin:7px 0 0;font-size:16px;font-weight:600;line-height:1.5;color:#f3f0ff}
  #panel .metas{display:flex;flex-wrap:wrap;gap:6px;margin-top:10px}
  #panel .metas span{font-size:10px;letter-spacing:.05em;color:#a89fd0;border:1px solid rgba(170,150,220,.22);
    border-radius:999px;padding:3px 9px;font-variant-numeric:tabular-nums}
  #panel .body{margin-top:12px;font-size:13px;line-height:1.8;color:#d7d2ea;white-space:pre-wrap;
    max-height:34vh;overflow:auto}
  #panel .close{position:absolute;right:14px;top:12px;width:30px;height:30px;border-radius:50%;
    border:1px solid rgba(170,150,220,.25);background:rgba(28,24,46,.85);color:#c9c2e4}
  #toast{position:fixed;left:50%;bottom:26px;transform:translateX(-50%);z-index:9;padding:8px 16px;
    border-radius:12px;background:rgba(20,16,34,.92);border:1px solid rgba(170,150,220,.3);
    font-size:12px;letter-spacing:.06em;color:#ded9f2;opacity:0;transition:opacity .3s}
  #toast.on{opacity:1}
</style>
</head>
<body>
<canvas id="cv"></canvas>
<div class="hud">
  <div>
    <div class="title" id="ttl">Memory</div>
    <div class="sub" id="sub">米饭 &amp; 他</div>
  </div>
  <div class="meta" id="meta"></div>
</div>
<section id="panel">
  <div class="grip"></div>
  <button class="close" id="pclose">×</button>
  <div class="eyebrow" id="peyebrow"></div>
  <h2 id="ptitle"></h2>
  <div class="metas" id="pmetas"></div>
  <div class="body" id="pbody"></div>
</section>
<div id="toast"></div>

<script>
var DATA = ${json};
(function () {
  'use strict';
  var cv = document.getElementById('cv');
  var ctx = cv.getContext('2d', { alpha: false });
  var W = 0, H = 0, DPR = Math.min(2, window.devicePixelRatio || 1);

  // ── 关键常量（按施工说明）──
  var FOCAL = 900;              // 焦距
  var GAL_R = 5.8;              // 银河半径（世界单位）
  var SPIRAL = 1.22;            // 旋臂拧度
  var REF = 100;                // 尺寸参考世界距离
  var CORE_GAIN = 1.0;
  var N_ARM = 15000, N_BULGE = 1500, N_HALO = 3200, N_FAR = 5200, N_GIANT = 320;
  var DIST0 = 13.5, DIST1 = 9.2, DIST_MIN = 3.4, DIST_MAX = 20;

  var cam = { theta: 0.6, phi: -0.42, dist: DIST0 };
  var intro = { t: 0, started: performance.now(), done: false };
  var sel = null, hover = null;

  function resize() {
    var r = cv.getBoundingClientRect();
    W = Math.max(1, Math.floor(r.width));
    H = Math.max(1, Math.floor(r.height));
    cv.width = Math.floor(W * DPR);
    cv.height = Math.floor(H * DPR);
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  }

  // ── 投影：世界 → 屏幕 ──
  function project(p, out) {
    var th = cam.theta, ph = cam.phi;
    var ct = Math.cos(th), st = Math.sin(th), cp = Math.cos(ph), sp = Math.sin(ph);
    // 先绕 Y 轴转 theta，再绕 X 轴转 phi
    var x1 = p.x * ct + p.z * st;
    var z1 = -p.x * st + p.z * ct;
    var y1 = p.y * cp - z1 * sp;
    var z2 = p.y * sp + z1 * cp;
    var depth = cam.dist - z2;
    if (depth < 0.05) { out.s = 0; return out; }
    var s = FOCAL / depth;
    out.sx = W / 2 + x1 * s;
    out.sy = H * 0.52 - y1 * s;
    out.s = s;
    out.depth = depth;
    return out;
  }
  var tmp = { sx: 0, sy: 0, s: 0, depth: 0 };

  // ── 粒子生成 ──
  function rnd(seed) { var x = Math.sin(seed * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); }
  var layers = [];  // {color, pts:[{x,y,z,s0}]}

  function addLayer(color, n, gen) {
    var arr = [];
    for (var i = 0; i < n; i++) arr.push(gen(i));
    layers.push({ color: color, pts: arr });
  }

  // 旋臂：对数螺线
  addLayer('rgba(205,190,255,0.85)', N_ARM, function (i) {
    var u = rnd(i * 1.7), v = rnd(i * 3.1), w = rnd(i * 5.3);
    var arm = i % 4;
    var r = GAL_R * Math.pow(u, 0.62);
    var th = (arm / 4) * Math.PI * 2 + r * SPIRAL + (v - 0.5) * 0.42;
    return { x: Math.cos(th) * r, z: Math.sin(th) * r, y: (w - 0.5) * 0.22 * (1 - r / GAL_R * 0.5), s0: 0.5 + rnd(i * 9.1) * 0.9 };
  });
  // 核球
  addLayer('rgba(255,238,255,0.95)', N_BULGE, function (i) {
    var u = rnd(i * 2.3), v = rnd(i * 4.7), w = rnd(i * 6.1);
    var r = 1.5 * Math.pow(u, 1.8);
    var th = v * Math.PI * 2, ph = Math.acos(1 - 2 * w);
    return { x: r * Math.sin(ph) * Math.cos(th), y: r * Math.cos(ph) * 0.75, z: r * Math.sin(ph) * Math.sin(th), s0: 1.1 + rnd(i * 8.3) * 1.5 };
  });
  // 晕
  addLayer('rgba(150,130,220,0.5)', N_HALO, function (i) {
    var u = rnd(i * 1.3), v = rnd(i * 3.7), w = rnd(i * 7.9);
    var r = GAL_R * (1.05 + u * 1.1);
    var th = v * Math.PI * 2, ph = Math.acos(1 - 2 * w);
    return { x: r * Math.sin(ph) * Math.cos(th), y: r * Math.cos(ph) * 1.2, z: r * Math.sin(ph) * Math.sin(th), s0: 0.4 + rnd(i * 4.4) * 0.6 };
  });
  // 远景繁星（固定在天球，不随转动）
  addLayer('rgba(235,230,255,0.75)', N_FAR, function (i) {
    var u = rnd(i * 2.9), v = rnd(i * 5.1);
    return { x: (u - 0.5) * 60, y: (v - 0.5) * 40, z: -28 - rnd(i * 3.3) * 10, s0: 0.35 + rnd(i * 7.7) * 0.5, far: true };
  });
  // 亮巨星
  addLayer('rgba(255,246,255,1)', N_GIANT, function (i) {
    var u = rnd(i * 3.3), v = rnd(i * 6.7), w = rnd(i * 8.1);
    var r = GAL_R * Math.pow(u, 0.7);
    var th = (i % 3) * 2.094 + r * SPIRAL * 0.9 + (v - 0.5) * 0.3;
    return { x: Math.cos(th) * r, z: Math.sin(th) * r, y: (w - 0.5) * 0.4, s0: 2.6 + rnd(i * 9.9) * 2.4 };
  });

  // ── 记忆星：按时间排名铺开（可随新记忆重建）──
  var mems = [], stars = [], byId = {};
  function buildStars() {
    mems = DATA.memories.slice().sort(function (a, b) { return new Date(a.at) - new Date(b.at); });
    stars = mems.map(function (m, i) {
    var t = mems.length > 1 ? i / (mems.length - 1) : 0.5;
    // 越早越靠中心
    var r = 0.5 + t * (GAL_R - 0.6);
    var arm = i % 4;
    var th = (arm / 4) * Math.PI * 2 + r * SPIRAL + (rnd(i * 1.7) - 0.5) * 0.5;
    var col = m.cat === 'stable_profile' ? [255, 205, 120] : (m.cat === 'emotion' ? [255, 140, 200] : [130, 190, 255]);
      return {
        m: m, x: Math.cos(th) * r, z: Math.sin(th) * r, y: (rnd(i * 4.3) - 0.5) * 0.5,
        color: col, imp: m.imp, idx: i, born: performance.now(),
      };
    });
    byId = {};
    stars.forEach(function (s) { byId[s.m.id] = s; });
  }
  buildStars();

  // ── 活水：线上（http）每 60 秒拉一次最新记忆；file:// 下自动跳过 ──
  var lastCount = -1;
  function pullFresh() {
    if (location.protocol === 'file:') return;
    fetch('/api/scene', { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (j) {
      if (!j || !j.points) return;
      if (j.points.length === lastCount) return;
      lastCount = j.points.length;
      var fresh = j.points.map(function (p) {
        var cat = p.kind === 'event' || p.kind === 'quote' || p.kind === 'diary'
          ? 'event' : (Math.abs(p.emotion || 0) >= 0.35 ? 'emotion' : 'stable_profile');
        return {
          id: 'm' + p.id, text: String(p.text || '').slice(0, 900),
          imp: Math.max(0.08, Math.min(1, p.importance || 0.5)),
          at: new Date(p.ts || Date.now()).toISOString(),
          cat: cat, tags: ['L' + (p.layer || 1), p.kind || ''], related: [], key: p.topic || null,
        };
      });
      DATA.memories = fresh;
      buildStars();
      if (DATA.memories.length !== lastCount) {
        document.getElementById('sub').textContent = (DATA.self || '') + ' & ' + (DATA.user || '') + ' · ' + DATA.memories.length + ' 条';
      }
      toast('记忆 +' + Math.max(0, DATA.memories.length - lastCount) + ' —— 银河又长了一点');
    }).catch(function () {});
  }
  var toastTimer = 0;
  function toast(msg) {
    var el = document.getElementById('toast');
    el.textContent = msg; el.classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove('on'); }, 2200);
  }
  setTimeout(function () { lastCount = DATA.memories.length; pullFresh(); }, 3000);
  setInterval(pullFresh, 60000);

  // ── 开场 ──
  function introT() { return (performance.now() - intro.started) / 1000; }

  // ── 绘制 ──
  var bgGrad = null;
  function drawBackground() {
    if (!bgGrad) {
      bgGrad = ctx.createRadialGradient(W / 2, H * 0.52, 0, W / 2, H * 0.52, Math.max(W, H) * 0.9);
      bgGrad.addColorStop(0, '#100a1c');
      bgGrad.addColorStop(0.45, '#080614');
      bgGrad.addColorStop(1, '#020208');
    }
    ctx.fillStyle = bgGrad;
    ctx.fillRect(0, 0, W, H);
  }

  function drawCore() {
    var g = ctx.createRadialGradient(W / 2, H * 0.52, 0, W / 2, H * 0.52, Math.min(W, H) * 0.52);
    g.addColorStop(0, 'rgba(255,255,255,' + (0.85 * CORE_GAIN).toFixed(2) + ')');
    g.addColorStop(0.06, 'rgba(255,240,255,0.55)');
    g.addColorStop(0.18, 'rgba(214,170,255,0.20)');
    g.addColorStop(0.42, 'rgba(140,90,220,0.09)');
    g.addColorStop(1, 'rgba(40,16,70,0)');
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(W / 2, H * 0.52, Math.min(W, H) * 0.52, 0, 7); ctx.fill();
    ctx.globalCompositeOperation = 'source-over';
  }

  function drawParticles() {
    var t = introT();
    ctx.globalCompositeOperation = 'lighter';
    for (var li = 0; li < layers.length; li++) {
      var L = layers[li];
      ctx.fillStyle = L.color;
      for (var i = 0; i < L.pts.length; i++) {
        var p = L.pts[i];
        // 开场：粒子按各自延迟点亮
        var delay = p.far ? 0.15 : 0.35 + (i / L.pts.length) * 0.9;
        var a = Math.min(1, Math.max(0, (t - delay) / 0.55));
        if (a <= 0.02) continue;
        project(p, tmp);
        if (tmp.s <= 0 || tmp.sx < -20 || tmp.sx > W + 20 || tmp.sy < -20 || tmp.sy > H + 20) continue;
        var sz = p.s0 * tmp.s / REF * (p.far ? 1 : 1);
        if (sz < 0.4) sz = 0.4;
        ctx.globalAlpha = a * (p.far ? 0.9 : 1);
        if (sz < 1.2) ctx.fillRect(tmp.sx, tmp.sy, sz, sz);
        else { ctx.beginPath(); ctx.arc(tmp.sx, tmp.sy, sz * 0.75, 0, 7); ctx.fill(); }
      }
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  function starPos(s, out) { return project(s, out); }

  function drawStars() {
    var t = introT();
    var newest = stars[stars.length - 1];
    for (var i = 0; i < stars.length; i++) {
      var s = stars[i];
      project(s, tmp);
      if (tmp.s <= 0) continue;
      var base = 1.4 + s.imp * 4.2;
      var r = Math.max(1.2, base * tmp.s / 260);
      // 开场：黑场后逐个亮起
      var born = s.born ? Math.min(1, (performance.now() - s.born) / 1200) : 1;
      var a = Math.min(1, Math.max(0, (t - 0.9 - (i / stars.length) * 1.1) / 0.5)) * (0.35 + 0.65 * born);
      if (a <= 0.02) continue;
      var rr = s.color[0] | 0, gg = s.color[1] | 0, bb = s.color[2] | 0;
      // 光晕
      var halo = r * 4.5;
      var g = ctx.createRadialGradient(tmp.sx, tmp.sy, 0, tmp.sx, tmp.sy, halo);
      g.addColorStop(0, 'rgba(' + rr + ',' + gg + ',' + bb + ',' + (0.55 * a).toFixed(3) + ')');
      g.addColorStop(0.35, 'rgba(' + rr + ',' + gg + ',' + bb + ',' + (0.16 * a).toFixed(3) + ')');
      g.addColorStop(1, 'rgba(' + rr + ',' + gg + ',' + bb + ',0)');
      ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(tmp.sx, tmp.sy, halo, 0, 7); ctx.fill();
      // 本体
      ctx.fillStyle = 'rgba(' + rr + ',' + gg + ',' + bb + ',' + a.toFixed(3) + ')';
      ctx.beginPath(); ctx.arc(tmp.sx, tmp.sy, r, 0, 7); ctx.fill();
      ctx.globalCompositeOperation = 'source-over';
      s._sx = tmp.sx; s._sy = tmp.sy; s._r = r; s._a = a;
      s._hl = (sel === s) || (hover === s);
    }
    // 最新一条「叮」一下
    if (newest && t > 2.2 && t < 4.2) {
      var k = (t - 2.2) / 2.0;
      if (newest._sx != null) {
        ctx.globalCompositeOperation = 'lighter';
        ctx.strokeStyle = 'rgba(255,246,220,' + (0.6 * (1 - k)).toFixed(3) + ')';
        ctx.lineWidth = 1.4;
        ctx.beginPath(); ctx.arc(newest._sx, newest._sy, 6 + k * 42, 0, 7); ctx.stroke();
        ctx.globalCompositeOperation = 'source-over';
      }
    }
  }

  function drawConstellation() {
    if (!sel) return;
    var rel = (sel.m.related || []).map(function (id) { return byId[id]; }).filter(Boolean);
    // 同类（同 key 或同 tag）也算
    var same = stars.filter(function (s) {
      if (s === sel) return false;
      if (sel.m.key && s.m.key === sel.m.key) return true;
      for (var i = 0; i < s.m.tags.length; i++) if (sel.m.tags.indexOf(s.m.tags[i]) >= 0) return true;
      return false;
    }).slice(0, 12);
    var set = rel.concat(same);
    ctx.globalCompositeOperation = 'lighter';
    for (var i = 0; i < set.length; i++) {
      var s = set[i];
      if (s._sx == null) continue;
      ctx.strokeStyle = 'rgba(255,220,180,0.28)';
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(sel._sx, sel._sy); ctx.lineTo(s._sx, s._sy); ctx.stroke();
    }
    // 选中星加环
    if (sel._sx != null) {
      ctx.strokeStyle = 'rgba(255,240,210,0.85)';
      ctx.lineWidth = 1.4;
      ctx.beginPath(); ctx.arc(sel._sx, sel._sy, (sel._r || 3) * 4, 0, 7); ctx.stroke();
    }
    ctx.globalCompositeOperation = 'source-over';
  }

  function drawVignette() {
    var g = ctx.createRadialGradient(W / 2, H * 0.52, Math.min(W, H) * 0.32, W / 2, H * 0.52, Math.max(W, H) * 0.78);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(1, 'rgba(0,0,0,0.62)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  }

  // ── 主循环 ──
  var last = performance.now();
  function frame(now) {
    var dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    var t = introT();

    // 镜头推进 + 自转
    if (t > 0.7 && !intro.done) {
      var k = Math.min(1, (t - 0.7) / 2.6);
      var e = 1 - Math.pow(1 - k, 3);            // easeOutCubic
      cam.dist = DIST0 + (DIST1 - DIST0) * e;
      if (k >= 1) intro.done = true;
    }
    cam.theta += dt * 0.035;

    drawBackground();
    // 黑场
    if (t < 0.7) {
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, W, H);
      requestAnimationFrame(frame);
      return;
    }
    drawCore();
    drawParticles();
    drawConstellation();
    drawStars();
    drawVignette();

    // HUD 数据
    var meta = document.getElementById('meta');
    if (meta && (now | 0) % 12 === 0) meta.textContent = DATA.memories.length + ' MEMORIES\\n' + (cam.dist).toFixed(1) + ' AU';

    requestAnimationFrame(frame);
  }

  // ── 交互 ──
  var drag = null;
  function pos(e) {
    var r = cv.getBoundingClientRect();
    return { x: (e.clientX - r.left), y: (e.clientY - r.top) };
  }
  function pick(x, y) {
    var best = null, bd = 26;
    for (var i = 0; i < stars.length; i++) {
      var s = stars[i];
      if (s._sx == null) continue;
      var d = Math.hypot(s._sx - x, s._sy - y);
      if (d < bd) { bd = d; best = s; }
    }
    return best;
  }
  function showPanel(s) {
    var m = s.m;
    document.getElementById('peyebrow').textContent = (m.cat === 'stable_profile' ? '长期事实' : m.cat === 'emotion' ? '情绪' : '事件') + ' · ' + (m.tags[1] || '');
    document.getElementById('ptitle').textContent = m.text.slice(0, 40) || '（空）';
    var d = new Date(m.at);
    document.getElementById('pmetas').innerHTML = [
      d.toLocaleDateString('zh-CN'), '重要度 ' + m.imp.toFixed(2), (m.tags || []).slice(0, 3).join(' · ')
    ].map(function (x) { return '<span>' + x + '</span>'; }).join('');
    document.getElementById('pbody').textContent = m.text;
    document.getElementById('panel').classList.add('open');
    document.getElementById('ttl').classList.add('hide');
  }
  function hidePanel() {
    document.getElementById('panel').classList.remove('open');
    sel = null;
  }
  document.getElementById('pclose').onclick = hidePanel;

  cv.addEventListener('pointerdown', function (e) {
    cv.setPointerCapture(e.pointerId);
    var p = pos(e);
    drag = { x: p.x, y: p.y, th: cam.theta, ph: cam.phi, moved: false };
    cv.classList.add('drag');
  });
  cv.addEventListener('pointermove', function (e) {
    var p = pos(e);
    if (drag) {
      var dx = p.x - drag.x, dy = p.y - drag.y;
      if (Math.hypot(dx, dy) > 6) drag.moved = true;
      cam.theta = drag.th + dx * 0.006;
      cam.phi = Math.max(-1.35, Math.min(1.35, drag.ph - dy * 0.005));
    } else {
      hover = pick(p.x, p.y);
      cv.style.cursor = hover ? 'pointer' : 'grab';
    }
  });
  cv.addEventListener('pointerup', function (e) {
    var p = pos(e);
    cv.classList.remove('drag');
    if (drag && !drag.moved) {
      var s = pick(p.x, p.y);
      if (s) { sel = s; showPanel(s); } else hidePanel();
    }
    drag = null;
  });
  cv.addEventListener('pointercancel', function () { drag = null; cv.classList.remove('drag'); });
  cv.addEventListener('wheel', function (e) {
    e.preventDefault();
    cam.dist = Math.max(DIST_MIN, Math.min(DIST_MAX, cam.dist * (e.deltaY > 0 ? 1.08 : 0.92)));
  }, { passive: false });
  // 双指缩放
  var pinch = null;
  cv.addEventListener('touchstart', function (e) {
    if (e.touches.length === 2) {
      pinch = { d: Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY), dist: cam.dist };
    }
  }, { passive: true });
  cv.addEventListener('touchmove', function (e) {
    if (pinch && e.touches.length === 2) {
      var d = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
      cam.dist = Math.max(DIST_MIN, Math.min(DIST_MAX, pinch.dist * (pinch.d / Math.max(1, d))));
    }
  }, { passive: true });
  cv.addEventListener('touchend', function () { pinch = null; }, { passive: true });

  // 尺寸：rect + ResizeObserver + 两次延时重试（施工说明里的坑）
  function boot() {
    resize();
    if (window.ResizeObserver) new ResizeObserver(resize).observe(cv);
    window.addEventListener('resize', resize);
    setTimeout(resize, 300);
    setTimeout(resize, 1500);
    requestAnimationFrame(frame);
    setTimeout(function () { document.getElementById('ttl').classList.add('hide'); }, 4200);
  }
  if (document.readyState === 'complete') boot();
  else window.addEventListener('load', boot);
})();
</script>
</body>
</html>`;

fs.writeFileSync(OUT, html, 'utf8');
console.log('✅ 写出:', OUT, '|', (html.length / 1024).toFixed(0) + 'KB');
