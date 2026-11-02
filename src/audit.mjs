import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const db = new DatabaseSync(process.env.MG_DB || 'memory.db');
const idx = JSON.parse(fs.readFileSync('index.json', 'utf-8'));
const q = (s) => db.prepare(s).get();
const a = (s) => db.prepare(s).all();

const total = q('SELECT COUNT(*) c FROM node').c;
const cold = q('SELECT COUNT(*) c FROM node WHERE cold=1').c;
const layers = a('SELECT layer, COUNT(*) c FROM node GROUP BY layer ORDER BY layer');
const kinds = a('SELECT kind, COUNT(*) c FROM node GROUP BY kind ORDER BY c DESC');
const orphan = q('SELECT COUNT(*) c FROM node n WHERE NOT EXISTS (SELECT 1 FROM edge e WHERE e.src=n.id OR e.dst=n.id)').c;
const oldIdx = Date.now() - fs.statSync('index.json').mtimeMs;
const idxIds = new Set(idx.entries.map((e) => e.i));
const missing = a('SELECT id FROM node WHERE cold=0').filter((r) => !idxIds.has(r.id)).length;
const stale = idx.entries.filter((e) => !q(`SELECT 1 FROM node WHERE id=${e.i}`)).length;
const tagNoise = Object.entries(idx.tags).sort((x, y) => y[1].length - x[1].length).slice(0, 5)
  .map(([t, ids]) => `${t}(${ids.length})`);

console.log('【规模】');
console.log(`  主库 ${total} 条 / 副库 ${idx.entries.length} 条 / 冷库 ${cold}`);
console.log(`  主库 ${(fs.statSync('memory.db').size/1048576).toFixed(1)}MB / 副库 ${(fs.statSync('index.json').size/1024).toFixed(0)}KB`);
console.log('【一致性】');
console.log(`  副库缺主库条目: ${missing}  ${missing===0?'✅':'⚠️'}`);
console.log(`  副库残留已删 id: ${stale}  ${stale===0?'✅':'⚠️'}`);
console.log(`  副库新鲜度: ${(oldIdx/60000).toFixed(1)} 分钟前  ${oldIdx<900000?'✅':'⚠️'}`);
console.log('【结构】');
console.log('  层级:', layers.map((x) => `L${x.layer} ${x.c}`).join(' / '));
console.log('  类型:', kinds.map((x) => `${x.kind} ${x.c}`).join(' / '));
console.log(`  孤立节点（无边）: ${orphan} ${orphan/total>0.6?'⚠️ 连线太少':'✅'}`);
console.log('【标签】最高频:', tagNoise.join(' '));
console.log('【遗忘】冷库占比:', (cold/total*100).toFixed(1)+'%', cold/total>0.5?'⚠️ 偏高':'✅');

// —— 第二部分：矛盾与承诺审计 ——
const DAY2 = 86400000;
const now2 = Date.now();
const openPromises = a(`SELECT id, text, ts_from, promise_of FROM node WHERE kind='promise' AND (status IS NULL OR status='open')`);
console.log('【承诺】');
console.log(`  未完成: ${openPromises.length}`);
for (const p of openPromises.slice(0, 6)) {
  const age = ((now2 - p.ts_from) / DAY2).toFixed(1);
  console.log(`   · ${age} 天前 · ${String(p.promise_of || '?')} · ${String(p.text).slice(0, 50)}`);
}

// 矛盾：高相似但语气相反（一个含否定）
const NEG = /不用|不要|不装|别|取消|作废|算了|改成|不是/;
const rows2 = a(`SELECT id, text FROM node WHERE length(text) > 8 LIMIT 400`);
function bg(s) { const o = new Set(); for (let i = 0; i < s.length - 1; i++) o.add(s.slice(i, i + 2)); return o; }
function jac(a1, a2) { let inter = 0; for (const x of a1) if (a2.has(x)) inter++; return inter / (a1.size + a2.size - inter); }
const vecs = rows2.map((r) => bg(r.text));
const conflicts = [];
for (let i = 0; i < rows2.length && conflicts.length < 8; i++) {
  for (let j = i + 1; j < rows2.length; j++) {
    if (Math.abs(rows2[i].text.length - rows2[j].text.length) > 60) continue;
    const sim = jac(vecs[i], vecs[j]);
    if (sim < 0.62) continue;
    const negDiff = NEG.test(rows2[i].text) !== NEG.test(rows2[j].text);
    if (negDiff) conflicts.push([sim.toFixed(2), rows2[i].text.slice(0, 40), rows2[j].text.slice(0, 40)]);
    if (conflicts.length >= 8) break;
  }
}
console.log('【矛盾】可能冲突的对数:', conflicts.length);
for (const [sim, x, y] of conflicts.slice(0, 4)) console.log(`   ${sim}  「${x}」 vs 「${y}」`);
