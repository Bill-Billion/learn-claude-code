# s05 · Tool Hooks

[English](README.md) · [中文](README.zh.md) · 日本語

[← s04](../s04_evented_tool_loop/README.ja.md) · [目次](../README.ja.md) · [s06 →](../s06_turn_state/README.ja.md)

> ひとことで：tool 実行パスには 2 つの hook があります——beforeToolCall はこの呼び出しを走らせるかどうかを決め、afterToolCall は結果がどんな姿で context に入るかを決めます。
>
> Pi の中での位置：`@earendil-works/pi-agent-core` の `AgentLoopConfig.beforeToolCall / afterToolCall`。

→ block は黙ってスキップすることではありません。handler は走りませんが、モデルには `isError: true` の toolResult が届き、次のターンで別の道を選べます
→ terminate は every 意味論です。1 バッチ内のすべての toolCall の結果が早期停止を求めたときだけループは本当に止まり、混在バッチは通常どおり次のターンへ進みます
→ afterToolCall には mini と Pi の間に本物の差分があります。Pi が渡すのはまだ message になっていない実行結果で、mini は `ToolResultMessage` を直接渡します
→ 権限、監査、危険コマンドの遮断はすべてこの 2 か所から入ります——Pi はこうした判断をカーネルに直書きしていません

---

## 問題

s04 のループは toolCall を受け取るとためらいなく実行します。実際に使い始めると、すぐに 3 つの場面にぶつかります。

実行すべきでない呼び出しがあります。たとえば機密パスの読み取りや、危険なコマンドの実行です。

モデルに渡す前に手を入れたい結果があります。監査マークを付ける、公開すべきでないフィールドを削る、成功した結果をエラー扱いに変える、などです。

そして、やり終えたらそこで止まるべき tool もあります。たとえば `notify_done` はすでに結果を外部システムへ送っています。そのあとモデルにまとめを一言足させても意味がありません。

この 3 種類の判断に共通するのは、どれも「どの tool か、どんな引数か、何が出てきたか」に強く依存し、場面ごとに変わることです。ループのカーネルに直書きするには向きません。Pi のやり方は、実行パスに差し込み口を 2 つ残し、判断を外に任せることです。

## 考え方

2 つの hook は tool 実行パスの決まった位置に挟まります：

```text
tool_execution_start
  -> beforeToolCall     handler が走る前
  -> ローカル handler
  -> afterToolCall      handler 完了後、toolResult イベント発行の前
  -> tool_execution_end
  -> toolResult message
```

| 差し込み口 | タイミング | できること |
|------|------|---------|
| `beforeToolCall` | handler 実行前 | `{ block: true, reason }` を返す：handler は走らず、reason がエラーの toolResult になる |
| `afterToolCall` | handler 完了後 | `content` / `isError` を書き換える。`terminate: true` を返して「終わったら停止」を要求する |

どちらの hook もイベント構造は変えません。遮断された呼び出しにも `tool_execution_start/end` と toolResult のメッセージイベントは変わらず付きます。外部の観察者に見えるのは相変わらず 1 回分の完全な実行記録です——結果がエラー扱いになっているだけです。

## まず動かす

```sh
npm run session:s05
```

出力はこうなります：

```text
Blocked result: read is disabled in this lesson
Patched result: audited: read: README.md
Terminated: true
Messages: assistant -> toolResult
```

demo は 3 つのシナリオを続けて走らせています。

1 行目は実行前の遮断です。`beforeToolCall` が block を返し、handler は走っていません（registry の呼び出しカウンターは 0 のまま）。それでもモデルが受け取る toolResult には遮断の理由が書いてあります。

2 行目は実行後の書き換えです。handler は正常に走って `read: README.md` を出し、`afterToolCall` が先頭に `audited: ` を付けました。context に入るのはこの書き換え後の版です。

最後の 2 行は早期停止です。`afterToolCall` が `terminate: true` を返すと、messages は `assistant -> toolResult` で止まり、2 通目の assistant message はありません——自動の follow-up turn がスキップされました。

## コードの中身

4 ステップに分けます。

**ステップ 1**：hook の型。それぞれの hook が何を返せるかは、シグネチャに全部書いてあります：

```ts
export type BeforeToolCallResult = {
  block?: boolean;
  reason?: string;
};

export type AfterToolCallResult = {
  content?: TextContent[];
  isError?: boolean;
  terminate?: boolean;
};
```

フィールドはすべて省略可能で、hook が `undefined` を返せば「介入しない」という意味になります——何も返さない hook は、付けていないのと同じです。hook が受け取る context も見ておく価値があります：

```ts
export type HookContext = {
  assistantMessage: AssistantMessage;
  toolCall: ToolCall;
  args: Record<string, unknown>;
  messages: LoopMessage[];
};

export type AfterHookContext = HookContext & {
  result: ToolResultMessage;
  isError: boolean;
};
```

tool 名で、引数で、さらには現在の会話履歴で判断する——材料はすべてここに揃っています。

**ステップ 2**：実行パス。`executeToolCallWithHooks()` の幹は 1 つの if/else です：

```ts
const beforeResult = await hooks.beforeToolCall?.(hookContext);
let message: ToolResultMessage;
let terminate = false;

if (beforeResult?.block) {
  message = createToolResultMessage(toolCall, beforeResult.reason || "Tool execution was blocked", true);
} else {
  message = await runLocalTool(registry, toolCall);
  const afterResult = await hooks.afterToolCall?.({
    ...hookContext,
    result: message,
    isError: message.isError,
  });

  if (afterResult) {
    message = {
      ...message,
      content: afterResult.content ?? message.content,
      isError: afterResult.isError ?? message.isError,
    };
    terminate = afterResult.terminate ?? false;
  }
}
```

block 分岐では handler がまったく呼ばれませんが、それでも `isError: true` の toolResult が 1 通生まれます。Pi も同じ考え方です。tool は実行されなかったが、モデルにはエラーの結果が見え、次のターンで別のやり方を選べます。

else 分岐で `afterToolCall` が受け取る `result` は、包装済みの `ToolResultMessage` です——型を 1 層減らすための mini の簡略化です。Pi は同じ位置で `AgentToolResult`、つまりまだ message になっていない実行結果を渡し、patch が終わってから Pi 側で message に包みます。Pi のソースを読むとき、この mini の近道に引っ張られないでください。差分は [pi-source.md](pi-source.md) に記録してあります。

書き換えはフィールド単位です。`afterResult.content ?? message.content`——hook が触れなかったフィールドはそのままです。実際の Pi は `details` の書き換えにも対応していますが、s05 ではまだやりません。

**ステップ 3**：terminate のバッチ意味論。この節でいちばん思い込みで間違えやすい場所です。ループ側の集計はこうなっています：

```ts
// Pi only stops early when EVERY finalized tool result in the batch sets
// terminate; mixed batches continue normally.
let shouldTerminateTurn = toolCalls.length > 0;

for (const toolCall of toolCalls) {
  const finalized = await executeToolCallWithHooks(registry, assistantMessage, toolCall, messages, hooks, emit);
  messages.push(finalized.message);
  turnToolResults.push(finalized.message);
  allToolResults.push(finalized.message);
  shouldTerminateTurn = shouldTerminateTurn && finalized.terminate;
}
```

`shouldTerminateTurn` は「このバッチが空でない」から出発し、各結果の terminate を順に AND していきます。つまり、tool が 1 つだけ「終わったら止めて」と言っても数に入りません。1 バッチの toolCall すべての結果が terminate を求めたときだけ、ループは早期に抜けます。混在バッチ（止めたいものと止めたくないものが混ざる）は通常どおり次のターンへ進みます。Pi の原文はこうです："The loop only stops early when every finalized tool result in that batch sets `terminate: true`. Mixed batches continue normally."（`agent/README.md:113`）

出口には s04 より break が 1 つ増えています：

```ts
if (toolCalls.length === 0) {
  break;
}
if (shouldTerminateTurn) {
  terminated = true;
  break;
}
```

demo には toolCall が 1 つしかないので、その 1 件が terminate を求めればバッチ全体が求めたことになります。だから `Terminated: true` です。

**ステップ 4**：hook の付け方。`runHookedToolLoop()` は s04 のループより引数を 1 つ多く受け取ります：

```ts
export async function runHookedToolLoop(
  provider: EventProvider,
  registry: ToolRegistry,
  hooks: ToolHooks = {},
  options: HookedToolLoopOptions = {},
): Promise<HookedToolLoopResult> {
```

demo の最初のシナリオが渡しているのは、まさに最小の hook オブジェクトです：

```ts
beforeToolCall() {
  return { block: true, reason: "read is disabled in this lesson" };
},
```

hooks を渡さなければ、それは s04 のループそのもので、挙動は完全に同じです。

## 手を動かす

`s05_tool_hooks/code.ts` を開き、`runDemo()` を書き換えて `npm run session:s05` を再実行してください。最初の 2 つの実験には複数 tool のバッチが必要です。ファイル先頭の import に `createDemoToolRegistry`（s02 から）と `createMultiToolCallProvider`（s04 から）を足してください。`code.test.ts` がまさにその使い方をしています。

1. `bash` だけ遮断して `read` は通す beforeToolCall を書きます：

   ```ts
   const selective = await runHookedToolLoop(
     createMultiToolCallProvider(
       [
         { toolName: "read", args: { path: "README.md" } },
         { toolName: "bash", args: { command: "ls" } },
       ],
       "I saw the mixed results.",
     ),
     createDemoToolRegistry(),
     {
       beforeToolCall({ toolCall }) {
         return toolCall.name === "bash" ? { block: true, reason: "bash is disabled" } : undefined;
       },
     },
   );

   console.log(selective.toolResults.map((result) => `${result.toolName}: ${result.isError}`));
   ```

   read は正常に実行され、bash はエラーの toolResult に遮断され、どちらも context に入り、ループはいつもどおり最終テキストまで進みます。実際の場面での tool 別の段階的権限は、まさにこの形をしています。
2. every 意味論を自分の手で確かめます。同じ 2 tool のバッチのまま、hook を read にだけ terminate を返すものに差し替えます：

   ```ts
   afterToolCall({ toolCall }) {
     return toolCall.name === "read" ? { terminate: true } : undefined;
   },
   ```

   `terminated` は false で、最終テキストはいつもどおり現れます——バッチの半分だけの terminate は数に入りません。次に条件を外して、すべての呼び出しが `{ terminate: true }` を返すようにします。`terminated` は true になり、messages は `assistant -> toolResult -> toolResult` で止まります。
3. demo の 2 番目のシナリオの書き換えに `isError: true` を 1 手足します（content の行は残します）。実行しても `Patched result` の本文は変わりませんが、`patched.toolResults[0]?.isError` を出力すると true です——最初のシナリオと見比べてください。block は「走らずにエラー報告」、こちらは「走ったうえで結果をエラーに改判」で、本文には handler の本当の出力が残っています。

変更後は `npm run test:s05` で、この節の振る舞いの約束を壊していないことを確認できます。

## 本線につなぐ

| コンポーネント | 前の節 | この節 |
| --- | --- | --- |
| tool 実行 | `executeToolCall()`：toolCall を受け取ったら即実行 | `executeToolCallWithHooks()`：まず beforeToolCall に聞いてから、実行するかを決める |
| toolResult | handler の出力（またはエラー）がそのまま message になる | afterToolCall が content / isError を書き換えてから確定できる |
| ループ終了 | このターンに toolCall があるかだけを見る | 1 条件追加：バッチの結果すべてが terminate を求めたら早期停止 |
| ループ入口 | `runEventedToolLoop(provider, registry, options)` | `runHookedToolLoop(provider, registry, hooks, options)`。結果に `terminated` が増える |

## Pi ソースと照合

この節を読み終えたら [pi-source.md](pi-source.md) を見てください。

対応関係をひとことで言うと：mini の if/else は Pi では 2 つの関数に分かれます——`prepareToolCall()` が `beforeToolCall` を担当し（block ならエラー結果を作って実行しない）、`finalizeExecutedToolCall()` が `afterToolCall` を担当します（フィールド単位の patch）。every 意味論は `shouldTerminateToolBatch()` の中の `every()` そのものです。hook context のフィールド差分や、`AgentToolResult` と message の境界線は、pi-source.md にすべて記録してあります。

## 次の節

hook が司るのは 1 回の tool 呼び出しを生かすか殺すかです。一歩外へ引いてみると、ターンのリクエストが始まる前に、agent にはまだ決めるべきことが山ほどあります——このターンでモデルにどの tool を見せるか、system prompt は何か、どんなリソースが使えるか。

[s06 Turn State](../s06_turn_state/README.ja.md)：各ターンのリクエストの前に、Pi は session、tool テーブル、リソース、モデル設定から状態のスナップショットを 1 枚撮ります。
