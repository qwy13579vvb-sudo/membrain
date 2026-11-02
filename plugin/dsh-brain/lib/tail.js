/** 从会话日志尾部取「用户最后一句真话」——增量读，不扫全文件 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const MAG = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const SESS = '/root/.dsh/sessions';
const state = { file: null, offset: 0, lastQuery: '' };

function newestSession() {
  let best = null, bestT = 0;
  const walk = (dir, depth) => {
    if (depth > 4) return;
    let list; try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of list) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.name.startsWith('session.v4.jsonl')) {
        let m = 0; try { m = fs.statSync(p).mtimeMs; } catch { continue; }
        if (m > bestT) { bestT = m; best = p; }
      }
    }
  };
  walk(SESS, 0);
  return best;
}

function frames(buf) {
  const offs = []; let i = 0;
  while ((i = buf.indexOf(MAG, i)) !== -1) { offs.push(i); i++; }
  const out = [];
  for (let k = 0; k < offs.length; k++) {
    const end = k + 1 < offs.length ? offs[k + 1] : buf.length;
    try { out.push(zlib.zstdDecompressSync(buf.subarray(offs[k], end))); } catch { /* 尾帧 */ }
  }
  return Buffer.concat(out);
}

function userTextFrom(rec) {
  const ins = rec?.data?.inserted;
  if (!Array.isArray(ins)) return '';
  for (const it of ins) {
    if (it?.source?.kind !== 'user') continue;
    const parts = Array.isArray(it.content) ? it.content : [];
    const t = parts.map((c) => (typeof c === 'string' ? c : c?.text || '')).join(' ').trim();
    if (t) return t;
  }
  return '';
}

/** 返回用户最后一条消息（增量解析） */
export function lastUserMessage() {
  let file;
  try { file = newestSession(); } catch { return state.lastQuery; }
  if (!file) return state.lastQuery;

  let size = 0;
  try { size = fs.statSync(file).size; } catch { return state.lastQuery; }

  if (state.file !== file) {
    // 新会话：只从尾部 ~2MB 起读，避免重启时全量解析
    state.file = file;
    state.offset = Math.max(0, size - 2 * 1024 * 1024);
    // 对齐到下一个帧头
    try {
      const head = fs.openSync(file, 'r');
      const buf = Buffer.alloc(64 * 1024);
      const n = fs.readSync(head, buf, 0, buf.length, state.offset);
      fs.closeSync(head);
      const idx = buf.subarray(0, n).indexOf(MAG);
      if (idx >= 0) state.offset += idx;
    } catch { /* 保持原值 */ }
  }
  if (size <= state.offset) return state.lastQuery;

  let chunk;
  try {
    const fd = fs.openSync(file, 'r');
    const len = size - state.offset;
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, state.offset);
    fs.closeSync(fd);
    chunk = buf;
  } catch { return state.lastQuery; }

  const text = frames(chunk).toString('utf-8');
  let found = '';
  for (const line of text.split('\n')) {
    if (!line.trim() || !line.includes('agent/inbox/spliced')) continue;
    let rec; try { rec = JSON.parse(line); } catch { continue; }
    const t = userTextFrom(rec);
    if (t) found = t;
  }
  // 只推进到最后一个完整帧，避免半截帧
  const lastFrame = chunk.lastIndexOf(MAG);
  if (lastFrame > 0) state.offset += lastFrame;

  if (found) {
    state.lastQuery = found
      .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, ' ')
      .replace(/\s+/g, ' ').trim().slice(0, 800);
  }
  return state.lastQuery;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log('最后一句:', JSON.stringify(lastUserMessage().slice(0, 200)));
}
