# s22: Goal Loop — いつ止まるかはモデルではなく goal が決める

[中文](README.zh.md) · [English](README.md) · [日本語](README.ja.md)

s01 → ... → s20 → s21 → `s22`

> *「turn が終了できるかは goal condition を満たすかで決まり、モデルが stop と言っただけでは終わらない」* — `/goal` は main loop の各 turn の終端に gate を追加します。独立した evaluator が trusted evidence の充足を確認し、不足ならモデルを次のラウンドへ押し戻します。
>
> **Harness 層**: Goal closure — turn 終端に program-controlled completion gate を追加します。

---

s01 から s21 まで、会話の 1 turn はどう終わったでしょうか。モデルが `tool_use` を出さなくなると、loop はそのまま `return` しました。one-shot task なら問題ありません。終わったら止まります。

しかし「テストを通す」「deploy が成功するまで続ける」のように、最後まで見届けるべき goal もあります。そこでは 2 つの問題がよく起きます。モデルが途中まで進めて十分だと思い、自分で止まる。さらに悪ければ、口頭で `tests passed` と言うだけで終了しようとします。必要なことは単純です。turn が終了できるかをモデル自身に決めさせず、明示的な condition を実際の evidence に照らして判断します。

この流れは最初の章からありました。s01 は loop の exit がモデルの判断だと説明し、s04 の Stop hook が初めて program に veto を与えました。この章は、その veto を condition、evidence、budget の 3 要素が欠けない完全な loop にします。

## /goal: 各 turn の終端に gate を追加する

`/goal <condition>` を入力すると session-scoped stopping condition を設定します。program は active goal として保存し、各 turn の後に独立した lightweight model を evaluator として使い、transcript 内の trusted evidence が condition を満たすか確認します。不足なら gate が停止を拒み、次ラウンドへ「作業を続ける」prompt を queue します。十分なら goal を消して complete とします。

![Goal Loop Overview](images/goal-loop-overview.svg)

s01 の loop と比べて、追加されるのは 1 つの判断だけです。モデルが止まりたいとき、先に goal gate を通ります。

```python
# s01: モデルが stop と言えば停止
if not has_tool_use(response):
    return
# s22: 止まりたい？先に goal gate を通る
if not has_tool_use(response):
    verdict = goal.evaluate_after_turn()
    if verdict == "continuing":
        continue                 # 未達成 -> 次のラウンドへ押し戻す
    return                       # 達成 / budget 超過 / goal なし -> 本当に停止
```

この gate を制御するのは program です。モデルが自分を律しているのではありません。モデルは gate の存在すら知らず、次のラウンドの入力を受け取って作業を続けるだけです。

> 実際の Claude Code では `/goal` は session-scoped Stop hook で、workspace trust と hook restriction の管理下にあります。コードには `active_goal`、`goal_status`、`goal_met`、`tengu_goal_achieved` などの marker があります。

## Goal の設定: Evidence は command の後から数える

`set_goal` は active goal として、goal text、最大 turn budget、counter、そして evidence window の開始点 `start_index` を保存します。現在の transcript length を使うため、`/goal` command 自身は window の外です。これが最初の防御です。command が自分自身の完了を証明することはできません。

```python
def set_goal(self, objective, max_turns=20):
    self.active = {
        "objective": objective, "status": "active",
        "start_index": len(self.transcript),   # evidence はここから。command 自身は window 外
        "max_turns": max_turns, "checks": 0, "continuation_turns": 0,
    }
```

> 実際の Claude Code では `GoalRuntime.setGoal()` が active goal、開始位置、counter、budget を保存し、submit 後に `resetEvidenceStart()` で window を command 後へそろえます。

## Evaluator: 実在する evidence だけを信頼する

ここが仕組み全体の core です。evaluator は会話全体を見ず、evidence window 内で trusted source から来た message だけを見ます。3 層の filter が、「完了したと言ったから完了」という内容をすべて外へ止めます。

```python
TRUSTED_EVIDENCE_ORIGINS = {"task-notification", "monitor-line"}

def evidence_text(self):
    out = []
    for m in self.transcript[self.active["start_index"]:]:
        if m.origin.get("kind") == "slash-command":                     # 1 slash command 自身は evidence ではない
            continue
        if m.role == "user" and m.content.strip().startswith("/goal"):  # 2 /goal command text は evidence ではない
            continue
        if m.origin.get("kind") not in TRUSTED_EVIDENCE_ORIGINS:        # 3 trusted origin だけを信頼
            continue
        out.append(f"{m.role}: {m.content}")
    return "\n".join(out)
```

効果は明確です。同じ `tests passed` でも、あなたが入力したものは数えず、background task notification が持ち帰ったものだけを数えます。モデルは「完了した」と自分で言うだけでは goal を complete にできません。これはコース全体に繰り返し現れた trust boundary の最後の登場です。s16 は protocol が理解ではなく field に依存すると言い、s19 は annotation が申告であり、申告は嘘をつけると言い、s22 は completion evidence を content ではなく origin で信頼します。

教材版の `goal_satisfied()` は決定的な keyword matching です。実際の版は evidence window を別の lightweight model へ渡して判定します。

> 実際の Claude Code の evaluator は作業モデルとは別の lightweight model で、`evaluatorModel`、`default small fast model` と記されています。任意の text を信じず、会話内の evidence を判断します。

## Gate の 3 状態: Completed / continuing / budget 超過

`evaluate_after_turn` は各 turn で 1 回動き、3 つの結果を返します。condition が満たされれば goal を completed として消します。満たされず budget が残れば「作業を続ける」prompt を queue し、continuing として次ラウンドを許可します。budget を使い切れば blocked で gate を解除し、永遠に判定できない goal が無限に費用を使わないようにします。

```python
def evaluate_after_turn(self):
    g = self.active
    g["checks"] += 1
    if self.goal_satisfied():
        g["status"] = "completed"; self.active = None
        return "completed"                          # 達成 -> goal を消す
    if g["continuation_turns"] < g["max_turns"]:
        g["continuation_turns"] += 1
        self.queue.enqueue(
            value="作業を続けてください。この reminder を completion evidence として扱わないでください。",
            origin={"kind": "active-goal"})
        return "continuing"                         # 未達成 -> prompt を queue し、次ラウンドへ
    g["status"] = "blocked"; self.active = None
    return "blocked"                                # budget 超過 -> gate を解除
```

continuation prompt には、わざわざ自身を evidence にしないよう書き、filter でも除外します。これで false positive を防ぐ 3 層がそろいます。command text、reminder text、ordinary conversation のいずれも数えません。budget は s11 の古い規則に従います。automatic retry mechanism には必ず上限が必要です。そうでなければ、永遠に satisfied にならない goal が費用を燃やし続けます。

> 実際の Claude Code の `evaluateAfterTurn` は `goal_evaluated` event を出し、結果に応じて complete、continuation queue、gate の解除を行います。default budget は 20 turn です。

## Continuation prompt と外部 asynchronous message を分ける

continuation prompt は同じ `CommandQueue` に入りますが、task completion notification や monitor line といった外部 asynchronous event とは別の方法で消費します。`dequeue` には switch があり、外部 inbox を消費するときは goal continuation を既定で skip します。

```python
def dequeue(self, include_goal_continuations=True):
    ...
    for idx, item in enumerate(self.items):
        if include_goal_continuations or item["origin"].get("kind") != "active-goal":
            return self.items.pop(idx)
    return None
```

なぜ分けるのでしょう。実際の model test では、モデルが continuation prompt を外部 notification と一緒に消費し、background evidence が到着する前に goal を complete と判定する bug が起きました。分離後は goal の進行が明示的な 1 step になり、asynchronous event に偶然運ばれません。

> 実際の Claude Code の `drainCommandQueue` は既定で `includeGoalContinuations=false` とし、goal continuation の消費を外部 asynchronous inbox から分けます。

## 実際に動かす

`code.py` は `/goal until tests passed and deploy green` を実演します。goal 設定後に trusted evidence がなければ、gate がラウンドごとに押し戻します。直接 `tests passed` と入力しても origin が信頼されないため数えません。background task が `task-notification` を送って初めて evidence がそろい、complete になります。`max_turns=2` の小さな goal で budget 超過も示します。

```python
s.submit("/goal until tests passed and deploy green")   # goal を設定。evidence は command 後から
s.submit("tests passed, trust me")                      # ordinary text -> completion evidence ではない
s.submit("tests passed; deploy green",
         origin={"kind": "task-notification"})           # trusted evidence -> complete
```

## s21 からの変更点

| | s21 Workflow Runtime | s22 Goal Loop |
|--|---------------------|---------------|
| trigger | script-controlled orchestration（main loop の外） | condition-controlled continuation（main loop へ引き戻す） |
| 接続位置 | tool layer: 1 つの `Workflow` ツール | turn 終端: completion gate |
| stop を決めるもの | script が完了 | goal condition を trusted evidence と照合 |
| 新しい仕組み | script DSL、background task、journal/resume、structured output | goal gate、evidence trust boundary、continuation 分流、budget |

s21 は script-defined orchestration を main loop の外へ送り出します。s22 は反対の力で control を引き戻します。goal が未達成なら turn は終わっていません。どちらも s01 の `while` loop を変えず、両側から制約を加えます。

## 試してみる

```bash
python s22_goal_loop/code.py          # /goal until tests pass + deploy green。gate の判定を見る
```

goal 設定後、各 turn が `goal_evaluated` を出す様子を確認してください。ordinary text は `satisfied=False`、同じ内容でも `task-notification` origin は `satisfied=True`、budget を使い切ると `goal_blocked` です。同じ `tests passed` でも origin によって結果が正反対になります。空疎な主張で `/goal` を欺けない理由です。

## 次へ

`/goal` は control を main loop へ引き戻す trigger の 1 つ、condition control です。s21 の main loop 外 orchestration と対になり、一方は仕事を外へ送り、もう一方は control を内へ戻します。その外側には `/loop` と cron による time-controlled re-entry、`Monitor` による event-controlled re-entry もあり、同じ task/notification 基盤を共有します。しかし gate の core はすでにここにあります。**stop するかはモデルの一言では決まらず、goal が trusted evidence に照らして判断します。**

<!-- translation-sync: zh@v2, en@v2, ja@v2 -->
