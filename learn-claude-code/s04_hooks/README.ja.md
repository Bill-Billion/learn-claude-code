# s04: Hooks — ループに掛ける、ループには書き込まない

[中文](README.zh.md) · [English](README.md) · [日本語](README.ja.md)

s01 → s02 → s03 → `s04` → [s05](../s05_todo_write/) → s06 → ... → s20

> *"ループに掛ける、ループには書き込まない"* — hook がツール実行の前後へ拡張ロジックを注入する。
>
> **Harness レイヤー**: hook — ループを侵食しない拡張ポイント。

---

前章の権限チェックは動くようになったが、まだループ内にハードコードされた一回の関数呼び出しだ。ここで、よくある要件を二つ追加する。ツール呼び出しごとにログを一行残すことと、出力が大きすぎるときに警告することだ。これまでの方法なら、さらにループへ詰め込む。

```python
def agent_loop(messages):
    while True:
        # ... LLM call ...
        for block in response.content:
            if block.type != "tool_use":
                continue
            log_to_file(block)          # 一行追加
            check_permission(block)     # 一行追加
            notify_slack(block)         # また一行
            output = execute(block)
            auto_git_add(block)         # さらに一行
            # ... すぐに元のループが見えなくなる
```

問題は拡張の仕方にある。変えたいのは Agent の振る舞いなのに、触っているのはエンジンだ。s01 では、後続の各章がこのループの周りに機能を足しても、ループ自体は変わらないと述べた。その約束を守るには、拡張をループ内へ書かず、ループに掛けなければならない。

![Hooks Overview](images/hooks-overview.svg)

---

## ループを直接変えると何が壊れるのか

**要件のたびにコアコードを触る。** ループは Agent の心臓で、ログ、通知、自動 commit は周辺の要件だ。周辺機能のたびに心臓を開けば、一度の変更ミスですべてが止まる。

**要件同士が絡み合う。** Slack 通知を消したければループ内の一行を探す。bash だけを記録したければ、またループへ条件を足す。すべての機能スイッチが一つの関数に埋まり、独立して出し入れできない。

**本流が埋もれる。** 元のループは五段階で説明できた。七つも八つも拡張を詰め込むと、新しい読者は `log_`、`notify_`、`auto_` の山から本流を掘り出さなければならない。

発想を変えよう。ループの重要な時点に取り付け口を用意する。ループは「ここまで来た」と通知するだけで、何をするかは登録された関数が決める。

---

## レジストリ：イベント名から callback のリストへ

hook システム全体は、一つの辞書と二つの関数だけだ。

```python
HOOKS = {"UserPromptSubmit": [], "PreToolUse": [], "PostToolUse": [], "Stop": []}

def register_hook(event: str, callback):
    HOOKS[event].append(callback)          # 登録：リストの末尾へ追加

def trigger_hooks(event: str, *args):
    for callback in HOOKS[event]:
        result = callback(*args)
        if result is not None:             # 教学上の省略：None 以外なら介入
            return result
    return None
```

約束は単純だ。hook が `None` を返せば「確認した、続行」。`None` 以外を返せば「ここで止める」で、残りの hook は実行されない。

四つのイベントが、Agent の一サイクルにある四つの重要な時点へ配置される。

| イベント | 発火する時点 | 教学版で掛けるもの |
|----------|--------------|--------------------|
| `UserPromptSubmit` | ユーザー入力後、LLM の前 | 作業ディレクトリを一行記録 |
| `PreToolUse` | ツール実行前 | 権限チェック、呼び出しログ |
| `PostToolUse` | ツール実行後 | 大きな出力の警告 |
| `Stop` | ループ終了直前 | 今回のツール呼び出し数 |

---

## PreToolUse：s03 の権限チェックを hook へ移す

s03 の `check_permission()` を丸ごと hook 関数へ移す。ロジックは一行も変わらず、置き場所だけが変わる。

```python
def permission_hook(block):
    """s03 の権限ロジック。今は hook として動く。"""
    if block.name == "bash":
        for pattern in DENY_LIST:
            if pattern in block.input.get("command", ""):
                return "Permission denied by deny list"     # None 以外 -> 遮断
        for kw in DESTRUCTIVE:
            if kw in block.input.get("command", ""):
                choice = input("   Allow? [y/N] ").strip().lower()
                if choice not in ("y", "yes"):
                    return "Permission denied by user"
    ...
    return None                                             # 許可

def log_hook(block):
    """ツール呼び出しごとに一行記録する。"""
    print(f"[HOOK] {block.name}(...)")
    return None

register_hook("PreToolUse", permission_hook)
register_hook("PreToolUse", log_hook)
```

ループ内の `if not check_permission(block)` は次に変わる。

```python
blocked = trigger_hooks("PreToolUse", block)
if blocked:
    results.append({"type": "tool_result", "tool_use_id": block.id,
                    "content": str(blocked)})   # 遮断理由をそのままモデルへ返す
    continue
```

s03 の規則はそのまま続く。遮断した呼び出しにも `tool_result` を返し、遮断理由そのものを内容にする。モデルは `Permission denied by user` を読み、自分で別の経路を探せる。

見落としやすい厳格な規則が一つある。**登録順が実行順になる。** `permission_hook` は `log_hook` より先に登録されているため、遮断された呼び出しはログに残らない。権限 hook が `None` 以外を返し、後続のチェーンを短絡するからだ。許可・遮断の両方を記録したければ `log_hook` を先に登録する。それだけで振る舞いが変わる。順序は見た目ではなく意味だ。

---

## PostToolUse：実行後に出力を見る

```python
def large_output_hook(block, output):
    if len(str(output)) > 100000:      # 100 KB を超えたら警告
        print(f"[HOOK] ⚠ Large output from {block.name}: {len(str(output))} chars")
    return None

register_hook("PostToolUse", large_output_hook)
```

今は警告するだけで、この 100 KB が会話履歴へ流れ込むのを止められない。大きな出力を実際に処理するのは s08 で、その処理ロジックを差し込む位置はまさにここになる。

---

## UserPromptSubmit と Stop：入口と出口

入力側では、ユーザーが Enter を押した後、内容が `messages` へ入る前に発火する。

```python
query = input("s04 >> ")
trigger_hooks("UserPromptSubmit", query)   # LLM へ入る前
history.append({"role": "user", "content": query})
```

教学版はログを一行出すだけだ。本番システムなら、ここで入力検証やプロジェクトコンテキストの注入を行う。現在の処理より位置のほうが重要で、ここはすべての入力が通る関門だ。

出口側はもっと興味深い。ループが終わろうとするとき、最後に Stop hook へ尋ねる。

```python
if response.stop_reason != "tool_use":
    force = trigger_hooks("Stop", messages)   # 終了前に最後の確認
    if force:
        messages.append({"role": "user", "content": force})
        continue                              # hook が「未完了」と言えば続行
    return
```

教学版の `summary_hook` は今回のツール呼び出し数を数え、`None` を返して終了を許可するだけだ。しかし、この仕組みの重さに注目しよう。`None` 以外を返す Stop hook は、Agent の終了を拒否し、ループへ押し戻せる。s01 では「ループを抜けるのはモデルの判断」だった。この章で初めて、プログラムがその判断に拒否権を持つ。s22 ではこれを完全な Goal Loop にする。

> 実際の Claude Code には 27 種類の hook イベントがあり、session、compaction、Subagent、チーム協調にも計測点がある。戻り値は None/非 None ではなく 14 フィールドの構造体だ。最も重要な安全上の不変条件は、hook が allow を返しても `settings.json` の deny/ask ルールを上書きできないこと。拡張ポイントは決して権限昇格の経路になってはならない。教学版の四イベントと一つの戻り値は、同じパターンの最小実行版だ。

---

## s03 からの変更

| コンポーネント | 変更前 (s03) | 変更後 (s04) |
|----------------|--------------|--------------|
| 拡張方法 | `check_permission()` をループにハードコード | `HOOKS` レジストリ + `trigger_hooks()` |
| 新しい関数 | — | `register_hook`, `trigger_hooks` |
| hook callback | — | `context_inject_hook`, `permission_hook`, `log_hook`, `large_output_hook`, `summary_hook` |
| 終了制御 | なし | Stop hook の非 None で続行を強制 |
| 入力の関門 | なし | LLM 前に `UserPromptSubmit` を発火 |

---

## 試してみる

```sh
cd learn-claude-code
python s04_hooks/code.py
```

1. `Read the file README.md`：一サイクルの hook タイムラインを見る。入力後に `[HOOK] UserPromptSubmit`、ツール前に `[HOOK] read_file(...)`、終了時に `[HOOK] Stop: session used N tool calls` が出る。
2. `Use read_file to read web/src/data/generated/docs.json without a limit`：このファイルは 700 KB を超えるため、100 KB のしきい値を越えて `PostToolUse` の警告が出る。
3. `Create a file called test.txt, then delete it`：書き込みはそのまま通り、`rm` が権限確認を出す。N を押し、遮断された呼び出しに `[HOOK] bash(...)` のログがないことを見る。権限 hook がログ hook より先にあり、チェーンを短絡した結果だ。

---

## 次へ

Agent は安全に実行でき、観測可能な形で拡張できるようになった。だが複雑なタスクを渡すと、まだ計画を立てず、行き当たりばったりに一歩ずつ始めてしまう。どこへ進むつもりかも見えない。

s05 TodoWrite → Agent に計画ツールを与える。先に一覧を作り、それから動く。

<!-- translation-sync: zh@v2, en@v2, ja@v2 -->
