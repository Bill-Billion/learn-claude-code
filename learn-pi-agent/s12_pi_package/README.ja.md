# s12 · Pi Package

[English](README.md) · [中文](README.zh.md) · 日本語

[← s11](../s11_trust_execution_env/README.ja.md) · [目次](../README.ja.md) · [s13 →](../s13_integrated_harness/README.ja.md)

> ひとことで：package は単なる配布単位です——resolver が 1 つの package を extension・skill・prompt・theme の 4 種類のリソースに展開し直すだけで、実行系には何も追加されません。
>
> Pi の中での位置：`@earendil-works/pi-coding-agent` の package-manager 層。

→ installer の filter がないとき、`pi` manifest が正式な境界になります：載っていないファイルは export されず、省略した resource key も規約ディレクトリにはフォールバックしません
→ installer の filter は package を狭める方向にしか働きません。`+` を使っても、作者が載せていないファイルは押し込めません
→ `extensions/` の中のすべての `.ts` が extension になるわけではありません——トップレベルのファイルと明示的なエントリだけが extension で、import される helper は数えません
→ プロジェクトの package はまず s11 の trust ゲートを通り、通ったあとで同名のグローバル package と競合します：プロジェクト側が勝ちます

---

## 問題

s11 までで、1 つの workflow は 4 つのディレクトリに散らばっています：

```text
extensions/review.ts
skills/review/SKILL.md
prompts/review.md
themes/review.json
```

自分だけで使うなら、`~/.pi/agent/` かプロジェクトの `.pi/` に置けば十分です。チームやコミュニティに配ろうとした瞬間、新しい問いが生まれます：package を受け取ったとき、Pi はどのファイルが extension で、どれが skill で、どれがただの実装詳細だと判断するのか？

この問いの本質は権限の切り分けです。package の作者、ディレクトリ規約、install する人——三者それぞれに言い分があります。境界が曖昧だと事故が起きます。作者が export するつもりのなかった helper が他人の session に読み込まれたり、install する人が `[]` を「未設定」のつもりで書いて、あるリソース種別を丸ごと切ってしまったり。

s12 で書く package resolver は、この境界線を引く仕組みです。新しい実行能力は導入せず、出力はこれまでの節と同じ 4 種類のリソースのままです。

## 考え方

Pi の package はただの npm 風ディレクトリです。`package.json` に `pi` フィールドを 1 つ足して、4 種類のリソースを宣言します。resolver は settings の package リストを受け取り、各 source をローカルディレクトリに解決し、3 層の権限で最終的なファイル集合を計算します：

| 誰 | どこで表明するか | 権限の範囲 |
| --- | --- | --- |
| package 作者 | `package.json` の `pi` フィールド | 書いた時点で正式な境界。載っていないファイルは export されない |
| ディレクトリ規約 | `extensions/` `skills/` `prompts/` `themes/` | manifest がないときだけのフォールバック |
| installer | settings の object form の filter | 作者が与えた集合を狭める方向にしか使えない |

ここに前の節から来る 2 つのルールが重なります。プロジェクトの package はまず s11 の trust ゲートを通ること。同じ package がグローバルとプロジェクトの両側に設定されているときは、プロジェクト側が有効になること。

この節では install はやりません。npm install、git clone、version の pin には触れず、ファイルはすべてメモリ上の fixture で表現します。resolver が答えるのは「どのファイルが有効か」だけです。

## まず動かす

```sh
npm run session:s12
```

出力はこんな形です：

```text
Extensions: 1
Skills: 1
Prompts: 1
Themes: 1
```

demo にはメモリ上の package `/packages/review` が 1 つだけあります。manifest には 4 種類のリソースが 1 項目ずつ、package には各 1 ファイル。4 つの数字は `resolvePiPackages()` が計算した有効リソース数です。数字そのものは平凡ですが、この節の中身はすべて「どんなときに 1 でなくなるか」にあります。

## コードの中身

6 ステップに分けます。

**ステップ 1**：package は `package.json` の `pi` フィールドから始まります。demo では JSON を数行節約するために `createPackageManifest()` を使います：

```ts
createPackageManifest("review-pack", {
  extensions: ["extensions"],
  skills: ["skills"],
  prompts: ["prompts/review.md"],
  themes: ["themes"],
});
```

本物の Pi でも形は同じです：

```json
{
  "name": "my-package",
  "keywords": ["pi-package"],
  "pi": {
    "extensions": ["./extensions"],
    "skills": ["./skills"],
    "prompts": ["./prompts"],
    "themes": ["./themes"]
  }
}
```

パスはすべて package root からの相対で、エントリはファイル・ディレクトリ・glob のいずれでも書けます。

**ステップ 2**：source を package root に変換します。settings の package エントリはローカルパス、`npm:` のパッケージ名、`git:` のリポジトリのいずれかです。`npm:` は `node_modules` 配下のインストール先ディレクトリに、`git:` は host/path で配置された clone ディレクトリに対応し、ローカルの絶対パスはそのまま使われます。書き方が違っても同じ package は同じ root に落ちます——`git:github.com/team/review` と `https://github.com/team/review` の解決結果は同じです。

文字列そのものをどう分解するかは、install フローの詳細です：

```ts
import { parseGitSource, parseNpmName } from "./source-parsing.ts";
```

`npm:@scope/name@1.2.0` からパッケージ名を剥がす処理や、git URL を host/path に正規化する処理は、同じディレクトリの [source-parsing.ts](source-parsing.ts) に切り出してあります。最初に読むときは飛ばして構いません。もう 1 つ近道があります。source が直接 `.ts` ファイルを指しているとき、そのファイルは単体で 1 つの extension になり、この後の manifest フローは通りません。

**ステップ 3**：filter がなければ manifest が正式な境界です。resolver はまずリソース種別ごとに収集モードを決めます：

```ts
const patterns = filter?.[resourceType];
const mode = filter
  ? patterns === undefined
    ? "filtered-default"
    : "filtered-candidates"
  : "manifest-authoritative";
const allFiles = collectPackageResourceFiles(files, packageRoot, resourceType, mode);
```

settings に文字列だけ（string form）を書いたときは filter がなく、4 種類とも `manifest-authoritative` を通ります：

```ts
if (mode === "manifest-authoritative" && manifest) {
  return collectFilesFromEntries(files, packageRoot, manifestEntries ?? [], resourceType);
}
```

鍵は `?? []` です。`package.json` に `pi` オブジェクトさえあれば、それが 4 種類すべてを同時に支配します。manifest の `prompts` に `prompts/review.md` しか載っていなければ、隣の `prompts/draft.md` は export されません。`skills` という key を書いていなければ、`?? []` がそれを空リストに変え、`skills/` ディレクトリを走査するフォールバックは起きません。明示的に `skills: []` と書いても同じく空の export になります。

`pi` フィールド全体が存在しないときだけ、関数末尾の規約ディレクトリに落ちます：

```ts
const conventionDir = joinPath(packageRoot, resourceType);
return listResourceFiles(files, conventionDir, resourceType);
```

だから小さな package なら、規約ディレクトリを 4 つ置くだけで `pi` を一切書かずに済みます。逆に manifest を書いた瞬間、export したい種別はすべて列挙しなければなりません。「key の省略は規約ディレクトリにフォールバックしない」という点は公式ドキュメントですら曖昧に書かれていますが、この節はソースコードの側に立って説明します。

**ステップ 4**：extension のディレクトリ発見にはエントリ判定がもう 1 層あります。skill・prompt・theme はディレクトリを走査してファイルを集めるだけで済みますが、extension はそうはいきません。1 つの extension が複数のファイルで構成されうるからです。

規約ディレクトリでのルール：トップレベルの `.ts` / `.js` は独立したエントリ。サブディレクトリは `index.ts` / `index.js` を持つか、自分の `package.json` の `pi.extensions` でエントリを宣言する。エントリから import される helper は、独立した extension としては読み込まれません。

manifest の glob もこの層に従います。`extensions/*` はファイルとサブディレクトリの両方にマッチします。ファイルはそのまま採用、ディレクトリはもう一度エントリ発見を通ります。結果として手に入るのは `standalone.ts` と `subagent/index.ts` で、`subagent/helper.ts` は入ってきません。

**ステップ 5**：filter は installer の選択で、狭める方向にしか働きません。object form は settings で特定の package にもう 1 層の絞り込みを足します：

```ts
{
  source: "/packages/review",
  extensions: ["extensions/*.ts", "!extensions/legacy.ts"],
  prompts: [],
  themes: ["+themes/review.json"],
}
```

6 つの書き方は、それぞれ 1 つの役割を持ちます：

- key の省略：その種別は filtered default になります——manifest にその種別の配列があればそれを使い、manifest に書かれていないときだけ規約ディレクトリにフォールバック
- `[]`：明示的にすべてオフ
- 通常の pattern：マッチしたものだけオン
- `!pattern`：マッチしたものを除外
- `+path`：正確なパスを 1 つ強制的にオン
- `-path`：正確なパスを 1 つ強制的にオフ

まず 2 本の線を引いておきます。

1 本目：object form の「key の省略」は string form の「filter なし」と同じではありません。同じ package で manifest に `skills` がない場合、string form では skills の export は空になります。object form では——filter に key を 1 つも書いていなくても——skills は規約ディレクトリにフォールバックします。object form で書いた瞬間に、解決経路が切り替わるのです。

2 本目：filter では作者が与えていないものを切り出せません。明示的な pattern の候補集合は、空でない manifest の配列から来ます。manifest にその種別がない、または空配列のときだけ、候補は規約ディレクトリから来ます。つまり filter は空でない manifest をどこまでも狭められますが、作者が載せていないファイルは押し込めません——`+path` でも無理です。候補の中にそもそも存在しないからです。

マッチングは minimatch のセマンティクスで、リソースごとに 3 つの候補表記を確認します：package-relative path、basename、absolute path。`SKILL.md` はさらに親ディレクトリについて同じ 3 表記を確認します。だから `*.ts` はファイル名で extension を選べて、`review` はディレクトリ名で skill を選べます。

思い込みやすい点が 2 つあります。`extensions/**/*.ts` の `**` はゼロ階層以上のディレクトリにマッチするので、トップレベルの `top.ts` にも当たります。逆に、glob を含まない `extensions` はただの正確な pattern であって、「ディレクトリの中身すべて」を意味しません——中身を選びたいなら glob を明示してください。`+` / `-` は常に正確なパスで比較され、skill はディレクトリパスを自分の identity として使えます。

書き方の選び方を一言に圧縮すると：迷ったら通常の pattern。除外や正確なパスの名指しが必要なときだけ特殊構文を使う。

| 場面 | 使うもの | 例 |
| --- | --- | --- |
| skill を全部配る | 通常の pattern | `skills/**` |
| 一部だけ残してテストを除外 | `!pattern` | `skills/**`, `!**/*.test.*` |
| pattern に当たらない正確なパスを強制的に含める | `+path` | `skills/**`, `+skills/internal/legacy.md` |
| この種別は一切いらない | `[]` | `prompts: []` |
| この種別はデフォルトのまま | key の省略 | `themes` を書かない |

もう 1 つは習慣の話です。「この種別は絞らない」と言いたいなら key を省略してください。`[]` をプレースホルダに使ってはいけません——空配列は明示的な全オフで、本当に空の骨組みを配りたいとき以外に出番はありません。

filter でオフにされたリソースは消えてなくなるのではなく、`enabled: false` を付けて結果に残ります。本物の Pi の `ResolvedResource` にも同じフィールドがあります。テストや上位の UI から見えるのは「この prompt は明示的にオフにされた」であって、「存在しない」ではありません。

**ステップ 6**：trust ゲートが最前段にあり、scope が勝敗を決めます。プロジェクトの package は resolver に入る前に s11 のゲートを通ります：

```ts
const packageEntries = dedupePackageEntries([
  ...(options.projectTrusted ? options.projectPackages.map((pkg) => ({ pkg, scope: "project" as const })) : []),
  ...options.userPackages.map((pkg) => ({ pkg, scope: "user" as const })),
]);
```

`projectTrusted` が false のとき、プロジェクトの package はそもそも解決に入らず、ユーザーのグローバル package は通常どおり読み込まれます。s11 と同じ一文です：trust が管理するのはプロジェクト入力の読み込みであって、実行 sandbox ではありません。

同じ package が両側に設定されているとき、dedupe は source identity で重複を除きます——npm はパッケージ名、git は host/path で判定し、ローカルパスは scope ごとに 1 つずつ残ります：

```ts
if (!existing || (entry.scope === "project" && existing.scope === "user")) {
  seen.set(identity, entry);
}
```

プロジェクトのエントリが先に並ぶので、identity が同じならグローバルのエントリは入ってきません。プロジェクトは自分の workflow を固定でき、ユーザーのグローバルにある同名 package に奪われることはありません。

## 手を動かす

`code.ts` の末尾にある `demo()` を開いてください。fixture はそこにあります。1 つ変えるたびに `npm run session:s12` を再実行して、4 つの数字を見ます。

1. fixture に隣のファイルを 1 つ足します：

```ts
"/packages/review/prompts/draft.md": "Draft release notes.",
```

Prompts は 1 のままです。manifest には `prompts/review.md` しか載っておらず、隣にあるだけのファイルがついでに export されることはありません。

2. draft.md を残したまま、`createPackageManifest(...)` の部分を `JSON.stringify({ name: "review-pack" })` に差し替えます。Prompts が 2 になります——`pi` フィールドがないときだけ、4 種類は規約ディレクトリに戻ります。manifest を元に戻し、今度は `prompts: ["prompts/review.md"]` の 1 行だけ削ってみてください。Prompts は 0 になります。2 ではありません。key の省略と manifest なしは別の経路です。

3. manifest を元に戻し、draft.md は残したまま、`userPackages: ["/packages/review"]` を object form に替えます：

```ts
userPackages: [{ source: "/packages/review", prompts: [] }],
```

Prompts が 0 になり、他の 3 つの数字は動きません——`[]` は明示的な全オフです。次に `prompts: ["prompts/draft.md"]` を試して、ステップ 1 の draft.md を拾い上げようとしてみてください。Prompts は 0 のままです。候補集合は manifest が列挙したファイルから来ていて、draft.md はそこに入っていないからです。`["+prompts/draft.md"]` に替えると Prompts は 1 に戻りますが、有効になるのは review.md のほうです——通常の pattern がないと候補は全部残り、`+` で強制的に開けようとしたファイルは相変わらず候補の外にいます。これが「filter は狭めることしかできない」を手で触った感触です。

終わったら `demo()` を元に戻し、`npm run test:s12` を実行して resolver の振る舞いの契約が保たれていることを確認してください。

## 本線につなぐ

resolver の出力に新しい実行系はありません。extension は s09 の読み込みへ、skill・prompt・theme は s08 へ戻り、実行の外殻は相変わらず s10 のあの顔ぶれです。s12 が溶接したのは「配布」という 1 リンクです：

| 項目 | s11 | s12 |
| --- | --- | --- |
| リソースの出どころ | プロジェクトの `.pi/` とユーザーグローバルディレクトリに散らばったファイル | package root の中で manifest か規約ディレクトリが囲ったファイル集合 |
| trust ゲートが守る入力 | プロジェクトの settings・extensions・prompts | 1 種類増える：プロジェクトの package はゲートを通らないと resolver に入れない |
| installer が設定できるもの | trust の判断（approve / store / default） | settings の packages リスト + object form の filter |
| 出力 | `projectTrusted` という 1 つの boolean | `enabled` と `scope` を持つ 4 種類のリソースリスト |

## Pi ソースと照合

この節を読み終えたら [pi-source.md](pi-source.md) を見てください。

対応関係を一言で：s12 の `resolvePiPackages()` は、Pi の `package-manager.ts` にある `DefaultPackageManager.resolve()` の最小経路に対応します。まず `docs/packages.md` で package 作者側のユーザーモデルを掴み、それから `collectPackageResources()` と `applyPackageFilter()` が manifest・規約ディレクトリ・filter をどう合成するかを読むのがおすすめです。本物の Pi にはこの線の外側に install の工学一式——npm install、git clone、pinned version、offline mode——がありますが、install フローが見えたら一旦止まって構いません。resolver の本線には影響しません。

## 次の節

s12 で完成したのは package resolver です。メモリ上のファイルと設定から、どの extension・skill・prompt・theme が有効かを計算できます。ただしその結果は、まだ agent の 1 リクエストにはつながっていません。s13 は新しい仕組みを書かず、adapter とオーケストレーションだけを行います——これまでの節の公開インターフェースを再利用して、trust・package・resource・extension・tool loop・session・runtime mode を 1 本の決定的なオフライン連鎖につなぎます。

期待値も正しく置いておきましょう。s13 の package と extension は引き続きメモリ上の fixture で、package の install も TypeScript の動的 import もしませんし、context compaction・hot reload・sandbox も含みません。

本物の Pi の工学的な詳細に進みたければ、この辺りが掘り下げの入口になります（行番号は [pi-source.md](pi-source.md) に載せてあります）：

```text
offline mode と pinned npm version     docs/packages.md:50-112 の source 分類、package-manager.ts の install フロー
git ref 依存のインストール              package-manager.ts の git clone / git fetch、pinned ref がどうディスクに落ちるか
name collision の診断                  リソースの precedence 順序と collision 診断
```

[s13 Integrated Harness](../s13_integrated_harness/README.ja.md)：これまでの 12 節で立てた部品を、実際に動く 1 本のリクエスト連鎖につなぎます。
