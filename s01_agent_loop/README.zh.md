# s01: Agent Loop — 一个循环就够了

[中文](README.zh.md) · [English](README.md) · [日本語](README.ja.md)

`s01` → [s02](../s02_tool_use/) → s03 → s04 → ... → s20
> *"One loop & Bash is all you need"* — 一个工具 + 一个循环 = 一个 Agent。
>
> **Harness 层**: 循环 — 模型与真实世界的第一道连接。

---

把一个任务抛给聊天窗口里的模型："看看我这个目录里有哪些 Python 文件，然后跑一下 hello.py。"

它回了你一条挺像样的 bash 命令，然后就停了。命令是你复制到终端里跑的，输出是你手动粘贴回去的；它看完输出，给出下一条命令，你再跑、再贴。

任务是它规划的，活儿全是你干的。一个真实的开发任务，几十次命令来回很正常，也就是几十轮人肉传话。这一章做的事只有一件：把"你"从这个来回里换成一个 `while` 循环。换完，Agent 就诞生了。

![Agent Loop](images/agent-loop.svg)

---

## 先搞懂：和模型的一次对话是怎么回事

写循环之前，先看清楚我们手里有什么。调用模型的 API，本质上就是发一个列表过去、收一条回复回来：

```python
messages = [{"role": "user", "content": "看看目录里有哪些 Python 文件"}]
response = client.messages.create(model=MODEL, messages=messages, ...)
```

`messages` 里的每一项有两个字段：`role` 说明这句话是谁说的（`user` 或 `assistant`），`content` 是内容本身。

有一个设定务必记住：模型是无状态的。它不记得上一次调用，每次都当作第一次见你。所谓"多轮对话"，其实是每次调用都把之前的完整历史重新发一遍，模型看完全部历史，接着往下说。

所以"让对话继续"在代码里只是一件事：往 `messages` 末尾追加新内容，再整个发一遍。

顺带记住这个设定的另一面：历史每轮都要完整重发，只会越来越长。这件事到 s08 会变成一个真正的麻烦。

---

## 模型没有手

模型运行在云端的服务器上，你的终端在本地。它可以在回复里写出 `ls *.py`，但它碰不到你的 shell，一行命令也执行不了。能执行命令的只有一个角色：你本地跑着的这段 Python 程序。

所以 API 设计了一套"点菜"协议，叫工具调用（tool use）：

1. 你在请求里用 `tools` 参数告诉模型：有这些工具可用，每个叫什么、干什么、参数长什么样；
2. 模型想用某个工具时，不再回普通文本，而是回一个 `tool_use` 块：工具名、参数，外加一个编号 `id`；
3. 你的程序看到 `tool_use`，真的去执行，把输出装进 `tool_result` 块发回去，带上同一个编号；
4. 模型看到结果，继续推理。

菜单上暂时只放一道菜：`bash`。

```python
TOOLS = [{
    "name": "bash",
    "description": "Run a shell command.",
    "input_schema": {                       # 参数的 JSON Schema
        "type": "object",
        "properties": {"command": {"type": "string"}},
        "required": ["command"],
    },
}]
```

执行端是一个普通函数，三处保护各有明确的理由：

```python
def run_bash(command: str) -> str:
    # 黑名单：这几个词出现就拒绝执行（s03 会换成真正的权限系统）
    dangerous = ["rm -rf /", "sudo", "shutdown", "reboot", "> /dev/"]
    if any(d in command for d in dangerous):
        return "Error: Dangerous command blocked"
    try:
        r = subprocess.run(command, shell=True, cwd=os.getcwd(),
                           capture_output=True, text=True, timeout=120)
        out = (r.stdout + r.stderr).strip()
        # 截断到 50000 字符：一条命令吐出 500KB 日志，会把后面的对话挤没
        return out[:50000] if out else "(no output)"
    except subprocess.TimeoutExpired:
        # 卡死的命令 120 秒后放弃，循环才能继续走
        return "Error: Timeout (120s)"
```

分工从这里就定下来了：模型只负责决策（要不要执行、执行什么），程序负责执行（真的跑命令、把结果带回来）。模型说了不算，你的代码才是那双手。后面每一章加的新能力，都沿用这个分工。

---

## 把人肉来回变成循环

现在把开头那套"你跑命令、你贴结果"翻译成代码，一共五步。

**第 1 步**：用户的问题作为第一条消息。

```python
messages = [{"role": "user", "content": query}]
```

**第 2 步**：消息和工具菜单一起发给模型。

```python
response = client.messages.create(
    model=MODEL, system=SYSTEM, messages=messages,
    tools=TOOLS, max_tokens=8000,
)
```

`system` 是一条常驻说明，告诉模型它的角色和行事风格。这里写的是：你是个编码 Agent，用 bash 干活，少解释多行动。s10 会专门讲怎么写好它。

**第 3 步**：把模型的回复追加进历史，然后看它是想干活还是说完了。判断依据是 `stop_reason`：模型请求调工具时，这个字段的值是 `"tool_use"`；没请求，说明它认为任务已经结束，循环退出。

```python
messages.append({"role": "assistant", "content": response.content})
if response.stop_reason != "tool_use":
    return
```

**第 4 步**：执行模型点的每一道菜，结果和编号一一对应收集起来。

```python
results = []
for block in response.content:
    if block.type == "tool_use":
        output = run_bash(block.input["command"])
        results.append({
            "type": "tool_result",
            "tool_use_id": block.id,   # 用编号对上这是哪次调用的结果
            "content": output,
        })
```

**第 5 步**：结果作为一条新的 `user` 消息追加，回到第 2 步。

```python
messages.append({"role": "user", "content": results})
```

工具结果的 `role` 是 `user`，第一次看会觉得别扭：明明是程序产生的，怎么算用户说的？换个角度就顺了：对模型来说，`assistant` 是"我说的话"，`user` 是"外部世界传来的信息"。命令输出正是外部世界的回音。

组装成完整函数：

```python
def agent_loop(messages):
    while True:
        response = client.messages.create(
            model=MODEL, system=SYSTEM, messages=messages,
            tools=TOOLS, max_tokens=8000,
        )
        messages.append({"role": "assistant", "content": response.content})

        if response.stop_reason != "tool_use":
            return

        results = []
        for block in response.content:
            if block.type == "tool_use":
                output = run_bash(block.input["command"])
                results.append({
                    "type": "tool_result",
                    "tool_use_id": block.id,
                    "content": output,
                })
        messages.append({"role": "user", "content": results})
```

拿一个具体任务走一遍，看 `messages` 是怎么生长的。任务：`Create a file called hello.py that prints "Hello, World!"`。一次典型的运行是这样（每次不一定完全相同，但形状如此）：

```text
messages[0]  user       Create a file called hello.py ...
messages[1]  assistant  tool_use: bash("echo 'print(...)' > hello.py")   ← 第 1 轮
messages[2]  user       tool_result: (no output)
messages[3]  assistant  tool_use: bash("python hello.py")                ← 第 2 轮
messages[4]  user       tool_result: Hello, World!
messages[5]  assistant  text: 文件已创建并验证。                          ← 没有 tool_use，循环结束
```

第 2 轮没人要求它验证，是模型看到第 1 轮成功后自己决定的。循环的全部价值就在这里：它让模型能看到结果再想下一步，规划、执行、检查连成一条线。整个循环只认两个信号：

| 信号 | 含义 | 循环动作 |
|------|------|---------|
| `stop_reason == "tool_use"` | 模型请求调用工具 | 执行，结果喂回去，继续 |
| `stop_reason != "tool_use"` | 模型没有请求工具 | 生成结束，退出循环 |

---

## 三个容易踩的坑

**`tool_result` 必须和 `tool_use` 配对。** 每个结果都要带 `tool_use_id`，而且必须出现在紧跟着的下一条 `user` 消息里。漏了、错位了，API 直接报 400。这条配对约束会一路跟到 s08：将来裁剪历史时，这两样东西不能拆开。

**结果要原样喂回去，包括报错。** 命令失败的输出（`command not found`、Python 的 traceback）不要吞掉，照样放进 `tool_result`。模型看到报错才会修正思路，这是它自我纠错的唯一线索。

**`while True` 没有保险丝。** 教学版特意不加轮数上限：循环停不停，完全由模型决定。绝大多数任务它干完就停；真遇到停不下来的，`Ctrl+C`。生产系统当然不能这么裸奔，轮数上限、预算控制这些保护，s11 和 s22 会补上。

---

## 试一下

> **教学 demo 提示**：代码会执行模型生成的 shell 命令。建议在一个临时测试目录中运行，避免影响你的项目文件。s03 会讲真正的权限系统。

**准备**（首次运行）：

```sh
pip install -r requirements.txt
cp .env.example .env
# 编辑 .env，填入 ANTHROPIC_API_KEY 和 MODEL_ID
```

**运行**：

```sh
python s01_agent_loop/code.py
```

试这三个任务。黄色的 `$ ...` 行就是循环在执行命令，数一数每个任务各跑了几轮：

1. `Create a file called hello.py that prints "Hello, World!"`：通常两轮，创建之后自发验证一次；
2. `List all Python files in this directory`：通常一轮，拿到列表就直接回答；
3. `What is the current git branch?`：一轮。可以接着追问 `Now count how many commits this branch has`，看它在同一段历史上继续干活。

观察重点：模型什么时候继续调工具（循环继续），什么时候直接回答（循环结束）。退出循环的从来不是代码里的某个条件写死了几轮，而是模型的一个决定。

---

## 接下来

现在模型手里只有 bash 一个工具，读文件要 `cat`，写文件要 `echo ... >`，找个文件要 `find`，不够直观，也容易拼错。

s02 Tool Use → 给它 5 个真正的工具，会发生什么？模型会不会一次调用多个工具？几个工具同时跑会不会互相踩？

<details>
<summary>深入 Claude Code 源码</summary>

> 以下内容基于 Claude Code 源码 `src/query.ts`（1729 行）的核查。核心差异就两个：Claude Code 不看 `stop_reason` 字段而是检查内容里有没有 tool_use 块（因为流式响应中 stop_reason 不可靠）；Claude Code 有更多的退出路径和恢复策略做生产级保护。

下面每一项都是在教学版循环基础上叠加的保护机制。

<details>
<summary>一、循环结构差异</summary>

教学版检查 `response.stop_reason`。Claude Code 不把它作为循环继续的唯一依据——流式响应中 `stop_reason` 可能还没更新但内容里已经有 `tool_use` 块了。Claude Code 用 `needsFollowUp` 标志：接收到流式消息时（`query.ts:830-834`），只要检测到 `tool_use` 块就设为 `true`；`QueryEngine.ts` 会从 `message_delta` 捕获真实 `stop_reason` 用于其他逻辑，但 query loop 本身靠 `needsFollowUp` 决定是否继续。

```typescript
// query.ts:554-558
// stop_reason === 'tool_use' is unreliable.
// Set during streaming whenever a tool_use block arrives.
let needsFollowUp = false
```

</details>

<details>
<summary>二、State 对象 10 字段（教学版只用 messages）</summary>

| # | 字段 | 用途 | 对应章节 |
|---|------|------|---------|
| 1 | `messages` | 当前迭代的消息数组 | s01 |
| 2 | `toolUseContext` | 工具、信号、权限上下文 | s02 |
| 3 | `autoCompactTracking` | 压缩状态追踪 | s08 |
| 4 | `maxOutputTokensRecoveryCount` | token 恢复尝试次数（上限 3） | s11 |
| 5 | `hasAttemptedReactiveCompact` | 本轮是否已尝试响应式压缩 | s08 |
| 6 | `maxOutputTokensOverride` | 8K→64K 的升级覆盖 | s11 |
| 7 | `pendingToolUseSummary` | 后台 Haiku 生成的 tool use 摘要 | s08 |
| 8 | `stopHookActive` | 停止钩子是否产生阻塞错误 | s04 |
| 9 | `turnCount` | 轮次计数（maxTurns 检查） | s01 |
| 10 | `transition` | 上一次继续原因 | s11 |

> 注：`taskBudgetRemaining`（`query.ts:291`）是 loop-local 局部变量，不在 State 上。源码注释明确写了 "Loop-local (not on State)"。

</details>

<details>
<summary>三、多条退出和继续路径</summary>

教学版只有 1 条退出路径（模型不调工具就结束）。生产版有多条退出和继续路径，覆盖 blocking limit、prompt too long、model error、abort、hook stop、max turns、token budget continuation、reactive compact retry 等场景。每种场景都有对应的恢复或退出策略。

</details>

<details>
<summary>四、流式工具执行和 QueryEngine</summary>

Claude Code 的 `StreamingToolExecutor`（`query.ts:561`）让工具在模型还在生成时就开始并行执行（根据工具是否 concurrency-safe 决定并发或独占）。`QueryEngine.ts` 额外加了费用超限、结构化输出验证失败等保护。教学版不实现这些——目标是概念清晰，不是性能极致。

</details>

所有复杂字段和退出路径都是保护机制，理解核心循环后再看这些会更容易。

</details>

<!-- translation-sync: zh@v2, en@v0, ja@v0 -->
