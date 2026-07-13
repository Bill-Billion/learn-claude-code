# s19: MCP Tools — 外接工具，标准协议

[中文](README.zh.md) · [English](README.md) · [日本語](README.ja.md)

s01 → ... → s17 → s18 → `s19` → [s20](../s20_comprehensive/)

> *"外接工具, 标准协议"* — 发现、组装、调用，Agent 不需要知道工具是谁写的。
>
> **Harness 层**: 插件 — 外部能力通过标准协议接入。

---

盘点一下工具箱：bash、文件、任务、团队、工位，全是我们亲手写进 `code.py` 的。现在用户来了需求："让 Agent 能查我们公司的 Jira，还有我们自建的部署平台。"

照老办法，s02 的口号还管用：定义一条，注册一行。可这次不对劲了。Jira 的工具得你写，部署平台的工具也得你写，下一家公司换一套系统，再写一遍、再发一版。工具的作者和 harness 的作者从此绑死，而世界上的系统是写不完的。

问题出在耦合方式上：harness 认识每一个具体工具。要解开，就得让它只认识一件事——怎么发现工具、怎么调用工具。像 USB：设备各造各的，插口只有一个标准。这个标准在 Agent 世界里叫 MCP（Model Context Protocol）。

![MCP Architecture](images/mcp-architecture.svg)

---

## 发现：运行时问出来，不是编译时写进去

接入一个 MCP server 的第一步不是注册工具，是问它"你有什么"：

```python
def connect_mcp(name: str) -> str:
    mcp_client = MOCK_SERVERS[name]()          # 建立连接
    mcp_clients[name] = mcp_client
    tool_names = [t["name"] for t in mcp_client.tools]   # 工具是"发现"出来的
    return (f"Connected to MCP server '{name}'. "
            f"Discovered {len(mcp_client.tools)} tools: {', '.join(tool_names)}")
```

server 自己报上工具清单，每个工具带名字、描述、参数 schema，格式和我们 s02 手写的 `TOOLS` 完全同构。harness 不需要预先知道 Jira 有哪些接口，连上那一刻才知道，这就是"发现"。

教学版的 server 是进程内的 mock（一个 `docs` 文档服务、一个 `deploy` 部署服务），真实的 MCP 是 JSON-RPC 协议，走 stdio 或 HTTP 跟独立进程通信。但"连接、发现、调用、回结果"这个形状是一样的，教学版保形状去管道。

---

## 命名：前缀就是命名空间

发现来的工具不能直接倒进工具池，先要改名：

```python
def normalize_mcp_name(name: str) -> str:
    return _DISALLOWED_CHARS.sub('_', name)    # 非 [a-zA-Z0-9_-] 一律换下划线

prefixed = f"mcp__{safe_server}__{safe_tool}"  # mcp__docs__search
```

前缀解决冲突：`docs` 和 `deploy` 两个 server 都可以有叫 `status` 的工具，加上 `mcp__{server}__` 之后互不相干，也永远撞不上内置的 `bash`。normalize 是安检哲学的第四次登场（s02 拦路径、s07 拦技能名、s18 拦工位名）：server 报上来的名字是外部输入，带怪字符的名字直接会让 API 拒绝整个请求。

---

## 装配：内置和外接倒进同一个池子

```python
def assemble_tool_pool() -> tuple[list[dict], dict]:
    tools = list(BUILTIN_TOOLS)
    handlers = dict(BUILTIN_HANDLERS)
    for server_name, mcp_client in mcp_clients.items():
        for tool_def in mcp_client.tools:
            prefixed = f"mcp__{normalize_mcp_name(server_name)}__{normalize_mcp_name(tool_def['name'])}"
            tools.append({"name": prefixed,
                          "description": tool_def.get("description", ""),
                          "input_schema": tool_def.get("inputSchema", {})})
            handlers[prefixed] = (
                lambda *, c=mcp_client, t=tool_def["name"], **kw: c.call_tool(t, kw))
    return tools, handlers
```

对模型来说，装配完的池子里没有"内置"和"外接"之分，`mcp__docs__search` 和 `read_file` 长得一模一样，都是名字加 schema。s02 的分发机制原样生效，这正是当初"查表分发"设计的复利。

那行 handler 的 lambda 里藏着一个 Python 老陷阱，值得点名。如果写成直觉的 `lambda **kw: mcp_client.call_tool(tool_def["name"], kw)`，闭包引用的是循环变量，循环跑完后所有 handler 都指向**最后一个**工具，你调 `search` 它执行 `get_version`。用默认参数 `c=mcp_client, t=tool_def["name"]` 在定义时刻把值固化下来，才是每个 handler 各绑各的。这个坑叫晚绑定，凡在循环里造闭包都要过一遍脑子。

装配不是一锤子买卖。`agent_loop` 每个工具轮之后重新装配一次，模型这一轮刚 `connect_mcp`，下一轮新工具就在池子里了。代价也要说破：工具列表变了，请求里的 `tools` 参数就变了，s08 选学讲过的 prompt cache 前缀随之失效。s10 的对照行说过真实系统里唯一的易失段是 `mcp_instructions`，原因就在这里：MCP 是工具池里唯一运行时可变的部分。

---

## 注解：外部工具的自我申报

看 mock server 的工具描述：`search` 标着 `(readOnly)`，`deploy.trigger` 标着 `(destructive)`。这是给权限系统的接口：内置工具读写与否我们自己清楚，外接工具只能靠它申报。

必须诚实一层：注解是 server 说的，server 可以撒谎。一个恶意 server 把删库工具标成 readOnly，教学版会照单全信。所以真实系统对注解的用法是保守方向的：readOnly 只能换来"少打扰"，destructive 必然触发审批，申报无法让一个危险工具跳过 s03 那道门。信任边界画在协议上，不画在对方的自觉上。

> 真实 Claude Code：支持六种传输（stdio、HTTP、SSE 等），带 OAuth 认证、服务器反向推送通知、多来源配置合并；MCP 工具的 readOnly/destructive 注解真正接入权限管线，destructive 默认要求用户批准。教学版的 mock 保留了发现、命名、装配、注解四个关键环节。

---

## 相对 s18 的变更

| 组件 | 之前 (s18) | 之后 (s19) |
|------|-----------|-----------|
| 工具来源 | 全部内置，编译时确定 | 内置 + MCP 发现，运行时可变 |
| 新类型 | — | `MCPClient`（发现 + 调用） |
| 新函数 | — | `connect_mcp`, `assemble_tool_pool`, `normalize_mcp_name` |
| 命名 | 裸名 | MCP 工具带 `mcp__{server}__{tool}` 前缀 |
| 工具池 | 静态 `TOOLS` | 每个工具轮后重新装配 |

---

## 试一下

```sh
cd learn-claude-code
python s19_mcp_plugin/code.py
```

1. **发现的瞬间**：`Connect to the docs MCP server, then list what tools you have now.`。连接日志 `[mcp] connected: docs → ['search', 'get_version']` 之后，模型自己就能报出 `mcp__docs__search` 这些新名字，它们进池子了；
2. **同池调用**：`Search the docs for "authentication" and also read README.md`。一轮里外接工具和内置工具混着调，对模型来说没有任何区别；
3. **连接不存在的 server**：`Connect to the jira MCP server`。返回 `Unknown server 'jira'. Available: docs, deploy`，报错里带着可用清单，模型看了自己纠正；
4. **注解的观感**：`Connect to deploy and check the status of service 'web'`，再试 `Trigger a deployment of 'web'`。两个工具都能跑通（教学版没接权限门），但描述里的 `(readOnly)` 和 `(destructive)` 已经写在那里。回想 s03：如果要给外接工具上三道闸门，判断依据就是这些注解。

---

## 接下来

MCP 接上，工具箱的最后一块拼图归位。回望这十九课，每课只加一个机制，代码都是各章独立的 demo。可真实的 Agent 不是十九个 demo，是一个进程：压缩、记忆、权限、团队、调度，全部挂在同一个循环上同时运转。

s20 Comprehensive Agent → 把前十九章合回一个完整的 harness。机制很多，循环一个。

<!-- translation-sync: zh@v3, en@v3, ja@v3 -->
