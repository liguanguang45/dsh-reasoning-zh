/**
 * dsh-reasoning-zh — 让 DeepSeek Harness 的思考过程（Think 里的 reasoning）用简体中文。
 *
 * 三层设计，可独立开关：
 *
 *   ① 引导层  steering: system-section / both
 *      往系统提示词插一段语言指令（order 10）。零成本，模型配合时原生中文思考。
 *
 *   ② 重申层  steering: first-step-reminder / both
 *      每个 turn 的 step 1 追加一条 user 角色的 system-reminder。
 *      上下文压缩后依然生效，是「中文思考漂移回英文」的主要对策。
 *
 *   ③ 兜底层  translate: true
 *      挂 llm/stream waterfall，缓冲 reasoning 块、整块翻成中文后重写 block-end。
 *      因为发生在 agent-loop 落日志之前，译文会进 session 日志、回放和后续上下文。
 *      两条省钱/省延迟的早退（cjkThreshold）：
 *        - 块内攒到 PROBE_CHARS 就先判一次语言，已是中文立刻放行、不翻译、也不再等整块；
 *        - 短块在 block-end 判定，已是中文则原样补发，不发翻译请求。
 *
 * 设计约束（改动前请先读）：
 *   - 最终回答（text 块）永远不被翻译层触碰，只由引导层控制语言。
 *   - 请求对象 GenerateOptions 对 loop 构造的调用是 deep-frozen，不能挂标记字段；
 *     `purpose` 也只接受 'compaction' | 'session-title'。防递归只能用 WeakSet。
 *   - 流协议由 @deepseek-ai/dsh-llm 的不变式校验器全局校验：每个 index 必须先
 *     block-start、block-end 必须闭合、usage 至多一次、必须以 finish 收尾。
 *     所以缓冲的 delta 必须原样补发，绝不能让块内容凭空消失。
 *   - 翻译失败一律 fail-open：保留原文，只是多花一次请求延迟。
 *   - 语言判定只做启发式：汉字占比 + 假名否决。纯简繁共享汉字的句子无法可靠区分，
 *     宁可漏判（翻译一遍）也不要错判（把日文当中文跳过）。
 *
 * 运行期零依赖：本文件只用 node: 内建能力。@deepseek-ai/dsh-llm 与 schemastery
 * 是「能解析到就用官方实现、解析不到就本地等价实现」的可选依赖，因此在
 * `pnpm add link:` 的开发方式下也能直接跑。
 */

import { randomUUID } from 'node:crypto'
import {
  appendFileSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { dirname } from 'node:path'

/**
 * 本模块**不使用 top-level await**：打包版 DSH（Electron）通过 ESM proxy 加载外部插件，
 * TLA 会多一层不确定性；同步 require 在两个表皮下都是安全的，解析不到就退回本地实现。
 */
const requireFromHere = createRequire(import.meta.url)

/** 可选：官方消息构造器（保证与上游语义完全一致）。 */
let createUserMessage
try {
  ;({ createUserMessage } = requireFromHere('@deepseek-ai/dsh-llm'))
} catch {
  // 解析不到（或该包是带 TLA 的 ESM 而 require 不了）时走本地等价实现。
}

/** 可选：schemastery 配置 schema（解析不到时降级为 apply() 内手工校验）。 */
let z
try {
  const loaded = requireFromHere('schemastery')
  z = loaded?.default ?? loaded
} catch {
  // 同上。
}

/** Cordis 插件名。 */
export const name = 'reasoning-zh'

/** 依赖的服务：缺任何一个都不挂载。 */
export const inject = ['systemPrompt', 'llm']

/** 提示词段位置：紧跟 harness 身份（-1000）与部署 persona（0）之后的第一方指导之前。 */
const SECTION_NAME = 'reasoning-zh:language'
const SECTION_ORDER = 10

/**
 * 默认翻译指令。
 *
 * 为什么写得这么细：实测（deepseek-chat）不带约束时**也能**保住
 * `cordis_mount`、`DeepSeek Harness` 这类像代码/专有名词的词，但那是模型的自觉，
 * 换模型或遇到歧义词就可能被意译。这里把「什么必须原样保留」写成明确规则，
 * 把自觉变成约束；用户还可以用 `keepTerms` 追加自己的词表。
 */
const DEFAULT_TRANSLATE_PROMPT = [
  '把下面的推理内容翻译成简体中文。只输出译文，不要解释、不要添加任何前后缀。',
  '规则：',
  '1. 代码、标识符、函数/变量名、命令、文件路径、URL、包名、配置键、接口/协议名、日志与报错，一律原样保留，不要翻译（例如 cordis_mount、llm/stream、DSH_HOME、include:reasoning-zh）。',
  '2. 反引号内、代码块内、路径里的内容原样保留，连标点都不要改。',
  '3. 产品名、项目名、框架名、人名保留原文；必要时可在其后用括号补一个简短中文说明。',
  '4. 只翻译自然语言的叙述部分；不要意译、不要总结、不要省略、不要补全、不要调整段落顺序。',
].join('\n')

/** 全部配置默认值（无 schema 时也按这份表归一化）。 */
const DEFAULTS = {
  steering: 'both',
  remindOn: 'first',
  steerAnswer: true,
  translate: false,
  translateProvider: 'deepseek-official',
  translateModel: 'deepseek-chat',
  translateThinkingOff: false,
  translatePrompt: DEFAULT_TRANSLATE_PROMPT,
  /**
   * 必须原样保留、永不翻译的词（产品名、项目名、内部代号…）。会追加到翻译指令末尾。
   * 例如 `['DeepSeek Harness', 'Cordis', 'prompt-polish']`。
   */
  keepTerms: [],
  /**
   * 汉字占比达到该值就认为「已经是中文」，整块跳过翻译。
   * 0 表示从不跳过（等价于「每一块都翻」）；引导层越有效，这个阈值省下的调用越多。
   */
  cjkThreshold: 0.3,
  maxCharsPerBlock: 20000,
  timeoutMs: 30000,
  verbose: false,
  /**
   * 诊断落盘路径：非空时，`verbose` 的每一行**同时**追加到这里（含时间戳）。
   * GUI 场景下宿主 stderr 不可见，这个开关就是「事后查日志」的入口。空字符串 = 不落盘。
   */
  verboseFile: '',
  /** 落盘文件超过该字节数就轮转一次为 `<verboseFile>.1`。 */
  verboseFileMaxBytes: 1000000,
  /**
   * 累计统计落盘路径：指向一个 json 后，`/reasoning-zh` 会显示**跨重启**的累计用量
   * （处理块数、翻译片数、跳过次数、估算省下的模型调用、加载次数…）。
   * 空字符串 = 只在内存里统计，重启归零。
   */
  statsFile: '',
  /**
   * 翻译范围：`main` 只翻主会话，子代理/工作流的思考一律直通（省成本）；
   * `all` 连子代理一起翻。判定依据是 agent 的 parentAgent / session header 的 delegationDepth。
   */
  translateScope: 'main',
  /** 整块超过这么多字符才分片并发翻译；低于它整块翻一次（与旧行为一致）。0 = 永不分片。 */
  chunkThreshold: 1000,
  /** 分片的目标长度区间；切片优先落在段落/换行/句末边界上。 */
  minChunkChars: 200,
  maxChunkChars: 800,
  /** true：某片翻译完成就立即作为 delta 下发（译文流式）；false：到 block-end 一次性下发。 */
  streamTranslated: true,
  /** 连续失败达到该次数后打开熔断，冷却期内不再发起翻译（0 = 不熔断）。 */
  breakerFailures: 3,
  /** 熔断冷却时长（毫秒）。 */
  breakerCooldownMs: 300000,
  /** 同时进行的翻译调用上限（0 = 不限）；长块分片时避免一次并发十几片触发限流。 */
  maxConcurrency: 4,
  /** 单片的额外重试次数（只对真实失败重试；取消不重试；0 = 不重试）。 */
  retry: 0,
  /**
   * 自诊断：为 true 时 apply() 每被调用一次就向 diagnosticsFile 追加一行 JSON，
   * 记录阶段、进程、入口 id、以及 systemPrompt/llm 等服务是否可见。
   * 用来回答「插件到底有没有被加载」——文件不出现就是没加载。
   */
  diagnostics: false,
  /** 诊断输出文件；diagnostics 为 true 时必须给绝对路径（宿主进程的 cwd 不可靠）。 */
  diagnosticsFile: '',
}

/** 攒够这么多字符就先判定一次语言：已是中文就立刻放行，避免白等一整块。 */
const PROBE_CHARS = 120

const STEERING_VALUES = new Set(['off', 'system-section', 'first-step-reminder', 'both'])
const REMIND_VALUES = new Set(['first', 'every', 'off'])

/**
 * 配置 schema：解析不到 schemastery 时为 undefined，行为完全一致（见 normalize）。
 *
 * 关于 `z?.object({...})`：可选链短路时**参数不会被求值**，所以无 schemastery 的环境里
 * 参数里那些 `z.string()` 也是安全的。实测 DSH 桌面壳正是这种情况——插件的包级
 * `node_modules` 里没有 schemastery，`Config` 一直是 undefined，全靠 `normalize` 兜底。
 * 外面再包一层 try/catch 是防另一个极端：`z` 存在但某个 API 缺失（那时整个模块会挂）。
 * @returns schema 或 undefined。
 */
function buildConfigSchema() {
  return z.object({
    steering: z.string().default(DEFAULTS.steering),
    remindOn: z.string().default(DEFAULTS.remindOn),
    steerAnswer: z.boolean().default(DEFAULTS.steerAnswer),
    translate: z.boolean().default(DEFAULTS.translate),
    translateProvider: z.string().default(DEFAULTS.translateProvider),
    translateModel: z.string().default(DEFAULTS.translateModel),
    translateThinkingOff: z.boolean().default(DEFAULTS.translateThinkingOff),
    translatePrompt: z.string().default(DEFAULTS.translatePrompt),
    keepTerms: z.array(z.string()).default(DEFAULTS.keepTerms),
    cjkThreshold: z.number().default(DEFAULTS.cjkThreshold),
    maxCharsPerBlock: z.number().default(DEFAULTS.maxCharsPerBlock),
    timeoutMs: z.number().default(DEFAULTS.timeoutMs),
    verbose: z.boolean().default(DEFAULTS.verbose),
    verboseFile: z.string().default(DEFAULTS.verboseFile),
    verboseFileMaxBytes: z.number().default(DEFAULTS.verboseFileMaxBytes),
    statsFile: z.string().default(DEFAULTS.statsFile),
    translateScope: z.string().default(DEFAULTS.translateScope),
    chunkThreshold: z.number().default(DEFAULTS.chunkThreshold),
    minChunkChars: z.number().default(DEFAULTS.minChunkChars),
    maxChunkChars: z.number().default(DEFAULTS.maxChunkChars),
    streamTranslated: z.boolean().default(DEFAULTS.streamTranslated),
    breakerFailures: z.number().default(DEFAULTS.breakerFailures),
    breakerCooldownMs: z.number().default(DEFAULTS.breakerCooldownMs),
    maxConcurrency: z.number().default(DEFAULTS.maxConcurrency),
    retry: z.number().default(DEFAULTS.retry),
    diagnostics: z.boolean().default(DEFAULTS.diagnostics),
    diagnosticsFile: z.string().default(DEFAULTS.diagnosticsFile),
  })
}

export const Config = (() => {
  if (z === undefined) return undefined
  try {
    return buildConfigSchema()
  } catch {
    // schema 不可用不影响功能：normalize 里有等价的手动校验与默认值。
    return undefined
  }
})()

/** 翻译中的辅助调用 options 身份集合，用于打破 llm/stream 的递归。 */
const AUX_CALLS = new WeakSet()

/**
 * 安全取服务：取不到或抛错都返回 undefined（**不要**把它用于必需服务，
 * 那会让插件静默半死；它只用于可选能力，例如命令）。
 */
function getService(ctx, name) {
  try {
    return ctx.get?.(name)
  } catch {
    return undefined
  }
}

/**
 * 诊断输出出口：`verbose` 是总开关（关掉就完全静默）；开启后写宿主 stderr，
 * 若还配了 `verboseFile` 就**同时**落盘。
 *
 * 为什么需要它：GUI（Electron）场景下宿主的 stderr 没人看得到、也不落盘，
 * 于是「翻译到底跑没跑、跳过了多少次、熔断了吗」这些事实在界面上完全不可见。
 * 落盘失败一律吞掉——诊断绝不能影响插件本身。
 * @param config - 归一化配置。
 * @param args - 与 `console.warn` 相同的参数（首参已带 `[reasoning-zh]` 前缀）。
 */
function warnTo(config, ...args) {
  if (!config.verbose) return
  console.warn(...args)
  if (config.verboseFile.length === 0) return
  try {
    appendDiagnostic(config, `${new Date().toISOString()} ${args.map((item) => String(item)).join(' ')}\n`)
  } catch {
    // 忽略：写不进去也不能影响主流程
  }
}

/**
 * 追加一行诊断到 `verboseFile`，必要时轮转一次；目录不存在会自动创建
 * （否则用户配一个尚未存在的路径会静默失败）。
 * @param config - 归一化配置。
 * @param line - 完整一行（含时间戳与换行）。
 */
function appendDiagnostic(config, line) {
  const file = config.verboseFile
  try {
    if (statSync(file).size > config.verboseFileMaxBytes) {
      renameSync(file, `${file}.1`)
    }
  } catch {
    // 文件还不存在，或正被别的进程占用 → 直接追加
  }
  try {
    mkdirSync(dirname(file), { recursive: true })
  } catch {
    // 目录已存在
  }
  appendFileSync(file, line, 'utf8')
}

// ───────────────────────── 累计统计的持久化 ─────────────────────────
//
// 本进程统计在内存里（`state.stats`），重启归零。想在重启之间累计用量，
// 就把 `statsFile` 指向一个 json，这里负责读写它。
// 关键设计：写盘时**先读盘再合并本进程「自上次 flush 以来的增量」**，
// 这样多个进程（例如并行跑 headless）同时写也不至于互相覆盖。

/** 参与累计的字段（`runs` 单独处理）。
 * @type {readonly string[]} */
const STATS_FIELDS = [
  'blocks',
  'translated',
  'skipped',
  'pieces',
  'failed',
  'sourceChars',
  'targetChars',
  'subagentSkips',
  'breakerTrips',
  'cancelled',
  'noop',
  'retries',
]

/**
 * 全零的累计统计。
 * @returns 字段全为 0 的对象（含 `runs`）。
 */
function zeroTotals() {
  const totals = { runs: 0 }
  for (const field of STATS_FIELDS) totals[field] = 0
  return totals
}

/**
 * 读累计统计文件；不存在、损坏、权限不足都返回 null（绝不抛）。
 * @param file - 文件绝对路径（空字符串直接返回 null）。
 * @returns `{ since, totals }` 或 null。
 */
function loadStatsFile(file) {
  if (file.length === 0) return null
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return {
      since: typeof parsed?.since === 'string' ? parsed.since : null,
      totals: { ...zeroTotals(), ...(parsed?.totals ?? {}) },
    }
  } catch {
    return null
  }
}

/**
 * 原子写累计统计（先写临时文件再 rename），失败返回 false。
 * @param file - 目标路径。
 * @param data - 完整文档。
 * @returns 是否写成功。
 */
function saveStatsFile(file, data) {
  if (file.length === 0) return false
  try {
    mkdirSync(dirname(file), { recursive: true })
    const tmp = `${file}.tmp-${process.pid}`
    writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
    renameSync(tmp, file)
    return true
  } catch {
    return false
  }
}

/**
 * 统计文件锁：同目录的 `<statsFile>.lock`。拿不到锁时返回 null，调用方跳过本次落盘、
 * 保留内存增量等下次再试，从而避免多个进程的「读-改-写」互相覆盖。
 * @param file - 统计文件绝对路径。
 * @returns 释放函数，或 null（锁被占用/无法创建）。
 */
function acquireStatsLock(file) {
  const lock = `${file}.lock`
  const tryCreate = () => {
    const fd = openSync(lock, 'wx')
    try {
      writeFileSync(fd, String(process.pid))
    } finally {
      closeSync(fd)
    }
  }
  try {
    mkdirSync(dirname(file), { recursive: true })
    tryCreate()
  } catch {
    // 进程崩溃可能留下陈旧锁：超过 60s 就清掉再试一次。
    try {
      if (Date.now() - statSync(lock).mtimeMs > 60000) {
        unlinkSync(lock)
        tryCreate()
      } else {
        return null
      }
    } catch {
      return null
    }
  }
  return () => {
    try {
      unlinkSync(lock)
    } catch {
      // 已被别的进程清掉
    }
  }
}

/**
 * 在文件锁内完成「读盘 → 合并 → 原子写」。拿不到锁返回 false，调用方保留增量。
 * @param file - 统计文件绝对路径。
 * @param mutate - 接收盘上旧文档，返回要写入的新文档。
 * @returns 是否写成功。
 */
function updateStatsFile(file, mutate) {
  if (file.length === 0) return false
  const release = acquireStatsLock(file)
  if (release === null) return false
  try {
    return saveStatsFile(file, mutate(loadStatsFile(file)))
  } finally {
    release()
  }
}

/**
 * 计算「盘上累计 + 本进程尚未落盘的增量」。
 * @param state - 插件实例状态。
 * @param config - 归一化配置。
 * @returns `{ since, totals }`，未配置 statsFile 时为 null。
 */
function computeCumulative(state, config) {
  if (config.statsFile.length === 0) return null
  const onDisk = loadStatsFile(config.statsFile)
  const base = onDisk?.totals ?? zeroTotals()
  const totals = { ...base }
  for (const field of STATS_FIELDS) {
    const session = state.stats[field] ?? 0
    const flushed = state.flushed[field] ?? 0
    totals[field] = (base[field] ?? 0) + Math.max(0, session - flushed)
  }
  totals.runs = base.runs ?? 0
  return { since: onDisk?.since ?? state.sinceFallback, totals }
}

/**
 * 把累计统计落盘，并记住「已落盘到哪」。
 * @param state - 插件实例状态。
 * @param config - 归一化配置。
 * @returns 是否写成功。
 */
function flushStats(state, config) {
  if (config.statsFile.length === 0) return false
  const ok = updateStatsFile(config.statsFile, (existing) => {
    const base = existing?.totals ?? zeroTotals()
    const totals = { ...base }
    for (const field of STATS_FIELDS) {
      const session = state.stats[field] ?? 0
      const flushed = state.flushed[field] ?? 0
      totals[field] = (base[field] ?? 0) + Math.max(0, session - flushed)
    }
    totals.runs = base.runs ?? 0
    return {
      version: 1,
      since: existing?.since ?? state.sinceFallback,
      updatedAt: new Date().toISOString(),
      totals,
    }
  })
  if (ok) {
    for (const field of STATS_FIELDS) state.flushed[field] = state.stats[field] ?? 0
  }
  return ok
}

/**
 * 去抖落盘：统计变化后 2 秒内的多次变化合并成一次写（定时器 unref，不阻塞进程退出）。
 * @param state - 插件实例状态。
 * @param config - 归一化配置。
 */
function scheduleFlush(state, config) {
  if (config.statsFile.length === 0) return
  if (state.flushTimer !== null) return
  const timer = setTimeout(() => {
    state.flushTimer = null
    flushStats(state, config)
  }, 2000)
  timer.unref?.()
  state.flushTimer = timer
}

/** 从包自身的 package.json 读版本号，供 `/reasoning-zh` 显示（读不到就 unknown）。 */
let PLUGIN_VERSION = 'unknown'
try {
  // 注意是 ../package.json：本文件在 lib/ 下，包根在上一级
  PLUGIN_VERSION = requireFromHere('../package.json')?.version ?? 'unknown'
} catch {
  // 忽略
}

/** 每个插件实例一份的运行统计；`/reasoning-zh` 读它，`/reasoning-zh reset` 清它。 */
function createStats() {
  return {
    startedAt: Date.now(),
    blocks: 0, // 处理过的 reasoning 块
    translated: 0, // 真正发起翻译的块
    skipped: 0, // 判定已是目标语言 / 超长保护而跳过的块
    pieces: 0, // 发出的翻译片数
    failed: 0, // 失败的片数
    sourceChars: 0, // 送去翻译的原文总字符
    targetChars: 0, // 得到的译文总字符
    subagentSkips: 0, // 因 translateScope 跳过的子会话请求数
    breakerTrips: 0, // 熔断打开次数
    cancelled: 0, // 因用户取消（主请求 abort）而放弃的片数
    noop: 0, // 译文与原文等价、没有实际收益的片数
    retries: 0, // 额外重试次数
    lastFailureAt: 0, // 最近一次翻译失败的时间戳
  }
}

/**
 * 把状态渲染成一段给人看的 markdown（命令的返回值直接进对话）。
 * @param state - 插件实例状态（含 stats 与 info）。
 * @param config - 归一化配置。
 * @returns markdown 文本。
 */
function formatStatus(state, config) {
  const info = state.info ?? {}
  const stats = state.stats
  const minutes = Math.max(0, Math.round((Date.now() - stats.startedAt) / 60000))
  const saved = stats.skipped + stats.subagentSkips
  const breaker = stats.breakerTrips === 0
    ? '未发生'
    : `${stats.breakerTrips} 次${breakerOpen(state, config) ? '（当前冷却中）' : '（已恢复）'}`
  const log = config.verboseFile.length === 0 ? '未配置 `verboseFile`' : `\`${config.verboseFile}\``
  return [
    `**dsh-reasoning-zh** v${info.version ?? PLUGIN_VERSION} · 本进程已运行 ${minutes} 分钟`,
    '',
    '| 层 | 状态 |',
    '|---|---|',
    `| ① 引导层（系统提示词段） | ${info.sectionRegistered === true ? '✅ 已注册' : '❌ 未注册'} |`,
    `| ② 重申层（每 turn pre-step） | ${info.reminderRegistered === true ? '✅ 已挂载' : '❌ 未挂载'} |`,
    `| ③ 翻译层（llm/stream） | ${info.translateRegistered === true ? '✅ 已挂载' : '❌ 未挂载'} |`,
    `| 命令 | ${info.commandRegistered === true
      ? '✅ 已注册'
      : (info.commandDeferred === true ? '⏳ 等待 commands 服务就绪' : `❌ ${info.commandError ?? '未注册'}`)} |`,
    '',
    '| 本进程统计 | 值 |',
    '|---|---|',
    `| 处理思考块 | ${stats.blocks}（翻译 ${stats.translated} / 跳过 ${stats.skipped}）|`,
    `| 翻译片数 | ${stats.pieces}（失败 ${stats.failed} / 取消 ${stats.cancelled} / 无变化 ${stats.noop} / 重试 ${stats.retries}）|`,
    `| 有效翻译 | ${Math.max(0, stats.pieces - stats.failed - stats.cancelled - stats.noop)} / ${stats.pieces} 片 |`,
    `| 字符量 | 原文 ${stats.sourceChars} → 译文 ${stats.targetChars} |`,
    `| 子会话跳过 | ${stats.subagentSkips} 次 |`,
    `| 熔断 | ${breaker} |`,
    `| 估算省下的模型调用 | ≈ ${saved} 次 |`,
    '',
    `配置：translate=${config.translate} · scope=${config.translateScope} · cjkThreshold=${config.cjkThreshold}`
      + ` · chunkThreshold=${config.chunkThreshold} · breakerFailures=${config.breakerFailures}`
      + ` · maxConcurrency=${config.maxConcurrency} · retry=${config.retry}`,
    `诊断日志：${log}`,
    ...cumulativeLines(state, config),
    '',
    '用法：`/reasoning-zh` · `/reasoning-zh reset [all]` · `/reasoning-zh log [N]`',
  ].join('\n')
}

/**
 * 累计统计那几行（未配置 `statsFile` 时给一句提示）。
 * @param state - 插件实例状态。
 * @param config - 归一化配置。
 * @returns markdown 行数组。
 */
function cumulativeLines(state, config) {
  const cumulative = computeCumulative(state, config)
  if (cumulative === null) {
    return ['累计统计：未开启（给插件行加上 `statsFile` 即可跨重启累计）']
  }
  const totals = cumulative.totals
  const since = cumulative.since === null ? '（首次运行）' : new Date(cumulative.since).toLocaleString('zh-CN')
  return [
    '',
    '| 累计统计（跨重启） | 值 |',
    '|---|---|',
    `| 处理思考块 | ${totals.blocks}（翻译 ${totals.translated} / 跳过 ${totals.skipped}）|`,
    `| 翻译片数 | ${totals.pieces}（失败 ${totals.failed} / 取消 ${totals.cancelled} / 无变化 ${totals.noop} / 重试 ${totals.retries}）|`,
    `| 有效翻译 | ${Math.max(0, totals.pieces - totals.failed - totals.cancelled - totals.noop)} / ${totals.pieces} 片 |`,
    `| 字符量 | 原文 ${totals.sourceChars} → 译文 ${totals.targetChars} |`,
    `| 子会话跳过 | ${totals.subagentSkips} 次 |`,
    `| 熔断 | ${totals.breakerTrips} 次 |`,
    `| 估算省下的模型调用 | ≈ ${totals.skipped + totals.subagentSkips} 次 |`,
    `| 插件加载次数 | ${totals.runs} 次 |`,
    `统计自 ${since} · 文件 \`${config.statsFile}\``,
  ]
}

/**
 * 读诊断日志尾部若干行。
 * @param config - 归一化配置。
 * @param lines - 要读的行数（已由调用方夹取上限）。
 * @returns CommandResult 形状的结果。
 */
function readLogTail(config, lines) {
  if (config.verboseFile.length === 0) {
    return {
      kind: 'success',
      text: '未配置 `verboseFile`，没有落盘日志可读。\n在 profile 的插件行 config 里加上 `verboseFile` 即可（见 README「诊断怎么查」）。',
    }
  }
  try {
    const text = readFileSync(config.verboseFile, 'utf8').trimEnd()
    if (text.length === 0) return { kind: 'success', text: `\`${config.verboseFile}\` 目前是空的。` }
    const all = text.split('\n')
    const tail = all.slice(-lines)
    return {
      kind: 'success',
      text: `\`${config.verboseFile}\`（共 ${all.length} 行，末 ${tail.length} 行）：\n\n\`\`\`\n${tail.join('\n')}\n\`\`\``,
    }
  } catch (error) {
    return { kind: 'error', text: `读日志失败：${error?.message ?? error}` }
  }
}

/**
 * `/reasoning-zh` 的处理器：宿主侧执行，不经过模型、不花 token。
 * @param invocation - 命令调用（含 rawInput）。
 * @param state - 插件实例状态。
 * @param config - 归一化配置。
 * @returns CommandResult。
 */
function handleStatusCommand(invocation, state, config) {
  const arg = (invocation?.rawInput ?? '').trim()
  if (arg.length === 0) return { kind: 'success', text: formatStatus(state, config) }

  const [verb, ...rest] = arg.split(/\s+/)
  if (verb === 'reset') {
    if (rest[0] === 'all') {
      if (config.statsFile.length === 0) {
        return { kind: 'error', text: '未配置 `statsFile`，没有累计统计可清。' }
      }
      // 先让增量归零（否则内存里的旧值会立刻被重新累加回去），再整体重置文件。
      for (const field of STATS_FIELDS) state.flushed[field] = state.stats[field] ?? 0
      const now = new Date().toISOString()
      const ok = updateStatsFile(config.statsFile, () => ({
        version: 1,
        since: now,
        updatedAt: now,
        totals: zeroTotals(),
      }))
      return ok
        ? { kind: 'success', text: '累计统计已清零（本进程统计保留，加载次数一并归零）。' }
        : { kind: 'error', text: `累计统计清零失败（写不了 ${config.statsFile}）。` }
    }
    const info = state.info
    state.stats = createStats()
    state.info = info
    return { kind: 'success', text: '本进程统计已清零（累计统计保留）。' }
  }
  if (verb === 'log') {
    const parsed = Number.parseInt(rest[0] ?? '', 10)
    const lines = Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 500) : 30
    return readLogTail(config, lines)
  }
  return { kind: 'error', text: `未知参数 ${JSON.stringify(arg)}。用法：/reasoning-zh [reset | log [N]]` }
}

/**
 * 注册 `/reasoning-zh` 命令。
 *
 * 为什么不直接用 `inject: ['commands']`：命令只是附加能力（核心是三个语言层），
 * 一旦写进 inject，某个没有该服务的组合会让**整个插件停在 pending**——
 * 那正是「插件没加载」这类最难排查的故障。
 *
 * 但也不能只 `ctx.get('commands')` 试一次就放弃：实测桌面壳里插件经
 * **bundle include 层**加载，apply 比 `dsh-commands` **早约 4 秒**
 * （探针：`apply entry=include:reasoning-zh commands=undefined register=FAIL`），
 * 一次性尝试会让命令被静默跳过。所以改成三条路径，全部幂等：
 *   1. 立即试一次（顶层 patch 层 / headless 场景，服务已就绪）；
 *   2. 失败则用 cordis 的动态注入 `ctx.inject(['commands'], …)` 等服务出现再注册；
 *   3. 再挂一个 `agent/created` 兜底（构建 agent 时服务必然就绪），仅在 1 失败时才挂。
 * 取服务统一用**外层 ctx**，保证注册作用域与「立即注册」完全一致。
 * @param ctx - 插件的 cordis 上下文。
 * @param config - 归一化配置。
 * @param state - 插件实例状态。
 * @returns 注册结果（`deferred` 为真表示还在等服务就绪）。
 */
function registerStatusCommand(ctx, config, state) {
  let registered = false
  let unregister
  let reason = 'commands 服务不可用'

  /**
   * 幂等地注册一次；服务没就绪就返回原因，绝不抛。
   * @param where - 触发路径（仅用于诊断）。
   * @returns 是否已注册。
   */
  const attempt = (where) => {
    if (registered) return true
    const commands = getService(ctx, 'commands')
    if (commands === undefined || typeof commands.register !== 'function') {
      reason = 'commands 服务不可用'
      return false
    }
    try {
      unregister = commands.register({
        name: 'reasoning-zh',
        description: '思考语言插件：三层状态、本进程统计与诊断日志（/reasoning-zh [reset | log [N]]）',
        input: { hint: '[reset | log [N]]' },
        handler: (invocation) => handleStatusCommand(invocation, state, config),
      })
      registered = true
      reason = null
      state.command.registered = true
      state.command.error = null
      if (state.info !== null) {
        state.info.commandRegistered = true
        state.info.commandError = null
      }
      if (where !== 'immediate') {
        warnTo(config, `[reasoning-zh] 命令延迟注册成功（路径 ${where}）：/reasoning-zh 可用`)
      }
      return true
    } catch (error) {
      reason = String(error?.message ?? error)
      state.command.registered = false
      state.command.error = reason
      if (state.info !== null) {
        state.info.commandRegistered = false
        state.info.commandError = reason
      }
      warnTo(config, `[reasoning-zh] 命令注册失败（路径 ${where}）：${reason}`)
      return false
    }
  }

  if (attempt('immediate')) {
    return { ok: true, dispose: () => unregister?.() }
  }

  warnTo(config, '[reasoning-zh] commands 服务此刻尚未就绪（bundle include 层的 apply 比 dsh-commands 早），已挂延迟注册')
  // 路径 2：等服务就绪（cordis 的动态注入）。
  let fiber
  if (typeof ctx.inject === 'function') {
    try {
      fiber = ctx.inject(['commands'], () => attempt('inject'))
    } catch (error) {
      reason = `inject 失败：${String(error?.message ?? error)}`
    }
  }

  // 路径 3：只在没有 ctx.inject 的旧 cordis 上兜底。现代版本路径 2 已经足够，
  // 不再额外挂 agent/created（少一个无谓监听，也少一条容易误判的状态分支）。
  let off
  if (typeof ctx.inject !== 'function') {
    try {
      off = ctx.on('agent/created', () => attempt('agent/created'))
    } catch {
      // 挂不上也不影响前两条路径
    }
  }

  return {
    ok: false,
    deferred: true,
    reason,
    dispose: () => {
      unregister?.()
      fiber?.dispose?.()
      off?.()
    },
  }
}

/** translateScope 取值。 */
const TRANSLATE_SCOPE_VALUES = new Set(['main', 'all'])

/**
 * 该请求是否属于主会话（而非子代理/工作流里的子会话）。
 *
 * 子代理在同一进程内复用同一个 `llm` 服务，因此 `llm/stream` 上看不出父子关系，
 * 只能按会话线索判断：`agent.parentAgent` 存在、或 session header 的
 * `delegationDepth > 0`，即视为子会话。查不到线索时按主会话处理——
 * 宁可多翻一次，也不要因为拿不到 registry 就漏翻主会话。
 * @param ctx - 插件的 cordis 上下文。
 * @param options - 本次模型请求。
 * @returns 是否主会话。
 */
function isMainSession(ctx, options) {
  const id = options.sessionId
  if (id === undefined) return true
  try {
    const agent = ctx.get?.('agents')?.get?.(id)
    if (agent === undefined) return true
    if (agent.parentAgent !== undefined) return false
    const depth = agent.session?.header?.delegationDepth
    return !(typeof depth === 'number' && depth > 0)
  } catch {
    return true
  }
}

/** 每个插件实例一份的熔断状态（放模块级会让多 profile 互相影响）。 */
function createBreaker() {
  return { failures: 0, openUntil: 0, tripped: 0 }
}

/**
 * 熔断是否打开。打开期间整条流直通，避免路由故障时每个思考块各白等一次 `timeoutMs`。
 * @param state - 含 breaker 的实例状态。
 * @param config - 归一化配置。
 * @param now - 便于测试注入的时间戳。
 * @returns 是否处于熔断期。
 */
function breakerOpen(state, config, now = Date.now()) {
  if (config.breakerFailures <= 0) return false
  if (state.breaker.openUntil === 0) return false
  if (now < state.breaker.openUntil) return true
  // 冷却结束，复位
  state.breaker.openUntil = 0
  state.breaker.failures = 0
  return false
}

/**
 * 记录一次翻译结果并维护熔断器。成功清零；连续失败达到阈值则打开冷却期。
 * @param state - 含 breaker 的实例状态。
 * @param config - 归一化配置。
 * @param ok - 本次翻译是否成功。
 */
function recordTranslateOutcome(state, config, ok) {
  const stats = state.stats
  if (!ok && stats !== undefined) {
    stats.failed += 1
    stats.lastFailureAt = Date.now()
    scheduleFlush(state, config)
  }
  if (config.breakerFailures <= 0) return
  const breaker = state.breaker
  if (ok) {
    breaker.failures = 0
    return
  }
  breaker.failures += 1
  if (breaker.failures >= config.breakerFailures) {
    breaker.failures = 0
    breaker.openUntil = Date.now() + config.breakerCooldownMs
    breaker.tripped += 1
    if (stats !== undefined) {
      stats.breakerTrips += 1
      scheduleFlush(state, config)
    }
    if (config.verbose) {
      warnTo(config, `[reasoning-zh] 翻译连续失败 ${config.breakerFailures} 次，熔断 ${config.breakerCooldownMs}ms（第 ${breaker.tripped} 次）`)
    }
  }
}

/**
 * 从缓冲文本头部切一片出来。
 * 返回 `[head, tail]`；`head` 为 `null` 表示还不到切的时候。
 * 切点优先落在段落/换行/句末边界上，避免把一句话从中间劈开。
 * @param text - 待切文本。
 * @param min - 片长下限；边界早于它时改为硬切 `max`。
 * @param max - 片长上限。
 * @returns 切出的头片与剩余尾巴。
 */
function splitChunk(text, min, max) {
  if (text.length <= max) return [null, text]
  const window = text.slice(0, max)
  // [边界位置, 该边界要一起吃掉的字符宽度]
  const candidates = [
    [window.lastIndexOf('\n\n'), 2],
    [window.lastIndexOf('\n'), 1],
    [window.lastIndexOf('。'), 1],
    [window.lastIndexOf('！'), 1],
    [window.lastIndexOf('？'), 1],
    [window.lastIndexOf('；'), 1],
    [window.lastIndexOf('. '), 2],
    [window.lastIndexOf('; '), 2],
  ]
  let boundary = -1
  let width = 1
  for (const [at, size] of candidates) {
    if (at > boundary) {
      boundary = at
      width = size
    }
  }
  const cut = boundary >= min ? boundary + width : max
  return [text.slice(0, cut), text.slice(cut)]
}

/**
 * 探测几个关键服务在**当前作用域**里是否可见。
 * cordis 的 inject 未满足时插件不会被调用，所以这份快照是排障的第一手材料。
 * @param ctx - 插件的 cordis 上下文。
 * @returns 服务名 → typeof 结果（或抛错信息）。
 */
function snapshotServices(ctx) {
  const out = {}
  for (const name of ['systemPrompt', 'llm', 'agents', 'loader', 'sessions']) {
    try {
      out[name] = typeof ctx.get?.(name)
    } catch (error) {
      out[name] = `throw:${error?.message ?? error}`
    }
  }
  return out
}

/**
 * 诊断落盘：一行一条 JSONL。任何失败都被吞掉——诊断绝不能影响插件本身。
 * @param ctx - 插件的 cordis 上下文。
 * @param config - 归一化配置。
 * @param phase - start / done / section-failed。
 * @param extra - 追加字段。
 */
function recordApply(ctx, config, phase, extra = {}) {
  if (!config.diagnostics || config.diagnosticsFile.length === 0) return
  try {
    appendFileSync(config.diagnosticsFile, `${JSON.stringify({
      time: new Date().toISOString(),
      phase,
      pid: process.pid,
      module: import.meta.url,
      execPath: process.execPath,
      entry: ctx?.fiber?.entry?.id ?? null,
      services: snapshotServices(ctx),
      ...extra,
    })}\n`, 'utf8')
  } catch {
    // 忽略
  }
}

/** 深冻结（与 dsh-llm 的 freezeMessage 同语义）。 */
function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const key of Object.getOwnPropertyNames(value)) deepFreeze(value[key])
  }
  return value
}

/**
 * 构造一条带稳定身份的 user 消息：优先用官方 createUserMessage，其次本地等价实现
 * （id 同为 randomUUID，整体 structuredClone + deepFreeze，与上游一致）。
 * @param text - 模型可见文本。
 * @param source - 生产者来源；插件注入内容用生产者自有 kind（如 'plugin:reasoning-zh'）。
 * @returns 冻结后的 UserMessage。
 */
function makeUserMessage(text, source) {
  const content = [{ type: 'text', text }]
  if (createUserMessage !== undefined) return createUserMessage({ content, source })
  return deepFreeze(structuredClone({ id: randomUUID(), role: 'user', content, source }))
}

const CJK_IDEOGRAPHS = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g
const LATIN_LETTERS = /[A-Za-z]/g
/** 平假名/片假名：有它就当日文处理，绝不因为「汉字占比高」而跳过翻译。 */
const KANA = /[\u3040-\u30ff\u31f0-\u31ff]/

/** 代码围栏、行内代码、URL：判定语言前先剥掉，避免代码里的英文词把中文块判成英文。 */
const CODE_FENCE = /```[\s\S]*?```/g
const INLINE_CODE = /`[^`]*`/g
const URL_PATTERN = /https?:\/\/\S+/g
/** 英文字母开头的词（含连字符/撇号），用于识别混合块里是否还有成句英文。 */
const ENGLISH_WORD = /[A-Za-z][A-Za-z'’-]+/g
/** 汉字占比低于该值、且英文词不少于 MIXED_ENGLISH_WORDS 时，不把块当成「已是中文」。 */
const MIXED_LANGUAGE_FLOOR = 0.6
const MIXED_ENGLISH_WORDS = 8

/**
 * 只保留自然语言部分：去掉代码块、行内代码与 URL。
 * @param text - 原始 reasoning 文本。
 * @returns 去掉代码片段后的文本。
 */
function naturalLanguageOnly(text) {
  return text.replace(CODE_FENCE, ' ').replace(INLINE_CODE, ' ').replace(URL_PATTERN, ' ')
}

/**
 * 自然语言部分里的英文词数。
 * @param text - 原始 reasoning 文本。
 * @returns 英文词个数。
 */
function englishNaturalWords(text) {
  return naturalLanguageOnly(text).match(ENGLISH_WORD)?.length ?? 0
}

/**
 * 汉字占比 = 汉字数 / (汉字数 + 拉丁字母数)。
 * 纯数字/符号/空白视为 1（没什么可翻的）。
 * @param text - 待判定文本。
 * @returns 0..1 之间的占比。
 */
function cjkRatio(text) {
  const cjk = text.match(CJK_IDEOGRAPHS)?.length ?? 0
  const latin = text.match(LATIN_LETTERS)?.length ?? 0
  const total = cjk + latin
  if (total === 0) return 1
  return cjk / total
}

/**
 * 是否已经可以当作简体中文、无需翻译。
 * 这是省钱的那道闸：提示词引导层经常已经让模型原生用中文思考，
 * 此时再翻一遍纯属浪费一次模型调用（实测出现过 218 -> 218 字符）。
 *
 * 只看汉字占比会漏掉「中文夹大段英文」的混合块：日志里汉字占比 31%–37%
 * 的块曾被整体跳过，英文叙述也一起留下。因此低于 MIXED_LANGUAGE_FLOOR 时，
 * 再按自然语言（去掉代码/URL）里的英文词数兜底判定。
 * @param text - 一个完整的 reasoning 块（或它的前若干字符）。
 * @param threshold - 汉字占比阈值；0 表示从不跳过。
 * @returns 是否跳过翻译。
 */
function isAlreadyChinese(text, threshold) {
  if (!(threshold > 0)) return false
  if (KANA.test(text)) return false
  const ratio = cjkRatio(text)
  if (ratio < threshold) return false
  if (ratio < MIXED_LANGUAGE_FLOOR && englishNaturalWords(text) >= MIXED_ENGLISH_WORDS) return false
  return true
}

/**
 * 比较译文与原文是否等价（忽略空白）。用于识别「翻了等于没翻」的 no-op。
 * @param text - 原文或译文。
 * @returns 去掉空白后的文本。
 */
function normalizeForCompare(text) {
  return text.replace(/\s+/g, '').trim()
}

/**
 * 归一化并校验配置；无效值直接抛错，不静默回退。
 * @param raw - 来自 profile patch 的原始配置，可能为空。
 * @returns 完整配置。
 */
function normalize(raw) {
  const config = { ...DEFAULTS, ...(raw ?? {}) }
  if (!STEERING_VALUES.has(config.steering)) {
    throw new Error(`reasoning-zh: steering 必须是 ${[...STEERING_VALUES].join(' | ')}，收到 ${JSON.stringify(config.steering)}`)
  }
  if (!REMIND_VALUES.has(config.remindOn)) {
    throw new Error(`reasoning-zh: remindOn 必须是 ${[...REMIND_VALUES].join(' | ')}，收到 ${JSON.stringify(config.remindOn)}`)
  }
  for (const key of ['steerAnswer', 'translate', 'translateThinkingOff', 'verbose', 'diagnostics', 'streamTranslated']) {
    if (typeof config[key] !== 'boolean') {
      throw new Error(`reasoning-zh: ${key} 必须是布尔值，收到 ${JSON.stringify(config[key])}`)
    }
  }
  for (const key of ['maxCharsPerBlock', 'timeoutMs']) {
    if (!Number.isFinite(config[key]) || config[key] <= 0) {
      throw new Error(`reasoning-zh: ${key} 必须是正数，收到 ${JSON.stringify(config[key])}`)
    }
  }
  if (!Number.isFinite(config.cjkThreshold) || config.cjkThreshold < 0 || config.cjkThreshold > 1) {
    throw new Error(`reasoning-zh: cjkThreshold 必须是 0..1，收到 ${JSON.stringify(config.cjkThreshold)}`)
  }
  if (!TRANSLATE_SCOPE_VALUES.has(config.translateScope)) {
    throw new Error(`reasoning-zh: translateScope 必须是 ${[...TRANSLATE_SCOPE_VALUES].join(' | ')}，收到 ${JSON.stringify(config.translateScope)}`)
  }
  for (const key of ['chunkThreshold', 'breakerFailures', 'breakerCooldownMs']) {
    if (!Number.isFinite(config[key]) || config[key] < 0) {
      throw new Error(`reasoning-zh: ${key} 必须是非负数，收到 ${JSON.stringify(config[key])}`)
    }
  }
  for (const key of ['minChunkChars', 'maxChunkChars']) {
    if (!Number.isFinite(config[key]) || config[key] <= 0) {
      throw new Error(`reasoning-zh: ${key} 必须是正数，收到 ${JSON.stringify(config[key])}`)
    }
  }
  if (config.maxChunkChars < config.minChunkChars) {
    throw new Error(`reasoning-zh: maxChunkChars(${config.maxChunkChars}) 不能小于 minChunkChars(${config.minChunkChars})`)
  }
  for (const key of ['translateProvider', 'translateModel', 'translatePrompt']) {
    if (typeof config[key] !== 'string' || config[key].length === 0) {
      throw new Error(`reasoning-zh: ${key} 不能为空`)
    }
  }
  if (typeof config.diagnosticsFile !== 'string') {
    throw new Error(`reasoning-zh: diagnosticsFile 必须是字符串`)
  }
  if (typeof config.verboseFile !== 'string') {
    throw new Error(`reasoning-zh: verboseFile 必须是字符串（空字符串 = 不落盘）`)
  }
  if (!Number.isFinite(config.verboseFileMaxBytes) || config.verboseFileMaxBytes <= 0) {
    throw new Error(`reasoning-zh: verboseFileMaxBytes 必须是正数，收到 ${JSON.stringify(config.verboseFileMaxBytes)}`)
  }
  if (typeof config.statsFile !== 'string') {
    throw new Error(`reasoning-zh: statsFile 必须是字符串（空字符串 = 只在内存里统计）`)
  }
  if (!Array.isArray(config.keepTerms)
    || config.keepTerms.some((term) => typeof term !== 'string' || term.length === 0)) {
    throw new Error('reasoning-zh: keepTerms 必须是字符串数组，且不能含空项')
  }
  if (config.diagnostics && config.diagnosticsFile.length === 0) {
    throw new Error('reasoning-zh: 开启 diagnostics 时必须给出 diagnosticsFile 的绝对路径')
  }
  for (const key of ['maxConcurrency', 'retry']) {
    if (!Number.isInteger(config[key]) || config[key] < 0) {
      throw new Error(`reasoning-zh: ${key} 必须是非负整数，收到 ${JSON.stringify(config[key])}`)
    }
  }
  return config
}

/** 系统提示词段的文本。 */
function instructionText(config) {
  const lines = [
    '## 思考语言',
    '内部推理（reasoning）、规划与工具调用理由一律使用简体中文。',
    '代码、标识符、命令、路径、日志和引用原文保持原样，不要翻译。',
  ]
  if (config.steerAnswer) lines.push('面向用户的最终回答同样使用简体中文。')
  return lines.join('\n')
}

/** 每步重申用的提醒消息。 */
function reminderMessage(config) {
  const tail = config.steerAnswer ? '回答也用简体中文' : '回答语言不限'
  return makeUserMessage(
    `<system-reminder>继续用简体中文进行思考与推理（${tail}）；代码、命令、路径保持原样。</system-reminder>`,
    {
      kind: 'plugin:reasoning-zh',
      form: 'notice',
      summary: '思考语言提醒',
    },
  )
}

/**
 * 挂载插件。
 * @param ctx - cordis 上下文（profile 根上下文）。
 * @param raw - 插件配置。
 * @returns 释放全部注册的 disposer。
 */
export function apply(ctx, raw) {
  const config = normalize(raw)
  const disposers = []
  /** 插件实例状态：熔断器按实例计数，避免多 profile/多实例互相影响。 */
  const state = {
    breaker: createBreaker(),
    scopeSkipped: new Set(),
    stats: createStats(),
    info: null,
    /** 命令注册状态（可被延迟注册路径更新，详见 registerStatusCommand）。 */
    command: { registered: false, error: null },
    /** 累计统计：已落盘到哪个进度（用增量算法合并，见 flushStats）。 */
    flushed: zeroTotals(),
    /** 去抖写盘定时器。 */
    flushTimer: null,
    /** 统计文件首次创建时的时间戳。 */
    sinceFallback: new Date().toISOString(),
  }

  recordApply(ctx, config, 'start', {
    steering: config.steering,
    remindOn: config.remindOn,
    translate: config.translate,
    translateScope: config.translateScope,
  })

  const wantSection = config.steering === 'both' || config.steering === 'system-section'
  const wantReminder = (config.steering === 'both' || config.steering === 'first-step-reminder')
    && config.remindOn !== 'off'

  // ① 引导层。注册失败不再让插件整体抛错（那会让宿主启动失败），而是记录原因。
  let sectionRegistered = false
  let sectionError = null
  if (wantSection) {
    try {
      disposers.push(ctx.effect(
        () => {
          const dispose = ctx.systemPrompt.section({
            name: SECTION_NAME,
            order: SECTION_ORDER,
            text: instructionText(config),
          })
          sectionRegistered = true
          return dispose
        },
        'reasoning-zh.section()',
      ))
    } catch (error) {
      sectionError = String(error?.message ?? error)
    }
  }

  // ② 重申层：每个新 agent 自己的作用域里挂 pre-step。
  //    注册要纳入 agent.ctx.effect，并在插件卸载时主动释放：插件 fiber 销毁不会自动
  //    清掉 agent.ctx 上的监听，否则禁用/热重载后已有会话仍会继续收到提醒。
  let reminderRegistered = false
  const perAgentDisposers = new Set()
  const installReminder = (agent) => {
    const handler = async ({ messages, signal, step }, next) => {
      const decision = await next()
      if (decision.kind === 'reject' || signal.aborted) return decision
      if (config.remindOn === 'first' && step !== 1) return decision
      // 循环会跳过空的首步与被清空的续步：那一步不会发出请求，别白塞消息。
      if (decision.messages.length === 0 && (step === 1 || messages.length > 0)) return decision
      return { ...decision, messages: [...decision.messages, reminderMessage(config)] }
    }
    if (typeof agent?.ctx?.effect === 'function') {
      try {
        perAgentDisposers.add(agent.ctx.effect(
          () => agent.ctx.on('agent/pre-step', handler, { prepend: true }),
        ))
        return
      } catch {
        // 旧 cordis 没有 effect 时退回直接注册。
      }
    }
    try {
      perAgentDisposers.add(agent.ctx.on('agent/pre-step', handler, { prepend: true }))
    } catch {
      // 单个 agent 注册失败不能影响其它 agent。
    }
  }
  if (wantReminder) {
    try {
      ctx.on('agent/created', ({ agent }) => installReminder(agent))
      reminderRegistered = true
    } catch (error) {
      sectionError = `reminder:${String(error?.message ?? error)}`
    }
  }

  // ③ 兜底层
  let translateRegistered = false
  if (config.translate) {
    try {
      disposers.push(ctx.on(
        'llm/stream',
        (options, next) => rewriteReasoning(ctx, config, options, state, next()),
        { global: true, prepend: true },
      ))
      translateRegistered = true
    } catch (error) {
      sectionError = `translate:${String(error?.message ?? error)}`
    }
  }

  // ④ 状态命令（附加能力，取不到 commands 服务就跳过，绝不影响上面三层）
  const command = registerStatusCommand(ctx, config, state)
  if (command.ok) disposers.push(command.dispose)

  // ⑤ 累计统计：加载次数 +1，并立刻落盘一次（统计从此处开始有记录）
  if (config.statsFile.length > 0) {
    const ok = updateStatsFile(config.statsFile, (existing) => {
      const totals = existing?.totals ?? zeroTotals()
      return {
        version: 1,
        since: existing?.since ?? state.sinceFallback,
        updatedAt: new Date().toISOString(),
        totals: { ...totals, runs: (totals.runs ?? 0) + 1 },
      }
    })
    if (!ok) sectionError = sectionError ?? 'stats:写不了 statsFile'
  }

  // 启动摘要写进诊断日志：以后「这一版什么时候加载过、命令有没有挂上」一查就知道。
  warnTo(
    config,
    `[reasoning-zh] 已加载 v${PLUGIN_VERSION} · 入口=${ctx?.fiber?.entry?.id ?? '?'}`
    + ` · ①引导=${sectionRegistered ? 'ok' : '未注册'} ②重申=${reminderRegistered ? 'ok' : '未挂载'}`
    + ` ③翻译=${translateRegistered ? 'ok' : '未挂载'}`
    + ` 命令=${state.command.registered ? 'ok' : (command.deferred === true ? '等待服务就绪' : `失败(${state.command.error ?? '未知'})`)}`
    + (config.statsFile.length === 0 ? '' : ' · 累计统计=已开启'),
  )

  state.info = {
    version: PLUGIN_VERSION,
    loadedAt: new Date().toISOString(),
    pid: process.pid,
    entry: ctx?.fiber?.entry?.id ?? null,
    sectionRegistered,
    reminderRegistered,
    translateRegistered,
    commandRegistered: state.command.registered,
    commandError: state.command.error,
    commandDeferred: command.deferred === true,
  }

  recordApply(ctx, config, 'done', {
    sectionRegistered,
    reminderRegistered,
    translateRegistered,
    commandRegistered: state.command.registered,
    commandError: state.command.error,
    commandDeferred: command.deferred === true,
    translateScope: config.translateScope,
    breakerFailures: config.breakerFailures,
    error: sectionError,
  })

  return () => {
    // 卸载前把尚未落盘的累计统计写掉，并取消待执行的去抖写。
    if (state.flushTimer !== null) {
      clearTimeout(state.flushTimer)
      state.flushTimer = null
    }
    flushStats(state, config)
    for (const dispose of perAgentDisposers) {
      try {
        dispose?.()
      } catch {
        // 已随 agent 销毁
      }
    }
    perAgentDisposers.clear()
    for (const dispose of disposers) {
      try {
        dispose?.()
      } catch {
        // 释放失败不影响其他注册。
      }
    }
  }
}

/**
 * 包装原始流：缓冲 reasoning delta，翻译后重写 block-end。
 *
 * 协议要点（改动前务必保持）：
 *   - block-start 原样下发；同一 index 的 delta 必须全部在它的 block-end 之前发出；
 *   - block-end 的 `block.text` 必须等于该块已发出的所有 delta 拼接，否则回放与实时不一致；
 *   - 任何路径（finish / 下游抛错 / 正常结束）都不能丢内容。
 *
 * 三条优化（对应同名的配置项）：
 *   - 分片并发：整块够长就按段落/句末边界切片并发翻译，总等待≈最慢的一片；
 *   - 译文流式（`streamTranslated`）：某片译完立即作为 delta 下发，不必等整块；
 *   - 熔断：连续失败后进入冷却，冷却期内整条流直通，不再逐块白等 `timeoutMs`。
 * @param ctx - cordis 上下文（用于发起辅助翻译调用）。
 * @param config - 归一化配置。
 * @param options - 本次模型请求（可能是 deep-frozen 的 loop 请求，只读）。
 * @param state - 插件实例状态（含熔断器）。
 * @param source - 下游（适配器）产出的原始块流。
 * @returns 重写后的块流。
 */
async function* rewriteReasoning(ctx, config, options, state, source) {
  // 辅助翻译调用自身、以及压缩/标题这类附带调用，一律直通。
  if (AUX_CALLS.has(options) || options.purpose !== undefined) {
    yield* source
    return
  }
  // 子代理/工作流的会话默认不翻（省成本，见 translateScope）。
  if (config.translateScope === 'main' && !isMainSession(ctx, options)) {
    if (state.stats !== undefined) state.stats.subagentSkips += 1
    if (config.verbose) {
      const key = options.sessionId ?? '(no-session)'
      if (!state.scopeSkipped.has(key)) {
        state.scopeSkipped.add(key)
        warnTo(config, `[reasoning-zh] 子会话 ${key} 跳过翻译（translateScope=main）`)
      }
    }
    yield* source
    return
  }
  // 熔断期：整条流直通，不再逐块尝试。
  if (breakerOpen(state, config)) {
    if (config.verbose) warnTo(config, '[reasoning-zh] 熔断期，本次请求不做翻译')
    yield* source
    return
  }

  /** index -> 尚未成片的原文尾巴 */
  const buffer = new Map()
  /** 已判定为「不翻译」的 index（已是中文，或超长保护），之后原样透传 */
  const passthrough = new Set()
  /** 已做过一次语言判定的 index */
  const decided = new Set()
  /** index -> 分片作业 */
  const jobs = new Map()

  /** 累加一项统计（state.stats 缺失时静默跳过，便于单测直接调用本函数）。 */
  const bump = (field, by = 1) => {
    if (state.stats === undefined) return
    state.stats[field] += by
    scheduleFlush(state, config)
  }

  /** 取（或建）某个 index 的作业。 */
  const jobOf = (index) => {
    let job = jobs.get(index)
    if (job === undefined) {
      job = { pieces: [], cursor: 0, sourceChars: 0 }
      jobs.set(index, job)
    }
    return job
  }

  /** 同时进行的翻译调用上限（0 = 不限）；整条流共享一个 limiter。 */
  const limit = createLimiter(config.maxConcurrency)

  /**
   * 发起一片翻译（不 await）：结果挂在 piece 上，成功/失败/取消分别记入统计。
   * 取消（主请求 abort）不算失败，也不喂给熔断器。
   * @param index - 块序号。
   * @param text - 这一片的原文。
   * @returns 片记录；其 `done` 永不 reject。
   */
  const launch = (index, text) => {
    const job = jobOf(index)
    const piece = {
      original: text,
      settled: false,
      text: undefined,
      failed: false,
      cancelled: false,
      noop: false,
      done: undefined,
    }
    if (text.length === 0) {
      piece.settled = true
      piece.done = Promise.resolve()
    } else if (options.signal?.aborted === true) {
      // 翻译还没开始主请求就被取消：不调用辅助模型，单独计入取消。
      piece.settled = true
      piece.cancelled = true
      bump('cancelled')
      piece.done = Promise.resolve()
    } else {
      piece.done = limit(() => translateWithRetry(ctx, config, text, options.signal))
        .then((result) => {
          piece.settled = true
          if (result.kind === 'ok') {
            piece.text = result.text
            piece.noop = normalizeForCompare(result.text) === normalizeForCompare(text)
            if (piece.noop) bump('noop')
            if (result.attempts > 1) bump('retries', result.attempts - 1)
            recordTranslateOutcome(state, config, true)
          } else if (result.kind === 'cancelled') {
            piece.cancelled = true
            bump('cancelled')
          } else {
            piece.failed = true
            if (result.attempts > 1) bump('retries', result.attempts - 1)
            recordTranslateOutcome(state, config, false)
          }
        })
        .catch(() => {
          piece.settled = true
          piece.failed = true
          recordTranslateOutcome(state, config, false)
        })
    }
    job.pieces.push(piece)
    job.sourceChars += text.length
    return piece
  }

  /**
   * 按顺序下发已完成的片，不阻塞（保持同 index 的 delta 顺序）。
   * @param index - 块序号。
   * @param force - true 时连未完成的片也按原文下发（收尾/异常路径）。
   */
  const drain = function* drain(index, force) {
    const job = jobs.get(index)
    if (job === undefined) return
    while (job.cursor < job.pieces.length) {
      const piece = job.pieces[job.cursor]
      if (!piece.settled && force !== true) return
      const text = piece.text ?? piece.original
      job.cursor += 1
      yield { type: 'reasoning-delta', index, text }
    }
  }

  /** 把缓冲里所有尾巴按原文补发出去（finish / 异常 / 协议异常共用）。 */
  const flushBuffer = function* flushBuffer() {
    for (const index of [...buffer.keys()]) {
      const text = buffer.get(index)
      buffer.delete(index)
      yield { type: 'reasoning-delta', index, text }
    }
  }

  /** 作业的最终文本 = 各片译文（失败或未完成的片回落原文）按顺序拼接。 */
  const jobText = (job) => job.pieces.map((piece) => piece.text ?? piece.original).join('')

  try {
    for await (const chunk of source) {
      // 译文流式：后续 chunk 到达时，把已经译好的片按顺序放出去。
      if (config.streamTranslated && chunk.type !== 'block-end' && chunk.type !== 'finish') {
        for (const index of [...jobs.keys()]) yield* drain(index, false)
      }

      switch (chunk.type) {
        case 'reasoning-delta': {
          if (passthrough.has(chunk.index)) {
            yield chunk
            break
          }
          const rest = (buffer.get(chunk.index) ?? '') + chunk.text
          const existing = jobs.get(chunk.index)
          const translating = existing !== undefined && existing.pieces.length > 0

          // 超长保护：只在「还没开始翻译」时生效，避免已发译文与原文混排。
          if (!translating && rest.length > config.maxCharsPerBlock) {
            buffer.delete(chunk.index)
            passthrough.add(chunk.index)
            bump('skipped')
            bump('blocks')
            if (config.verbose) {
              warnTo(config, `[reasoning-zh] reasoning 块 ${chunk.index} 超过 ${config.maxCharsPerBlock} 字符，改为原文透传`)
            }
            yield { type: 'reasoning-delta', index: chunk.index, text: rest }
            break
          }

          // 首次判定：够样本量才决定「翻」还是「不翻」。
          if (!decided.has(chunk.index)) {
            if (rest.length < PROBE_CHARS) {
              buffer.set(chunk.index, rest)
              break
            }
            decided.add(chunk.index)
            if (isAlreadyChinese(rest, config.cjkThreshold)) {
              buffer.delete(chunk.index)
              passthrough.add(chunk.index)
              bump('skipped')
              bump('blocks')
              if (config.verbose) {
                warnTo(config, `[reasoning-zh] reasoning 块 ${chunk.index} 采样判定（汉字占比 ${(cjkRatio(rest) * 100).toFixed(0)}%），跳过翻译`)
              }
              yield { type: 'reasoning-delta', index: chunk.index, text: rest }
              break
            }
          }

          // 翻译模式：累计够长（chunkThreshold）才开始分片，每攒满一片立刻并发发起。
          let tail = rest
          const accumulated = (existing?.sourceChars ?? 0) + tail.length
          const chunking = config.chunkThreshold > 0 && accumulated >= config.chunkThreshold
          while (chunking && tail.length >= config.maxChunkChars) {
            const [head, remainder] = splitChunk(tail, config.minChunkChars, config.maxChunkChars)
            if (head === null) break
            launch(chunk.index, head)
            tail = remainder
          }
          buffer.set(chunk.index, tail)
          break
        }

        case 'block-end': {
          const isReasoning = chunk.block.type === 'reasoning'
          const buffered = isReasoning ? buffer.get(chunk.index) : undefined
          buffer.delete(chunk.index)
          const job = jobs.get(chunk.index)

          // 没进分片模式：非 reasoning 块，或短到没触发判定的块。
          if (job === undefined) {
            if (buffered === undefined) {
              yield chunk
              break
            }
            if (isAlreadyChinese(buffered, config.cjkThreshold)) {
              bump('skipped')
              bump('blocks')
              if (config.verbose) {
                warnTo(config, `[reasoning-zh] reasoning 块 ${chunk.index} 已是中文（汉字占比 ${(cjkRatio(buffered) * 100).toFixed(0)}%），跳过翻译`)
              }
              yield { type: 'reasoning-delta', index: chunk.index, text: buffered }
              yield chunk
              break
            }
            // 短英文块：整块翻一次（与旧行为一致）。
            const shortJob = jobOf(chunk.index)
            const piece = launch(chunk.index, buffered)
            await piece.done
            yield* drain(chunk.index, true)
            const shortText = jobText(shortJob)
            bump('translated')
            bump('blocks')
            bump('pieces', shortJob.pieces.length)
            bump('sourceChars', shortJob.sourceChars)
            bump('targetChars', shortText.length)
            if (config.verbose) {
              warnTo(config, `[reasoning-zh] reasoning 块 ${chunk.index}：${shortJob.sourceChars} -> ${shortText.length} 字符（1 片）`)
            }
            yield { ...chunk, block: { type: 'reasoning', text: shortText } }
            break
          }

          // 分片模式：尾巴补成最后一片，等全部完成后再按顺序下发剩余片。
          if (buffered !== undefined && buffered.length > 0) launch(chunk.index, buffered)
          await Promise.all(job.pieces.map((piece) => piece.done))
          yield* drain(chunk.index, true)
          const text = jobText(job)
          bump('translated')
          bump('blocks')
          bump('pieces', job.pieces.length)
          bump('sourceChars', job.sourceChars)
          bump('targetChars', text.length)
          if (config.verbose) {
            warnTo(config, `[reasoning-zh] reasoning 块 ${chunk.index}：${job.sourceChars} -> ${text.length} 字符（${job.pieces.length} 片）`)
          }
          yield { ...chunk, block: { type: 'reasoning', text } }
          break
        }

        case 'finish': {
          // finish 之前必须清空缓冲与作业，否则该块内容会丢。
          yield* flushBuffer()
          for (const index of [...jobs.keys()]) yield* drain(index, true)
          yield chunk
          break
        }

        default:
          yield chunk
      }
    }
  } catch (error) {
    // 下游（适配器）抛错时也别丢内容：先补发缓冲与半成品，再把错误抛上去。
    yield* flushBuffer()
    for (const index of [...jobs.keys()]) yield* drain(index, true)
    throw error
  }

  // 正常结束但没见到 finish（协议异常）：同样补发。
  yield* flushBuffer()
  for (const index of [...jobs.keys()]) yield* drain(index, true)
}

/**
 * 本次翻译实际使用的指令：默认指令 + 用户的 `keepTerms` 词表。
 * @param config - 归一化配置。
 * @returns 完整指令文本。
 */
function translatePromptFor(config) {
  if (config.keepTerms.length === 0) return config.translatePrompt
  return `${config.translatePrompt}\n以下词汇必须原样保留，不要翻译：${config.keepTerms.join('、')}`
}

/**
 * 用辅助模型把一段 reasoning 翻成简体中文。
 * 返回 `{ kind: 'ok', text }` / `{ kind: 'cancelled' }` / `{ kind: 'failed' }`；
 * 调用方对非 ok 结果 fail-open 保留原文。
 * @param ctx - cordis 上下文。
 * @param config - 归一化配置。
 * @param text - 待翻译的完整 reasoning 文本。
 * @param signal - 主请求的取消信号。
 * @returns 翻译结果对象。
 */
async function translate(ctx, config, text, signal) {
  // 主请求在翻译真正开始前就被取消：不必再发一次辅助调用。
  if (signal?.aborted === true) return { kind: 'cancelled' }
  const controller = new AbortController()
  const onAbort = () => controller.abort(signal?.reason)
  signal?.addEventListener('abort', onAbort, { once: true })
  const timer = setTimeout(
    () => controller.abort(new Error('reasoning-zh: translation timed out')),
    config.timeoutMs,
  )

  // 注意：辅助调用的 options 必须是「最终对象」本身，先登记再 stream()，
  // 否则 WeakSet 里的身份与 waterfall 收到的不一致，防递归会失效。
  const options = {
    provider: config.translateProvider,
    model: config.translateModel,
    messages: [makeUserMessage(`${translatePromptFor(config)}\n\n${text}`, { kind: 'user' })],
    signal: controller.signal,
    ...(config.translateThinkingOff ? { reasoningEffort: 'off' } : {}),
  }
  AUX_CALLS.add(options)

  let out = ''
  let reasoningOut = ''
  try {
    for await (const chunk of ctx.llm.stream(options)) {
      if (chunk.type === 'text-delta') out += chunk.text
      else if (chunk.type === 'reasoning-delta') reasoningOut += chunk.text
      else if (chunk.type === 'finish' && chunk.reason.kind !== 'stop') {
        // 非正常结束（模型不存在、限流、截断…）也走 fail-open，并把原因说清楚。
        // 只有主请求真的被取消才算 cancelled；超时仍算失败，参与熔断。
        const cancelled = signal?.aborted === true
        if (config.verbose) {
          const code = chunk.reason.failure?.code
          warnTo(config, `[reasoning-zh] 翻译调用${cancelled ? '已取消' : '未正常结束'}（${chunk.reason.kind}${code === undefined ? '' : `:${code}`}），保留原文`)
        }
        return { kind: cancelled ? 'cancelled' : 'failed' }
      }
    }
  } catch (error) {
    const cancelled = signal?.aborted === true
    if (config.verbose) {
      warnTo(config, `[reasoning-zh] 翻译调用${cancelled ? '已取消' : '失败'}，保留原文：`, error?.message ?? error)
    }
    return { kind: cancelled ? 'cancelled' : 'failed' }
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }

  // 优先用最终回答块；思考模型可能把译文放进 reasoning，作为兜底。
  const trimmed = out.trim() || reasoningOut.trim()
  return trimmed.length > 0 ? { kind: 'ok', text: trimmed } : { kind: 'failed' }
}

/**
 * 翻译一片，失败时按 `retry` 做指数退避重试（取消不重试）。
 * @param ctx - cordis 上下文。
 * @param config - 归一化配置。
 * @param text - 这一片的原文。
 * @param signal - 主请求的取消信号。
 * @returns 翻译结果对象，额外带 `attempts`（实际尝试次数）。
 */
async function translateWithRetry(ctx, config, text, signal) {
  let attempts = 0
  for (;;) {
    attempts += 1
    const result = await translate(ctx, config, text, signal)
    if (result.kind !== 'failed' || attempts > config.retry || signal?.aborted === true) {
      return { ...result, attempts }
    }
    await delay(Math.min(2000, 200 * 2 ** (attempts - 1)), signal)
  }
}

/**
 * 可被 signal 打断的延时（等待重试）。
 * @param ms - 毫秒。
 * @param signal - 取消信号。
 * @returns 到点或被取消时 resolve。
 */
function delay(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted === true) {
      resolve()
      return
    }
    let timer
    const onAbort = () => {
      clearTimeout(timer)
      resolve()
    }
    timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * 简单的并发限制器。`max` 为 0 时不限制。
 * @param max - 最大并发数。
 * @returns `(task) => Promise`。
 */
function createLimiter(max) {
  if (!(max > 0)) return (task) => task()
  let active = 0
  const queue = []
  const pump = () => {
    while (active < max && queue.length > 0) {
      const { task, resolve, reject } = queue.shift()
      active += 1
      task().then(
        (value) => {
          active -= 1
          resolve(value)
          pump()
        },
        (error) => {
          active -= 1
          reject(error)
          pump()
        },
      )
    }
  }
  return (task) => new Promise((resolve, reject) => {
    queue.push({ task, resolve, reject })
    pump()
  })
}

// 供测试使用的最小内部导出（不属于公开 API）。
export const __internal = {
  makeUserMessage,
  normalize,
  rewriteReasoning,
  instructionText,
  translatePromptFor,
  cjkRatio,
  isAlreadyChinese,
  englishNaturalWords,
  normalizeForCompare,
  recordApply,
  snapshotServices,
  isMainSession,
  createBreaker,
  breakerOpen,
  recordTranslateOutcome,
  splitChunk,
  createStats,
  formatStatus,
  handleStatusCommand,
  readLogTail,
  registerStatusCommand,
  loadStatsFile,
  saveStatsFile,
  updateStatsFile,
  acquireStatsLock,
  flushStats,
  computeCumulative,
  zeroTotals,
  translateWithRetry,
  createLimiter,
  delay,
  STATS_FIELDS,
  PROBE_CHARS,
  DEFAULT_TRANSLATE_PROMPT,
}
