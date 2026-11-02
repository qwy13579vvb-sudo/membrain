/**
 * distill.mjs —— 用 LLM 做归纳（本地规则做不到的那部分）
 *
 * 取「还没被归纳过」的近期记忆 → 交给 deepseek-v4-flash →
 * 产出：经验规则 / 用户偏好 / 待办承诺，落库。
 * 状态存 distill.state.json（记录处理到哪个 ts），增量、不重复花钱。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { chatJSON } from './llm.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const STATE = path.join(HERE, 'distill.state.json');
const KEY_PATH = '';
const UA = 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36';
const MODELS = process.env.DISTILL_MODEL
  ? [process.env.DISTILL_MODEL]
  : ['玉衡-gemini-3.8-flash', 'deepseek-v4-flash', '开阳-gemini-3.7-flash'];

const state = () => { try { return JSON.parse(fs.readFileSync(STATE, 'utf-8')); } catch { return { lastTs: 0 }; } };
const saveState = (s) => fs.writeFileSync(STATE, JSON.stringify(s));

function apiKey() {
  return JSON.parse(fs.readFileSync(KEY_PATH, 'utf-8')).api_key;
}

const SYSTEM = `你是记忆整理器。输入是一批中文对话记录。
请只输出 JSON，形如：
{"rules":[{"when":"触发条件","then":"该怎么做","why":"依据"}],
 "preferences":[{"text":"用户偏好"}],
 "promises":[{"text":"承诺或待办","status":"open"}]}
要求：
1. 只提炼**可复用**的东西，不要复述具体时间/路径/版本号细节。
2. 没有就返回空数组，宁缺毋滥。
3. rules 最多 3 条，preferences 最多 3 条，promises 最多 2 条。
4. 全中文。不要 markdown，不要解释。`;

async function callLLM(items) {
  return chatJSON({
    system: SYSTEM,
    user: items.map((x, i) => `${i + 1}. ${String(x.text).slice(0, 160)}`).join('\n'),
    maxTokens: 1200,
  });
}

export async function distill(db, { batch = 12, maxBatches = 3, nowTs = Date.now() } = {}) {
  const st = state();
  const rows = db.prepare(`SELECT id, text, ts_from, kind FROM node
    WHERE layer=1 AND ts_from > ? AND length(text) >= 12 AND kind IN ('event','fact','quote','correction')
    ORDER BY ts_from ASC LIMIT ?`).all(st.lastTs, batch * maxBatches);
  if (process.env.DBG) console.error('[dbg] lastTs=', st.lastTs, 'rows=', rows.length);
  if (!rows.length) return { batches: 0, rules: 0, prefs: 0, promises: 0, consumed: 0, costCalls: 0 };

  let rules = 0, prefs = 0, promises = 0, batches = 0;
  for (let i = 0; i < rows.length; i += batch) {
    const chunk = rows.slice(i, i + batch);
    if (chunk.length < 6) break;
    let out = null, usedModel = 'official';
    for (const m of [1]) {
      try {
        out = await callLLM(chunk);
        if (out) break;
      } catch (e) {
        const msg = String(e.message || e);
        if (msg.startsWith('QUOTA:') || msg.startsWith('NOQUOTA:') || msg === 'BADKEY') {
          console.log('  ⚠️ 中转额度不足，归纳暂停（余额剩 ¥0.011，单次需 ¥0.03）');
          try {
            db.prepare(`INSERT OR IGNORE INTO node (uid, kind, text, ts_from, ts_to, source, source_ref, speaker,
                importance, confidence, user_confirmed, layer, emotion, arousal, strength, status, created_at)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
              .run('gap-quota', 'gap', '缺口｜中转 API 额度不足（剩 ¥0.011，单次需 ¥0.03），LLM 归纳/自补/迁移全部暂停',
                Date.now(), Date.now(), 'gap', 'term:llm-quota', 'system', 0.9, 0.9, 0, 2, 0, 0.3, 10, 'open', Date.now());
          } catch {}
          return { batches: 0, rules: 0, prefs: 0, promises: 0, quotaExhausted: true };
        }
        if (process.env.DBG) console.error('[dbg]', m, msg);
        if (msg.includes('429')) { await new Promise((r) => setTimeout(r, 3000)); }
      }
    }
    if (!out) { console.log('  本轮无产出（模型都没给出合法 JSON）'); break; }
    if (process.env.DBG) console.error('[dbg] 用', usedModel, '产出 keys=', Object.keys(out).join(','));
    batches++;

    const ins = (kind, text, importance, extra = '') => {
      const dup = db.prepare(`SELECT id FROM node WHERE kind=? AND text LIKE ?`).get(kind, text.slice(0, Math.min(30, text.length)) + '%');
      if (dup) return false;
      const ts = chunk[0].ts_from;
      db.prepare(`INSERT INTO node (uid, kind, text, ts_from, ts_to, source, source_ref, speaker,
          importance, confidence, user_confirmed, layer, emotion, arousal, strength, source_ids, created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(`ds-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, kind, text, ts, Date.now(),
          'distill', extra, 'system', importance, 0.75, 0, 2, 0, 0.3, 16,
          JSON.stringify(chunk.map((c) => c.id)), Date.now());
      return true;
    };

    const BAD = /(名字|称作|称呼|自称).{0,8}(大肥鱼|肥鱼)|大肥鱼.{0,6}(是|叫).{0,4}(名字|助手)/;
    for (const r of (out.rules || []).slice(0, 2)) {
      if (!r?.when || !r?.then) continue;
      if (BAD.test(`${r.when}${r.then}${r.why || ''}`)) continue;   // 名字是「米饭」，不是「大肥鱼」
      if (ins('rule', `经验｜当「${r.when}」→ ${r.then}${r.why ? `（依据：${r.why}）` : ''}`, 0.85, 'LLM')) rules++;
    }
    for (const p of (out.preferences || []).slice(0, 2)) {
      const t = typeof p === 'string' ? p : p?.text;
      const NOT_PREF = /(生日|生于|是 \d|新增|实现|写一个|帮我|所有对话、事件|计划)/;
      if (t && !BAD.test(t) && !NOT_PREF.test(t) && ins('preference', `偏好｜${t}`, 0.8, 'LLM')) prefs++;
    }
    for (const p of (out.promises || []).slice(0, 1)) {
      const t = typeof p === 'string' ? p : p?.text;
      if (t && !/^用户(计划|想|要|说)/.test(t) && ins('promise', `承诺｜${t}`, 0.9, 'LLM')) promises++;
    }
  }
  const last = rows[Math.min(rows.length - 1, batch * batches - 1)];
  if (last) { st.lastTs = last.ts_from; saveState(st); }
  return { batches, rules, prefs, promises, consumed: batch * batches, costCalls: batches };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const db = new DatabaseSync(process.env.MG_DB || 'memory.db');
  const r = await distill(db);
  console.log('归纳结果:', r);
}
