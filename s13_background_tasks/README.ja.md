# s13: Background Tasks — 遅い処理をバックグラウンドへ

[中文](README.zh.md) · [English](README.md) · [日本語](README.ja.md)

s01 → ... → s11 → s12 → `s13` → [s14](../s14_cron_scheduler/) → s15 → ... → s20

> *「遅い処理はバックグラウンドに送り、Agent は作業を続ける」* — バックグラウンドスレッドでコマンドを実行し、完了後に通知を注入します。
>
> **Harness 層**: バックグラウンド — main loop を止めない非同期実行。

---

s01 から現在まで、`run_bash` にはまだ問題を起こしていなかった 1 行、`timeout=120` が隠れていました。コマンドが 2 分を超えると強制終了します。全テストに 10 分かかるなら、これまでのどの章でも最後までたどり着けません。

タイムアウトを延ばしても、問題の姿が変わるだけです。`subprocess.run` はブロッキングなので、コマンドに 10 分かかれば Agent もその場で 10 分待ちます。モデルを呼べず、ほかの仕事もできません。ターミナルは動かず、実行中なのか死んだのかも分かりません。

自分ならそんな働き方はしないはずです。洗濯物を洗濯機に入れたら、ドラムを眺めて待たず、料理をして完了音が鳴ったら戻ります。この章では Agent に同じ流れを与えます。遅いコマンドを送り出し、別の作業へ移り、終わったら結果を受け取ります。

![Background Tasks Overview](images/background-tasks-overview.svg)

---

## 何をバックグラウンドへ送るか: モデルが決め、ヒューリスティックで補う

最初の問題は判定です。どのコマンドをバックグラウンドへ送るべきでしょうか。

```python
def is_slow_operation(tool_name: str, tool_input: dict) -> bool:
    """フォールバック用ヒューリスティック: このキーワードを含むコマンドは 30 秒を超える可能性が高い。"""
    if tool_name != "bash":
        return False
    cmd = tool_input.get("command", "").lower()
    slow_keywords = ["install", "build", "test", "deploy", "compile",
                     "docker build", "pip install", "npm install",
                     "cargo build", "pytest", "make"]
    return any(kw in cmd for kw in slow_keywords)

def should_run_background(tool_name: str, tool_input: dict) -> bool:
    if tool_input.get("run_in_background"):   # モデルが明示したら、そのままバックグラウンドへ
        return True
    return is_slow_operation(tool_name, tool_input)   # 指定がなければヒューリスティックを見る
```

どのコマンドが遅いかは、キーワード表よりモデルのほうが正確に判断できます。そのため `bash` ツールに `run_in_background` 引数を追加し、モデルからの明示的な要求を優先します。ヒューリスティックはあくまで予備です。モデルが引数を忘れても、`npm install` がループ全体を止めないようにします。

この予備策の欠点も正直に見ておきましょう。キーワード一致には必ず誤判定があり、`echo running tests` にも「test」が含まれるため、バックグラウンドへ送られます。またコードの形にも注目してください。明示的な `True` はヒューリスティックに勝ちますが、明示的な `False` では止められません。教材版ではモデルの指定が一方向にしか効かない簡略化を採用しており、実験で実際に遭遇します。

---

## ディスパッチ: スレッドと台帳

```python
background_tasks: dict[str, dict] = {}   # bg_id → {tool_use_id, command, status}
background_results: dict[str, str] = {}  # bg_id → 出力
background_lock = threading.Lock()

def start_background_task(block) -> str:
    global _bg_counter
    _bg_counter += 1
    bg_id = f"bg_{_bg_counter:04d}"

    def worker():
        result = execute_tool(block)          # 子スレッド内で実際に実行
        with background_lock:
            background_tasks[bg_id]["status"] = "completed"
            background_results[bg_id] = result

    with background_lock:
        background_tasks[bg_id] = {"tool_use_id": block.id,
                                   "command": ..., "status": "running"}
    threading.Thread(target=worker, daemon=True).start()
    return bg_id
```

`background_lock` は飾りではありません。worker が `status` を書いている間に、main thread が 2 つの辞書を走査したり項目を取り出したりする可能性があります。ロックがなければデータ競合です。軽ければ通知が 1 件消え、重ければ辞書の構造が壊れます。規則は単純で、この 2 つの辞書に触れるときは、どちらのスレッドも必ずロックを持ちます。

`daemon=True` も知っておくべき境界です。main process が終了するとバックグラウンドスレッドも道連れになり、未完了の結果は失われます。教材版はこの制約を受け入れますが、本番システムではバックグラウンドタスクを別プロセスとディスクに置きます。

---

## 引換券: ペアリング規則は待ってくれない

ディスパッチで「ブロックしない」は解決しますが、すぐに s01 の規則へぶつかります。すべての `tool_use` には、次の user メッセージで対応する `tool_result` が必要です。しかし本当の結果はまだスレッド内で実行中です。このターンでは何を API に返せばよいのでしょうか。

引換券を返します。

```python
if should_run_background(block.name, block.input):
    bg_id = start_background_task(block)
    results.append({"type": "tool_result",
                    "tool_use_id": block.id,
                    "content": f"[Background task {bg_id} started] "
                               f"Command: ... Result will be available when complete."})
```

ペアリング規則は同じターンで満たされ、モデルは引換番号も受け取ります。「Result will be available when complete」を見れば、その場で待たず別の作業へ進むべきだと分かります。

---

## 結果の回収: 通知はテキスト経路を使い、ツール結果を装わない

バックグラウンド処理が終わったら、結果をどう会話へ戻すのでしょうか。よくある間違いは、最初の `tool_use_id` を再利用し、もう 1 件の `tool_result` を注入することです。これはできません。その ID は引換券のターンですでにペアになっており、API は各 ID について 1 回しか対応付けを認めません。再利用するとエラーになります。

そこで通知は、s01 で説明した別の経路を使います。`user` メッセージは「外部世界の声」です。バックグラウンド結果は世界で起きた新しい出来事なので、モデルが認識しやすい構造化 XML の通常テキストブロックとして注入します。

```python
notifications.append(
    f"<task_notification>\n"
    f"  <task_id>{bg_id}</task_id>\n"
    f"  <status>completed</status>\n"
    f"  <command>{task['command']}</command>\n"
    f"  <summary>{summary}</summary>\n"
    f"</task_notification>")
```

注入するのは各ツールラウンドの後です。そのラウンドの `tool_result` と、たまっていたバックグラウンド通知を同じ user メッセージへ詰めて返します。ここに教材版の境界があります。**通知はツールラウンドの後にしか注入されません。** モデルがすでに仕事を終え、ツールを必要とする新しい要求も送らなければ、完了した結果は台帳に残って待ち続けます。実システムは常駐メッセージキューを毎ターン消費して、この問題を解決します。

> 実際の Claude Code はスレッドを使いません。Node.js のシングルスレッドイベントループ上で動き、「バックグラウンド」とは await しないことです。コマンド出力をファイルへリダイレクトし、プロセスを独立して走らせます。バックグラウンドタスクにはローカルコマンド、ローカルおよびリモート Agent、ワークフロー、監視など 7 種類があり、それぞれ固有のライフサイクルを持ちます。バックグラウンド bash には停止監視もあり、出力が 45 秒増えないと、`(y/n)` のような対話プロンプトで止まっていないか確認します。

---

## s12 からの変更点

| コンポーネント | 変更前 (s12) | 変更後 (s13) |
|------|-----------|-----------|
| 遅いコマンド | main loop をブロック（120 秒で強制終了） | バックグラウンドスレッドで実行し、main loop は継続 |
| bash 引数 | `command` | +`run_in_background`（モデルが明示） |
| 新しい関数 | — | `is_slow_operation`, `should_run_background`, `start_background_task`, `collect_background_results` |
| 結果の返却 | 同じラウンドの `tool_result` | 引換券 + `<task_notification>` テキスト注入 |
| スレッド安全性 | 対象外 | `threading.Lock` で台帳を保護 |

---

## 試してみる

```sh
cd learn-claude-code
python s13_background_tasks/code.py
```

1. **完全なタイムラインを一度に見る**: `Run this command: echo running tests`。「test」キーワードでヒューリスティックが発動し、瞬時に終わるコマンドまでバックグラウンドへ送られます。完了が十分速いため、同じラウンドで `[background] dispatched`、`[background done]`、`[inject] 1 background notification(s)` という一連の出力が見えます。キーワード誤判定の実例でもあります。
2. **本当の並行処理**: `In the background, run 'sleep 15 && echo finished'. While waiting, write a short poem about waiting to wait.md`。「sleep」はキーワード表にないため、モデル自身が `run_in_background` を渡します。ディスパッチ後、止まらずすぐ詩を書き始める様子を観察してください。
3. **通知のタイミング**: 実験 2 の後、15 秒ほど待って `Read wait.md` と入力します。この要求にはツールラウンドがあるため、`<task_notification>` が同乗して会話へ入り、モデルはバックグラウンドコマンドの完了に触れます。ツール不要の雑談だけを送れば、通知は台帳に残ります。「ツールラウンドの後だけ注入」という境界を自分で確かめられます。

---

## 次へ

長いコマンドに Agent を足止めされなくなりました。しかし、すべての作業はまだ「あなたが一言指示する」ことで始まります。毎朝 9 時にテストを走らせたり、5 分ごとにサービスを確認したりするにはどうすればよいでしょう。時刻どおりに Enter を押す係を雇うのでは意味がありません。

s14 Cron Scheduler → Agent に目覚まし時計を持たせます。

<!-- translation-sync: zh@v2, en@v2, ja@v2 -->
