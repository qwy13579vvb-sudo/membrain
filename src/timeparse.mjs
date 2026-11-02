/** 把「昨天/前天/上周/N天前/今天」这类说法变成时间区间（北京时间） */
const DAY = 86400000;
const SH = 8 * 3600000;

function startOfDayCN(ts) {
  const d = new Date(ts + SH);
  d.setUTCHours(0, 0, 0, 0);
  return d.getTime() - SH;
}

/** 返回 {since, until, label} 或 null */
export function parseTimeRange(query, now = Date.now()) {
  const q = String(query);
  const today = startOfDayCN(now);

  const rel = [
    [/今天|今日/, 0], [/昨天|昨日/, 1], [/前天/, 2], [/大前天/, 3],
    [/(\d+)\s*天前/, -1],
  ];
  for (const [re, off] of rel) {
    const m = q.match(re);
    if (!m) continue;
    const n = off === -1 ? Number(m[1]) : off;
    if (!Number.isFinite(n)) continue;
    const s = today - n * DAY;
    return { since: s, until: s + DAY, label: `${n === 0 ? '今天' : n + '天前'}` };
  }
  if (/本周|这周/.test(q)) return { since: today - 6 * DAY, until: now, label: '本周' };
  if (/上周|上个?星期/.test(q)) return { since: today - 13 * DAY, until: today - 6 * DAY, label: '上周' };
  if (/本月|这个月/.test(q)) {
    const d = new Date(now + SH); d.setUTCDate(1); d.setUTCHours(0, 0, 0, 0);
    return { since: d.getTime() - SH, until: now, label: '本月' };
  }
  return null;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  for (const q of ['昨天说过什么', '前天', '3天前', '上周']) {
    const r = parseTimeRange(q);
    console.log(q, '→', r ? `${r.label}  ${new Date(r.since).toLocaleString('zh-CN')} ~ ${new Date(r.until).toLocaleString('zh-CN')}` : '无');
  }
}
