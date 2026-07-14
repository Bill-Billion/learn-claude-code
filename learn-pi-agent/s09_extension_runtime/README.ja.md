# s09 · Extension Runtime

[コーストップ](../README.ja.md) | [English](README.md) | [中文](README.zh.md) | [日本語](README.ja.md)

> Pi の中での位置：Tool 登録、Command、Resource Discovery、Harness Lifecycle Event へ接続する Coding Agent の Extension Loader と Runner です。

```text
extension factory -> registrations -> runner
                      |   |   |
                      |   |   +-> before_agent_start / resources_discover / tool_call
                      |   +-----> Commands
                      +---------> Tools -> real Harness Turn
```

## 問題：すべての Workflow を Core に入れるべきではない

s08 までで、Harness は実 Model-Tool Loop、Session History、Context Resource を持ちます。すべての Workflow を直接 Core に足すと、すぐに特定 Product 向けになります。ある利用者は Tool、別の利用者は Command、実行前 Guard、追加 Skill を求めます。

Core には、外部 Module が振る舞いを加えられ、かつ二つ目の Agent Loop を所有しない安定した接続点が必要です。

## 考え方：登録と実行を分ける

Extension は小さな Registration API を受け取る Factory です。

```ts
pi.registerTool(tool);
pi.registerCommand(name, command);
pi.on("before_agent_start", handler);
pi.on("resources_discover", handler);
pi.on("tool_call", handler);
```

登録と実行は別です。Factory の Load は Tool、Command、Event Handler を記録するだけです。`MiniExtensionRunner` は対応する操作が起きたときに、Load 順でそれらを呼びます。

## まず動かす

コースの `.env` を設定し、`learn-pi-agent/` から実行します。

```bash
npm run s09
```

レッスン組み込み Extension に参加を依頼することもできます。

```bash
npm run s09 -- "note Tool で Extension Runtime が接続済みだと記録し、その結果を確認してください。"
```

これは引き続き実際の Model Call です。登録済み `note` Tool を使うか、どう使うかはモデルが決めるため、表現と Tool Call は変わる場合があります。安定しているのは、Extension Tool が Turn Snapshot より前に Merge され、組み込み Tool と同じ Registry と Tool Loop で実行されることです。

## コードの中身

### 1. Factory を Registration Record として読み込む

`loadMiniExtensions()` は、外部から渡された各 Factory を `MiniExtensionAPI` で実行します。API は登録項目を `LoadedExtension` Record へ追加するだけです。読み込まれた Extension 間で Tool または Command Name が重複すると明示的に拒否します。

`MiniExtensionRunner.getTools()`、`getCommands()`、`runCommand()` は複製済み Record を扱います。このレッスンは Caller が渡す Factory を受け取り、Extension File を動的 Import しません。

### 2. Snapshot より前に Resource と Tool を準備する

`resources_discover` Handler は Skill、Prompt、Theme の Path を返せます。Runner は各 Path に、それを報告した `extensionPath` を付けて Provenance を保ちます。s09 は発見した Skill と Prompt Path を s08 の Resource Preparation へ渡します。

`mergeExtensionTools()` は Base Tool Name との衝突を拒否し、s02 Registry を拡張します。どちらも Harness が Tool と Resource の Snapshot を取る前に行われます。

### 3. before_agent_start Message を永続化する

`before_agent_start` Handler は Extension の Load 順で動きます。各 Handler は前の Handler が作った System Prompt を見て、変更した Prompt と Custom Message を返せます。

Runner はその値を s06 の `CustomMessage` Type に materialize します。`runExtensionTurn()` は実 Harness Turn の開始前に各 Custom Message を Session へ追加するため、新しい Turn Snapshot に含まれます。モデル境界では、s06 の `convertToLlm()` がモデル向け User Message に変換します。

### 4. tool_call を s05 Hook 境界へ接続する

`createExtensionToolHooks()` は `tool_call` Event を s05 の `beforeToolCall` へ適応します。`runExtensionTurn()` では Caller の Before Hook が先に動き、引数を書き換えた場合は Extension Policy がその Effective Tool Call を受け取ります。どちらかが拒否すれば通常の Error Tool Result が作られ、Handler は実行されません。拒否されなければ、書き換え後の引数が検証と実行へ進みます。

Extension 登録 Tool 自体は、Base Tool と同じ Schema Validation、Execution Lifecycle、Result Persistence、実 Provider Continuation を使います。Extension 経路が Main Loop を迂回することはありません。

## 手を動かす

1. 一つの Factory に `echo` Tool と `hello` Command を登録します。`runner.getTools()` を確認し、`runCommand()` で Command を呼びます。
2. 一つの Skill Path を返す `resources_discover` Handler を加え、読み込まれた Skill と `extensionPath` Provenance を確認します。
3. `read_file` を拒否する `tool_call` Handler を追加します。モデルにファイル読み取りを頼み、Session が内容ではなく Error Tool Result を持つことを確認します。
4. `before_agent_start` から Custom Message を返し、Turn 前後の Session Role を調べます。

## 本線につなぐ

| 境界 | s08 | s09 |
| --- | --- | --- |
| Tool Source | Base Registry | Base と Extension 登録 Tool |
| Command | なし | Runner から呼べる登録済み Handler |
| Resource Path | Caller 引数 | Caller 引数と Extension Discovery |
| Resource Provenance | 元の File Path | Path と報告元 `extensionPath` |
| System Prompt | Resource Callback | 連鎖する `before_agent_start` 修正 |
| Tool Policy | Caller Hook | `tool_call` を同じ s05 境界へ適応 |
| 実行経路 | `runContextResourceTurn()` | 同じ実 Loop を使う `runExtensionTurn()` |

## Pi ソースと照合

Factory Registration、Load 順の Event Dispatch、Tool Blocking、Prompt Chaining、Resource Provenance は Pi 0.79.1 に対応します。Pi はさらに多くの Event と UI/Runtime 能力を公開しますが、このレッスンは s02、s05、s06、s08 と合成できる最小部分に絞ります。

固定版ソースとの対応は英語の [pi-source.md](pi-source.md) を参照してください。

## 次のレッスン

[s10 · Runtime Modes](../s10_runtime_modes/) では、同じ Harness と Extension Runtime を Interactive、Print/JSON、RPC、SDK Shell の背後へ置きます。
