# s21: Workflow Runtime — モデルが単一 step を決め、script が orchestration を決める

[中文](README.zh.md) · [English](README.md) · [日本語](README.ja.md)

s01 → ... → s19 → s20 → `s21`

> *「1 回の tool_use で、バックグラウンドに一式の orchestration を走らせる」* — `Workflow` ツールが決定的で復元可能な script runtime を起動し、多数の subagent をまとめて送り出します。
>
> **Harness 層**: Orchestration — single-agent loop の上に、決定的な multi-agent script runtime を追加します。

---

s01 から s20 まで、loop は常にモデル駆動で 1 step ずつ進みました。各ラウンドでモデルが 1 つのツールを選び、結果を `messages[]` へ入れ、次のラウンドへ進みます。open-ended なタスクには最適です。次に何をするかを、モデルが context を見てその場で決められます。

しかし、複数の Agent を決定的に指揮したい仕事もあります。大きな変更の review を考えてください。10 の観点から並行して問題を探す → 各 finding へ別 Agent を送り adversarial verification を行う → 結果を集約して重複を除く → severity 順に並べる。この流れの形は固定されており、本当に必要なのは 3 つです。

- **並行性**: 1 件ずつ順番に待たないこと。
- **決定性**: 同じ入力から同じ結果構造が得られること。
- **復元可能性**: 途中で止まっても、完了済みの部分を最初からやり直さないこと。

この流れをモデルに main loop で 1 ラウンドずつ動かさせると、遅く、結果は不確定で、中断すれば最初からです。ここで必要なのは「もう 1 turn 話す」ことではなく、orchestration をそのままコードにすることです。

## 計画は chat のラウンドを重ねず、コードに書く

Claude Code の tool pool には `Workflow` ツールがあります。あなたが渡すか、モデルが high-intensity mode で起動した script は、`agent() / parallel() / pipeline() / phase()` という少数の primitive を使い、orchestration を決定的なコードとして表します。

main loop から見えるのは 1 回の `tool_use` だけで、すぐ「バックグラウンドで起動済み」という結果を受け取ります。本当の実行は background runtime で進み、進捗をリアルタイムに報告し、全過程をディスク上の journal へ記録します。script の中間結果は変数に保存され、会話履歴の場所を取りません。`resumeFromRunId` で再開すると、変更されていない `agent()` は journal cache に当たり、以前の結果を直接使って checkpoint から続行します。

![Workflow Runtime Overview](images/workflow-runtime-overview.svg)

```python
SAMPLE_META = {"name": "review-changes", "description": "コード変更を review", "phases": ["Review", "Verify"]}

async def sample_workflow(ctx, args):
    ctx.phase("Review")
    results = await ctx.pipeline(DIMENSIONS, audit, verify)   # 各 dimension が独立して audit → verify を通る
    confirmed = [f for r in results if r for f in r["confirmed"]]
    ctx.log(f"{len(confirmed)} 件の実在する問題を確認")
    return {"confirmed": confirmed}
```

## Workflow ツール: バックグラウンド起動、main loop には 1 回の call だけ

`Workflow`（別名 `RunWorkflow`）は main Agent の tool pool にあります。明示的に「この workflow を実行」と頼む、保存済みの `/command` を使う、またはモデルが自動で high-intensity path へ入ると、モデルが `Workflow(...)` の tool call を出します。

ツールは argument を parse し、meta 情報を検証し、permission check を通し、local workflow task を登録すると、すぐ「非同期で起動済み」と返します。main loop は block せず別の仕事を続け、workflow は background で実行されます。これは s13 の引換券 pattern を拡大したものです。先に引換券を渡し、結果ができたら通知します。

```python
class WorkflowTool:
    async def call(self, meta, script_fn, args=None, resume_from_run_id=None):
        validate_meta(meta)
        check_permission(meta)
        run_id = resume_from_run_id or create_run_id(meta)
        task = LocalWorkflowTask(create_task_id(run_id), run_id, meta)
        task.event("async_launched", runId=run_id, taskId=task.task_id)   # すぐ return
        ...                                                                # 残りはバックグラウンドで進む
```

> 実際の Claude Code は `{status:'async_launched', taskId, taskType:'local_workflow', runId, summary, transcriptDir, scriptPath}` をすぐ返し、background task の完了後に通知します。

## Script と meta: 1 行目を正しく書く

script の 1 行目は必ず `export const meta = { name, description, phases }` とし、変数、関数呼び出し、文字列連結を含まない純粋な literal でなければなりません。runtime はコードを一切実行する前に parse します。`name` と `description` は task と UI の表示に使い、`phases` は progress bar の group 名を定義します。

不正な入力はすぐ `WorkflowInputError` になり、登録時に止まります。s14 の cron 式検証と同じ考えです。不正な script が実行時まで進んでから壊れないようにします。

```python
def validate_meta(meta):
    if not meta.get("name") or not meta.get("description"):
        raise WorkflowInputError("meta には name と description が必要です")
    if "phases" in meta and not isinstance(meta["phases"], list):
        raise WorkflowInputError("meta.phases は list でなければなりません")
    return meta
```

> 実際の Claude Code の `parseWorkflowScript` は、meta を 1 行目の純粋な literal に限定します。教材版は dict を直接受け取り、この部分を簡略化しています。

## Orchestration primitive: この少数だけで、すべての flow を書ける

script は独立した context で動き、global variable として使えるのは少数の orchestration primitive だけです。script 自身はファイルを直接読み書きせず、shell も実行しません。実際のコード操作は、派遣された subagent が自分の tool permission で行います。primitive はすべて `ExecutionState` の method です。

| Primitive | 役割 |
|------|------|
| `agent(prompt, {schema, label, phase})` | 1 つの subagent を派遣 |
| `parallel(thunks)` | **barrier**: すべての task を並行実行し、全結果が戻るまで待つ |
| `pipeline(items, *stages)` | 各 item を **barrier なし**で stage ごとに実行し、終わった item から先へ進める |
| `phase(title)` | 現在の progress phase を記録し、progress bar を更新 |
| `log(message)` | progress log を 1 行出力 |
| `workflow(name, args)` | nested sub-workflow（1 階層だけ） |

既定では `pipeline` を使うべきです。各 item がすべての stage を独立して通り、item A が stage 3 にいる間、item B はまだ stage 1 かもしれません。次の stage へ進むために前 stage の全結果が本当に必要なときだけ、`parallel` barrier を使います。barrier は最も遅い task を待つため、不要なら置かないでください。

```python
async def pipeline(self, items, *stages):
    async def run_item(item, idx):
        value = item
        for stage in stages:                       # 各 item がすべての stage を独立して完走
            value = await stage(value, item, idx)
        return value
    return await asyncio.gather(*[run_item(it, i) for i, it in enumerate(items)])
```

> 実際の Claude Code は同名 primitive を script VM の context へ注入します。さらに `args`、total/spent/remaining を持つ `budget`、最大 1000 Agent の上限、concurrency semaphore も提供します。

## 構造化出力: Subagent に散文を返させない

`agent({schema})` は、schema に一致する JSON object を subagent に要求します。内部では structured output call を 1 回使い、runtime が結果を schema で検証し、不一致なら 1 回 retry します。下流コードが受け取るのは規則的な object であり、再 parse が必要な長文ではありません。

s05 では tool argument を全面的に信頼できないと説明しました。ここでは同じ教訓を逆向きに使います。subagent の出力も全面的には信頼できません。orchestration boundary で検証し、1 回 retry の機会を与え、不確実性を後続 flow の外へ止めます。

```python
result = self.runner.run(prompt, schema, label)
if schema is not None:
    ok, err = SimpleJsonSchema(schema).validate(result)
    if not ok:                                       # 1 回だけ注意して retry、それでも不正なら error
        result = self.runner.run(prompt + "\n\n有効な JSON を返してください。", schema, label)
        ok, err = SimpleJsonSchema(schema).validate(result)
        if not ok:
            raise WorkflowInputError(f"agent({{schema}}) の出力が不正です: {err}")
```

> 実際の Claude Code は `SimpleJsonSchema`、`StructuredOutput` ツール、schema-aware retry を組み合わせ、出力形式を保証します。

## Background task と progress event

`LocalWorkflowTask` は status と token usage を管理し、SDK style の event stream を外へ出します。`task_started` → phase change、subagent start、log batch を含む一連の `task_progress` → 完了、失敗、停止に加え、output file、token 数、tool call 数、所要時間を含む最後の `task_notification` です。

main session は通常 event として処理し、最後の完了通知だけが main loop へ再び入ります。

```python
class LocalWorkflowTask:
    def progress_event(self, ptype, **data):         # phase/subagent/log
        self.progress.append({"type": ptype, **data})
        print(f"  progress   {ptype} ...")
```

> 実際の Claude Code は進捗を task state へまとめ、`task_progress.workflow_progress` として UI と SDK へ送ります。

## 保存: Snapshot + journal で中断から再開する

各 run は `~/.claude/projects/<project>/<session>/` に 5 種類を書きます。`<runId>.json` snapshot、`<runId>.output.json` output、`<runId>.journal.jsonl` journal、`scripts/<runId>.js` の script copy、`subagents/workflows/<runId>/` の subagent transcript です。保存した再利用可能な workflow は project scope の `.claude/workflows/` または user scope の `~/.claude/workflows/` に置きます。

journal は checkpoint resume の中心で、各 `agent()` の結果を 1 行ずつ記録します。

```python
class WorkflowJournal:
    def record(self, key, value):
        self._f.write(json.dumps({"key": key, "value": value}) + "\n")
        self._f.flush()
        self.cache[key] = value
```

## Resume: runId から続行し、変更のないものを再利用する

`Workflow({scriptPath, resumeFromRunId, args})` を呼ぶと script を再実行しますが、各 `agent()` は決定的な semantic key を計算します。journal に key があれば、再実行せず cached result を返します。変更のない call はすべて cache hit し、変更された call とそれに依存する後続 step だけが本当に動きます。

key は concurrency の完了順に依存してはいけません。`parallel` と `pipeline` の Agent は不定の順番で完了します。「何番目に完了したか」を key にすると、次回の cache が別の call へ対応してしまいます。そのため key は競合する counter ではなく、call の内容、つまり type、label、prompt、schema の stable hash です。

```python
def key(self, kind, label, prompt, schema):
    basis = f"{kind}|{label}|{prompt}|{json.dumps(schema, sort_keys=True)}"
    return f"{kind}-{_stable_hash(basis) % 10**10:010d}"

# agent() の内部:
cached = self.journal.cached(key)
if cached is not MISS:
    self.task.progress_event("workflow_agent", label=label, status="cached")
    return cached
```

> 実際の Claude Code も「決定的 semantic key + journal cache」という考えです。同じ session で resume すると、完了済み `agent()` は cached result を直接返し、その後だけを実行します。

## 決定性: Resume に意味を持たせる再現性

resume が動くには、まず script が再現可能でなければなりません。runtime は `Date.now()`、引数なしの `new Date()`、`Math.random()` などの非決定的なものを script context から取り除き、Node native API も渡しません。同じ script + 同じ argument → 同じ key → 100% cache hit になります。教材版は stable hash で同じ性質を得ます。実際の版は、非決定的な source を除いた sandbox VM で JavaScript 全体を実行します。

## 実際に動かす

sample workflow `review-changes` は `pipeline` を使い、各 review dimension を独立して audit → verify へ通します。audit では schema 付き `agent()` が問題を探し、verify では `parallel()` が各 finding に別の adversarial verification subagent を送ります。実在すると確認された問題だけを残し、severity 順に並べます。

```python
async def sample_workflow(ctx, args):
    ctx.phase("Review")

    async def audit(_v, dimension, _i):
        out = await ctx.agent(f"変更されたコードに {dimension} 関連の問題がないか確認してください",
                              schema=FINDINGS_SCHEMA, label=f"audit:{dimension}", phase="Review")
        return {"dimension": dimension, "findings": out["findings"]}

    async def verify(audited, dimension, _i):
        ctx.phase("Verify")
        verdicts = await ctx.parallel([                       # 各 finding を独立して verify
            (lambda f=f: ctx.agent(f"この問題が実在するか adversarial に検証してください: {f['title']}",
                                   schema=VERDICT_SCHEMA, label=f"verify:{dimension}:{f['title']}"))
            for f in audited["findings"]])
        return {"dimension": dimension,
                "confirmed": [f for f, v in zip(audited["findings"], verdicts) if v and v["isReal"]]}

    results = await ctx.pipeline(DIMENSIONS, audit, verify)
    ...
```

## s20 からの変更点

| | s20 Comprehensive Agent | s21 Workflow Runtime |
|--|-----------|---------------------|
| loop | 1 つ、モデル駆動 | main loop は不変。その上に決定的 orchestration を追加 |
| 次の step を決めるもの | モデルが毎ラウンド判断 | script が orchestration flow を事前に定義 |
| multi-agent | s06 subagent を一度だけ派遣 | script 化された、再現可能で復元可能な一括 orchestration |
| 新しい仕組み | — | script DSL、background task、progress event、journal/resume、structured output、deterministic VM |

s21 は main loop を置き換えません。tool layer に `Workflow` を公開し、背後で local workflow runtime を起動します。1 つの workflow が N 個の Agent loop を決定的に駆動します。s06 の subagent はモデルがその場で 1 回派遣し、s21 は orchestration を replay 可能な script にします。

## 試してみる

```bash
python s21_workflow_runtime/code.py          # review-changes を起動し、event stream を確認
python s21_workflow_runtime/code.py resume   # 前回の runId から resume。すべての agent() が journal cache に当たる
```

1 回の起動から `async_launched`、background の phase change と subagent progress、最後の `task_notification` までを観察してください。結果は task object に保存されます。resume 時はすべて cache hit するため `agents=0 tokens=0` と表示され、結果は前回と 1 byte も違いません。

## 次へ

orchestration は Agent 能力の上にもう 1 層を加えます。main loop は個々の操作を管理し、script はチーム全体の flow を管理します。仕事が決定的で復元可能な script になると、モデルは「ラウンドごとの driver」から「script に schedule される実行 unit」へ変わります。同じ `agent()` を main loop でモデルがその場で呼ぶことも、workflow 内で script がまとめて編成することもできます。

次へ: [s22 Goal Loop](../s22_goal_loop/) — Orchestration は仕事を fan-out し、main loop から離れます。次章は逆に、1 つの goal が control を main loop へ引き戻し、objective が達成されるまで turn の終了を認めません。

<!-- translation-sync: zh@v2, en@v2, ja@v2 -->
