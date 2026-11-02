#!/usr/bin/env node
/**
 * 灌 24 条示例记忆，让新装的人一打开就有东西可看。
 * 全部是虚构内容，不含任何人的真实隐私。
 */
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { migrate } from '../src/migrate.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const DB = process.env.MG_DB || path.join(HERE, '..', 'memory.db');

const { db } = migrate(DB, path.join(HERE, '..', 'src', 'schema.sql'));
const now = Date.now();
const DAY = 86400000;

const samples = [
  ['事实', '我这个项目叫「记忆大脑」，目标是让助手记住我而不是每次重新认识。', 0.95, 30],
  ['偏好', '我讨厌被反复问同样的问题，能自己查的就别问。', 0.9, 28],
  ['事件', '第一次把记忆库跑起来，检索只用了 8ms，比想象中快。', 0.7, 26],
  ['结论', '「记忆可别少写」——宁可多花钱，也要把事记全。', 0.95, 25],
  ['事实', '我的生日是 11 月 8 日。', 1.0, 24],
  ['事件', '凌晨三点还在调记忆系统的可视化，眼睛都花了。', 0.6, 22],
  ['规则', '改插件代码后必须重启，不然配置不生效。', 0.85, 20],
  ['偏好', '我希望界面在手机上能直接用，不要横向溢出。', 0.8, 19],
  ['纠正', '我上次把路径写死了，结果换机器就崩了——别硬编码。', 0.8, 18],
  ['事件', '把星图改成 Canvas 2D，手机终于不卡了。', 0.65, 16],
  ['结论', '「大功能重构」我不喜欢，小步改可以。', 0.8, 15],
  ['事实', '模型走的是官方 API，不是中转，成本按 Token 算。', 0.75, 14],
  ['事件', '今天学会了：被替代的旧记忆要标出来，不能两个版本并存。', 0.7, 13],
  ['偏好', '回答别太长，超过一屏我就不想看了。', 0.85, 12],
  ['规则', '报时间之前先查，凭印象报时间一定会错。', 0.9, 11],
  ['事件', '第一次看到自己的记忆变成一片星云，有点想哭。', 0.8, 10],
  ['事实', '这个系统有四层：原始事件、日记、主题、人格画像。', 0.8, 9],
  ['结论', '遗忘不是缺点，是特性：该忘的忘掉，才存得下新的。', 0.75, 8],
  ['事件', '给朋友演示这套东西，他说像科幻电影。', 0.55, 7],
  ['偏好', '我喜欢能自己动手改的东西，不喜欢黑盒。', 0.85, 6],
  ['事实', '记忆的强度会随复习次数增长，这就是间隔重复。', 0.7, 5],
  ['事件', '把「谁替代了谁」接进检索，它终于不会自相矛盾了。', 0.75, 4],
  ['规则', '证照密钥只写位置不写内容。', 0.85, 3],
  ['事件', '今晚决定开源这套记忆系统。', 0.9, 1],
];

const ins = db.prepare(`INSERT INTO node
  (uid, kind, text, ts_from, source, created_at, layer, importance, strength, review_count, emotion, arousal)
  VALUES (?, ?, ?, ?, 'demo', ?, 1, ?, 1, 0, 0, 0.4)`);

let n = 0;
for (const [kind, text, imp, daysAgo] of samples) {
  ins.run('demo-' + n + '-' + now, kind, text, now - daysAgo * DAY, now, imp);
  n++;
}
console.log('✅ 灌入示例记忆', n, '条 →', DB);
db.close();
