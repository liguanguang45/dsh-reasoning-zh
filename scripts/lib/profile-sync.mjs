/**
 * profile 同步的纯逻辑：解析路径、比对哈希、平铺复制。
 *
 * 抽成独立模块是为了能单测；`scripts/install-into-profile.mjs` 只负责 CLI 与输出。
 * 这里固化了我们踩过的坑：
 *   - `file:` 依赖是快照，pnpm 不会因为源码变化重新复制 → 必须自己清旧副本再复制；
 *   - DSH 桌面壳要求 `node_modules/<pkg>` 是**平铺真实目录**，符号链接会被判为「未成为 profile 层」；
 *   - 删除前做路径断言，避免因为参数写错而误删别的目录。
 */
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

/** 本包名（也是 profile 里 node_modules 下的目录名）。 */
export const PKG_NAME = 'dsh-reasoning-zh'

/** 需要同步进 profile 的路径（相对包根）。 */
export const SYNC_PATHS = ['lib', 'locale', 'package.json', 'cordis.patch.yml', 'README.md', 'icon.svg', 'LICENSE']

/** 插件在 profile patch 里的挂载行 id。 */
export const PATCH_ROW_ID = 'reasoning-zh'

/**
 * 解析 Harness home：优先 `DSH_HOME`（与 DSH 自身一致），否则 `~/.dsh`。
 * @param env - 环境变量表（默认 process.env，便于测试注入）。
 * @param fallbackHome - 无 DSH_HOME 时的用户目录。
 * @returns 绝对路径。
 */
export function resolveHome(env = process.env, fallbackHome = homedir()) {
  const configured = env.DSH_HOME
  return configured !== undefined && configured.length > 0 ? resolve(configured) : join(fallbackHome, '.dsh')
}

/**
 * 解析 profile 目录；拒绝空名与含路径分隔符的名字。
 * @param home - Harness home。
 * @param profileName - profile 名（如 desktop / web / headless）。
 * @returns profile 目录绝对路径。
 */
export function resolveProfileDir(home, profileName) {
  if (typeof profileName !== 'string' || profileName.length === 0 || /[\\/]/.test(profileName)) {
    throw new Error(`profile 名不合法：${JSON.stringify(profileName)}`)
  }
  return join(home, 'profiles', profileName)
}

/**
 * 目标包目录：`<profile>/node_modules/<PKG_NAME>`。
 * @param profileDir - profile 目录。
 * @returns 目标目录绝对路径。
 */
export function resolveTargetDir(profileDir) {
  return join(profileDir, 'node_modules', PKG_NAME)
}

/**
 * 递归收集要同步的文件（相对路径，字典序）。
 * @param sourceDir - 包根目录。
 * @param paths - 要收集的相对路径列表。
 * @returns 相对路径数组（用 `/` 分隔）。
 */
export function collectFiles(sourceDir, paths = SYNC_PATHS) {
  const out = []
  const walk = (absolute) => {
    const info = statSync(absolute)
    if (info.isDirectory()) {
      for (const entry of readdirSync(absolute).sort()) walk(join(absolute, entry))
    } else if (info.isFile()) {
      out.push(relative(sourceDir, absolute).split('\\').join('/'))
    }
  }
  for (const item of paths) {
    const absolute = join(sourceDir, item)
    if (existsSync(absolute)) walk(absolute)
  }
  return out.sort()
}

/**
 * 文件 sha256；文件不存在返回 null。
 * @param file - 文件绝对路径。
 * @returns 十六进制摘要或 null。
 */
export function hashFile(file) {
  if (!existsSync(file)) return null
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

/**
 * 读 package.json 的 version；读不到返回 null。
 * @param file - package.json 路径。
 * @returns 版本号或 null。
 */
export function readPackageVersion(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8')).version ?? null
  } catch {
    return null
  }
}

/**
 * 只读校验：逐个文件比对源码与 profile 副本的哈希，并给出两侧版本号。
 * @param sourceDir - 包根目录。
 * @param profileDir - profile 目录。
 * @returns 校验结果。
 */
export function verifyProfile(sourceDir, profileDir) {
  const targetDir = resolveTargetDir(profileDir)
  const list = collectFiles(sourceDir)
  const files = list.map((rel) => {
    const sourceHash = hashFile(join(sourceDir, rel))
    const targetHash = hashFile(join(targetDir, rel))
    return {
      file: rel,
      match: sourceHash !== null && sourceHash === targetHash,
      sourceHash: sourceHash === null ? null : sourceHash.slice(0, 12),
      targetHash: targetHash === null ? null : targetHash.slice(0, 12),
    }
  })
  return {
    targetDir,
    files,
    ok: files.length > 0 && files.every((entry) => entry.match),
    version: {
      source: readPackageVersion(join(sourceDir, 'package.json')),
      target: readPackageVersion(join(targetDir, 'package.json')),
    },
  }
}

/**
 * 同步：清掉旧副本 → 平铺复制。
 *
 * 删除前做两道断言（目标必须是 `<profile>/node_modules/<PKG_NAME>`），
 * 因为这是不可逆操作。
 * @param sourceDir - 包根目录。
 * @param profileDir - profile 目录。
 * @param options - 可覆盖文件清单（测试用）。
 * @returns 目标目录与已复制文件。
 */
export function syncIntoProfile(sourceDir, profileDir, { files } = {}) {
  const targetDir = resolveTargetDir(profileDir)
  const expectedParent = join(resolve(profileDir), 'node_modules')
  if (resolve(dirname(targetDir)) !== expectedParent || !targetDir.endsWith(PKG_NAME)) {
    throw new Error(`拒绝操作可疑路径：${targetDir}`)
  }
  const list = files ?? collectFiles(sourceDir)
  if (list.length === 0) throw new Error(`源码目录里没有可同步的文件：${sourceDir}`)

  rmSync(targetDir, { recursive: true, force: true })
  for (const rel of list) {
    const from = join(sourceDir, rel)
    const to = join(targetDir, rel)
    mkdirSync(dirname(to), { recursive: true })
    cpSync(from, to)
  }
  return { targetDir, files: list }
}

/**
 * 读 profile 的 package.json（依赖与 bundles 登记情况）。
 * @param profileDir - profile 目录。
 * @returns 登记信息。
 */
export function readProfileManifest(profileDir) {
  try {
    const manifest = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))
    return {
      ok: true,
      dependencies: manifest.dependencies ?? {},
      bundles: manifest.dsh?.profile?.bundles ?? [],
    }
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) }
  }
}

/**
 * 在 profile 的 cordis.patch.yml 里找本插件的行（文本扫描，不做完整 YAML 解析）。
 * @param profileDir - profile 目录。
 * @returns 行号与该行起的片段，或未找到的原因。
 */
export function readPatchRow(profileDir) {
  const file = join(profileDir, 'cordis.patch.yml')
  if (!existsSync(file)) return { ok: false, reason: '没有 cordis.patch.yml' }
  const lines = readFileSync(file, 'utf8').split(/\r?\n/)
  const index = lines.findIndex((line) => /^\s*-\s*id:\s*['"]?reasoning-zh['"]?\s*$/.test(line))
  if (index === -1) return { ok: false, reason: 'patch 里没有 id: reasoning-zh 的行' }
  return {
    ok: true,
    line: index + 1,
    text: lines.slice(index, index + 14).filter((line) => line.trim().length > 0).join('\n'),
  }
}

/**
 * 导入自检：确认源码能被 import，并读出插件名、版本与关键配置默认值。
 * 在动 profile 之前跑，避免把坏代码复制进去。
 * @param sourceDir - 包根目录。
 * @returns 自检结果。
 */
export async function importSelfCheck(sourceDir) {
  const entry = pathToFileURL(join(sourceDir, 'lib', 'index.js')).href
  try {
    const mod = await import(entry)
    const config = mod.__internal?.normalize?.(undefined)
    return {
      ok: true,
      pluginName: mod.name,
      version: readPackageVersion(join(sourceDir, 'package.json')),
      inject: mod.inject,
      hasStatusCommand: typeof mod.__internal?.handleStatusCommand === 'function',
      translateScope: config?.translateScope,
      verboseFile: config?.verboseFile,
      breakerFailures: config?.breakerFailures,
      maxConcurrency: config?.maxConcurrency,
      retry: config?.retry,
    }
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) }
  }
}

/**
 * 确保 profile 的 package.json 把本包登记为「依赖 + bundle」。
 *
 * 为什么要两处都写：桌面壳只认真实存在的 profile 层——它需要 `dsh.profile.bundles`
 * 里列出这个包，才会去加载包内的 `cordis.patch.yml`（我们实测的 `include:<pkg>` 层）。
 * 只把目录放进去、只在 profile patch 里写一行，都可能被 reconcile 忽略或清理掉。
 * @param profileDir - profile 目录。
 * @param options - `{ sourceDir, pkgName, spec }`。
 * @returns 变更摘要。
 */
export function ensureProfileManifest(profileDir, { sourceDir, pkgName = PKG_NAME, spec } = {}) {
  const file = join(profileDir, 'package.json')
  let manifest = {}
  let existed = true
  try {
    manifest = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    manifest = { name: `dsh-profile-${resolve(profileDir).split(/[\\/]/).pop()}`, private: true }
    existed = false
  }
  const changes = []

  const wanted = spec ?? `file:${resolve(sourceDir).split('\\').join('/')}`
  if (manifest.dependencies === undefined || typeof manifest.dependencies !== 'object') {
    manifest.dependencies = {}
  }
  if (manifest.dependencies[pkgName] !== wanted) {
    manifest.dependencies[pkgName] = wanted
    changes.push('dependencies')
  }

  if (manifest.dsh === undefined || typeof manifest.dsh !== 'object') manifest.dsh = {}
  if (manifest.dsh.profile === undefined || typeof manifest.dsh.profile !== 'object') {
    manifest.dsh.profile = {}
  }
  const bundles = Array.isArray(manifest.dsh.profile.bundles) ? [...manifest.dsh.profile.bundles] : []
  if (!bundles.includes(pkgName)) {
    bundles.push(pkgName)
    changes.push('bundles')
  }
  manifest.dsh.profile.bundles = bundles

  if (changes.length > 0) {
    writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  }
  return { ok: true, file, existed, changes }
}

/**
 * 确保 profile 的 cordis.patch.yml 里有本插件的挂载行（幂等）。
 * 已经有同 id 的行时**原样保留**，避免覆盖使用者自己调过的配置。
 * @param profileDir - profile 目录。
 * @param options - `{ pkgName, id }`。
 * @returns 是否新增。
 */
export function ensurePatchRow(profileDir, { pkgName = PKG_NAME, id = PATCH_ROW_ID } = {}) {
  const file = join(profileDir, 'cordis.patch.yml')
  let text = ''
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    text = ''
  }
  if (new RegExp(`^\\s*-\\s*id:\\s*['"]?${id}['"]?\\s*$`, 'm').test(text)) {
    return { ok: true, file, added: false, reason: '已存在同 id 的行，保持不动' }
  }

  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const block = [
    `# ${pkgName}: 让思考过程用简体中文（由安装脚本添加；删掉本段即可卸载）`,
    '- insert:',
    `    - id: ${id}`,
    `      name: ${pkgName}`,
    '      config:',
    '        steering: both',
    '        remindOn: first',
    '        steerAnswer: true',
    '        cjkThreshold: 0.3',
    '        translate: true',
    '        verbose: false',
  ]
  const head = text.length === 0 ? '' : `${text.replace(/\s*$/, '')}${eol}${eol}`
  writeFileSync(file, `${head}${block.join(eol)}${eol}`, 'utf8')
  return { ok: true, file, added: true }
}

/**
 * 从零安装（或更新）本插件到一个 profile：
 * 平铺复制 → 登记依赖与 bundle → 写挂载行 → 逐文件校验。
 * @param sourceDir - 包根目录。
 * @param profileDir - profile 目录。
 * @param options - `{ pkgName, spec }`。
 * @returns 各步结果。
 */
export function installIntoProfile(sourceDir, profileDir, options = {}) {
  const synced = syncIntoProfile(sourceDir, profileDir, options)
  const manifest = ensureProfileManifest(profileDir, {
    sourceDir,
    pkgName: options.pkgName,
    spec: options.spec,
  })
  const patch = ensurePatchRow(profileDir, { pkgName: options.pkgName })
  const verified = verifyProfile(sourceDir, profileDir)
  return { synced, manifest, patch, verified }
}
