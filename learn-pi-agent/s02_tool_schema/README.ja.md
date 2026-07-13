# s02 · Tool Schema

[English](README.md) · [中文](README.zh.md) · 日本語

[← s01](../s01_agent_loop/README.ja.md) · [目次](../README.ja.md) · [s03 →](../s03_provider_events/README.ja.md)

> ひとことで：ツールはまずモデルに見せる契約であり、その次にローカルで実行できるコードです——登録時に両面を 1 つに束ね、provider に送る前に剥がします。
>
> Pi の中での位置：`@earendil-works/pi-ai` の `Tool` 契約と、agent 側の `AgentTool` ランタイムオブジェクトの間の境界。

→ `ToolDefinition` のフィールドは name / description / parameters の 3 つだけ。モデルに見えるのはこれがすべてです
→ label と handler はどちらも `RegisteredTool` 側に住んでいます：一方は UI 表示用のフィールド、もう一方はローカル関数で、provider はどちらも受け取りません
→ 剥がす処理は `listToolDefinitions()` という 1 つの関数に集約されています——レジストリはローカルのランタイム資産で、provider に渡す payload はシリアライズ可能な契約だけです
→ `dispatchTool()` はテーブル参照に加え、必須フィールドと基本型を検査します。モデルが「ツールを呼びたい」と言うことと、ツールが実際に実行されることの間には、s04 がまるごと挟まっています

---

## 問題

s01 のデモでは assistant がすでに「ツールを呼びたい」と言っていましたが、システムの中に「ツール」というものはまだ存在しませんでした——モデルはどんなツールが使えるか知らず、ローカルにも呼び出せる関数が 1 つもありません。

ツールを足すときに一番やりがちな間違いは、いきなり tool loop から書き始めることです：読者は schema、handler、toolCall、toolResult、エラー処理、イベントストリームに同時にぶつかることになります。Pi は概念をそんなふうに混ぜていません。Pi ではツールをまず両面に分けます：

```text
モデルに見せる面：name / description / parameters
ローカルで使う面：execute または handler
```

モデルが知る必要があるのは、このツールが何をできるか、パラメータがどんな形か、それだけです。ローカル関数を手に入れることはできませんし、ツールが内部でどうファイルを読み、どう shell を叩くかを知るべきでもありません。s02 で扱うのはこの境界だけです。

## 考え方

2 つの型で両面を固定し、1 つの関数で境界を実装します：

| フィールド | どこに住むか | モデルに見えるか |
|------|--------|-------------|
| `name` / `description` / `parameters` | `ToolDefinition` | 見える。これが契約の本体 |
| `label` | `RegisteredTool` | 見えない。UI 表示用 |
| `handler` | `RegisteredTool` | 見えない。ローカル関数 |

登録時には両面を 1 つにまとめ（`RegisteredTool = ToolDefinition & { label, handler }`）、provider に送る前に `listToolDefinitions()` が label と handler をまとめて剥がします。

この節ではツールを実行しません。`dispatchTool()` が示すのは境界のもう半分——ローカルは名前から handler を引き戻せる、ということだけです。

## まず動かす

```sh
npm run session:s02
```

出力：

```text
Tools visible to the provider:
- read: Read a file by path. The s02 demo does not touch the filesystem.
- bash: Describe a shell command. The s02 demo does not execute it.
Dispatch result: read: README.md
```

ここの `read` はファイルを読んでいませんし、`bash` は shell を起動していません。証明しているのは 2 つだけです：provider にはツールの schema が見えること、そしてローカルコードはツール名から handler を見つけられること。

## コードの中身

4 ステップです。

**ステップ 1**：両面を 2 つの型として書く。`ToolDefinition` はモデルに見える契約です：

```ts
export type ToolDefinition = {
  name: string;
  description: string;
  parameters: ToolParameters;
};
```

`RegisteredTool` は契約の上にローカル用フィールドを 2 つ重ねます：

```ts
export type RegisteredTool = ToolDefinition & {
  label: string;
  handler: ToolHandler;
};
```

`label` はターミナル UI に表示する名前です。Pi の `AgentTool` も持っていますが、provider へのシリアライズでは送られません——handler と同じ側に属していて、ローカルでだけ意味を持ちます。パラメータ schema については、Pi の実コードは TypeBox で書かれています。schema はシリアライズでき、複数の provider に適合し、ランタイム検証もできる必要があるからです。教材版ではまず、ごく小さな JSON schema のサブセットを使います。

**ステップ 2**：登録。`createToolRegistry()` はツール配列を受け取る前に名前の重複を検査します：

```ts
export function createToolRegistry(tools: RegisteredTool[]): ToolRegistry {
  const seen = new Set<string>();

  for (const tool of tools) {
    if (seen.has(tool.name)) {
      throw new Error(`Duplicate tool: ${tool.name}`);
    }
    seen.add(tool.name);
  }

  return { tools };
}
```

以降のすべての検索は name をキーにします——モデルが呼び出しを発行するとき、伝えてくるのは名前だけです。2 つのツールが同名なら dispatch はくじ引きになってしまうので、登録時に即座に throw して、いちばん早い地点で問題を止めます。

**ステップ 3**：剥がす。provider に送る前に、`listToolDefinitions()` は契約だけを通します：

```ts
export function listToolDefinitions(registry: ToolRegistry): ToolDefinition[] {
  return registry.tools.map(({ handler: _handler, label: _label, ...definition }) => ({
    ...definition,
    parameters: {
      ...definition.parameters,
      properties: { ...definition.parameters.properties },
      required: definition.parameters.required ? [...definition.parameters.required] : undefined,
    },
  }));
}
```

分割代入が handler と label をまとめて捨て、残るのはちょうど `ToolDefinition` の 3 フィールドです。`parameters` はさらに一段コピーするので、返り値とレジストリは互いに影響しません。モデルが見るのは常にこのシリアライズ可能な契約だけで、ローカル関数はずっとランタイム側に留まります。これが Pi のツール体系の最初の境界で、s04 の実行も s05 の hook もこの上に建っています。

**ステップ 4**：ローカルが名前から handler を引き戻す。

```ts
export async function dispatchTool(
  registry: ToolRegistry,
  name: string,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const tool = registry.tools.find((candidate) => candidate.name === name);
  if (!tool) {
    throw new Error(`Unknown tool: ${name}`);
  }

  validateInput(tool, input);
  return tool.handler(input);
}
```

途中の `validateInput()` は、この節で定義した小さな schema subset を検証します。必須フィールドが存在し、宣言された `string`、`number`、`boolean` と実行時の型が一致しなければなりません。Pi は TypeBox で完全な JSON Schema 検証を行いますが、この教材では配列、入れ子の object、union、format、追加プロパティの規則までは扱いません：

```ts
function validateInput(tool: ToolDefinition, input: Record<string, unknown>): void {
  for (const key of tool.parameters.required ?? []) {
    if (!(key in input)) {
      throw new Error(`Missing required parameter: ${key}`);
    }
  }

  for (const [key, property] of Object.entries(tool.parameters.properties)) {
    if (!(key in input)) continue;
    const value = input[key];
    const hasExpectedType = typeof value === property.type
      && (property.type !== "number" || Number.isFinite(value));
    if (!hasExpectedType) {
      throw new Error(`Invalid parameter type: ${key} must be ${property.type}`);
    }
  }
}
```

dispatch は名前で handler を探すだけで、まだ Pi の tool loop ではありません。実際の Pi はツール実行の前後で `tool_execution_start`、`tool_execution_update`、`tool_execution_end` を発行し、さらに `beforeToolCall` と `afterToolCall` を実行します。

## 手を動かす

1. `runDemo()` に `console.log(JSON.stringify(registry.tools[0]))` を 1 行足して、`definitions` の中身と見比べてください。handler は静かに消えるのに（関数はそもそも JSON に入りません）、label はそのまま漏れて出てきます——シリアライズのついでに剥がし終えたことにできない理由がこれで、境界は明示的に書く必要があります。
2. `createDemoToolRegistry()` に 3 つ目のツール `write` を追加し、必須パラメータ `path` と `content` を持たせて、`npm run session:s02` で "Tools visible to the provider" のリストに現れることを確認してください。次に、わざと `content` を抜いて `dispatchTool` を呼び、`validateInput` が `Missing required parameter: content` を throw するのを見てください。
3. `bash` の name も `read` に変えてデモを実行すると、どのツールが使われるより前に `createToolRegistry()` が `Duplicate tool: read` を throw します。

書き換えたら `npm run test:s02` を実行して、この節の挙動の約束を壊していないか確認してください。

## 本線につなぐ

| コンポーネント | 前の節 | この節 |
| --- | --- | --- |
| ツール契約 | なし——assistant はツールを呼びたいと言うが、システムにツールという概念がない | `ToolDefinition`：name / description / parameters |
| ローカルの実行体 | なし | `RegisteredTool` が label と handler を持ち、`dispatchTool()` が名前で呼び出す |
| モデル／ローカルの境界 | 不要——provider は messages しか受け取らない | `listToolDefinitions()` が handler と label を剥がし、シリアライズ可能な契約だけを通す |

s03 の `ProviderContext.tools` に入るのがまさにこの契約リストで、s04 の tool loop が `dispatchTool()` を使って、モデルの toolCall をローカル実行へ引き戻します。

## Pi ソースと照合

この節を読み終えたら [pi-source.md](pi-source.md) を見てください。

対応関係をひとことで：`ToolDefinition` は pi-ai の `Tool` に、`RegisteredTool` は agent パッケージの `AgentTool` に対応します——Pi でも label と `execute()` はランタイム側にあります。「name / description / parameters だけを残す」処理を実際にやっているのは provider 側のシリアライズで、たとえば anthropic provider の `convertTools()` です。なお coding-agent にも `ToolDefinition` という同名の型がありますが、s02 のものとは別物です。見分け方は pi-source にあります。

## 次の節

モデルはツール契約を見られるようになりましたが、s01 の `provider.complete()` は依然として assistant message を丸ごと一度に返しています。実際のモデルは token を 1 つずつ生成し、テキストも tool call の引数も断片で吐き出されます。

[s03 Provider Events](../s03_provider_events/README.ja.md)：Pi は「モデルが生成中」という状態を 1 本のイベントストリームに分解します——assistant はストリームの中で toolCall を発行できますが、ローカルの handler はまだ実行されません。実行は s04 です。
