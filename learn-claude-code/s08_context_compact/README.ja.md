# s08: Context Compact — コンテキストはいつか満杯になる、まず整理、それから要約

[中文](README.zh.md) · [English](README.md) · [日本語](README.ja.md)

s01 → s02 → s03 → s04 → s05 → s06 → s07 → `s08` → [s09](../s09_memory/) → s10 → ... → s20

---

s07 までで、Agent はツールを使い、権限を管理し、Subagent に仕事を任せ、必要な skill を読み込めるようになった。タスクが長くなると新しい問題が現れる。ファイルやコマンドが増えたある時点で、モデル呼び出しが突然 `prompt_too_long` で失敗する。

この章では、そのエラーが何を意味し、なぜ必ず起こり、どれほど長いタスクでも Agent を動かし続けるにはどうすればよいかを扱う。

![Context Compact 全体像](images/compact-overview.svg)

---

## まず理解する：コンテキストとは何か

問題を解くとき、目の前に下書き用紙を広げる。課題、今どこまで進んだか、途中結果、調べて書き写した資料など、現在必要な情報はすべてその紙にあり、目を落とせば見える。

モデルにも同じ下書き用紙があり、コンテキストウィンドウと呼ぶ。ユーザーの発言、モデルの返答、ツール呼び出し、ツール結果がすべて順番に書かれる。モデルが考えるとき、紙にある内容を全部見られる。

この紙には一つの特徴がある。大きさが固定されている。モデルによって広さは違っても、必ず上限がある。書き切れば新しい内容を載せられず、リクエストは失敗する。

紙の大部分を使うのは会話ではなく、ツール結果だ。

- 1,000 行のコードファイルを読めば、1,000 行すべてがコンテキストへ入る。
- テストを一回実行すれば、数十 KB のログが入る。
- 十数個のファイルを続けて検索すれば、結果が次々に積み上がる。

計算してみよう。コンテキストが 200,000 token、普通のファイル一つが平均 5,000 token なら、40 ファイルで満杯になる。現実の開発タスクでは、ファイルを読み、コマンドを実行し、エラーを調べるために数十から数百回のツール呼び出しをすることも珍しくない。

> タスクが十分に長ければ、コンテキストは必ず満杯になる。確率ではなく時間の問題だ。

しかも満杯になる前から問題は始まる。紙の情報が多すぎると、モデルは要点をつかみにくくなり、重要な制約が古いログに埋まり、要求を忘れていく。コンテキスト圧縮はエラーを防ぐだけではなく、モデルが自分の仕事を見失わないためにも必要だ。

---

## 最も直感的な方法を、なぜ最初に使えないのか

最初に思いつくのは、前の内容をモデルに数行へ要約させて場所を空けることだろう。

最後には使うが、最初の一手にはできない。下書き用紙が埋まったからといって、いきなり前のページを破り、要点だけを書き直すことはしない。理由は三つある。

第一に、要約は必ず細部を失う。どれほど丁寧な要点でも、元の下書きほど多くの情報は持てない。関数の引数、完全なエラー文、ユーザーが何気なく伝えた小さな制約が抜けることがある。要約が履歴を置き換えれば、書かれなかった細部は現在のコンテキストから消える。

第二に、要約自体にコストがある。生成には追加のモデル呼び出しが必要で、時間も費用もかかる。普通のコードで片付けられる内容を、モデルに書き直させる必要はない。

第三に、最も場所を取る内容は、そもそも要約する価値がないことが多い。読んだファイルはディスクに残り、コマンドは再実行できる。必要になったら完全な内容を取り直せばよく、永久にコンテキストへ広げる必要はない。

正しい考え方は下書き用紙の整理と同じだ。まず情報を失わない整理から始める。しまえるものはしまい、再生できるものは消す。それでも足りない最後の段階で要点を書く。

次の四段階はこの順に並ぶ。前ほど情報損失が少なく安価で、後ほど大きく空間を回収する代わりに代償が高い。

![4 ステップ圧縮パイプライン](images/compaction-layers.svg)

---

## 第 1 段階：tool_result_budget — 大きな結果を先にディスクへ移す

問題は長い履歴ではなく、最新の結果群が大きすぎることもある。Agent が大きなファイルを一度に何個か読むと、最後のメッセージにある `tool_result` の合計が 200 KB を超える。新しい結果なので捨てられないが、全文をコンテキストに広げる必要もない。

資料を書き写す場合と同じだ。全文をノートへ保存し、下書き用紙には「ノートの 5 ページ」と一行残す。コードでは、完全な出力をディスクへ書き、コンテキストにはパスと冒頭の preview だけを置く。

![大きな結果を先に保存](images/layer1-budget.svg)

```python
def tool_result_budget(messages, max_bytes=200_000):
    # 最新メッセージのツール結果だけを見る
    blocks = [b for b in messages[-1]["content"] if b.get("type") == "tool_result"]
    total = sum(len(str(b["content"])) for b in blocks)

    if total <= max_bytes:      # 予算内なら変更しない
        return messages

    # 大きい結果から順にディスクへ移す
    for block in sorted(blocks, key=lambda b: len(str(b["content"])), reverse=True):
        # 全文を保存し、コンテキストにはパスと先頭 2,000 文字だけ残す
        block["content"] = persist_large_output(block["tool_use_id"], str(block["content"]))
        total = sum(len(str(b["content"])) for b in blocks)
        if total <= max_bytes:
            break
    return messages
```

この段階は何も失わず、保存場所を変えるだけだ。モデルも呼ばず、数ミリ秒で終わる。モデルには保存先と冒頭が見え、必要なら後で完全な内容を読み戻せる。

ただし、処理するのは最新の結果群の大きさだけだ。メッセージが一件ずつ増え続ける問題は扱わない。

---

## 第 2 段階：snip_compact — 古い中間部分を取り除く

何ページもの下書きで役立つのは、多くの場合、両端だ。最初に課題と規則があり、最後に現在の計算がある。終わった途中の導出は場所を取るだけになる。

`snip_compact` は先頭と末尾を残し、中間の古いメッセージを抜き、その位置へ省略件数を一行で残す。

```python
def snip_compact(messages, max_messages=50):
    if len(messages) <= max_messages:   # 履歴が短ければ切らない
        return messages

    head = safe_head(messages, 3)                  # 先頭 3 件：元のタスク
    tail = safe_tail(messages, max_messages - 3)   # 末尾：現在の作業
    snipped = len(messages) - len(head) - len(tail)

    return head + [
        {"role": "user", "content": f"[snipped {snipped} messages]"}
    ] + tail
```

絶対に守る規則が一つある。`assistant` message の `tool_use` と対応する `tool_result` を分離してはいけない。分離すると、モデルには出所不明の結果が見え、API はリクエストを拒否する。そのため `safe_head` と `safe_tail` は単純な slice ではなく、対応関係の途中を避けるよう切断位置を動かす（実装は `code.py`）。

この段階はメッセージ数を減らす。しかし残したメッセージ内の古い `tool_result` は縮まない。30 KB のファイル内容は 30 KB のままだ。

---

## 第 3 段階：micro_compact — 古いツール結果をプレースホルダにする

Agent が十ファイルを連続して読んでも、比較中なのは最近の二、三個だけで、古いものはほとんど見返さない。しかも結果は再取得できる。ファイルはディスクにあり、コマンドも再実行できる。

`micro_compact` は最新の 3 件を完全なまま残し、それより古く、120 文字を超える結果を一行のプレースホルダへ変える。

![古い結果をプレースホルダに置換](images/micro-compact.svg)

```python
KEEP_RECENT = 3   # 最新 3 件は全文を残す

def micro_compact(messages):
    results = collect_tool_results(messages)

    # 古くて長い結果をプレースホルダへ置換
    for _, _, block in results[:-KEEP_RECENT]:
        if len(block.get("content", "")) > 120:
            block["content"] = "[Earlier tool result compacted. Re-run if needed.]"
    return messages
```

第 1 段階との違いに注意しよう。ディスクへの退避は完全な控えを残すが、プレースホルダは何も保存しない。置換した内容はコンテキストにも保存ファイルにもなく、もう一度見るにはツールを再実行する。ファイルやコマンド出力のように再生できるものなら、この代償は受け入れられる。

ここまでで、しまえるものをしまい、再生できるものを消した。モデルは一度も呼んでいない。それでもコンテキストが大きすぎるなら、残る方法は一つ、モデルに手伝わせることだ。

---

## 第 4 段階：compact_history — 整理しても足りないときだけ要約する

最初の三段階でも足りないときだけ実行する。完全な会話を保存し、モデルに要約させ、その要約で履歴を置き換える。

![LLM による全履歴要約](images/auto-compact.svg)

```python
def compact_history(messages):
    transcript_path = write_transcript(messages)  # 1 完全な会話を保存
    summary = summarize_history(messages)         # 2 モデルに要約させる
    return [{
        "role": "user",
        "content": f"[Compacted]\n\n{summary}",   # 3 履歴を要約で置換
    }]
```

要約 prompt は五種類の情報を残すよう求める。現在の目標、ユーザーの制約、重要な発見、変更したファイル、次の計画だ。

この段階は最も大きく空間を空ける一方、最も高くつく。不可逆であり、詳しい要約でも細部を失う。生成にはモデル呼び出しも必要だ。完全な履歴はディスクに残るが、以降のモデルが毎ターン見られるのは要約だけになる。要約にない細部は、モデルにとって一時的に存在しなくなる。

だから必ず最後に置く。最初の三段階で解決できるなら、ここへ来てはいけない。

---

## なぜ順序を変えられないのか

四段階の順序には二つの理由がある。

第一はコストと損失だ。退避は無損失、切り詰めは低損失、プレースホルダは再取得可能で、どれもモデルを呼ばない。要約は不可逆で、一回のモデル呼び出しも必要だ。安い処理を先に、高い処理を後にすれば、多くの場合、第 4 段階を実行せずに済む。

第二は厳格な依存関係だ。`tool_result_budget` は必ず `micro_compact` より先に走らなければならない。前者は全文をディスクへ残し、後者は一行だけを残して何も保存しない。`micro_compact` を先に動かし、最新の結果群が 3 件を超えていたら、超過分が先にプレースホルダへ変わる。その後 `tool_result_budget` が来ても、手元にはプレースホルダしかなく、保存すべき全文はもうない。

順序を逆にしてもエラーは出ない。「無損失」が静かに「損失あり」へ変わる。この種の問題は crash より見つけにくい。

---

## 緊急処理：reactive_compact — エラー後の救済

各呼び出し前に整理しても、`estimate_size` は推定であり、誤差がある。一回のツール出力が突然巨大になることもある。そのため API がなお `prompt_too_long` を返す場合がある。そのときは、より強い整理を一度だけ行う。完全な記録を保存し、最後の 5 メッセージだけを残し、それ以前を要約する。

```python
def reactive_compact(messages):
    write_transcript(messages)         # 完全な記録を保存
    tail = safe_tail(messages, 5)      # 対応関係を壊さず最後の 5 件を残す
    summary = summarize_history(messages[:len(messages) - len(tail)])

    return [{
        "role": "user",
        "content": f"[Reactive compact]\n\n{summary}",
    }] + tail
```

この経路はエラー後だけ使い、再試行は一回（`MAX_REACTIVE_RETRIES = 1`）に制限する。上限がなければ、失敗するたびに「要約の要約の要約」となり、情報を失い続け、最後にはモデル自身が何をしているかわからなくなる。一回で駄目なら停止してエラーを出し、人に確認を委ねる。

---

## Agent Loop へ戻す

```python
def agent_loop(messages):
    reactive_retries = 0
    while True:
        # モデル呼び出し前に三つの整理を実行（API 呼び出し 0 回）
        messages[:] = tool_result_budget(messages)   # 1 大きな結果を退避
        messages[:] = snip_compact(messages)         # 2 古い中間を切る
        messages[:] = micro_compact(messages)        # 3 古い結果をプレースホルダ化

        # 整理しても超過するときだけ要約（API 呼び出し 1 回）
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

        # ... ツールを実行し、結果を messages へ追加 ...
```

教学上の単純化を一つ明記しておく。`estimate_size` は `len(str(messages))` を物差しにし、実際の token ではなく文字数を数える。厳密な計数には tokenizer が必要だが、この章の仕組みを説明するには文字数で十分だ。教学版の `CONTEXT_LIMIT` も 50,000 文字と意図的に小さくし、自動要約が発生する様子を見られるようにしている。

---

## compact ツール：モデル自身に整理を申し出させる

ここまでの整理はプログラムが自動で発火する。もう一つ、モデルだけがわかる時機がある。タスクが新しい段階へ進み、前段階の細部が不要になったときだ。モデルが整理を申し出られるよう、`compact` ツールを与える。

```python
{"name": "compact",
 "description": "Summarize earlier conversation to free context space.",
 "input_schema": {"type": "object", "properties": {"focus": {"type": "string"}}}}
```

```python
if block.name == "compact":
    messages[:] = compact_history(messages)
    results.append({"type": "tool_result", "tool_use_id": block.id,
                    "content": "[Compacted. Conversation history has been summarized.]"})
    messages.append({"role": "user", "content": results})
    break   # このターンを終え、整理後のコンテキストで次へ進む
```

役割分担は明確だ。モデルは「今が整理の時機」と判断するだけで、実際の保存、要約、履歴置換はプログラムが行う。「整理したほうがよい」と手を挙げることと、本当に整理することは違う。

---

## 試してみる

```bash
cd learn-claude-code
python s08_context_compact/code.py
```

**実験 1：プレースホルダ。** 5 ファイルを続けて読ませる。

```text
Use read_file separately to read s01_agent_loop/README.md, s02_tool_use/README.md, s03_permission/README.md, s04_hooks/README.md, and s05_todo_write/README.md. Then say done.
```

続けて質問する。

```text
Without re-reading, quote the first heading of s01_agent_loop/README.md.
```

`KEEP_RECENT = 3` なので、5 件のうち最初の 2 件は `[Earlier tool result compacted. Re-run if needed.]` に変わっている。モデルは以前の結果が整理されたと答えるか、ファイルを読み直す。これが第 3 段階だ。

**実験 2：大きな結果の退避。** 700 KB を超えるファイルを読む。

```text
Use read_file to read web/src/data/generated/docs.json without a limit. Then say what kind of file it is.
```

結果は 200 KB の予算を超え、ディスクへ移される。二箇所を見る。`.task_outputs/tool-results/` に全文を含む `toolu_*.txt` が増え、モデルは preview とパスだけを受け取ったと述べる。これが第 1 段階だ。

**実験 3：自動要約。** 合計がしきい値を超える二ファイルを読む。

```text
Use read_file to read s08_context_compact/code.py and s09_memory/code.py without a limit. Then explain the main difference between them.
```

約 24.7K + 27.1K 文字で、教学版の `CONTEXT_LIMIT = 50000` を超える。二つ目を読んだ後、ターミナルに `[auto compact]` と `[transcript saved: ...]` が出て、モデルは `[Compacted]` で始まる要約から作業を続ける。完全な会話は `.transcripts/` に残る。

---

## 選択項目：本番システムでは prompt cache も考える

四段階の圧縮はこれで完成だ。実際の Claude Code には、設計へ大きく影響する別の制約がある。prompt cache だ。

下書き用紙の比喩に戻ろう。紙の最上部には最初から最後まで変わらない数行がある。「あなたは coding assistant」「これらのツールを使える」「この規則を守る」。毎回この固定部分を処理すれば時間も費用もかかる。モデル platform は、リクエスト先頭の安定した prefix を cache し、次回も完全に同じなら再利用できる。

Anthropic API では、cache hit 部分の読み取りは通常入力よりかなり安い。ただし最初の cache 書き込みには追加費用があり、期限もある。無料ではなく、「prefix が安定するほど繰り返し呼び出しが得になる」最適化だ。

cache は prefix が一字一句同じかを見るため、圧縮順序にも関係する。cache breakpoint より前を変えれば大抵 miss し、その後ろだけを変えれば前半を再利用できる可能性がある。そのため本番の圧縮は先頭をなるべく動かさない。

- 第 1 段階は最新の結果だけを扱い、先頭に触れない。
- 第 2 段階は最初のタスクと規則を残し、安定した prefix を保つ。
- 第 3 段階は再実行可能な古いツール内容を扱い、system prompt やツール定義を変えない。
- 第 4 段階は履歴構造全体を書き換え、cache への影響が最大なので最後にする。

厳密には「中間だけを変える」ことも cache hit を保証しない。breakpoint の位置、system prompt とツール定義の変更、prefix が完全一致するかで決まる。それでも「まず末尾と中間を整理し、最後に履歴を書き換える」ことには、情報を失いにくい以外の実務上の利点がある。安定 prefix を長く生かし、不要な無効化を避けられる。

教学版は API レベルの cache も breakpoint 計算も実装しない。観察しやすいコードで取捨選択を示すだけだ。実際の Claude Code はもっと多くの層、fallback、cache 最適化を持つが、下の論理は同じである。要約より整理を先にし、復元可能な情報を守ってから不可逆な要約へ進む。

---

## s07 からの変更

| コンポーネント | s07 | s08 |
|----------------|-----|-----|
| コンテキスト管理 | なし | モデル呼び出し前に毎回整理 |
| ツール結果 | 永久にコンテキストへ残る | 大きな結果を退避し、古い結果をプレースホルダ化 |
| メッセージ履歴 | 増え続ける | 古い中間履歴を削除可能 |
| 上限超過 | リクエスト失敗 | まず整理し、足りなければ要約 |
| 新しいツール | なし | `compact` |

---

## まとめ

この章の原則は一つだけだ。

> 整理できるものはまず整理する。再取得できるものは要約しない。それでも足りないときだけ、モデルに履歴を要約させる。

四つの関数が四段階を実装するが、背後の順序は同じだ。無損失を先に、モデル呼び出し不要の処理を先にし、損失と費用がある処理を最後にする。これで Agent は自分の履歴に押し潰されなくなる。

ただし解決したのは「下書き用紙が足りない」問題だけだ。何度も発見し直さず、長期に残したい情報もある。何を、どう残すべきかを s09 で扱う。

<!-- translation-sync: zh@v6, en@v6, ja@v6 -->
