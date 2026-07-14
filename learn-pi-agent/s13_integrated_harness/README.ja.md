# s13 · Integrated Harness

[コーストップ](../README.ja.md) | [English](README.md) | [中文](README.zh.md) | [日本語](README.ja.md)

> Pi の中での位置：Trust と Resource を解決し、一つの Agent Session Runtime を構築して、CLI と SDK Shell から公開する Assembly Layer です。

```text
files + trust policy + package entries + Extension factories
  -> Project Trust
  -> direct Resources + Package Resolver
  -> Extension runner + Skills + Prompt Templates
  -> one MiniCoreRuntime
       +-> real Model and Tool loop
       +-> one AgentMessage Session
  -> serialized IntegratedHarnessRuntime
  -> Print / JSON / RPC / SDK
```

## 問題：部品が個別に正しくても、組み立て順が正しいとは限らない

これまでの各レッスンは一つずつ境界を検証しました。利用できる Harness にするには、それらを正しい順序で組み立てる必要があります。

Trust は Project Extension と Package の選択より先に解決します。Package Path は Extension Factory の Load より先です。Context、Skill、明示的に呼び出した Prompt Template は Tool Registry と同じ Turn に入ります。すべての Shell は一つの AgentMessage Session を共有し、二つの Caller がその Session を同時に変更してはいけません。

Assembly Layer がどれかを再実装すると、コースの最後に互換性のない第二の Agent が生まれます。そこで s13 が追加するのは Orchestration と一つの Concurrency Rule だけで、新しい Model-Tool Loop ではありません。

## 考え方：Host の依存関係を一つの構築入口へ集める

`createIntegratedHarnessRuntime()` は Host が所有する Dependency と Configuration を受け取り、s01-s12 の Public API を接続します。

| Host Input | 接続先 |
| --- | --- |
| `Model<Api>` と Stream Option | 実 s03-s06 Model Path |
| Tool Registry と Active Tool Name | 実 Tool Loop |
| `MiniSession<AgentMessage>` | 一つの累積 Session Tree |
| Resource Source と Direct Path | Context、Skill、Prompt Template |
| User/Project Package Entry | s12 Package Resolver |
| Path-to-Factory Map | Direct と Packaged Extension |
| Trust Policy と Store | s11 Project Trust |

結果は `IntegratedHarnessRuntime` です。s10 の `MiniRuntime` Contract を実装し、確認用に `projectTrusted`、`projectInputs`、`packageResources` を公開し、明示的な Prompt Template Invocation も維持します。

## まず動かす

コースの `.env` を設定し、`learn-pi-agent/` から実行します。

```bash
npm run s13 -- "read_file で package.json を確認し、どの Component が Integrated Session を共有するか説明してください。"
```

CLI は設定済みの実 Model、File System Context Resource Source、Session Tree、`read_file` Tool、Print Shell を使います。Model Output と Tool Choice は変わる場合がありますが、それらの動作はすべて `createIntegratedHarnessRuntime()` が構築する同じ Integrated Path を通ります。

`PI_PROJECT_TRUST` の Default は `ask` です。この小さな CLI には Trust Selection UI も永続 Store もないため、Decision が必要な場合は保護対象の Project Input が無効のままです。Project を確認した後、`always` で有効化し、`never` で拒否できます。

```bash
PI_PROJECT_TRUST=always npm run s13 -- "Trusted な Project Resource を要約してください。"
```

コース Host は TypeScript を動的 import せず、Project Settings を Package Entry へ Parse しません。Trusted Direct Extension には Programmatic API から明示 Factory を渡す必要があり、なければ構築に失敗します。したがって Built-in CLI で Trust を直接有効化できるのは、選択される Project Input が未設定の Extension Factory を必要としない場合です。

## コードの中身

### 1. Project Input を選ぶ前に Trust を解決する

`createIntegratedHarnessRuntime()` は `prepareProjectTrust()` から始まります。Decision は三種類の保護対象 Source を制御します。

- s11 が発見した Direct Project Skill と Prompt Template
- `.pi/extensions` にある Direct Project Extension Entry Point
- Host が渡した `projectPackages` List 全体

User Extension、Skill、Prompt、Package Input は Project Trust と独立しています。Context Candidate File も Trust Gate の外にあり、s08 と s11 の Per-directory Precedence を使います。

Decision は `runtime.projectTrusted` から確認でき、正確な Gated Path は `runtime.projectInputs` に Clone されます。

### 2. Resource Path と明示 Extension Factory を Merge する

Trusted Direct Project Extension Directory は s12 の Entry-point Discovery を通るため、Child `index.ts` は読み込めますが、`helper.ts` は第二の Extension になりません。

`extensionFactories` は正規化した Path-to-Factory Map です。Direct Extension と Package が選択した Extension Path の両方に Factory を提供します。Selected Path に Factory がなければ Error になり、Harness は String Path を Source Code 実行の許可とは解釈しません。

`createPackageRuntime()` は User Path、Trusted Project Path、Enabled Package Path を Merge します。Extension Factory は Runner、Skill は Context Resource、Prompt File は Template Catalog に入ります。通常の Turn の System Prompt に Template Body は含まれません。`runtime.invokePromptTemplate(name, args)` は選択した Template 一つだけを展開し、展開済み User Prompt を実 Turn の Queue に入れます。

### 3. 一つの実 Model と AgentMessage Session を保つ

組み立て後の Core は引き続き `MiniCoreRuntime` です。実 `runExtensionTurn()` Path を呼び、Context Resource を構築し、`before_agent_start` と Tool Hook を実行し、渡された Model を Stream し、Tool を Dispatch し、Lifecycle Event を発行して、完全な `AgentMessage` を Session へ追加します。

Host が `session` を省略すると、s13 は Session Tree を作ります。Host が明示 Session を渡す場合、Tool を使う各 Turn は完全な Message を次の順序で追加します。

```text
user
assistant(toolCall)
toolResult
assistant(final text)
```

Context Instruction、Package Skill Metadata、明示 Prompt Invocation、Extension 登録 Tool、Base Tool はすべて同じ Session に影響します。Rich Message を Plain Text に潰す Adapter はありません。

### 4. Host Prompt を直列化して、すべての Shell を再利用する

`IntegratedHarnessRuntime.prompt()` は `promptQueue` に Work を Chain します。Concurrent Call は提出順に実行され、二つの Run が一つの Session を安定して読み書きできます。成功でも失敗でも Queue は次へ進むため、一つの Rejected Run が後続 Work を止めません。明示 Prompt Template Invocation も同じ Queue を使います。

`getState()` と `subscribe()` は Core へ委譲するため、既存の s10 Helper を変換なしで再利用できます。

| Shell | Integrated Behavior |
| --- | --- |
| Print | 一つの Final Text Result を待つ |
| JSON | Run 後に収集済み Event を Serialize |
| RPC | 同じ Runtime で `prompt` と `get_state` を支援 |
| SDK | Queued Turn の実行中に Live Event を受け取る |

## 手を動かす

1. Extension Tool、Skill、Prompt Template を持つ User Package を構成します。通常の Turn が Tool と Skill は見ても、Prompt Body は見ないことを確認します。
2. `invokePromptTemplate()` を呼び、最後の User Message を確認します。展開済み Text が一つの実 Queued Turn に入ります。
3. User と Project Package を追加し、Trust を拒否します。User Resource は残り、Project Package と Direct Project Extension は消えます。
4. Trusted Direct Extension Directory に `index.ts` と `helper.ts` を置き、Entry Point にだけ Factory を渡します。その Factory だけが Load されます。
5. Print、JSON、RPC、SDK を順に呼びます。`getState().turns` と Session Message List が四回すべてを含むことを確認します。
6. `Promise.all()` で二つの `prompt()` を同時に開始します。Run ID と Session Message は提出順を保ちます。

## 本線につなぐ

| 境界 | これまでのレッスン | s13 の構成 |
| --- | --- | --- |
| Model と Tool Loop | s01-s05 | Hook と Event を持つ一つの実 Streamed Turn |
| AgentMessage State | s06-s07 | 一つの累積 Session Tree |
| Context と Resource | s08 | Context Candidate、Skill、明示 Prompt Invocation |
| Extension | s09 | Direct と Package-selected の明示 Factory |
| Runtime Shell | s10 | 一つの Shared Print/JSON/RPC/SDK Surface |
| Project Trust | s11 | Protected Path の参加前に解決 |
| Package | s12 | Enabled Path が同じ Core へ入る |
| Host Concurrency | 以前は Owner なし | Shared Session を囲む順序付き Promise Queue |

## Pi ソースと照合

Pi 0.79.1 は `createAgentSession()`、`AgentSessionRuntime`、`ResourceLoader`、`ProjectTrustStore`、`DefaultPackageManager`、Extension Loader/Runner、`AgentHarness`、Session API を通して同種の Assembly を行います。CLI Mode と SDK Call は、その Session を囲む Shell です。

コースは構成を見える形、注入できる形に保ちます。作成済み Model、Tool Registry、File Source、Package Entry、Extension Factory を受け取ります。Pi はさらに Settings Parse、Model Discovery、Extension Module Load、Package Installation、UI Service、Reload、Compaction、より完全な Session Control を所有します。

透明な Promise Queue はコース Host Policy です。Pi は Streaming 中の二回目の `prompt()` を暗黙に直列化せず、Caller が Steering または Follow-up Behavior を選びます。どちらも Active Session の意味を守りますが、Public Concurrency Contract は異なります。

固定版ソースとの対応は英語の [pi-source.md](pi-source.md) を参照してください。

## 完成したもの

最終 API は Harness の図だけではありません。実際のコース Model Path、Tool Execution、Event、AgentMessage Session、Context Resource、Extension、Trust Gate、Package Resolver、Prompt Template Invocation、四つの Runtime Shell が一つの実行経路で動きます。

[コーストップ](../README.ja.md) に戻り、学習経路全体を振り返って、次に拡張する境界を選んでください。
