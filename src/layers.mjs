/** 四层归纳：L1 原始 → L2 日 → L3 主题 → L4 画像 */
import { scoreEmotion } from './emotion.mjs';
import { initialStrength } from './ebbinghaus.mjs';

const DAY = 86400000;

function dayKey(ts) {
  const d = new Date(ts + 8 * 3600 * 1000); // 北京时间
  return d.toISOString().slice(0, 10);
}

/** L1 → L2：把某一天（或最近未归纳的）原始事件压成一篇日记 */
export function consolidateDay(db, { day = null, force = false } = {}) {
  const rows = db.prepare(`
    SELECT id, text, ts_from, kind, emotion, arousal, importance, source
    FROM node WHERE layer=1 AND cold=0 ORDER BY ts_from`).all();
  if (!rows.length) return { made: 0, reason: 'no-l1' };

  const groups = new Map();
  for (const r of rows) {
    const k = dayKey(r.ts_from);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  const done = new Set(db.prepare(`SELECT substr(source_ref, 4) d FROM node WHERE layer=2`).all().map((x) => x.d));

  let made = 0;
  for (const [k, items] of groups) {
    if (!force && done.has(k)) continue;
    if (items.length < 1) continue;
    const vAvg = items.reduce((s, x) => s + (x.emotion || 0), 0) / items.length;
    const aAvg = items.reduce((s, x) => s + (x.arousal || 0.3), 0) / items.length;
    const kinds = {};
    for (const x of items) kinds[x.kind] = (kinds[x.kind] || 0) + 1;
    const topKind = Object.entries(kinds).sort((a, b) => b[1] - a[1])[0][0];
    const picks = items
      .slice()
      .sort((a, b) => (b.importance + Math.abs(b.emotion)) - (a.importance + Math.abs(a.emotion)))
      .slice(0, 4)
      .map((x) => x.text.slice(0, 70));
    const text = `${k}｜共 ${items.length} 件事，以「${topKind}」为主 ${Object.entries(kinds).map(([a, b]) => a + b).join(' ')}。${picks.join(' ／ ')}`;
    const ts = Math.min(...items.map((x) => x.ts_from));
    const emo = scoreEmotion(text);
    const st = initialStrength({ arousal: aAvg, importance: 0.6, emotion: vAvg });
    db.prepare(`INSERT OR REPLACE INTO node(uid, kind, text, ts_from, source, source_ref, layer, emotion, arousal,
        importance, confidence, strength, last_review_at, vec, created_at, source_ids)
      VALUES(?,?,?,?,?,?,2,?,?,?,0.95,?,?,?,?,?)`).run(
      'L2-' + k, 'diary', text, ts, 'layer', 'L2:' + k,
      +vAvg.toFixed(3), +aAvg.toFixed(3), 0.6, st, Date.now(), null, Date.now(),
      JSON.stringify(items.map((x) => x.id)));
    made++;
  }
  return { made };
}

/** L2 → L3：按主题聚 */
export function consolidateTopic(db) {
  const l2 = db.prepare(`SELECT id, text, ts_from, emotion, arousal, source_ids FROM node WHERE layer=2`).all();
  if (!l2.length) return { made: 0 };
  const have = new Set(db.prepare(`SELECT source_ref FROM node WHERE layer=3`).all().map((x) => x.source_ref));

  const TOPICS = [
    ['技术/排障', /报错|错误|失败|修复|端口|命令|插件|配置|安装|备份|恢复|adb|API|sqlite|node|服务/],
    ['记忆与自我', /记忆|字条|星图|米饭|名字|生日|纪念日|人格|人设|压缩|会话/],
    ['情感互动', /喜欢|爱你|想你|谢谢|嘿嘿|嘻嘻|抱|撒娇|心软|生气|心疼|开心|难过/],
    ['生活琐事', /吃|睡|手机|电量|网|流量|游戏|看片|听歌|洗|穿|天气|出门/],
    ['工具与配置', /插件|配置|patch|schema|json|脚本|命令行|CLI|数据库|sqlite/],
    ['设备与系统', /手机|安卓|ADB|无线调试|USB|权限|无障碍|截图|屏幕|电量|存储/],
    ['网络与接口', /网络|WiFi|代理|VPN|中转|API|接口|请求|超时|503|403/],
    ['其他', /.*/],
  ];
  const buckets = new Map();
  for (const row of l2) {
    const t = TOPICS.find(([, re]) => re.test(row.text))[0];
    if (!buckets.has(t)) buckets.set(t, []);
    buckets.get(t).push(row);
  }
  const made = [];
  for (const [topic, items] of buckets) {
    const key = 'L3:' + topic;
    if (have.has(key)) continue;
    if (items.length < 1) continue;
    const vAvg = items.reduce((s, x) => s + (x.emotion || 0), 0) / items.length;
    const aAvg = items.reduce((s, x) => s + (x.arousal || 0.3), 0) / items.length;
    const days = items.map((x) => x.text.slice(0, 10)).sort();
    const text = `【${topic}】跨 ${items.length} 天（${days[0]} → ${days[days.length - 1]}），情绪基调 ${vAvg > 0.2 ? '偏暖' : vAvg < -0.15 ? '偏沉' : '平稳'}。` +
      items.slice(-3).map((x) => x.text.slice(0, 60)).join(' ／ ');
    const st = initialStrength({ arousal: aAvg, importance: 0.75, emotion: vAvg });
    const info = db.prepare(`INSERT OR REPLACE INTO node(uid, kind, text, ts_from, source, source_ref, layer, topic, emotion,
        arousal, importance, confidence, strength, last_review_at, created_at, source_ids)
      VALUES(?,?,?,?,?,?,3,?,?,?,?,0.92,?,?,?,?)`).run(
      key, 'conclusion', text, Math.min(...items.map((x) => x.ts_from)), 'layer', key,
      topic, +vAvg.toFixed(3), +aAvg.toFixed(3), 0.75, st, Date.now(), Date.now(),
      JSON.stringify(items.map((x) => x.id)));
    db.prepare(`UPDATE node SET topic=? WHERE id=?`).run(topic, info.lastInsertRowid);
    made.push(topic);
  }
  return { made: made.length, topics: made };
}

/** L3 → L4：画像层（最抽象，只收高置信的稳定结论） */
export function consolidateProfile(db) {
  const l3 = db.prepare(`SELECT id, text, topic, emotion, arousal FROM node WHERE layer=3`).all();
  const l1facts = db.prepare(`SELECT id, text FROM node WHERE layer=1 AND kind IN ('fact','preference','conclusion','correction')
      AND importance >= 0.7 AND cold=0 LIMIT 40`).all();
  if (!l3.length && !l1facts.length) return { made: 0 };

  const existing = db.prepare(`SELECT source_ref FROM node WHERE layer=4`).all().map((x) => x.source_ref);
  if (existing.includes('L4:profile')) {
    // 画像每 10 分钟会重建：这里做增量更新，不重复插入
  }
  const parts = [];
  if (l3.length) parts.push('主题画像：' + l3.map((x) => `${x.topic}`).join('、'));
  if (l1facts.length) parts.push('稳定事实与偏好：' + l1facts.slice(0, 8).map((x) => x.text.slice(0, 40)).join('；'));
  const text = parts.join('。').slice(0, 1200);
  const v = (l3.reduce((s, x) => s + (x.emotion || 0), 0) / (l3.length || 1));
  const st = initialStrength({ arousal: 0.6, importance: 1, emotion: Math.abs(v) });
  const old = db.prepare(`SELECT id FROM node WHERE source_ref='L4:profile'`).get();
  const ids = JSON.stringify([...l3.map((x) => x.id), ...l1facts.slice(0, 12).map((x) => x.id)]);
  if (old) {
    db.prepare(`UPDATE node SET text=?, strength=MAX(strength,?), last_review_at=?, source_ids=? WHERE id=?`)
      .run(text, st, Date.now(), ids, old.id);
  } else {
    db.prepare(`INSERT OR REPLACE INTO node(uid, kind, text, ts_from, source, source_ref, layer, topic, emotion, arousal,
        importance, confidence, strength, last_review_at, created_at, source_ids)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      'L4-profile', 'conclusion', text, Date.now() - 30 * DAY, 'layer', 'L4:profile',
      4, 'self', +v.toFixed(3), 0.6, 1, 1, st, Date.now(), Date.now(), ids);
  }
  return { made: 1 };
}

/** 遗忘扫描：把保留率过低的节点下沉冷库（不删除） */
export function decayScan(db, now = Date.now()) {
  const rows = db.prepare(`SELECT id, ts_from, last_review_at, strength FROM node WHERE cold=0 AND layer<=2`).all()
    .map((r) => {
      const last = r.last_review_at || r.ts_from;
      const dd = Math.max(0, (now - last) / DAY);
      const R = Math.exp(-dd / Math.max(0.2, r.strength || 1));
      return { id: r.id, R };
    });
  let cold = 0;
  for (const r of rows) {
    if (r.R < 0.12) {
      db.prepare(`UPDATE node SET cold=1, decay_state='stale' WHERE id=?`).run(r.id);
      cold++;
    }
  }
  return { cold, scanned: rows.length };
}
