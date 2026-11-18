#!/usr/bin/env node
/**
 * 准备「可分享目录」：`dist/dsh-reasoning-zh-<version>/`
 *
 * 只放插件本体与安装/自测所需文件，不带开发过程产物（`.verify3`、`dist` 自身等）。
 * 压缩成 zip 交给外部命令完成（Windows 用 Compress-Archive，其他平台用 zip），
 * 这样本脚本保持零依赖、不 spawn 子进程。
 *
 * 用法：node scripts/pack-share.mjs
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** 分享包里要带的路径（相对包根）。 */
const SHARE_PATHS = [
  'lib',
  'locale',
  'icon.svg',
  'LICENSE',
  'scripts',
  'tools',
  'test',
  'mount',
  'cordis.patch.yml',
  'package.json',
  'README.md',
  'INSTALL.md',
  'install.mjs',
  'install.bat',
  'install.sh',
  '.gitignore',
]

const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version ?? '0.0.0'
const outDir = join(ROOT, 'dist', `dsh-reasoning-zh-${version}`)

rmSync(outDir, { recursive: true, force: true })
mkdirSync(outDir, { recursive: true })
for (const item of SHARE_PATHS) {
  const from = join(ROOT, item)
  if (!existsSync(from)) continue
  cpSync(from, join(outDir, item), { recursive: true })
}
console.log(`已准备分享目录：${outDir}`)
console.log(`  版本 ${version} · 含 ${SHARE_PATHS.filter((item) => existsSync(join(ROOT, item))).length} 个条目`)
console.log('下一步压缩：')
console.log(`  Compress-Archive -Path "${outDir}\\*" -DestinationPath "${join(ROOT, 'dist', `dsh-reasoning-zh-${version}.zip`)}" -Force`)
