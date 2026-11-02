/** 情绪识别：效价 valence(-1..1) + 唤醒度 arousal(0..1)，纯规则、无网络 */

const POS = [
  [3, /开心|高兴|喜欢|爱你|想你|谢谢|太好了|漂亮|可爱|舒服|满足|哈哈|嘿嘿|嘻嘻|好耶|赞|棒|顺利|成功|搞定|修好|成了|厉害|心疼|感动|暖/],
  [2, /不错|还行|可以|好的|行吧|嗯嗯|收到|知道了|明白|对的|确实/],
  [1, /好|嗯|对|行|成/],
];
const NEG = [
  [3, /烦|崩|炸|气死|难受|难过|痛|哭|绝望|完了|废了|恶心|辣鸡|傻逼|操|草|干|滚|垃圾|狗屎|恨|讨厌死|受不了|累死/],
  [2, /不行|失败|出错|报错|挂了|断了|丢了|没了|失败|超时|卡住|失败|麻烦|头疼|郁闷|麻了|无语|裂开/],
  [1, /不行|不好|算了|算了|唉|哎|啧|呃|emm|额/],
];
const HIGH_AROUSAL = /[!！？?]{2,}|[啊呀哦诶哇]{2,}|哈{3,}|呜{2,}|呜呜|急了|冲|赶紧|快|马上|立刻|真的|居然|竟然|气/;
const LOW_AROUSAL  = /累|困|想睡|躺|慢慢|随便|都行|无所谓|算了|没什么|还好|安静|安静地/;

export function scoreEmotion(text) {
  const t = String(text || '');
  let v = 0;
  for (const [w, re] of POS) if (re.test(t)) { v += w; break; }
  for (const [w, re] of NEG) if (re.test(t)) { v -= w; break; }
  // 感叹号/问号堆积加剧
  const bangs = (t.match(/[!！]/g) || []).length;
  const qs = (t.match(/[?？]/g) || []).length;
  if (bangs >= 2) v += 0.5 * Math.sign(v || 1);
  if (qs >= 3) v -= 0.3;
  v = Math.max(-1, Math.min(1, v / 3));

  let a = 0.3;
  if (HIGH_AROUSAL.test(t)) a += 0.35;
  if (LOW_AROUSAL.test(t)) a -= 0.18;
  if (bangs >= 2) a += 0.15;
  if (t.length > 80) a += 0.08;
  a = Math.max(0.05, Math.min(1, a));

  let label = '平静';
  if (v >= 0.5) label = '很开心';
  else if (v >= 0.2) label = '愉快';
  else if (v <= -0.6) label = '很糟';
  else if (v <= -0.25) label = '低落';
  if (a >= 0.7) label = v >= 0 ? '激动' : '焦躁';

  return { valence: +v.toFixed(3), arousal: +a.toFixed(3), label };
}

export function emotionColor(v) {
  // 冷蓝(负) → 灰(中) → 暖粉/橙(正)
  if (v <= -0.05) return `hsl(${210 + v * 20}, ${60 + Math.abs(v) * 20}%, ${58}%)`;
  if (v >= 0.05) return `hsl(${10 + (1 - v) * 25}, ${70 + v * 20}%, ${62}%)`;
  return 'hsl(220, 12%, 62%)';
}
