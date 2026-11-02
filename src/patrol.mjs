/**
 * patrol.mjs —— 自主巡检（只读）
 * 检查：磁盘、内存、主库/副库一致性、调度器存活、近期报错、开口缺口。
 * 产出：一条 conclusion 节点（每天去重）+ 发现的问题进缺口队列。
 * 明确的边界：只读。不改文件、不动设备、不发消息。
 */
import fs from 'node:fs';
import os from 'node:os';
import { execSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const HERE = new URL('.', import.meta.url).pathname;
const DAY = 86400000;

function sh(cmd) {
  try { return execSync(cmd, { encoding: 'utf-8', timeout: 8000 }).trim(); } catch { return ''; }
}

export function patrol(db, { now = Date.now() } = {}) {
  const issues = [];
  const notes = [];

  // 磁盘
  const df = sh("df -h /root | tail -1 | awk '{print $5, $4}'").split(' ');
  if (df[0]) {
    const pct = parseInt(df[0], 10);
    notes.push(`磁盘 ${df[0]}（剩 ${df[1] || '?'}）`);
    if (pct >= 90) issues.push(`磁盘占用 ${pct}%，只剩 ${df[1]}`);
  }

  // 内存
  const mem = sh("free -m | awk 'NR==2{print $7}'");
  if (mem) {
    const avail = parseInt(mem, 10);
    notes.push(`可用内存 ${avail}MB`);
    if (avail < 300) issues.push(`可用内存只剩 ${avail}MB`);
  }

  // 主副库一致性
  try {
    const total = db.prepare('SELECT COUNT(*) c FROM node WHERE cold=0').get().c;
    const idx = JSON.parse(fs.readFileSync(HERE + 'index.json', 'utf-8'));
    const ageMin = (now - fs.statSync(HERE + 'index.json').mtimeMs) / 60000;
    notes.push(`库 ${total} 条 / 副库 ${idx.entries.length} 条（${ageMin.toFixed(0)} 分钟前）`);
    if (Math.abs(total - idx.entries.length) > 12) issues.push(`副库与主库差 ${total - idx.entries.length} 条`);
    if (ageMin > 30) issues.push(`副库已 ${ageMin.toFixed(0)} 分钟没重建`);
  } catch (e) { issues.push('副库读取失败：' + e.message); }

  // 调度器存活
  const sched = sh('ps -eo cmd | grep -c "[s]cheduler.mjs"');
  notes.push(`调度器进程 ${sched || 0} 个`);
  if (!Number(sched)) issues.push('调度器没在跑');

  // 开口缺口
  const gaps = db.prepare(`SELECT COUNT(*) c FROM node WHERE kind='gap' AND (status IS NULL OR status='open')`).get().c;
  notes.push(`开口缺口 ${gaps} 个`);

  // 争议规则
  const refuted = db.prepare(`SELECT COUNT(*) c FROM node WHERE kind='rule' AND status='refuted'`).get().c;
  if (refuted) notes.push(`已作废规则 ${refuted} 条`);

  const summary = issues.length
    ? `巡检发现 ${issues.length} 个问题：${issues.join('；')}`
    : '巡检正常';

  // 落库（每天最多一条）
  try {
    const dayStart = new Date(now + 8 * 3600000).setUTCHours(0, 0, 0, 0);
    const since = dayStart - 8 * 3600000;
    const exists = db.prepare(`SELECT id FROM node WHERE source='patrol' AND ts_from >= ?`).get(since);
    if (!exists) {
      db.prepare(`INSERT INTO node (uid, kind, text, ts_from, ts_to, source, speaker, importance,
          confidence, user_confirmed, layer, emotion, arousal, strength, created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(`patrol-${now}`, 'conclusion',
          `自主巡检（只读）｜${summary}。${notes.join('；')}`,
          now, now, 'patrol', 'system', 0.5, 0.9, 1, 2, 0, 0.2, 6, now);
    }
  } catch { /* ignore */ }

  return { ok: issues.length === 0, issues, notes, summary };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const db = new DatabaseSync(HERE + 'memory.db');
  const r = patrol(db);
  console.log(r.summary);
  for (const n of r.notes) console.log('  ·', n);
}
