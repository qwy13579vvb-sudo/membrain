/**
 * notify.mjs —— 让米饭能「喊人」（手机通知 + 震动）
 * 只用于三件事：巡检异常、当天承诺到期、纪念日。
 * 自带上限：每小时最多 2 条，同一内容 6 小时不重复。
 */
import fs from 'node:fs';
import { BRIDGE_HEADERS } from './config.mjs';
import path from 'node:path';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const STATE = path.join(HERE, 'notify.state.json');
const BRIDGE = 'http://127.0.0.1:3090';
const HEADERS = BRIDGE_HEADERS;

const load = () => { try { return JSON.parse(fs.readFileSync(STATE, 'utf-8')); } catch { return { sent: [] }; } };
const save = (s) => fs.writeFileSync(STATE, JSON.stringify(s));

async function bridge(pathAndQuery) {
  const h = fs.readFileSync(HEADERS, 'utf-8').split('\n')
    .map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
    .map((l) => `-H "${l}"`).join(' ');
  const { execSync } = await import('node:child_process');
  try {
    return execSync(`curl -s -m 10 ${h} "${BRIDGE}${pathAndQuery}"`, { encoding: 'utf-8', timeout: 12000 }).trim();
  } catch { return ''; }
}

export async function notify(title, text, { key = '', vibrateMs = 0, maxPerHour = 2, cooldownMs = 6 * 3600000 } = {}) {
  const now = Date.now();
  const st = load();
  st.sent = (st.sent || []).filter((x) => now - x.at < 24 * 3600000);

  if (key && st.sent.some((x) => x.key === key && now - x.at < cooldownMs)) return { skipped: 'cooldown' };
  if (st.sent.filter((x) => now - x.at < 3600000).length >= maxPerHour) return { skipped: 'rate' };

  const q = `?title=${encodeURIComponent(title)}&text=${encodeURIComponent(text)}`;
  const r = await bridge(`/app/notify${q}`);
  if (vibrateMs) await bridge(`/app/vibrate?ms=${vibrateMs}`);
  st.sent.push({ key, at: now, title, result: r });
  save(st);
  return { ok: true, result: r };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const title = process.argv[2] || '米饭';
  const text = process.argv[3] || '测试通知';
  console.log(await notify(title, text, { key: 'test', vibrateMs: 200 }));
}
