# s22: Goal Loop — 終了を決めるのは目標、モデルではない

[中文](README.zh.md) · [English](README.md) · [日本語](README.ja.md)

s01 → ... → s20 → s21 → `s22`

> *"turn を終えてよいかは、モデルではなく目標条件が判定する"* — `/goal` は turn の終わり際に 1 つの gate を挿す：毎 turn 後、独立した evaluator が信頼できる証拠が条件を満たすか判定し、満たさなければ制御を次の turn へ押し戻す。
>
> **Harness 層**: 目標ループ — turn の境界に、host が所有する完了 gate を 1 つ加える。

---

## 問題

s01 から s21 まで、turn はどう終わるか？ model が `tool_use` を出さなくなると loop は `return` する。一度きりの task ならこれでいい——終わったら終わり。

しかし一部の目標は **複数の turn にまたがって追い続ける** 必要がある：「テストを green にする」「deploy が成功するまで」。よくある失敗は 2 つ：model が半分やって「まあ十分」と止まる；あるいは `tests passed` と打つだけで切り上げようとする。欲しいのは——**この turn を終えてよいかは model の判断ではなく、明示的な条件が信頼できる証拠に対して判定する**ことだ。

これは timer（s14 cron）でも、background task（s13）でも、model の自制でもない。host が turn の境界に加える gate だ。

## 解決策

`/goal <条件>` は session スコープの停止条件を設定する。host はそれを active goal として保存し、毎 turn 後、独立した small/fast の evaluator model が transcript の中の**信頼できる証拠**が条件を満たすか判定する。満たさない → gate がこの停止を塞ぎ、continuation を次の turn に送り込む；満たす → goal を clear し、達成を記録する。

![Goal Loop 概観](images/goal-loop-overview.svg)

s01 の loop と比べると、増えるのは判定 1 つだけ——model が止まりたいとき、まず目標に訊く：

```python
# s01：model が止まると言えば止まる
if not has_tool_use(response):
    return
# s22：止まりたいとき、まず目標 gate を通す
if not has_tool_use(response):
    verdict = goal.evaluate_after_turn()
    if verdict == "continuing":
        continue                 # 未達成 -> 押し戻してもう 1 turn
    return                       # 達成 / 予算超過 / 目標なし -> 本当に止まる
```

## 仕組み

### /goal：turn 境界の 1 つの gate

`/goal` は session スコープの prompt ベース Stop hook だ。main loop の形は変えず、各 turn の終わりに `evaluate_after_turn()` を 1 つ差し込むだけ。この gate は **host が所有する**——model の自制ではない。model は 1 turn 引き止められたことすら知らず、ただ次の入力を受け取るだけだ。

```python
def submit(self, text, origin=None):
    ...                                  # 入力を記録、1 回の (mock) assistant turn を走らせる
    return self.goal.evaluate_after_turn()    # <-- turn 境界の Stop gate
```

> 実際の Claude Code：`/goal` は session スコープの Stop hook で、workspace trust と hook 制限で門制される；binary に `active_goal`、`goal_status`、`goal_met`、`tengu_goal_achieved` などの marker がある。

### 目標を設定：証拠ウィンドウは命令の後から始まる

`set_goal` は active goal を保存する：目標テキスト、予算 `max_turns`、カウンタ、そして `start_index`——**証拠ウィンドウの起点**だ。現在の transcript 長を取るので、`/goal` 命令の行はすでにウィンドウの外にある。これが第一の防御：命令テキストは自分自身を満たせない。

```python
def set_goal(self, objective, max_turns=20):
    self.active = {
        "objective": objective, "status": "active",
        "start_index": len(self.transcript),   # 証拠ウィンドウはここから；命令自体はすでに外
        "max_turns": max_turns, "checks": 0, "continuation_turns": 0,
    }
```

> 実際の Claude Code：`GoalRuntime.setGoal()` が activeGoal、startIndex、カウンタ、予算を保存する；提出後に `resetEvidenceStart()` でウィンドウを命令の直後に揃える。

### evaluator の判定：信頼できる証拠だけを認める

ここが核心だ。evaluator は会話全体を見ず、証拠ウィンドウ内の**信頼できる origin** のメッセージだけを見る。3 つのフィルタが「達成に見えて実は違う」テキストを締め出す：

```python
TRUSTED_EVIDENCE_ORIGINS = {"task-notification", "monitor-line"}

def evidence_text(self):
    out = []
    for m in self.transcript[self.active["start_index"]:]:
        if m.origin.get("kind") == "slash-command":                     # 1 slash-command 由来は不可
            continue
        if m.role == "user" and m.content.strip().startswith("/goal"):  # 2 /goal 命令行は不可
            continue
        if m.origin.get("kind") not in TRUSTED_EVIDENCE_ORIGINS:        # 3 信頼できる origin だけ
            continue
        out.append(f"{m.role}: {m.content}")
    return "\n".join(out)
```

効果：user が打った `tests passed` は認められず、`task-notification` が運んできた同じ行は認められる。model は誤魔化せない——自分の一言で goal を「達成」にはできない。教学版の `goal_satisfied()` は決定的な keyword チェック；実際の版はウィンドウを small/fast model に渡す。

> 実際の Claude Code：evaluator は worker と分離した small/fast model（marker `evaluatorModel`、`default small fast model`）で、任意の尤もらしさではなく transcript 証拠を判定する。

### gate の 3 状態：completed / continuing / blocked

`evaluate_after_turn` は turn ごとに 1 回走り、出口は 3 つ：満たせば goal を clear（completed）；満たさず予算が残っていれば continuation を enqueue して次の turn を走らせる（continuing）；予算を使い切れば止める（blocked）——判定できない goal が無限に回り続けないように。

```python
def evaluate_after_turn(self):
    g = self.active
    g["checks"] += 1
    if self.goal_satisfied():
        g["status"] = "completed"; self.active = None
        return "completed"                          # 達成 -> goal を clear
    if g["continuation_turns"] < g["max_turns"]:
        g["continuation_turns"] += 1
        self.queue.enqueue(
            value="Continue working ... do not treat this reminder as completion evidence.",
            origin={"kind": "active-goal"})
        return "continuing"                         # 未達成 -> continuation を enqueue
    g["status"] = "blocked"; self.active = None
    return "blocked"                                # 予算超過 -> もう塞がない
```

その continuation は `do not treat this reminder as completion evidence` という一文を自ら抱える——だから reminder テキスト自体も証拠から除外される。3 つの誤判定防御が揃う：命令テキスト、reminder テキスト、ただのテキスト、どれも達成にはならない。

> 実際の Claude Code：`evaluateAfterTurn` は `goal_evaluated` を出し、結果に応じて complete / continuation を enqueue / block する；デフォルト予算は `20`。

### continuation と外部 async inbox の分流

continuation は同じ `CommandQueue` に入るが、外部の async イベント（task 完了通知、monitor 行）とは **同じ drain ではない**。`dequeue` は switch を取る：外部 inbox の drain はデフォルトで active-goal の continuation を飛ばす。

```python
def dequeue(self, include_goal_continuations=True):
    ...
    for idx, item in enumerate(self.items):
        if include_goal_continuations or item["origin"].get("kind") != "active-goal":
            return self.items.pop(idx)
    return None
```

なぜ分けるか：real-model テストで bug が見つかった——model が continuation を外部通知のように一緒に drain し、background 証拠が届く前に goal を死んだと判定してしまった。分流後は、goal の前進は明示的な一歩になり、async イベントに引きずられない。

> 実際の Claude Code：`drainCommandQueue` はデフォルトで `includeGoalContinuations=false`、active-goal continuation と外部 async inbox drain を分ける。

### まとめて走らせる

`code.py` は `/goal until tests passed and deploy green` を走らせる：goal 設定後はまだ信頼できる証拠がない → gate が turn ごとに押し戻す；user が `tests passed` と打っても認められない（origin が信頼できない）；background task が `task-notification` を届けると証拠が揃う → completed。さらに `max_turns=2` の goal で blocked を示す。

```python
s.submit("/goal until tests passed and deploy green")   # goal 設定、ウィンドウは命令の後
s.submit("tests passed, trust me")                      # ただのテキスト -> 達成にならない
s.submit("tests passed; deploy green",
         origin={"kind": "task-notification"})           # 信頼できる証拠 -> completed
```

## s21 からの変更

| | s21 Workflow Runtime | s22 Goal Loop |
|--|---------------------|---------------|
| トリガー | スクリプト制御のオーケストレーション（main loop を離れる） | 条件制御の継続（main loop に再入する） |
| どこに付くか | tool layer：`Workflow` ツール 1 つ | turn 境界：完了 gate 1 つ |
| 誰が止めるか決めるか | スクリプトが終われば終わり | 目標条件が信頼できる証拠に対して判定 |
| 新しい仕組み | script DSL、background task、journal/resume、構造化出力 | 目標 gate、証拠の信頼境界、continuation 分流、予算 |

s21 はオーケストレーションを script として書き、仕事を扇出して main loop から離す；s22 はその逆——制御を main loop に**再入**させる力だ：goal が満たされるまで、turn を終わらせない。どちらも s01 の `while` は変えず、両側から圧をかけるだけだ。

## 試す

```bash
python s22_goal_loop/code.py          # /goal until tests pass + deploy green、gate の判定を見る
```

観察：goal 設定後、毎 turn の終わりに `goal_evaluated` が出る；ただのテキストは `satisfied=False`、`task-notification` 由来は `satisfied=True`；予算を使い切ると `goal_blocked`。同じ `tests passed` でも、origin が違えば判定は逆になる——これが `/goal` が一言では騙されない理由だ。

## これから

`/goal` は「main loop に再入する」トリガーの 1 つ：条件制御だ。s21 の「main loop を離れる」とちょうど対になる——一方は仕事を扇出し、もう一方は制御を引き戻す。さらに外には時間制御（`/loop`、cron）と事件制御（`Monitor`）の再入があり、同じ task / 通知の基盤を共有する；だが gate の核心はすでにここにある：**止まるか否かは model の一言ではなく、目標が信頼できる証拠に対して判定する。**

<!-- translation-sync: zh@v1, en@v1, ja@v1 -->
