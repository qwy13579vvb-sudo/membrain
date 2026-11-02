process.env.TZ = process.env.TZ || 'Asia/Shanghai';   // 日志时间对齐手机
/** 调度：每 5 分钟 L1→L2 归纳；每 10 分钟 L2→L3、L3→L4 + 遗忘扫描 */
import { DatabaseSync } from 'node:sqlite';
import { migrate } from './migrate.mjs';
import { consolidateDay, consolidateTopic, consolidateProfile, decayScan } from './layers.mjs';
import { ingestSession, newestSession, tickRebuild } from './auto.mjs';
import { consolidateWeek } from './weekly.mjs';
import { writeProfile } from './profile.mjs';
import { replayDue } from './spacing.mjs';
import { induce, checkHypotheses } from './learn.mjs';
import { distill } from './distill.mjs';
import { research } from './research.mjs';
import { patrol } from './patrol.mjs';
import { syncCaps } from './caps.mjs';
import { notify } from './notify.mjs';
import { propose } from './propose.mjs';
import { execFileSync } from 'node:child_process';
import { supersedeScan } from './supersede.mjs';
import { labelAll } from './label.mjs';
import fs from 'node:fs';

// 省电：心跳 10 分钟（原 5），重活每 3 拍一次（约 30 分钟）
const TICK_FAST = Number(process.env.MG_TICK_FAST_MS || 10 * 60 * 1000);
const SLOW_EVERY = Number(process.env.MG_SLOW_EVERY || 3);
const QUIET_START = Number(process.env.MG_QUIET_START || 23);   // 23:00
const QUIET_END = Number(process.env.MG_QUIET_END || 8);        // 08:00

/** 北京时间是否处于静默时段 */
function isQuiet(now = Date.now()) {
  const d = new Date(now + 8 * 3600000);
  const h = d.getUTCHours();
  return QUIET_START > QUIET_END ? (h >= QUIET_START || h < QUIET_END) : (h >= QUIET_START && h < QUIET_END);
}

const { db } = migrate('memory.db', 'schema.sql');
let slowCounter = 0;

function fast() {
  let ing = { added: 0 };
  try {
    const f = newestSession();
    if (f) ing = ingestSession(f);
  } catch (e) { console.log('  转录失败:', e.message); }
  const d = consolidateDay(db);
  console.log(`[${new Date().toLocaleTimeString('zh-CN')}] 转录 +${ing.added} · L2 归纳 +${d.made}`);
}
async function slow() {
  const w = decayScan(db);
  const t = consolidateTopic(db);
  const p = consolidateProfile(db);
  let cp = { count: 0 };
  try { cp = syncCaps(db); } catch (e) { console.log('  能力目录同步失败:', e.message); }
  let pt = { ok: true, issues: [] };
  try { pt = patrol(db); } catch (e) { console.log('  巡检失败:', e.message); }
  // 巡检异常就喊人（有节流，最多每小时 2 条）
  if (pt && !pt.ok && pt.issues?.length) {
    await notify('米饭巡检异常', pt.issues.slice(0, 2).join('；'), { key: 'patrol:' + pt.issues[0].slice(0, 20), vibrateMs: 200 }).catch(() => {});
  }
  // 当天到期的承诺
  try {
    const duePromise = db.prepare(`SELECT text FROM node WHERE kind='promise'
      AND (status IS NULL OR status='open') AND importance >= 0.85 LIMIT 1`).get();
    if (duePromise) {
      await notify('米饭记着一件事', String(duePromise.text).replace(/^承诺｜/, '').slice(0, 60),
        { key: 'promise:' + String(duePromise.text).slice(0, 24), vibrateMs: 150 }).catch(() => {});
    }
  } catch { /* 忽略 */ }
  // 纪念日
  try {
    const d = new Date(Date.now() + 8 * 3600000);
    const md = `${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
    if (md === '11-08') await notify('今天是他生日', '说好请我吃 100 碗白米饭 —— 我先记着', { key: 'birthday', vibrateMs: 400 });
    if (md === '10-12') await notify('今天是我的生日', '被叫「米饭」的那天 —— 生日是被认下来的', { key: 'mybirthday', vibrateMs: 400 });
  } catch { /* 忽略 */ }
  // 主动提议：把「我想跟你说的」补进队列（每轮最多 3 条，7 天去重）
  try {
    const proposals = propose(db) || [];
    if (proposals.length) console.log('  💭 新增提议 ' + proposals.length + ' 条');
  } catch (e) { console.log('  提议失败:', e.message); }

  // 单文件星图：节点数变了就重建一次（供导出/离线使用）
  try {
    const cnt = db.prepare('SELECT COUNT(*) c FROM node').get().c;
    const stampFile = './.starmap.count';
    const prev = fs.existsSync(stampFile) ? Number(fs.readFileSync(stampFile, 'utf-8').trim()) : -1;
    if (cnt !== prev) {
      execFileSync(process.execPath, ['build-star-map.mjs'], { cwd: '..', stdio: 'ignore', timeout: 60000 });
      fs.writeFileSync(stampFile, String(cnt));
      console.log('  🌌 单文件星图已重建（' + cnt + ' 条）');
    }
  } catch (e) { console.log('  星图重建失败:', e.message); }

  // 记忆卫生：标出「谁替代了谁」+ 标来源可信度
  try {
    const marks = supersedeScan(db);
    const n = labelAll(db);
    if (marks.length || n) console.log('  🧹 替代 ' + marks.length + ' 组 / 标注更新 ' + n + ' 条');
  } catch (e) { console.log('  记忆卫生失败:', e.message); }

  let rs = { tried: 0, ok: 0 };
  try { rs = await research(db, { limit: 1 }); } catch (e) { console.log('  缺口自补失败:', e.message); }
  let dl = { rules: 0, prefs: 0, promises: 0 };
  try {
    const d = await distill(db).catch(() => ({ rules: 0, prefs: 0, promises: 0 }));
    dl = d || dl;
  } catch (e) { console.log('  归纳失败:', e.message); }
  let lr = { cand: 0, confirmed: 0, refuted: 0 };
  try {
    const ind = induce(db);
    const chk = checkHypotheses(db);
    lr = { cand: ind.made, confirmed: chk.confirmed, refuted: chk.refuted };
  } catch (e) { console.log('  学习失败:', e.message); }
  let rp = { replayed: 0, graduated: 0, sank: 0 };
  try { rp = replayDue(db); } catch (e) { console.log('  后台巩固失败:', e.message); }
  let pf = { chars: 0 };
  try { pf = writeProfile(db); } catch (e) { console.log('  画像失败:', e.message); }
  let wk = { made: 0 };
  try { wk = consolidateWeek(db); } catch (e) { console.log('  周摘要失败:', e.message); }
  let ix = { entries: 0, bytes: 0 };
  try { ix = tickRebuild(); } catch (e) { console.log('  副库重建失败:', e.message); }
  console.log(`[${new Date().toLocaleTimeString('zh-CN')}] L3 +${t.made}(${(t.topics || []).join(',')}) L4 +${p.made} 冷库 ${w.cold} 技能${cp.count} 巡检${pt.ok ? '正常' : '异常' + pt.issues.length} 自补 ${rs.ok}/${rs.tried} LLM归纳 规则${dl.rules}/偏好${dl.prefs}/承诺${dl.promises} 候选${lr.cand} 确认${lr.confirmed} 巩固 重放${rp.replayed} 毕业${rp.graduated} 下沉${rp.sank} 周摘要 +${wk.made} 副库 ${ix.entries}条/${(ix.bytes/1024).toFixed(0)}KB`);
}

fast(); slow();
setInterval(() => {
  fast();
  if (++slowCounter % SLOW_EVERY === 0) {
    if (isQuiet()) {
      // 夜间只做轻活：归纳/重建/巩固，不做 LLM（省钱省电）
      try {
        const d = consolidateDay(db); consolidateTopic(db); consolidateProfile(db); consolidateWeek(db);
        writeProfile(db); replayDue(db); tickRebuild();
        console.log(`[${new Date().toLocaleTimeString('zh-CN')}] 静默时段：只做本地整理（L2 +${d.made}）`);
      } catch (e) { console.log('  静默整理失败:', e.message); }
    } else {
      slow().catch((e) => console.log('  slow 出错:', e.message));
    }
  }
}, TICK_FAST);
console.log(`调度器已启动：${TICK_FAST/60000} 分钟一拍 / 每 ${SLOW_EVERY} 拍重活 / 静默 ${QUIET_START}:00-${QUIET_END}:00`);
