/**
 * caps.mjs —— 能力目录
 * 扫描 SKILLS_DIR 下每个技能的 SKILL.md，汇总成「我会什么」。
 * 落库 kind='capability'（稳定 uid，重复同步只更新）。
 */
import fs from 'node:fs';
import { SKILLS_DIR } from './config.mjs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const SKILLS = SKILLS_DIR;
const now = () => Date.now();

function parseFront(text) {
  const m = text.match(/^---\s*\n([\s\S]*?)\n---/);
  const out = {};
  if (!m) return out;
  for (const line of m[1].split('\n')) {
    const mm = line.match(/^([a-zA-Z_]+):\s*(.*)$/);
    if (mm) out[mm[1]] = mm[2].replace(/^["']|["']$/g, '').trim();
  }
  return out;
}

export function scanSkills() {
  const list = [];
  let names = [];
  try { names = fs.readdirSync(SKILLS); } catch { return list; }
  for (const n of names) {
    const f = path.join(SKILLS, n, 'SKILL.md');
    if (!fs.existsSync(f)) continue;
    const text = fs.readFileSync(f, 'utf-8');
    const fm = parseFront(text);
    list.push({
      id: n,
      name: fm.name || n,
      desc: (fm.description || '').replace(/\s+/g, ' ').slice(0, 90),
      when: (fm.whenToUse || '').replace(/\s+/g, ' ').slice(0, 80),
    });
  }
  return list;
}

/** 把技能目录同步进库（kind=capability） */
export function syncCaps(db) {
  const skills = scanSkills();
  const up = db.prepare(`INSERT INTO node (uid, kind, text, ts_from, ts_to, source, source_ref, speaker,
      importance, confidence, user_confirmed, layer, emotion, arousal, strength, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(uid) DO UPDATE SET text=excluded.text, ts_to=excluded.ts_to`);
  let n = 0;
  for (const s of skills) {
    up.run(`cap-${s.id}`, 'capability', `能力｜${s.name}：${s.desc}`, now(), now(),
      'caps', s.id, 'system', 0.6, 0.95, 1, 2, 0, 0.2, 30, now());
    n++;
  }
  return { count: n, skills };
}

/** 一行摘要，用于每轮注入 */
export function capsLine(db) {
  const rows = db.prepare(`SELECT source_ref, text FROM node WHERE kind='capability' ORDER BY source_ref`).all();
  if (!rows.length) return '';
  const names = rows.map((r) => String(r.text).match(/^能力｜([^：]+)/)?.[1] || r.source_ref);
  return `🧰 会 ${names.length} 项技能：${names.join('、')}`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const db = new DatabaseSync(new URL('./memory.db', import.meta.url).pathname);
  if (process.argv[2] === 'sync') {
    const r = syncCaps(db);
    console.log(`同步 ${r.count} 项技能：`);
    for (const s of r.skills) console.log(`  · ${s.name} — ${s.desc}`);
  } else {
    console.log(capsLine(db) || '（空）');
  }
}
