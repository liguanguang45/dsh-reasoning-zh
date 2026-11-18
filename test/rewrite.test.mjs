/**
 * dsh-reasoning-zh 冒烟测试：用假 ctx + 假流驱动插件，覆盖三层行为与流协议边界。
 * 运行：node --test test/   （不需要安装任何依赖）
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply, __internal } from '../lib/index.js'

const {
  makeUserMessage,
  normalize,
  splitChunk,
  createBreaker,
  breakerOpen,
  recordTranslateOutcome,
  createStats,
  zeroTotals,
  loadStatsFile,
  saveStatsFile,
  flushStats,
  computeCumulative,
  translatePromptFor,
  DEFAULT_TRANSLATE_PROMPT,
} = __internal

/**
 * 造一个够用的假 cordis 上下文：记录注册，模拟辅助翻译调用。
 * @param auxFinish - 辅助调用的结束原因（'stop' | 'error'）。
 * @param auxText - 辅助调用返回的译文。
 * @param aux - 可选回调 `(inputText, callIndex) => { text?, finish?, gate? }`，
 *   用于按片定制译文 / 用 gate 卡住某一片，验证流式与并发行为。
 * @param agents - 可选的 `agents.get(sessionId)` 返回值表，用于验证 translateScope。
 * @param commands - 覆盖 commands 服务；传 `null` 表示该服务不存在。
 */
function makeCtx({ auxFinish = 'stop', auxText = '中文译文', aux, agents, commands, auxKind = 'text' } = {}) {
  const state = { section: null, handlers: new Map(), auxCalls: 0, auxOptions: [], commands: [] }
  const services = {
    systemPrompt: { section() {} },
    llm: { async *stream() {} },
    agents: { get: (id) => agents?.[id] },
    commands: commands === null
      ? undefined
      : (commands ?? {
        register(definition) {
          state.commands.push(definition)
          return () => {}
        },
      }),
  }
  const ctx = {
    effect(fn) {
      return fn()
    },
    // cordis 的服务查找：诊断探针会用它判断服务在当前作用域是否可见
    get(name) {
      return services[name]
    },
    fiber: { entry: { id: 'reasoning-zh-test' } },
    systemPrompt: {
      section(section) {
        state.section = section
        return () => {}
      },
    },
    on(event, handler, options) {
      // 一个事件可以有多条监听（真实 cordis 如此）：按注册顺序保存，listener() 取第一条
      const list = state.handlers.get(event) ?? []
      list.push({ handler, options })
      state.handlers.set(event, list)
      return () => {}
    },
    llm: {
      async *stream(options) {
        state.auxCalls += 1
        const call = state.auxCalls
        state.auxOptions.push(options)
        const input = options.messages?.[0]?.content?.[0]?.text ?? ''
        const custom = aux?.(input, call)
        if (custom?.gate !== undefined) await custom.gate
        if (options.signal?.aborted === true) {
          yield { type: 'finish', reason: { kind: 'aborted', failure: { code: 'ABORTED', message: 'aborted' } } }
          return
        }
        yield {
          type: auxKind === 'reasoning' ? 'reasoning-delta' : 'text-delta',
          index: 0,
          text: custom?.text ?? auxText,
        }
        const finish = custom?.finish ?? auxFinish
        yield {
          type: 'finish',
          reason: finish === 'stop'
            ? { kind: 'stop' }
            : finish === 'aborted'
              ? { kind: 'aborted', failure: { code: 'ABORTED', message: 'aborted' } }
              : { kind: 'error', failure: { code: 'MOCK', message: 'mock failure' } },
        }
      },
    },
  }
  return { ctx, state, setCommands(service) { services.commands = service } }
}

/** 取出插件注册的某个监听器（同一事件多条监听时取最先注册的那条）。 */
function listener(state, event) {
  const list = state.handlers.get(event)
  assert.ok(list && list.length > 0, `插件应当注册 ${event} 监听器`)
  return list[0]
}

/** 取出挂在 agent 作用域上的 pre-step 处理器。 */
function preStepOf(state) {
  const created = listener(state, 'agent/created')
  let registration
  created.handler({
    agent: {
      ctx: {
        on(event, handler, options) {
          registration = { event, handler, options }
          return () => {}
        },
      },
    },
  })
  assert.equal(registration.event, 'agent/pre-step')
  return registration
}

async function collect(iterable) {
  const out = []
  for await (const chunk of iterable) out.push(chunk)
  return out
}

function userFixture(id = 'm1') {
  return { id, role: 'user', content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }
}

/** 一段带 reasoning 块 + text 块的完整请求流。 */
function mainSource() {
  return [
    { type: 'block-start', index: 0, blockType: 'reasoning' },
    { type: 'reasoning-delta', index: 0, text: 'Let me ' },
    { type: 'reasoning-delta', index: 0, text: 'think.' },
    { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'Let me think.' } },
    { type: 'block-start', index: 1, blockType: 'text' },
    { type: 'text-delta', index: 1, text: 'Hello' },
    { type: 'block-end', index: 1, block: { type: 'text', text: 'Hello' } },
    { type: 'usage', usage: { inputTokens: 1, outputTokens: 2 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

/**
 * 跑一次 llm/stream 监听器。
 * @param config - 插件配置（自动带上 translate: true）。
 * @param source - 上游块序列（数组或异步生成器函数）。
 * @param ctxOptions - 传给 makeCtx 的选项。
 * @param requestOptions - 覆盖模型请求字段（如 sessionId）。
 */
async function runStream(config, source, ctxOptions, requestOptions) {
  const { ctx, state } = makeCtx(ctxOptions)
  apply(ctx, { translate: true, ...config })
  const entry = listener(state, 'llm/stream')
  assert.equal(entry.options.global, true)
  const options = {
    provider: 'p',
    model: 'm',
    messages: [],
    signal: new AbortController().signal,
    ...requestOptions,
  }
  const upstream = typeof source === 'function'
    ? source()
    : (async function* () { yield* source })()
  const out = await collect(entry.handler(options, () => upstream))
  return { out, state }
}

test('① 引导层：默认注册 order 10 的中文思考提示词段', () => {
  const { ctx, state } = makeCtx()
  apply(ctx, {})
  assert.ok(state.section, '应当注册提示词段')
  assert.equal(state.section.name, 'reasoning-zh:language')
  assert.equal(state.section.order, 10)
  assert.match(state.section.text, /简体中文/)
  assert.match(state.section.text, /最终回答同样使用简体中文/)
})

test('① steerAnswer:false 时不要求回答用中文；steering:off 完全不注册', () => {
  const a = makeCtx()
  apply(a.ctx, { steerAnswer: false })
  assert.doesNotMatch(a.state.section.text, /最终回答/)

  const b = makeCtx()
  apply(b.ctx, { steering: 'off' })
  assert.equal(b.state.section, null)
  assert.equal(b.state.handlers.size, 0, 'off 时不应注册任何监听器')
})

test('② 重申层：默认只在 step 1 追加提醒，且提醒是 plugin/notice 消息', async () => {
  const { ctx, state } = makeCtx()
  apply(ctx, {})
  const { handler } = preStepOf(state)
  const signal = new AbortController().signal

  const first = await handler(
    { messages: [userFixture()], signal, step: 1 },
    async () => ({ kind: 'enter', messages: [userFixture()] }),
  )
  assert.equal(first.messages.length, 2, 'step 1 应追加一条提醒')
  const reminder = first.messages[1]
  assert.equal(reminder.role, 'user')
  assert.equal(reminder.source.kind, 'plugin:reasoning-zh')
  assert.equal(reminder.source.form, 'notice')
  assert.match(reminder.content[0].text, /^<system-reminder>/)
  assert.ok(Object.isFrozen(reminder), '消息必须冻结')
  assert.match(reminder.id, /^[0-9a-f-]{36}$/, '消息 id 应为 randomUUID')

  const second = await handler(
    { messages: [], signal, step: 2 },
    async () => ({ kind: 'enter', messages: [userFixture('m2')] }),
  )
  assert.equal(second.messages.length, 1, 'step 2 默认不再追加')
})

test('② remindOn:every 每步都追加；被跳过的空步不追加', async () => {
  const { ctx, state } = makeCtx()
  apply(ctx, { remindOn: 'every' })
  const { handler } = preStepOf(state)
  const signal = new AbortController().signal

  const step2 = await handler(
    { messages: [], signal, step: 2 },
    async () => ({ kind: 'enter', messages: [userFixture('m3')] }),
  )
  assert.equal(step2.messages.length, 2, 'every 模式下 step 2 也要追加')

  const skipped = await handler(
    { messages: [], signal, step: 1 },
    async () => ({ kind: 'enter', messages: [] }),
  )
  assert.equal(skipped.messages.length, 0, '循环会跳过的空首步不应被塞消息')
})

test('③ 翻译层：整块替换 reasoning，text/usage/finish 原样通过', async () => {
  const { out, state } = await runStream({}, mainSource())
  assert.equal(state.auxCalls, 1, '每个 reasoning 块一次辅助调用')

  const types = out.map((chunk) => chunk.type)
  assert.deepEqual(types, [
    'block-start',
    'reasoning-delta',
    'block-end',
    'block-start',
    'text-delta',
    'block-end',
    'usage',
    'finish',
  ])

  const reasoningDeltas = out.filter((chunk) => chunk.type === 'reasoning-delta')
  assert.equal(reasoningDeltas.length, 1, '两条英文 delta 应合并成一条中文 delta')
  assert.equal(reasoningDeltas[0].text, '中文译文')

  const reasoningEnd = out.find((chunk) => chunk.type === 'block-end' && chunk.block.type === 'reasoning')
  assert.equal(reasoningEnd.block.text, '中文译文', 'block-end 的块文本必须与 delta 一致')

  const textEnd = out.find((chunk) => chunk.type === 'block-end' && chunk.block.type === 'text')
  assert.equal(textEnd.block.text, 'Hello', '最终回答绝不被翻译层改写')

  assert.equal(out.at(-1).type, 'finish', '必须以 finish 收尾')
  assert.equal(out.filter((chunk) => chunk.type === 'usage').length, 1)
})

test('③ fail-open：辅助调用非正常结束 → 保留原文且协议完整', async () => {
  const { out, state } = await runStream({}, mainSource(), { auxFinish: 'error' })
  assert.equal(state.auxCalls, 1)
  const reasoningDeltas = out.filter((chunk) => chunk.type === 'reasoning-delta')
  assert.equal(reasoningDeltas.length, 1)
  assert.equal(reasoningDeltas[0].text, 'Let me think.', '失败时补发原文，不能丢内容')
  const reasoningEnd = out.find((chunk) => chunk.type === 'block-end' && chunk.block.type === 'reasoning')
  assert.equal(reasoningEnd.block.text, 'Let me think.')
  assert.equal(out.at(-1).type, 'finish')
})

test('③ 超长块：不调用辅助模型，原文实时透传', async () => {
  const { out, state } = await runStream({ maxCharsPerBlock: 5 }, mainSource())
  assert.equal(state.auxCalls, 0)
  const reasoningDeltas = out.filter((chunk) => chunk.type === 'reasoning-delta')
  assert.deepEqual(reasoningDeltas.map((chunk) => chunk.text), ['Let me ', 'think.'])
  const reasoningEnd = out.find((chunk) => chunk.type === 'block-end' && chunk.block.type === 'reasoning')
  assert.equal(reasoningEnd.block.text, 'Let me think.')
})

test('③ 附带调用（purpose）直通，不触发翻译', async () => {
  const { ctx, state } = makeCtx()
  apply(ctx, { translate: true })
  const entry = listener(state, 'llm/stream')
  const options = { provider: 'p', model: 'm', messages: [], purpose: 'session-title' }
  const out = await collect(entry.handler(options, () => (async function* () { yield* mainSource() })()))
  assert.equal(state.auxCalls, 0)
  assert.equal(out.filter((chunk) => chunk.type === 'reasoning-delta').length, 2, '原始 delta 数量不变')
})

test('③ 流在 finish 之前断掉：缓冲内容仍被补发', async () => {
  const source = [
    { type: 'block-start', index: 0, blockType: 'reasoning' },
    { type: 'reasoning-delta', index: 0, text: 'abc' },
    { type: 'reasoning-delta', index: 0, text: 'def' },
  ]
  const { out, state } = await runStream({}, source)
  assert.equal(state.auxCalls, 0, '没有 block-end 就不翻译')
  const reasoningDeltas = out.filter((chunk) => chunk.type === 'reasoning-delta')
  assert.equal(reasoningDeltas.length, 1)
  assert.equal(reasoningDeltas[0].text, 'abcdef', '断流也不能丢思考内容')
})

test('配置校验：非法值直接抛错，不静默回退', () => {
  assert.throws(() => normalize({ steering: 'sometimes' }), /steering/)
  assert.throws(() => normalize({ remindOn: 'never' }), /remindOn/)
  assert.throws(() => normalize({ maxCharsPerBlock: 0 }), /maxCharsPerBlock/)
  assert.throws(() => normalize({ translate: 'yes' }), /translate/)
  assert.throws(() => normalize({ translateModel: '' }), /translateModel/)
  assert.throws(() => normalize({ cjkThreshold: 2 }), /cjkThreshold/)
  assert.throws(() => normalize({ cjkThreshold: -0.1 }), /cjkThreshold/)
  assert.deepEqual(normalize(undefined).steering, 'both')
  assert.equal(normalize(undefined).cjkThreshold, 0.3)
})

// —— cjkThreshold：已是中文就别再翻一遍（实测出现过 218 -> 218 字符的纯浪费）——

const { cjkRatio, isAlreadyChinese, PROBE_CHARS } = __internal

test('语言判定：汉字占比与假名否决', () => {
  assert.equal(cjkRatio('中文abc'), 2 / 5)
  assert.equal(cjkRatio('123 !?'), 1, '无字母无汉字视为无需翻译')
  assert.equal(isAlreadyChinese('这是一段中文思考', 0.3), true)
  assert.equal(isAlreadyChinese('Let me think about it', 0.3), false)
  assert.equal(isAlreadyChinese('这是一段中文思考', 0), false, '阈值 0 = 从不跳过')
  assert.equal(isAlreadyChinese('これはテストです', 0.3), false, '有假名当日文处理')
  assert.equal(isAlreadyChinese('日本語のテスト', 0.3), false)
})

test('③ 长中文块：采样后立刻放行、不翻译、不再等整块', async () => {
  const chinese = '这是一段中文思考内容，'.repeat(12) // 132 字符 > PROBE_CHARS
  const source = [
    { type: 'block-start', index: 0, blockType: 'reasoning' },
    { type: 'reasoning-delta', index: 0, text: chinese.slice(0, 60) },
    { type: 'reasoning-delta', index: 0, text: chinese.slice(60) },
    { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } },
    { type: 'block-end', index: 0, block: { type: 'reasoning', text: chinese } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
  const { out, state } = await runStream({}, source)
  assert.equal(state.auxCalls, 0, '已经是中文就不该发翻译请求')

  const deltaAt = out.findIndex((chunk) => chunk.type === 'reasoning-delta')
  const usageAt = out.findIndex((chunk) => chunk.type === 'usage')
  assert.ok(deltaAt !== -1 && deltaAt < usageAt, '应当在攒够采样长度时就放行，而不是等到 block-end')
  assert.equal(out[deltaAt].text, chinese, '放行的是完整缓冲内容，不能丢字')

  const reasoningEnd = out.find((chunk) => chunk.type === 'block-end' && chunk.block.type === 'reasoning')
  assert.equal(reasoningEnd.block.text, chinese)
  assert.equal(out.at(-1).type, 'finish')
})

test('③ 短中文块：block-end 判定后原样补发，不翻译', async () => {
  const chinese = '简短的中文思考。'
  const source = [
    { type: 'block-start', index: 0, blockType: 'reasoning' },
    { type: 'reasoning-delta', index: 0, text: chinese },
    { type: 'block-end', index: 0, block: { type: 'reasoning', text: chinese } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
  const { out, state } = await runStream({}, source)
  assert.equal(state.auxCalls, 0)
  const reasoningDeltas = out.filter((chunk) => chunk.type === 'reasoning-delta')
  assert.equal(reasoningDeltas.length, 1)
  assert.equal(reasoningDeltas[0].text, chinese)
})

test('③ cjkThreshold: 0 → 中文块也照翻（保留旧行为）', async () => {
  const chinese = '简短的中文思考。'
  const source = [
    { type: 'block-start', index: 0, blockType: 'reasoning' },
    { type: 'reasoning-delta', index: 0, text: chinese },
    { type: 'block-end', index: 0, block: { type: 'reasoning', text: chinese } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
  const { out, state } = await runStream({ cjkThreshold: 0 }, source)
  assert.equal(state.auxCalls, 1, '阈值 0 表示从不跳过')
  assert.equal(out.find((chunk) => chunk.type === 'reasoning-delta').text, '中文译文')
})

test('③ 含假名的块不被跳过，仍然翻译', async () => {
  const japanese = 'これはテストです。日本語で考えています。'
  const source = [
    { type: 'block-start', index: 0, blockType: 'reasoning' },
    { type: 'reasoning-delta', index: 0, text: japanese },
    { type: 'block-end', index: 0, block: { type: 'reasoning', text: japanese } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
  const { out, state } = await runStream({}, source)
  assert.equal(state.auxCalls, 1)
  assert.equal(out.find((chunk) => chunk.type === 'reasoning-delta').text, '中文译文')
})

test('消息构造：本地兜底实现与官方语义一致（uuid + 深冻结）', () => {
  const msg = makeUserMessage('x', { kind: 'user' })
  assert.equal(msg.role, 'user')
  assert.deepEqual(msg.content, [{ type: 'text', text: 'x' }])
  assert.ok(Object.isFrozen(msg))
  assert.ok(Object.isFrozen(msg.content))
  assert.ok(Object.isFrozen(msg.content[0]))
  assert.notEqual(msg.id, makeUserMessage('x', { kind: 'user' }).id)
})

// —— 自诊断探针：回答「插件到底有没有被加载」——

test('诊断探针：apply 每次调用写 start/done 两行，含服务可见性与注册结果', () => {
  const dir = mkdtempSync(join(tmpdir(), 'reasoning-zh-'))
  const file = join(dir, 'apply.jsonl')
  const { ctx } = makeCtx()
  apply(ctx, { diagnostics: true, diagnosticsFile: file, translate: true })

  const lines = readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
  assert.equal(lines.length, 2)
  assert.equal(lines[0].phase, 'start')
  assert.equal(lines[1].phase, 'done')
  assert.equal(lines[0].services.systemPrompt, 'object', '服务可见性要落盘')
  assert.equal(lines[0].services.llm, 'object')
  assert.equal(lines[0].services.agents, 'object')
  assert.equal(lines[0].services.loader, 'undefined')
  assert.equal(lines[0].entry, 'reasoning-zh-test')
  assert.equal(lines[1].sectionRegistered, true)
  assert.equal(lines[1].reminderRegistered, true)
  assert.equal(lines[1].translateRegistered, true)
  assert.equal(lines[1].error, null)
  rmSync(dir, { recursive: true, force: true })
})

test('诊断探针：默认关闭不写文件；开启却没给路径时配置校验报错', () => {
  const dir = mkdtempSync(join(tmpdir(), 'reasoning-zh-'))
  const file = join(dir, 'apply.jsonl')
  const { ctx } = makeCtx()
  apply(ctx, { diagnosticsFile: file }) // diagnostics 默认 false
  assert.equal(existsSync(file), false)
  assert.throws(() => normalize({ diagnostics: true }), /diagnosticsFile/)
  assert.throws(() => normalize({ diagnostics: 'yes' }), /diagnostics/)
  assert.throws(() => normalize({ diagnosticsFile: 42 }), /diagnosticsFile/)
  rmSync(dir, { recursive: true, force: true })
})

test('诊断探针：段落注册失败只记录原因，不让插件整体抛错（避免宿主启动失败）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'reasoning-zh-'))
  const file = join(dir, 'apply.jsonl')
  const { ctx } = makeCtx()
  ctx.systemPrompt.section = () => {
    throw new Error('boom: systemPrompt unavailable')
  }
  assert.doesNotThrow(() => apply(ctx, { diagnostics: true, diagnosticsFile: file }))
  const lines = readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
  assert.equal(lines.at(-1).sectionRegistered, false)
  assert.match(lines.at(-1).error, /boom/)
  rmSync(dir, { recursive: true, force: true })
})

// ───────────────────────── #1 分片并发 + 译文流式 ─────────────────────────

/** 一段足够长的英文思考（约 1560 字符）。 */
const ENGLISH_LONG = 'Alpha beta gamma delta. '.repeat(60)

/** 单块长文本的上游流。 */
function longSource(text) {
  return [
    { type: 'block-start', index: 0, blockType: 'reasoning' },
    { type: 'reasoning-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'reasoning', text } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

/** 从辅助调用的 options 里取回这一片的原文（剥掉翻译指令前缀）。 */
function pieceTextOf(auxOption) {
  const full = auxOption.messages[0].content[0].text
  const at = full.indexOf('\n\n')
  return at === -1 ? full : full.slice(at + 2)
}

test('#1 长英文块分片并发：片序正确、不丢字、block-end 与 delta 拼接一致', async () => {
  const { out, state } = await runStream(
    { chunkThreshold: 300, minChunkChars: 50, maxChunkChars: 200 },
    longSource(ENGLISH_LONG),
  )

  assert.ok(state.auxCalls >= 5, `应当切成多片并发翻译（实际 ${state.auxCalls} 次）`)
  const pieces = state.auxOptions.map(pieceTextOf)
  assert.equal(pieces.join(''), ENGLISH_LONG, '切片必须无损且保序')

  const deltas = out.filter((chunk) => chunk.type === 'reasoning-delta')
  assert.equal(deltas.length, state.auxCalls, '每片对应一条 delta')
  const blockEnd = out.find((chunk) => chunk.type === 'block-end' && chunk.block.type === 'reasoning')
  assert.equal(deltas.map((chunk) => chunk.text).join(''), blockEnd.block.text, 'block-end 必须等于所有 delta 拼接')
  assert.equal(out.at(-1).type, 'finish')
})

test('#1 短块不分片：整块翻一次（chunkThreshold 生效）', async () => {
  const text = 'Alpha beta gamma. '.repeat(6) // 108 字符
  const { state } = await runStream(
    { chunkThreshold: 1000, minChunkChars: 50, maxChunkChars: 200 },
    longSource(text),
  )
  assert.equal(state.auxCalls, 1, '低于 chunkThreshold 应整块翻一次')
})

test('#1 chunkThreshold: 0 = 永不分片', async () => {
  const { state } = await runStream(
    { chunkThreshold: 0, minChunkChars: 50, maxChunkChars: 200 },
    longSource(ENGLISH_LONG),
  )
  assert.equal(state.auxCalls, 1)
})

test('#1 译文流式：片译完即下发，不等 block-end', async () => {
  const source = async function* stream() {
    yield { type: 'block-start', index: 0, blockType: 'reasoning' }
    yield { type: 'reasoning-delta', index: 0, text: ENGLISH_LONG }
    await new Promise((resolve) => setTimeout(resolve, 5)) // 让已发起的翻译 settle
    yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
    yield { type: 'block-end', index: 0, block: { type: 'reasoning', text: ENGLISH_LONG } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
  const chunked = { chunkThreshold: 300, minChunkChars: 50, maxChunkChars: 200 }

  const on = await runStream({ ...chunked, streamTranslated: true }, source)
  const onDelta = on.out.findIndex((chunk) => chunk.type === 'reasoning-delta')
  const onUsage = on.out.findIndex((chunk) => chunk.type === 'usage')
  assert.ok(onDelta !== -1 && onDelta < onUsage, '开启流式时第一片应在 usage 之前就下发')

  const off = await runStream({ ...chunked, streamTranslated: false }, source)
  const offDelta = off.out.findIndex((chunk) => chunk.type === 'reasoning-delta')
  const offUsage = off.out.findIndex((chunk) => chunk.type === 'usage')
  assert.ok(offDelta > offUsage, '关闭流式时不应提前下发')
})

test('#1 splitChunk：优先段落/句末边界，无边界时硬切，始终无损', () => {
  assert.deepEqual(splitChunk('short', 10, 100), [null, 'short'])

  const para = `${'a'.repeat(60)}\n\n${'b'.repeat(60)}\n\n${'c'.repeat(60)}`
  const [head, tail] = splitChunk(para, 20, 100)
  assert.ok(head.endsWith('\n\n'), `应切在段落边界上，实际结尾 ${JSON.stringify(head.slice(-4))}`)
  assert.equal(head + tail, para, '切片无损')

  const noBoundary = 'x'.repeat(500)
  const [h2, t2] = splitChunk(noBoundary, 20, 100)
  assert.equal(h2.length, 100, '无自然边界时硬切 max')
  assert.equal(h2 + t2, noBoundary)
})

// ───────────────────────── #2 translateScope ─────────────────────────

test('#2 translateScope: main 跳过子代理会话，all 与未知会话不受影响', async () => {
  const agents = {
    root: {},
    child: { parentAgent: { id: 'root' } },
    deep: { session: { header: { delegationDepth: 2 } } },
  }
  const child = await runStream({ translateScope: 'main' }, mainSource(), { agents }, { sessionId: 'child' })
  assert.equal(child.state.auxCalls, 0, '子代理会话不应触发翻译')
  assert.equal(
    child.out.filter((chunk) => chunk.type === 'reasoning-delta').map((chunk) => chunk.text).join(''),
    'Let me think.',
    '跳过时原文必须原样透传',
  )

  const all = await runStream({ translateScope: 'all' }, mainSource(), { agents }, { sessionId: 'child' })
  assert.equal(all.state.auxCalls, 1, 'translateScope: all 时应照翻')

  const root = await runStream({ translateScope: 'main' }, mainSource(), { agents }, { sessionId: 'root' })
  assert.equal(root.state.auxCalls, 1, '主会话应照翻')

  const deep = await runStream({ translateScope: 'main' }, mainSource(), { agents }, { sessionId: 'deep' })
  assert.equal(deep.state.auxCalls, 0, 'delegationDepth > 0 视为子会话')

  const unknown = await runStream({ translateScope: 'main' }, mainSource(), { agents }, { sessionId: 'nope' })
  assert.equal(unknown.state.auxCalls, 1, '查不到 agent 时按主会话保守处理')
})

// ───────────────────────── #3 熔断 ─────────────────────────

test('#3 熔断：连续失败后进入冷却，期间整条流直通不再调用', async () => {
  const config = { breakerFailures: 2, breakerCooldownMs: 60000 }
  const pack = makeCtx({ auxFinish: 'error' })
  apply(pack.ctx, { translate: true, ...config })
  const entry = listener(pack.state, 'llm/stream')
  const options = { provider: 'p', model: 'm', messages: [], signal: new AbortController().signal }
  const run = async () => collect(entry.handler(options, () => (async function* () { yield* mainSource() })()))

  await run()
  assert.equal(pack.state.auxCalls, 1, '第一次失败：发起过 1 次翻译')
  await run()
  assert.equal(pack.state.auxCalls, 2, '第二次失败：累计到阈值，熔断打开')

  const third = await run()
  assert.equal(pack.state.auxCalls, 2, '熔断期内不应再发起翻译（fail-fast）')
  const deltas = third.filter((chunk) => chunk.type === 'reasoning-delta')
  assert.equal(deltas.map((chunk) => chunk.text).join(''), 'Let me think.', '熔断时原文照旧，不丢内容')
  assert.equal(third.at(-1).type, 'finish')
})

test('#3 熔断器语义：阈值、冷却、成功后复位', () => {
  const config = normalize({ breakerFailures: 2, breakerCooldownMs: 1000 })
  const state = { breaker: createBreaker() }

  assert.equal(breakerOpen(state, config), false, '初始不熔断')
  recordTranslateOutcome(state, config, false)
  assert.equal(breakerOpen(state, config), false, '未达阈值不熔断')
  recordTranslateOutcome(state, config, false)
  assert.equal(breakerOpen(state, config), true, '达到阈值即熔断')
  assert.equal(state.breaker.tripped, 1)

  assert.equal(breakerOpen(state, config, Date.now() + config.breakerCooldownMs + 50), false, '冷却结束后恢复')
  assert.equal(state.breaker.failures, 0)

  recordTranslateOutcome(state, config, false)
  recordTranslateOutcome(state, config, true)
  assert.equal(state.breaker.failures, 0, '成功应清零连续失败计数')

  // breakerFailures: 0 = 关闭熔断
  const off = normalize({ breakerFailures: 0 })
  const offState = { breaker: createBreaker() }
  for (let i = 0; i < 10; i += 1) recordTranslateOutcome(offState, off, false)
  assert.equal(breakerOpen(offState, off), false, '关闭熔断时永不打开')
})

// ───────────────────────── 新配置校验 ─────────────────────────

test('配置校验：#1/#2/#3 新增项', () => {
  assert.throws(() => normalize({ translateScope: 'nope' }), /translateScope/)
  assert.throws(() => normalize({ chunkThreshold: -1 }), /chunkThreshold/)
  assert.throws(() => normalize({ minChunkChars: 0 }), /minChunkChars/)
  assert.throws(() => normalize({ maxChunkChars: 10, minChunkChars: 100 }), /maxChunkChars/)
  assert.throws(() => normalize({ streamTranslated: 'yes' }), /streamTranslated/)
  assert.throws(() => normalize({ breakerFailures: -1 }), /breakerFailures/)
  assert.throws(() => normalize({ breakerCooldownMs: -5 }), /breakerCooldownMs/)

  const defaults = normalize(undefined)
  assert.equal(defaults.translateScope, 'main')
  assert.equal(defaults.chunkThreshold, 1000)
  assert.equal(defaults.maxChunkChars, 800)
  assert.equal(defaults.streamTranslated, true)
  assert.equal(defaults.breakerFailures, 3)
})

// ───────────────────────── verboseFile 落盘 ─────────────────────────

/** 静音 console.warn，避免测试输出被诊断刷屏（异步函数也要 await，否则静音提前失效）。 */
async function withSilentWarn(fn) {
  const original = console.warn
  console.warn = () => {}
  try {
    return await fn()
  } finally {
    console.warn = original
  }
}

/** 一个短中文块的上游流（必然触发「已是中文，跳过翻译」这条诊断）。 */
function shortChineseSource() {
  const text = '简短的中文思考。'
  return [
    { type: 'block-start', index: 0, blockType: 'reasoning' },
    { type: 'reasoning-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'reasoning', text } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

test('verboseFile：verbose 开启时诊断同时落盘（自动建目录、带 ISO 时间戳）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'reasoning-zh-'))
  const file = join(dir, 'logs', 'verbose.log') // 目录故意不存在，验证会自动创建
  try {
    await withSilentWarn(() => runStream({ verbose: true, verboseFile: file }, shortChineseSource()))
    assert.ok(existsSync(file), 'verboseFile 应被创建（连目录一起）')
    const text = readFileSync(file, 'utf8')
    assert.match(text, /\[reasoning-zh\]/)
    assert.match(text, /跳过翻译/)
    assert.match(text, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/, '每行应带 ISO 时间戳')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('verboseFile：verbose 关闭时不落盘', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'reasoning-zh-'))
  const file = join(dir, 'verbose.log')
  try {
    await withSilentWarn(() => runStream({ verbose: false, verboseFile: file }, shortChineseSource()))
    assert.equal(existsSync(file), false, 'verbose 关闭时不应写文件')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('verboseFile：超过上限时轮转为 .1', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'reasoning-zh-'))
  const file = join(dir, 'verbose.log')
  const config = { verbose: true, verboseFile: file, verboseFileMaxBytes: 1 }
  try {
    await withSilentWarn(async () => {
      await runStream(config, mainSource())
      assert.ok(existsSync(file), '第一次写应生成文件')
      await runStream(config, mainSource())
    })
    assert.ok(existsSync(`${file}.1`), '超过上限后应轮转为 .1')
    assert.match(readFileSync(file, 'utf8'), /\[reasoning-zh\]/, '轮转后新文件继续写入')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('配置校验：verboseFile / verboseFileMaxBytes', () => {
  assert.throws(() => normalize({ verboseFile: 42 }), /verboseFile/)
  assert.throws(() => normalize({ verboseFileMaxBytes: 0 }), /verboseFileMaxBytes/)
  assert.equal(normalize(undefined).verboseFile, '')
  assert.equal(normalize(undefined).verboseFileMaxBytes, 1000000)
})

// ───────────────────────── 2b 斜杠命令与运行统计 ─────────────────────────

/** 在已经 apply 过的 pack 上跑一次上游流。 */
async function runOn(pack, source) {
  const entry = listener(pack.state, 'llm/stream')
  const options = { provider: 'p', model: 'm', messages: [], signal: new AbortController().signal }
  return collect(entry.handler(options, () => (async function* () { yield* source })()))
}

test('2b 命令：/reasoning-zh 显示三层状态与本进程统计，支持 reset 与 log', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'reasoning-zh-'))
  const logFile = join(dir, 'v.log')
  try {
    const pack = makeCtx()
    apply(pack.ctx, { translate: true, verbose: true, verboseFile: logFile })
    assert.equal(pack.state.commands.length, 1, '应注册一条命令')
    const definition = pack.state.commands[0]
    assert.equal(definition.name, 'reasoning-zh')
    assert.equal(typeof definition.handler, 'function')

    // 制造统计：一次翻译（短英文块）+ 一次跳过（短中文块）
    await withSilentWarn(() => runOn(pack, mainSource()))
    await withSilentWarn(() => runOn(pack, shortChineseSource()))

    const status = await definition.handler({ rawInput: '' })
    assert.equal(status.kind, 'success')
    assert.match(status.text, /\*\*dsh-reasoning-zh\*\* v\d+\.\d+\.\d+/, '应显示真实版本号')
    assert.match(status.text, /引导层（系统提示词段） \| ✅/)
    assert.match(status.text, /处理思考块 \| 2（翻译 1 \/ 跳过 1）/)
    assert.match(status.text, /翻译片数 \| 1/)
    assert.match(status.text, /估算省下的模型调用 \| ≈ 1 次/)

    const log = await definition.handler({ rawInput: 'log 5' })
    assert.equal(log.kind, 'success')
    assert.match(log.text, /\[reasoning-zh\]/)

    const reset = await definition.handler({ rawInput: 'reset' })
    assert.equal(reset.kind, 'success')
    const after = await definition.handler({ rawInput: '' })
    assert.match(after.text, /处理思考块 \| 0（翻译 0 \/ 跳过 0）/)
    assert.match(after.text, /\*\*dsh-reasoning-zh\*\*/, 'reset 不应清掉加载信息')

    const bad = await definition.handler({ rawInput: 'nope' })
    assert.equal(bad.kind, 'error')
    assert.match(bad.text, /用法/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('2b 命令：commands 服务缺失时三层照常注册，只标记命令不可用', () => {
  const pack = makeCtx({ commands: null })
  assert.doesNotThrow(() => apply(pack.ctx, { translate: true }))
  assert.equal(pack.state.commands.length, 0)
  assert.ok(pack.state.section, '引导层照常注册')
  assert.ok(pack.state.handlers.get('agent/created'), '重申层照常注册')
  assert.ok(pack.state.handlers.get('llm/stream'), '翻译层照常注册')
})

test('2b 命令：未配置 verboseFile 时 log 给出提示', async () => {
  const pack = makeCtx()
  apply(pack.ctx, { translate: true })
  const log = await pack.state.commands[0].handler({ rawInput: 'log' })
  assert.equal(log.kind, 'success')
  assert.match(log.text, /未配置/)
})

test('2b 统计：翻译失败与熔断会累计到统计里', async () => {
  const pack = makeCtx({ auxFinish: 'error' })
  apply(pack.ctx, { translate: true, breakerFailures: 2, breakerCooldownMs: 60000 })
  await runOn(pack, mainSource())
  await runOn(pack, mainSource())
  const status = await pack.state.commands[0].handler({ rawInput: '' })
  assert.match(status.text, /翻译片数 \| 2（失败 2/)
  assert.match(status.text, /熔断 \| 1 次（当前冷却中）/)
})

test('2b 命令：服务晚到时（bundle include 层场景）走 ctx.inject 完成注册', () => {
  const pack = makeCtx({ commands: null }) // 复现桌面壳：apply 时 commands 还不存在
  let injectCallback
  pack.ctx.inject = (deps, callback) => {
    injectCallback = callback
    return { dispose() {} }
  }
  apply(pack.ctx, { translate: true })
  assert.equal(pack.state.commands.length, 0, '服务不可见时先不注册')
  assert.equal(typeof injectCallback, 'function', '应通过 ctx.inject 等待服务就绪')

  // 服务就绪 → cordis 触发注入回调
  pack.setCommands({ register(definition) { pack.state.commands.push(definition); return () => {} } })
  injectCallback(pack.ctx)

  assert.equal(pack.state.commands.length, 1, '服务就绪后应完成注册')
  assert.equal(pack.state.commands[0].name, 'reasoning-zh')
})

test('2b 命令：agent/created 兜底路径也能注册，且幂等', () => {
  const pack = makeCtx({ commands: null })
  apply(pack.ctx, { translate: true })
  assert.equal(pack.state.commands.length, 0)

  pack.setCommands({ register(definition) { pack.state.commands.push(definition); return () => {} } })
  const created = pack.state.handlers.get('agent/created')
  assert.ok(created && created.length >= 1, '应立即注册失败时挂上兜底监听')
  const agent = { session: { id: 's1' }, ctx: { on() { return () => {} } } }

  for (const entry of created) entry.handler({ agent })
  assert.equal(pack.state.commands.length, 1, '兜底路径应完成注册')
  for (const entry of created) entry.handler({ agent: { session: { id: 's2' }, ctx: { on() { return () => {} } } } })
  assert.equal(pack.state.commands.length, 1, '重复触发不应重复注册（幂等）')
})

// ───────────────────────── 累计统计持久化 ─────────────────────────

test('统计文件：读写往返、损坏容错、原子写不留临时文件', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rz-stats-'))
  const file = join(dir, 'stats.json')
  try {
    assert.equal(loadStatsFile(file), null, '文件不存在时返回 null')
    assert.equal(saveStatsFile(file, {
      version: 1, since: 'S', updatedAt: 'U', totals: { ...zeroTotals(), blocks: 7 },
    }), true)
    const loaded = loadStatsFile(file)
    assert.equal(loaded.since, 'S')
    assert.equal(loaded.totals.blocks, 7)
    assert.equal(loaded.totals.runs, 0, '缺省字段应补 0')

    writeFileSync(file, '{ 这不是 json')
    assert.equal(loadStatsFile(file), null, '损坏文件不应抛错')
    assert.equal(existsSync(`${file}.tmp-${process.pid}`), false, '不应残留临时文件')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('统计文件：累计 = 盘上历史 + 未落盘增量，且并行写入被合并不被覆盖', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rz-stats-'))
  const file = join(dir, 'stats.json')
  const config = normalize({ statsFile: file })
  try {
    saveStatsFile(file, {
      version: 1, since: 'S', updatedAt: 'U', totals: { ...zeroTotals(), blocks: 100, runs: 3 },
    })
    const state = { stats: createStats(), flushed: zeroTotals(), sinceFallback: 'F' }
    state.stats.blocks = 5
    state.stats.skipped = 2

    const cumulative = computeCumulative(state, config)
    assert.equal(cumulative.totals.blocks, 105, '应与盘上历史相加')
    assert.equal(cumulative.totals.skipped, 2)
    assert.equal(cumulative.totals.runs, 3)

    flushStats(state, config)
    assert.equal(computeCumulative(state, config).totals.blocks, 105, '已落盘的增量不应重复计入')

    // 模拟另一个进程在此期间又写了 +10；本进程随后再多 1 块
    const onDisk = loadStatsFile(file)
    saveStatsFile(file, { ...onDisk, totals: { ...onDisk.totals, blocks: onDisk.totals.blocks + 10 } })
    state.stats.blocks = 6
    flushStats(state, config)
    assert.equal(loadStatsFile(file).totals.blocks, 116, '并行写入应被合并而不是覆盖')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('统计文件：端到端 —— 翻译一点就计入累计，卸载时落盘', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rz-stats-'))
  const file = join(dir, 'stats.json')
  try {
    const pack = makeCtx()
    const dispose = apply(pack.ctx, { translate: true, statsFile: file })
    await withSilentWarn(() => runOn(pack, mainSource())) // 一次翻译
    await withSilentWarn(() => runOn(pack, shortChineseSource())) // 一次跳过

    const status = await pack.state.commands[0].handler({ rawInput: '' })
    assert.match(status.text, /累计统计（跨重启）/)
    assert.match(status.text, /处理思考块 \| 2（翻译 1 \/ 跳过 1）/)
    assert.match(status.text, /插件加载次数 \| 1 次/)
    assert.match(status.text, /估算省下的模型调用 \| ≈ 1 次/)

    dispose() // 卸载 → 应把未落盘的统计写掉
    const onDisk = loadStatsFile(file)
    assert.ok(onDisk !== null, '卸载后应有统计文件')
    assert.equal(onDisk.totals.blocks, 2, 'dispose 时应落盘')
    assert.equal(onDisk.totals.translated, 1)
    assert.equal(onDisk.totals.skipped, 1)
    assert.equal(onDisk.totals.pieces, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('统计文件：每次加载 runs +1；reset all 只清累计、本进程保留', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rz-stats-'))
  const file = join(dir, 'stats.json')
  try {
    const first = makeCtx()
    const dispose = apply(first.ctx, { translate: true, statsFile: file })
    await withSilentWarn(() => runOn(first, mainSource()))
    apply(makeCtx().ctx, { statsFile: file })
    assert.equal(loadStatsFile(file).totals.runs, 2, '每次加载 runs +1')

    const reset = await first.state.commands[0].handler({ rawInput: 'reset all' })
    assert.equal(reset.kind, 'success')
    const after = await first.state.commands[0].handler({ rawInput: '' })
    assert.match(after.text, /处理思考块 \| 1（翻译 1 \/ 跳过 0）/, '本进程统计应保留')
    assert.match(after.text, /累计统计（跨重启）[\s\S]*处理思考块 \| 0（翻译 0 \/ 跳过 0）/, '累计应清零')
    assert.equal(loadStatsFile(file).totals.blocks, 0)
    dispose()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('统计文件：未配置时显示「未开启」，reset all 报错，配置校验拦住非字符串', async () => {
  const pack = makeCtx()
  apply(pack.ctx, { translate: true }) // 未配 statsFile
  const status = await pack.state.commands[0].handler({ rawInput: '' })
  assert.match(status.text, /累计统计：未开启/)
  const bad = await pack.state.commands[0].handler({ rawInput: 'reset all' })
  assert.equal(bad.kind, 'error')
  assert.match(bad.text, /没有累计统计可清/)

  assert.throws(() => normalize({ statsFile: 42 }), /statsFile/)
  assert.equal(normalize(undefined).statsFile, '')
})

// ───────────────────────── 术语保留（翻译指令） ─────────────────────────

test('翻译指令：默认带术语保留规则，keepTerms 会追加进实际请求', async () => {
  // 默认指令本身必须含明确规则，而不是只靠模型自觉
  assert.match(DEFAULT_TRANSLATE_PROMPT, /只输出译文/)
  assert.match(DEFAULT_TRANSLATE_PROMPT, /原样保留/)
  assert.match(DEFAULT_TRANSLATE_PROMPT, /路径/)

  const withTerms = normalize({ keepTerms: ['Cordis', 'prompt-polish'] })
  const prompt = translatePromptFor(withTerms)
  assert.match(prompt, /必须原样保留/)
  assert.match(prompt, /Cordis、prompt-polish/)
  assert.equal(translatePromptFor(normalize({})), normalize({}).translatePrompt, '空词表时不追加')

  // 端到端：词表要真的出现在发给辅助模型的请求里
  const pack = makeCtx()
  apply(pack.ctx, { translate: true, keepTerms: ['Typert'] })
  await withSilentWarn(() => runOn(pack, mainSource()))
  assert.match(pack.state.auxOptions[0].messages[0].content[0].text, /必须原样保留[\s\S]*Typert/)

  // 校验：只接受非空字符串数组
  assert.throws(() => normalize({ keepTerms: 'Cordis' }), /keepTerms/)
  assert.throws(() => normalize({ keepTerms: [''] }), /keepTerms/)
  assert.throws(() => normalize({ keepTerms: [42] }), /keepTerms/)
  assert.deepEqual(normalize(undefined).keepTerms, [])
})

// ───────────────────────── 语言判定 / 取消 / no-op / 重试 / 并发 ─────────────────────────

test('语言判定：中文夹成句英文时不再整体跳过', () => {
  const mixed = '先分析一下这个问题。我们需要仔细阅读文件并确认结果。'
    + 'The user wants a concise answer with no tools and we should read the file carefully. '
    + '然后给出结论。'
  assert.ok(cjkRatio(mixed) >= 0.3, `测试文本的汉字占比应高于阈值（实际 ${cjkRatio(mixed)}）`)
  assert.equal(isAlreadyChinese(mixed, 0.3), false, '英文成句时仍应翻译')
  assert.equal(isAlreadyChinese('这是中文，只有 Cordis 和 Typert 两个词。', 0.3), true, '零散英文词不影响判定')
})

test('取消翻译：abort 不计失败、不触发熔断，统计里单列取消', async () => {
  const controller = new AbortController()
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const pack = makeCtx({ aux: () => ({ gate }) })
  apply(pack.ctx, { translate: true, breakerFailures: 1, breakerCooldownMs: 60000 })
  const entry = listener(pack.state, 'llm/stream')
  const options = { provider: 'p', model: 'm', messages: [], signal: controller.signal }
  const running = collect(entry.handler(options, () => (async function* () { yield* mainSource() })()))
  controller.abort()
  release()
  const out = await running
  const status = await pack.state.commands[0].handler({ rawInput: '' })
  assert.match(status.text, /取消 1/)
  assert.match(status.text, /失败 0/)
  assert.match(status.text, /熔断 \| 未发生/)
  assert.equal(out.at(-1).type, 'finish')
})

test('no-op 检测：译文与原文等价时计入 noop，而不是有效翻译', async () => {
  const pack = makeCtx({ auxText: 'Let me think.' })
  apply(pack.ctx, { translate: true })
  await withSilentWarn(() => runOn(pack, mainSource()))
  const status = await pack.state.commands[0].handler({ rawInput: '' })
  assert.match(status.text, /无变化 1/)
  assert.match(status.text, /有效翻译 \| 0 \/ 1 片/)
})

test('重试：retry 对失败片生效，成功后计入重试次数', async () => {
  let calls = 0
  const pack = makeCtx({
    aux: () => {
      calls += 1
      return calls === 1 ? { finish: 'error' } : { finish: 'stop', text: '中文译文' }
    },
  })
  apply(pack.ctx, { translate: true, retry: 1 })
  const out = await runOn(pack, mainSource())
  assert.equal(calls, 2, '第一次失败后应重试一次')
  assert.equal(out.find((chunk) => chunk.type === 'reasoning-delta').text, '中文译文')
  const status = await pack.state.commands[0].handler({ rawInput: '' })
  assert.match(status.text, /重试 1/)
  assert.match(status.text, /失败 0/)
})

test('并发上限：maxConcurrency 限制同时在途的翻译片', async () => {
  let active = 0
  let peak = 0
  const pack = makeCtx({
    aux: () => {
      active += 1
      peak = Math.max(peak, active)
      let release
      const gate = new Promise((resolve) => { release = resolve })
      setTimeout(() => {
        active -= 1
        release()
      }, 5)
      return { gate }
    },
  })
  apply(pack.ctx, {
    translate: true,
    maxConcurrency: 2,
    chunkThreshold: 100,
    minChunkChars: 20,
    maxChunkChars: 50,
  })
  await withSilentWarn(() => runOn(pack, longSource(ENGLISH_LONG)))
  assert.ok(peak <= 2, `同时在途的片不应超过 2（实际 ${peak}）`)
  assert.ok(peak >= 1)
})

test('翻译调用：思考模型把译文放在 reasoning 里也能取到', async () => {
  const pack = makeCtx({ auxKind: 'reasoning', auxText: '来自 reasoning 的译文' })
  apply(pack.ctx, { translate: true })
  const out = await runOn(pack, mainSource())
  const delta = out.find((chunk) => chunk.type === 'reasoning-delta')
  assert.equal(delta.text, '来自 reasoning 的译文')
})

test('重申层：per-agent 注册纳入 agent.ctx.effect，卸载插件时释放', () => {
  const pack = makeCtx()
  const dispose = apply(pack.ctx, {})
  let off = 0
  let effectDisposed = 0
  const created = listener(pack.state, 'agent/created')
  created.handler({
    agent: {
      ctx: {
        effect(fn) {
          const inner = fn()
          return () => {
            inner?.()
            effectDisposed += 1
          }
        },
        on() {
          return () => {
            off += 1
          }
        },
      },
    },
  })
  dispose()
  assert.equal(off, 1, '插件卸载时应释放 per-agent pre-step 监听')
  assert.equal(effectDisposed, 1)
})

test('统计文件：锁被占用时跳过落盘并保留增量，释放后补写', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rz-lock-'))
  const file = join(dir, 'stats.json')
  const config = normalize({ statsFile: file })
  const state = { stats: createStats(), flushed: zeroTotals(), sinceFallback: 'F' }
  try {
    saveStatsFile(file, { version: 1, since: 'S', updatedAt: 'U', totals: { ...zeroTotals(), blocks: 1 } })
    writeFileSync(`${file}.lock`, 'other')
    state.stats.blocks = 1
    assert.equal(flushStats(state, config), false, '锁被占用时应跳过')
    assert.equal(loadStatsFile(file).totals.blocks, 1, '盘上不应被改写')
    rmSync(`${file}.lock`, { force: true })
    assert.equal(flushStats(state, config), true, '锁释放后应写入')
    assert.equal(loadStatsFile(file).totals.blocks, 2)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('配置校验：maxConcurrency / retry', () => {
  assert.throws(() => normalize({ maxConcurrency: -1 }), /maxConcurrency/)
  assert.throws(() => normalize({ maxConcurrency: 1.5 }), /maxConcurrency/)
  assert.throws(() => normalize({ retry: -1 }), /retry/)
  assert.equal(normalize(undefined).maxConcurrency, 4)
  assert.equal(normalize(undefined).retry, 0)
})
