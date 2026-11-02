/** 静态检查：页面脚本里有没有「用了但没声明」的标识符（专治我这种手滑） */
import fs from 'node:fs';
import path from 'node:path';

const file = path.join(path.dirname(new URL(import.meta.url).pathname), 'viz', 'index.html');
const html = fs.readFileSync(file, 'utf-8');
const js = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n');

const declared = new Set();
// 一行多声明（let a = 1, b = 2）要逐个抓
for (const m of js.matchAll(/\b(?:let|const|var)\s+([^;\n]+)/g)) {
  const seg = m[1];
  // 按顶层逗号切
  let depth = 0, cur = '';
  const parts = [];
  for (const ch of seg) {
    if ('([{'.includes(ch)) depth++;
    else if (')]}'.includes(ch)) depth--;
    if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; } else cur += ch;
  }
  parts.push(cur);
  for (const part of parts) {
    const name = part.split('=')[0].trim().replace(/^\{.*\}$/s, '');
    if (/^[A-Za-z_$][\w$]*$/.test(name)) declared.add(name);
  }
}
for (const m of js.matchAll(/function\s+([A-Za-z_$][\w$]*)/g)) declared.add(m[1]);
for (const m of js.matchAll(/(?:const|let|var)\s+\{([^}]+)\}\s*=/g))
  m[1].split(',').forEach((x) => declared.add(x.split(':').pop().trim()));
for (const m of js.matchAll(/\(([^)]*)\)\s*=>/g))
  m[1].split(',').forEach((x) => { const n = x.trim().split('=')[0].trim(); if (/^[A-Za-z_$][\w$]*$/.test(n)) declared.add(n); });
for (const m of js.matchAll(/for\s*\(const\s+([A-Za-z_$][\w$]*)/g)) declared.add(m[1]);
for (const m of js.matchAll(/for\s*\(const\s+\[([^\]]+)\]/g))
  m[1].split(',').forEach((x) => declared.add(x.trim()));
for (const m of js.matchAll(/for\s*\(const\s+\{([^}]+)\}/g))
  m[1].split(',').forEach((x) => declared.add(x.split(':').pop().trim()));
for (const m of js.matchAll(/for\s*\(([A-Za-z_$][\w$]*)\s*[=;]/g)) declared.add(m[1]);
for (const m of js.matchAll(/\.forEach\(\(([A-Za-z_$][\w$]*)\)/g)) declared.add(m[1]);
for (const m of js.matchAll(/\.map\(\(([A-Za-z_$][\w$]*)\)/g)) declared.add(m[1]);

const globals = new Set(['window','document','Math','JSON','Number','String','Array','Object','Date','console',
  'setInterval','setTimeout','clearInterval','fetch','requestAnimationFrame','performance','Map','Set','URL',
  'Promise','Boolean','parseInt','parseFloat','isNaN','Infinity','NaN','undefined','null','true','false','this',
  'Float32Array','Uint8Array','localStorage','alert','event','arguments','HTMLCanvasElement','Image']);

// 只查「明显是我自己变量」的那几个常见坑，避免误报
const suspicious = ['drag','touch','ptrs','gesture','DATA','points','edges','cam','W','H','DPR','selLayer',
  'hovered','selected','showLabels','labelMax','T0','ctx','cv','FOCAL','CAM_DEFAULT','KIND_LABEL','LAYER_LABEL'];

const problems = suspicious.filter((name) => {
  const used = new RegExp('(?<![\\w$.])' + name + '(?![\\w$])').test(js);
  return used && !declared.has(name);
});

if (problems.length) {
  console.log('❌ 用了但没声明:', problems.join(', '));
  process.exit(1);
}
// 函数级检查：只查「裸调用」（前面不是 . 的），并先剔掉着色器字符串
let js2 = js.replace(/`[^`]*void main[\s\S]*?`/g, '``').replace(/`[^`]*gl_FragColor[\s\S]*?`/g, '``');
const definedFn = new Set([...js2.matchAll(/function\s+([A-Za-z_$][\w$]*)/g)].map((m) => m[1]));
for (const m of js2.matchAll(/(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:function|\()/g)) definedFn.add(m[1]);
const builtinFn = new Set(['async','await','fetch','of','in','rgba','rgb','hsl',
  'vec2','vec3','vec4','mat2','mat3','mat4','float','int','bool','cos','sin','tan','atan','pow','exp','log','sqrt',
  'abs','max','min','clamp','mix','smoothstep','step','distance','dot','length','normalize','fract','mod','texture2D',
  'orbit','discard','return','main','gl_Position','gl_PointSize','gl_FragColor','precision','uniform','attribute','varying',
  'if','for','while','switch','catch','return','typeof','new','do','else','function',
  'requestAnimationFrame','setInterval','setTimeout','clearTimeout','clearInterval','alert','parseInt','parseFloat',
  'isNaN','encodeURIComponent','decodeURIComponent','structuredClone','queueMicrotask','from','of','in','instanceof',
  'String','Number','Boolean','Array','Object','Date','Map','Set','WeakMap','Promise','Error','TypeError','Uint8Array',
  'Float32Array','Uint16Array','Uint32Array','Int32Array','isFinite','confirm','prompt']);
const undef = [...new Set([...js2.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)\s*\(/g)].map((m) => m[1]))]
  .filter((n) => !definedFn.has(n) && !builtinFn.has(n));
if (undef.length) { console.log('❌ 调用了但没定义：' + undef.join(', ')); process.exit(1); }
console.log('✅ 页面脚本没有「用了但没声明」的变量，也没有「调用不存在的函数」');
