# 🧠 MemBrain · 会遗忘的 AI 长期记忆

### 三条命令，给你自己的 AI 装一个大脑

```bash
git clone https://github.com/qwy13579vvb-sudo/membrain.git
cd membrain
node scripts/init.mjs        # 建库 + 灌示例 + 建索引，一条命令搞定
```

```bash
node src/mg.mjs search "记忆"        # 立刻能搜
node tools/build-star-map.mjs       # 生成星图，双击就能看
```

**要求：Node.js ≥ 22.5，不需要 npm install，不需要任何 API Key，不需要数据库服务。**
（接 LLM 做归纳才需要；不接也能跑全部核心功能）


> **想开 CI？** 把 `docs/ci-example.yml` 复制到 `.github/workflows/ci.yml` 就会自动跑
> （建库 → 检索 → 14 条单元测试 → 星图 → 全脚本语法，Node 22 / 24 双版本）。
> 手动验证也行：`node scripts/test-core.mjs` 应输出 `14 通过 / 0 失败`。

---

**给 AI Agent 的一套长期记忆系统**：四层结构 + 艾宾浩斯遗忘 + 间隔重复 + 记忆巩固 + 替代链 + 证据标注。
零依赖，只用 Node 内置的 `node:sqlite`；离线可跑；912 条记忆检索 7–30ms。

---

## 为什么不是「把聊天记录存下来」

| 普通做法 | MemBrain |
|---|---|
| 全量塞进上下文 | 先副库定位，只注入 ~900 字 |
| 永不遗忘，越堆越乱 | 按留存率衰减，该沉的沉进冷库 |
| 重要的事也会淡忘 | 复习够多次 → 钉住，永不衰减 |
| 新旧版本互相矛盾 | 替代链：旧的标「已被替代」，检索时不再出现 |
| 分不清谁说的 | 证据标注：你说的 0.92 / 我转述 0.68 / 归纳 0.45 |

---

## 30 秒上手

```bash
git clone <this-repo> membrain && cd membrain
node scripts/init.mjs          # 建库 + 灌 24 条示例 + 建副库
node src/mg.mjs search "记忆"   # 检索
node tools/build-star-map.mjs  # 生成可离线打开的星图 star-map.html
```

要求：**Node.js ≥ 22.5**（`node:sqlite` 内置）。无 npm 依赖。

---

## 它怎么工作

### 1. 记忆强度与遗忘

```
留存率   R = e^(−Δt/S)          半衰期 t½ = S·ln2
初始强度 S0 = (3 + 17×(0.5×重要度 + 0.3×唤醒度 + 0.2×|情绪|)) × 层级倍率{1, 1.6, 2.6, 6}
```

### 2. 复习会强化（间隔重复 / 测试效应）

```
S' = S × (1 + k(1−R)) × 1.6      k: 被检索 1.0 / 被写入 1.4 / 被纠正 1.8
下次到期 = 上次复习 + S·ln2·0.9    上限 365 天
```

### 3. 巩固与冷库

```
复习≥4 且 S≥8 且 重要度≥0.6  → pinned（永不衰减）
R < 0.12                     → 冷库（不删，只是不再主动提）
```

### 4. 睡眠重放

后台每 10 分钟，把到期且重要度 ≥0.45 的记忆过一遍，强度增幅压到 k=0.35
（远弱于真实回忆），模拟海马体回放。

### 5. 检索流水线

```
多路召回（实词/标签/时间词/情绪）
  → 图扩展 1–2 跳
  → 情绪加权
  → 预算控制（默认 900 字）
  → 证据过滤（被替代的不取，低可信标「·存疑」）
```

### 6. 归纳与自我修正

```
distill   从对话提炼 规则/偏好/承诺
learn     只产出「假设」，不当事实
curate    编辑式清理（护栏：规则永不自动删，单批≤20%）
dedupe    余弦 ≥0.86 判重
supersede 替代链：同话题 / 同类型≥0.90 / 跨类型≥0.97
label     证据标注：origin + confidence
audit     查矛盾、查过期承诺
```

### 7. 自主性

```
💭 我想跟你说的  提议队列（7 天去重）      🎯 我还不懂  缺口
📌 欠着          未完成承诺                📋 进行中    计划进度
🔁 到期该复习    今天该回看的              🧵 刚才在做  最近两条 L1
```

---

## 目录

```
src/            引擎（35 个 .mjs，全部可单独跑）
  config.mjs      路径与 LLM 配置（全部可用环境变量覆盖）
  migrate*.mjs    建库 / 补字段
  ebbinghaus.mjs  遗忘曲线      spacing.mjs  间隔重复
  layers.mjs      L1→L4 归纳    index.mjs    副库与检索
  mg.mjs          CLI：search / remember / stats / ingest
  scheduler.mjs   后台调度（转录/归纳/复习/巡检/提议）
  viz.mjs         记忆星图服务
plugin/dsh-brain/ 接入 DeepSeek Harness 的插件（每轮自动回想）
tools/            build-star-map.mjs（导出单文件星图）
demo/             seed.mjs（24 条虚构示例）
docs/             ARCHITECTURE.md（设计取舍与踩坑）
```

---

## 接入自己的 Agent

**方式一：命令行**

```bash
node src/mg.mjs remember fact 0.9 "用户生日是 11 月 8 日"
node src/mg.mjs search "生日"
```

**方式二：当库用（推荐）**

```js
import { recall } from './src/index.mjs';
const { block, chars, hits } = recall('上次说的那个方案', { budget: 900 });
// block 直接拼进你的 system prompt
```

**方式三：DeepSeek Harness 插件**

把 `plugin/dsh-brain` 链进你的 profile，每轮自动注入 `💭 / 🎯 / 📌 / 🔁` 等小节。

---

## 配置（全部可选）

| 环境变量 | 默认 | 作用 |
|---|---|---|
| `MG_DB` | `./memory.db` | 主库路径 |
| `DSH_HOME` | `~/.dsh` | 若接 DSH：会话/技能/凭证目录 |
| `MEMBRAIN_LLM_BASE` | `https://api.deepseek.com/v1` | 归纳用的 LLM |
| `MEMBRAIN_LLM_KEY_ENV` | `DEEPSEEK_API_KEY` | 从哪个环境变量取 key |
| `MEMBRAIN_LLM_MODEL` | `deepseek-chat` | 模型 |

**不配 LLM 也能用** —— 转录、检索、复习、衰减、星图全部本地完成；
只有「归纳规则 / 补缺口 / 生成假设」需要 LLM。

---

## 已知短板

```
· 话题聚合（L3）还偏粗，主题数量少
· 冷库阈值保守，很多该沉的没沉
· 假设（hypothesis）还没有自动验证闭环
· 只记文字，视频/语音未进记忆
· 单机单库，没有跨设备同步
```

---

## License

MIT

---

## English (short)

**MemBrain** is a four-layer, forgetting-aware long-term memory for AI agents:
SQLite + FTS5, zero dependencies, offline. It forgets on an Ebbinghaus curve,
strengthens on recall (spaced repetition), consolidates in background
(sleep replay), supersedes outdated facts, and labels every memory with
its origin and confidence.

```bash
node scripts/init.mjs && node src/mg.mjs search "hello"
```

MIT. PRs welcome.
