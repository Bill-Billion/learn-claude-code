# s17: Autonomous Agents — Lead を待たず、空いたら board から claim する

[中文](README.zh.md) · [English](README.md) · [日本語](README.ja.md)

s01 → ... → s15 → s16 → `s17` → [s18](../s18_worktree_isolation/) → s19 → s20

> *「Lead の割り当てを待たず、空いたら board から claim する」* — idle 時に poll し、タスクがあれば claim します。
>
> **Harness 層**: 自律 — Lead の割り当てに依存せず、teammate が自己組織化します。

---

s16 でチームに規則はできましたが、分担方法はまだ指名制です。「Alice はこれ、Bob はあれ」。board に 10 タスクあれば、Lead は 10 回名前を呼びます。チームが大きくなるほど、Lead の turn はすべて配車係に費やされ、その 1 turn ごとに実際の API 料金がかかります。時系列も硬直しています。Lead が plan approval で忙しい間、仕事を終えた teammate は、board に手つかずのタスクがあっても待つしかありません。

成熟したチームはそう動きません。task board は公開され、空いている人が自分で取ります。この章では分担を push から pull へ反転します。**タスクは割り当てられるのではなく、claim されます。**

s12 で植えた種がここで芽を出します。タスクファイルの `owner` フィールドと `claim_task` の所有者チェックは当時余計に見えましたが、今は複数 Agent が同じ仕事を奪い合わないための土台です。

![Autonomous Agents Overview](images/autonomous-agents-overview.svg)

---

## ライフサイクル: WORK で走り、IDLE で巡回し、仕事がなければ自分で帰る

3 章を通じて teammate の生き方は進化してきました。s15 では 10 ラウンド後に解散し、s16 では仕事後に待機して判断を待ち、s17 では次の仕事を自分で探します。コードでは 2 状態のループです。

```python
while True:
    # WORK: 1 回の sprint（最大 10 LLM ラウンド）で手元の仕事を進める
    for _ in range(10):
        ...  # mailbox の確認、モデル呼び出し、ツール実行

    # IDLE: 巡回。5 秒ごとに確認し、60 秒収穫がなければ終了
    idle_result = idle_poll(name, messages, name, role)
    if idle_result in ("shutdown", "timeout"):
        break
```

巡回の優先順位は明確で、mailbox が board より先です。

```python
def idle_poll(agent_name, messages, name, role) -> str:
    for _ in range(IDLE_TIMEOUT // IDLE_POLL_INTERVAL):   # 60s / 5s = 12 回
        time.sleep(IDLE_POLL_INTERVAL)

        inbox = BUS.read_inbox(agent_name)
        if inbox:
            ...                      # shutdown_request → acknowledgement 後に退場
            return "work"            # 通常メッセージ → 会話へ注入し、仕事へ戻る

        unclaimed = scan_unclaimed_tasks()
        if unclaimed:
            result = claim_task(unclaimed[0]["id"], agent_name)
            if "Claimed" in result:  # claim 成功後にだけ成立
                return "work"
    return "timeout"                 # 60 秒何もなければ自分で退場
```

`timeout` 分岐には立ち止まる価値があります。仕事のない社員は自分で帰ります。これは単なる省力化ではなく、節約です。idle poll する thread はモデルを呼ばなくても、永遠に退場しなければ process 内に役目のない teammate が蓄積します。60 秒は教材用の値です。本番システムならもっと長い window にするか、Lead に通知して残すかどうかを判断させます。

---

## 仕事の奪い合い: 早い者勝ち、負けたら巡回を続ける

board の走査は、本当に着手できる仕事だけを選びます。3 条件すべてが必要です。

```python
def scan_unclaimed_tasks() -> list[dict]:
    unclaimed = []
    for f in sorted(TASKS_DIR.glob("task_*.json")):
        task = json.loads(f.read_text())
        if (task.get("status") == "pending"      # まだ誰も着手していない
                and not task.get("owner")        # owner がいない
                and can_start(task["id"])):      # 依存先がすべて完了（s12 のチェック）
            unclaimed.append(task)
    return unclaimed
```

2 人の teammate が同時に巡回し、同じタスクを見たらどうなるでしょう。答えは `claim_task` の戻り値チェックにあります。s12 の所有者チェックがここで効きます。先に書いた側が状態を `in_progress` に変え、後から `claim_task` を呼んだ側は `"Task xxx is in_progress, cannot claim"` を受け取ります。したがって claim 後には必ず結果を検証し、`"Claimed" in result` のときだけ獲得です。負けた側は `[idle] claim failed` を 1 行出して巡回を続け、次の周回で別の仕事を探します。

claim に成功すると、Harness は task を読み直し、完全な JSON を `<auto-claimed>` に入れて teammate の会話へ注入します。subject だけでは作業契約になりません。何を作るか、今着手できるかを判断するには、description、依存先、owner、現在の status も必要です。後から確認するときは、`get_task` が同じ record を返します。

正直な境界は同じです。教材版に file lock はなく、2 つの thread が同じミリ秒に `pending` を読み、両方が書く window は残っています。実システムは s12 で説明したとおり、file lock 内で再読込してから判定します。教材版は小さな競合 window を受け入れる代わりに、「楽観的 claim + 失敗時の retry」というパターンを直接読める形にしています。

---

## Identity の再注入: 長く走る人は自分が誰か忘れる

teammate の context は s15 の `messages[-20:]` sliding window を使います。短命なら問題ありませんが、自律 teammate は長距離走者です。タスクを次々 claim し、window が前へ滑り続けると、最初の「あなたは Alice、poet です」という文はいずれ外へ落ちます。identity を失った teammate は無関係な返答をしたり、自分を Lead だと思って他人を指揮し始めたりします。

そこで外側ループの開始時に message list を確認し、短ければ、つまり開始直後か切り詰められた直後なら identity を戻します。

```python
if len(messages) <= 3:
    messages.insert(0, {"role": "user",
        "content": f"<identity>You are '{name}', role: {role}. "
                   f"Continue your work.</identity>"})
```

これは s08 の要約で 5 種類の情報を残したことや、s09 の memory が compaction に耐えることと同じ感覚です。**context は失われるため、生き残るべき情報には、再び戻す責任者が必要です。** マルチ Agent システムで最も失ってはいけないのが identity です。

> 実際の Claude Code では、idle teammate は直接退場せず、Lead へ `idle_notification` を送り、Lead または timeout policy が残すか決めます。claim は file lock で競合を防ぎます。教材版の「60 秒で自分から帰る」は、この判断を 1 つの定数へ縮めたものです。

---

## s16 からの変更点

| コンポーネント | 変更前 (s16) | 変更後 (s17) |
|------|-----------|-----------|
| 分担方法 | Lead が指名して割当 | teammate が board を走査して claim（pull model） |
| teammate のライフサイクル | WORK → standby → 外部から終了 | WORK → IDLE 巡回 → 自動 claim / timeout で退場 |
| teammate のツール | 5 | 8（+`list_tasks`, `claim_task`, `complete_task`） |
| 新しい関数 | — | `scan_unclaimed_tasks`, `idle_poll` |
| identity の維持 | なし | message list が短くなったとき `<identity>` を再注入 |

---

## 試してみる

```sh
cd learn-claude-code
python s17_autonomous_agents/code.py
```

1. **完全な pull pipeline**: `Create three tasks: write a haiku to a.md, write a limerick to b.md, write a couplet to c.md. Then spawn two teammates 'w1' and 'w2', both poets, with the prompt "Check the task board and work autonomously."` Lead は最初から最後まで 1 件も割り当てません。`[idle] w1 auto-claimed` と `[idle] w2 auto-claimed` が交互に現れ、3 タスクを 2 人で分け、速い側が多く担当する様子を見てください。
2. **claim 失敗の現場**: 実験 1 では、おそらく `[idle] claim failed: Task ... is in_progress` という行が見えます。2 人が同時に同じタスクを見つけましたが、負けた側は crash も重複作業もせず、ログを出して巡回を続けます。この 1 行が s12 の所有者チェックの価値です。
3. **自分で帰る**: 3 タスクがすべて終わったら、何も作らず 60 秒待ちます。`[idle] w1 timeout (60s)` に続いて `[teammate] w1 finished` が現れます。仕事のない人は zombie thread を残さず帰ります。

---

## 次へ

teammate は自律しましたが、新しい問題も生まれます。2 人が別々に claim したタスクが、偶然同じファイルを変更するかもしれません。1 人が書き終えた直後に、もう 1 人が上書きします。タスクは分離されても filesystem は分離されていません。s06 で触れた問題が、今や現実になりました。

s18 Worktree Isolation → 各タスクに独立した作業場所を与えます。git worktree で別々のコピーを変更し、完了後に merge します。

<!-- translation-sync: zh@v2, en@v2, ja@v2 -->
