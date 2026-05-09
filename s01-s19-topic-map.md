# Learn Claude Code 主题划分分析

这个仓库的主线不是在"写一个智能体大脑"，而是在拆解 **Agent Harness 工程**。也就是：模型负责 agency，代码负责给模型提供工具、上下文、知识、任务状态、并发能力、团队协作和执行隔离。

## 阶段划分

| 阶段 | 范围 | 核心问题 |
|---|---:|---|
| 第一阶段：工具管线 | s01-s04 | 模型怎么动手、怎么加工具、怎么管权限、怎么拦截 |
| 第二阶段：单 Agent 能力增强 | s05-s08 | 规划、上下文隔离、按需加载知识、压缩记忆 |
| 第三阶段：知识与韧性 | s09-s11 | 跨压缩/跨会话记忆、运行时 prompt 组装、错误恢复 |
| 第四阶段：持久化工作 | s12-s14 | 任务图、后台执行、定时调度 |
| 第五阶段：多 Agent 平台 | s15-s19 | 团队协作、协议握手、自治认领、worktree 隔离、MCP 插件 |

## s01-s04 主题内容（Phase 1: Tool Pipeline）

> **核心问题**: 模型怎么动手？加工具不改循环怎么做到？怎么管权限？怎么在不动工具代码的前提下改工具行为？

| 主题 | 名称 | Motto | 内容是什么 |
|---|---|---|---|
| s01 | Agent Loop | *"One loop & Bash is all you need"* | 最小 agent 内核：`messages -> LLM -> tool_use -> execute tool -> append tool_result -> loop`。只有一个 `bash` 工具，重点是理解 `stop_reason == "tool_use"` 时继续循环，否则结束。对应 `s01_agent_loop/code.py`。 |
| s02 | Tool Use | *"Adding a tool means adding one handler"* | 把单一 `bash` 扩展成工具分发系统。新增 `read_file`、`write_file`、`edit_file`、`glob`，通过 `TOOL_HANDLERS` dispatch map 按工具名路由。重点是：加工具不改 agent loop，只加 schema 和 handler。对应 `s02_tool_use/code.py`。 |
| s03 | Permission System | *"Set boundaries first, then grant freedom"* | 把"一刀切禁止"升级为分级策略。引入 `PermissionGuard`，定义 allow/ask/deny 三种模式，`ls` 直接放行，`rm -rf /` 直接拒绝，中间的需确认。权限是光谱，不是两个按钮。对应 `s03_permission/code.py`。 |
| s04 | Hook System | *"Hook around the loop, never rewrite the loop"* | 在工具执行前后插入拦截层。引入 `HookManager`，支持 `PreToolUse`/`PostToolUse` 事件，三种模式 observe/modify/block。不改工具代码，也能改变工具行为——开闭原则的实践。对应 `s04_hooks/code.py`。 |

## s05-s08 主题内容（Phase 2: Single-Agent Capability）

> **核心问题**: 单个 agent 怎么稳定干长任务？怎么规划？怎么隔离上下文？怎么加载知识？上下文满了怎么办？

| 主题 | 名称 | Motto | 内容是什么 |
|---|---|---|---|
| s05 | TodoWrite | *"An agent without a plan drifts"* | 给 agent 加会话内计划能力。`TodoManager` 维护 `pending / in_progress / completed`，且只允许一个任务处于 `in_progress`。还有 nag reminder：多轮不更新 todo 就注入提醒。重点是防止多步任务跑偏。对应 `s05_todo_write/code.py`。 |
| s06 | Subagent | *"Big tasks split small, each subtask gets clean context"* | 引入一次性子 agent。父 agent 通过 `task` 工具派生子 agent，子 agent 使用独立 `messages[]`，完成后只返回摘要。重点是上下文隔离：子任务读了很多文件，父上下文只收到结论。对应 `s06_subagent/code.py`。 |
| s07 | Skill Loading | *"Load knowledge on demand, not upfront"* | 引入按需知识加载。`SkillLoader` 扫描 skill 定义，系统提示里只放名称和描述，模型需要时调用 `load_skill` 注入完整内容。重点是避免把全部领域知识塞进 system prompt。对应 `s07_skill_loading/code.py`。 |
| s08 | Context Compact | *"Context always fills up -- have a way to make room"* | 引入上下文压缩。四层策略：snip_compact 裁旧对话、micro_compact 旧工具结果占位、tool_result_budget 大结果落盘、compact_history LLM 全量摘要。重点是让长任务不会被上下文窗口限制。对应 `s08_context_compact/code.py`。 |

## s09-s11 主题内容（Phase 3: Knowledge and Resilience）

> **核心问题**: 压缩会丢信息，怎么跨压缩/跨会话保持知识？prompt 怎么管理才不膨胀？出错怎么恢复？

| 主题 | 名称 | Motto | 内容是什么 |
|---|---|---|---|
| s09 | Memory | *"Remember what matters, forget what doesn't"* | 引入持久记忆。三个子系统：Loading 每轮筛选相关记忆加载，Extraction 在 autoCompact 后自动发现偏好，Consolidation 定期整理去重。压缩是有损的，记忆系统补回了丢失的细节。对应 `s09_memory/code.py`。 |
| s10 | System Prompt | *"Prompts are assembled at runtime, not hardcoded"* | 把硬编码的 system prompt 拆成 `PROMPT_SECTIONS` 分段定义，按需拼接 `assemble_system_prompt`，加缓存避免重复组装。换项目只改 section，不改整个 prompt。对应 `s10_system_prompt/code.py`。 |
| s11 | Error Recovery | *"Errors aren't the end, they're the start of a retry"* | 三种恢复模式：输出截断时升级 max_tokens + 续写，上下文超限时 reactive compact，临时故障时指数退避 + 抖动重试。重点是错误不是终点，是分类 → 恢复的起点。对应 `s11_error_recovery/code.py`。 |

## s12-s14 主题内容（Phase 4: Durable Work）

> **核心问题**: 目标怎么跨会话存在？慢操作怎么不阻塞？周期性任务怎么自动触发？

| 主题 | 名称 | Motto | 内容是什么 |
|---|---|---|---|
| s12 | Task System | *"Big goals break into small tasks, ordered, persisted to disk"* | 把 s05 的内存 todo 升级成磁盘持久化任务图。每个任务写成 JSON 文件，支持 `blockedBy` 依赖、`pending → in_progress → completed` 状态流转、完成后自动解锁后续任务。重点是让目标跨压缩、跨进程、跨会话存在。对应 `s12_task_system/code.py`。 |
| s13 | Background Tasks | *"Slow ops go background, agent keeps thinking"* | 引入后台执行。`BackgroundManager` 用线程运行慢命令，主 agent loop 继续工作；后台完成后通过通知队列把结果注入下一轮 LLM 上下文。重点是 `pytest`、`npm install` 不再阻塞 agent 思考。对应 `s13_background_tasks/code.py`。 |
| s14 | Cron Scheduler | *"Fire on schedule, no human kick needed"* | 引入定时调度。独立 cron 线程 + 任务队列，支持持久化（`durable: true`，写入 `scheduled_tasks.json`）和会话级两种模式。重点是 Agent 自己按时间表做事，不需要人来推。对应 `s14_cron_scheduler/code.py`。 |

## s15-s19 主题内容（Phase 5: Multi-Agent Platform）

> **核心问题**: 单 agent 搞不定的任务怎么分工？队友间怎么通信？怎么让队友自己找活？多个 agent 怎么避免文件冲突？外部工具怎么接入？

| 主题 | 名称 | Motto | 内容是什么 |
|---|---|---|---|
| s15 | Agent Teams | *"Too big for one agent -- delegate to teammates"* | 引入持久队友。`TeammateManager` 创建有名字、有角色、有状态的 teammate，每个 teammate 有自己的 agent loop；`MessageBus` 用 JSONL 文件做异步邮箱。重点是从一次性 subagent 进化到持久协作 agent。对应 `s15_agent_teams/code.py`。 |
| s16 | Team Protocols | *"Teammates need shared communication rules"* | 给团队通信加协议。核心模式是 `request_id + pending/approved/rejected FSM`，用于 graceful shutdown 和 plan approval。重点是：队友之间不能只靠自由文本聊天，高风险动作要有结构化握手。对应 `s16_team_protocols/code.py`。 |
| s17 | Autonomous Agents | *"Teammates check the board, claim work themselves"* | 让队友具备自治能力。teammate 空闲后会轮询 inbox 和任务看板，发现未认领且未阻塞的任务就自动 claim；同时有 idle timeout 和身份重注入，防止压缩后忘记自己是谁。重点是从"领导分配任务"走向"队友自己找活"。对应 `s17_autonomous_agents/code.py`。 |
| s18 | Worktree Isolation | *"Each works in its own directory, no interference"* | 给任务绑定独立 git worktree。`.tasks/` 是控制面，`.worktrees/` 是执行面，任务 ID 和 worktree 绑定；支持创建、运行命令、保留、删除、事件日志。重点是多个 agent 并行改代码时目录隔离，避免互相覆盖。对应 `s18_worktree_isolation/code.py`。 |
| s19 | MCP Plugin | *"Not enough capability? Plug in more via MCP"* | 引入 MCP 外部工具协议。`MCPClient` 模拟 `tools/list` + `tools/call` 发现和调用外部工具；`assemble_tool_pool` 把内置工具和 MCP 工具合并成一个池子，`mcp__{server}__{tool}` 命名避免冲突。重点是外部能力通过标准协议接入，不需要重写工具代码。对应 `s19_mcp_plugin/code.py`。 |

## 最关键的递进关系

s01-s02 解决"模型怎么动手"。一个循环，一个分发表，加工具不改循环。

s03-s04 解决"怎么管住模型的动手"。权限是光谱不是开关，拦截在外不在内。

s05-s08 解决"单个 agent 怎么稳定干长任务"。先列计划，再隔离上下文，按需加载知识，满了就压缩。

s09-s11 解决"知识和韧性怎么跨会话存在"。压缩会丢信息——记忆补回来；prompt 别写死——运行时组装；出错别崩——分类恢复。

s12-s14 解决"目标和执行怎么脱离单次对话"。任务持久化到磁盘，慢操作丢后台，定时任务自动触发。

s15-s19 解决"多 agent 怎么协作、自治、隔离、扩展"。持久队友 + 异步邮箱、协议握手、自治认领、worktree 目录隔离、MCP 外部工具接入。

## 层级 (Harness Layer) 划分

| Layer | Harness 层 | 章节 |
|-------|-----------|------|
| 循环 | 基础连接 | s01 |
| 分发 | 扩展边界 | s02 |
| 安全门 | 权限管线 | s03 |
| 扩展点 | 钩子拦截 | s04 |
| 规划 | 会内计划 | s05 |
| 隔离 | 子上下文 | s06 |
| 知识 | 按需加载 | s07 |
| 压缩 | 上下文管理 | s08 |
| 记忆 | 跨会话积累 | s09 |
| 提示 | 运行时组装 | s10 |
| 韧性 | 错误恢复 | s11 |
| 任务 | 持久目标 | s12 |
| 后台 | 异步执行 | s13 |
| 调度 | 定时触发 | s14 |
| 团队 | 持久队友 | s15 |
| 协议 | 结构化握手 | s16 |
| 自治 | 自主认领 | s17 |
| 隔离 | 目录隔离 | s18 |
| 插件 | 外部能力 | s19 |

## 推荐阅读顺序

1. 先读根目录 `README.md`，把"模型负责 agency，harness 负责落地"的基本立场立住。
2. 按顺序读 `s01_agent_loop/README.md` 到 `s19_mcp_plugin/README.md`，每章只关注新增机制。
3. 对照运行各章 `code.py`，看每章新增的工具和类。
4. 最后读 `s_full/code.py`，把所有机制合成一张完整 harness 架构图。

## 递进规则

每个章节只做一件事：在上一个章节的基础上，加一个新机制。核心循环 `while True` 从 s01 到 s19 从未改变。循环属于 agent，机制属于 harness。

<!-- translation-sync: zh@v1 -->
