#!/usr/bin/env node
/** 核心算法单元测试：遗忘曲线 / 间隔重复 / 初始强度 / 时间词解析 */
import assert from 'node:assert';
import { retention, review, initialStrength, COLD_THRESHOLD } from '../src/ebbinghaus.mjs';
import { parseTimeRange } from '../src/timeparse.mjs';

const DAY = 86400000;
let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log('  ✅', name); }
  catch (e) { fail++; console.log('  ❌', name, '→', e.message); }
};
const node = (daysAgo, strength = 10) => ({
  ts_from: Date.now() - daysAgo * DAY,
  strength,
  review_count: 0,
  last_review_at: Date.now() - daysAgo * DAY,
});

console.log('遗忘曲线');
t('刚写入 → 保留率约 1', () => {
  const r = retention(node(0, 10));
  assert.ok(r > 0.99 && r <= 1, 'r=' + r);
});
t('时间越久 → 保留率越低', () => {
  const a = retention(node(1, 10)), b = retention(node(30, 10));
  assert.ok(a > b, `${a.toFixed(3)} 应大于 ${b.toFixed(3)}`);
});
t('强度越大 → 同等时间下留存越高', () => {
  const weak = retention(node(10, 2)), strong = retention(node(10, 20));
  assert.ok(strong > weak, `${strong.toFixed(3)} 应大于 ${weak.toFixed(3)}`);
});
t('半衰期 = S·ln2：一个半衰期后约 0.5', () => {
  const S = 10, halfLifeDays = S * Math.LN2;
  const r = retention(node(halfLifeDays, S));
  assert.ok(Math.abs(r - 0.5) < 0.02, 'r=' + r.toFixed(3));
});
t('极久未复习 → 低于冷库阈值', () => {
  assert.ok(retention(node(365, 3)) < COLD_THRESHOLD);
});

console.log('\n间隔重复');
t('复习后强度上升', () => {
  const before = node(20, 10);
  const after = review(before);
  assert.ok(after.strength > before.strength, `${after.strength} > ${before.strength}`);
});
t('忘得越多、复习收益越大', () => {
  const faded = review(node(60, 10));   // 几乎忘光
  const fresh = review(node(0, 10));    // 刚记过
  assert.ok(faded.strength > fresh.strength, `${faded.strength} > ${fresh.strength}`);
});
t('复习次数 +1 且记录时间', () => {
  const r = review(node(5, 10));
  assert.equal(r.review_count, 1);
  assert.ok(r.last_review_at > 0);
});

console.log('\n初始强度');
t('越重要 → 越强', () => {
  const low = initialStrength({ importance: 0.2, arousal: 0.2, emotion: 0, layer: 1 });
  const high = initialStrength({ importance: 0.9, arousal: 0.8, emotion: 0.5, layer: 1 });
  assert.ok(high > low, `${high} > ${low}`);
});
t('抽象层更持久（L4 远强于 L1）', () => {
  const l1 = initialStrength({ importance: 0.5, arousal: 0.5, emotion: 0, layer: 1 });
  const l4 = initialStrength({ importance: 0.5, arousal: 0.5, emotion: 0, layer: 4 });
  assert.ok(l4 > l1 * 3, `L4 ${l4} 应远大于 L1 ${l1}`);
});
t('强度上限 365 天', () => {
  assert.ok(initialStrength({ importance: 1, arousal: 1, emotion: 1, layer: 4 }) <= 365);
});

console.log('\n时间词解析');
t('今天 → 有区间、跨度不超过一天', () => {
  const r = parseTimeRange('今天做了什么');
  assert.ok(r && r.since && r.until, '应解析出区间: ' + JSON.stringify(r));
  assert.ok(r.until - r.since <= 2 * DAY, '跨度过大: ' + (r.until - r.since) / DAY + ' 天');
  assert.ok(r.until >= Date.now() - 2 * DAY, '区间太旧: ' + JSON.stringify(r));
});
t('3 天前 → 落在过去，且跨度约一天', () => {
  const r = parseTimeRange('3 天前');
  assert.ok(r && r.since && r.until, JSON.stringify(r));
  assert.ok(r.until <= Date.now(), '不该是未来');
  assert.ok(r.until >= Date.now() - 6 * DAY, '太旧了: ' + JSON.stringify(r));
});
t('没有时间词 → null', () => {
  assert.equal(parseTimeRange('随便聊聊'), null);
});

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
