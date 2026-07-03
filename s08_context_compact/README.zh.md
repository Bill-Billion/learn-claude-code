# s08: Context Compact — 上下文总会满，先整理，再总结

[中文](README.zh.md) · [English](README.md) · [日本語](README.ja.md)

s01 → s02 → s03 → s04 → s05 → s06 → s07 → `s08` → [s09](../s09_memory/) → s10 → ... → s20

---

Agent 在做长任务时，读一个文件，可能就是几千 token；跑一次测试，日志又是一大段。文件内容、命令输出、工具结果都会被塞回 `messages`，越堆越多。

上下文越多，模型的注意力越分散；等到真正装满，请求会直接失败：`prompt_too_long`。

所以 s08 要解决一件事：

> 让 Agent 在长任务里能一直工作下去。

![Context Compact 全景](images/compact-overview.svg)

---

## 不要一上来就总结历史对话

最直觉的办法，是让模型把历史总结一下。

但这不该是第一步。

很多内容并不需要总结，比如旧日志、旧文件内容、已经用过的工具结果。它们只是占地方，不一定还重要。对这些内容，更合适的做法是先整理：能存到磁盘的先存到磁盘，能用占位符代替的先用占位符，能裁掉的先裁掉。

这些都做完，上下文还是快要超限，才让模型生成摘要。

原因也很简单：前三步基本可恢复，摘要是有损的。摘要一旦替换历史，细节就不在当前上下文里了。

---

## 整体流程

每次调用模型前，先整理一次 `messages`：

```python
messages = tool_result_budget(messages)  # 大结果先存起来
messages = snip_compact(messages)        # 中间旧对话裁掉
messages = micro_compact(messages)       # 较早工具结果换成占位符

if estimate_size(messages) > CONTEXT_LIMIT:
    messages = compact_history(messages) # 还不够，才摘要
```

![四步压缩管线](images/compaction-layers.svg)

> 这个顺序不能随意调换。
>
> 尤其是 `tool_result_budget` 必须在 `micro_compact` 前面。因为 `micro_compact` 会把旧工具结果替换成占位符。如果它先跑，后面就拿不到完整内容，也就没法把大结果存起来。

---

## 第一步：tool_result_budget — 大结果先暂存

有时不是历史太长，而是单条工具结果太大。

比如 Agent 一次读了几个大文件，最后一条 `tool_result` 就可能超过 200KB。这个结果是最新的，不能简单丢掉；但它也不应该完整塞在上下文里。

做法是：把完整内容写到磁盘，上下文里只留下路径和一小段预览。

![大结果先暂存](images/layer1-budget.svg)

```python
def tool_result_budget(messages, max_bytes=200_000):
    blocks = [b for b in messages[-1]["content"] if b.get("type") == "tool_result"]
    total = sum(len(str(b["content"])) for b in blocks)

    if total <= max_bytes:
        return messages

    for block in sorted(blocks, key=lambda b: len(str(b["content"])), reverse=True):
        block["content"] = persist_large_output(block["tool_use_id"], str(block["content"]))
        total = sum(len(str(b["content"])) for b in blocks)
        if total <= max_bytes:
            break

    return messages
```

这一步不丢内容，只是把内容从"当前上下文"挪到磁盘。

模型还能看到：这段内容已经保存在哪里、开头大概是什么样。后面真需要完整内容，再读回来即可。

---

## 第二步：snip_compact — 裁减旧对话

消息太多时，可以保留开头和结尾。

开头通常有原始任务和约束，结尾是当前正在做的事。中间那段旧历史，可以换成一条说明。

```python
def snip_compact(messages, max_messages=50):
    if len(messages) <= max_messages:
        return messages

    head = safe_head(messages, 3)
    tail = safe_tail(messages, max_messages - 3)
    snipped = len(messages) - len(head) - len(tail)

    return head + [
        {"role": "user", "content": f"[snipped {snipped} messages]"}
    ] + tail
```

这里需要注意：不能把 `assistant` 的 `tool_use` 和对应的 `tool_result` 拆开。否则模型会看到一条来历不明的工具结果，API 会直接报错。

所以 `safe_head` 和 `safe_tail` 都不是简单切片，它们会避开这种断点（实现见 `code.py`）。

这一步减少的是消息数量。

但它不处理单条消息里的大内容。如果某条旧 `tool_result` 里还有几十 KB 的文件内容，它仍然会占上下文。

所以还要继续整理工具结果。

---

## 第三步：micro_compact — 较早的工具结果换成占位符

工具结果往往比对话更占地方。

Agent 连续读了十个文件，前几个文件的完整内容通常已经不需要一直放在上下文里。保留最近几条就够了。更早的结果，如果之后真的有用，可以重新读取。

![旧结果换占位符](images/micro-compact.svg)

```python
KEEP_RECENT = 3

def micro_compact(messages):
    results = collect_tool_results(messages)

    for _, _, block in results[:-KEEP_RECENT]:
        if len(block.get("content", "")) > 120:
            block["content"] = "[Earlier tool result compacted. Re-run if needed.]"

    return messages
```

这一步不会总结内容，只是把较早的完整结果换成一句说明。

它适合处理"工具结果很多"的情况，但处理不了"整理完还是太大"的情况。到这里如果上下文仍然超限，就只能让模型生成摘要。

---

## 第四步：compact_history — 整理后仍超限，再生成摘要

前三步都做完，如果上下文还是太大，才让模型摘要历史。

这一步分三件事：

先把完整对话写到磁盘。
再让模型生成摘要。
最后用摘要替换旧历史。

![LLM 全量摘要](images/auto-compact.svg)

```python
def compact_history(messages):
    transcript_path = write_transcript(messages)  # ① 完整对话先写到磁盘
    summary = summarize_history(messages)         # ② 生成摘要
    return [{
        "role": "user",
        "content": f"[Compacted]\n\n{summary}",   # ③ 用摘要替换旧历史
    }]
```

摘要要求保留五类信息：当前目标、用户约束、重要发现、已修改文件、下一步工作。

这一步最有效，也最具风险。

虽然完整历史还在磁盘里，但是模型当前只能看到摘要。摘要中没有写进去的细节，对之后的每一轮来说就等于暂时看不见了。

所以摘要一定要放在最后。

---

## 报错后的补救整理

正常情况下，调用模型前就会把上下文整理好。

但 token 估算可能不准，或者某一轮工具输出突然变得很大，接口仍然可能返回 `prompt_too_long`。这时再做一次更激进的整理：保存完整记录，把前面大部分历史压成摘要，只保留最后几条消息。

```python
def reactive_compact(messages):
    write_transcript(messages)
    tail = safe_tail(messages, 5)   # 尾部切片，同样避开断点
    summary = summarize_history(messages[:len(messages) - len(tail)])

    return [{
        "role": "user",
        "content": f"[Reactive compact]\n\n{summary}",
    }] + tail
```

这不是常规路径。

它只在已经报错时使用，而且只重试有限次数（教学版是 1 次）。否则一旦摘要也失败，就可能陷入反复重试。

---

## 放回 Agent Loop

整理逻辑最终要接回 Agent Loop。

```python
def agent_loop(messages):
    reactive_retries = 0
    while True:
        messages[:] = tool_result_budget(messages)
        messages[:] = snip_compact(messages)
        messages[:] = micro_compact(messages)

        if estimate_size(messages) > CONTEXT_LIMIT:
            messages[:] = compact_history(messages)

        try:
            response = client.messages.create(
                model=MODEL, system=SYSTEM,
                messages=messages, tools=TOOLS, max_tokens=8000)
        except Exception as e:
            if "prompt_too_long" in str(e).lower() and reactive_retries < MAX_REACTIVE_RETRIES:
                messages[:] = reactive_compact(messages)
                reactive_retries += 1
                continue
            raise

        # ... 执行工具，把结果塞回 messages ...
```

这里最重要的是顺序：

```text
大结果先存 → 中间旧对话裁掉 → 较早工具结果占位 → 仍然超限，再生成摘要
```

前三步都不需要模型参与，主要是在整理空间。第四步才是真的改写历史，所以必须放到最后。

---

## compact 工具：让模型自己提出整理

除了自动整理，也可以给模型一个 `compact` 工具。

当模型发现上下文太长，或者任务已经进入新阶段时，可以主动调用这个工具。调用后，程序执行 `compact_history`，结束当前轮，再用整理后的上下文开始下一轮。

这样，整理不只由程序自动触发，也可以由模型在合适的时候主动提出。

---

## 相对 s07 的变化

| 组件       | s07              | s08                    |
| ---------- | ---------------- | ---------------------- |
| 上下文管理 | 无               | 每轮调用前先整理       |
| 工具结果   | 一直留在上下文里 | 大结果转存，旧结果占位 |
| 历史消息   | 一直累积         | 中间旧历史可省略       |
| 超限处理   | 直接失败         | 先整理，不够再摘要     |
| 新增工具   | 无               | `compact`              |

s07 让 Agent 更会做事。
s08 让 Agent 在长任务里不被自己的历史拖垮。

---

## 试一下

```bash
cd learn-claude-code
python s08_context_compact/code.py
```

可以试这几个任务：

```text
Read README.md, then read code.py, then read s01_agent_loop/README.md
```

观察较早的工具结果是否被换成占位符。

```text
Read every file in s08_context_compact/
```

观察大输出是否被转存到磁盘。

```text
Keep discussing and editing for more than 20 turns
```

观察上下文接近上限时，是否触发摘要。

---

## 小结

Context Compact 的核心原则只有一句：

> 能整理就先整理，能恢复就别摘要；实在不够，再让模型总结历史对话。

s08 让长任务可以继续。
s09 要解决下一个问题：哪些信息值得长期留下来。

<!-- translation-sync: zh@v5, en@v5, ja@v5 -->
