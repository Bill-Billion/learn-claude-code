# s13: Background Tasks — 慢操作放后台

[中文](README.zh.md) · [English](README.md) · [日本語](README.ja.md)

s01 → ... → s11 → s12 → `s13` → [s14](../s14_cron_scheduler/) → s15 → ... → s20

> *"慢操作丢后台, agent 继续处理"* — 后台线程跑命令, 完成后注入通知。
>
> **Harness 层**: 后台 — 异步执行, 不阻塞主循环。

---

从 s01 到现在，`run_bash` 里一直藏着一行没发作过的代码：`timeout=120`。命令超过两分钟，直接杀掉。全量测试要跑十分钟？在前面任何一课里，它都到不了终点。

就算把超时调大，问题只是换了个姿势：`subprocess.run` 是阻塞的，命令跑十分钟，Agent 就在那儿站十分钟。不能调模型，不能干别的活，终端一动不动，你也不知道它是在跑还是死了。

你自己不会这么干活。衣服丢进洗衣机，你不会站在旁边盯着滚筒，你去做饭，听到"叮"再回来收。这一课给 Agent 装上同一套流程：慢命令派出去，转身干别的，好了再收结果。

![Background Tasks Overview](images/background-tasks-overview.svg)

---

## 谁进后台：模型说了算，启发式兜底

第一个问题是判定。哪些命令该进后台？

```python
def is_slow_operation(tool_name: str, tool_input: dict) -> bool:
    """兜底启发式：这些关键词的命令大概率超过 30 秒。"""
    if tool_name != "bash":
        return False
    cmd = tool_input.get("command", "").lower()
    slow_keywords = ["install", "build", "test", "deploy", "compile",
                     "docker build", "pip install", "npm install",
                     "cargo build", "pytest", "make"]
    return any(kw in cmd for kw in slow_keywords)

def should_run_background(tool_name: str, tool_input: dict) -> bool:
    if tool_input.get("run_in_background"):   # 模型显式要求，直接进后台
        return True
    return is_slow_operation(tool_name, tool_input)   # 没表态，看启发式
```

判断哪条命令慢，模型比关键词表准得多，所以 `bash` 工具的参数里新增了 `run_in_background`，模型的显式请求优先。启发式只是兜底：模型忘了传参数时，别让一条 `npm install` 把循环卡死。

诚实说一句这套兜底的毛病：关键词匹配必有误判，`echo running tests` 也含 "test"，照样会被丢进后台。而且注意代码的形状：显式 `True` 能压过启发式，显式 `False` 压不过。教学版给了模型单向的否决权，这是个简化，实验里你会亲眼撞见它。

---

## 派发：线程加一本登记簿

```python
background_tasks: dict[str, dict] = {}   # bg_id → {tool_use_id, command, status}
background_results: dict[str, str] = {}  # bg_id → 输出
background_lock = threading.Lock()

def start_background_task(block) -> str:
    global _bg_counter
    _bg_counter += 1
    bg_id = f"bg_{_bg_counter:04d}"

    def worker():
        result = execute_tool(block)          # 在子线程里真正执行
        with background_lock:
            background_tasks[bg_id]["status"] = "completed"
            background_results[bg_id] = result

    with background_lock:
        background_tasks[bg_id] = {"tool_use_id": block.id,
                                   "command": ..., "status": "running"}
    threading.Thread(target=worker, daemon=True).start()
    return bg_id
```

那把 `background_lock` 不是摆设。工作线程在写 `status`，主线程可能同时在遍历、弹出这两个字典，不加锁就是数据竞争：轻则丢一条通知，重则字典结构损坏。规矩很简单，碰这两个字典必须持锁，两个线程都一样。

`daemon=True` 是另一个要知道的边界：主进程退出时，后台线程直接陪葬，没跑完的结果就丢了。教学版接受这一点，生产系统会把后台任务落到独立进程和磁盘上。

---

## 占位凭条：配对规矩不许等

派发解决了"不阻塞"，马上撞上 s01 的老规矩：每个 `tool_use` 必须在下一条 user 消息里有对应的 `tool_result`。可真正的结果还在线程里跑着，本轮拿什么回给 API？

回一张取件凭条：

```python
if should_run_background(block.name, block.input):
    bg_id = start_background_task(block)
    results.append({"type": "tool_result",
                    "tool_use_id": block.id,
                    "content": f"[Background task {bg_id} started] "
                               f"Command: ... Result will be available when complete."})
```

配对规矩当轮满足，模型也拿到了凭条号。它看到"结果稍后可取"，就知道现在该去干别的，而不是原地等待。

---

## 收结果：通知走文本通道，不冒充工具结果

后台跑完了，结果怎么回到对话里？最容易犯的错，是拿着当初那个 `tool_use_id` 再造一条 `tool_result` 塞回去。不行：那个 id 在凭条那轮已经配对完毕，API 对每个 id 只认一次配对，复用直接报错。

所以通知走另一条通道，s01 讲过的那条：`user` 消息是"外部世界的声音"。后台结果就是世界发生的新鲜事，用普通文本块注入，格式是结构化的 XML，模型好认：

```python
notifications.append(
    f"<task_notification>\n"
    f"  <task_id>{bg_id}</task_id>\n"
    f"  <status>completed</status>\n"
    f"  <command>{task['command']}</command>\n"
    f"  <summary>{summary}</summary>\n"
    f"</task_notification>")
```

注入时机在每个工具轮之后：本轮的 `tool_result` 和攒到的后台通知装进同一条 user 消息发回去。这也带来一个教学版的边界：**通知只在工具轮后注入。** 如果模型已经收工、你也不再发需要动工具的请求，做完的后台结果就一直在登记簿里等着。真实系统用常驻的消息队列解决这件事，每轮必消费。

> 真实 Claude Code：没有线程。它跑在 Node.js 单线程事件循环上，"后台"就是不 await，命令输出重定向到文件由进程独立跑；后台任务有七种类型（本地命令、本地/远程 Agent、工作流、监控等）各有生命周期；后台 bash 还配了停滞看门狗，输出 45 秒无增长就检查是不是卡在 `(y/n)` 这类交互式提问上。

---

## 相对 s12 的变更

| 组件 | 之前 (s12) | 之后 (s13) |
|------|-----------|-----------|
| 慢命令 | 阻塞主循环（且 120s 超时杀掉） | 后台线程执行，主循环继续 |
| bash 参数 | `command` | +`run_in_background`（模型显式请求） |
| 新函数 | — | `is_slow_operation`, `should_run_background`, `start_background_task`, `collect_background_results` |
| 结果回传 | 同轮 `tool_result` | 凭条占位 + `<task_notification>` 文本注入 |
| 线程安全 | 不涉及 | `threading.Lock` 保护登记簿 |

---

## 试一下

```sh
cd learn-claude-code
python s13_background_tasks/code.py
```

1. **完整时间线一次看完**：`Run this command: echo running tests`。"test" 关键词触发启发式，一条瞬时命令也被丢进后台。因为它完成得足够快，同一轮里你能看到全套输出：`[background] dispatched`、`[background done]`、`[inject] 1 background notification(s)`。顺便，这就是关键词误判的现场；
2. **真正的并行**：`In the background, run 'sleep 15 && echo finished'. While waiting, write a short poem about waiting to wait.md`。sleep 不在关键词表里，模型会自己传 `run_in_background`。观察派发之后 Agent 立刻去写诗，没有卡住；
3. **通知的时机**：接着实验 2，等十几秒后输入 `Read wait.md`。这个请求带工具轮，`<task_notification>` 会搭这一轮的车进入对话，模型的回答里会提到后台命令完成了。如果你只发一句不需要工具的闲聊，通知就还在登记簿里等，亲眼验证"只在工具轮后注入"这条边界。

---

## 接下来

Agent 不再被长命令卡住了。但所有工作仍然由"你说一句"启动。想让它每天早上九点跑一遍测试、每五分钟看一眼服务状态呢？总不能雇个人定时来敲回车。

s14 Cron Scheduler → 给 Agent 装一个闹钟。

<!-- translation-sync: zh@v2, en@v1, ja@v1 -->
