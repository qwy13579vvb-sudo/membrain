import { recall } from './recall.js';
import { lastUserMessage } from './tail.js';
import { DatabaseSync } from 'node:sqlite';
/**
 * dsh-brain —— 我的长期记忆大脑（插件版）
 *
 * 给「我」三个工具 + 一行上下文：
 *   memory_recall  去记忆库捞相关子图（只把结果带进上下文）
 *   memory_write   当场把这件事写进库
 *   memory_stats   看库里有多少、分层多少
 *
 * 记忆库本体：memory-graph/memory.db（SQLite + FTS5 + 四层 + 艾宾浩斯）
 * 本插件只是"手"，脑子是那个库。
 */
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';

const BRAIN_DIR = process.env.DSH_BRAIN_DIR
  || path.join(os.homedir(), 'Documents', 'deepseek-harness', 'default-workspace', 'memory-graph');

let brain = null;
let loadError = null;
let lastIdf = 0;

async function mod() {
  if (brain) return brain;
  if (loadError) throw loadError;
  try {
    brain = await import(path.join(BRAIN_DIR, 'mg.mjs'));
    return brain;
  } catch (err) {
    loadError = err;
    throw err;
  }
}


// 黑匣子：插件启动与每次注入都落盘一行，方便重启后定位
import fsx from 'node:fs';
function trace(tag, extra = '') {
  try { fsx.appendFileSync('/tmp/brain-boot.log', `${new Date().toISOString()} ${tag} ${extra}\n`); } catch { /* ignore */ }
}

export const name = 'dsh-brain';
export const inject = ['tools', 'systemPrompt'];


// 库规模统计（缓存 30 秒，避免每轮查库）
let statCache = { at: 0, text: '' };
function statLine() {
  const now = Date.now();
  if (now - statCache.at < 30000 && statCache.text) return statCache.text;
  try {
    const f = '/root/Documents/deepseek-harness/default-workspace/memory-graph/memory.db';
    const db = new DatabaseSync(f);
    const total = db.prepare('SELECT COUNT(*) c FROM node').get().c;
    const rows = db.prepare('SELECT layer, COUNT(*) c FROM node GROUP BY layer').all();
    const parts = rows.sort((a, b) => b.layer - a.layer).map((r) => `L${r.layer} ${r.c}`).join(' / ');
    statCache = { at: now, text: `库 ${total} 条（${parts}）` };
    return statCache.text;
  } catch { return statCache.text || '库已连接'; }
}

export function apply(ctx, config = {}) {
  trace('apply-start');
  try { return applyInner(ctx, config); } catch (e) { trace('apply-throw', e && e.message); throw e; }
}

function applyInner(ctx, config = {}) {
  const budget = Number(config.budget ?? 2400);
  const maxNodes = Number(config.maxNodes ?? 30);
  // 默认不挂工具：工具 schema 一有问题就会让整个会话每一轮 INVALID_REQUEST。
  // 要启用请在 profile patch 里写 config: { tools: true }。
  const ENABLE_TOOLS = config.tools === true;

  // ---------- 工具 ----------
  if (ENABLE_TOOLS) try {
    ctx.tools.register({
      name: 'memory_recall',
      description:
        'Query my long-term memory brain (four layers: raw events / daily digests / topics / self-profile, with Ebbinghaus retention and emotion scores). Returns only the relevant subgraph, never the whole store. Use this whenever the user refers to something from the past — names, birthdays, preferences, past mistakes, devices, configs, promises — or when you are unsure whether something was already established. Query with concrete content words, not full sentences. This is not a search engine over the internet; it is my own memory.',
      parameters: {
        query: { type: 'string', required: true, description: 'Concrete content words, space separated, e.g. "生日 名字" or "备份 恢复 格式化".' },
        budget: { type: 'integer', description: 'Max characters to inject. Default 2400.' },
        maxNodes: { type: 'integer', description: 'Max memory lines to inject. Default 30.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: { text: { type: 'string' } },
        },
      render: (_args, value) => [{ type: 'text', text: String(value?.text ?? '') }],
      },
      async execute(args) {
        const m = await mod();
        const db = m.open();
        if (Date.now() - lastIdf > 60_000) { m.refreshIdf(db); lastIdf = Date.now(); }
        const r = m.recall(db, String(args?.query || ''), {
          budget: Math.min(6000, Math.max(400, Number(args?.budget || budget))),
          maxNodes: Math.min(60, Math.max(4, Number(args?.maxNodes || maxNodes))),
        });
        const text = r.lines.length
          ? `【记忆召回 · 注入 ${r.lines.length} 条 / ${r.stats.chars} 字 / ${r.stats.ms}ms】\n${r.lines.join('\n')}`
          : `【记忆召回】没有相关内容（查询：${args?.query}）。可能就是没记过，别编。`;
        return { text, injected: r.stats.injected, chars: r.stats.chars, ms: r.stats.ms };
      },
    });

    ctx.tools.register({
      name: 'memory_write',
      description:
        'Write one durable memory into my long-term brain. Use it the moment a durable fact appears: user preferences and verbatim quotes, birthdays/anniversaries, device facts, config paths/ports/package names, error messages plus their fix, and any correction the user made to me. Do not write transient state, tool logs, or the task instruction itself. One sentence should carry the conclusion AND the key parameters.',
      parameters: {
        text: { type: 'string', required: true, description: 'The memory, one sentence, with concrete parameters.' },
        kind: {
          type: 'string',
          enum: ['fact', 'preference', 'conclusion', 'correction', 'plan', 'event', 'diary', 'quote'],
          description: 'fact=硬事实 preference=偏好 conclusion=结论 correction=纠正 plan=约定 event=经历 diary=日记 quote=用户原话',
        },
        importance: { type: 'number', description: '0..1. 约定/纠正 0.9, 硬事实 0.75, 普通经历 0.45.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: { text: { type: 'string' } },
        },
      render: (_args, value) => [{ type: 'text', text: String(value?.text ?? '') }],
      },
      async execute(args) {
        const m = await mod();
        const db = m.open();
        const kind = args?.kind || 'event';
        const importance = Math.max(0, Math.min(1, Number(args?.importance ?? 0.6)));
        m.queue(db, {
          kind, text: String(args?.text || ''), ts: Date.now(),
          source: 'manual', importance, confidence: 1, userConfirmed: true,
        });
        const r = m.drain(db, { verbose: false });
        return { text: `✅ 已写入：新增 ${r.added} / 去重 ${r.deduped} / 新连线 ${r.linked}（kind=${kind} importance=${importance}）` };
      },
    });

    ctx.tools.register({
      name: 'memory_stats',
      description: 'Show how big my memory brain currently is: total nodes, per-layer counts, cold (forgotten) count, emotion average.',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: { text: { type: 'string' } },
        },
      render: (_args, value) => [{ type: 'text', text: String(value?.text ?? '') }],
      },
      async execute() {
        const m = await mod();
        const db = m.open();
        const q = (sql) => db.prepare(sql).get();
        const total = q(`SELECT COUNT(*) c FROM node`).c;
        const edges = q(`SELECT COUNT(*) c FROM edge`).c;
        const cold = q(`SELECT COUNT(*) c FROM node WHERE cold=1`).c;
        const layers = db.prepare(`SELECT layer, COUNT(*) c FROM node GROUP BY layer ORDER BY layer`).all();
        const emo = q(`SELECT ROUND(AVG(emotion),3) v FROM node WHERE layer=1`).v;
        const kinds = db.prepare(`SELECT kind, COUNT(*) c FROM node GROUP BY kind ORDER BY c DESC LIMIT 6`).all();
        return {
          text: `记忆库：${total} 条 / ${edges} 连线 / 冷库 ${cold} / 平均情绪 ${emo}\n`
            + `层级：${layers.map((x) => `L${x.layer} ${x.c}`).join(' / ')}\n`
            + `类型：${kinds.map((x) => `${x.kind} ${x.c}`).join(' / ')}`,
        };
      },
    });
  } catch (err) {
    console.error('[dsh-brain] 工具注册失败（已跳过，不影响对话）：', err);
  }

  // ---------- 每轮自动回想 ----------
  try {
    ctx.systemPrompt.context({
      name: 'brain',
      order: 10200,
      text: () => {
        trace('text-call');
        try {
          return buildRecallText();
        } catch (e) {
          trace('text-throw', e && e.message);
          return '';
        }
      },
    });
    trace('context-registered');
  } catch (err) {
    trace('context-register-fail', err && err.message);
    console.error('[dsh-brain] 上下文注入失败：', err);
  }
}

function buildRecallText() {
  const q = lastUserMessage();
  const r = recall(q, { budget: 900, maxItems: 8 });
  const stat = statLine();
  if (!r.hits) {
    return `【记忆大脑】${stat}\n这次没想起直接相关的（${r.ms}ms）。`
      + `需要时用命令行查：node mg.mjs search "词 词"`;
  }
  return `【记忆大脑·自动回想】${stat}\n`
    + `你刚说的话让我想起 ${r.hits} 条（${r.chars} 字 / ${r.ms}ms）：\n${r.block}\n`
    + `（不够再查：node mg.mjs search "词 词"）`;
}
