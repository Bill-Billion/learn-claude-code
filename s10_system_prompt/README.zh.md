# s10: System Prompt — 运行时组装，不硬编码

[中文](README.zh.md) · [English](README.md) · [日本語](README.ja.md)

s01 → ... → s08 → s09 → `s10` → [s11](../s11_error_recovery/) → s12 → ... → s20
> *"prompt 是组装出来的, 不是写死的"*。分段 + 按需拼接 + 缓存。
>
> **Harness 层**: 提示的运行时组装。

---

回头数一数 SYSTEM prompt 这一路是怎么长起来的：s01 只有一句身份，s05 加了 todo 引导，s07 拼进了技能目录，s09 又拼进了记忆索引。每一章都往同一个字符串上焊一段：

```python
SYSTEM = (
    f"You are a coding agent at {WORKDIR}. "
    "Use tools to solve tasks. Act, don't explain. "
    "Before starting any multi-step task, use todo_write. "
    "Skills are available via list_skills and load_skill. "
    "Relevant memories are injected below when available. "
    # ... 加一个能力就多焊一段
)
```

三个麻烦跟着来。换个项目要重写整段，但哪些句子是通用的、哪些是项目相关的，焊死之后分不出来。加一段新指令可能和前面某句打架，一团字符串里没人能看出冲突。而且 s08 的选学讲过 prompt cache 的脾气：前缀逐字一致才命中。一整团字符串，只要有一个字是动态的，整个 SYSTEM 每轮都是"新前缀"。

要治这三个麻烦，第一步是同一个动作：把它拆开。

![System Prompt Overview](images/system-prompt-overview.svg)

---

## 拆成段：一个主题一个段落

```python
PROMPT_SECTIONS = {
    "identity": "You are a coding agent. Act, don't explain.",
    "tools": "Available tools: bash, read_file, write_file.",
    "workspace": f"Working directory: {WORKDIR}",
    "memory": "Relevant memories are injected below when available.",
}
```

段与段独立维护：改 `tools` 不碰 `identity`，新增 `memory` 不动 `workspace`。冲突也变得可见，因为每段只讲一件事。

拆开只是第一步。段有了，谁来决定这一轮装哪些？

---

## 按状态装配，不按关键词猜测

```python
def assemble_system_prompt(context: dict) -> str:
    sections = []

    # 始终加载：身份、工具、工作目录，每轮都需要
    sections.append(PROMPT_SECTIONS["identity"])
    sections.append(PROMPT_SECTIONS["tools"])
    sections.append(PROMPT_SECTIONS["workspace"])

    # 按需加载：依据是真实状态，不是对话里的关键词
    memories = context.get("memories", "")
    if memories:
        sections.append(f"Relevant memories:\n{memories}")

    return "\n\n".join(sections)
```

判断依据值得较真。memory 段装不装，看的是 `.memory/MEMORY.md` 是否存在且非空，这是文件系统里的事实。另一种做法是看用户的话里有没有"记住""偏好"这类词，那是猜测。事实驱动的装配是确定的、可测试的；关键词驱动的装配会在用户换个说法时失灵。

context 本身也从真实状态派生：

```python
def update_context(context: dict, messages: list) -> dict:
    memories = ""
    if MEMORY_INDEX.exists():                       # 查文件系统，不查对话
        content = MEMORY_INDEX.read_text().strip()
        if content:
            memories = content
    return {
        "enabled_tools": list(TOOL_HANDLERS.keys()),  # 实际注册的工具
        "workspace": str(WORKDIR),
        "memories": memories,
    }
```

循环里每轮工具执行完都重估一次 context。原因很实际：工具会改变世界，模型上一轮刚写了 `MEMORY.md`，下一轮的 prompt 就该反映出来。

---

## 缓存：同样的状态，别拼第二遍

同一轮对话里 context 往往没变，每次都重新拼字符串是浪费。加一层缓存，用序列化后的 context 当 key：

```python
def get_system_prompt(context: dict) -> str:
    global _last_context_key, _last_prompt
    key = json.dumps(context, sort_keys=True, ensure_ascii=False, default=str)
    if key == _last_context_key and _last_prompt:
        return _last_prompt                     # [cache hit]
    _last_context_key = key
    _last_prompt = assemble_system_prompt(context)
    return _last_prompt                         # [assembled]
```

cache key 为什么用 `json.dumps(sort_keys=True)` 而不是顺手的 `hash()`？两个坏法：Python 的 `hash()` 对字符串有进程级随机化，同一个 context 在两次运行里 key 不同，缓存形同虚设；而且 context 里有 list 和 dict，`hash()` 直接抛 `unhashable type`。确定性序列化是唯一稳的选择，`sort_keys` 保证字典序不影响 key。

一句诚实的边界：这层缓存省的是本进程里拼字符串的功夫，和 API 侧的 prompt cache 是两回事。不过分段这个动作同时在为后者铺路：段拆开了，才能把稳定的段排在前面、把易变的段推到最后，让 s08 讲过的"稳定前缀"活得更久。

> 真实 Claude Code：section 数量不固定，随 feature flag、输出风格、运行模式增减；静态段合并成一个全局缓存块，动态段被 `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` 隔在缓存边界之外；全家唯一的易失段是 `mcp_instructions`，因为 MCP server 可能在轮次之间连上或断开。教学版的四段两策略，是同一套结构的最小版。

---

## 相对 s09 的变更

| 组件 | 之前 (s09) | 之后 (s10) |
|------|-----------|-----------|
| prompt | 硬编码 SYSTEM 字符串 | `PROMPT_SECTIONS` + `assemble_system_prompt` |
| 缓存 | 无 | `get_system_prompt`（`json.dumps` 检测 + 缓存） |
| 新函数 | — | `assemble_system_prompt`, `get_system_prompt`, `update_context` |
| 工具 | 6 个 | 3 个（本章聚焦 prompt 组装，收窄到 bash, read_file, write_file） |
| 循环 | 用固定 SYSTEM | 每轮工具执行后重估 context，再取 prompt |

---

## 试一下

```sh
cd learn-claude-code
python s10_system_prompt/code.py
```

终端上的两个标签就是本章的全部观察点：`[assembled] sections: ...` 表示重新组装（会列出装了哪些段），`[cache hit]` 表示状态没变、直接复用。

1. `Read the file README.md`：看第一次组装装了哪三个段。如果你刚跑过 s09，`.memory/` 里已有记忆文件，第一轮就会看到 `memory` 也在列表里；
2. 接着再问一个问题：这次应该是 `[cache hit]`，因为 context 没变；
3. `Create a file called .memory/MEMORY.md with content "- [test](test.md) — test memory"`（若此前没有记忆文件）：写入后的下一轮，`[assembled]` 重新出现，sections 列表里多了 `memory`。模型改了文件系统，prompt 跟着变了，这就是"按状态装配"在跑。

---

## 接下来

prompt 会组装了，能力也齐了。但这一切建立在一个假设上：每次 API 调用都成功。真实世界不是这样，网络抖动、限流、输出截断、上下文超限，这些不是意外，是日常。现在的代码碰上其中任何一个，直接崩给你看。

s11 Error Recovery → 四条恢复路径：升级 token、压缩上下文、指数退避、切换模型。

<!-- translation-sync: zh@v2, en@v2, ja@v2 -->
