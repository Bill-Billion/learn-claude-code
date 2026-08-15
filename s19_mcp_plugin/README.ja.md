# s19: MCP Tools — 外部ツールを標準プロトコルで接続する

[中文](README.zh.md) · [English](README.md) · [日本語](README.ja.md)

s01 → ... → s17 → s18 → `s19` → [s20](../s20_comprehensive/)

> *「外部ツールを標準プロトコルで接続する」* — 発見、組み立て、呼び出し。Agent は実装者を知る必要がありません。
>
> **Harness 層**: プラグイン — 外部能力を標準プロトコルで接続します。

---

toolbox を棚卸しすると、bash、ファイル、タスク、チーム、worktree はすべて私たちが `code.py` へ直接書きました。そこへユーザーから「Agent に社内 Jira と独自 deployment platform を調べさせたい」という要求が来ます。

従来の方法なら、s02 の合言葉「1 つ定義し、1 行登録する」がまだ使えそうです。しかし今回は何かがおかしい。Jira のツールをあなたが書き、deployment platform のツールもあなたが書き、次の会社で別のシステムが来たらまた書いてリリースします。ツール作者と Harness 作者が永遠に結び付きますが、世界中のシステムをすべて実装することはできません。

問題は結合の向きです。Harness が個別のツールをすべて知っています。解くには、知ることを 2 つだけにします。ツールをどう発見し、どう呼び出すかです。USB と同じです。機器は各社が作っても、port は 1 つの標準に従います。Agent の世界で、その標準を MCP（Model Context Protocol）と呼びます。

![MCP Architecture](images/mcp-architecture.svg)

---

## 発見: Compile 時に書かず、runtime に尋ねる

MCP server を接続する最初の手順は、ツール登録ではありません。「何を持っているか」と尋ねます。

```python
def connect_mcp(name: str) -> str:
    mcp_client = MOCK_SERVERS[name]()          # 接続を確立
    mcp_clients[name] = mcp_client
    tool_names = [t["name"] for t in mcp_client.tools]   # ツールは発見される
    return (f"Connected to MCP server '{name}'. "
            f"Discovered {len(mcp_client.tools)} tools: {', '.join(tool_names)}")
```

server が自分のツール一覧を報告します。各ツールは名前、説明、parameter schema を持ち、s02 で手書きした `TOOLS` とまったく同じ形です。Harness は Jira がどの interface を持つか事前に知る必要がなく、接続した瞬間に学びます。これが「発見」です。

教材版の server は process 内 mock で、`docs` 文書サービスと `deploy` 配備サービスがあります。実際の MCP は JSON-RPC protocol を使い、stdio または HTTP で別 process と通信します。ただし「接続、発見、呼び出し、結果返却」という形は同じです。教材版は形を残して transport を省いています。

---

## 命名: Prefix が namespace になる

発見したツールをそのまま pool へ入れず、先に改名します。

```python
def normalize_mcp_name(name: str) -> str:
    return _DISALLOWED_CHARS.sub('_', name)    # [a-zA-Z0-9_-] 以外をすべて underscore へ

prefixed = f"mcp__{safe_server}__{safe_tool}"  # mcp__docs__search
```

prefix が衝突を防ぎます。`docs` と `deploy` の両 server に `status` というツールがあっても、`mcp__{server}__` を付ければ別物になり、built-in の `bash` とも衝突しません。normalize は検査の考え方が 4 度目に登場したものです。s02 は path、s07 は skill 名、s18 は worktree 名を守りました。server が報告する名前も外部入力であり、奇妙な文字を含むと API が request 全体を拒否します。

---

## 組み立て: Built-in と外部ツールを同じ pool へ入れる

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

組み立て後の pool は、モデルから見ると「built-in」と「外部」に分かれていません。`mcp__docs__search` と `read_file` は、どちらも名前と schema で同じ形です。s02 の dispatch 機構がそのまま動きます。最初に table-driven dispatch を選んだ複利です。

handler の lambda には、名前を挙げる価値のある古い Python の罠があります。直感的な `lambda **kw: mcp_client.call_tool(tool_def["name"], kw)` では loop variable を closure が参照します。loop 終了後、すべての handler が**最後の**ツールを指し、`search` を呼ぶと `get_version` が実行されます。default argument の `c=mcp_client, t=tool_def["name"]` は定義時点の値を固定し、handler ごとに別々の binding を与えます。この罠は late binding と呼ばれ、loop 内で closure を作るたびに確認が必要です。

組み立ては 1 回だけではありません。`agent_loop` は各 tool round の後に pool を組み直します。モデルが今のラウンドで `connect_mcp` を呼べば、次のラウンドには新ツールがあります。代償も明確にしましょう。tool list が変わると request の `tools` parameter が変わり、s08 の選択項目で触れた prompt cache prefix は無効になります。s10 の比較で、実システムの唯一の volatile segment が `mcp_instructions` だと説明しましたが、理由はここにあります。MCP は tool pool で唯一 runtime に変化する部分です。

---

## Annotation: 外部ツールによる自己申告

mock server の tool definition を見ると、`search` は `{"readOnlyHint": true, "destructiveHint": false}`、`deploy.trigger` は反対の値を持ちます。description に文字を付け足したものではなく、構造化された annotation です。built-in tool の読み書きは実装者が分かりますが、外部 tool は意図した動作を server が申告するしかありません。

`assemble_tool_pool()` は prefix 付き tool name を key にして、annotation を `MCP_TOOL_ANNOTATIONS` へ保存します。これは host metadata であり、description へ押し込まず、モデル向け tool schema にも混ぜません。s19 は情報を保つところまでで、permission policy はまだ適用しません。s20 の `PreToolUse` gate が dispatch 前に利用します。

もう一つ境界があります。annotation は server の自己申告であり、server は嘘をつけます。MCP では authorization ではなく hint として定義されています。外部 server を接続する実装では、server trust と local policy を重ねなければなりません。本章で接続できるのはコードに明示登録した in-process mock だけですが、それでも `readOnlyHint=true` を安全性の証明として教えないよう、この境界を残します。

---

## s18 からの変更点

| コンポーネント | 変更前 (s18) | 変更後 (s19) |
|------|-----------|-----------|
| ツール source | すべて built-in、compile 時に確定 | built-in + MCP 発見、runtime に変化 |
| 新しい型 | — | `MCPClient`（発見 + 呼び出し） |
| 新しい関数 | — | `connect_mcp`, `assemble_tool_pool`, `normalize_mcp_name` |
| 命名 | prefix なし | MCP ツールに `mcp__{server}__{tool}` prefix |
| tool pool | static `TOOLS` | 各 tool round 後に再組み立て |
| annotation | なし | prefix 付き tool name を key にした構造化 host metadata |

---

## 試してみる

```sh
cd learn-claude-code
python s19_mcp_plugin/code.py
```

1. **発見の瞬間**: `Connect to the docs MCP server, then list what tools you have now.` 接続ログ `[mcp] connected: docs → ['search', 'get_version']` の後、モデル自身が `mcp__docs__search` などの新しい名前を挙げられます。pool に入った証拠です。
2. **同じ pool から呼ぶ**: `Search the docs for "authentication" and also read README.md`。1 ラウンドで外部ツールと built-in ツールを混ぜて呼んでも、モデルには違いがありません。
3. **存在しない server へ接続**: `Connect to the jira MCP server`。`Unknown server 'jira'. Available: docs, deploy` が返り、エラーに利用可能な一覧があるため、モデルは自分で修正できます。
4. **Annotation が保たれるか**: `Connect to deploy and check the status of service 'web'`、続いて `Trigger a deployment of 'web'` を試します。s19 は permission gate をまだ接続していないため、どちらも実行できます。違いは `MCP_TOOL_ANNOTATIONS` に残り、s20 が tool name から危険度を推測せず dispatch 前に読みます。

---

## 次へ

MCP がつながり、toolbox の最後の piece がそろいました。19 章を振り返ると、各章は 1 つの仕組みだけを追加した独立 demo です。しかし実際の Agent は 19 個の demo ではなく、1 つの process です。compaction、memory、permission、team、scheduling が同じ loop の周囲で同時に動きます。

s20 Comprehensive Agent → 最初の 19 章を 1 つの完全な Harness へ統合します。仕組みは多数、loop は 1 つです。

<!-- translation-sync: zh@v3, en@v3, ja@v3 -->
