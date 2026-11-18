/**
 * 同步/校验脚本的单测（纯函数层，不 spawn 子进程）。
 * 运行：node test/install.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  PKG_NAME,
  collectFiles,
  hashFile,
  importSelfCheck,
  installIntoProfile,
  readPackageVersion,
  readPatchRow,
  readProfileManifest,
  resolveHome,
  resolveProfileDir,
  resolveTargetDir,
  syncIntoProfile,
  verifyProfile,
} from '../scripts/lib/profile-sync.mjs'

/** 本仓库根目录（用于 importSelfCheck 的真实用例）。 */
const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url))

/** 造一个假的包源码目录。 */
function makeSource(dir) {
  mkdirSync(join(dir, 'lib'), { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: PKG_NAME, version: '9.9.9' }, null, 2))
  writeFileSync(join(dir, 'cordis.patch.yml'), '- insert:\n    - id: reasoning-zh\n      name: dsh-reasoning-zh\n')
  writeFileSync(join(dir, 'README.md'), '# demo\n')
  writeFileSync(join(dir, 'lib', 'index.js'), 'export const name = "demo"\n')
  writeFileSync(join(dir, 'noise.txt'), '不该被同步\n')
  return dir
}

/** 造一个假的 profile 目录（含 package.json 与 cordis.patch.yml）。 */
function makeProfile(dir) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: 'dsh-profile-fake',
    dependencies: { [PKG_NAME]: 'file:F:/somewhere' },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', PKG_NAME] } },
  }, null, 2))
  writeFileSync(join(dir, 'cordis.patch.yml'), [
    '# 假 profile',
    '- insert:',
    '    - id: other-plugin',
    "      name: '@x/y'",
    '',
    '# dsh-reasoning-zh',
    '- insert:',
    '    - id: reasoning-zh',
    '      name: dsh-reasoning-zh',
    '',
  ].join('\n'))
  return dir
}

test('路径解析：DSH_HOME 优先，profile 名拒绝路径分隔符', () => {
  assert.equal(resolveHome({ DSH_HOME: 'F:/tmp/home' }, 'C:/Users/x'), join('F:/tmp/home'))
  assert.equal(resolveHome({}, 'C:/Users/x'), join('C:/Users/x', '.dsh'))
  assert.equal(resolveProfileDir('F:/h', 'desktop'), join('F:/h', 'profiles', 'desktop'))
  assert.throws(() => resolveProfileDir('F:/h', ''), /profile 名不合法/)
  assert.throws(() => resolveProfileDir('F:/h', '../evil'), /profile 名不合法/)
  assert.throws(() => resolveProfileDir('F:/h', 'a/b'), /profile 名不合法/)
})

test('collectFiles：只收白名单路径，lib/ 递归，忽略无关文件', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rz-src-'))
  try {
    makeSource(dir)
    const files = collectFiles(dir)
    assert.deepEqual(files, ['README.md', 'cordis.patch.yml', 'lib/index.js', 'package.json'].sort())
    assert.ok(!files.includes('noise.txt'), '白名单外的文件不应被同步')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('syncIntoProfile → verifyProfile：平铺复制后逐文件一致，且清掉旧副本残留', () => {
  const root = mkdtempSync(join(tmpdir(), 'rz-sync-'))
  const source = join(root, 'source')
  const profile = makeProfile(join(root, 'home', 'profiles', 'desktop'))
  try {
    makeSource(source)
    // 先放一份「旧副本」：内容错、还多一个残留文件
    const target = resolveTargetDir(profile)
    mkdirSync(join(target, 'lib'), { recursive: true })
    writeFileSync(join(target, 'package.json'), JSON.stringify({ version: '0.0.1' }))
    writeFileSync(join(target, 'lib', 'index.js'), 'export const name = "old"\n')
    writeFileSync(join(target, 'stale.txt'), '残留\n')

    const before = verifyProfile(source, profile)
    assert.equal(before.ok, false, '同步前应判定不一致')
    assert.equal(before.version.target, '0.0.1')

    const synced = syncIntoProfile(source, profile)
    assert.equal(synced.files.length, 4)
    assert.equal(existsSync(join(target, 'stale.txt')), false, '旧副本的残留文件应被清掉')

    const after = verifyProfile(source, profile)
    assert.equal(after.ok, true, `同步后应一致：${JSON.stringify(after.files)}`)
    assert.equal(after.version.source, '9.9.9')
    assert.equal(after.version.target, '9.9.9')
    assert.ok(after.files.every((entry) => entry.match))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('verifyProfile：目标缺失时逐项为不匹配并给出 ok=false', () => {
  const root = mkdtempSync(join(tmpdir(), 'rz-verify-'))
  const source = join(root, 'source')
  const profile = makeProfile(join(root, 'home', 'profiles', 'desktop'))
  try {
    makeSource(source)
    const result = verifyProfile(source, profile)
    assert.equal(result.ok, false)
    assert.equal(result.version.target, null, '目标没有 package.json')
    assert.ok(result.files.every((entry) => entry.targetHash === null))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('hashFile：文件缺失返回 null', () => {
  assert.equal(hashFile('F:/definitely/not/here.txt'), null)
})

test('readProfileManifest / readPatchRow：读出登记情况与行号', () => {
  const root = mkdtempSync(join(tmpdir(), 'rz-read-'))
  const profile = makeProfile(join(root, 'desktop'))
  try {
    const manifest = readProfileManifest(profile)
    assert.equal(manifest.ok, true)
    assert.equal(manifest.dependencies[PKG_NAME], 'file:F:/somewhere')
    assert.ok(manifest.bundles.includes(PKG_NAME))

    const row = readPatchRow(profile)
    assert.equal(row.ok, true)
    assert.equal(row.line, 8, 'id 行在第 8 行')
    assert.match(row.text, /name: dsh-reasoning-zh/)

    // 找不到时给出原因
    writeFileSync(join(profile, 'cordis.patch.yml'), '- insert:\n    - id: other\n')
    assert.equal(readPatchRow(profile).ok, false)
    assert.match(readPatchRow(profile).reason, /没有 id: reasoning-zh/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('importSelfCheck：真源码通过并报告关键配置；坏源码被拦住', async () => {
  const real = await importSelfCheck(PACKAGE_ROOT)
  assert.equal(real.ok, true, `真实源码应能导入：${real.error}`)
  assert.equal(real.pluginName, 'reasoning-zh')
  assert.equal(real.hasStatusCommand, true, '应导出状态命令处理器')
  assert.equal(real.translateScope, 'main')
  assert.match(real.version ?? '', /^\d+\.\d+\.\d+$/)

  const dir = mkdtempSync(join(tmpdir(), 'rz-bad-'))
  try {
    mkdirSync(join(dir, 'lib'), { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'bad', version: '0.0.0' }))
    writeFileSync(join(dir, 'lib', 'index.js'), 'export const name = ;;; broken\n')
    const bad = await importSelfCheck(dir)
    assert.equal(bad.ok, false, '语法错误的源码必须被自检拦住')
    assert.ok(typeof bad.error === 'string' && bad.error.length > 0)
    assert.equal(readPackageVersion(join(dir, 'package.json')), '0.0.0')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('从零安装：空 profile 也能建出 package.json 与挂载行，重复执行幂等', () => {
  const root = mkdtempSync(join(tmpdir(), 'rz-fresh-'))
  const source = makeSource(join(root, 'source'))
  const profile = join(root, 'home', 'profiles', 'desktop')
  mkdirSync(profile, { recursive: true }) // 全新 profile：一个配置文件都没有
  try {
    const first = installIntoProfile(source, profile)
    assert.equal(first.verified.ok, true, '安装后应逐文件一致')
    assert.equal(first.patch.added, true, '应补上挂载行')
    assert.equal(first.manifest.existed, false, 'package.json 原本不存在 → 已创建')
    assert.deepEqual([...first.manifest.changes].sort(), ['bundles', 'dependencies'])

    const manifest = readProfileManifest(profile)
    assert.equal(manifest.ok, true)
    assert.match(manifest.dependencies[PKG_NAME], /^file:/)
    assert.ok(manifest.bundles.includes(PKG_NAME))
    assert.equal(readPatchRow(profile).ok, true)

    // 幂等：再装一次不该重复添加
    const second = installIntoProfile(source, profile)
    assert.equal(second.patch.added, false)
    assert.deepEqual(second.manifest.changes, [], '无需再改 package.json')
    assert.equal(second.verified.ok, true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('从零安装：不覆盖已有 bundles、无关字段与已经存在的挂载行', () => {
  const root = mkdtempSync(join(tmpdir(), 'rz-merge-'))
  const source = makeSource(join(root, 'source'))
  const profile = makeProfile(join(root, 'home', 'profiles', 'desktop'))
  try {
    const before = JSON.parse(readFileSync(join(profile, 'package.json'), 'utf8'))
    const result = installIntoProfile(source, profile)
    const after = JSON.parse(readFileSync(join(profile, 'package.json'), 'utf8'))

    assert.deepEqual(after.dsh.profile.bundles, before.dsh.profile.bundles, 'bundles 顺序与内容不应被改写')
    assert.equal(after.name, before.name, '无关字段应原样保留')
    assert.equal(result.manifest.changes.includes('bundles'), false)
    assert.equal(result.patch.added, false, '已有 id: reasoning-zh 的行 → 保持不动')
    assert.equal(result.verified.ok, true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
