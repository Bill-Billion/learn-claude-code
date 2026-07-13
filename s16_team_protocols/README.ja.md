# s16: Team Protocols — Teammate の間には取り決めが必要

[中文](README.zh.md) · [English](README.md) · [日本語](README.ja.md)

s01 → ... → s14 → s15 → `s16` → [s17](../s17_autonomous_agents/) → s18 → s19 → s20
> *「Teammate の間には取り決めが必要」* — request-response パターンで協議を動かします。
>
> **Harness 層**: プロトコル — Agent 間の構造化された handshake。

---

s15 の teammate は仕事も伝言もできますが、伝言はすべて自由文です。負荷が上がると、2 つの場面ですぐ問題が見えます。

**Shutdown。** Lead は Alice に作業を止めてほしい。「もう止めていい」と送るのでしょうか。Alice のモデルは助言、称賛、あるいは新しいタスクとして解釈するかもしれません。thread を直接殺せば、書きかけのファイルがディスク上で壊れます。

**承認。** Bob は認証モジュールをリファクタリングしたいと考えています。高リスクな操作なので、先に計画を提出し、承認後に着手すべきです。しかし「こう進めるつもりです」も「よし、進めて」も通常の chat です。Lead が同時に 2 人の計画を待っているとき、「了解」とだけ届いたら、誰のどの件への返事でしょうか。

2 つの場面はまったく同じ形です。一方が request を送り、もう一方が response を返し、response はどの request に答えたか特定できなければなりません。chat はモデルの理解に頼り、理解には曖昧さがあります。協調に必要なのは曖昧でない部分、つまり**プロトコルです。メッセージに機械的に検査できるフィールドを加えます。**

![Team Protocols Overview](images/team-protocols-overview.svg)

---

## 3 つのフィールド、1 つの状態機械

足りないものはちょうど 3 つです。種類（これは shutdown 指示で雑談ではない）、番号（この response はどの request への返事か）、状態（どこまで進んだか）です。コードにすると次のようになります。

```python
@dataclass
class ProtocolState:
    request_id: str    # req_042317、request ごとに一意
    type: str          # "shutdown" | "plan_approval"
    sender: str
    target: str
    status: str        # pending | approved | rejected
    payload: str

pending_requests: dict[str, ProtocolState] = {}
```

response が戻ったら番号で照合し、3 つの検証を 1 つも省かず行います。

```python
def match_response(response_type: str, request_id: str, approve: bool):
    state = pending_requests.get(request_id)
    if not state:
        return   # ① 未知の番号: 自分が送った request ではない
    if state.type == "shutdown" and response_type != "shutdown_response":
        return   # ② 種類が不一致: shutdown に plan response で答えるメッセージは拒否
    if state.status != "pending":
        return   # ③ 結案済み: 重複 response は無視
    state.status = "approved" if approve else "rejected"
```

各検証が別の事故を防ぎます。番号がなければ、Lead が並行して 2 件の response を待つと必ず取り違えます。種類の検証がなければ、フィールドを誤ったメッセージが別の request を汚染します。結案済みか確認しなければ、ネットワーク再送で approved になった状態がもう一度書き換わります。3 つ目には冪等性という名前もあります。同じメッセージを 2 回処理しても 1 回と同じ結果になる、分散システムの基本的な礼儀です。

---

## 1 つの強い制約: 消費入口は 1 つにする

s15 で説明したように、mailbox は消費型で、読むと内容を削除します。そこへ protocol response も混ざることで、隠れた危険が生まれます。Lead には `check_inbox` ツールと main loop の wake-up という 2 つの読取経路があります。どちらかが直接 `BUS.read_inbox` を呼ぶと、`shutdown_response` を取り出しても `match_response` へ通さず、`pending_requests` の request は永遠に pending のままです。

修正は入口を絞ることです。すべての読取を 1 つの関数へ通し、先に route してから返します。

```python
def consume_lead_inbox(route_protocol: bool = True) -> list[dict]:
    msgs = BUS.read_inbox("lead")
    for msg in msgs:
        req_id = msg.get("metadata", {}).get("request_id", "")
        if req_id and msg.get("type", "").endswith("_response"):
            match_response(msg["type"], req_id, msg["metadata"].get("approve", False))
    return msgs
```

消費型ストレージに複数 consumer がいるなら、入口を統一しなければなりません。この規則は本章に限らず、「読むと消える」あらゆるデータソースに当てはまります。

---

## Shutdown handshake: 先に acknowledgement、次に退場

プロトコルの土台ができると、shutdown はきれいな handshake になります。Lead 側で request を登録して送ります。

```python
def run_request_shutdown(teammate: str) -> str:
    req_id = new_request_id()
    pending_requests[req_id] = ProtocolState(request_id=req_id, type="shutdown",
                                             sender="lead", target=teammate,
                                             status="pending", payload="")
    BUS.send("lead", teammate, "Please shut down gracefully.",
             "shutdown_request", {"request_id": req_id})
```

teammate 側のループには dispatch 層を追加します。protocol message は種類別の handler へ送り、通常メッセージは従来どおり会話へ注入します。

```python
if msg_type == "shutdown_request":
    BUS.send(name, "lead", "Shutting down gracefully.",
             "shutdown_response", {"request_id": req_id, "approve": True})
    return True   # 先に acknowledgement、その後 exit path へ
```

先に acknowledgement、次に退場という順序には意味があります。cleanup の途中で何か失敗しても、Lead は少なくとも request が届いたと分かり、すでに死んだ teammate を永遠に待たずに済みます。

さらに、s15 の「最大 10 ラウンド」はこの章で予告どおり進化します。teammate は最初の仕事を終えても退場せず、standby loop に入り、1 秒ごとに mailbox を確認します。新しいタスクが来れば仕事へ戻り、`shutdown_request` が来て初めて片付けて退場します。ライフサイクルは「カウンターが 0 になったら終了」から「指示を待つ」へ変わり、s15 で示した実システムの形に近づきました。

---

## Plan approval: 同じ状態機械を逆向きに使う

approval flow はまったく同じ仕組みを使い、request の向きだけが逆になります。teammate が開始し、Lead が判断します。

```
Bob: submit_plan("認証をリファクタリング: 先にテストを追加し、その後 interface を変更...") → plan_approval_request (req_xxx)
Lead: review_plan(req_xxx, approve=True)                                                 → plan_approval_response
Bob の会話へ注入: [Plan approved] Proceed with the task.
```

1 つの `request_id` による対応付けと、1 つの pending → approved/rejected 状態機械で、2 種類の protocol を扱えます。将来、資源申請のような 3 種類目を加えるときも同じ形を使えます。「取り決め」を構造にした見返りです。

境界も正直に説明する必要があります。**これは protocol レベルの承認であり、コードレベルの gate ではありません。** `submit_plan` の後も teammate thread は動き続け、ツールも呼べます。「承認まで待つ」はモデルの自制に依存しています。強制するには、tool dispatch 層で未承認の操作を止める必要があります。s03 で見たように、会話層の許可は境界層の許可ではありません。この教材版は会話層だけを構築し、境界層を空けています。

> 実際の Claude Code の shutdown は 3 方向 protocol です。teammate は「まだ仕事がある」のような理由を添えて `shutdown_rejected` を返せます。確認後、システムは terminal pane を自動で片付け、担当タスクを解放し、メンバーを roster から外します。実行 gate は本当にツール層で未承認の高リスク操作を止め、モデルの自制には頼りません。

---

## s15 からの変更点

| コンポーネント | 変更前 (s15) | 変更後 (s16) |
|------|-----------|-----------|
| メッセージ | 自由文 | +type / request_id / metadata 構造 |
| プロトコル | なし | `ProtocolState` 状態機械（pending → approved/rejected） |
| teammate のライフサイクル | 最大 10 ラウンド | standby loop、`shutdown_request` でのみ退場 |
| Lead の新しいツール | — | `request_shutdown`, `request_plan`, `review_plan` |
| teammate の新しいツール | — | `submit_plan` |
| mailbox の消費 | 経路ごとに読取 | `consume_lead_inbox` の単一入口 + protocol routing |

---

## 試してみる

```sh
cd learn-claude-code
python s16_team_protocols/code.py
```

1. **丁寧な shutdown**: `Spawn a teammate 'alice' (a writer) to write a haiku to haiku.md, wait for her result, then ask her to shut down.` 完全な経路がログに出ます。`[protocol] shutdown_request → alice (req_xxxxxx)`、次に `[protocol] alice approved shutdown`、最後に `[protocol] shutdown ✓ (req_xxxxxx: approved)` です。1 つの番号を発行から結案まで追えます。
2. **Plan approval**: `Spawn 'bob' (an engineer) and ask him to submit a plan for adding a config file, then approve his plan.` 番号付きの `plan_approval_request` が Lead の mailbox に入り、`review_plan` の後で初めて Bob が `[Plan approved]` を受け取って着手する様子を確認します。
3. **Standby loop**: 実験 1 で Alice が原稿を渡してから shutdown を頼まれるまで、退出も terminal の占有もせず、静かに mailbox を見張っています。s15 の仕事が終わると解散する teammate と比べれば、「指示を待つ」の違いが分かります。

---

## 次へ

プロトコルによって協調に規則が生まれましたが、分担はまだ Lead がすべて行います。「Alice はこれ、Bob はあれ」。board に 10 タスクあれば、Lead は 10 回名前を呼ぶ必要があります。

s12 のタスクシステムには、すでに `claim_task` があります。teammate が自分で board を見て claim し、完了したら次を取るようにして、Lead は問題の定義だけを担当できないでしょうか。

s17 Autonomous Agents → Lead の割り当てなしで teammate が自己組織化します。

<!-- translation-sync: zh@v2, en@v2, ja@v2 -->
