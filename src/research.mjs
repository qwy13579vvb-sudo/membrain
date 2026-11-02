/**
 * research.mjs —— 缺口自补
 * 取 open 缺口 → 查资料（维基中文 / DuckDuckGo lite）→ 让模型压成 1~2 句 → 落库并 resolve。
 * 落库来源标 'research'、置信度 0.5（不是亲历，可能是二手）。
 */
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { chat } from './llm.mjs';

const UA = 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36';
const KEY_PATH = '';
const MODEL = '玉衡-gemini-3.8-flash';

const apiKey = () => JSON.parse(fs.readFileSync(KEY_PATH, 'utf-8')).api_key;

async function wikiSearch(q) {
  const url = `https://zh.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(q)}&format=json&srlimit=2`;
  const r = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!r.ok) return '';
  const j = await r.json();
  return (j?.query?.search || []).map((x) => `${x.title}：${String(x.snippet).replace(/<[^>]+>/g, '')}`).join('\n');
}

async function ddg(q) {
  const url = `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(q)}`;
  const r = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!r.ok) return '';
  const html = await r.text();
  const out = [];
  const re = /<a[^>]*class="result-link"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<td[^>]*class="result-snippet"[^>]*>([\s\S]*?)<\/td>/g;
  let m;
  while ((m = re.exec(html)) && out.length < 3) {
    out.push(`${m[1].replace(/<[^>]+>/g, '').trim()}：${m[2].replace(/<[^>]+>/g, '').trim()}`);
  }
  return out.join('\n');
}

async function summarize(gap, raw, hasSources) {
  return chat({
    system: hasSources
      ? '你是知识整理器。用中文把资料压成 1-2 句可靠结论；资料不足就直说「资料不足」。不要 markdown。'
      : '用你的知识用中文回答，1-2 句，直给结论；不确定就只说「资料不足」。不要 markdown。',
    user: hasSources ? `问题：${gap}\n资料：\n${raw.slice(0, 2000)}` : `问题：${gap}`,
    maxTokens: 400,
  });
}

export async function research(db, { limit = 2, maxAgeMs = 6 * 3600000 } = {}) {
  const gaps = db.prepare(`SELECT id, text, source_ref, ts_from, access_count FROM node
    WHERE kind='gap' AND (status IS NULL OR status='open')
      AND (source_ref LIKE 'term:%' OR source_ref LIKE 'miss:%')
      AND ts_from > ? ORDER BY (access_count*0.3 + importance) DESC LIMIT ?`).all(Date.now() - 30 * 86400000, limit);
  const done = [];
  for (const g of gaps) {
    const topic = String(g.text).replace(/^缺口｜[^：]*：/, '').slice(0, 60);
    if (!topic || topic.length < 3) continue;
    let raw = '';
    try { raw = await wikiSearch(topic); } catch { /* ignore */ }
    if (raw.length < 80) { try { raw = await ddg(topic); } catch { /* ignore */ } }
    const fromWeb = raw.length >= 40;
    let ans = '';
    if (fromWeb) {
      try { ans = await summarize(topic, raw, true); } catch { /* ignore */ }
    }
    if (!ans || ans.includes('资料不足')) {
      // 回退：让模型用自己的知识答，置信度压低、来源标明
      try { ans = await summarize(topic, '', false); } catch (e) {
        if (String(e.message) === 'QUOTA') { done.push({ topic, ok: false, why: '中转额度不足' }); break; }
      }
    }
    if (!ans || ans.includes('资料不足')) { done.push({ topic, ok: false, why: '答不出' }); continue; }
    const conf = fromWeb ? 0.55 : 0.35;
    const srcTag = fromWeb ? '查证' : '模型自述（未核实）';

    const ts = Date.now();
    db.prepare(`INSERT INTO node (uid, kind, text, ts_from, ts_to, source, source_ref, speaker,
        importance, confidence, user_confirmed, layer, emotion, arousal, strength, source_ids, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(`rs-${ts}-${Math.random().toString(36).slice(2, 6)}`, 'fact',
        `${srcTag}｜${topic} —— ${ans.slice(0, 200)}`, ts, ts, 'research', 'research:' + topic, 'system',
        0.55, conf, 0, 2, 0, 0.2, 10, JSON.stringify([g.id]), ts);
    db.prepare(`UPDATE node SET status='resolved', text = text || ? WHERE id=?`)
      .run(`（已查证 → 见「查证｜${topic.slice(0, 20)}」）`, g.id);
    done.push({ topic, ok: true, ans: `${fromWeb ? '🌐' : '🧠'} ${ans.slice(0, 80)}` });
  }
  return { tried: gaps.length, ok: done.filter((d) => d.ok).length, done };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const db = new DatabaseSync(process.env.MG_DB || 'memory.db');
  const r = await research(db);
  console.log(`尝试 ${r.tried} 个缺口，成功 ${r.ok} 个`);
  for (const d of r.done) console.log(d.ok ? `  ✅ ${d.topic} → ${d.ans}` : `  ✗ ${d.topic}（${d.why}）`);
}
