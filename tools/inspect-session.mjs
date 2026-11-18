#!/usr/bin/env node
/**
 * dsh-reasoning-zh 检验工具：直接读 session 日志，回答三个问题——
 *   ① 引导层：渲染后的系统提示词里有没有我们的语言指令段？
 *   ② 重申层：有没有 plugin=reasoning-zh 的 notice 消息？
 *   ③ 翻译/语言：思考块（reasoning）到底是不是中文？
 *
 * 用法：
 *   node tools/inspect-session.mjs                 # 自动取最近一个会话
 *   node tools/inspect-session.mjs <session 目录或 .zstd 文件>
 *   node tools/inspect-session.mjs --marker 思考语言 --plugin reasoning-zh --sample 3
 *
 * 注意：session 日志是「一次追加一帧」的串联 zstd，Node 的 zstd 解压 API 只读第一帧，
 * 所以这里按帧魔数切开逐帧解压。
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { zstdDecompressSync } from 'node:zlib'

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
/** 会话日志文件名：各表层版本不同（Web 用 v4，headless 用 v3），通吃。 */
const LOG_PATTERN = /^session\.v\d+\.jsonl\.zstd$/

/** 在一个会话目录里挑最新的日志文件。 */
function newestLogIn(dir) {
  const candidates = readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && LOG_PATTERN.test(entry.name))
    .map((entry) => ({ full: join(dir, entry.name), mtime: statSync(join(dir, entry.name)).mtimeMs }))
  if (candidates.length === 0) throw new Error(`${dir} 下没有 session.v*.jsonl.zstd`)
  return candidates.sort((a, b) => b.mtime - a.mtime)[0].full
}

/** 按 zstd 帧魔数切帧，逐帧解压后拼接。 */
function decodeSession(file) {
  const buf = readFileSync(file)
  const offsets = []
  for (let i = buf.indexOf(ZSTD_MAGIC); i !== -1; i = buf.indexOf(ZSTD_MAGIC, i + 4)) offsets.push(i)
  if (offsets.length === 0) return { text: '', frames: 0 }
  offsets.push(buf.length)
  const parts = []
  for (let i = 0; i < offsets.length - 1; i += 1) {
    try {
      parts.push(zstdDecompressSync(buf.subarray(offsets[i], offsets[i + 1])).toString('utf8'))
    } catch {
      // 极低概率的伪魔数，跳过
    }
  }
  return { text: parts.join(''), frames: offsets.length - 1 }
}

/** 找到目标会话文件；没给参数就取最近修改的那个。 */
function resolveSessionFile(target) {
  if (target !== undefined) {
    return statSync(target).isDirectory() ? newestLogIn(target) : target
  }
  // 与 DSH 一致：优先 DSH_HOME（沙箱/多实例场景常用），否则 ~/.dsh
  const root = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'sessions')
  const found = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (LOG_PATTERN.test(entry.name)) found.push({ full, mtime: statSync(full).mtimeMs })
    }
  }
  walk(root)
  if (found.length === 0) throw new Error(`在 ${root} 下没找到 session.v*.jsonl.zstd`)
  return found.sort((a, b) => b.mtime - a.mtime)[0].full
}

/** 统计一段文本的中英构成。 */
function languageOf(text) {
  const cjk = (text.match(/[\u3400-\u4dbf\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/g) ?? []).length
  const latin = (text.match(/[A-Za-z]/g) ?? []).length
  const total = cjk + latin
  const ratio = total === 0 ? 0 : cjk / total
  const label = total === 0 ? 'empty' : ratio >= 0.3 ? 'zh' : ratio <= 0.05 ? 'en' : 'mixed'
  return { cjk, latin, ratio, label }
}

/** 解析 CLI 参数。 */
function parseArgs(argv) {
  const options = { marker: '思考语言', plugin: 'reasoning-zh', sample: 3, target: undefined }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--marker') options.marker = argv[++i]
    else if (arg === '--plugin') options.plugin = argv[++i]
    else if (arg === '--sample') options.sample = Number(argv[++i])
    else if (!arg.startsWith('--')) options.target = arg
  }
  return options
}

const options = parseArgs(process.argv.slice(2))
const file = resolveSessionFile(options.target)
const { text, frames } = decodeSession(file)
const lines = text.split('\n').filter((line) => line.trim().length > 0)

const events = []
let unparsable = 0
for (const line of lines) {
  try {
    events.push(JSON.parse(line))
  } catch {
    unparsable += 1
  }
}

const typeCount = new Map()
for (const event of events) typeCount.set(event.type, (typeCount.get(event.type) ?? 0) + 1)

// ① 引导层：只看 system/message 里的渲染文本
const systemMessages = events.filter((event) => event.type === 'system/message')
const promptText = systemMessages
  .flatMap((event) => event.data?.message?.content ?? [])
  .filter((block) => block?.type === 'text')
  .map((block) => block.text)
  .join('\n')
const sectionHits = promptText.split(options.marker).length - 1

// ② 重申层：来源是插件的 user 消息
const pluginMessages = events.filter((event) => {
  const source = event.type === 'user/message' ? event.data?.source : undefined
  return source?.kind === 'plugin:' + options.plugin
})

// ③ 思考块的语种构成
const reasoningBlocks = events
  .filter((event) => event.type === 'assistant/message')
  .flatMap((event) => event.data?.message?.content ?? [])
  .filter((block) => block?.type === 'reasoning' && typeof block.text === 'string')
const stats = reasoningBlocks.map((block) => languageOf(block.text))
const zh = stats.filter((item) => item.label === 'zh').length
const en = stats.filter((item) => item.label === 'en').length
const mixed = stats.filter((item) => item.label === 'mixed').length
const totalChars = reasoningBlocks.reduce((sum, block) => sum + block.text.length, 0)

const pad = (label) => `${label}`.padEnd(34, ' ')
console.log(`会话文件   ${file}`)
console.log(`规模       ${frames} 个 zstd 帧 / ${events.length} 条事件 / ${(text.length / 1024).toFixed(0)} KB 文本`
  + (unparsable > 0 ? ` / ${unparsable} 行无法解析` : ''))
console.log(`事件类型   ${[...typeCount].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([k, v]) => `${k}:${v}`).join(' ')}`)
console.log('')
console.log(pad('① 系统提示词快照') + `${systemMessages.length} 条 system/message`)
console.log(pad(`   其中出现「${options.marker}」`) + `${sectionHits} 次  ${sectionHits > 0 ? '✅ 引导层已生效' : '❌ 引导层未生效（或未开启/未重启）'}`)
console.log(pad(`② plugin=${options.plugin} 的消息`) + `${pluginMessages.length} 条  ${pluginMessages.length > 0 ? '✅ 重申层已生效' : '❌ 重申层未生效'}`)
console.log(pad('③ 思考块') + `${reasoningBlocks.length} 块 / ${totalChars} 字符`)
console.log(pad('   中文主导 / 英文主导 / 混合') + `${zh} / ${en} / ${mixed}`
  + `  ${reasoningBlocks.length > 0 && zh / reasoningBlocks.length >= 0.8 ? '✅ 思考基本是中文' : '⚠️ 思考仍以英文为主'}`)

if (options.sample > 0 && reasoningBlocks.length > 0) {
  console.log('\n最近几个思考块的开头：')
  for (const block of reasoningBlocks.slice(-options.sample)) {
    const info = languageOf(block.text)
    console.log(`  [${info.label} cjk=${(info.ratio * 100).toFixed(0)}%] ${block.text.slice(0, 90).replace(/\n/g, ' ')}…`)
  }
}
