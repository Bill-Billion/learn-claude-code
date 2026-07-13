# s06 · Turn State

[English](README.md) · [中文](README.zh.md) · 日本語

[← s05](../s05_tool_hooks/README.ja.md) · [目次](../README.ja.md) · [s07 →](../s07_session_tree/README.ja.md)

> ひとことで：ターンを始める前に、harness が messages・tool・resources・model・リクエストオプションを一枚のスナップショットに固めます。そのターンは最初から最後まで、このスナップショットしか見ません。
>
> Pi の中での位置：`@earendil-works/pi-agent-core` harness 層の `AgentHarness.createTurnState()`。

→ `tools` と `activeTools` は別々のリスト。登録は山ほどあっても、このターンでモデルに見せるのは一握りだけでいい
→ systemPrompt は関数でもいい——このターンにどの tool・どの skill があるかはスナップショットを撮る瞬間にしか揃わないので、解決もその瞬間に行われる
→ 途中で model を替えても resources を書き換えても、このターンは動じない。変更は失われず、次のターンが新しいスナップショットを撮るときに効く
→ 本物の Pi にはリクエスト送信前に、mini にはない変換ラインがもう一本ある。AgentMessage と LLM Message は別物

---

## 問題

障害シナリオをひとつ想像してください。あるターンがすでに走っています。1 回目の provider 呼び出しが toolUse を返し、tool の実行が終わり、これから toolResult を載せて 2 回目のリクエストを送るところです。まさにその隙間で、外部が harness の設定に手を入れました——extension が resources の skills を差し替えた、ユーザーが途中で model を切り替えた、あるいは streamOptions の headers が書き換えられた。

loop の各ステップがグローバル変数を直接読んでいたら、このターンの中で前後の辻褄が合わなくなります：

```text
system prompt は古い skills から生成されたのに、2 回目のリクエストには新しい skills が載っている
ターンの前半は model A に、後半は model B に送られた
2 回のリクエストで timeout と headers が違い、このターンがどの設定で走ったのかログから説明できない
```

この種のバグは追いにくいものです。一歩一歩を単独で見ればどれも正しく、間違っているのは「二歩の間に世界が変わった」ことだからです。

Pi のやり方は、ターンにグローバル状態を直接触らせないこと。ターンを始める前にすべての入力を turn state というスナップショットに焼き付け、ターン全体はスナップショットだけを読みます。外部の変更は失われませんが、次のターンが新しいスナップショットを撮るまで効きません。

## 考え方

`createMiniHarness()` を書きます。メソッドは `createTurnState()` ひとつだけ。session・tool 一覧・resources・model 設定からスナップショットを組み立てます：

```text
messages       session から取り出した現在のメッセージ
sessionId      provider cache とログがこのターンの持ち主を識別するための ID
systemPrompt   固定文字列、またはスナップショット時に関数が生成
model          このターンで使う provider とモデル
tools          登録済みの全 tool
activeTools    このターンで実際にモデルに見せる tool
resources      skills と prompt templates（中身が何かは s08 で扱います）
streamOptions  timeout・headers・metadata などのリクエストオプション
```

Pi のスナップショットにはもうひとつ `thinkingLevel`（このターンの推論の強さ）がありますが、mini では省いています。

この節ではスナップショットを作るだけで、provider は呼びません。

## まず動かす

```sh
npm run session:s06
```

出力はだいたいこうなります：

```text
Session: demo-session
Messages: 1
Active tools: read
System prompt: tools=read skills=audit
Timeout: 30
```

レジストリには実は read と bash の 2 つの tool が登録されていますが、`activeToolNames` が read しか挙げていないので、このターンのモデルには read しか見えません。system prompt の `tools=read` も同じリストから動的に計算されたものです。

## コードの中身

3 ステップに分けます。

**ステップ 1**：session は 2 つの口しか公開しません。

```ts
export function createDemoSession(id: string, initialMessages: MiniMessage[] = []): MiniSession {
  return {
    messages: initialMessages.map(cloneMessage),
    async buildContext() {
      return {
        messages: this.messages.map(cloneMessage),
      };
    },
    async getMetadata() {
      return { id };
    },
  };
}
```

`buildContext()` はこのターンで使う messages を、`getMetadata()` は session id を返します。本物の Pi の session は分岐できる entry tree（s07 で扱います）ですが、turn state が session に要求するのはこの 2 メソッドだけです。

**ステップ 2**：harness は作成時に tool のリストを確定します。

```ts
const tools = options.registry.tools.map((tool) => ({ ...tool }));
const activeToolNames = options.activeToolNames ? [...options.activeToolNames] : tools.map((tool) => tool.name);
validateActiveToolNames(tools, activeToolNames);
```

`tools` は登録済みの全 tool、`activeToolNames` がこのターンで有効にするものを決めます。リストに未登録の名前や重複があれば、ここで throw します。リクエストを送り出してから失敗するのではありません。

**ステップ 3**：`createTurnState()` がスナップショットを撮ります。

```ts
const context = await options.session.buildContext();
const metadata = await options.session.getMetadata();
const activeTools = activeToolNames.map((name) => tools.find((tool) => tool.name === name)!);
```

まず session のコンテキストを取り、次に session のメタデータを取り、リストに従ってこのターンの tool を選び出します。続いて system prompt の解決——固定文字列でも、関数でも構いません：

```ts
systemPrompt({ activeTools, resources }) {
  return `tools=${listActiveToolNames(activeTools)} skills=${resources.skills?.map((skill) => skill.name).join(",")}`;
}
```

動的な prompt は芸を見せるためではありません。このターンにどの tool・どの skill があるかはスナップショットを撮る瞬間にしか揃わないので、解決もこの瞬間にしか行えないのです。

最後は戻り値です。すべてのフィールドをコピーして返します：

```ts
return {
  messages: context.messages.map(cloneMessage),
  resources: turnResources,
  streamOptions: cloneStreamOptions(streamOptions),
  sessionId: metadata.id,
  systemPrompt: resolvedSystemPrompt,
  model: { ...options.model },
  tools: tools.map((tool) => ({ ...tool })),
  activeTools: activeTools.map((tool) => ({ ...tool })),
};
```

スナップショットはスナップショットらしく振る舞うべきです。`createTurnState()` が返った後に外部が resources や streamOptions、session のメッセージを書き換えても、すでに始まったこのターンには影響しません。「グローバル変数を読む」のではなく「スナップショットを一枚撮る」ことで、どのターンにも安定した、推論可能な出発点が与えられます。s06 のテストはまさにこの点を検証しています。

## スナップショットの messages は、まだモデルに送る messages ではない

mini では `turnState.messages` を取り出せばそのまま送信できます。`MiniMessage` は生まれつき LLM が理解できる形——role と content——だからです。本物の Pi はそうではありません。

Pi 内部の AgentMessage は、モデルが知っているものよりずっと多くを抱えています。ターミナル UI の通知メッセージ、extension が差し込んだ custom message、session entry、branch summary……モデルが理解するのは標準の LLM メッセージだけです。そこで Pi は毎ターン、リクエストが実際に出ていく前に、mini にはない変換ラインを通します：

```text
AgentMessage[] -> transformContext() -> convertToLlm() -> Message[] -> LLM
```

`agent-loop.ts` の `streamAssistantResponse()` にこの 2 ステップが見えます。まず `transformContext()` がコンテキストを書き換えるチャンスを一度得ます（AgentMessage[] が入って AgentMessage[] が出る。compaction のような整理作業はここに接続します）。次に `convertToLlm()` が内部メッセージを、provider が受け取れる標準の Message[] に畳み込みます。

この変換層のおかげで、Pi は内部にいくらでも豊かな状態を持ちながら、モデルに送るリクエストを汚さずに済みます——UI の通知も extension の私有データも内部に留まり、モデルが見るのは常にクリーンな標準メッセージです。mini のメッセージ型は生まれつき LLM の形なのでこの層はありませんが、本物の Pi にはあることを覚えておいてください。s09 で extension の custom message を扱うときに再会します。extension が session に書き込む独自メッセージをモデルに見せるかどうか、どんな形で見せるかを決めているのは、まさにこの変換層です。

## 手を動かす

1. demo の `activeToolNames: ["read"]` を `["read", "bash"]` に変えて再実行すると、Active tools と System prompt が一緒に変わります——両方が同じリストを読んでいるからです。さらに `["missing"]` に変えると、`createMiniHarness()` の段階で `Unknown active tool: missing` が throw されます。

2. スナップショットの隔離を検証してみます。`runDemo()` の中でスナップショットを 2 枚続けて撮り、1 枚目を汚して、2 枚目が無事かどうか見ます：

   ```ts
   const first = await harness.createTurnState();
   const second = await harness.createTurnState();
   first.activeTools[0].name = "hacked";
   console.log(second.activeTools[0].name);
   ```

   出力は read のままです。次に `createTurnState()` の戻り値にある `activeTools: activeTools.map((tool) => ({ ...tool }))` をただの `activeTools` に変えて再実行——hacked が 2 枚目のスナップショットに染み出します。これが参照共有の代償で、下の「Pi ソースと照合」で触れる、Pi の浅いコピーが残す形そのものです。

変更したら `npm run test:s06` で、この節の振る舞いの約束を壊していないか確認できます。

## 本線につなぐ

s05 までは、ターンの入力は呼び出し側に散らばっていました。provider・registry・hooks は関数引数で、session はなく、model やリクエスト設定の置き場所もありませんでした。s06 は「ターンの全入力」をひとつのオブジェクトにまとめます：

| コンポーネント | 前節（s05） | 本節（s06） |
| --- | --- | --- |
| ターンの入力 | `runHookedToolLoop(provider, registry, hooks)` のばらばらな引数 | `createTurnState()` が撮る一枚のスナップショット |
| tool | registry にあるものは loop が何でも実行できた | `tools` に全登録、`activeTools` で毎ターン選抜 |
| メッセージの出どころ | loop 内部で空配列から積み上げ | `session.buildContext()` が提供 |
| system prompt / model / streamOptions | 存在しなかった | スナップショットに入り、このターンの固定設定になる |

s06 は後続の節のハブでもあります。スナップショットの resources は s08 でプロジェクトから実際に収集されます（AGENTS.md・skills・prompt templates）。streamOptions と sessionId は、s10 で複数の実行シェルがひとつの core を共有するときのリクエストの識別と設定に使われます。そして session というブラックボックスは、次の節で分解します。

## Pi ソースと照合

この節を読み終えたら [pi-source.md](pi-source.md) へ。

対応関係をひとことで：mini の `createTurnState()` は `agent-harness.ts:331-362` の `AgentHarness.createTurnState()` に対応します。`buildContext()` + `getMetadata()` + activeToolNames で tool を選ぶ + systemPrompt を解決する、という同じ流れで、Pi のスナップショットには `thinkingLevel` フィールドがひとつ多くあります。知っておく価値のある違いがひとつ：mini は Pi より深くコピーします——Pi の `getResources()`（`agent-harness.ts:981-986`）は配列を `slice()` するだけで、skill と template のオブジェクト自体は共有参照のままです。

## 次の節

s06 は session をブラックボックスとして使いました。`buildContext()` がメッセージを、`getMetadata()` が id をくれれば、スナップショットを撮るには十分です。しかし Pi の session はメッセージ配列ひとつでは済みません——古い質問に戻って別の道からやり直せて、しかも履歴を失わないことが求められます。

[s07 Session Tree](../s07_session_tree/README.ja.md)：session は append-only の JSONL entry tree として保存され、現在位置は移動可能な leaf ポインタが決めます。
