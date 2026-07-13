# s07: Skill Loading — 用到的时候才加载

[中文](README.zh.md) · [English](README.md) · [日本語](README.ja.md)

s01 → s02 → s03 → s04 → s05 → s06 → `s07` → [s08](../s08_context_compact/) → s09 → ... → s20
> *"用到时再加载, 别全塞 prompt 里"* — 通过 `tool_result` 注入, 不塞 system prompt。
>
> **Harness 层**: 知识 — 按需加载, 不堆满上下文。

---

上一课结尾留了个问题：每类任务需要的知识不一样。你的项目里有一套 React 组件规范、一份 SQL 风格指南、一份 API 设计文档，Agent 干活时得守这些规矩。规矩从哪来？

最直接的想法，全塞进 system prompt：

```python
SYSTEM = (
    f"You are a coding agent. "
    + open("docs/react-style.md").read()       # 2000 行
    + open("docs/sql-style.md").read()         # 1500 行
    + open("docs/api-design.md").read()        # 3000 行
)
```

6500 行的 system prompt。s01 讲过模型是无状态的，这 6500 行每一轮调用都要完整重发。Agent 此刻在改一个 CSS 颜色，SQL 指南和 API 文档跟它毫无关系，却轮轮都在计费。可以算笔账：一份规范约 2000 token，十份就是 2 万 token 的固定开销，而其中 99% 的内容和当前任务无关。

![Skill Overview](images/skill-overview.svg)

---

## 那让它自己去读文件？

第二个直觉：把文档拆成几个文件放在项目里，Agent 用哪个自己 `read_file`。

差一步。Agent 根本不知道有哪些文档可读。它得先知道"有什么"，才谈得上"用哪个"。你不能指望它每次任务前先 `glob` 一遍全项目找文档，那是撞运气，不是设计。

拆开这两个需求，答案就出来了：**"有什么"必须常驻，"是什么"可以按需。** 常驻的部分要足够便宜（一个名字加一句话），按需的部分才是大头（完整规范全文）。

| 层 | 位置 | 时机 | 代价 |
|---|------|------|------|
| 目录 | system prompt | 启动时注入 | ~100 token/技能，每轮都带 |
| 内容 | tool_result | Agent 调 `load_skill` 时 | ~2000 token/技能，用到才花 |

---

## 第一层：启动时扫描，目录进 SYSTEM

技能就是一个目录一个 `SKILL.md`，frontmatter 里写名字和一句话描述：

```
skills/
  agent-builder/SKILL.md
  code-review/SKILL.md
  mcp-builder/SKILL.md
  pdf/SKILL.md
```

harness 启动时扫一遍，解析 frontmatter，存进注册表：

```python
SKILL_REGISTRY: dict[str, dict] = {}

def _scan_skills():
    for d in sorted(SKILLS_DIR.iterdir()):
        manifest = d / "SKILL.md"
        if manifest.exists():
            raw = manifest.read_text()
            meta, body = _parse_frontmatter(raw)          # 解析 YAML frontmatter
            name = meta.get("name", d.name)
            desc = meta.get("description", ...)
            SKILL_REGISTRY[name] = {"name": name, "description": desc, "content": raw}

_scan_skills()   # 启动时跑一次

def build_system() -> str:
    catalog = "\n".join(f"- **{s['name']}**: {s['description']}"
                        for s in SKILL_REGISTRY.values())
    return (
        f"You are a coding agent at {WORKDIR}. "
        f"Skills available:\n{catalog}\n"
        "Use load_skill to get full details when needed."
    )

SYSTEM = build_system()
```

从此模型每一轮都看得到"我会什么"：四行目录，每行一个名字加一句描述，代价小到可以忽略。

但目录只有一句话。真要做 code review 时，那份完整的审查清单，它还够不到。

---

## 第二层：load_skill，内容按需取

模型自己判断"这个任务需要 code-review 技能"，然后调工具取全文：

```python
def load_skill(name: str) -> str:
    skill = SKILL_REGISTRY.get(name)      # 查注册表，不碰文件路径
    if not skill:
        return f"Skill not found: {name}"
    return skill["content"]
```

接入还是老规矩，定义一条、注册一行，循环零改动。

两个设计决定藏在这几行里，都有对应的坏法。

**查注册表，不拼文件路径。** 如果实现成 `open(f"skills/{name}/SKILL.md")`，那么 `name` 就成了路径注入口，`load_skill("../../.env")` 会把你的密钥读出来喂给模型。注册表在启动时固定，运行时给什么名字都只在字典里查，查不到就是一句 `Skill not found`。

**内容进 `messages`，不进 SYSTEM。** 加载的技能全文是以 `tool_result` 的身份进入对话的，和读文件的结果同等待遇。如果反过来把它追加进 system prompt，它就永久驻留了：每轮重发，用完了也甩不掉。放在 `messages` 里，它就服从对话历史的一切管理规则，这一点下一课马上会用到。

还有一条边界要说清：**子 Agent 没有技能系统。** `SUB_SYSTEM` 里没有目录，`SUB_TOOLS` 里没有 `load_skill`。委派任务时如果需要领域知识，得把要点写进任务描述里带过去。这是 s06"摘要之外的信息就是不存在"的镜像：上下文隔离是双向的。

> 真实 Claude Code：技能来源有十来种（用户目录、项目目录、插件、MCP 远程技能、内置技能等）合并加载；目录注入有预算，约占上下文窗口的 1%、上限 8000 字符；SKILL.md 还能声明 `context: fork`，让技能直接作为子 Agent 运行。教学版一个目录一个工具，两级结构与之相同。

---

## 相对 s06 的变更

| 组件 | 之前 (s06) | 之后 (s07) |
|------|-----------|-----------|
| 工具数量 | 7 (bash, read, write, edit, glob, todo_write, task) | 8 (+`load_skill`) |
| 知识加载 | 无 | 两级：目录常驻 SYSTEM + 内容按需进 `messages` |
| SYSTEM 提示 | 静态字符串 | 启动时扫描 `skills/` 注入目录 |
| 技能注册表 | 无 | `SKILL_REGISTRY`（启动时填充，防路径注入） |
| 循环 | 不变 | 不变 |

---

## 试一下

```sh
cd learn-claude-code
python s07_skill_loading/code.py
```

1. `What skills are available?`：模型直接报出四个技能，注意终端上没有出现任何 `[HOOK]` 行。零工具调用，因为目录本来就在 SYSTEM 里；
2. `Without loading anything, tell me the exact review steps the code-review skill prescribes`：它答不准，只能围绕那句描述猜。目录层的信息就只有一句话，这是设计出来的边界；
3. `Load the code-review skill and use it to review s02_tool_use/code.py`：这次 `[HOOK] load_skill` 出现了，之后的审查会按 SKILL.md 里的结构展开。对比实验 2，就是"目录常驻、内容按需"的两级差距。

---

## 接下来

现在盘点一下 `messages` 里都住着谁：工具结果、文件内容、命令输出，这一课又搬进来整份整份的技能文档。它们只进不出，任务一长，某一次调用就会撞上那个报错：`prompt_too_long`。

s08 Context Compact → 四步整理管线。便宜的先跑，贵的后跑；能整理就不总结。

<!-- translation-sync: zh@v4, en@v4, ja@v4 -->
