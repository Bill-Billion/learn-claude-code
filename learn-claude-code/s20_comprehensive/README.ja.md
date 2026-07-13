# s20: Comprehensive Agent — すべての仕組みを 1 つのループへ

[中文](README.zh.md) · [English](README.md) · [日本語](README.ja.md)

s01 → ... → s18 → s19 → `s20`

> *「仕組みは多数、ループは 1 つ」* — ツール、permission、memory、task、team、plugin のすべてを同じ `while True` に接続します。
>
> **Harness 層**: 統合 — 最初の 19 章の仕組みを 1 つの実行可能なシステムへ戻します。

---

19 章を経て、手元には 19 個の部品があり、それぞれ単独では動きます。しかし実際の Agent は 19 個の demo ではなく 1 つの process です。compaction は memory 抽出へ先を譲り、permission は dispatch 前に止め、cron はユーザーが会話中の turn に割り込んではいけません。部品が正しくても組み立て順を誤れば、機械は壊れます。

この章は新しい仕組みを発明しません。1 つの問いだけに答えます。**各部品を loop のどこへ接続し、なぜそこに置くのでしょうか。**

![System Architecture](images/system-architecture.svg)

図全体をテキストにすると次のようになります。

```text
ユーザー入力
  → UserPromptSubmit hooks
  → cron/background 通知を注入
  → context compact
  → memory + skills + MCP state から system prompt を組み立て
  → LLM
  → tool_use block があるか？
      いいえ → Stop hooks → return
      はい   → PreToolUse hooks + permission
             → TOOL_HANDLERS / MCP handlers / background dispatch
             → PostToolUse hooks
             → tool_result / task_notification を messages へ戻す
             → 次のラウンド
```

loop 自体は s01 の 5 段階のままです。モデルを呼び、ツールを求めたか確認し、実行し、結果を返し、繰り返します。完成したのは loop の周囲すべてです。

> 実際の Claude Code は「ツールを求めたか」の判定にさえ `stop_reason` を信用せず、content に `tool_use` block があるか調べます。s01 で説明した streaming 時の事情が理由です。教材版は最終章でも `stop_reason` を使い続けますが、non-streaming では十分に正確です。

---

## Loop 内でのコンポーネントの位置

| 位置 | コンポーネント | 役割 |
|------|------|------|
| ユーザー入力の前後 | `UserPromptSubmit` hooks | ユーザー入力の記録、注入、audit |
| LLM 前 | cron queue | 定時トリガーの prompt を `messages` へ注入 |
| LLM 前 | background notifications | バックグラウンド完了後に `<task_notification>` として注入 |
| LLM 前 | compaction pipeline | 大きな結果を保存し、履歴を裁ち、古い結果を置換し、必要なら要約 |
| LLM 前 | memory / skills / MCP state | system prompt を組み立て、現在の能力と長期 context をモデルへ見せる |
| LLM 呼び出し | error recovery | 429/529 で backoff、`max_tokens` を増やし、overflow で reactive compact |
| ツール実行前 | `PreToolUse` hooks + permission | 危険な command、範囲外 write、destructive MCP tool を止める |
| ツール dispatch | `assemble_tool_pool` | built-in + dynamic MCP tool を毎ラウンド再構成 |
| ツール実行中 | background dispatch | 遅い処理を daemon thread へ送り、main loop は引換券を持って先へ進む |
| ツール実行後 | `PostToolUse` hooks | 大きな出力の警告、log などの後処理 |
| loop へ戻る | tool_result | すべての `tool_use` に 1 つの `tool_result` を対応させ、次のラウンドへ |
| 停止時 | `Stop` hooks | 統計と cleanup。non-None の戻り値で終了を拒否可能 |

---

## 組み立て順は自由ではない

各章の強い制約は、1 台の機械へ載せると組み立て規則になります。個別の失敗方法は各章で説明したため、ここでは 1 つの一覧へまとめます。

| 規則 | 逆に組むとどうなるか | 出典 |
|------|------------|------|
| `tool_result_budget` を `micro_compact` より先に実行 | 大きな結果が保存前に placeholder へ変わり、永遠に失われる | s08 |
| memory 抽出には compaction 前の snapshot を使う | 裁かれた履歴から復元しようとしても、重要な preference は placeholder になっている | s09 |
| permission check を tool dispatch より先に実行 | command はすでに実行済みで、interception が事後報告になる | s03/s04 |
| 拒否や block にも `tool_result` を返す | pairing が壊れ、API が 400 を返す | s01/s03 |
| background notification は `tool_use_id` を再利用しない | ID は pairing 済みで再利用は失敗する。通知は user text を使う | s13 |
| cron turn と user turn は同じ `agent_lock` を使う | 2 turn が同じ履歴へ同時に書き、message が交錯する | s14 |
| mailbox 消費を単一入口へ集約し、先に route する | protocol response が登録されずに消え、request が永遠に pending になる | s16 |
| 破壊前に検証する（保存 / parse / 変更数の確認） | 1 回の失敗で memory が空になり、worktree 内の作業が消える | s08/s09/s18 |
| モデルが渡すすべての名前を先に検査 | path injection で `.env` を読み、repository 外に worktree を作る | s02/s07/s18/s19 |

この表がコース全体の骨格です。1 行ずつ見ると小さな注意ですが、集めると同じ立場を表します。**モデルは判断し、Harness はその判断が構造的な破壊を起こせないようにします。**

---

## code.py に含まれるもの

**ツールと dispatch。** built-in は 27 ツールです。bash、ファイル、todo、task/subagent、skill、compact、task graph 5 種、cron 3 種、team 6 種、worktree 3 種、`connect_mcp` があります。MCP から発見した dynamic tool と同じ pool に入り、`assemble_tool_pool()` が毎ラウンド組み直します。s02 の table-driven dispatch は、構造を一行も変えず最終章まで続きます。

**2 層の計画。** `todo_write` は s05 のように 1 Agent の現在 session を管理し、drift を防ぎます。task graph は s12 のように依存、claim、永続化による cross-session 協調を管理します。2 層は重複ではありません。一方は付箋、もう一方は project board です。

**2 種類の委任。** `task` は s06 のように、clean context を持ち要約だけを返す one-shot subagent を起動します。`spawn_teammate` は s15-s17 のように、mailbox 通信と自律 claim を持つ persistent teammate を起動します。前者は context 分離を、後者は長期並行を解決します。

**prompt と知識。** `assemble_system_prompt(context)` は s10 に従い、実際の state から identity、tools、workspace、skill inventory、memory index、接続済み MCP server を組み立てます。skill と memory は s07/s09 のように inventory を常駐させ、本文は必要時だけ読み込みます。

**compaction と recovery。** LLM 前の 4 段階 pipeline は s08 から、呼び出しを包む recovery は s11 から来ています。429/529 の backoff、2 段階の `max_tokens` 増加、overflow 時の reactive compact があります。

**background と定時実行。** 遅い command を thread へ送り、引換券を返し、通知を注入する s13 の仕組みです。s14 の独立 cron thread は時刻を監視し、queue へ trigger を送り、定時 turn と user turn を排他します。

**分離と外部接続。** task は worktree へ binding でき、teammate は s18 のようにその作業場所で実行します。発見された MCP tool は s19 のように prefix 付きで pool へ入ります。

---

## s19 からの変更点

| コンポーネント | s19 | s20 |
|------|-----|-----|
| tool pool | built-in + MCP | s01-s18 の全ツールを復帰 |
| permission | 教材の主題から省略 | `PreToolUse` hook 内で実行 |
| hooks | 省略 | 4 event すべてを接続 |
| todo / skill / compact | 省略 | すべて復帰 |
| error recovery | 単純な try/except | backoff / escalation / reactive compact |
| background / cron | 省略 | background thread + durable scheduling |
| multi-agent / worktree | 維持 | 維持。teammate は worktree 内で実行 |

---

## 試してみる

```sh
cd learn-claude-code
python s20_comprehensive/code.py
```

1. `Create a todo list for inspecting this repo, then list Python files`: s05 の付箋と s02 のツールが同じラウンドで動きます。
2. `Connect to the docs MCP server and search for agent loop`: s19 の発見と組み立てです。
3. `Create two tasks, create worktrees for them, then spawn alice and bob. Ask them to submit plans before claiming tasks.`: s12、s15、s16、s18 の 4 機構がかみ合います。plan approval 後にだけ teammate が claim し、その後それぞれの worktree で働く様子を確認します。
4. `Remind me of the meeting in 3 minutes.`: s14 の目覚ましで、時刻になると terminal が自分で動きます。
5. `Run 'sleep 20 && echo build done' in the background and continue reading README.md`: s13 の引換券と通知です。

観察するのは、各 tool call 前の `[HOOK]`、`connect_mcp` 後の次ラウンドに現れる新ツール、background の引換券、時刻どおりの自動通知、approval 前に teammate が停止するか、worktree binding 後の実行ディレクトリです。19 章すべての log marker がそろっています。

---

## 終わりは始まりでもある

s01 から s20 まで、表面のコードは複雑になっても core は変わりません。

```python
while True:
    response = LLM(messages, tools)
    if not has_tool_use(response.content):
        return
    results = execute_tools(response.content)
    messages.append(tool_results)
```

Claude Code の複雑さは「別の Agent brain」ではなく、成熟した Harness の複雑さです。モデルは判断して選び、Harness は environment、tools、permission、memory、team、外部能力を整理し、上の表にある組み立て規則を守ります。

これで s01-s20 main line は収束します。しかし、この loop は常に single-step でモデル駆動です。各ラウンドでモデルが 1 つのツールを選びます。orchestration の形が固定されているなら、たとえば並行 fan-out、項目ごとの pipeline、checkpoint からの再開では、モデルに 1 ラウンドずつ動かさせるより、決定的で復元可能な script にするほうが適しています。

次へ: [s21 Workflow Runtime](../s21_workflow_runtime/) — モデルが単一 step を決め、script が orchestration を決めます。
