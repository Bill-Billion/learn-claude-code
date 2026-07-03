# s08: Context Compact — コンテキストはいつか満杯になる、まず整理、それから要約

[中文](README.zh.md) · [English](README.md) · [日本語](README.ja.md)

s01 → s02 → s03 → s04 → s05 → s06 → s07 → `s08` → [s09](../s09_memory/) → s10 → ... → s20

---

長いタスクでは、ファイルを 1 つ読むだけで数千 token、テストを 1 回走らせればログがまた大量に出る。ファイル内容、コマンド出力、ツール結果はすべて `messages` に戻され、どんどん積み上がっていく。

コンテキストが増えるほどモデルの注意は散漫になり、本当に満杯になった時点でリクエストはそのまま失敗する：`prompt_too_long`。

だから s08 が解決するのは一つ：

> 長いタスクでも Agent が働き続けられるようにする。

![Context Compact 全体像](images/compact-overview.svg)

---

## いきなり履歴を要約しない

最も直感的なのは、モデルに履歴を要約させることだ。

だが、それを最初の一手にしてはいけない。

要約する必要のない内容は多い。古いログ、古いファイル内容、すでに役目を終えたツール結果。これらは場所を取っているだけで、もう重要とは限らない。こうした内容にはまず整理で対応する：ディスクに退避できるものは退避し、プレースホルダで置き換えられるものは置き換え、切り詰められるものは切り詰める。

これらをすべてやってもまだ上限に近いときに、はじめてモデルに要約を生成させる。

理由は単純だ。前の 3 ステップはほぼ復元可能だが、要約は不可逆。要約が履歴を置き換えた瞬間、細部は現在のコンテキストから消える。

---

## 全体の流れ

モデルを呼び出す前に、毎回 `messages` を一度整理する：

```python
messages = tool_result_budget(messages)  # 大きな結果を先に退避
messages = snip_compact(messages)        # 中間の古い対話を切り詰め
messages = micro_compact(messages)       # 古いツール結果をプレースホルダ化

if estimate_size(messages) > CONTEXT_LIMIT:
    messages = compact_history(messages) # それでも足りなければ要約
```

![4 ステップ圧縮パイプライン](images/compaction-layers.svg)

> この順序は入れ替えられない。
>
> 特に `tool_result_budget` は `micro_compact` より先に走らなければならない。`micro_compact` は古いツール結果をプレースホルダに置き換えるので、先に走ると完全な内容が手に入らなくなり、大きな結果を退避できなくなる。

---

## Step 1：tool_result_budget — 大きな結果を先に退避する

問題は履歴の長さではなく、1 件のツール結果が大きすぎることもある。

たとえば Agent が大きなファイルを何個か一気に読むと、最後の `tool_result` は 200KB を超えうる。最新の結果だから単純に捨てるわけにはいかない。だが、全文をコンテキストに置いておくべきでもない。

やり方：全文をディスクに書き出し、コンテキストにはパスと短いプレビューだけを残す。

![大きな結果をディスクへ退避](images/layer1-budget.svg)

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

このステップは内容を失わない。「現在のコンテキスト」からディスクへ移すだけだ。

モデルには、その内容がどこに保存されたか、冒頭がどんな様子かは見えている。後で全文が必要になったら読み戻せばいい。

---

## Step 2：snip_compact — 古い対話を切り詰める

メッセージが多すぎるときは、先頭と末尾を残せばいい。

先頭にはたいてい元のタスクと制約があり、末尾は今やっている作業だ。中間の古い履歴は、一行の説明に置き換えられる。

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

注意点が一つ：`assistant` の `tool_use` と対応する `tool_result` を切り離してはいけない。切り離すと、モデルには出所不明のツール結果が見え、API はリクエストをそのまま拒否する。

だから `safe_head` と `safe_tail` は単純なスライスではない。こうした断点を避けて切る（実装は `code.py`）。

このステップが減らすのはメッセージの数だ。

だが 1 件のメッセージ内の大きな内容は扱えない。古い `tool_result` に数十 KB のファイル内容が残っていれば、それはコンテキストを占め続ける。

だからツール結果の整理を続ける。

---

## Step 3：micro_compact — 古いツール結果をプレースホルダに置き換える

コンテキストを膨らませるのは、対話そのものよりツール結果であることが多い。

Agent がファイルを 10 個続けて読んだとき、最初の数個の全文をコンテキストに置き続ける必要はまずない。直近の数件を残せば足りる。より古い結果は、本当に必要になったら再取得すればいい。

![古い結果をプレースホルダ化](images/micro-compact.svg)

```python
KEEP_RECENT = 3

def micro_compact(messages):
    results = collect_tool_results(messages)

    for _, _, block in results[:-KEEP_RECENT]:
        if len(block.get("content", "")) > 120:
            block["content"] = "[Earlier tool result compacted. Re-run if needed.]"

    return messages
```

このステップは内容を要約しない。古い全文を一行の説明に置き換えるだけだ。

「ツール結果が多い」場合には効くが、「整理してもまだ大きい」場合には効かない。ここまでやってなお超過しているなら、残る手はモデルによる要約だけだ。

---

## Step 4：compact_history — 整理しても超過するなら、要約する

前の 3 ステップを終えてもコンテキストが大きすぎるなら、モデルに履歴を要約させる。

やることは三つ：

まず完全な対話をディスクに書き出す。
次にモデルに要約を生成させる。
最後に要約で古い履歴を置き換える。

![LLM 全量要約](images/auto-compact.svg)

```python
def compact_history(messages):
    transcript_path = write_transcript(messages)  # ① 完全な対話をディスクへ
    summary = summarize_history(messages)         # ② 要約を生成
    return [{
        "role": "user",
        "content": f"[Compacted]\n\n{summary}",   # ③ 要約で古い履歴を置換
    }]
```

要約には 5 種類の情報を残すよう求める：現在の目標、ユーザーの制約、重要な発見、変更したファイル、次の作業。

このステップは最も効果的で、最もリスクが高い。

完全な履歴はディスクに残っているが、モデルに今見えるのは要約だけだ。要約に書かれなかった細部は、以降のすべてのターンにとって、当面見えないのと同じになる。

だから要約は必ず最後に置く。

---

## エラー後の応急整理

通常は、モデルを呼び出す前にコンテキストを整理し終えている。

だが token の見積もりが外れることも、あるターンのツール出力が突然膨らむこともあり、API は依然として `prompt_too_long` を返しうる。そのときはもう一段激しい整理をする：完全な記録を保存し、前方の大部分を要約に潰し、最後の数件だけを残す。

```python
def reactive_compact(messages):
    write_transcript(messages)
    tail = safe_tail(messages, 5)   # 末尾スライス、同じく断点を回避
    summary = summarize_history(messages[:len(messages) - len(tail)])

    return [{
        "role": "user",
        "content": f"[Reactive compact]\n\n{summary}",
    }] + tail
```

これは通常経路ではない。

すでにエラーが起きたときだけ使い、リトライ回数も限られる（教学版は 1 回）。さもないと、要約自体が失敗したときに無限リトライに陥りかねない。

---

## Agent Loop に組み戻す

整理ロジックは最終的に Agent Loop へ戻す。

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

        # ... ツールを実行し、結果を messages に戻す ...
```

ここで最も重要なのは順序だ：

```text
大きな結果を退避 → 中間の古い対話を切り詰め → 古い結果をプレースホルダ化 → それでも超過、そこで要約
```

前の 3 ステップにモデルは関与しない。主に空間の整理だ。Step 4 だけが本当に履歴を書き換える。だから必ず最後に置く。

---

## compact ツール：モデル自身が整理を求める

自動整理のほかに、モデルに `compact` ツールを持たせることもできる。

コンテキストが長すぎると気づいたとき、あるいはタスクが新しい段階に入ったとき、モデルはこのツールを自分から呼べる。呼ばれるとプログラムは `compact_history` を実行して現在のターンを終え、整理後のコンテキストで次のターンを始める。

これで整理はプログラムの自動トリガーだけでなく、モデルが適切なタイミングで自分から言い出せるものになる。

---

## s07 からの変更

| コンポーネント | s07 | s08 |
|------|------|------|
| コンテキスト管理 | なし | 毎回呼び出し前に整理 |
| ツール結果 | ずっとコンテキストに残る | 大きな結果は退避、古い結果はプレースホルダ |
| 履歴メッセージ | 蓄積し続ける | 中間の古い履歴は省略可能 |
| 上限超過時 | そのまま失敗 | まず整理、足りなければ要約 |
| 新ツール | なし | `compact` |

s07 は Agent の仕事の腕を上げた。
s08 は長いタスクで Agent が自分の履歴に押し潰されないようにする。

---

## 試してみる

```bash
cd learn-claude-code
python s08_context_compact/code.py
```

試すタスク：

```text
Read README.md, then read code.py, then read s01_agent_loop/README.md
```

古いツール結果がプレースホルダに置き換わるかを観察する。

```text
Read every file in s08_context_compact/
```

大きな出力がディスクへ退避されるかを観察する。

```text
Keep discussing and editing for more than 20 turns
```

コンテキストが上限に近づいたとき、要約がトリガーされるかを観察する。

---

## まとめ

Context Compact の核心となる原則は一行だ：

> 整理できるものはまず整理する。復元できるものは要約しない。それでも足りないときだけ、モデルに履歴を要約させる。

s08 で長いタスクは続けられるようになった。
s09 は次の問題に取り組む：どの情報を長く残す価値があるか。

<!-- translation-sync: zh@v5, en@v5, ja@v5 -->
