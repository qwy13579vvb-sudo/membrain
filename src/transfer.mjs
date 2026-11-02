/**
 * transfer.mjs —— 跨域迁移（规则挑候选，模型判能不能迁移）
 * 只在「真的要解决新问题」时调用，不常驻轮询。
 */
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { chatJSON } from './llm.mjs';

const KEY = () => '';
const UA = 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36';
const MODEL = '玉衡-gemini-3.8-flash';

async function ask(prompt) {
  return chatJSON({
    system: '你是跨领域迁移专家。只输出 JSON：{"transferable":true|false,"how":"一句话具体怎么做","confidence":0~1}。不可迁移就 transferable=false 并说明原因。不要 markdown。',
    user: prompt,
    maxTokens: 400,
  });
}

/** 给一个当前问题，返回一条可执行的迁移建议（或 null） */
export async function transfer(db, problem) {
  // 候选：别的领域里「问题→解法」相邻的记录
  const rows = db.prepare(`SELECT text, ts_from FROM node WHERE layer<=2
    AND kind IN ('event','fact','conclusion','correction','rule') ORDER BY ts_from`).all();
  const cands = [];
  for (let i = 0; i < rows.length; i++) {
    const a = String(rows[i].text), b = String(rows[i + 1]?.text || '');
    if (!/失败|报错|不行|连不上|超时|卡/.test(a)) continue;
    if (!/改成|换了|修好|解决|这样就|改用|开一下|重启/.test(b)) continue;
    if (a.includes(problem.slice(0, 6))) continue;      // 同一件事不算跨域
    cands.push({ p: a.slice(0, 80), s: b.slice(0, 80) });
    if (cands.length >= 3) break;
  }
  if (!cands.length) return { transferable: false, how: '', confidence: 0, reason: '库里没有可迁移的先例' };

  const prompt = `当前新问题：${problem}\n\n库里的旧经验：\n`
    + cands.map((c, i) => `${i + 1}) 当时的问题：${c.p}\n   当时的解法：${c.s}`).join('\n')
    + `\n\n问：这些旧经验能不能迁移到当前问题？如果能，具体怎么套用？`;
  const out = await ask(prompt);
  if (!out) return null;
  return { ...out, candidates: cands.length };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const db = new DatabaseSync(new URL('./memory.db', import.meta.url).pathname);
  const q = process.argv.slice(2).join(' ') || '记忆检索越来越慢';
  const r = await transfer(db, q);
  console.log('问题:', q);
  console.log('结果:', JSON.stringify(r, null, 1).slice(0, 600));
}
