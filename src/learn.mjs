/**
 * learn.mjs —— 自主学习三件套
 *  ① induce()      从相似记忆簇里归纳「规则」节点（kind=rule）
 *  ② analogy()     给一个问题找「结构相似」的旧案例（可迁移经验）
 *  ③ hypothesize() 提假设 → 等证据 → 自动确认/推翻（kind=hypothesis）
 */
import { DatabaseSync } from 'node:sqlite';

const DAY = 86400000;
const now = () => Date.now();

const DIM = 256;
function hash32(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function bg(s) {
  const t = String(s).replace(/[\s\p{P}]+/gu, '');
  const o = new Set();
  for (let i = 0; i < t.length - 1; i++) o.add(t.slice(i, i + 2));
  return o;
}
function vec(text) {
  const v = new Float32Array(DIM);
  for (const g of bg(text)) v[hash32(g) % DIM] += 1;
  let n = 0; for (let i = 0; i < DIM; i++) n += v[i] * v[i];
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < DIM; i++) v[i] /= n;
  return v;
}
function cos(a, b) { let s = 0; for (let i = 0; i < DIM; i++) s += a[i] * b[i]; return s; }
function sharedGrams(a, b) {
  const A = bg(a), B = bg(b);
  let n = 0; for (const g of A) if (B.has(g)) n++;
  return n;
}
function newUid(prefix) { return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`; }

/** ① 归纳经验：找「问题 → 解法」对，产出可迁移规则 */
const PROB = /报错|失败|连不上|超时|503|404|错误|不行|无效|卡住|打不开|白屏|崩|没反应|识别不到|拒绝|ENOENT|TRANSPORT/i;
const SOLVE = /修好|改成|改为|换成|改用|这样可以|解决|通了|成功|跑通|搞定|已生效|验证过|补上|删掉那条/i;

export function induce(db, { windowMs = 2 * 3600000, maxRules = 8, minSim = 0.16 } = {}) {
  const rows = db.prepare(`SELECT id, text, ts_from, kind FROM node
    WHERE layer=1 AND length(text) >= 12 AND kind IN ('event','fact','correction','conclusion')
    ORDER BY ts_from ASC`).all();
  const probs = rows.filter((r) => PROB.test(r.text) && !SOLVE.test(r.text));
  const sols = rows.filter((r) => SOLVE.test(r.text));
  const rules = [];
  const seen = new Set();

  for (const p of probs) {
    const pv = vec(p.text);
    // 必须同话题：共享实词 + 两小时内
    const after = sols
      .filter((s) => s.ts_from > p.ts_from && s.ts_from - p.ts_from <= windowMs)
      .map((s) => ({ s, sim: cos(pv, vec(s.text)), shared: sharedGrams(p.text, s.text) }))
      .filter((x) => x.sim >= minSim && x.shared >= 4)
      .sort((a, b) => b.sim - a.sim)[0]?.s;
    if (!after) continue;
    const key = String(p.text).slice(0, 12) + '→' + String(after.text).slice(0, 12);
    if (seen.has(key)) continue;
    seen.add(key);
    const ref = 'P:' + hash32(key).toString(36);
    if (db.prepare(`SELECT id FROM node WHERE kind='rule' AND source_ref=?`).get(ref)) continue;

    const problem = String(p.text).replace(/\s+/g, ' ').slice(0, 60);
    const solve = String(after.text).replace(/\s+/g, ' ').slice(0, 60);
    const text = `候选经验｜遇到「${problem}」→ 怀疑解法是「${solve}」。`
      + `（自动配对，未确认；确认后才升级为规则）`;
    db.prepare(`INSERT INTO node (uid, kind, text, ts_from, ts_to, source, source_ref, speaker,
        importance, confidence, user_confirmed, layer, emotion, arousal, strength, source_ids, created_at, status)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(newUid('cand'), 'hypothesis', text, p.ts_from, now(), 'induce', ref, 'system',
        0.5, 0.3, 0, 2, 0, 0.25, 6, JSON.stringify([p.id, after.id]), now(), 'pending');
    rules.push(text);
    if (rules.length >= maxRules) break;
  }
  return { made: rules.length, rules };
}

/** ② 举一反三：结构相似案例（共同标签≥2、但主题不同） */
export function analogy(db, text, { limit = 5 } = {}) {
  const tv = vec(text);
  const rows = db.prepare(`SELECT id, text, kind, ts_from, topic FROM node
    WHERE layer<=2 AND kind IN ('event','fact','conclusion','correction','rule','promise')`).all();
  const scored = [];
  for (const r of rows) {
    if (String(r.text).includes(text.slice(0, 6))) continue;
    const sim = cos(tv, vec(r.text));
    if (sim < 0.2) continue;
    const shared = sharedGrams(text, r.text);
    if (shared < 3) continue;
    scored.push({ r, sim, shared });
  }
  scored.sort((a, b) => b.sim - a.sim);
  return scored.slice(0, limit).map((x) => ({
    sim: +x.sim.toFixed(2), shared: x.shared, kind: x.r.kind, text: String(x.r.text).slice(0, 80),
  }));
}

/** ③ 假设 → 证据 → 确认/推翻 */
export function hypothesize(db, { hypothesis, probe }) {
  const uid = newUid('hyp');
  db.prepare(`INSERT INTO node (uid, kind, text, ts_from, ts_to, source, speaker, importance,
      confidence, user_confirmed, layer, emotion, arousal, strength, status, promise_of, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(uid, 'hypothesis', hypothesis, now(), now(), 'learn', 'self', 0.6, 0.4, 0, 2,
      0, 0.3, 5, 'pending', probe, now());
  return { uid, hypothesis, probe };
}

export function checkHypotheses(db) {
  const hyps = db.prepare(`SELECT id, uid, text, promise_of, created_at FROM node
    WHERE kind='hypothesis' AND (status IS NULL OR status='pending')`).all();
  let confirmed = 0, refuted = 0;
  for (const h of hyps) {
    const probe = h.promise_of;
    if (!probe) continue;
    const evid = db.prepare(`SELECT id, text FROM node WHERE text LIKE ? AND ts_from > ? LIMIT 3`)
      .all(`%${probe}%`, h.created_at);
    if (evid.length >= 1) {
      db.prepare(`UPDATE node SET status='confirmed', confidence=?, text=? WHERE id=?`)
        .run(0.8, `${h.text}（已由 ${evid.length} 条证据确认）`, h.id);
      confirmed++;
    } else if (now() - h.created_at > 7 * DAY) {
      db.prepare(`UPDATE node SET status='refuted', confidence=0.1 WHERE id=?`).run(h.id);
      refuted++;
    }
  }
  return { checked: hyps.length, confirmed, refuted };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const db = new DatabaseSync(new URL('./memory.db', import.meta.url).pathname);
  const cmd = process.argv[2];
  if (cmd === 'induce') {
    const r = induce(db);
    console.log(`归纳出 ${r.made} 条规则`);
    for (const x of r.rules) console.log('  ·', String(x).slice(0, 130));
  } else if (cmd === 'analogy') {
    const q = process.argv.slice(3).join(' ');
    const r = analogy(db, q);
    console.log(`「${q}」的相似案例 ${r.length} 条：`);
    for (const x of r) console.log(`  ${x.sim} [${x.kind}] ${x.text}`);
  } else if (cmd === 'check') {
    console.log(checkHypotheses(db));
  } else {
    console.log('用法: node learn.mjs induce | analogy "问题" | check');
  }
}

// ============ ③ 跨域类比 ============
// 不靠词汇相似，靠「问题类型」相同 + 领域不同。
const DOMAINS = [
  ['网络/接口', /网络|WiFi|代理|VPN|中转|API|接口|请求|超时|5\d\d|4\d\d|DNS|端口/],
  ['权限/设备', /ADB|权限|无障碍|root|Shizuku|屏幕|截图|设备|安装|卸载/],
  ['数据/存储', /数据库|sqlite|备份|恢复|索引|记忆|文件|磁盘|附件/],
  ['代码/前端', /前端|页面|CSS|渲染|脚本|插件|配置|报错|语法|依赖/],
  ['生图/内容', /生图|图片|插画|模型|提示词|水印|画风/],
];
export function classifyDomain(text) {
  let best = null, bestScore = 0;
  for (const [name, re] of DOMAINS) {
    const hits = (String(text).match(new RegExp(re.source, 'g')) || []).length;
    if (hits > bestScore) { bestScore = hits; best = name; }
  }
  return best;
}

const SOLVE_WORDS = /修好|改成|改为|换成|改用|这样就|解决|通了|成功|跑通|搞定|已生效|补上|加个|删掉|重启|开一下|关掉/;

/** 跨域类比：同类问题、不同领域的解法 */
export function crossAnalogy(db, problem, { limit = 4 } = {}) {
  const domain = classifyDomain(problem);
  const rows = db.prepare(`SELECT id, text, kind, topic, ts_from FROM node
    WHERE layer<=2 AND kind IN ('event','fact','conclusion','correction','rule')`).all();
  const probs = [];
  for (const r of rows) {
    const t = String(r.text);
    if (!PROB.test(t) || SOLVE_WORDS.test(t)) continue;
    const d = classifyDomain(t);
    if (!d || d === domain) continue;               // 必须跨域
    probs.push({ r, d });
  }
  const out = [];
  for (const p of probs) {
    const sol = rows.filter((s) => s.ts_from > p.r.ts_from && s.ts_from - p.r.ts_from < 12 * 3600000
        && SOLVE_WORDS.test(String(s.text)))
      .sort((a, b) => a.ts_from - b.ts_from)[0];
    if (!sol) continue;
    out.push({
      fromDomain: p.d,
      problem: String(p.r.text).slice(0, 60),
      solution: String(sol.text).slice(0, 60),
      transfer: `「${p.d}」里这样解决过 → 在「${domain || '当前领域'}」可以试试同一招`,
    });
    if (out.length >= limit) break;
  }
  return { domain, items: out };
}

// ============ ④ 反例验证 ============
const CONTRA = /不行|没用|无效|反而|不对|不是这样|失败了|还是不行|取消|作废|别用|不要用/;

/** 规则被反例打脸 → 降置信；低于 0.3 直接作废并记缺口 */
export function verifyRules(db, { demote = 0.2, floor = 0.3 } = {}) {
  const rules = db.prepare(`SELECT id, text, ts_from, confidence FROM node
    WHERE kind='rule' AND COALESCE(status,'open') != 'refuted'`).all();
  const rows = db.prepare(`SELECT text, ts_from FROM node WHERE layer<=2`).all();
  let demoted = 0, refuted = 0;
  for (const r of rules) {
    const key = (String(r.text).match(/「([^」]{2,12})」/g) || []).map((x) => x.slice(1, -1)).slice(0, 3);
    if (!key.length) continue;
    const bad = rows.filter((x) => x.ts_from > r.ts_from
      && CONTRA.test(String(x.text))
      && key.some((k) => String(x.text).includes(k))).length;
    if (bad < 2) continue;
    const conf = Math.max(0.05, (r.confidence || 0.7) - demote * bad);
    if (conf < floor) {
      db.prepare(`UPDATE node SET confidence=?, status='refuted' WHERE id=?`).run(conf, r.id);
      refuted++;
    } else {
      db.prepare(`UPDATE node SET confidence=? WHERE id=?`).run(conf, r.id);
      demoted++;
    }
  }
  return { checked: rules.length, demoted, refuted };
}
