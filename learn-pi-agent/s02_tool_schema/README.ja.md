# s02 · Tool Schema

[コーストップ](../README.ja.md) | [English](README.md) | [中文](README.zh.md) | [日本語](README.ja.md)

> Pi の中での位置：`pi-ai` でモデルに見せる `Tool` 契約と、Agent Runtime が保持する実行可能なツールオブジェクトの境界です。

```text
モデルが見る：name + description + parameters
Harness が保持：schema + handler
```

## 問題：ローカル関数をそのままモデルへ渡せない

s01 でモデルとツールの往復は完成しましたが、一つの Tool Runtime に公開 Schema と実行可能な Handler が同居しています。ツールが増えるほど、この構造では境界を把握しにくくなります。

モデルに必要なのはシリアライズ可能な契約で、Harness に必要なのは呼び出せる関数です。Runtime Object 全体を Provider へ渡すと、モデル契約に含めるべきでないフィールドが漏れる可能性があります。Schema だけを残すと、今度はローカルで実行するものがありません。

## 考え方：ツールの二つの形を明示的に分ける

各ツールを二つの形で表し、変換を明示します。

```text
RegisteredTool
  ├── ToolDefinition：name、description、parameters
  └── ToolHandler：ローカルの実行関数

ToolRegistry
  ├── listToolDefinitions() -> モデル用の Tool[]
  └── dispatchTool()        -> 検証後のローカル実行
```

Registry が境界になります。Provider は Schema のコピーを受け取り、ローカルの振り分け処理は名前から非公開 Handler を探します。

## まず動かす

コースの `.env` を設定し、`learn-pi-agent/` から実行します。

```bash
npm run s02
```

1 回の依頼でツールの使用を明示することもできます。

```bash
npm run s02 -- "read_file で README.md を読み、五つの学習フェーズを挙げてください。"
```

回答は実行ごとに変わる場合があります。安定しているのは、モデルが `read_file` Schema を受け取り、Tool Call を出し、Registry が非公開 Handler を実行してから結果をモデルへ返すことです。

## コードの中身

### 1. ツールの二つの側面を記述する

`ToolDefinition` は `name`、`description`、`parameters` だけを持ちます。`RegisteredTool` は、ローカルの `handler` と任意の UI `label` を加えます。

```ts
export type RegisteredTool = ToolDefinition & {
  label?: string;
  handler: ToolHandler;
};
```

モデルを呼ぶ前に、このコース型を正式な `pi-ai` の `Tool` へ変換します。

### 2. Registry の主 Entry を作る

`createToolRegistry()` は名前の重複を拒否し、各定義を `pi-ai` Schema へ変換し、非公開の `WeakMap` に `{ schema, handler }` Entry を保存します。モデル側 API から Registry を使うコードには Handler を渡しません。

### 3. モデルに見せる定義だけを列挙する

`listToolDefinitions()` は、三つのフィールドだけを持つ新しいオブジェクトを返します。

```ts
{
  name: schema.name,
  description: schema.description,
  parameters: schema.parameters,
}
```

この分離は明示的です。JSON シリアライズが偶然関数を落とすことには頼りません。

### 4. ローカルで振り分ける前に検証する

`dispatchTool()` は主 Entry を検索し、未知の名前を拒否して `ToolCall` を作ります。引数検証は `pi-ai` の `validateToolCall()` へ直接委譲します。Handler はこの公式 Validator が成功した後だけ呼ばれます。

`createRegistryToolRuntime()` は、この境界を s01 の Loop へ適合させます。振り分けの失敗は Error `ToolResultMessage` になり、モデルは失敗を受け取って処理を続けられます。

### 5. 実モデルのループを変えない

`createCourseToolRegistry()` は s01 と同じ安全な `read_file` 能力を登録します。`runToolRegistryAgentLoop()` は Registry による Tool Runtime を `runAgentLoop()` へ渡します。

```ts
return runAgentLoop({
  ...agentOptions,
  toolRuntime: createRegistryToolRuntime(registry),
});
```

モデルとツールの往復は変わりません。変わるのは Schema と Handler の所有場所だけです。

## 手を動かす

1. `createCourseToolRegistry()` に二つ目の読み取り専用ツールを追加します。別の名前を付け、Handler が固定のコース情報を返すようにして、モデルに使わせてください。
2. 同じ名前のツールを二つ登録し、すぐに出る `Duplicate tool` エラーを確認します。モデルを呼ぶ前に競合を拒否します。
3. 未知の名前または文字列ではない `path` で `dispatchTool()` を呼びます。検索エラーと Schema 検証エラーを比較し、`createRegistryToolRuntime()` が両方を Error Tool Result に変える経路を追ってください。

## 本線につなぐ

| 境界 | s01 | s02 |
| --- | --- | --- |
| モデルに見せるツール | `ToolRuntime.tools` | `listToolDefinitions(registry)` |
| 実行可能なコード | Inline Tool Runtime | 非公開 Registry Handler |
| 引数検証 | `read_file` Runtime 内の `validateToolCall()` | `dispatchTool()` に集約 |
| Loop の入口 | `runAgentLoop()` | `runToolRegistryAgentLoop()` |
| 実際の能力 | 安全な `read_file` | Registry 経由の同じ安全な `read_file` |

## Pi ソースと照合

公開 Schema は `@earendil-works/pi-ai` 0.79.1 と同じ `Tool` の形と `validateToolCall()` を使います。Registry 側は、Pi のより豊富な `AgentTool` Runtime Object と Coding Tool 構築処理を小さくしたものです。

固定版ソースとの対応と、Pi 内部にある二つの異なる `ToolDefinition` の説明は、英語の [pi-source.md](pi-source.md) を参照してください。

## 次のレッスン

[s03 · Provider Events](../s03_provider_events/) では Registry を保ち、完成した応答を返すインターフェースを正式な `pi-ai` Event Stream へ変えます。
