/**
 * dsh-apollo —— 设置装配（src/settings.js）。
 *
 * 0.5.0 起 Apollo 不再注册任何 HTTP 路由：子代理能力/模型/路由探针与
 * `/apollo/api/*` 别名由 dsh-better-subagent 拥有，compact 诊断由
 * dsh-better-compact 拥有。重复注册同一 `(kind, path)` 会让 webServer 抛错，
 * 所以这里必须保持“零路由”。
 *
 * 本文件只做三件需要等服务的事情：
 *
 * 1. **反代部署标志**：`installOwnsHostTap`（`src/owns-host.js`）在行配置
 *    `declareOwnsHost: true` 时注入 index boot 全局。
 *
 * 2. **行配置页面策略**：`ctx.inject(['settings'])` → 在本插件实例上登记
 *    `configure({ auto: false }, ctx.fiber)`：本行自带的最小配置页就是唯一
 *    编辑入口，不需要 DSH 再按 schema 自动生成一页。策略随本行的 effect
 *    生命周期增删。
 *
 * 3. **旧 eng.json / atlas.json 一次性只读导入**：DSH 0.2 起设置就是正式
 *    Config（volatile，见 `src/config.js`）。`<dshHome>/eng.json` 与旧名
 *    `atlas.json` 不再被写入（**只读**），但第一次装配时会把里面的
 *    `exitGuard` 搬进正式配置。0.5.0 后这个 `exitGuard` 是 **job/通用守卫**
 *    的开关；同一个初值再由迁移模块复制到 dsh-better-subagent 的
 *    `childExitGuard`（旧组合开关拆成两个可独立配置的开关）。
 *
 *    迁移规则：
 *      - 只在 `settings` 服务可用、且 Loader 已把所有 entry 装配完（本行
 *        fiber 进入 active，`describe()` 才认得它）之后跑一次；
 *      - **当前 profile 显式给出的值优先**：`exitGuard` 已存在于用户层（哪怕
 *        是显式 `false`）时不覆盖；
 *      - 值已经与生效值相同（等于 schema 默认）时不写盘；
 *      - 旧文件永不改写、永不删除；导入失败只告警，不影响插件装载。
 *
 * 持久化与生效：写入经 `settings.update`（= configEditor 校验完整候选后落盘 +
 * Loader 调和）。因为 `exitGuard` 是 volatile 字段，写入不会重挂本行。
 *
 * 零第三方依赖：只用 node 内置模块 + 本包 `src/config.js` / `src/owns-host.js`。
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ENTRY_ID } from './config.js'
import { resolveDshHome } from './dsh-home.js'
import { installOwnsHostTap } from './owns-host.js'

/** 旧配置文件名，按优先级排列（新名优先，旧名只读回退）。 */
export const LEGACY_FILES = Object.freeze(['eng.json', 'atlas.json'])

/** 读取一个 JSON 文件并确保顶层是普通对象；缺失/损坏/形状非法返回 undefined。 */
function readJsonObject(path) {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'))
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
    return raw
  } catch {
    return undefined
  }
}

/** 是否是普通数据对象。 */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 用户层里是否显式写了这个字段（存在即为覆盖，与值无关）。 */
function hasOwn(value, key) {
  return isRecord(value) && Object.hasOwn(value, key)
}

/**
 * 读取旧运行时配置文档（只读）。
 *
 * `eng.json` 优先，缺失或损坏时回退旧名 `atlas.json`；两者都没有返回 undefined。
 * @param env - 读取 DSH_HOME 的进程环境（测试注入点）。
 * @returns `{ file, path, value }` 或 undefined。
 */
export function readLegacyDocument(env = process.env) {
  const home = resolveDshHome(env)
  for (const file of LEGACY_FILES) {
    const path = join(home, file)
    const value = readJsonObject(path)
    if (value !== undefined) return { file, path, value }
  }
  return undefined
}

/**
 * 由旧文档算出要写进正式配置的补丁（纯函数，便于测试）。
 *
 * 目前唯一有对应关系的旧字段是 `exitGuard`（布尔）。规则：
 *   - 旧值不是布尔 → 不导入；
 *   - 用户层已显式给出 `exitGuard`（含显式 false）→ 不覆盖；
 *   - 生效值已与旧值相同 → 不写盘（避免无意义的 profile 覆盖层）。
 * @param raw - 旧文档内容。
 * @param user - 当前用户层（profile 覆盖层投影，仅含可编辑字段）。
 * @param value - 当前生效值（仅含可编辑字段）。
 * @returns 补丁对象；无需导入时为空对象。
 */
export function legacyPatch(raw, user, value) {
  const patch = {}
  if (typeof raw?.exitGuard !== 'boolean') return patch
  if (hasOwn(user, 'exitGuard')) return patch
  if (isRecord(value) && value.exitGuard === raw.exitGuard) return patch
  patch.exitGuard = raw.exitGuard
  return patch
}

/** 取 Loader 服务（用于等待所有 entry 装配完）；拿不到返回 undefined。 */
function loaderOf(ctx) {
  try {
    const direct = ctx.get?.('loader')
    if (typeof direct?.await === 'function') return direct
  } catch {
    // 未提供 loader（测试 fake ctx）→ 退回 root。
  }
  try {
    const root = ctx.root?.loader
    return typeof root?.await === 'function' ? root : undefined
  } catch {
    return undefined
  }
}

/**
 * 把旧文档里的字段一次性导入正式配置（需要 `settings` 服务）。
 *
 * 调用方保证「只调用一次」；本函数自身也幂等（用户层已有该字段就不写）。
 * @param ctx - 已注入 `settings` 的上下文。
 * @param env - 读取 DSH_HOME 的进程环境（测试注入点）。
 * @returns `{ imported, reason, file?, patch? }`（不抛错以外的失败信息只用于日志）。
 */
export async function importLegacyConfig(ctx, env = process.env) {
  const legacy = readLegacyDocument(env)
  if (legacy === undefined) return { imported: false, reason: 'absent' }
  const settings = ctx.settings
  if (typeof settings?.describe !== 'function' || typeof settings?.update !== 'function') {
    return { imported: false, reason: 'unavailable', file: legacy.file }
  }
  // Loader 装配完成后 describe() 才认得出本行（fiber 必须 active）。
  const loader = loaderOf(ctx)
  if (loader !== undefined) await loader.await()
  const descriptors = await settings.describe()
  const descriptor = Array.isArray(descriptors)
    ? descriptors.find((row) => row?.ns === ENTRY_ID)
    : undefined
  if (descriptor === undefined) return { imported: false, reason: 'not-configurable', file: legacy.file }
  const patch = legacyPatch(legacy.value, descriptor.user, descriptor.value)
  if (Object.keys(patch).length === 0) return { imported: false, reason: 'no-change', file: legacy.file }
  await settings.update(ENTRY_ID, patch, descriptor.revision)
  return { imported: true, file: legacy.file, patch }
}

/**
 * 装配设置侧：安装反代部署 tap、登记行配置页面策略、一次性导入旧配置。
 *
 * 由宿主行（`src/index.js` 的 `apply`）调用。所有动作都延迟到服务出现时进行：
 * 没有 webServer / settings 的组合里本函数安静返回，插件其余部分照常工作。
 * @param ctx - 插件上下文。
 * @param config - 行配置（可能含 volatile 引用）。
 * @param options - 注入点（测试用）：`env`。
 * @returns `{ legacyImport }`：旧配置导入结束时 resolve 的 Promise（失败也
 *   resolve，错误只记日志）。迁移模块用它保证先导入、再读取来源。
 */
export function mountSettings(ctx, config, options = {}) {
  const env = options.env ?? process.env

  // 反代部署标志：宿主行只调 mountSettings 时也必须装上。
  installOwnsHostTap(ctx, config)

  let settle
  const legacyImport = new Promise((resolve) => { settle = resolve })
  let started = false
  ctx.inject(['settings'], (settingsCtx) => {
    // 行配置页面策略：本行自带配置页，不需要自动生成的一页。
    try {
      const dispose = settingsCtx.settings.configure({ auto: false }, ctx.fiber)
      settingsCtx.effect(() => dispose, 'apollo-settings: row config page policy')
    } catch (error) {
      settingsCtx.logger?.warn?.(`apollo-settings: settings page policy was not registered: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (started) {
      settle()
      return
    }
    started = true
    void importLegacyConfig(settingsCtx, env).then((result) => {
      if (result.imported) {
        settingsCtx.logger?.info?.(`apollo-settings: imported ${result.file} into the ${ENTRY_ID} config (exitGuard=${String(result.patch.exitGuard)})`)
      }
    }, (error) => {
      settingsCtx.logger?.warn?.(`apollo-settings: legacy config import skipped: ${error instanceof Error ? error.message : String(error)}`)
    }).finally(settle)
  })
  return { legacyImport }
}
