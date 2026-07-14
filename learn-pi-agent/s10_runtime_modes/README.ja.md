# s10 · Runtime Modes

[コーストップ](../README.ja.md) | [English](README.md) | [中文](README.zh.md) | [日本語](README.ja.md)

> Pi の中での位置：一つの Agent Session Runtime を囲む Interactive、Print/JSON、RPC、SDK Shell です。

```text
                         +-> interactive
one MiniCoreRuntime -----+-> print (text or JSON)
one Session              +-> RPC
                         +-> SDK
```

## 問題：入口ごとに別の Agent を作るべきではない

s09 には実 Model-Tool Loop、Session Tree、Context Resource、Extension があります。それでも Product には複数の入口が必要です。人は Interactive Terminal、Script は一つの結果、別 Process は Command、Application は API を求めます。

入口ごとに Agent を作ると、Message History と設定が分裂します。RPC から送った Prompt が Interactive Session には存在せず、新しい Tool や Extension の振る舞いも複数回実装することになります。

## 考え方：四つの Shell が一つの Core と Session を共有する

s10 は四つの Shell Family を、一つの `MiniCoreRuntime` と一つの Session の周囲に置きます。

| Shell | 入力 | 出力 |
| --- | --- | --- |
| Interactive | Terminal-style Prompt の列 | Transcript |
| Print | 一つの Prompt | 最終 Text または JSONL Lifecycle Event |
| RPC | `prompt` と `get_state` Command | 対応付け可能な Response Object |
| SDK | 直接の Method Call | Result Object、State、Event Callback |

Shell Contract は小さいままです。

```ts
export interface MiniRuntime {
  prompt(prompt: string): Promise<MiniRunResult>;
  getState(): MiniRuntimeState;
  subscribe(listener: (event: MiniRuntimeEvent) => void): () => void;
}
```

`createMiniCoreRuntime()` は Async Factory です。最初に Session Metadata と Active Message Context を Hydrate します。その後 `MiniCoreRuntime.prompt()` が s09 の `runExtensionTurn()` を呼び、実 Agent Event を収集して公開し、Session Snapshot を Refresh して、成功した Run Result を記録します。すべての Shell がこの Object へ委譲します。

## まず動かす

コースの `.env` を設定し、`learn-pi-agent/` から実行します。

```bash
npm run s10
```

CLI の Print Shell へ 1 回の Prompt を直接渡すこともできます。

```bash
npm run s10 -- "read_file で package.json を確認し、pi-ai のバージョンを報告してください。"
```

モデルの回答と Tool Call は変わる場合があります。安定した経路は s09 と同じで、実 Model、Extension Turn、Active `read_file`、Session Persistence を通ります。s10 が変えるのは Caller の入口と Result の消費方法だけです。

## コードの中身

### 1. 累積 State を一つの実 Core に置く

Caller は最初に `createMiniCoreRuntime()` を await します。Factory が Session Metadata と Active Context を読むため、Resumed Session は新しい Prompt の前から Session ID、Message、最新 Assistant Text、既存 User-Prompt Count を報告できます。

`MiniCoreRuntime.prompt()` は `runExtensionTurn()` へ委譲する前に、単調な Prompt-attempt Counter を増やします。`onEvent` で各 `AgentEvent` を集め、Turn の実行中に Clone を現在の Subscriber へ送ります。成功後に Session Snapshot を Refresh し、複製した `MiniRunResult` を保存します。

```ts
const runtime = await createMiniCoreRuntime(options);
const result = await runtime.prompt(prompt);

console.log(result.runId);
console.log(runtime.getState());
```

Turn が失敗しても、Runtime は Loop がすでに永続化した Message を Refresh してから、元の Error を再 throw します。`getState().turns` は成功 Result だけでなく Prompt Attempt を数え、Branch や Compaction で Active Context が短くなっても後退しません。`getPrompts()` はこの Runtime Instance に送られた失敗を含む Attempt、`getRuns()` は `MiniRunResult` を生成した Attempt だけを返します。

### 2. Text と JSON を二つの Print 出力として扱う

`runPrintMode()` は `runtime.prompt()` を待って `finalText` を返します。`runJsonMode()` も Prompt 全体の完了を待ち、その後で収集済み Lifecycle Event を JSONL にします。

したがって、このレッスンの JSON Helper は Run 後の Serialize であり、Live Event Stream ではありません。実 Pi の JSON Branch は Prompt より前に Subscribe し、Event 到着時に書き出します。

### 3. RPC Command を同じ Method Call に変える

`runRpcMode()` は `prompt` と `get_state` を支援します。任意の Command ID を保ち、別 Process が Response を対応付けられるようにします。

レッスン版 RPC の `prompt` Response は Turn 完了を待ち、成功時に完全な `MiniRunResult` を含みます。Model、Tool Loop、Event Observer が失敗すると、`runRpcMode()` は Rejection を捕捉し、同じ対応付け可能な Response Shapeで `success: false` と Error String を返します。実 Pi Protocol は Preflight Acknowledgement と非同期 Session Event を分け、さらに多くの Command を持ちます。

### 4. SDK と Interactive Wrapper を薄く保つ

`runInteractiveMode()` は同じ Runtime へ Prompt を順番に渡し、Transcript を整形します。TUI ではなく、Editor State、Key Binding、Rendering はこのレッスンの外です。

`createSdkSession()` は、同じ Core へ委譲して `prompt()`、`getState()`、`subscribe()` を公開します。`MiniCoreRuntime.subscribe()` は基盤 Turn の実行中に `onEvent` から Clone 済み Event を受け取り、`prompt()` の完了より先に Callback を呼びます。`result.events` の事後 Replay ではなく Live Subscription です。Unsubscribe は Listener への後続 Event を止めます。

## 手を動かす

1. Session に User/Assistant Message を一組 Preload し、`createMiniCoreRuntime()` を await して、新しい Prompt 前の State を確認します。
2. Print、JSON、RPC、SDK を順に呼び、単調な `getState().turns` と `getPrompts()` を、成功だけを含む `getRuns()` と比べます。
3. `createSdkSession()` で Subscribe し、Callback 内で `getRuns().length` を確認します。Live Event は現在の成功 Run が保存される前に届きます。
4. RPC Prompt を一度失敗させてから次の Prompt を送ります。最初の Response は `success: false`、Refresh 後の Session は永続化済み Message を保持し、次の Run ID は次の Attempt Number を使います。

## 本線につなぐ

| 境界 | s09 | s10 |
| --- | --- | --- |
| Core 実行 | `runExtensionTurn()` | `MiniCoreRuntime.prompt()` で包む |
| Session | 一つの Turn に渡す | すべての Shell Call で共有 |
| Event | 一つの Turn 中の Callback | Run ごとに収集し、SDK Subscriber へ Live 配信 |
| Text 出力 | Caller が Final Message を読む | Print と Interactive が整形 |
| Machine 出力 | Result Object のみ | JSONL、RPC Response、SDK Object |
| State Hydration | Caller が Session を持つ | Async Factory が Metadata と Active Context を読む |
| Attempt State | 一度に一つの Turn | 単調 Attempt と成功だけの Run Result |

## Pi ソースと照合

Shared Runtime、Session Hydration、Mode Dispatch、Print Text/JSON Branch、RPC Response Layer、SDK Session API は Pi 0.79.1 に対応します。コースの SDK Subscription は Pi Agent Session Subscription と同じく Event を Live に受け取ります。一方、JSON Output は Prompt 後にまとめられ、RPC `prompt` は完全な Run または Failure Response を待ちます。Pi は Prompt Preflight を別に確認し、JSON と RPC Session Event は処理中にも届きます。

固定版ソースとの対応は英語の [pi-source.md](pi-source.md) を参照してください。

## 次のレッスン

[s11 · Project Trust](../s11_project_trust/) では、これらの Runtime Shell が始まる前に、どの Project-local Input を読み込めるか決定します。これは Loading Gate であり、Permission System や Sandbox ではありません。
