# s21: Workflow Runtime：モデルが単一の判断を行い、script が全体の進行を決める

[中文](README.zh.md) · [English](README.md) · [日本語](README.ja.md)

s01 → ... → s19 → s20 → `s21`

> *「一つの仕事をどう進めるかはモデルに任せ、複数の仕事をどの順序で進めるかは script に任せる。」*
>
> **Harness layer：orchestration。** 安定していて繰り返しやすく、並列化に向いた multi-agent の流れをコードにします。

---

![Workflow Runtime 全体像](images/workflow-runtime-overview.svg)

s01 から s20 までは、次に何をするかを常にモデルが決めてきました。モデルは context を読み、tool を選び、結果を観察してから次の行動を決めます。答えが最初から分からない仕事では、これが今でも最も自然な進め方です。

一方で、実行順序がすでに明確な仕事もあります。大きな変更を review する場合を考えてみましょう。

1. 確認すべき file を見つける。
2. 複数の観点から並列に調べる。
3. 同じ根本原因を説明する report をまとめる。
4. まとめた各 issue を別の Agent が検証する。
5. 優先順位を付け、一つの report にまとめる。

モデルが判断すべきなのは、「コードに問題があるか」「その finding は本当に成立するか」です。いつ並列に実行し、誰が検証し、最後にどう集約するかを毎 turn モデルに決め直させる必要はありません。

Workflow は、この実行の流れを script に移します。

## 実行の流れをコードにする

Claude Code に保存される Workflow は JavaScript です。通常の条件分岐、loop、変数で処理を組み立て、判断が必要な step を `agent()` に任せます。

```javascript
export const meta = {
  name: "review-changes",
  description: "Review changed files and verify every finding",
}

const audits = await pipeline(args.files, file =>
  agent(`Review ${file} for correctness problems.`, { label: file })
)

return audits.filter(Boolean)
```

この章では、background 実行、並列処理、失敗、resume の仕組みを追いやすくするため、runtime を Python で再構成します。sample Workflow の中心は次のようになります。

```python
async def review_changes(context, args):
    context.phase("Review")

    audits = await context.parallel([
        lambda dimension=dimension: context.agent(
            f"対象 file の {dimension} problem を調べる",
            schema=FINDINGS_SCHEMA,
            label=f"audit:{dimension}",
        )
        for dimension in REVIEW_DIMENSIONS
    ])

    findings = []
    for dimension, result in zip(REVIEW_DIMENSIONS, audits):
        if not result.ok:
            continue
        for finding in result.value["findings"]:
            findings.append({
                "source_id": f"r{len(findings)}",
                "dimension": dimension,
                **finding,
            })

    context.phase("Consolidate")
    grouping = await context.agent(
        f"同じ根本原因の report をまとめる：{findings}",
        schema=CONSOLIDATION_SCHEMA,
        label="consolidate",
    )
    consolidated = validate_consolidation(findings, grouping)

    async def verify(finding, _original, _index):
        verdict = await context.agent(
            f"この finding を独立して検証する：{finding}",
            schema=VERDICT_SCHEMA,
            label=f"verify:{finding['title']}",
        )
        return finding if verdict["confirmed"] else {}

    context.phase("Verify")
    verdicts = await context.pipeline(consolidated, verify)

    return [
        result.value for result in verdicts
        if result.ok and result.value
    ]
```

言語が変わっても役割分担は同じです。判断はモデルが担当し、script は開始、待機、結果の受け渡し、終了処理を担当します。

## 一度起動し、background で完了する

Workflow は main Agent の tool の一つです。モデルが呼び出すと、tool は local task を登録してすぐに戻ります。

```python
job = asyncio.create_task(self._execute(...))
self.registry.register(task, job)

return {
    "status": "async_launched",
    "taskId": task_id,
    "runId": run_id,
}
```

main session は全処理の完了を待たず、task の受付情報を受け取ります。background task はそのまま進み、phase、Agent、最終完了の event を送ります。

## agent() は完全な subagent を起動する

`agent()` は一度だけ text completion を呼ぶ処理ではありません。各 subagent は独立した messages と tool loop を持ち、file や diff を読み、追加の tool call が必要かを自分で判断します。

```python
for _turn in range(30):
    response = client.messages.create(
        model=model,
        messages=messages,
        tools=READ_ONLY_TOOLS,
    )
    messages.append({"role": "assistant", "content": response.content})

    tool_results = []
    for block in response.content:
        if _block_type(block) != "tool_use":
            continue
        output = self._run_tool(
            _block_value(block, "name"),
            _block_value(block, "input", {}),
        )
        tool_results.append({
            "type": "tool_result",
            "tool_use_id": _block_value(block, "id"),
            "content": output,
        })

    if tool_results:
        messages.append({"role": "user", "content": tool_results})
        continue

    return AgentRun(value=_extract_text(response.content))
```

sample reviewer が使えるのは read-only tool だけです。`read_file` は安定した行番号を返すため、後続の finding は正確な evidence を示せます。`glob` は Git が track している file と ignore していない file から match し、件数と文字数を制限します。広い検索でも `.worktrees` や生成 file を大量にモデルへ返しません。file を変更する Workflow では、複数の writer に同じ directory を共有させず、前の章で扱った permission check と worktree isolation を引き続き使うべきです。

## parallel() と pipeline()

互いに独立し、最後にまとめて受け取りたい仕事には `parallel()` を使います。

```python
audits = await context.parallel([
    lambda: audit("correctness"),
    lambda: audit("maintainability"),
])
```

すべての branch が同時に始まり、完了後は入力順で結果が返ります。

各 item を複数の stage に順番に通したい場合は `pipeline()` を使います。

```python
results = await context.pipeline(
    findings,
    verify,
)
```

同じ item の stage 順序は守られますが、異なる item は並行して進みます。ある finding の verification が終わっても、別の finding はまだ関連コードを読んでいるかもしれません。

## まず形を保証し、そのあと内容を判断する

Workflow の結果はさらにコードから利用されるため、field の形を安定させる必要があります。`agent(schema=...)` は、schema に一致する structured result を最後に提出するよう subagent に求めます。

```python
{
    "findings": [
        {
            "title": "...",
            "severity": "high",
            "evidence": "..."
        }
    ]
}
```

Schema が保証するのは、下流のコードが値を扱えることだけです。内容が正しいことまでは保証しません。

正しい形の `findings` array が返っても、各 finding が本物か、説明された原因と影響をコードから導けるかは別の Agent が検証する必要があります。形の validation と内容の verification は別の問題です。JSON が正しいだけで結論を信用してはいけません。

## 同じ issue は一度だけ検証する

異なる review dimension が同じ issue を報告しても、title が完全に一致することはほとんどありません。title は表示用の文であり、重複判定の key には使えません。

script は各 raw report に `r0`、`r1` のような source ID を付けます。そのあと Consolidate Agent が、同じ根本原因を説明する report を判断します。

```json
{
  "groups": [
    {
      "source_ids": ["r0", "r1"],
      "title": "percentage() が total 0 を処理しない",
      "evidence": "二つの report は同じ zero guard の欠落を示している"
    }
  ]
}
```

semantic grouping はモデルが担当しますが、一つの修正で group 内の全 report を解決できる場合だけ統合し、判断に迷う場合は分けたままにします。script はすべての source ID が一度だけ現れることを確認し、raw report の最も高い severity と全 review dimension を残します。Verify Agent は consolidated issue ごとに一つだけ起動します。

grouping が source ID を省略、重複、または捏造した場合、workflow は error を `incomplete` に記録し、raw report を個別に検証します。Consolidate が失敗しても finding は消えません。

すべての branch が完了しても、すべての defect を発見した証明にはなりません。並列 review は確認範囲を広げますが、モデルの判断を網羅的な検査に変えるものではありません。

## 失敗を消してはいけない

並列処理では timeout、rate limit、不正な出力、tool error が起こります。例外をすべて `None` に変えると、次の二つを区別できません。

- 確認は完了したが問題が見つからなかった。
- 確認そのものが完了しなかった。

そのため、`parallel()` と `pipeline()` は明示的な `Outcome` を返します。

```python
Outcome(ok=True, value=result)
Outcome(ok=False, error="RuntimeError: request timed out")
```

検証済みの finding は report に残し、完了しなかった review、consolidation、verification branch は `incomplete` に記録します。部分的な結果は利用できますが、失敗を「問題なし」として扱うことはできません。

## resume はどこから始まるか

runtime は各 `agent()` の開始順、入力、結果を記録します。resume では最初の呼び出しから順に比較します。

```text
old run: A → B → C  → D
new run: A → B → C' → D

resume:  A と B は以前の結果を利用
         C' は再実行
         D も再実行
```

未完了または変更された step が一つ見つかると、それ以降はすべて再実行します。以前の処理の後半を、新しい実行経路へ誤って接続しないためです。

並列 Agent の完了順は変わる可能性があるため、journal は完了順ではなく開始順を記録します。

journal が比較するのは `agent()` call の入力です。Agent が読む file の変更までは検出しません。`resume` は同じ run を続けるために使い、コードや入力データが変わった場合は新しい run を開始します。

## 一つの実行は一つの制限を共有する

concurrency semaphore、Agent call 数、usage は個別の step ではなく実行全体に属します。usage は Agent 数、model API call 数、token、tool call 数を別々に記録します。nested Workflow も同じ制限を共有するため、nesting で上限を回避することはできません。

permission は起動前に確認します。明示的な allow rule がなければ user に確認すべきです。この章の script を直接実行する操作は、内蔵 sample の起動を user が明示的に承認したものとして扱います。

## 実行してみる

dependency を install し、`.env` を準備します。

```bash
pip install -r requirements.txt

# .env
ANTHROPIC_API_KEY=...
MODEL_ID=...
```

内蔵 review Workflow を実行します。

```bash
python s21_workflow_runtime/code.py
```

対象 file を指定することもできます。

```bash
python s21_workflow_runtime/code.py s20_comprehensive/code.py
```

直前の実行を resume します。

```bash
python s21_workflow_runtime/code.py resume
```

event stream には次の順序が現れます。

```text
async_launched
task_started
workflow_phase
workflow_agent
task_notification
```

output と journal は `s21_workflow_runtime/.runtime/` に保存されます。これは local runtime state であり、repository には commit しません。

## s20 から何が変わったか

| | s20 comprehensive harness | s21 Workflow Runtime |
|---|---|---|
| 次を誰が決めるか | モデルが turn ごとに決める | script が既知の流れを実行する |
| Multi-agent | モデルが必要に応じて subagent や teammate を起動する | script が複数の subagent をまとめて起動、集約する |
| 中間結果 | message history に戻る | script の変数に残る |
| 実行方法 | 現在の session 内で進む | local background task として進む |
| Resume | session と task state に依存する | Agent の開始順で完了済み prefix を再利用する |

各 `agent()` の内部では元の agent loop が動きます。script が担当するのは、複数の Agent の実行順序です。

すべての task を Workflow にする必要はありません。要求が変化している場合や、次の step がモデルの発見に依存する場合は、通常の agent loop を使い続けます。実行順序が安定し、繰り返す価値があるときだけコードに移します。

次章の [s22 Goal Loop](../s22_goal_loop/) は、turn が止まろうとするたびに完了条件を確認します。Workflow の終了は script が終わったことを示しますが、user の最終 goal が満たされたとは限りません。

<!-- translation-sync: zh@v4, en@v4, ja@v4 -->
