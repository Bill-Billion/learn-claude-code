# s12: Task System — 大きな目標を小さなタスクに分ける

[中文](README.zh.md) · [English](README.md) · [日本語](README.ja.md)

s01 → ... → s10 → s11 → `s12` → [s13](../s13_background_tasks/) → s14 → ... → s20

> *「大きな目標を小さなタスクに分け、順序を決め、永続化する」* — ファイルに永続化するタスクグラフは、マルチ Agent 協調の基盤です。
>
> **Harness 層**: タスク — 永続化された目標と、復元可能な進捗。

---

Agent にプロジェクト規模の仕事を渡してみましょう。データベースを構築し、API を書き、テストを追加する仕事です。Agent は s05 の TodoWrite でチェックリストを作り、順番に着手します。API を半分まで書いたところでテーブルがないことに気づき、戻ってテーブルを追加します。テーブルができてテストを書き始めると、今度は API のシグネチャが変わっていることに気づきます。

問題はチェックリストの書き方ではなく、チェックリストというデータ構造そのものにあります。平らなリストでは「schema ができてから API を書く」という関係を表せません。タスク間の関係は列ではなく、グラフです。建築工程表なら、「梁を上げる」には「先に柱を立てる」という制約を結び付ける必要があり、単に 3 行目に置くだけでは足りません。

もっと素朴な問題もあります。s05 のチェックリストはプロセスメモリに住んでいるため、`q` を押した瞬間に消えます。プロジェクトを途中で切り上げても、翌日の Agent は続きから再開できるべきです。

![Task System Overview](images/task-system-overview.svg)

---

## TodoWrite に足りない 3 つのもの

| | TodoWrite (s05) | Task System (s12) |
|---|---|---|
| 役割 | 現在のタスクの実行チェックリスト | 復元可能なタスクシステム |
| 保存先 | プロセスメモリ | `.tasks/{id}.json` ファイル |
| 依存関係 | なし | `blockedBy` 依存グラフ |
| ライフサイクル | 現在のセッション | セッションをまたいで保持 |
| 所有者 | なし | `owner` フィールド + claim の仕組み |

一言で分けるなら、**チェックリストは手順を管理し、タスクシステムは協調を管理します。** 依存関係は作業の順序を制約し、永続化は再起動から進捗を守り、所有者は「誰が何をしているか」に答えます。3 つ目は Agent が 1 つしかない今は余計に見えますが、s15 で複数の Agent が登場すると、2 人が同じ仕事を奪い合わないための鍵になります。

この章の教材コードはタスクシステムに集中するため、基本ループに戻り、s11 のエラーリカバリを引き継いでいません。これは設計上の対立ではありません。タスク CRUD とエラーリカバリは独立したレイヤーであり、実システムでは自然に重ねられます。

---

## 保存: 1 タスクにつき 1 つの JSON ファイル

```python
@dataclass
class Task:
    id: str
    subject: str
    description: str
    status: str          # pending | in_progress | completed
    owner: str | None    # 誰が claim したか（マルチ Agent の場合）
    blockedBy: list[str] # 上流にある依存タスクの ID

def save_task(task: Task):
    (TASKS_DIR / f"{task.id}.json").write_text(json.dumps(asdict(task), indent=2))
```

すべてを 1 つの大きな JSON に入れず、タスクごとにファイルを分けるのはなぜでしょうか。将来の並行処理に備えるためです。複数の Agent が同時に働くとき、それぞれが claim したタスクだけを更新すれば、変更するファイルが分かれて競合範囲を最小化できます。この判断の重みは s15 で完全に見えてきます。

タスク作成時に依存関係を宣言します。

```python
def create_task(subject, description="", blockedBy=None) -> Task:
    task = Task(id=f"task_{int(time.time())}_{random.randint(0, 9999):04d}",
                subject=subject, description=description,
                status="pending", owner=None, blockedBy=blockedBy or [])
    save_task(task)
    return task
```

---

## 依存関係の確認: 上流がすべて完了してから着手する

```python
def can_start(task_id: str) -> bool:
    task = load_task(task_id)
    for dep_id in task.blockedBy:
        if not _task_path(dep_id).exists():
            return False          # 存在しない依存先は blocked とみなす
        if load_task(dep_id).status != "completed":
            return False
    return True
```

「依存先が存在しない」分岐に注目してください。s05 で説明したとおり、モデルは ID を書き間違えます。ツール引数はモデルから来るため、全面的には信用できません。誤った ID に対して直接 `load_task` を呼ぶとクラッシュしますが、黙って通すのはさらに悪手です。依存チェックが無意味になるからです。blocked とみなすのが最も堅実です。タスクは動けませんが、モデルは「Blocked by」エラーに含まれる不審な ID を見て、自分で修正できます。

---

## Claim と完了: 2 つの操作、3 つの状態

```
pending ──claim──→ in_progress ──complete──→ completed
```

```python
def claim_task(task_id: str, owner: str = "agent") -> str:
    task = load_task(task_id)
    if task.status != "pending":
        return f"Task {task_id} is {task.status}, cannot claim"   # claim 済み、または完了済み
    if not can_start(task_id):
        return f"Blocked by: {...}"                               # 上流が未完了
    task.owner = owner
    task.status = "in_progress"
    save_task(task)
```

claim が拒否される 2 つの理由は、そのまま `tool_result` としてモデルに返します。状態が不正か、上流が未完了かのどちらかです。モデルは `Blocked by: [task_xxx]` を受け取れば、先に何をすべきか分かります。Harness にスケジューリングロジックを書く必要はなく、エラーメッセージ自体が案内役になります。

タスクの完了時にはもう 1 つ、全タスクを走査し、いま解除されたタスクを通知します。

```python
def complete_task(task_id: str) -> str:
    task = load_task(task_id)
    if task.status != "in_progress":
        return f"Task {task_id} is {task.status}, cannot complete"
    task.status = "completed"
    save_task(task)
    unblocked = [t.subject for t in list_tasks()
                 if t.status == "pending" and t.blockedBy and can_start(t.id)]
    ...   # "Unblocked: create API endpoints, write docs"
```

この通知こそグラフ構造の見返りです。schema が完了した瞬間に、モデルは endpoints と docs の両方が着手可能になったと知ります。自分で何度もポーリングする必要はありません。

---

## 教材版に意図的に残した 2 つの穴

**循環検出がありません。** 2 つのタスクが互いを `blockedBy` に入れると、`can_start` は両方に False を返し、どちらも claim できません。これはデッドロックです。教材版では検出せず、下の実験で自分の手で作れるようにしています。本番システムでは依存関係の作成時に非巡回であることを検証しなければなりません。

**release のフォールバックがありません。** 状態機械に `in_progress → pending` という遷移がありません。タスクを claim した Agent のプロセスが落ちると、そのタスクは永遠に `in_progress` のままで、誰も引き継げません。JSON を手作業で削除するしかありません。実際の Claude Code では teammate が終了すると、その担当タスクから owner を消して `pending` に戻し、ほかの teammate が改めて claim できるようにします。

> 実際の Claude Code では、`claimTask` がファイルロックで競合を防ぎます。TOCTOU を防ぐためロック内でタスクを再読込し、`already_claimed` と `blocked` を確認してから owner を設定します。ID は増加する整数で、削除後の再利用を防ぐ `.highwatermark` ファイルも使います。依存関係は作成時だけでなく、`TaskUpdate` の `addBlocks/addBlockedBy` で管理します。教材版の 5 つの関数は実装側の 4 つのツールに対応し、根底の構造を共有しています。

---

## s11 からの変更点

| コンポーネント | 変更前 (s11) | 変更後 (s12) |
|------|-----------|-----------|
| タスク管理 | なし | `Task` dataclass + 5 ツール |
| 保存 | 永続化なし | `.tasks/{id}.json` でセッションを横断 |
| 依存関係 | なし | `blockedBy` グラフ + `can_start` チェック |
| ツール | bash, read_file, write_file (3) | +create_task, list_tasks, get_task, claim_task, complete_task (8) |
| ライフサイクル | — | pending → in_progress → completed（release フォールバックなし） |

---

## 試してみる

```sh
cd learn-claude-code
python s12_task_system/code.py
```

1. `Create tasks: setup database schema, create API endpoints (depends on schema), write tests (depends on endpoints), write docs (depends on schema)`: `.tasks/` ディレクトリを開いてください。4 つの JSON ファイルが並び、依存関係が `blockedBy` に正確に記録されています。
2. `Claim and complete the first unblocked task`: schema が完了するときの `[unblocked]` 通知を見てください。endpoints と docs が同時に解除されます。
3. `q` で終了し、**もう一度起動**して `List all tasks` と入力します。リストは完了状態も含めて、そのまま復元されます。s05 のメモリ上のチェックリストにはできないことです。
4. **自分の手でデッドロックを作ります**: `Create task A blocked by task B, and task B blocked by task A. Then try to claim either one.` 両方が `Blocked by` を返し、どちらも動けません。これが循環検出を持たない代償です。この感触を覚えておけば、将来タスクシステムを設計するときに思い出せます。

---

## 次へ

タスクグラフはできましたが、各タスクはまだ main Agent が自分で実行し、終わるまで次へ進めません。時間のかかる作業もあります。全テストには 10 分、ビルドとデプロイには 30 分かかるかもしれません。token 単位で課金されるループを遅いコマンドの待ち時間に使うと、費用も時間も燃えていきます。

s13 Background Tasks → 遅い処理をバックグラウンドに回し、Agent は別の仕事を続け、完了後に結果を受け取ります。

<!-- translation-sync: zh@v2, en@v2, ja@v2 -->
