/** 艾宾浩斯遗忘曲线：R = e^(-Δt / S)，召回即复习 */
const MIN = 60 * 1000;
const DAY = 24 * 60 * MIN;

/** 初始强度 S0（单位：天）：由情绪唤醒度与重要度决定 */
export function initialStrength({ importance = 0.5, arousal = 0, emotion = 0, layer = 1 } = {}) {
  // S 的单位是「天」；半衰期 t½ = S·ln2。layer 越高越稳。
  const base = 3 + 17 * (0.5 * importance + 0.3 * Math.min(1, arousal) + 0.2 * Math.abs(emotion));
  const layerBoost = { 1: 1, 2: 1.6, 3: 2.6, 4: 6 }[layer] ?? 1;
  return +(Math.min(365, base * layerBoost)).toFixed(3);
}

/** 当前保留率 0..1 */
export function retention(node, now = Date.now()) {
  const last = node.last_review_at || node.ts_from || now;
  const dtDays = Math.max(0, (now - last) / DAY);
  const S = Math.max(0.2, node.strength || 1);
  return Math.exp(-dtDays / S);
}

/** 复习一次：S 按间隔效应增长（越早复习增益越小，跨过遗忘点复习增益大） */
export function review(node, now = Date.now()) {
  const r = retention(node, now);
  const gain = 1 + (1 - r) * 1.4;   // 忘得越多、复习收益越大
  const S = Math.min(120, (node.strength || 1) * gain);
  return { strength: +S.toFixed(3), last_review_at: now, review_count: (node.review_count || 0) + 1 };
}

/** 冷库阈值：保留率掉到 0.12 以下就下沉（不删除） */
export const COLD_THRESHOLD = 0.12;
