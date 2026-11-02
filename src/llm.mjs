/**
 * llm.mjs —— 统一模型入口（官方 DeepSeek 优先）
 * key 从 CRED_FILE 指向的 YAML 里按环境变量名读取；也可以用 MEMBRAIN_LLM_KEY 直接给。
 */
import fs from 'node:fs';
import { CRED_FILE } from './config.mjs';

const CRED = CRED_FILE;
const BASE = process.env.DSH_LLM_BASE || 'https://api.deepseek.com/v1';
const MODEL = process.env.DSH_LLM_MODEL || 'deepseek-chat';

let cachedKey = null;
export function officialKey() {
  if (cachedKey) return cachedKey;
  const t = fs.readFileSync(CRED, 'utf-8');
  const m = t.match(/DSHA_DEEPSEEK_OFFICIAL_API_KEY:\s*(\S+)/);
  if (!m) throw new Error('凭据里没有 DSHA_DEEPSEEK_OFFICIAL_API_KEY');
  cachedKey = m[1].trim().replace(/^["']|["']$/g, '');
  return cachedKey;
}

/** 返回文本；配额/网络问题抛错，调用方自行降级 */
export async function chat({ system, user, maxTokens = 2000, temperature = 0.2, model = MODEL }) {
  const messages = [];
  if (system) messages.push({ role: 'system', content: system });
  messages.push({ role: 'user', content: user });
  const res = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${officialKey()}`,
      'User-Agent': 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36',
    },
    body: JSON.stringify({ model, messages, temperature, max_tokens: maxTokens }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    if (res.status === 401) throw new Error('BADKEY');
    if (/quota|balance|insufficient/i.test(body)) throw new Error('NOQUOTA:' + body.slice(0, 120));
    throw new Error(`HTTP ${res.status}: ${body.slice(0, 120)}`);
  }
  const j = await res.json();
  const c = String(j?.choices?.[0]?.message?.content || '').trim();
  if (!c && process.env.DBG) console.error('[dbg] 空回复:', JSON.stringify(j).slice(0, 400));
  return c;
}

/** JSON 出参：带容错 */
export async function chatJSON(opts) {
  const t = await chat(opts);
  const s = t.indexOf('{'), e = t.lastIndexOf('}');
  if (s < 0) return null;
  const body = t.slice(s, e + 1);
  try { return JSON.parse(body); } catch { /* 补括号 */ }
  for (const tail of ['}', ']}', '}]}']) {
    try { return JSON.parse(body + tail); } catch { /* next */ }
  }
  return null;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const t = await chat({ user: '只回两个字：在线', maxTokens: 20 });
  console.log('官方模型回复:', t);
  console.log('模型:', MODEL, '/ 端点:', BASE);
}
