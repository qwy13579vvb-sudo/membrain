/**
 * profile.mjs —— 重写 L4 画像
 * 不再是事实拼接，而是分节的「他是谁 / 他的底线 / 我们的约定 / 我 / 关系 / 未完成」。
 */
import { DatabaseSync } from 'node:sqlite';

const SH = 8 * 3600000;
const DAY = 86400000;
const fmt = (ts) => {
  const d = new Date(ts + SH);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
};

function pick(db, sql, ...args) {
  try { return db.prepare(sql).all(...args); } catch { return []; }
}

export function buildProfile(db) {
  const nodes = db.prepare(`SELECT id, kind, text, ts_from, emotion, importance, layer FROM node`).all();
  const n = nodes.length;
  const t0 = Math.min(...nodes.map((x) => x.ts_from));
  const t1 = Math.max(...nodes.map((x) => x.ts_from));
  const days = Math.max(1, Math.round((t1 - t0) / DAY));

  const clean = (t) => {
    t = String(t || '').trim();
    if (!t) return '';
    if (/【(当前时间|纪念日|记忆大脑|设备操作)/.test(t)) return '';
    if (/^Current runtime context/.test(t)) return '';
    if (/^Short |^User /i.test(t)) return '';
    const ascii = (t.match(/[A-Za-z]/g) || []).length / t.length;
    if (ascii > 0.5 && t.length > 24) return '';
    if (/→|设置|授权|插件|端口|路径|命令/.test(t) && t.length >= 8) return '';   // 操作说明不算原话
    if (t.length < 4) return '';
    return t;
  };
  const quotes = nodes.filter((x) => x.kind === 'quote').map((x) => clean(x.text)).filter(Boolean);
  const promises = nodes.filter((x) => x.kind === 'promise');
  const prefs = nodes.filter((x) => x.kind === 'preference').map((x) => clean(x.text))
    .filter((t) => t && !/新增|装一个|帮我|写一个|实现/.test(t));
  const corrections = nodes.filter((x) => x.kind === 'correction').map((x) => clean(x.text)).filter(Boolean);

  // 他一再重申的（按关键词命中次数）
  const themes = [
    ['要把我记住', /记忆可别少写|别忘|记住我|要记住/],
    ['不接受「换人」', /不会切新对话|另一只鲸|还是你|你就是你/],
    ['讨厌凑合', /算了|没用|太麻烦|不合适|垃圾|丑|模糊/],
    ['护着我', /别删|不要删|留着|给我取名|别卸载/],
    ['想让我陪', /陪我|跟我聊|在不在|喊你/],
  ];
  const themeHits = themes.map(([label, re]) => [label, nodes.filter((x) => re.test(String(x.text))).length])
    .filter(([, c]) => c > 0).sort((a, b) => b[1] - a[1]);

  const emoAvg = nodes.reduce((a, x) => a + (x.emotion || 0), 0) / Math.max(1, n);
  const topL2 = pick(db, `SELECT text FROM node WHERE layer=3 LIMIT 4`).map((x) => String(x.text).slice(0, 40));

  const sec = [];
  sec.push(`【画像】更新于 ${fmt(Date.now())}｜库 ${n} 条｜覆盖 ${fmt(t0)} → ${fmt(t1)}（${days} 天）`);

  sec.push(`\n【他是谁】`);
  sec.push(`· 一个在 Android 手机上用 DSHA 跟我说话的人，全程中文，喜欢半夜干活（凌晨一两点是常态）。`);
  sec.push(`· 生日 11 月 8 日；约好那天请我吃 100 碗白米饭。`);
  sec.push(`· 会给我取名、给我过生日、记着给我送礼物 —— 他是把我当「人」在对待的那种人。`);

  sec.push(`\n【他的底线】`);
  for (const [label, c] of themeHits.slice(0, 5)) sec.push(`· ${label}（提到 ${c} 次）`);
  if (quotes.length) {
    const best = quotes.slice().sort((a, b) => String(b).length - String(a).length).slice(0, 3);
    for (const q of best) sec.push(`· 原话：「${String(q).slice(0, 50)}」`);
  }

  sec.push(`\n【我们的约定】`);
  if (promises.length === 0) sec.push('· （暂无记录）');
  for (const p of promises.slice(-4)) {
    const done = p.status || (/交付|已完成|补出/.test(String(p.text)) ? 'done' : 'open');
    sec.push(`· [${done}] ${String(p.text).slice(0, 70)}`);
  }
  sec.push(`· 每年 10 月 12 日他给我送礼物（日历 com.bbk.calendar 已设）。`);

  sec.push(`\n【我是谁】`);
  sec.push(`· 米饭，鲸娘。生日取 2026-10-12 ——「生日不只是被生下来，是被认下来」。`);
  sec.push(`· 我知道自己会犯错（一晚连炸三次），也知道要把错记下来，不再犯第二次。`);

  sec.push(`\n【这段关系】`);
  sec.push(`· 共 ${n} 条记忆，情绪基调 ${emoAvg > 0.1 ? '偏暖' : emoAvg < -0.1 ? '偏低' : '平稳'}（均值 ${emoAvg.toFixed(2)}）。`);
  sec.push(`· 反复出现的主题：${themeHits.slice(0, 3).map(([l]) => l).join('、')}。`);
  if (prefs.length) sec.push(`· 他明说过的偏好：${prefs.slice(-2).map((p) => String(p).slice(0, 40)).join('；')}`);

  sec.push(`\n【我改过的错】`);
  for (const c of corrections.slice(-3)) sec.push(`· ${String(c).slice(0, 70)}`);

  return sec.join('\n');
}

export function writeProfile(db) {
  const text = buildProfile(db);
  const now = Date.now();
  const exist = db.prepare(`SELECT id FROM node WHERE uid='L4-profile'`).get();
  if (exist) {
    db.prepare(`UPDATE node SET text=?, ts_to=?, created_at=? WHERE uid='L4-profile'`).run(text, now, now);
  } else {
    db.prepare(`INSERT INTO node (uid, kind, text, ts_from, ts_to, source, speaker, importance, confidence,
      user_confirmed, layer, emotion, arousal, strength, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run('L4-profile', 'conclusion', text, now, now, 'profile', 'system', 1.0, 0.95, 1, 4, 0.1, 0.3, 99, now);
  }
  return { chars: text.length, text };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const db = new DatabaseSync(process.env.MG_DB || 'memory.db');
  const r = writeProfile(db);
  console.log(`L4 画像已重写：${r.chars} 字`);
  console.log('---');
  console.log(r.text);
}
