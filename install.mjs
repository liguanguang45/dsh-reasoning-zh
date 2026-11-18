#!/usr/bin/env node
/**
 * 一键安装 dsh-reasoning-zh 到本机的 DSH。
 *
 * 用法（在解压后的目录里运行）：
 *   node install.mjs                     # 自动找 DSH home 与 profile（优先 desktop）
 *   node install.mjs --profile desktop   # 指定 profile
 *   node install.mjs --home D:/my-dsh    # 手动指定 DSH home
 *   node install.mjs --check             # 只校验当前安装状态，不写任何文件
 *
 * 它会做四件事（都可重复执行）：
 *   1. 把本目录**平铺复制**到 <home>/profiles/<profile>/node_modules/dsh-reasoning-zh
 *      （桌面壳只认平铺真实目录，符号链接会被判为「未成为 profile 层」）；
 *   2. 在 profile 的 package.json 里登记 dependencies + dsh.profile.bundles；
 *   3. 在 profile 的 cordis.patch.yml 里补一段挂载行（已有同 id 的行则原样不动）；
 *   4. 逐文件做 SHA256 校验并打印结果。
 *
 * 装完需要**完全退出并重新打开** DSH。
 */
import { existsSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  installIntoProfile,
  resolveHome,
  resolveProfileDir,
  verifyProfile,
} from './scripts/lib/profile-sync.mjs'

const HERE = resolve(dirname(fileURLToPath(import.meta.url)))

/** 解析命令行参数。 */
function parseArgs(argv) {
  const args = { profile: undefined, home: undefined, check: false, help: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--profile') args.profile = argv[++i]
    else if (arg === '--home') args.home = argv[++i]
    else if (arg === '--check') args.check = true
    else if (arg === '--help' || arg === '-h') args.help = true
    else {
      console.error(`未知参数：${arg}`)
      args.help = true
    }
  }
  return args
}

/** 列出 home 下已有的 profile 名。 */
function listProfiles(home) {
  const dir = join(home, 'profiles')
  if (!existsSync(dir)) return []
  return readdirSync(dir).filter((name) => {
    try {
      return statSync(join(dir, name)).isDirectory()
    } catch {
      return false
    }
  })
}

/** 选一个 profile：优先 desktop（官方桌面壳），否则取第一个存在的。 */
function pickProfile(home, wanted) {
  const names = listProfiles(home)
  if (wanted !== undefined) {
    if (!names.includes(wanted)) {
      throw new Error(`profile "${wanted}" 不存在，这个 home 下有：${names.join(', ') || '(无)'}`)
    }
    return wanted
  }
  if (names.includes('desktop')) return 'desktop'
  if (names.length === 0) {
    throw new Error(`没找到任何 profile（${join(home, 'profiles')}）——请先启动一次 DSH 再运行本脚本`)
  }
  return names[0]
}

/** 打印用法。 */
function printUsage() {
  console.log(`用法：node install.mjs [--profile <name>] [--home <dir>] [--check]

  （无参数）        自动找 DSH home 与 profile 并安装
  --profile <name>  指定 profile（默认优先 desktop）
  --home <dir>      指定 DSH home（默认取 $DSH_HOME，否则 ~/.dsh）
  --check           只校验当前安装状态，不写任何文件（退出码 0=一致，2=不一致）`)
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    printUsage()
    return 0
  }

  const home = args.home === undefined ? resolveHome() : resolve(args.home)
  console.log(`DSH home : ${home}`)
  const profileName = pickProfile(home, args.profile)
  const profileDir = resolveProfileDir(home, profileName)
  console.log(`profile  : ${profileDir}`)

  // 预检：profile 必须已经被 DSH 初始化过。
  // 否则我们写出的 bundles 列表会缺 @deepseek-ai/dsh-base 与 dsh-web-app，DSH 可能起不来。
  const manifestFile = join(profileDir, 'package.json')
  if (!existsSync(manifestFile)) {
    console.error(`\n这个 profile 还没被 DSH 初始化（缺少 ${manifestFile}）。`)
    console.error('请先启动一次 DSH，让它创建好 profile，然后再运行本脚本。')
    return 1
  }

  if (args.check) {
    const result = verifyProfile(HERE, profileDir)
    for (const entry of result.files) {
      console.log(`  ${entry.match ? '✓' : '✗'} ${entry.file}`)
    }
    console.log(result.ok
      ? '结论：已安装，且与当前目录逐文件一致 ✓'
      : '结论：未安装，或与当前目录不一致（重新运行不带 --check 的安装即可）')
    return result.ok ? 0 : 2
  }

  const result = installIntoProfile(HERE, profileDir)
  console.log(`\n已复制 ${result.synced.files.length} 个文件 → ${result.synced.targetDir}`)
  console.log(`package.json    ：${result.manifest.existed ? '已合并' : '已创建'}`
    + `${result.manifest.changes.length === 0 ? '（无需改动）' : `（更新：${result.manifest.changes.join('、')}）`}`)
  console.log(`cordis.patch.yml：${result.patch.added ? '已补上挂载行' : `保持不动（${result.patch.reason}）`}`)
  console.log(result.verified.ok ? 'SHA256 校验：逐文件一致 ✓' : 'SHA256 校验：⚠ 有不一致，请把上面的输出发给我')
  console.log('\n下一步：**完全退出并重新打开 DSH**（桌面版要退出进程，不是只关窗口）。')
  console.log('装好后在对话里输入 /reasoning-zh 回车，能看到三层状态就成功了。')
  console.log(`\n卸载：删掉 ${result.synced.targetDir}，`
    + '并从 profile 的 package.json 与 cordis.patch.yml 里移除 dsh-reasoning-zh 相关内容。')
  return result.verified.ok ? 0 : 2
}

main().then(
  (code) => {
    process.exitCode = code
  },
  (error) => {
    console.error(`安装失败：${error?.message ?? error}`)
    process.exitCode = 1
  },
)
