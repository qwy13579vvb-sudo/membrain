/** 全量重连：对所有节点做 kNN 余弦，补 similar 边 + 同主题边 */
import { DatabaseSync } from 'node:sqlite';

const db = new DatabaseSync(process.env.MG_DB || 'memory.db');
const DIM = 256;
function bigrams(s){const t=String(s).replace(/[\s\p{P}]+/gu,' ').trim();const o=[];for(const c of t.split(' ')){if(!c)continue;if(c.length===1){o.push(c);continue}for(let i=0;i<c.length-1;i++)o.push(c.slice(i,i+2))}return o}
function hash32(s){let h=2166136261;for(let i=0;i<s.length;i++){h^=s.charCodeAt(i);h=Math.imul(h,16777619)}return h>>>0}
function vec(t){const v=new Float32Array(DIM);const g=bigrams(t);if(!g.length)return v;for(const x of g){v[hash32(x)%DIM]+=1}let n=0;for(let i=0;i<DIM;i++)n+=v[i]*v[i];n=Math.sqrt(n)||1;for(let i=0;i<DIM;i++)v[i]/=n;return v}
function cos(a,b){let s=0;for(let i=0;i<DIM;i++)s+=a[i]*b[i];return s}

const rows = db.prepare('SELECT id, text, layer, topic, ts_from FROM node WHERE cold=0').all();
console.log('参与重连:', rows.length, '条');
const vecs = rows.map((r) => vec(r.text));

// 清掉旧的 similar 边，保留其他关系
db.exec(`DELETE FROM edge WHERE rel='similar'`);

const ins = db.prepare('INSERT OR REPLACE INTO edge(src,dst,rel,weight,ts) VALUES(?,?,?,?,?)');
let added = 0;
db.exec('BEGIN');
const K = 6, MIN = 0.16;
for (let i = 0; i < rows.length; i++) {
  const sims = [];
  for (let j = 0; j < rows.length; j++) {
    if (i === j) continue;
    const s = cos(vecs[i], vecs[j]);
    if (s >= MIN) sims.push([j, s]);
  }
  sims.sort((a, b) => b[1] - a[1]);
  for (const [j, s] of sims.slice(0, K)) {
    const a = rows[i].id, b = rows[j].id;
    const [src, dst] = a < b ? [a, b] : [b, a];
    ins.run(src, dst, 'similar', +s.toFixed(3), Math.max(rows[i].ts_from, rows[j].ts_from));
    added++;
  }
}
// 同主题边（拿 topic / layer 上层串起来）
const tops = db.prepare(`SELECT id, topic FROM node WHERE layer=3 AND topic IS NOT NULL`).all();
for (const t of tops) {
  const kids = db.prepare(`SELECT id FROM node WHERE layer=2 LIMIT 20`).all();
  for (const k of kids) { ins.run(t.id, k.id, 'same_topic', 0.5, Date.now()); added++; }
}
db.exec('COMMIT');
const orphan = db.prepare(`SELECT COUNT(*) c FROM node n WHERE NOT EXISTS (SELECT 1 FROM edge e WHERE e.src=n.id OR e.dst=n.id)`).get().c;
const total = db.prepare(`SELECT COUNT(*) c FROM node`).get().c;
console.log(`新增/更新边 ${added} 条；孤立节点 ${orphan}/${total}（${(orphan/total*100).toFixed(0)}%）`);
