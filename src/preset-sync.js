/**
 * 预设同步：把包内 `presets/` 下的每个预设目录幂等同步进 dsh agent-presets
 * 发现根（harness home 的 `.agent-presets`），并解析该发现根所在的 DSH home。
 *
 * 为什么需要同步：DSH 的预设发现根是硬约束——只有内置根（随 dsh 安装）与
 * 用户根（`<dshHome>/.agent-presets`）会被扫描，profile patch 无法新增预设
 * 根。因此插件包自带的预设只能在上电时写进用户根。模式参照 dsh-web 生态的
 * dsh-liangshen（https://github.com/zhu1090093659/dsh-web）的 sync-on-boot。
 *
 * 一个预设 = 一个持有 `agent.cordis.yml` 的目录，目录名即预设 id。同步按
 * 目录进行且幂等：目标树与源树逐字节相同时跳过（`current`），否则整体复制并
 * 删除源树不含的多余目标文件。插件不拥有的目录（用户自建的其他预设）绝不
 * 触碰。`retire` 列出插件曾经拥有、如今不再发布的预设 id，源树缺失时从目标
 * 根删除。
 *
 * 零依赖（只用 node 内置模块），宿主插件因此可以从任意位置加载而无需
 * bare import 解析。
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative } from 'node:path'

/**
 * 解析 DSH home 目录：DSH_HOME 环境变量优先（`~` 展开、相对路径基于进程
 * CWD），缺省 `<home>/.dsh`。
 * @param env - 读取 DSH_HOME 的进程环境（测试注入点）。
 * @param home - 平台 home 目录回退（测试注入点）。
 * @returns 绝对 DSH home 路径。
 */
export function resolveDshHome(env = process.env, home = homedir()) {
  const raw = env.DSH_HOME
  if (raw !== undefined && raw.trim() !== '') {
    const trimmed = raw.trim()
    const expanded = trimmed === '~' ? home
      : trimmed.startsWith('~/') || trimmed.startsWith('~\\') ? join(home, trimmed.slice(2))
      : trimmed
    return isAbsolute(expanded) ? expanded : join(process.cwd(), expanded)
  }
  return join(home, '.dsh')
}

/** 从当前环境解析 DSH home 目录。 */
export function dshHome() {
  return resolveDshHome()
}

/**
 * 一次同步运行的分类结果：
 * - `synced`：本次写入的预设 id；
 * - `current`：已与源一致的预设 id；
 * - `failed`：复制失败的预设 id 及原因；
 * - `retired`：本次从目标根删除的过期预设 id。
 * @typedef {Object} SyncResult
 * @property {string[]} synced
 * @property {string[]} current
 * @property {{id: string, error: string}[]} failed
 * @property {string[]} retired
 */

function filesUnder(root) {
  const out = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry)
      if (statSync(path).isDirectory()) walk(path)
      else out.push(path)
    }
  }
  walk(root)
  return out
}

/** 文件身份即内容：大小不同即判不同，否则逐字节比较。不用 mtime 快路径——复制会刷新 mtime，不作判据。 */
function sameFile(a, b) {
  const sa = statSync(a)
  const sb = statSync(b)
  if (sa.size !== sb.size) return false
  return readFileSync(a).equals(readFileSync(b))
}

/** 复制 `sourceDir` 整棵树到 `targetDir`（先建目录，按条目逐项复制）。 */
function copyTreeSync(sourceDir, targetDir) {
  mkdirSync(targetDir, { recursive: true })
  for (const entry of readdirSync(sourceDir)) {
    const source = join(sourceDir, entry)
    const target = join(targetDir, entry)
    if (statSync(source).isDirectory()) copyTreeSync(source, target)
    else copyFileSync(source, target)
  }
}

/** 删除 `root` 下不在 `keep`（相对路径集合）中的文件，再清理因此空出的目录。 */
function pruneExtras(root, keep) {
  const parents = new Set()
  for (const file of filesUnder(root)) {
    if (!keep.has(relative(root, file))) {
      parents.add(dirname(file))
      rmSync(file, { force: true })
    }
  }
  for (const start of parents) {
    let dir = start
    while (dir !== undefined && relative(root, dir) !== '') {
      if (existsSync(dir) && readdirSync(dir).length === 0) {
        rmSync(dir, { recursive: true, force: true })
        dir = dirname(dir)
      } else {
        dir = undefined
      }
    }
  }
}

/** 复制 `sourceDir/<id>` 到 `targetDir/<id>`，幂等；返回 'synced' 或 'current'。 */
export function syncOnePreset(sourceDir, targetDir) {
  const sourceFiles = filesUnder(sourceDir)
  const sourceSet = new Set(sourceFiles.map((file) => relative(sourceDir, file)))

  if (existsSync(targetDir) && !statSync(targetDir).isDirectory()) {
    rmSync(targetDir, { recursive: true, force: true })
  }
  if (!existsSync(targetDir)) {
    copyTreeSync(sourceDir, targetDir)
    return 'synced'
  }

  let dirty = false
  for (const file of sourceFiles) {
    const dest = join(targetDir, relative(sourceDir, file))
    if (!existsSync(dest) || !sameFile(file, dest)) {
      dirty = true
      break
    }
  }
  if (!dirty) {
    for (const file of filesUnder(targetDir)) {
      if (!sourceSet.has(relative(targetDir, file))) {
        dirty = true
        break
      }
    }
  }
  if (!dirty) return 'current'

  // 必须先 prune 再 copy：目标侧可能残留与源文件同名的多余目录（或反之），
  // 不先清掉类型冲突项，copyFileSync 会以 EISDIR/ENOTDIR 失败；prune 会连带
  // 清掉因此空出的目录。copy 之后不再二次 prune——目标内容由源树决定，
  // 同输入的二次 prune 必然无操作。
  pruneExtras(targetDir, sourceSet)
  copyTreeSync(sourceDir, targetDir)
  return 'synced'
}

/**
 * 同步 `sourceRoot` 下每个预设目录到 `targetRoot`，并按 `retire` 删除插件
 * 不再发布的预设。只操作插件拥有的预设 id，其他目录不动。
 * @param sourceRoot - 包内预设树（本包的 `presets/`）。
 * @param targetRoot - dsh agent-presets 发现根（如 `<dshHome>/.agent-presets`）。
 * @param retire - 源树缺失时应从目标根删除的预设 id 列表。
 * @returns 分类结果。
 */
export function syncPresetTrees(sourceRoot, targetRoot, retire = []) {
  const result = { synced: [], current: [], failed: [], retired: [] }
  mkdirSync(targetRoot, { recursive: true })
  if (existsSync(sourceRoot)) {
    for (const entry of readdirSync(sourceRoot)) {
      const source = join(sourceRoot, entry)
      if (!statSync(source).isDirectory()) continue
      const id = basename(source)
      try {
        const outcome = syncOnePreset(source, join(targetRoot, id))
        ;(outcome === 'synced' ? result.synced : result.current).push(id)
      } catch (error) {
        result.failed.push({ id, error: error instanceof Error ? error.message : String(error) })
      }
    }
  }
  for (const id of retire) {
    if (existsSync(join(sourceRoot, id))) continue
    const stale = join(targetRoot, id)
    if (existsSync(stale) && statSync(stale).isDirectory()) {
      rmSync(stale, { recursive: true, force: true })
      result.retired.push(id)
    }
  }
  return result
}
