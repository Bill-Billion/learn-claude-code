# s20: Comprehensive Agent — 全部机制，归到一个循环

[中文](README.zh.md) · [English](README.md) · [日本語](README.ja.md)

s01 → ... → s18 → s19 → `s20`

> *"机制很多，循环一个"* — 工具、权限、记忆、任务、团队、插件都挂在同一个 while True 上。
>
> **Harness 层**: 综合 — 把前 19 章的机制放回同一个可运行系统。

---

十九课下来，你手里攒了十九个零件，每个都单独跑通过。但真实的 Agent 不是十九个 demo，是一个进程：压缩要在记忆提取前让路，权限要卡在分发之前，cron 不能打断用户正聊着的轮次。零件对了，装配顺序错了，机器照样散架。

这一课不发明任何新机制，只回答一个问题：**每个零件挂在循环的哪个位置，为什么是那个位置。**

![System Architecture](images/system-architecture.svg)

一图流的版本是这样：

```text
用户输入
  → UserPromptSubmit hooks
  → cron/background 通知注入
  → context compact
  → memory + skills + MCP 状态组装 system prompt
  → LLM
  → has tool_use block?
      否 → Stop hooks → 返回
      是 → PreToolUse hooks + permission
          → TOOL_HANDLERS / MCP handlers / background dispatch
          → PostToolUse hooks
          → tool_result / task_notification 回 messages
          → 下一轮
```

循环本身还是 s01 那五步：调模型、看它是否要工具、执行、结果喂回去、再来。变完整的是循环周围的一切。

> 真实 Claude Code：连"看它是否要工具"都不信任 `stop_reason`，而是检查内容里有没有 `tool_use` 块（s01 讲过流式下的原因）。教学版到最后一课也保持 `stop_reason` 判断，非流式下它足够准。

---

## 组件在循环中的位置

| 位置 | 组件 | 作用 |
|------|------|------|
| 用户输入前后 | `UserPromptSubmit` hooks | 记录、注入、审计用户输入 |
| LLM 前 | cron queue | 把定时触发的 prompt 注入 `messages` |
| LLM 前 | background notifications | 后台任务完成后以 `<task_notification>` 注入 |
| LLM 前 | compaction pipeline | 先转存大结果，再裁历史，再占位旧结果，必要时摘要 |
| LLM 前 | memory / skills / MCP state | 组装 system prompt，让模型看到当前能力和长期上下文 |
| LLM 调用 | error recovery | 429/529 退避，`max_tokens` 升级，超限触发 reactive compact |
| 工具执行前 | `PreToolUse` hooks + permission | 拦危险命令、写越界、破坏性 MCP 工具 |
| 工具分发 | `assemble_tool_pool` | 内置工具 + MCP 动态工具，每轮重组 |
| 工具执行时 | background dispatch | 慢操作进 daemon 线程，主循环拿占位凭条先走 |
| 工具执行后 | `PostToolUse` hooks | 大输出告警、日志等后处理 |
| 返回循环 | tool_result | 每个 `tool_use` 对应一个 `tool_result`，回到下一轮 |
| 停止时 | `Stop` hooks | 统计、清理，返回非 None 可拒绝收工 |

---

## 装配顺序不是随意的

各章讲过的硬约束，装到一台机器上就成了装配规程。翻车方式当时都单独论证过，这里汇成一张清单：

| 规程 | 反着装会怎样 | 出处 |
|------|------------|------|
| `tool_result_budget` 先于 `micro_compact` | 大结果先被擦成占位符，永远失去转存机会 | s08 |
| 记忆提取用压缩前快照 | 对着被裁剪的历史考古，关键偏好已成占位符 | s09 |
| 权限检查先于工具分发 | 命令已经跑了，拦截变成事后通报 | s03/s04 |
| 拒绝、拦截也要回 `tool_result` | 配对断裂，API 直接 400 | s01/s03 |
| 后台通知不复用 `tool_use_id` | id 已配对过，复用报错；通知走 user 文本通道 | s13 |
| cron 轮与用户轮共用 `agent_lock` | 两个轮次并发写同一份历史，消息交错 | s14 |
| 信箱消费统一入口、路由先行 | 协议答复被掏走未登记，请求永远 pending | s16 |
| 销毁前先确认（存盘/解析/数变更） | 一次失败清空记忆 / 蒸发工位里的工作 | s08/s09/s18 |
| 一切模型给的名字先过安检 | 路径注入：读走 `.env`，工位开到仓库外 | s02/s07/s18/s19 |

这张表就是全课程的骨架。单看每一条都是小心思，合在一起是同一个立场：**模型负责决策，harness 负责让决策无法造成结构性破坏。**

---

## code.py 里都有什么

**工具与分发。** 内置 27 个工具（bash、文件、todo、task/subagent、skill、compact、任务图五件套、cron 三件套、团队六件套、worktree 三件套、connect_mcp），加上 MCP 发现的动态工具，`assemble_tool_pool()` 每轮重组。s02 的查表分发一路用到最后一课，没改过一行结构。

**两层计划。** `todo_write` 管单 Agent 的当前会话（防漂移，s05），任务图管跨会话协作（依赖、认领、持久化，s12）。两层并存不冗余，一个是便签，一个是看板。

**两种委派。** `task` 拉一次性子 Agent（干净上下文，只回摘要，s06）；`spawn_teammate` 拉持久队友（信箱通信、自治认领，s15-s17）。前者解决上下文隔离，后者解决长期并行。

**prompt 与知识。** `assemble_system_prompt(context)` 按真实状态装配（s10）：身份、工具、workspace、技能目录、记忆索引、已连接的 MCP server。技能和记忆都是目录常驻、正文按需（s07/s09）。

**压缩与恢复。** LLM 前四步管线（s08），调用外包一层恢复（429/529 退避、`max_tokens` 两级升级、超限 reactive compact，s11）。

**后台与定时。** 慢命令进线程、凭条占位、通知注入（s13）；cron 调度线程独立看表，触发走队列，与用户轮互斥（s14）。

**隔离与外接。** 任务可绑 worktree，队友在工位目录里干活（s18）；MCP 工具发现后带前缀入池（s19）。

---

## 相对 s19 的变化

| 组件 | s19 | s20 |
|------|-----|-----|
| 工具池 | 内置 + MCP | 补齐 s01-s18 的全部工具 |
| 权限 | 教学主体省略 | `PreToolUse` hook 中执行 |
| hooks | 省略 | 四事件全挂载 |
| todo / skill / compact | 省略 | 全部回归 |
| error recovery | 简化 try/except | 退避 / 升级 / reactive compact |
| background / cron | 省略 | 后台线程 + durable 调度 |
| multi-agent / worktree | 保留 | 保留，队友在工位目录执行 |

---

## 试一下

```sh
cd learn-claude-code
python s20_comprehensive/code.py
```

1. `Create a todo list for inspecting this repo, then list Python files`：s05 的便签和 s02 的工具在同一轮里工作；
2. `Connect to the docs MCP server and search for agent loop`：s19 的发现与装配；
3. `Create two tasks, create worktrees for them, then spawn alice and bob. Ask them to submit plans before claiming tasks.`：s12+s15+s16+s18 四套机制咬合运转，看计划审批通过后队友才认领、认领后在各自工位里干活；
4. `Remind me of the meeting in 3 minutes.`：s14 的闹钟，到点终端自己动；
5. `Run 'sleep 20 && echo build done' in the background and continue reading README.md`：s13 的凭条与通知。

观察重点：每个工具调用前的 `[HOOK]` 行、`connect_mcp` 后下一轮的新工具、后台占位凭条、到点自动提醒、审批前队友是否暂停、worktree 绑定后队友的执行目录。十九章的日志标记全部在场。

---

## 结束亦是开始

从 s01 到 s20，代码表面越来越复杂，核心始终没变：

```python
while True:
    response = LLM(messages, tools)
    if not has_tool_use(response.content):
        return
    results = execute_tools(response.content)
    messages.append(tool_results)
```

Claude Code 的复杂性不是"另一个 Agent 大脑"，而是一个成熟 harness 的复杂性。模型负责判断和选择，harness 负责把环境、工具、权限、记忆、团队和外部能力组织好，并且守住上面那张装配规程表。

这是 s01-s20 主线的收束。而这个循环始终是单步、模型驱动的：每一轮，模型挑一个工具。当编排的形状已经固定（并行扇出、逐项流水、断点续跑），与其让模型一轮轮驱动，不如把它写成一段确定性、可恢复的脚本。

接下来：[s21 Workflow Runtime](../s21_workflow_runtime/) — 模型决定单步，脚本决定编排。
