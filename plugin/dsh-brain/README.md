# dsh-brain · DeepSeek Harness 记忆插件

把 MemBrain 接进 DSH：**每轮对话自动注入相关记忆**，并可主动读写。

## 安装

```bash
# 把本目录链进你的 profile（示例：web）
dsh plugin --profile web add link:/path/to/membrain/plugin/dsh-brain
```

然后重启 DSH。

## 它每轮注入什么

```
• 相关记忆（默认约 900 字）
🧰 会 N 项技能
📋 进行中
🎯 我还不懂
📌 欠着
💭 我想跟你说的
🧵 刚才在做
🔁 到期该复习
```

## 依赖

- 主库路径由 `MG_DB` 指定（默认 ./memory.db）
- 会话日志：`DSH_HOME/sessions`（用于增量转录）
- 环境变量见仓库根 `.env.example`
