#!/usr/bin/env node
/** 一键初始化：建库 → 补字段 → 灌示例 → 建副库 */
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.join(HERE, '..');
const db = process.env.MG_DB || path.join(ROOT, 'memory.db');
process.env.MG_DB = db;

const run = (args) => execFileSync(process.execPath, args, { cwd: ROOT, stdio: 'inherit', env: process.env });

console.log('1/4 建库…');
run(['-e', `import('${path.join(ROOT,'src','migrate.mjs')}').then(m=>{const {db}=m.migrate(${JSON.stringify(db)}, ${JSON.stringify(path.join(ROOT,'src','schema.sql'))});db.close();})`]);
console.log('2/4 补字段…');
run([path.join(ROOT,'src','migrate2.mjs')]);
run([path.join(ROOT,'src','migrate3.mjs')]);
console.log('3/4 示例数据（已有数据会跳过）…');
try { run([path.join(ROOT,'demo','seed.mjs')]); } catch (e) { console.log('  跳过：', e.message.split('\n')[0]); }
console.log('4/4 建副库…');
run([path.join(ROOT,'src','index.mjs'), 'build']);
console.log('\n✅ 完成。试试： node src/mg.mjs search "记忆"');
