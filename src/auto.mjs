/**
 * auto.mjs —— 全量转录（增量）
 *
 * 每 5 分钟把当前会话新增的对话导入主库；不重复导入（按字节偏移记状态）。
 * 对应方案①的「全量记忆转录」。
 */
import fs from 'node:fs';
import { SESSIONS_DIR } from './config.mjs';
import path from 'node:path';
import zlib from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import { queue, drain } from './mg.mjs';
import { build as buildIndex } from './index.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const STATE = path.join(HERE, 'auto.state.json');
const MAG = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

function state() {
  try { return JSON.parse(fs.readFileSync(STATE, 'utf-8')); } catch { return {}; }
}
function saveState(s) { fs.writeFileSync(STATE, JSON.stringify(s, null, 1)); }

function decodeFrames(buf) {
  const offs = [];
  let i = 0;
  while ((i = buf.indexOf(MAG, i)) !== -1) { offs.push(i); i++; }
  if (!offs.length) { try { return zlib.zstdDecompressSync(buf); } catch { return Buffer.alloc(0); } }
  const out = [];
  for (let k = 0; k < offs.length; k++) {
    const end = k + 1 < offs.length ? offs[k + 1] : buf.length;
    try { out.push(zlib.zstdDecompressSync(buf.subarray(offs[k], end))); } catch { /* 尾帧 */ }
  }
  return Buffer.concat(out);
}

function extractText(o) {
  const d = o.data ?? o;
  if (typeof d.text === 'string') return d.text;
  const c = d.content ?? d.message?.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((x) => (typeof x === 'string' ? x : x?.text ?? '')).join(' ');
  return '';
}

// 承诺/待办识别：一旦命中就当钉子，永不衰减
const PROMISE_RE = /我答应|答应你|说好了?|一定|保证|明天.{0,6}(给你|帮你|画|做|发)|下次.{0,6}(给你|帮你)|我会(给你|帮你|记得|把)|包在我身上/;
function promiseOf(t) {
  const m = t.match(/(生图|画|图片|头像|壁纸|安装|备份|恢复|查询?|下载|注册|接入|修复|改|写)/);
  return m ? m[1] : null;
}

const DRAFTS = ['Short warm reply', 'User just says', 'User says', 'The user says', 'Keep it short',
  'Let me ', 'I need to ', 'Reply short', '（点头', '（顿了顿', '（尾鳍'];

export function ingestSession(file, dbPath = (process.env.MG_DB || path.join(process.cwd(), 'memory.db'))) {
  const st = state();
  const size = fs.statSync(file).size;
  const prev = st[file] || 0;
  if (size <= prev) return { added: 0, skipped: true, size };

  const buf = fs.readFileSync(file);
  const chunk = buf.subarray(prev);
  const text = decodeFrames(chunk).toString('utf-8');
  const db = new DatabaseSync(dbPath);

  let queued = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o.type !== 'user/message' && o.type !== 'assistant/message') continue;
    const raw = extractText(o);
    const t = String(raw).replace(/\s+/g, ' ').trim();
    if (t.length < 4) continue;
    if (/<system-reminder>|Progress:|^ok |Downloaded and extracted|```|\[stderr\]/i.test(raw)) continue;
    const ascii = (t.match(/[A-Za-z0-9\s]/g) || []).length / t.length;
    if (ascii > 0.72 && t.length > 40) continue;
    if (DRAFTS.some((p) => t.startsWith(p))) continue;
    const isUser = o.type === 'user/message';
    if (!isUser && t.length > 220) continue;
    if (isUser && /需求[:：]|要求[:：]|写一个|写个|实现一个|代码精简|帮我做|请输出/.test(t)) continue;
    const isPromise = PROMISE_RE.test(t) && !isUser;
    queue(db, {
      kind: isPromise ? 'promise' : 'event', text: t,
      ts: typeof o.time === 'number' ? o.time : Date.now(),
      source: 'chat', speaker: isUser ? 'owner' : 'self',
      importance: isPromise ? 0.95 : (isUser ? 0.6 : 0.35),
      confidence: 0.99, userConfirmed: isUser,
    });
    if (isPromise) {
      try {
        db.prepare(`UPDATE node SET pinned=1, status='open', promise_of=? WHERE text=? ORDER BY id DESC LIMIT 1`)
          .run(promiseOf(t), t);
      } catch {}
    }
    queued++;
  }
  const r = queued ? drain(db, { verbose: false }) : { added: 0, deduped: 0, linked: 0 };
  st[file] = size;
  saveState(st);
  return { queued, added: r.added, deduped: r.deduped, linked: r.linked, size };
}

export function newestSession() {
  const base = SESSIONS_DIR;
  let best = null, bestT = 0;
  const walk = (dir, depth = 0) => {
    if (depth > 3) return;
    let list; try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const d of list) {
      const p = path.join(dir, d.name);
      if (d.isDirectory()) walk(p, depth + 1);
      else if (d.name.startsWith('session.v4.jsonl')) {
        const m = fs.statSync(p).mtimeMs;
        if (m > bestT) { bestT = m; best = p; }
      }
    }
  };
  walk(base);
  return best;
}

export function tickRebuild() {
  const r = buildIndex();
  return r;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const argFile = process.argv.slice(2).find((a) => !a.startsWith('--'));
  const f = argFile || newestSession();
  console.log('会话:', f);
  const r = ingestSession(f);
  console.log('结果:', r);
  if (process.argv.includes('--rebuild')) console.log('副库:', tickRebuild());
}
