# s15: Agent Teams — 一个搞不定，组队来

[中文](README.zh.md) · [English](README.md) · [日本語](README.ja.md)

s01 → ... → s13 → s14 → `s15` → [s16](../s16_team_protocols/) → s17 → s18 → s19 → s20
> *"一个搞不定, 组队来"* — 文件收件箱 + 队友线程。
>
> **Harness 层**: 团队 — 多 Agent 协作, 消息总线。

---

"重构整个后端"这种活，摊开是四摊：认证模块、数据库层、API 路由、测试。单个 Agent 串着干，修到 API 路由时，认证模块的细节早被挤出上下文了。

s06 的子 Agent 能分摊吗？差一口气。`spawn_subagent` 是阻塞调用：派一个出去，主 Agent 就站在原地等它回来，四摊活还是排队干。而且子 Agent 的通信通道只有一个返回值，干完才说一句话，中途发现"数据库表结构和任务描述对不上"，它没有渠道回来问。

真正需要的是同事，不是临时工。同事之间的两个特征，恰好是子 Agent 没有的：**同时干活**，**随时捎话**。同时干活 s13 已经给了答案（线程），随时捎话是这一课的主角。

![Agent Teams Overview](images/agent-teams-overview.svg)

---

## 同事之间不 return，同事之间发消息

函数调用的通信模型是"一问一答一次性"：调用方等着，被调方返回，通道关闭。团队协作要的是另一种模型：每人一个信箱，谁想说话就投一封，收件人有空了自己看。

`MessageBus` 就是这个信箱系统，实现朴素到可以直接看穿：

```python
class MessageBus:
    def send(self, from_agent, to_agent, content, msg_type="message"):
        msg = {"from": from_agent, "to": to_agent,
               "content": content, "type": msg_type, "ts": time.time()}
        inbox = MAILBOX_DIR / f"{to_agent}.jsonl"
        with open(inbox, "a") as f:                  # 发信 = 往对方文件追加一行
            f.write(json.dumps(msg) + "\n")

    def read_inbox(self, agent) -> list[dict]:
        inbox = MAILBOX_DIR / f"{agent}.jsonl"
        if not inbox.exists():
            return []
        msgs = [json.loads(line) for line in inbox.read_text().splitlines() if line.strip()]
        inbox.unlink()                               # 收信 = 读完即删（消费式）
        return msgs

    def peek(self, agent) -> bool:
        inbox = MAILBOX_DIR / f"{agent}.jsonl"
        return inbox.exists() and inbox.stat().st_size > 0   # 只看有没有，不动内容
```

为什么用文件而不是内存队列？两个理由。观察性：`.mailboxes/` 目录就摆在那里，任何时刻 `cat` 一眼就知道谁在跟谁说什么，调试多 Agent 系统时这比日志好用得多。扩展性：文件天然跨进程，今天的队友是线程，明天换成独立进程甚至另一台机器，信箱不用改。

两个边界要交代清楚。读是消费式的，读完文件就删了，拿到的消息必须当场处理，弄丢了没有第二份。以及教学版没加文件锁，两个写者在极端时序下可能把行写串，真实的 Claude Code 用 `proper-lockfile` 保护每次追加。

---

## 队友：还是那个循环，多了名字和信箱

老规律第三次应验：teammate 和 s06 的子 Agent 一样，就是 s01 循环的又一份拷贝，区别只在配置。它有名字和角色（写进自己的 system 提示）、有自己的信箱、每轮开工前先查信：

```python
def spawn_teammate_thread(name: str, role: str, prompt: str) -> str:
    system = (f"You are '{name}', a {role}. "
              f"Use tools to complete tasks. Send results via send_message to 'lead'.")

    def run():
        messages = [{"role": "user", "content": prompt}]
        for _ in range(10):                          # 教学版：10 轮封顶
            inbox = BUS.read_inbox(name)             # 每轮先查信箱
            if inbox:
                messages.append({"role": "user",
                                 "content": f"<inbox>{json.dumps(inbox)}</inbox>"})
            response = client.messages.create(
                model=MODEL, system=system, messages=messages[-20:],   # 滑动窗口
                tools=sub_tools, max_tokens=8000)
            ...
        BUS.send(name, "lead", summary, "result")    # 收工前把总结寄给 lead
        active_teammates.pop(name, None)             # 从花名册注销自己

    threading.Thread(target=run, daemon=True).start()
```

工具集照旧收窄：`bash`/`read_file`/`write_file`/`send_message`，没有 `spawn_teammate`，队友不能再拉人头，s06 防递归的老规矩。上下文管理用 `messages[-20:]` 滑动窗口而不是 s08 的压缩管线，理由是队友短命（10 轮封顶），最近 20 条足够覆盖一生，犯不上为它跑四步整理。

Lead 这边添三个工具：`spawn_teammate` 拉人，`send_message` 捎话，`check_inbox` 查信。

---

## Lead 的终端：从一问一答变成事件循环

前十四课的主程序都是同一个形状：`input()` 等你说话，跑一轮，再等。现在不行了，队友的报告随时可能到，不能指望你恰好在那时敲回车。

主程序改成事件循环：两个来源（你的输入、后台的动静）汇进同一个队列，谁来了处理谁：

```python
def inbox_poller():
    while True:
        time.sleep(1)
        if BUS.peek("lead") or has_pending_background():
            events.put(("wake", None))       # 有信或后台完工：请求唤醒一轮

while True:
    kind, payload = events.get()
    if kind == "user":
        history.append({"role": "user", "content": payload})
    else:  # wake
        inbox = BUS.read_inbox("lead")
        ...
        if not parts:
            continue                          # 已被上一次 wake 掏空，跳过
        history.append({"role": "user", "content": "\n".join(parts)})
    agent_loop(history, context)
```

两处防御各对应一种真实的翻车。

**wake 必须幂等。** 轮询每秒一次，队友的信到达后可能排进两个 wake 事件；第一个把信箱掏空了，第二个必须发现"没东西"然后跳过。少了这个 `continue`，每封信都会附赠一轮空转的 API 调用。

**轮询不看花名册。** 直觉写法是"还有活着的队友才去查信"。但队友的退场顺序是先寄出最后的总结、再注销自己，两步之间没有原子性。按花名册把关，恰好在注销之后到达的最后一封信就永远没人收了。所以 poller 只认信箱本身：有信就唤醒，别管寄信人还在不在。

> 真实 Claude Code：teammate 不是 10 轮封顶，而是 idle loop——干完活在信箱边待命，直到收到 `shutdown_request` 才退场；信箱写入有文件锁；团队还有自己的 hook 事件（TeammateIdle、TaskCompleted），供外部系统挂载。

---

## 相对 s14 的变更

| 组件 | 之前 (s14) | 之后 (s15) |
|------|-----------|-----------|
| Agent 数量 | 1 | 1 个 Lead + N 个队友线程 |
| 通信 | 无 | `MessageBus` 文件信箱（`.mailboxes/*.jsonl`） |
| 新工具 | — | `spawn_teammate`, `send_message`, `check_inbox`（共 14 个） |
| 主程序 | `input()` 一问一答 | 事件循环（用户输入 + 唤醒事件合流） |
| 队友生命周期 | — | 10 轮封顶，收工自动寄总结、注销 |

---

## 试一下

```sh
cd learn-claude-code
python s15_agent_teams/code.py
```

1. **并行与自动唤醒**：`Spawn two teammates: 'poet' (a poet) who writes a short poem to poem.md, and 'critic' (a critic) who reviews the first paragraph of README.md. Wait for both reports.`。看 `[teammate] poet spawned`、`[teammate] critic spawned` 几乎同时出现，两边的 `[bus]` 消息交错滚动；报告寄回时，你没敲任何字，终端自己打出 `[wake: N inbox ...]` 并开始新一轮，最后是 `[all teammates done]`；
2. **看见通信本身**：给队友派个慢活，比如 `Spawn a teammate 'worker' who runs 'sleep 15' and then writes done.md`，趁它干活时对 Lead 说 `Run ls -la .mailboxes/`。信箱文件就躺在那里，这套协作的全部基础设施不过是几个 JSONL 文件；
3. **消费式读取**：全部结束后输入 `Check your inbox`，大概率得到 `(inbox empty)`。不是消息丢了，是唤醒机制早一步把信取走注入对话了。读完即删的信箱只有一份拷贝，谁先取归谁，这个手感值得记住。

---

## 接下来

队友能干活、能通信，但都是"自由发挥"式的：说的话没有格式，Lead 想让某个队友停下来，也只能干瞪眼。直接杀线程？它可能正写文件写到一半。

s16 Team Protocols → 给消息加上类型和编号，关机要握手，请求要回执。

<!-- translation-sync: zh@v2, en@v2, ja@v2 -->
