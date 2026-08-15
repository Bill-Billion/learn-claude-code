# s18: Worktree Isolation — それぞれ別に作業し、互いに干渉しない

[中文](README.zh.md) · [English](README.md) · [日本語](README.ja.md)

s01 → ... → s16 → s17 → `s18` → [s19](../s19_mcp_plugin/) → s20

> *「それぞれ別のディレクトリで作業し、互いに干渉しない」* — task は目標を、worktree はディレクトリを管理し、ID で結びます。
>
> **Harness 層**: 分離 — 並行実行のためのディレクトリ分離。

---

s06 の「会話 context は分離されたが、filesystem は分離されていない」という一文は、当時は注意書きのように聞こえました。s17 になると、実際に爆発する問題になります。

Alice と Bob は別々のタスクを claim しても、同じディレクトリで働きます。Alice のタスクは `config.py` を変更し、Bob のタスクも同じです。後から書いた内容が先の変更を上書きします。もっと気づきにくい形では、2 人が古いファイルを読み、それぞれ変更して書き戻し、どちらも意図しない混合物を作ります。問題が起きても戻せません。`git diff` に 2 人の変更が絡み合い、どの行が誰のものか分からないからです。

s15 から s17 は「誰が何をするか」を task board で、「どう話すか」を mailbox で答えましたが、「どこで働くか」には答えていません。

![Worktree Overview](images/worktree-overview.svg)

---

## Lock が答えではない理由

最初は lock を追加したくなります。repository 全体を lock すれば、並行処理が直列へ退化し、s15 でチームを組んだ意味が消えます。ファイル単位で lock するには、まず「このタスクがどのファイルに触れるか」を答えなければなりませんが、着手前にはモデル自身にも分かりません。分かったとしても、2 タスクが交差する lock を保持するのは deadlock の定番です。

発想を変えましょう。この問題を git は 20 年前に解決しました。1 人 1 つ working copy を持ち、それぞれ変更し、最後に merge します。`git worktree` は clone よりずっと軽い方法です。1 つの repository から複数の作業ディレクトリを生やし、それぞれを branch へ結びながら、同じ `.git` 履歴を共有します。

worktree の機構は Git の機能であり、Agent Harness が発明したものではありません。Harness は作成時期、task との binding、teammate の working directory、作成時 commit の記録、安全に片付けられる時期を管理します。この章で実装するのは Git を囲む lifecycle であって、分離機構そのものの再実装ではありません。

この章の設計は一文で表せます。**分離は lock ではなく、copy で行います。**

---

## 作業場所を開く: 先に名前を検査する

```python
VALID_WT_NAME = re.compile(r'^[A-Za-z0-9._-]{1,64}$')

@dataclass(frozen=True)
class WorktreeRecord:
    name: str
    path: str
    branch: str
    base_commit: str
    task_id: str = ""

def create_worktree(name: str, task_id: str = "") -> str:
    err = validate_worktree_name(name)      # 不正な名前はその場で拒否
    if err:
        return f"Error: {err}"
    ok, base_commit = run_git(["rev-parse", "HEAD"])
    if not ok:
        return f"Git error: cannot record base commit: {base_commit}"
    path = WORKTREES_DIR / name             # .worktrees/<name>
    branch = f"wt/{name}"
    ok, result = run_git(["worktree", "add", str(path), "-b", branch, "HEAD"])
    if not ok:
        return f"Git error: {result}"
    save_worktree_record(WorktreeRecord(
        name, str(path.resolve()), branch, base_commit.strip(), task_id))
    if task_id:
        bind_task_to_worktree(task_id, name)
    log_event("create", name, task_id)      # audit log: 成功した事実だけを記録
```

名前の検証は、古い知人が 3 度目に登場したものです。s02 の `safe_path` はファイルパスを、s07 の registry は skill 名を、この正規表現は作業場所の名前を守ります。`../../etc` のような名前を path へ連結すると、workspace の外に worktree が作られます。モデルが渡す文字列を path の一部にするなら、必ず先に検査する。この規則はどの章でも変わりません。

`log_event` の位置にも意味があります。`run_git` の成功後に置きます。先に log を書いてから実行すると、失敗した操作にも「成功」という audit record が残り、log は証拠ではなく嘘になります。

`WorktreeRecord` は audit log とは別のものです。正確な branch、path、`base_commit` を保存し、後から何が増えたかを検証できるようにします。record がない、または directory と一致しない場合、通常の cleanup は推測せず拒否します。

---

## Binding: 作業場所は task の属性であり、claim ではない

```python
def bind_task_to_worktree(task_id: str, worktree_name: str):
    task = load_task(task_id)
    task.worktree = worktree_name    # このフィールドだけを変更
    save_task(task)                  # status は pending のまま
```

意図的に行わないことへ注目してください。status を変えず、owner も設定しません。binding が答えるのは「このタスクはどの作業場所で進めるか」だけで、「誰が進めるか」ではありません。そのため s17 の自律機構はそのままです。タスクは誰かが claim するまで board に残り、獲得した人がその作業場所へ移ります。2 つの機構は直交し、別々のフィールドを管理します。

teammate 側の変更は 1 つだけです。worktree に binding されたタスクを claim すると、その後の `bash`、`read_file`、`write_file` はすべてそのディレクトリで実行します。Alice は `.worktrees/auth/` の `config.py` を、Bob は `.worktrees/ui/` の `config.py` を変更します。物理的に別の 2 ファイルなので、互いを踏みません。

---

## 作業場所を閉じる: 削除前に数える

使い終わった作業場所を片付ける前に、1 つ答える必要があります。中に持ち出していないものが残っていないでしょうか。

```python
def remove_worktree(name: str, discard_changes: bool = False) -> str:
    path = WORKTREES_DIR / name
    record, record_error = load_worktree_record(name)
    if not discard_changes:
        if record_error:
            return f"Cannot verify worktree: {record_error}"
        verified, files, commits, detail = _inspect_worktree_changes(
            path, record.base_commit)
        if not verified:
            return f"Cannot verify worktree: {detail}"
        if files > 0 or commits > 0:
            return (f"Worktree '{name}' has {files} uncommitted file(s) "
                    f"and {commits} new commit(s) since creation. "
                    "Use discard_changes=true to force removal, "
                    "or keep_worktree to preserve for review.")
    branch = record.branch if record else f"wt/{name}"
    remove_args = ["worktree", "remove"]
    if discard_changes:
        remove_args.append("--force")
    run_git([*remove_args, str(path)])
    run_git(["branch", "-D" if discard_changes else "-d", branch])
    log_event("remove", name)
```

変更のある worktree は既定で削除を拒否します。未 commit ファイルは `git status`、新しい commit は `git rev-list base_commit..HEAD` で数えます。新しい worktree には upstream がないことも多いため、検査は remote tracking branch に依存しません。作成 record がない、Git command が失敗した、commit 数を読めない場合も、0 と見なさず拒否します。

s08 の「要約前に保存」、s09 の「新しい inventory を得てから古いファイルを消す」と同じ感覚が 3 度目に現れます。**破壊する前に、孤児になるデータがないことを確認します。** 逆を想像してください。teammate が commit を終えたものの未 merge のとき、Lead が何気なく「作業場所を片付けて」と言い、`branch -D` で数時間の作業が消え、log には整然とした remove の 1 行だけが残ります。

本当に削除したい場合は 2 つの明示的な出口があります。`discard_changes=true` は「何を捨てるか理解している」、`keep_worktree` は「branch を残し、人が review する」という意味です。危険な操作も実行できますが、言葉にした決断でなければならず、既定動作にはしません。

> 実際の Claude Code には 2 つの worktree 経路があります。`EnterWorktree` は process 単位の chdir で現在の session 全体を移します。AgentTool の `isolation: "worktree"` は global directory を変えず、1 つの subagent だけを囲み、変更のない一時 worktree は自動 cleanup されます。task と worktree を結ぶフィールドはなく、2 つのシステムは独立し、モデルが context から関連付けます。教材版の `worktree` フィールドは意図的な簡略化です。

---

## s17 からの変更点

| コンポーネント | 変更前 (s17) | 変更後 (s18) |
|------|-----------|-----------|
| 作業ディレクトリ | 全員が WORKDIR を共有 | task ごとに独立 worktree を binding 可能 |
| Task フィールド | id/subject/.../blockedBy | +`worktree` |
| 新しい関数 | — | `create_worktree`, `bind_task_to_worktree`, `remove_worktree`, `keep_worktree`, `validate_worktree_name` |
| cleanup の根拠 | なし | path、branch、作成時 commit を持つ `WorktreeRecord` |
| Audit | なし | `.worktrees/events.jsonl` の lifecycle log |
| teammate の実行 | 常に main directory | binding された task では cwd を作業場所へ切替 |

---

## 試してみる

```sh
cd learn-claude-code
python s18_worktree_isolation/code.py
```

1. **分離の現場**: `Create two tasks: 'write auth notes to notes.md' and 'write UI notes to notes.md'. Create worktrees wt-auth and wt-ui, bind one task to each. Spawn alice and bob to work autonomously.` 2 タスクとも同名の `notes.md` を書きますが、それぞれ無事に残ります。`cat .worktrees/wt-auth/notes.md` と `cat .worktrees/wt-ui/notes.md` を比べると、内容が異なり、互いに上書きしていません。これが copy による分離の直接的な証拠です。
2. **検査**: `Create a worktree named ../../escape`。名前が正規表現を通らず、すぐエラーが返り、workspace の外は何も変わりません。
3. **作業場所を閉じる gate**: 実験 1 の teammate が終わったあと、`Remove worktree wt-auth` を実行します。未 merge の commit があるため削除を拒否し、エラーにはファイルと commit の件数、2 つの明示的な出口が書かれています。この拒否が本章で最も価値のある 1 行です。

---

## 次へ

チームは並行作業、分離、片付けまでできるようになりました。Agent の toolbox を振り返ると、bash、ファイル、タスク、チームはすべて私たちが手書きしています。しかしユーザーには、社内 Jira や独自 deployment platform のような自分たちのシステムがあります。組織ごとに別のツールセットを `code.py` へ溶接するわけにはいきません。

s19 MCP Plugin → plugin protocol。外部ツールを標準 interface で接続し、Agent は実装者を知る必要がありません。

<!-- translation-sync: zh@v2, en@v2, ja@v2 -->
