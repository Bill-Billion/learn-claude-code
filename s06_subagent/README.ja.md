# s06: Subagent — 大きなタスクを分け、クリーンなコンテキストを渡す

[中文](README.zh.md) · [English](README.md) · [日本語](README.ja.md)

s01 → s02 → s03 → s04 → s05 → `s06` → [s07](../s07_skill_loading/) → s08 → ... → s20

> *"大きなタスクを小さく分け、各サブタスクにクリーンなコンテキストを"* — Subagent は独立した `messages[]` を使い、親の会話を汚さない。
>
> **Harness レイヤー**: Subagent — コンテキストを分離し、注意の漂流を防ぐ。

---

前章の一覧は作業順を制御できたが、情報量は制御できない。

Agent が bug を直している。呼び出し経路を追うため 30 ファイルを読み、60 ターンを往復し、`messages` は 120 件に増えた。その大半は調査途中の産物で、「bug を直す」という目的にはもう関係ない。それでもコンテキストを占め続ける。最初の bug に戻った頃には、肝心の説明のほうが見えなくなりかけている。

人ならどうするか。別のターミナルを開いて呼び出し経路を調べ、結論をメモし、ターミナルを閉じて元の修正へ戻る。途中で読んだ 30 ファイルは一緒に戻ってこない。

この章では Agent に同じ能力を与える。新しいコンテキストを持つ Subagent に面倒な調査を任せ、結論だけを持ち帰らせる。

![Subagent Overview](images/subagent-overview.svg)

---

## 親 Agent が最後まで一人でやると、なぜ駄目なのか

直感的には、親 Agent が呼び出し経路を追い、そのまま修正すればよい。しかし問題は先ほど見たとおり、調査過程が永久に親の会話へ残ることだ。s08 では満杯のコンテキストを圧縮するが、後から圧縮するより、不要な情報を最初から入れないほうがよい。

では途中のメッセージを「使い終わったら削除」すればよいか。それもできない。メッセージを消すと s01 の `tool_use`/`tool_result` の対応を壊す可能性があり、何を「使い終わった」とみなすかも親 Agent 自身には正確に判断できない。

解決策は外注だ。「呼び出し経路を追う」という仕事全体を別の会話で実行する。その会話はいくら汚れてもよい。終わったら全履歴を捨て、要約だけを返す。

---

## Subagent は s01 のループをもう一つ動かすだけ

`spawn_subagent` は新しい概念を導入しない。新しい `messages[]` を用意し、s01 型のループをもう一つ始めるだけだ。

```python
def spawn_subagent(description: str) -> str:
    messages = [{"role": "user", "content": description}]   # タスクだけを含む新しいコンテキスト

    for _ in range(30):                                     # 安全上限：最大 30 ターン
        response = client.messages.create(
            model=MODEL, system=SUB_SYSTEM,                 # Subagent 専用の system prompt
            messages=messages, tools=SUB_TOOLS, max_tokens=8000,
        )
        messages.append({"role": "assistant", "content": response.content})
        if response.stop_reason != "tool_use":
            break
        results = []
        for block in response.content:
            if block.type == "tool_use":
                blocked = trigger_hooks("PreToolUse", block)   # 外注しても権限チェックは免除しない
                if blocked:
                    results.append({"type": "tool_result", "tool_use_id": block.id,
                                    "content": str(blocked)})
                    continue
                handler = SUB_HANDLERS.get(block.name)
                output = handler(**block.input) if handler else f"Unknown: {block.name}"
                results.append({"type": "tool_result", "tool_use_id": block.id,
                                "content": output})
        messages.append({"role": "user", "content": results})

    # 結論だけを持ち帰り、会話履歴全体をここで捨てる
    result = extract_text(messages[-1]["content"])
    ...
    return result
```

`SUB_SYSTEM` の違いは一文だけだ。「タスクを完了し、簡潔な要約を返し、さらに委任しないこと」。`SUB_TOOLS` は親 Agent のツールの部分集合で、`bash`/`read`/`write`/`edit`/`glob` はあるが、`task` も `todo_write` もない。

親 Agent 側の接続方法も同じ合言葉に従う。定義を一つ、登録を一行。

```python
TOOLS.append({
    "name": "task",
    "description": "Launch a subagent to handle a complex subtask. Returns only the final conclusion.",
    "input_schema": {"type": "object", "properties": {"description": {"type": "string"}}, "required": ["description"]},
})
TOOL_HANDLERS["task"] = spawn_subagent
```

親のループから見れば、`task` と `read_file` に違いはない。一回呼び出し、一つの結果を受け取る。ただし、その「結果」の裏では別の Agent が一つの仕事人生を走り切っている。

---

## 省略できない四つの防線

このコードには四つの意図的な設計があり、それぞれが異なる失敗を防ぐ。

**Subagent に `task` ツールを与えない。** 与えると、Subagent が孫を生み、孫がさらに次を生む。一段ごとに最大 30 ターンの委任が暴走すれば、数段で API 予算を使い切れる。再帰を子の一段で止めるのはツールセットによる強制で、モデルの自制には頼らない。

**外注しても権限は免除しない。** Subagent の各ツール呼び出しも `PreToolUse` hook を通る。これを飛ばすと、「Subagent に任せる」が権限回避になる。親で止められたコマンドも、タスク説明へ書いて子に実行させればよいからだ。コンテキスト分離と権限分離は別物で、前者は効率設計、後者は安全境界である。

**結論抽出には fallback がある。** 30 ターンの上限に達したとき、最後のメッセージがモデルのテキストを含まない `tool_result` かもしれない。最後だけを読むと空文字列になり、親は空の結論を受け取る。そこでコードは直近の assistant テキストを後ろから探す。それもなければ `"Subagent stopped after 30 turns without final answer."` を返し、何が起きたかを親へ伝える。

**要約にない情報は存在しない。** Subagent が読んだファイルや試した経路を、親は永遠に見ない。委任とは、親の会話をきれいに保つ代わりに、一度の非可逆な圧縮を受け入れることだ。何を要約へ残すかは `task` ツールの `description` が十分明確かどうかで決まる。

> 実際の Claude Code には Subagent の実行モードが三つある。fork モードはコンテキストを空にするどころか、親と一字一句同じメッセージ接頭辞を構築する。Anthropic API の prompt cache に当て、時間と費用を節約するためだ。また Subagent がバックグラウンドで動き、完了後に親へ通知する非同期経路もある。s13 でこれを作る。

---

## s05 からの変更

| コンポーネント | 変更前 (s05) | 変更後 (s06) |
|----------------|--------------|--------------|
| ツール数 | 6 (`bash`, `read`, `write`, `edit`, `glob`, `todo_write`) | 7 (+`task`) |
| 新しい関数 | — | `spawn_subagent`（独立 `messages[]` + 30 ターン上限） |
| コンテキスト | すべて親の会話 | Subagent は新しい `messages[]` で開始 |
| ループ | 変更なし | dispatch は同じ、Subagent は `SUB_SYSTEM` と hook で保護 |

---

## 試してみる

```sh
cd learn-claude-code
python s06_subagent/code.py
```

1. `Use a subtask to find what testing framework this project uses`：`[Subagent spawned]`、字下げされた `[sub] read_file: ...`、`[Subagent done]` の三段階を見る。親が受け取るのは一つの結論だけだ。
2. `Delegate: read all Python files in s01_agent_loop/ and s02_tool_use/ and summarize what each one does`：Subagent は複数のファイルを読む。終了後、親に `Quote the exact SYSTEM prompt string from s01's code.py` と聞く。再度ファイルを読まない限り答えられない。詳細は破棄された子コンテキストに残ったからだ。これが実際に分離された証拠になる。
3. `Use a task to create s06_subagent/example/string_tools.py with a slugify(text: str) function, then verify it from the parent agent`：Subagent が書いたファイルはディスクに残り、親 Agent も読める。会話コンテキストは分離されても、ファイルシステムは分離されていない。この二つを区別しよう。

---

## 次へ

Agent はタスクを分けられるようになった。しかし必要な知識はタスクごとに違う。frontend の変更には component 規約、SQL には schema が必要だ。すべての分野知識を system prompt へ入れれば、どのタスクも全マニュアルを背負って走ることになる。

s07 Skill Loading → 知識を必要なときだけ読み込む。カタログは常駐させ、本文は使うときにだけ、ファイルと同じように読む。

<!-- translation-sync: zh@v3, en@v3, ja@v3 -->
