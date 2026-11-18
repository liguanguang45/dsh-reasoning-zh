# dsh-reasoning-zh

[![CI](https://github.com/liguanguang45/dsh-reasoning-zh/actions/workflows/ci.yml/badge.svg)](https://github.com/liguanguang45/dsh-reasoning-zh/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Release](https://img.shields.io/github/v/release/liguanguang45/dsh-reasoning-zh)](https://github.com/liguanguang45/dsh-reasoning-zh/releases)

让 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）的**思考过程（Think 里的 reasoning）用简体中文**的插件。

> 仓库地址：<https://github.com/liguanguang45/dsh-reasoning-zh>。
> 非官方社区插件，与 DeepSeek / DeepSeek Harness 维护方无隶属或背书关系。

## 为什么是三层

模型侧没有"指定思考语言"的参数；系统提示词对 reasoning 语言经常不生效；上下文压缩还会把早期指令挤掉。
所以本插件把手段拆成三层，可以独立开关：

| 层 | 开关 | 做法 | 成本 |
|---|---|---|---|
| ① 引导层 | `steering: system-section` | 在系统提示词里插一段语言指令（order 10，紧跟 harness 身份与 persona 之后） | 零，只占 prompt token |
| ② 重申层 | `steering: first-step-reminder` | 每个 turn 的 step 1 追加一条 `plugin/notice` 用户消息重申语言 | 零 |
| ③ 兜底层 | `translate: true` | 挂 `llm/stream`，把英文 reasoning 整块翻成中文后重写 `block-end` | 每个思考块一次辅助模型调用 |

`steering: both`（默认）= ①+②。建议**先只开 ①②**（多数情况已经够用、零成本），不够再开 ③。

## 配置

| 字段 | 默认值 | 含义 |
|---|---|---|
| `steering` | `both` | `off` / `system-section` / `first-step-reminder` / `both` |
| `remindOn` | `first` | `first`（只在 step 1 重申）/ `every`（每步）/ `off` |
| `steerAnswer` | `true` | **只**控制最终回答的语言；关掉即"只改思考、不改回答" |
| `translate` | `false` | 兜底翻译层总开关。默认关闭；只开 ①② 时零额外模型调用。开启后每个漂回英文的块调用一次翻译模型，且完整 reasoning 会发给 `translateProvider`（见“隐私与数据外发”） |
| `translateProvider` | `deepseek-official` | 翻译调用的 provider 路由 |
| `translateModel` | `deepseek-chat` | 翻译模型，建议便宜的非思考路由 |
| `translateThinkingOff` | `false` | 翻译调用是否请求 `reasoningEffort: 'off'`（模型不支持会整块失败→保留原文） |
| `translatePrompt` | 见源码 | 翻译指令模板（默认已含术语保留规则）|
| `keepTerms` | `[]` | **必须原样保留、永不翻译**的词表（产品名/项目名/内部代号），会追加到翻译指令末尾 |
| `cjkThreshold` | `0.3` | 汉字占比达到该值即视为「已是中文」→ **整块跳过翻译**；`0` = 从不跳过（每块都翻）。混合块还会按自然语言里的英文词数兜底，避免中文夹英文时整体跳过 |
| `maxCharsPerBlock` | `20000` | 超长思考块放弃翻译、原文实时透传（只在「还没开始翻译」时生效，避免中英混排） |
| `timeoutMs` | `30000` | 单次翻译超时 |
| `verbose` | `false` | 打印跳过 / `N -> M 字符（N 片）`，以及熔断、子会话跳过等事件 |
| `verboseFile` | `''` | 诊断**同时落盘**的路径（每行带 ISO 时间戳）；GUI 下宿主 stderr 不可见，这是事后查日志的入口；空 = 不落盘 |
| `verboseFileMaxBytes` | `1000000` | 落盘文件超过该字节数就轮转为 `<verboseFile>.1` |
| `statsFile` | `''` | 累计统计落盘路径（json）；配了之后 `/reasoning-zh` 会显示**跨重启**的累计用量；空 = 只在内存里统计 |
| `translateScope` | `main` | `main` = 只翻主会话，子代理/工作流的思考直通（省成本）；`all` = 都翻 |
| `chunkThreshold` | `1000` | 整块累计超过这么多字符才分片并发翻译；`0` = 永不分片（长块也一次翻完） |
| `minChunkChars` / `maxChunkChars` | `200` / `800` | 片长区间；切点优先落在段落、换行、句末边界，保证切片无损 |
| `streamTranslated` | `true` | 某片译完就立即作为 delta 下发（译文流式）；`false` = 到块尾一次性下发 |
| `maxConcurrency` | `4` | 同时进行的翻译调用上限；`0` = 不限。长块分片时避免一次并发十几片触发限流 |
| `retry` | `0` | 单片失败后的额外重试次数（只对真实失败重试；用户取消不重试） |
| `breakerFailures` | `3` | 连续失败达到该次数即熔断（`0` = 不熔断） |
| `breakerCooldownMs` | `300000` | 熔断冷却时长；冷却期内整条流直通，不再逐块白等 `timeoutMs` |

无效配置在挂载时抛错，不会静默回退。

### cjkThreshold 为什么重要

引导层经常已经让模型**原生**用中文思考；此时再翻一遍纯属浪费一次模型调用——本机实测出现过
`218 -> 218 字符`（中文翻中文）。判定分两处早退：

- 块内攒到 120 字符就先判一次：已是中文 → **立刻放行、不翻译，也不再等整块**（所以中文思考基本是流式的）；
- 更短的块在 `block-end` 判定，已是中文则原样补发。

判定是启发式的：汉字占比 + **假名否决**（出现平假名/片假名一律当日文，照翻）+ **混合块英文词兜底**
（汉字占比在 0.3–0.6 之间、且去掉代码/URL 后仍有 ≥8 个英文词时，不当作「已是中文」）。
纯简繁共享汉字的句子无法可靠区分，策略上宁可漏判（多翻一遍）也不错判（把日文当中文跳过）。

译文返回后还会做一次 no-op 检查：忽略空白后与原文完全相同就记为「无变化」，不计入有效翻译。
本机日志里 341 条翻译中曾有 214 条长度与原文完全相同，这类调用现在会在 `/reasoning-zh` 的
「无变化 / 有效翻译率」里直接暴露，方便判断翻译层是否真的在干活。

### 术语/专有名词会被翻译掉吗

默认翻译指令（`translatePrompt`）里已经写死了规则：

> 代码、标识符、函数/变量名、命令、文件路径、URL、包名、配置键、接口/协议名、日志与报错，一律原样保留；
> 反引号内、代码块内、路径里的内容原样保留；产品名、项目名、框架名、人名保留原文；只翻译自然语言叙述。

所以 `cordis_mount`、`llm/stream`、`DSH_HOME`、`include:reasoning-zh`、`DeepSeek Harness`、`Cordis`
这类词通常不会被翻。**但"模型自觉"不等于"有保证"**——换翻译模型或遇到歧义词时仍可能被意译，
所以要更稳就自己列词表：

```yaml
config:
  keepTerms: ['DeepSeek Harness', 'Cordis', 'Typert', 'prompt-polish']
```

实测（`translateModel: deepseek-chat`，同一个术语密集任务）：

| | 结果 |
|---|---|
| 只给一句话的旧指令 | 靠模型自觉，实测恰好也保住了，但**没有任何约束**（换模型/换词就可能变）|
| 现在（含保留规则） | `373 -> 344 字符`，`DeepSeek Harness`、`Cordis`、`Typert`、`subagent`、`prompt-polish`、`cordis_mount`、`llm/stream` **全部原样保留** |

### 分片、流式、熔断、scope：为什么长思考不再卡（2026-10-06 加入）

| 机制 | 解决的问题 | 真实宿主实测 |
|---|---|---|
| **分片并发** | 整块英文思考要等一次完整往返，块越长越明显 | `reasoning 块 0：1424 -> 466 字符（12 片）`，总等待≈最慢的一片 |
| **译文流式** (`streamTranslated`) | 译文只在块尾一次性出现，Think 区长时间空白 | 某片译完立即作为 delta 下发；`false` 可退回旧行为 |
| **熔断** (`breakerFailures`) | 路由/模型故障时每个块各白等一次 `timeoutMs` | `翻译连续失败 2 次，熔断 600000ms（第 1 次）`，随后 fail-open 原文不丢 |
| **`translateScope: main`** | 子代理/工作流里的思考也被翻译，成本随代理数翻倍 | `子会话 b8d7deaf-… 跳过翻译（translateScope=main）` |

**取舍**：分片会增加**调用次数**（片数 ≈ 长度 / `maxChunkChars`），换来的是首字延迟大幅下降（片并发执行）；
跨片上下文只在片内，术语一致性靠翻译指令保证。整块短于 `chunkThreshold` 时仍是**一次调用**（与旧行为一致）。

**协议保证**（改这块代码前务必保持）：同一 index 的所有 delta 必须在它的 `block-end` 之前发出，
且 `block-end.block.text` 必须等于该块已发出 delta 的拼接——否则实时与回放会不一致。
`finish`、下游抛错、协议异常三条路径都会把缓冲与半成品补发掉，任何情况下都不丢内容。

### 诊断怎么查（GUI 场景）

宿主的 stderr 在 Electron 里既看不到也不落盘，所以给 `verbose` 配一个落盘路径：

```yaml
config:
  verbose: true
  verboseFile: 'C:/Users/<you>/.dsh/dsh-reasoning-zh.verbose.log'
```

之后每次翻译／跳过／熔断都会带 ISO 时间戳追加进去（目录不存在会自动创建；超过 `verboseFileMaxBytes`
自动轮转为 `.1`）。真实样例：

```
2026-10-06T00:19:36.184Z [reasoning-zh] reasoning 块 0：1424 -> 466 字符（12 片）
2026-10-06T00:20:11.002Z [reasoning-zh] 翻译连续失败 2 次，熔断 600000ms（第 1 次）
2026-10-06T00:21:02.517Z [reasoning-zh] 子会话 b8d7deaf-… 跳过翻译（translateScope=main）
```

看这几类行就能回答日常疑问：**跳过翻译**（省钱生效）、**N 片**（分片在工作）、**熔断**（路由出问题了）、
**子会话跳过**（子代理没白花钱）。

### 运行时状态：`/reasoning-zh` 命令

不想开终端看日志，就在对话里输入（宿主侧执行，**不经过模型、不花 token**）：

| 命令 | 作用 |
|---|---|
| `/reasoning-zh` | 三层是否已挂载 + 本进程统计（处理几块、翻译几块、跳过几块、几片、失败/取消/无变化/重试、有效翻译率、熔断状态、估算省下的模型调用次数）|
| `/reasoning-zh reset` | 清零统计（不影响运行）|
| `/reasoning-zh log [N]` | 直接看最近 N 行诊断日志（默认 30，上限 500）——省得开终端再记 `-Encoding UTF8` |

统计是**每进程内存态**：重启 app 归零；默认不写任何文件，配置 `statsFile` 后才会把累计统计落盘。

### 累计统计（跨重启）

给插件行加上 `statsFile`，`/reasoning-zh` 就会多一栏**跨重启**的累计：

```yaml
config:
  statsFile: 'C:/Users/<you>/.dsh/dsh-reasoning-zh.stats.json'
```

```
| 累计统计（跨重启） | 值 |
|---|---|
| 处理思考块 | 386（翻译 121 / 跳过 265）|
| 翻译片数 | 240（失败 2 / 取消 1 / 无变化 9 / 重试 1）|
| 有效翻译 | 228 / 240 片 |
| 字符量 | 原文 152340 → 译文 48120 |
| 子会话跳过 | 12 次 |
| 熔断 | 1 次 |
| 估算省下的模型调用 | ≈ 277 次 |
| 插件加载次数 | 8 次 |
统计自 2026-10-06 10:30 · 文件 `…/dsh-reasoning-zh.stats.json`
```

- `/reasoning-zh reset` 清**本进程**；`/reasoning-zh reset all` 清**累计**（加载次数一并归零）。
- 写盘**去抖 2 秒 + 原子写**（写临时文件再 rename），卸载时补写一次；
- 合并策略是「先读盘、再累加本进程自上次落盘以来的增量」，并用同目录的 `<statsFile>.lock` 串行化读-改-写；拿不到锁时跳过本次落盘、保留增量等下次，因此多个进程（例如并行跑 headless）同时写**不会互相覆盖**；
- 文件损坏/不可写一律静默降级为「只统计本进程」，绝不影响插件。

### 命令为什么有两级注册路径

命令只是附加能力（核心是三个语言层），所以**不能**把 `commands` 写进插件的静态 `inject`：
一旦写进去，某个没有该服务的组合会让整个插件停在 pending——那正是「插件没加载」这类最难排查的故障。

但也**不能只试一次**。实测（启动摘要就写在 `verboseFile` 里）：

```
[reasoning-zh] 已加载 v0.2.3 · 入口=include:reasoning-zh · ①引导=ok ②重申=ok ③翻译=ok 命令=等待服务就绪
[reasoning-zh] commands 服务此刻尚未就绪（bundle include 层的 apply 比 dsh-commands 早），已挂延迟注册
[reasoning-zh] 命令延迟注册成功（路径 inject）：/reasoning-zh 可用
```

桌面壳里插件经 **bundle include 层**加载，`apply` 比 `dsh-commands` **早约 4 秒**，那一刻
`ctx.get('commands')` 还是 `undefined`；而同一份代码在 headless 里走**顶层 patch 层**、apply 较晚，
服务已就绪（`register=ok`）。所以现在是两条**幂等**路径：

1. **立即试一次** —— 服务已就绪的场合；
2. `ctx.inject(['commands'], …)` —— cordis 的动态注入，等服务出现再注册（实测 26ms 后补上）。

只有在没有 `ctx.inject` 的旧 cordis 上，才额外挂 `agent/created` 兜底；现代桌面壳不再增加这个无谓监听。

取服务统一用**外层 `ctx`**，保证注册作用域与立即注册一致。

## 三个必须知道的语义边界

1. **翻译层只改 reasoning，永远不碰最终回答。** 回答语言由 `steerAnswer` 决定（它只影响提示词里的那句话）。
2. **译文会进入持久状态。** `llm/stream` 位于 agent-loop 落日志之前，所以译文会写进 session 日志、Web 回放和后续模型上下文，原文不再保留。翻译失败时三处一致地保留原文（fail-open）。
3. **翻译会把完整 reasoning 发给 `translateModel`**，其中可能含源码、文件路径、工具返回内容或意外凭证。确认过 provider 的数据保留政策再开。

## 隐私与数据外发

- **默认 `translate: false`**：只启用系统提示词引导和每轮重申，不发起额外模型调用，也不把 reasoning 发送给任何翻译服务。
- **显式开启 `translate: true` 后**，每个漂回英文的 reasoning 块会发给 `translateModel`（默认 `deepseek-chat`，provider `deepseek-official`）。完整 reasoning 可能包含源码、文件路径、工具返回内容或意外凭证；确认 provider 的数据保留政策后再开。
- 译文会写进 session 日志和后续模型上下文，原文不再保留；翻译失败时保留原文（fail-open）。
- `verboseFile` / `statsFile` 默认空。开启后请写到私有路径，不要把日志或统计文件提交到仓库。
- `keepTerms` 可以保护必须原样保留的词，但它不会阻止整块内容发给翻译模型。

## 兼容性

- 已在 DSH `0.2.2-rc.3`、Node `22.19+` 上验证；CI 覆盖 Node 22/24。
- `desktop`（Electron）、`web`、`headless` profile 都可用；桌面壳优先用 `install.mjs`（平铺安装），不要依赖 pnpm 软链。
- 运行期零依赖；`@deepseek-ai/dsh-llm` 和 `schemastery` 是可选导入，解析不到时用内置等价实现。

## 安装

### 方式 G：从 GitHub 安装（发布后推荐）

```powershell
git clone https://github.com/liguanguang45/dsh-reasoning-zh.git
cd dsh-reasoning-zh
node install.mjs
```

也可以从 [Releases](https://github.com/liguanguang45/dsh-reasoning-zh/releases) 下载 `dsh-reasoning-zh-0.4.0.zip`，解压后运行 `node install.mjs`。
装到非 `desktop` profile：`node install.mjs --profile web`；查看帮助：`node install.mjs --help`。
安装完成后**完全退出并重新打开 DSH**（桌面壳不会热加载新依赖）。

### 方式 0：脚本同步（改完代码后日常用这个）

```powershell
node scripts/install-into-profile.mjs                  # 同步到 desktop：自检 → 清旧副本 → 平铺复制 → SHA256 校验
node scripts/install-into-profile.mjs --verify         # 只读：profile 里跑的是哪版、与源码是否逐文件一致
node scripts/install-into-profile.mjs --print-config   # 只读：依赖/bundles/patch 行登记情况
node scripts/install-into-profile.mjs --profile web    # 同步到别的 profile
node scripts/install-into-profile.mjs --home D:/x      # 覆盖 DSH_HOME（测试用）
```

它固化了几个必须遵守的事实，手工做很容易漏：

- **`file:` 依赖是快照**：源码改了 pnpm 不会重新复制（删掉目录也不恢复）→ 必须先删旧副本再平铺复制；
- **必须是平铺真实目录**：`node_modules/dsh-reasoning-zh` 若是符号链接，桌面壳不会认它为 profile 层；
- **删除前做路径断言**（目标必须等于 `<profile>/node_modules/dsh-reasoning-zh`），避免参数写错误删；
- 动 profile 之前先做**源码导入自检**，坏代码不会被复制进去。

退出码：`0` 成功/一致，`2` 不一致，`1` 前置条件失败（profile 不存在、源码自检不过）。

### 方式 A：写进 profile 的 patch 层（推荐，实测可行）

`desktop` profile 由 Electron 独占，`dsh plugin --profile desktop …` 会被拒绝
（`error: profile "desktop" is managed exclusively by the Electron application`），
而且 `pnpm` 不一定在 PATH 上。所以最省事的是像其它第三方插件一样，直接把行追加到 profile 的 patch 层：

```powershell
$profile = "$env:USERPROFILE\.dsh\profiles\desktop\cordis.patch.yml"
Copy-Item $profile "$profile.bak-reasoning-zh"      # 备份，回滚用

$patch = @'

# dsh-reasoning-zh: force Simplified-Chinese reasoning
- insert:
    - id: reasoning-zh
      name: 'file:///C:/path/to/dsh-reasoning-zh/lib/index.js'
      config:
        steering: both
        remindOn: first
        steerAnswer: true
        # 默认只开 ①②：零额外模型调用。
        # 要翻译层就改成 true；注意完整 reasoning 会发给 translateModel。
        translate: false
        cjkThreshold: 0.3
        verbose: true
'@
Add-Content -Path $profile -Value $patch -Encoding utf8
```

> `file:///` 后面换成你的实际绝对路径；Windows 用 `C:/...` 形式，路径里不要有反斜杠。
> 上面的示例默认零成本；要确定性中文就把 `translate` 改成 `true`，但先读“隐私与数据外发”。

`patchReload: live` 通常会热加载，不必重启；没生效再重启 GUI。
**回滚**：`Move-Item "$profile.bak-reasoning-zh" $profile -Force`

> 注释务必写成 ASCII：`Add-Content -Encoding utf8` 与既有文件编码混用可能出问题，纯 ASCII 最稳。

### 方式 B：作为包安装（需要 pnpm）

```powershell
# 若 pnpm 不在 PATH，用 DSH 自带的：
#   ~/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/pnpm/bin/pnpm.cjs
cd $env:USERPROFILE\.dsh\profiles\<profile>
pnpm add link:C:/path/to/dsh-reasoning-zh   # 换成你的仓库绝对路径
```

再把包名加进同一份 `package.json` 的 `dsh.profile.bundles`（包自带的 `cordis.patch.yml` 负责插行）：

```json
"dsh": { "profile": { "bundles": [
  "@deepseek-ai/dsh-base",
  "@deepseek-ai/dsh-web-app",
  "dsh-reasoning-zh"
] } }
```

`web` / `headless` 这类非 Electron profile 也可以用 `dsh plugin --profile <name> add …`（就是将参数转发给 pnpm）。
`file:` 是复制安装，改源码后要重新装；`link:` 是软链，改完立即生效——本插件运行期零依赖，
`link:` 下会走内置的等价兜底实现（见下）。

### 方式 C：不安装，直接以源码挂载（联调最快）

```powershell
dsh --profile headless --patch C:/path/to/dsh-reasoning-zh/mount/dev.cordis.yml "your task"
dsh web --patch C:/path/to/dsh-reasoning-zh/mount/dev.cordis.yml
```

`mount/` 下有三个 overlay，**不要同时用 `dev.cordis.yml` 与 `dev-with-translate.cordis.yml`**
（都挂会注册同名提示词段而冲突）：

| 文件 | 用途 |
|---|---|
| `dev.cordis.yml` | 只开引导层 + 重申层（`translate: false`），基线对照 |
| `dev-with-thinking.cordis.yml` | 附带设置 `reasoningEffort: high`——`dsh-base` 默认不设，模型就不吐 reasoning |
| `dev-with-translate.cordis.yml` | 开启翻译层（替代 `dev.cordis.yml` 使用） |

这些 overlay 里用的是 `file:///C:/path/to/dsh-reasoning-zh/lib/index.js`。**必须用 `file://` URL**：
cordis loader 对不以 `.` 开头的 `name` 直接执行 `import(name)`，裸 Windows 路径会被当成包名而解析失败。

> 踩坑记录：`- id: <已存在的行>` 形式的 config 覆盖**不会**与 bundle 内原行的 config 合并
> （bundle 是 `cordis:include`，跨层不合并）。所以覆盖 `agent-default-model` 时必须把
> `provider`/`model` 一并写全，否则报 `$.provider missing required value`。

> 会话日志版本：Web 表层写 `session.v4.jsonl.zstd`，headless 写 `session.v3.jsonl.zstd`；
> `tools/inspect-session.mjs` 两种都认。

## 分享给别人

```bash
node scripts/pack-share.mjs                      # 生成 dist/dsh-reasoning-zh-<version>/
Compress-Archive -Path "dist\dsh-reasoning-zh-<version>" `
                 -DestinationPath "dist\dsh-reasoning-zh-<version>.zip" -Force
```

压缩包（约 70 KB、十几个文件）里带 `INSTALL.md`（给对方看的说明）与 `install.mjs`（一键安装）。
对方只需要三步：**解压到固定目录 → `node install.mjs` → 完全退出并重启 DSH**。

`install.mjs` 做四件事，全部可重复执行：

1. 把包**平铺复制**到 `<DSH_HOME>/profiles/<profile>/node_modules/dsh-reasoning-zh`
   （桌面壳只认平铺真实目录，符号链接会被判为「未成为 profile 层」）；
2. 在 profile 的 `package.json` 里**追加** `dependencies` 与 `dsh.profile.bundles`（不覆盖已有条目）；
3. 在 `cordis.patch.yml` 里补一段挂载行（已有同 id 的行则原样不动，不覆盖对方调过的配置）；
4. 逐文件 SHA256 校验并打印下一步。

几个实测过的注意点：

- **对方必须先启动过一次 DSH**：profile 未初始化时脚本会拒绝安装并提示——否则写出的 `bundles`
  会缺 `@deepseek-ai/dsh-base` / `dsh-web-app`，DSH 可能起不来（这条是踩过才知道的）；
- `dsh plugin add` 对 desktop profile 无效（会被 Electron 应用拒绝），别指望一条 npm 命令装完；
- 对方的 Node 不在 PATH 时，用 DSH 自带的（`<DSH_HOME>/dsh-runtimes/...`）；
- 卸载 = 删掉 `node_modules/dsh-reasoning-zh` + 从两个配置文件里移除 `dsh-reasoning-zh` 相关内容，
  脚本不会碰对方的其它配置。

## 如何检验

按代价从低到高四级，每级都有明确的"该看到什么"。

### L0 逻辑层：单元测试（零依赖，秒级）

```powershell
node test/run-all.mjs
```

期望 `tests 62 / pass 62 / fail 0`。覆盖提示词段注册、step 1/每步/空步的重申行为、整块翻译改写、
fail-open、超长透传、`purpose` 直通、断流补发、配置校验、消息构造、取消/重试/并发上限、语言判定、
no-op 检测、统计文件锁与 per-agent 释放。

想确认测试本身有效（不是永远绿）：把 `lib/index.js` 里 `config.remindOn === 'first'` 的判断删掉再跑，
应当出现失败。

### L1 挂载层：profile 树 diff（不启动、不连模型）

用独立 `DSH_HOME` 避免污染真实 home（`--dump-config` 会写 `$DSH_HOME/profiles/<name>/cordis.yml`）：

```powershell
$env:DSH_HOME = "$env:TEMP\dsh-verify-home"
dsh --profile web --dump-config > base.txt
dsh --profile web --patch C:/path/to/dsh-reasoning-zh/mount/dev.cordis.yml --dump-config > with.txt
Compare-Object (Get-Content base.txt) (Get-Content with.txt)
```

期望：只多出 overlay 那一行条目（`id: reasoning-zh-dev`、`name: file:///…`、以及 config 键）。
实测 539 行 → 548 行，差异正好是那 9 行。

这一步能抓掉大部分低级错误：YAML 写错、`file://` 漏写、profile 名写错、插件行 id 冲突。

### L2 运行层：session 日志三锚点（最硬的证据）

DSH 会把**渲染后的系统提示词**写进 `system/message`、把注入消息的 `source` 写进 `user/message`、
把每个思考块写进 `assistant/message`。三层各有可直接查的落点：

```powershell
node tools/inspect-session.mjs                 # 取最近写入的会话（认 DSH_HOME）
node tools/inspect-session.mjs <会话目录>
node tools/inspect-session.mjs --marker 思考语言 --plugin reasoning-zh --sample 5
```

> 不带参数时按**文件写入时间**取最新——正在使用的 GUI 会话通常就是最新的；
> 想看某次 `headless` 运行，请显式传那个会话目录。

| 输出行 | 对应层 | 生效时应为 |
|---|---|---|
| `① 其中出现「思考语言」` | 引导层 | > 0 次（只在 `system/message` 里命中，不受聊天内容干扰） |
| `② plugin=reasoning-zh 的消息` | 重申层 | ≈ 每个 turn 1 条 |
| `③ 中文主导 / 英文主导 / 混合` | 语言效果 | 中文主导占比明显上升 |

注意它按 zstd 帧魔数**逐帧**解压：session 日志是"一次追加一帧"的串联 zstd，
Node 的 `zstdDecompressSync` 只读第一帧，直接解只会拿到 187 字节的会话头。

### L3 界面层：GUI 里的两个观察点

- **设置 → 插件**的插件清单（Cordis Loader inventory）里应出现 `reasoning-zh` 这一行；没有就是没挂载，回 L1。
- 展开对话里的 **Think** 块：**英文**块会整块延迟出现（缓冲→翻译→一次性吐），**已是中文**的块会在约 120 字符后转成流式——这是设计行为，不是卡死。

### L4 反证层：A/B 对比

同一句提示词各跑一次，用 L2 的工具对比。**本机实测记录（2026-10-05）**：

| 运行 | 配置 | ① 引导层 | ② 重申层 | ③ 思考块 |
|---|---|---|---|---|
| GUI 会话基线（未装插件） | — | 0 次 ❌ | 0 条 ❌ | 99 块 / 246,268 字符，中文主导仅 **1** 块 |
| headless #1 | `steering: both`, `translate: false` | 1 次 ✅ | 1 条 ✅ | 0 块（`dsh-base` 未设 `reasoningEffort`，模型没思考） |
| headless #2 | 同上 + `reasoningEffort: high` | 1 次 ✅ | 1 条 ✅ | 1 块 / 41 字符 → **英文 100%** |
| headless #3 | `steering: both`, `translate: true` | 1 次 ✅ | 1 条 ✅ | 1 块 / 99 字符 → **中文 100%**，日志 `342 -> 99 字符` |
| headless #4 | 同上，但模型原生中文思考 | 1 次 ✅ | 1 条 ✅ | 1 块 / 99 字符 → 中文，但日志是 `218 -> 218 字符`（**纯浪费**，促成 `cjkThreshold`） |
| headless #5 | 加了 `cjkThreshold` 之后 | 1 次 ✅ | 1 条 ✅ | 日志变为 `采样判定（汉字占比 96%），跳过翻译`，**零额外调用** |

结论很清楚：**① 能保证"指令进了提示词"，但不保证"思考就是中文"**（#2 就是反例，思考仍是
`User wants one sentence answer, no tools.`）；**③ 才是确定性的那一层**，#3 的 `verbose` 日志给出了
`[reasoning-zh] reasoning 块 0：342 -> 99 字符`，随后 `dsh: reasoning:` 段流出的就是中文。

而 #4/#5 说明：③ 开久了会暴露“中文翻中文”的浪费，`cjkThreshold` 就是为此加的闸。
如果确实需要确定性的中文结果，并且接受把 reasoning 发给翻译模型，推荐 `translate: true` + `cjkThreshold: 0.3`：
中文块零成本，英文块才付一次调用；默认配置保持 `translate: false`。

### 常见"看起来没生效"

| 现象 | 先查 |
|---|---|
| ① 0 次 | 插件行进没进 profile 树（L1）；新增依赖后有没有重启 GUI（不会热加载） |
| ② 0 条 | `steering` 是否设成了 `system-section`（那样本来就没有重申层）；`remindOn: off` |
| ③ 仍旧英文 | 引导层本就是概率性的。先确认 ② 生效（说明注入链路通了），再开 `translate: true` |
| 翻译层整块失败 | `translateProvider` / `translateModel` 是否是设置里可用的路由；开 `verbose: true` 看 warn |

## 实现要点（改代码前先读）

- **运行期零依赖**：`lib/index.js` 只用 `node:crypto`。`@deepseek-ai/dsh-llm`（`createUserMessage`）和
  `schemastery`（配置 schema）是**可选**导入：能解析到就用官方实现，解析不到就走本地等价实现
  （`randomUUID` + `structuredClone` + 深冻结，与上游 `createMessage` 同语义）。这样 `link:` 开发也能跑。
- **防递归**：loop 构造的 `GenerateOptions` 是 deep-frozen，不能挂标记字段；`purpose` 也只接受
  `'compaction' | 'session-title'`。所以只能用 `WeakSet` 按**最终 options 对象本身**登记辅助调用
  （先登记再 `stream()`，否则身份不一致）。
- **流协议不变式**：`@deepseek-ai/dsh-llm` 的校验器会检查每个 index 先 `block-start`、`block-end` 必须闭合、
  `usage` 至多一次、必须以 `finish` 收尾。因此被缓冲的 delta 在决定放行时必须"合并成一条 delta 补发"，
  并且在 `finish` 前、下游抛错时、以及流异常结束时都要清空缓冲——任何路径都不能丢思考内容。
- **落点选择**：`llm/stream` 在日志写入之前，所以译文会持久化；只想要"UI 显示中文、日志存原文"，
  得写浏览器半边的 client 插件 + host RPC，本插件不做。

## 贡献

见 [CONTRIBUTING.md](CONTRIBUTING.md)。安全问题请按 [SECURITY.md](SECURITY.md) 私密报告；
行为准则见 [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)。变更记录见 [CHANGELOG.md](CHANGELOG.md)。

## License

MIT
