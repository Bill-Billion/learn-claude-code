# Session 更新计划

## 原则

- 每章开独立 Explore Agent 深入读 CC 源码，拿到具体的字段名、行号、常量值、算法逻辑
- 源码分析写入 `<details>` 折叠，不污染教学主线
- 深入但不堆砌——只保留对理解核心概念有帮助的差异点
- 简单章（概念足够直观）分析可以轻量，复杂章（机制密集）必须全量

## 更新完成标准

每章更新后应满足：
- [ ] README 主线无 CC 内部工程术语（tengu_*、GrowthBook 等）
- [ ] `<details>` 折叠中有基于源码行号的逐项对照
- [ ] 关键差异点有"教学版为什么简化"的说明
- [ ] 复杂章有 SVG 图，简单章 code 够用
- [ ] code.py 可独立运行

---

## Batch 1: 已有深度的章（微调）

### s01 Agent Loop ✅ 已完成
- query.ts 1729 行全量分析
- State 11 字段 + 10 退出路径 + 7 继续路径
- 改动：无需

### s02 Tool Use ✅ 已完成
- Tool.ts + toolOrchestration.ts + StreamingToolExecutor.ts 分析
- isConcurrencySafe vs isReadOnly 修正
- 并发对比 SVG
- 改动：无需

### s08 Context Compact ✅ 已完成
- compact.ts 1705 行 + autoCompact.ts 351 行全量分析
- 5 层修正为 4 层管线 + 应急
- 14 个精确常量
- 改动：无需

---

## Batch 2: 亟待深化的复杂章（深度分析 + 重写 CC 对照）

### s03 Permission System

**CC 源码位置**:
- `src/Tool.ts` — checkPermissions(), PermissionResult 类型
- `src/services/tools/toolExecution.ts` — checkPermissionsAndCallTool() 完整管线
- `src/tools.ts` — canUseTool callback, permissionContext
- `src/query.ts` — permission 在循环中的调用点
- YoloClassifier / auto-approve 逻辑

**分析重点**:
1. PermissionResult 的完整类型定义（allow/deny/ask 三种决策）
2. checkPermissions 的调用时机和参数
3. canUseTool callback 的签名和作用
4. 权限决策管线的精确顺序（schema → validateInput → hooks → permission → call）
5. YoloClassifier 如何自动批准
6. permission bubbling 机制

**更新内容**:
- [ ] 重写 `<details>` 折叠：完整 PermissionResult 类型 + 管线顺序 + 行号
- [ ] 补充 permission bubbling 概念
- [ ] 术语小抄补上

---

### s04 Hooks System

**CC 源码位置**:
- `src/services/tools/toolHooks.ts` (650 行) — PreToolUse/PostToolUse 钩子执行
- `src/query.ts` — stop hooks, hook_stopped_continuation
- `src/hooks/` 目录 — 各类 React hooks（与教学无关），但 stop hooks 相关的逻辑在 query.ts
- `src/services/compact/postCompactCleanup.ts` — 压缩后钩子清理

**分析重点**:
1. PreToolUse hooks 的完整执行流程和返回值类型
2. PostToolUse hooks 的触发时机
3. Hook 返回值如何影响工具执行（preventContinuation, updatedInput, permissionDecision）
4. Stop hooks 的触发时机和处理逻辑
5. 钩子注册和优先级机制

**更新内容**:
- [ ] 重写 `<details>` 折叠：PreToolUse/PostToolUse/Stop hooks 的完整类型 + 触发时机 + 行号
- [ ] 教学版的 register_hook/trigger_hooks 与 CC 的差异对比

---

### s09 Memory System

**CC 源码位置**:
- `src/services/extractMemories/extractMemories.ts` (615 行) — 记忆提取
- `src/services/extractMemories/prompts.ts` — 提取 prompt
- `src/services/SessionMemory/sessionMemory.ts` (495 行) — 会话记忆
- `src/services/SessionMemory/prompts.ts` — 记忆 prompt
- `src/services/autoDream/consolidationLock.ts` — 巩固锁
- `src/query.ts` — 记忆加载和提取的调用点

**分析重点**:
1. MemorySelector 的筛选算法（embedding 相似度 vs 关键词）
2. ExtractMemories 的触发时机（stop hook 中，不是 autoCompact 后）
3. DreamConsolidator 的触发频率和逻辑
4. 记忆的 JSON 结构（type、tags、timestamp、expires_at）
5. session memory vs user memory 的区分
6. 记忆文件存储位置和格式

**更新内容**:
- [ ] 重写 `<details>` 折叠：三子系统的具体触发时机 + 数据结构 + 行号
- [ ] 补充 session memory compact（s08 中回撤的那个机制）
- [ ] 术语小抄补上

---

### s11 Error Recovery

**CC 源码位置**:
- `src/query.ts` — 全部恢复逻辑：
  - max_tokens escalation (8K→64K)
  - max_output_tokens recovery (续写提示，最多 3 次)
  - collapse_drain_retry
  - reactive_compact_retry
  - stop_hook_blocking
  - token_budget_continuation
  - fallback model 切换
  - 指数退避

**分析重点**:
1. 7 种 Continue 路径的精确触发条件和行号（部分已在 s01 中覆盖）
2. 指数退避的具体参数（BASE_DELAY_MS, MAX_RETRIES, jitter）
3. fallback model 的切换逻辑
4. max_tokens escalation 的单次限制
5. reactiveCompact vs autoCompact 的触发差异

**更新内容**:
- [ ] 重写 `<details>` 折叠：四条恢复路径的精确条件 + 常量 + 行号
- [ ] 添加错误恢复决策树 SVG
- [ ] 术语小抄补上

---

### s15 Agent Teams

**CC 源码位置**:
- `src/hooks/useSwarmInitialization.ts` (81 行) — Team/Swarm 初始化
- `src/hooks/useSwarmPermissionPoller.ts` (330 行) — 权限轮询
- `src/hooks/useInboxPoller.ts` (969 行) — 收件箱轮询
- `src/hooks/useTeammateViewAutoExit.ts` (63 行) — 队友自动退出
- `src/Task.ts` — teammate 相关的 task 逻辑
- `src/query.ts` — teammate idle notification, TaskCompleted hooks

**分析重点**:
1. Teammate 的生命周期管理
2. 收件箱的 JSONL 格式和读写锁
3. 消息总线的实现方式
4. permission bubbling 在 team 中的实际应用
5. teammate 的 idle 通知机制

**更新内容**:
- [ ] 重写 `<details>` 折叠：team 拓扑 + 消息格式 + 权限冒泡 + 行号
- [ ] 术语小抄补上

---

### s19 MCP Plugin

**CC 源码位置**:
- `src/services/mcp/client.ts` (3348 行) — MCP Client 核心
- `src/services/mcp/auth.ts` — MCP 认证
- `src/services/mcp/config.ts` — MCP 配置
- `src/services/mcp/channelPermissions.ts` (240 行) — 通道权限
- `src/services/mcp/channelNotification.ts` — 通道通知
- `src/services/mcp/channelAllowlist.ts` — 通道白名单

**分析重点**:
1. MCP Client 的连接生命周期（stdio/SSE/HTTP 三种 transport）
2. tools/list 和 tools/call 的 JSON-RPC 协议细节
3. Channel 机制——MCP server 如何反向给 Agent 发消息
4. 工具池合并的精确算法
5. MCP tool 的命名规则（mcp__server__tool）

**更新内容**:
- [ ] 重写 `<details>` 折叠：MCP 协议细节 + transport 类型 + channel 机制 + 行号
- [ ] 术语小抄补上

---

## Batch 3: 中等复杂章（定向分析 + 补充 CC 对照）

### s06 Subagent

**CC 源码位置**:
- `src/tools/AgentTool/` — AgentTool 定义
- `src/query.ts` — fork mode, fresh messages[]
- `src/Task.ts` — 子 Agent 的 task 绑定

**分析重点**:
1. fork mode vs fresh mode 的实际差异
2. prompt cache 在子 Agent 中的共享机制
3. 子 Agent 的上下文限制

**更新内容**:
- [ ] 补充 CC 源码对照折叠
- [ ] 术语小抄

### s07 Skill Loading

**CC 源码位置**:
- `src/setup.ts` — skill loading 初始化
- `src/query.ts` — skill 注入点
- `src/tools.ts` — skill 工具的注册

**分析重点**:
1. Skill 的目录结构和 manifest 格式
2. 两级加载的具体实现
3. Skill 内容注入方式（system prompt vs tool_result）

**更新内容**:
- [ ] 补充 CC 源码对照折叠
- [ ] 术语小抄

### s10 System Prompt

**CC 源码位置**:
- `src/constants/systemPromptSections.ts` (68 行) — 所有 prompt section
- `src/constants/prompts.ts` (914 行) — 完整 prompt 模板
- `src/context.ts` (189 行) — 上下文组装
- `src/query.ts` — getSystemContext/getUserContext 调用点

**分析重点**:
1. system prompt 的 section 列表和顺序
2. 运行时组装的逻辑（哪些始终加载，哪些按需）
3. memoize 缓存机制

**更新内容**:
- [ ] 补充 CC 源码对照折叠
- [ ] 术语小抄

### s12 Task System

**CC 源码位置**:
- `src/utils/tasks.ts` (862 行) — Task 数据结构和 CRUD
- `src/tools/TaskCreateTool/TaskCreateTool.ts` — 创建任务
- `src/tools/TaskListTool/TaskListTool.ts` — 列出任务
- `src/tools/TaskGetTool/TaskGetTool.ts` — 获取任务
- `src/tools/TaskUpdateTool/TaskUpdateTool.ts` — 更新任务
- `src/hooks/useTaskListWatcher.ts` (221 行) — 任务看板监听

**分析重点**:
1. TaskRecord 的完整字段（id, subject, status, owner, blockedBy, ...）
2. 任务状态机的所有合法转换
3. claim task 的并发安全机制
4. 任务文件存储格式

**更新内容**:
- [ ] 补充 CC 源码对照折叠
- [ ] 术语小抄
- [ ] 任务状态机 SVG

### s13 Background Tasks

**CC 源码位置**:
- `src/query.ts` — pendingToolUseSummary, notification queue, background execution

**分析重点**:
1. background task 的线程模型
2. notification queue 的注入时机
3. pendingToolUseSummary 的生成（Haiku 后台摘要）

**更新内容**:
- [ ] 补充 CC 源码对照折叠
- [ ] 术语小抄

### s14 Cron Scheduler

**CC 源码位置**:
- `src/hooks/useScheduledTasks.ts` (139 行)
- CC 的 cron job 存储和触发机制

**分析重点**:
1. durable vs session-only 的持久化方式
2. cron 表达式的解析和匹配算法
3. 调度器在主循环中的集成点

**更新内容**:
- [ ] 补充 CC 源码对照折叠
- [ ] 术语小抄

---

## Batch 4: 概念章或教学虚构章（轻量分析）

### s05 TodoWrite
- CC 中已被 Task 系统取代
- [ ] 补充说明 CC 的演进路径
- [ ] 术语小抄

### s16 Team Protocols
- shutdown_request/response 协议在 query.ts 中的实现
- [ ] 轻量 CC 对照

### s17 Autonomous Agents
- 来新璐指出"真实 CC 里没有这套"，是教学假设
- [ ] 开篇诚实标注，不需要 CC 源码分析
- [ ] 术语小抄

### s18 Worktree Isolation
- git worktree 命令的使用在 setup.ts/tools.ts 中
- [ ] 轻量 CC 对照

---

## 执行顺序

```
Batch 1 (已完成): s01, s02, s08

Batch 2 (深度分析, 本周):
  Day 1: s03 Permission + s04 Hooks    (并行跑 2 个 Agent)
  Day 2: s09 Memory + s11 Error Recovery (并行跑 2 个 Agent)
  Day 3: s15 Agent Teams + s19 MCP      (并行跑 2 个 Agent)

Batch 3 (定向分析, 后续):
  s06 Subagent + s07 Skill Loading    (并行)
  s10 System Prompt + s12 Task System  (并行)
  s13 Background + s14 Cron            (并行)

Batch 4 (轻量, 最后):
  s05 TodoWrite + s16 Team Protocols   (并行)
  s17 Autonomous + s18 Worktree        (并行)
```

## 总工作量估算

| Batch | 章数 | 每章预估 |
|-------|------|---------|
| Batch 2 深度 | 6 章 | 2-3 Agent 调用 + 编辑 |
| Batch 3 定向 | 8 章 | 1-2 Agent 调用 + 编辑 |
| Batch 4 轻量 | 4 章 | 直接编辑 |
| **合计** | **18 章**（s01/s02/s08 已完成） | |
