# s08: Context Compact — コンテキストはいつか満杯になる、場所を空ける方法が必要

[中文](README.zh.md) · [English](README.md) · [日本語](README.ja.md)

s01 → s02 → s03 → s04 → s05 → s06 → s07 → `s08` → [s09](../s09_memory/) → s10 → ... → s20
> *"Context will fill up — have a way to make room"* — 4層圧縮戦略、安価なものを先に、高価なものを後に実行。
>
> **Harness レイヤー**: 圧縮 — コンテキスト超過時に自動要約し、セッションを持続可能に保つ。

---

## 課題

前章で Agent に Skills を加えた。少し「領域経験」を持ち始め、PDF や MCP、コードレビューに出くわすと、対応する操作説明を先に読み込んでから動くようになった。

だが Agent が仕事をこなせるほど、別の問題が目立ってくる。1000 行のファイルを 1 つ読めば ~4000 token、さらに 30 個のファイルを読み、20 個のコマンドを走らせる。コマンドの出力もファイルの内容も、すべて `messages` リストに戻され、少しずつ積み上がる。

普通のチャットなら数十ターンは何でもない。コードエージェントは違う。一度の読み取りが数千行、一度のテストが大量のログだ。タスクが終わらないうちに、コンテキストウィンドウが先に満杯になりかねない。

満杯になると、問題は「モデルの答えが少し悪い」ではない。API がリクエストを直接拒否する：`prompt_too_long`。圧縮しなければ、Agent は大きなプロジェクトでまともに動けない。

---

## ソリューション

![Compact Overview](images/compact-overview.svg)

s07 の hook 構造、skill ロード、サブエージェントの骨格は残し、この章では一層だけ加える。LLM を呼ぶ前に、まず `messages` を整える。

いちばん素直な発想は、満杯になったらモデルに要約させることだ。だがここには 2 つの問題がある。1 つ目、要約は API 呼び出しを 1 回余分に使う。コンテキストが大きくなるたびに要約していては、コストがすぐ膨らむ。2 つ目、すべての内容が要約に値するわけではない。古いツール結果の多くはとっくに不要だし、ただ大きいだけの内容もある。たとえば `cat` が数百 KB のログを吐いた場合、それは「理解」される必要はなく、コンテキストから外して必要なときに読み直せばいい。

だから compact は 1 つの動作ではなく、1 本のパイプラインだ。**安いものを先に、高いものを後に**。まずモデルを呼ばないローカルな整理を数ステップ走らせる。切れるものは切り、プレースホルダにできるものは置き換え、ディスクに退避できるものは退避する。それでも足りないときに初めて、LLM に本当の要約をさせる。

---

## 仕組み

![4層圧縮パイプライン](images/compaction-layers.svg)

### L1: snip_compact — 無関係な古い会話を切り捨て

Agent が 80 ターン走り、`messages` は 160 件たまった。先頭の「hello.py を作って」は今の作業とほぼ無関係になっているが、まだ場所を占めている。

メッセージ数が 50 を超えたら → 先頭 3 件（最初のタスクと制約）と末尾 47 件（今の作業）を残し、中間を切る。気をつける境界は 1 つだけ：`assistant(tool_use)` とその後ろの `user(tool_result)` を切り離してはいけない。さもないとモデルは、どの呼び出しに対応するか分からない孤立した結果を見ることになる。

```python
def snip_compact(messages, max_messages=50):
    if len(messages) <= max_messages: return messages
    keep_head, keep_tail = 3, max_messages - 3
    head_end, tail_start = keep_head, len(messages) - keep_tail
    if head_end > 0 and _message_has_tool_use(messages[head_end - 1]):
        while head_end < len(messages) and _is_tool_result_message(messages[head_end]):
            head_end += 1
    if (tail_start > 0 and tail_start < len(messages)
            and _is_tool_result_message(messages[tail_start])
            and _message_has_tool_use(messages[tail_start - 1])):
        tail_start -= 1
    if head_end >= tail_start: return messages
    snipped = tail_start - head_end
    return messages[:head_end] + [{"role": "user", "content": f"[snipped {snipped} messages]"}] + messages[tail_start:]
```

切るのはメッセージそのもので、切れ目に保護を 1 つ入れるだけだ。だが残ったメッセージの中では、`tool_result` の内容がまだ積み上がっている。34 番目のメッセージには 30KB の古いファイル内容が眠っているかもしれない。メッセージ数は減っても、token は減っていない。→ L2。

### L2: micro_compact — 古いツール結果をプレースホルダに置換

![古い結果のプレースホルダ化](images/micro-compact.svg)

コンテキストを膨らませる最大の原因は、会話そのものよりツール結果であることが多い。Agent が 10 個のファイルを続けて読んだとして、1 番目から 7 番目までの完全な内容はとっくに不要なのに、そのままコンテキストに居座っている。

直近 3 件の `tool_result` の完全な内容を残し、それより古いものは 1 行のプレースホルダに置き換える。発想は素朴だ。古い結果が本当に要るなら、モデルがもう一度読めばいい。ずっと場所を占めるべきではない。

```python
KEEP_RECENT = 3

def micro_compact(messages):
    tool_results = collect_tool_results(messages)
    if len(tool_results) <= KEEP_RECENT: return messages
    for _, _, block in tool_results[:-KEEP_RECENT]:
        if len(block.get("content", "")) > 120:
            block["content"] = "[Earlier tool result compacted. Re-run if needed.]"
    return messages
```

古い結果は片付いたが、まだ防げないケースがある。1 件の新しい結果だけで 500KB になることだ。大きなファイルを `cat` した出力 1 つでコンテキストを使い切ってしまう。しかもそれは新しすぎて、micro_compact は手を付けない。→ L3。

### L3: tool_result_budget — 大きな結果をディスクに退避

![大きな結果のディスク退避](images/layer1-budget.svg)

結果には「多い」ではなく「1 件が大きすぎる」ものもある。モデルが大きなファイルを一度に 5 つ読み、最後の user メッセージ内の `tool_result` が合計 200KB を超える。こうなると直近 3 件を残しても無駄だ。最新の 1 件だけでコンテキストを使い切れるからだ。

ツール結果に予算を設ける。最後の user メッセージ内のすべての `tool_result` の合計サイズを数え、200KB を超えたら大きいものから `.task_outputs/tool-results/` に退避し、コンテキストには `<persisted-output>` マーカーと先頭 2000 文字のプレビューだけを残す。モデルはマーカーを見れば完全な内容がディスク上にあると分かり、必要なときに読み戻せる。

```python
def tool_result_budget(messages, max_bytes=200_000):
    last = messages[-1] if messages else None
    if not last or last.get("role") != "user" or not isinstance(last.get("content"), list): return messages
    blocks = [(i, b) for i, b in enumerate(last["content"])
              if isinstance(b, dict) and b.get("type") == "tool_result"]
    total = sum(len(str(b.get("content", ""))) for _, b in blocks)
    if total <= max_bytes: return messages
    ranked = sorted(blocks, key=lambda p: len(str(p[1].get("content", ""))), reverse=True)
    for _, block in ranked:
        if total <= max_bytes: break
        block["content"] = persist_large_output(block.get("tool_use_id", "unknown"), str(block.get("content", "")))
        total = sum(len(str(b.get("content", ""))) for _, b in blocks)
    return messages
```

ここで大事なのは捨てることではない。内容を「アクティブなコンテキスト」から「復元可能な外部ストレージ」へ移すことだ。これで最初の 3 層がそろう：純粋なテキスト/構造の操作、API 呼び出し 0、それぞれが 1 種類の冗長さを見張る。だが共通の限界がある：会話が何の話か読めない。どの発見が重要か、どの制約を残すべきか分からない。それでもコンテキストが大きすぎるなら、モデルに出てもらうしかない。→ L4。

### L4: compact_history — LLM 全量要約

![LLM 全量要約](images/auto-compact.svg)

3 層を走らせ切っても、token はまだ閾値を超える。この一手こそ、多くの人が直感的に思い描く「コンテキスト圧縮」だ。履歴をモデルに渡し、より短い状態に要約させる。

3 ステップ。まず完全な会話を `.transcripts/`（JSONL）に書き出す。アクティブなコンテキストには要約だけが残るが、ディスクには完全な記録が残る。次に LLM に要約を生成させ、現在の目標、重要な発見、変更済みのファイル、残りの作業、ユーザーの制約を保持するよう求める。最後にこの 1 件の要約で古いメッセージをすべて置き換える。

```python
def compact_history(messages):
    transcript_path = write_transcript(messages)   # 先に完全な会話を保存
    summary = summarize_history(messages)            # LLM が要約を生成
    return [{"role": "user", "content": f"[Compacted]\n\n{summary}"}]
```

この一手はロッシー（不可逆）だ：transcript には完全な履歴があるが、モデルは今やその細部を見られず、要約だけを頼りに続ける。だから先に L1/L2/L3 を走らせる：モデルに要約させずに済むなら済ませる。いったん要約に入れば、細部は取り返しなく失われるからだ。教学版にはサーキットブレーカーも加えてある：compact が 3 回連続で失敗したら止め、API 呼び出しを無限に浪費しない。

### 緊急: reactive_compact

通常は、モデルを呼ぶ前にコンテキストを整えておく。だがコンテキストの増加が速すぎたり、token の見積もりがずれたりすると、API はやはり `prompt_too_long` を返しうる。

このとき reactive_compact に入る。compact_history によく似ているが、より激しい：先に transcript を保存し、前半の大部分を要約し、末尾 5 件だけを末尾コンテキストとして残す（こちらも孤立した `tool_result` を残さないようにする）。

```python
def reactive_compact(messages):
    transcript = write_transcript(messages)
    tail_start = max(0, len(messages) - 5)
    if (tail_start > 0 and tail_start < len(messages)
            and _is_tool_result_message(messages[tail_start])
            and _message_has_tool_use(messages[tail_start - 1])):
        tail_start -= 1
    summary = summarize_history(messages[:tail_start])
    return [{"role": "user", "content": f"[Reactive compact]\n\n{summary}"}, *messages[tail_start:]]
```

reactive は通常パスではなくフォールバックだ。デフォルトでは 1 回だけリトライし、もう一度失敗したら無限ループせず例外を投げる。完全なエラー回復ロジックは s11 に譲る。

### 合わせて実行

これらを Agent Loop に戻して組み込む。各ラウンドで LLM を呼ぶ前に 3 層のローカル整理を走らせ、足りなければ要約し、呼び出しが実際にエラーになったら緊急パスに回る。

```python
def agent_loop(messages):
    reactive_retries = 0
    while True:
        # 3 つの前処理（API 呼び出し 0）、順序：budget -> snip -> micro
        messages[:] = tool_result_budget(messages)    # L3: 大きな結果を退避
        messages[:] = snip_compact(messages)          # L1: 中間を切る
        messages[:] = micro_compact(messages)         # L2: 古い結果をプレースホルダ化

        if estimate_size(messages) > CONTEXT_LIMIT:   # まだ足りない -> LLM 要約（API 1 回）
            messages[:] = compact_history(messages)

        try:
            response = client.messages.create(model=MODEL, system=SYSTEM, messages=messages, tools=TOOLS, max_tokens=8000)
        except Exception as e:
            if "prompt_too_long" in str(e).lower() and reactive_retries < MAX_REACTIVE_RETRIES:
                messages[:] = reactive_compact(messages)   # 緊急
                reactive_retries += 1
                continue
            raise
        # ... ツール実行 ...
```

**順序は変えられない。** L3（budget）は L2（micro）より前でなければならない：micro は古い大きな `tool_result` を 1 行のプレースホルダに置き換えるので、もし先に走れば budget が完全な内容を退避する機会を失う。先に budget で大きな内容を保存し、それからプレースホルダ化と切り捨てを行う。これが Claude Code のソースが `applyToolResultBudget` を最前に置く理由でもある。

### compact ツール — モデルからも要求できる

自動圧縮のほかに、モデル自身が整理を要求することもできる。コンテキストが長すぎる、あるいはタスクの段階が切り替わったと感じたとき、モデルは能動的に `compact` ツールを呼べる。教学版ではこのツールが `compact_history` をトリガーし、現在の turn を終え、圧縮後のコンテキストで新たな 1 ラウンドを始める。手動の `/compact` によく似ているが、違いは今回モデル自身が整理どきだと気づいた点だ。

---

## s07 からの変更点

| コンポーネント | 変更前 (s07) | 変更後 (s08) |
|------|-----------|-----------|
| コンテキスト管理 | なし（無制限に膨張） | 4 層圧縮パイプライン + 緊急 |
| 新しい関数 | — | snip_compact, micro_compact, tool_result_budget, compact_history, reactive_compact |
| ツール | bash, read, write, edit, glob, todo_write, task, load_skill (8) | 8 + compact (9) |
| ループ | LLM 呼び出し → ツール実行 | 各ラウンド前に 3 層の前処理 + 閾値で compact_history を起動 |
| 設計原則 | Agent を仕事できるように | Agent が長く走っても崩れないように |

この一手は「能力」を加えるというより「体力」を加えるに近い：s07 は Agent を専門的な作業に強くし、s08 は長いタスクで自分の履歴に押しつぶされないようにする。

---

## 試してみよう

```sh
cd learn-claude-code
python s08_context_compact/code.py
```

次の prompt を試してみよう：

1. `Read the file README.md, then read code.py, then read s01_agent_loop/README.md`（複数ファイルを続けて読み、L2 が古い結果を圧縮する様子を観察）
2. `Read every file in s08_context_compact/`（一度に大量に読み、L3 のディスク退避を観察）
3. 会話を 20 ターン以上続け、`[auto compact]` や `[reactive compact]` が出るか観察

観察ポイント：各ツール実行後、古い `tool_result` は置き換えられるか？大きな出力は退避されるか？token が閾値を超えたとき、要約は生成されるか？

---

## 次へ

圧縮のおかげで Agent は長く走っても崩れない。だが圧縮のたびに細部がいくらか失われる：ユーザーが前に述べた好み、プロジェクトの長期的な制約、複数のタスクにまたがって重要な情報。どれも要約に完全に残る保証はない。

compact が答えるのは「今のセッションがもうすぐ満杯だ、どう走り続けるか」だ。「どの情報を長く残す価値があるか」には答えない。

s09 Memory → 3 つのサブシステム：何を覚えるか選ぶ、重要な情報を抽出する、整理して定着させる。圧縮をまたぎ、セッションをまたいで。

<details>
<summary>Claude Code ソースコードの詳細</summary>

> 以下は Claude Code ソースコード `compact.ts`、`autoCompact.ts`、`microCompact.ts`、`query.ts` の分析に基づく。

### 実行順序の対応

教学版は説明の便宜上 L1/L2/L3/L4 と番号を振っているが、実際の実行順序は番号と完全には一致しない：

| 項目 | 教学版 | Claude Code |
|------|--------|-------------|
| 実行順序 | budget → snip → micro → auto | budget → snip → micro → collapse → auto（`query.ts:379-468`） |
| snip_compact | 先頭 3 + 末尾 47 を保持 | Claude Code はメインスレッドのみ有効；実装はオープンソースリポジトリにない（`HISTORY_SNIP` feature gate）、インターフェースは確認可能：`snipCompactIfNeeded(messages)` → `{ messages, tokensFreed, boundaryMessage? }`、`SnipTool` もモデルが能動的に呼び出し可能。教学版の 3/47 は簡略パラメータ |
| micro_compact | テキストプレースホルダで置換 | 2 つのパス：time-based は直接内容をクリア、cached は API の `cache_edits` を使用（legacy パスは削除済み） |
| micro_compact ホワイトリスト | 位置による（直近 3 件） | time-based は時間閾値でトリガー、cached はカウントでトリガー（`microCompact.ts`） |
| tool_result_budget | 200KB 文字 | 200,000 文字（`toolLimits.ts:49`） |
| compact_history 閾値 | 文字数で推定 | 精密な token 数：`contextWindow - maxOutputTokens - 13_000` |
| 要約の要求 | 5 種類の情報 | 9 つのセクション + `<analysis>`/`<summary>` デュアルタグ |
| 圧縮プロンプト | シンプルなプロンプト | 先頭と末尾に二重の安全ガードでツール呼び出しを禁止 |
| PTL retry | あり（簡略版） | `truncateHeadForPTLRetry()` がメッセージグループ単位でロールバック（`compact.ts:243-290`） |
| 圧縮後のリカバリ | なし（教学版は要約のみ保持） | 直近のファイル、計画、agent/skill/tool などの自動再付加 |
| サーキットブレーカー | 3 回 | 3 回（`autoCompact.ts:70`） |
| reactive リトライ | 1 回 | Claude Code にはより精緻な段階別リトライがある |

### 実行順序の詳細

Claude Code ソース `query.ts` での実際の順序：

1. `applyToolResultBudget`（L379）：まず大きな結果を処理し、完全な内容を退避
2. `snipCompact`（L403）：中間メッセージを切り捨て
3. `microcompact`（L414）：古い結果のプレースホルダ化
4. `contextCollapse`（L441）：独立したコンテキスト管理システム（教学版にはなし）
5. `autoCompact`（L454）：LLM 全量要約

教学版の budget → snip → micro の順序はこれと一致する。教学版には contextCollapse メカニズムがない。

### read_file のトレードオフ

教学版の `micro_compact` は、古い `tool_result` を一律にプレースホルダへ置き換える。`read_file` も例外ではない。これは通常、機能的な正しさには影響しない。後でファイル内容が必要になれば、モデルはもう一度そのファイルを読めばよい。代償は、追加のツール呼び出しが発生し得ることと、prompt cache のヒット率が下がり得ること。

Claude Code は、この問題を教学版のような単純なルールでは処理していない。`Read` も microcompact 可能なツール集合に入れる一方で、別途 `readFileState` を維持している。変更されていないファイルの再読込では `FILE_UNCHANGED_STUB` を返し、compact 後には予算内で直近に読んだファイル内容を復元する（例：最大 5 ファイル、1 ファイル 5K token、合計 50K token）。これは本番実装向けのキャッシュと復元メカニズムである。教学版ではそこまで展開せず、「古い結果を圧縮し、必要なら再読込する」という単純な trade-off を残している。

### 完全な定数リファレンス

| 定数 | 値 | ソースファイル |
|------|-----|--------|
| `AUTOCOMPACT_BUFFER_TOKENS` | 13,000 | `autoCompact.ts:62` |
| `MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES` | 3 | `autoCompact.ts:70` |
| `MAX_OUTPUT_TOKENS_FOR_SUMMARY` | 20,000 | `autoCompact.ts:30` |
| `POST_COMPACT_TOKEN_BUDGET` | 50,000 | `compact.ts:123` |
| `POST_COMPACT_MAX_FILES_TO_RESTORE` | 5 | `compact.ts:122` |
| `POST_COMPACT_MAX_TOKENS_PER_FILE` | 5,000 | `compact.ts:124` |
| 時間ベース micro_compact 間隔 | 60 分 | `timeBasedMCConfig.ts` |
| `MAX_COMPACT_STREAMING_RETRIES` | 2 | `compact.ts:131` |

### contextCollapse と sessionMemoryCompact

Claude Code ソースコードには、この教学版では展開していない 2 つのメカニズムが存在する：

- **contextCollapse**：独立したコンテキスト管理システム。有効時には proactive autocompact を抑制し（`autoCompact.ts:215-222`）、collapse の commit/blocking フローがコンテキスト管理を引き継ぐ。ただし manual `/compact` と reactive fallback は独立パスのままで、contextCollapse の影響を受けない。
- **sessionMemoryCompact**：compact_history の前に、Claude Code は既存の session memory（s09 で解説）を使った軽量要約を先に試みる。LLM を呼び出さない。このメカニズムは s09 を学んだ後に振り返るとより理解しやすい。

### 圧縮プロンプトの中身

Claude Code の圧縮プロンプトには 2 つの厳格な要件がある：

1. **ツール呼び出しの絶対禁止**：冒頭が `CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.` で、末尾にも再度 REMINDER がある
2. **先に分析してから要約**：モデルはまず `<analysis>` タグで思考を整理し、その後 `<summary>` タグで正式な要約を出力する。analysis はフォーマット時に除去される

### 教学版の簡略化は意図的

- micro_compact でテキストプレースホルダを使用 → API 層の `cache_edits` 権限がないため
- read_file は特別扱いしない → 教学版では必要時の再読込を受け入れ、readFileState と圧縮後復元の仕組みを導入しない
- token を文字数で推定 → 精密な tokenizer は教学の対象外
- 圧縮後のリカバリを省略 → 教学版は要約のみを保持し、ファイルの自動再付加を行わない
- 2 つの補助メカニズムを展開しない → 10% の細部に属する

コア設計思想は完全に保持されている。

</details>

<!-- translation-sync: zh@v3, en@v3, ja@v3 -->
