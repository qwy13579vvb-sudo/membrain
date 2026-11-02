/**
 * plan.mjs —— 任务拆解与跟踪
 * 复杂目标 → 拆成子步骤（DAG 的线性版）→ 落库跟踪 → 逐条推进 → 完成归档。
 * kind='plan' 是目标，kind='step' 是步骤，用 source_ref 关联。
 */
import { DatabaseSync } from 'node:sqlite';
const now = () => Date.now();

export function createPlan(db, goal, steps = []) {
  const uid = `plan-${now()}-${Math.random().toString(36).slice(2, 6)}`;
  db.prepare(`INSERT INTO node (uid, kind, text, ts_from, ts_to, source, speaker, importance,
      confidence, user_confirmed, layer, emotion, arousal, strength, status, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(uid, 'plan', `目标｜${goal}`, now(), now(), 'plan', 'self', 0.85, 0.8, 1, 2, 0, 0.3, 20, 'open', now());
  steps.forEach((s, i) => {
    db.prepare(`INSERT INTO node (uid, kind, text, ts_from, ts_to, source, source_ref, speaker, importance,
        confidence, user_confirmed, layer, emotion, arousal, strength, status, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(`step-${now()}-${i}-${Math.random().toString(36).slice(2, 5)}`, 'step',
        `第${i + 1}步｜${s}`, now(), now(), 'plan', uid, 'self', 0.7, 0.8, 1, 2, 0, 0.25, 10,
        i === 0 ? 'doing' : 'pending', now());
  });
  return { uid, goal, steps: steps.length };
}

export function setStep(db, stepId, status) {
  db.prepare(`UPDATE node SET status=?, ts_to=? WHERE id=? AND kind='step'`).run(status, now(), stepId);
  // 全部完成 → 目标归档
  const row = db.prepare(`SELECT source_ref FROM node WHERE id=?`).get(stepId);
  if (row) {
    const left = db.prepare(`SELECT COUNT(*) c FROM node WHERE kind='step' AND source_ref=? AND status!='done'`).get(row.source_ref).c;
    if (left === 0) db.prepare(`UPDATE node SET status='done' WHERE uid=?`).run(row.source_ref);
  }
  return { stepId, status };
}

export function listPlans(db) {
  return db.prepare(`SELECT uid, text, status FROM node WHERE kind='plan' AND status='open' ORDER BY id DESC`).all()
    .map((p) => {
      const steps = db.prepare(`SELECT id, text, status FROM node WHERE kind='step' AND source_ref=? ORDER BY id`).all(p.uid);
      const done = steps.filter((s) => s.status === 'done').length;
      const cur = steps.find((s) => s.status === 'doing')
        || steps.find((s) => s.status === 'pending')
        || steps.find((s) => s.status === 'blocked');
      const blocked = steps.some((s) => s.status === 'blocked');
      const label = cur ? `${cur.text}${cur.status === 'blocked' ? '（阻塞）' : ''}` : '(全部完成)';
      return { uid: p.uid, goal: p.text.replace(/^目标｜/, ''), total: steps.length, done, blocked, current: label };
    });
}

export function planLine(db) {
  const ps = listPlans(db);
  if (!ps.length) return '';
  return '📋 进行中：' + ps.slice(0, 2).map((p) => `${p.goal.slice(0, 24)}（${p.done}/${p.total}，当前：${p.current.replace(/^第\d+步｜/, '').slice(0, 20)}）`).join('；');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const db = new DatabaseSync(new URL('./memory.db', import.meta.url).pathname);
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === 'new') {
    const [goal, stepsArg] = rest;
    const steps = (stepsArg || '').split('|').filter(Boolean);
    const r = createPlan(db, goal, steps);
    console.log('已建目标：', r.goal, `（${r.steps} 步）`);
  } else if (cmd === 'list') {
    for (const p of listPlans(db)) console.log(`· ${p.goal} — ${p.done}/${p.total}，当前：${p.current}`);
    if (!listPlans(db).length) console.log('（空闲）');
  } else if (cmd === 'done') {
    const id = Number(rest[0]);
    console.log(setStep(db, id, 'done'));
  } else {
    console.log(planLine(db) || '（空闲）');
  }
}
