# s07 · Session Tree

[コーストップ](../README.ja.md) | [English](README.md) | [中文](README.zh.md) | [日本語](README.ja.md)

> Pi の中での位置：Harness Session 層の Append-only Session Entry、JSONL Storage、Branch Navigation、Context Materialization です。

```text
append-only entries + parentId + current leaf
                    |
                    +-> active root-to-leaf path -> AgentMessage[] -> s06 Harness Turn
```

## 問題：Message Array だけでは分岐した履歴を保てない

平坦な Message Array は会話を続けられますが、履歴の複製や書き換えなしに、同じ過去の質問へ二つの回答を残せません。Coding Session では、古い記録を消さずに Navigation と Summary も記録する必要があります。

モデル側の要件は逆です。放棄された Branch をすべて受け取るのではなく、Active Path の一貫した Context だけを必要とします。

## 考え方：Append-only Entry Tree として Session を保存する

s07 は Session を Header と Append-only Entry の列として保存します。

```text
session
message
message
leaf
branch_summary
message
compaction
```

各 Entry は ID、`parentId`、Timestamp を持ちます。`message` は `AgentMessage`、`leaf` は Navigation、`branch_summary` と `compaction` は呼び出し側が渡した Summary を保存します。メモリ内の Leaf が Active Position を示します。

`buildContext()` は Active Root-to-leaf Path だけをたどり、その Entry を `AgentMessage[]` へ materialize します。

## まず動かす

コースの `.env` を設定し、`learn-pi-agent/` から実行します。

```bash
npm run s07
```

1 回の Prompt を直接渡すこともできます。

```bash
npm run s07 -- "read_file で README.md を確認し、学習 Phase を要約してください。"
```

このコマンドは s06 の実モデルと `read_file` Loop を走らせますが、Session は `createSessionTree()` が提供します。具体的な出力は変わる場合があります。安定した変化は保存層にあり、各 User、Assistant、Tool Result Message が現在の Leaf の下へ新しい `message` Entry として追加されます。

## コードの中身

### 1. 現在の Leaf の下へ Message を追加する

`appendMessage()` は `AgentMessage` を深く複製し、`parentId` を現在の Leaf に設定し、Entry を追加してから Leaf を新しい ID へ進めます。

```text
e1 user
└─ e2 assistant  <- leaf
```

会話が伸びても、古い Entry は決して変更されません。

### 2. Branch を消さずに Leaf を動かす

`branch(entryId)` は、元の位置と移動先を記録する `leaf` Entry をまず追加し、メモリ内の Leaf を `entryId` へ動かします。次の Message は自然にその Target の別 Child になります。

```text
e1 user
├─ e2 assistant
└─ e4 assistant  <- leaf
```

最初の回答は `buildContext(e2)` で引き続き取得でき、Active Context は `e4` をたどります。

### 3. Summary Entry を Context へ materialize する

`appendBranchSummary(summary, fromId)` は、外部から渡された Summary と、その対象 Entry を保存します。Active Path 上では、`buildContext()` がそれを `BranchSummaryMessage` にします。

`appendCompaction({ summary, firstKeptEntryId, tokensBefore })` は、外部から渡された Summary と Retained Suffix Boundary を記録します。Active Path 上で最新の Compaction なら、Context は一つの `CompactionSummaryMessage` から始まり、`firstKeptEntryId` 以降の Message が続きます。

このレッスンが実装するのは Entry Storage と Context Materialization だけです。Token Threshold の選択、Cut Point の決定、Summary 生成は行いません。それらは呼び出し側が与えます。

### 4. Append-only JSONL を往復させる

`toJSONL()` は Session Header とすべての Entry を 1 行 1 JSON Object で出力します。`loadSessionTreeFromJSONL()` は参照を検証しながら Entry Map と Leaf Position を再構築します。

同じ Session Object が s06 の `buildContext()`、`getMetadata()`、`appendMessage()` を実装します。そのため `runHarnessTurn()` は Tree を直接使い、実際の Tool Loop 中に完了 Message を順に永続化できます。

## 手を動かす

1. User Message を一つ追加し、二つの Assistant Message の間で `branch()` を呼びます。両方の Leaf ID に対する `buildContext()` を比較します。
2. `toJSONL()` で serialize し、`loadSessionTreeFromJSONL()` で reload して、Active Context と Entry Type が変わらないことを確認します。
3. 放棄した Leaf から戻った後に Branch Summary を追加し、自分で選んだ Retained Boundary を持つ Compaction も追加して、結果の `AgentMessage` Role を調べます。

## 本線につなぐ

| 境界 | s06 | s07 |
| --- | --- | --- |
| Session Storage | メモリ上の `AgentMessage[]` | Append-only Entry Tree |
| 現在位置 | Array の末尾 | 移動できる Leaf |
| 代替履歴 | 表現しない | `parentId` による Sibling Branch |
| Summary | Message Type が存在 | Summary Entry がその Message Type になる |
| 永続化形式 | なし | JSONL Header と Entry |
| 実行経路 | `runHarnessTurn()` | `SessionTree` を使う同じ実 Loop |

## Pi ソースと照合

Entry Tree、Leaf の復元、Active Path Context、Branch と Compaction Summary の materialize は Pi 0.79.1 に対応します。Pi はさらに多くの Entry Type と個別 Storage 実装を持ちますが、レッスンはデータモデルを示す最小集合に絞ります。

固定版ソースとの対応と Summary Generation の正確な境界は英語の [pi-source.md](pi-source.md) を参照してください。

## 次のレッスン

[s08 · Context Resources](../s08_context_resources/) では Filesystem-backed Source から Project Instruction、Skill、Prompt Template を読み、次の Turn Snapshot に含めます。
