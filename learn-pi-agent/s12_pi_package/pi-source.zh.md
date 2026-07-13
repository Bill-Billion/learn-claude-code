# s12 的 Pi 源码对照

s12 对应 Pi 的 package resolver。

本节对照的是仓库内固定的 `@earendil-works/pi-coding-agent` 0.79.1，git commit `2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210`。

```text
package source
  -> installed package root
  -> pi manifest or conventional directories
  -> extensions / skills / prompts / themes
  -> ResourceLoader
```

## 对应文件

- [`packages/coding-agent/README.md`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/coding-agent/README.md)
- [`packages/coding-agent/docs/packages.md`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/coding-agent/docs/packages.md)
- [`packages/coding-agent/src/core/package-manager.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/coding-agent/src/core/package-manager.ts)
- [`packages/coding-agent/src/core/settings-manager.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/coding-agent/src/core/settings-manager.ts)
- [`packages/coding-agent/src/core/resource-loader.ts`](https://github.com/earendil-works/pi/blob/2f5066d7a0c7bd7d2a6a219561d41a1e11b3b210/packages/coding-agent/src/core/resource-loader.ts)

具体锚点：

```text
README.md:402-449                 Pi Packages 总览、安装命令和 manifest 示例
README.md:491-501                 为什么很多 workflow 交给 extension / skill / package
docs/packages.md:18-48            install / remove / update / temporary -e
docs/packages.md:50-112           npm、git、local path 三类 source
docs/packages.md:114-131          package.json 的 pi manifest
docs/packages.md:154-163          conventional directories
docs/packages.md:165-186          dependencies / peerDependencies / bundledDependencies
docs/packages.md:188-210          package filtering
package-manager.ts:147-153        PiManifest
package-manager.ts:179-188        PackageFilter 和 RESOURCE_TYPES
package-manager.ts:534-630        extension 顶层文件、子目录 index / manifest 入口发现
package-manager.ts:632-761        filter 的 minimatch 候选、skill directory identity、+/- 顺序
package-manager.ts:885-921        resolve() 收集 project/user packages、local entries 和 auto resources
package-manager.ts:1209-1266      resolvePackageSources()
package-manager.ts:1270-1295      local path source：文件当单 extension，目录按 package 规则解析
package-manager.ts:1645-1667      dedupePackages()，项目 package 覆盖全局 package
package-manager.ts:1678-1682      项目 package storage 需要 projectTrusted
package-manager.ts:2030-2073      collectPackageResources()
package-manager.ts:2076-2096      collectDefaultResources()
package-manager.ts:2098-2122      applyPackageFilter()
package-manager.ts:2129-2148      manifest 和 conventional directories 的文件集合
package-manager.ts:2151-2164      readPiManifest()
package-manager.ts:2186-2200      manifest glob 同时展开文件和目录
package-manager.ts:2392-2408      glob 命中目录后按资源类型继续发现入口
test/package-manager.test.ts:1950-2051 multi-file extension 不把 helper 当独立入口的回归测试
                                  （在 packages/coding-agent/test/ 下，不在 src/core/）
package-manager.ts:2226-2390      addAutoDiscoveredResources()，project resources 受 trust 控制
package-manager.ts:2450-2470      toResolvedPaths()
settings-manager.ts:911-921       packages / setPackages / setProjectPackages
resource-loader.ts:333-343        reload 时先 resolveProjectTrust，再 packageManager.resolve()
```

## 对应关系

| s12 | Pi |
| --- | --- |
| `createPackageManifest()` | `package.json` 的 `pi` manifest |
| `PackageEntry` | `PackageSource` 的 string / object filter |
| `resolvePiPackages()` | `DefaultPackageManager.resolve()` 的最小版 |
| `collectPackageResourceFiles()` | `collectPackageResources()` / `collectDefaultResources()` / `collectManifestFiles()` |
| `collectAutoExtensionEntries()` | `collectAutoExtensionEntries()` / `resolveExtensionEntries()` |
| `matchesPattern()` / `matchesExactPath()` | `matchesAnyPattern()` / `matchesAnyExactPattern()` |
| `applyPatterns()` | `applyPatterns()`，依次 include / exclude / force-include / force-exclude |
| `projectTrusted` | `SettingsManager.isProjectTrusted()` |
| `metadata.scope` | `PathMetadata.scope` |
| `enabled` | `ResolvedResource.enabled` |

## 本节采用的简化

真实 Pi 的 package manager 做了很多工程活：

```text
npm install / git clone / git fetch
pinned npm version 和 git ref
offline mode
dependency install
settings.json 持久化
progress event
ignore 文件和 symlink 处理
路径 canonicalize 和 cloud sync ignore
package update check
资源 precedence 排序和 name collision 诊断
```

s12 没有实现这些。它只保留 resolver 主线：

```text
package root
  -> string form: manifest authoritative, otherwise convention
  -> object form: filtered default or filtered candidates
  -> extension entry discovery
  -> resource list
```

这里特意保留了 0.79.1 的几个细节：string form 遇到现有 `pi` manifest 时，省略的资源 key 不回退；object-form filter 才按 `collectDefaultResources()` / `collectManifestFiles()` 的规则选择 manifest 或约定目录。extension 目录也只发现顶层 `.ts` / `.js` 和显式子入口，不递归加载 helper；manifest glob 命中目录时会继续做入口发现。

filter 匹配使用 Node 内置的 `node:path.posix.matchesGlob()`（v22.5 起提供）表达与上游 minimatch 相同的 globstar 等路径语义，并像 Pi 一样分别检查 relative path、basename、absolute path 和 skill 父目录候选。这样不需要给教学项目增加运行时依赖。

还有一处 local path 的 identity 差异：mini 对本地路径按 `local:${scope}:${source}` 保留（同一路径可在两个 scope 各留一份），真实 Pi 的 identity 是 resolved absolute path（`docs/packages.md:227`、`package-manager.ts:1634-1638`），同一绝对路径跨 scope 会去重且 project 赢。两者的可观察结果恰好等价（先到先得 + project 排前），但机制不同。

这是初学者最需要先抓住的部分。真实安装和更新流程可以之后再看，不适合放进第一轮课程。

## 和前几节的关系

```text
s08 Context Resources    package 最终产物还是 skills、prompts、themes
s09 Extension Runtime    package 可以带 extensions
s11 Trust Env            project package 只有 trust 后才进入资源解析
s12 Pi Package           把外层能力打包成可安装的分发单元
```

Pi package 的价值在于不用 fork Pi 就能分发 workflow。这个点也是整门课的收束：Pi core 保持小，外层能力通过资源、extension 和 package 往外长。

## 建议读法

先读 `docs/packages.md` 的 Creating a Pi Package 和 Package Structure。那里能看到 package 作者需要写什么。

再看 `package-manager.ts` 的 `collectPackageResources()` 和 `applyPackageFilter()`。这两段说明 manifest、约定目录和 settings filter 如何合并。

最后看 `resolve()` 和 `dedupePackages()`。这里能看到 project/user scope 的顺序，以及为什么项目 package 可以覆盖全局 package。
