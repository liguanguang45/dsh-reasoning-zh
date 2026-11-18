#!/usr/bin/env node
/**
 * 把本插件同步进一个 DSH profile（默认 desktop）。
 *
 * 用法：
 *   node scripts/install-into-profile.mjs                     # 同步到 desktop
 *   node scripts/install-into-profile.mjs --profile web       # 同步到别的 profile
 *   node scripts/install-into-profile.mjs --verify            # 只校验，不写任何文件
 *   node scripts/install-into-profile.mjs --print-config      # 看 profile 里登记了什么
 *   node scripts/install-into-profile.mjs --home D:/other     # 覆盖 DSH_HOME（测试用）
 *
 * 为什么需要它：DSH 桌面壳要求插件以**平铺真实目录**存在于 profile 的 node_modules，
 * 而 `file:` 依赖是快照、pnpm 在源码变化后不会重新复制（删了都不恢复）。
 * 本脚本把「自检 → 清旧副本 → 平铺复制 → SHA256 校验」固化成一条命令。
 */
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  collectFiles,
  importSelfCheck,
  readPatchRow,
  readProfileManifest,
  resolveHome,
  resolveProfileDir,
  syncIntoProfile,
  verifyProfile,
} from './lib/profile-sync.mjs'

const SOURCE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** 解析命令行参数。 */
function parseArgs(argv) {
  const args = { profile: 'desktop', verify: false, printConfig: false, home: undefined, help: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--profile') args.profile = argv[++i]
    else if (arg === '--home') args.home = argv[++i]
    else if (arg === '--verify') args.verify = true
    else if (arg === '--print-config') args.printConfig = true
    else if (arg === '--help' || arg === '-h') args.help = true
    else {
      console.error(`未知参数：${arg}`)
      args.help = true
    }
  }
  return args
}

/** 打印用法。 */
function printUsage() {
  console.log(`用法：node scripts/install-into-profile.mjs [--profile desktop] [--verify] [--print-config] [--home <dir>]

  （无参数）        自检 → 清掉 profile 里的旧副本 → 平铺复制 → SHA256 校验 → 提示重启
  --verify          只读：报告 profile 里跑的是哪一版、与源码是否逐文件一致
  --print-config    只读：打印 profile 的依赖/bundles/patch 行登记情况
  --profile <name>  目标 profile，默认 desktop
  --home <dir>      覆盖 DSH_HOME（默认 ~/.dsh）`)
}

/** 打印校验表。 */
function printVerify(result) {
  console.log(`目标：${result.targetDir}`)
  console.log(`版本：源码 ${result.version.source ?? '?'} / profile ${result.version.target ?? '?'}`)
  for (const entry of result.files) {
    console.log(`  ${entry.match ? '✓' : '✗'} ${entry.file}  ${entry.sourceHash ?? '(缺)'} vs ${entry.targetHash ?? '(缺)'}`)
  }
  console.log(result.ok ? '结论：一致 ✓' : '结论：不一致（需要同步，或 profile 里根本不是这份代码）')
}

/** 打印登记情况。 */
function printConfig(profileDir, sourceDir) {
  const manifest = readProfileManifest(profileDir)
  if (!manifest.ok) {
    console.log(`profile package.json 读取失败：${manifest.error}`)
  } else {
    const dep = Object.entries(manifest.dependencies).find(([name]) => name === 'dsh-reasoning-zh')
    console.log(`依赖声明：${dep === undefined ? '无（靠 patch 行 + node_modules 也能工作）' : JSON.stringify(dep)}`)
    console.log(`in bundles：${manifest.bundles.includes('dsh-reasoning-zh') ? '是' : '否（桌面壳会自动 reconcile，通常无需手写）'}`)
  }
  const row = readPatchRow(profileDir)
  console.log(row.ok ? `patch 行（第 ${row.line} 行）：\n${row.text}` : `patch 行：未找到（${row.reason}）`)
  console.log(`源码将同步 ${collectFiles(sourceDir).length} 个文件：${collectFiles(sourceDir).join(', ')}`)
}

/** 入口。 */
async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    printUsage()
    return 0
  }

  const home = args.home === undefined ? resolveHome() : resolve(args.home)
  const profileDir = resolveProfileDir(home, args.profile)
  console.log(`DSH home：${home}`)
  console.log(`profile ：${profileDir}`)
  if (!existsSync(profileDir)) {
    console.error(`profile 不存在：${profileDir}`)
    return 1
  }

  // 动 profile 之前先确认源码自己没问题
  const check = await importSelfCheck(SOURCE_DIR)
  if (!check.ok) {
    console.error(`源码导入自检失败，已中止：${check.error}`)
    return 1
  }
  console.log(`源码自检：${check.pluginName} v${check.version} · inject=${JSON.stringify(check.inject)}`
    + ` · 状态命令=${check.hasStatusCommand ? '有' : '无'}`)
  console.log(`  配置默认值：translateScope=${check.translateScope} verboseFile=${JSON.stringify(check.verboseFile)}`
    + ` breakerFailures=${check.breakerFailures} maxConcurrency=${check.maxConcurrency} retry=${check.retry}`)

  if (args.printConfig) {
    printConfig(profileDir, SOURCE_DIR)
    return 0
  }
  if (args.verify) {
    const result = verifyProfile(SOURCE_DIR, profileDir)
    printVerify(result)
    return result.ok ? 0 : 2
  }

  const before = verifyProfile(SOURCE_DIR, profileDir)
  if (before.ok) {
    console.log('profile 里已经是这份代码，无需同步（仍会刷新一次以消除残留文件）。')
  }
  const synced = syncIntoProfile(SOURCE_DIR, profileDir)
  const after = verifyProfile(SOURCE_DIR, profileDir)
  console.log(`已同步 ${synced.files.length} 个文件 → ${synced.targetDir}`)
  printVerify(after)

  const manifest = readProfileManifest(profileDir)
  if (manifest.ok) {
    console.log(`登记检查：dependencies 含本包=${Object.hasOwn(manifest.dependencies, 'dsh-reasoning-zh')}`
      + ` · bundles 含本包=${manifest.bundles.includes('dsh-reasoning-zh')}`)
  }
  const row = readPatchRow(profileDir)
  console.log(row.ok ? `patch 行存在（第 ${row.line} 行）` : `⚠ patch 行缺失：${row.reason}`)
  console.log('\n下一步：完整重启 DeepSeek Harness（退出进程再打开），新代码才会生效。')
  console.log('回滚：把 profile 里的 node_modules/dsh-reasoning-zh 换回上一份，或用备份的 package.json/cordis.patch.yml 恢复登记。')
  return after.ok ? 0 : 2
}

main().then(
  (code) => {
    process.exitCode = code
  },
  (error) => {
    console.error(`意外失败：${error?.stack ?? error}`)
    process.exitCode = 1
  },
)
