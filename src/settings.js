/**
 * dsh-apollo —— 设置装配（src/settings.js）。
 *
 * 本文件负责两件「必须等到服务可用才能做」的事，以及一次性的旧配置迁移：
 *
 * 1. **只读能力路由**：`ctx.inject(['webServer'])` → 注册
 *    `/apollo/api/capabilities`（处理器与探针在 `src/panel.js`，一处注册避免
 *    webServer 的重复 (kind,path) 抛错）。headless 组合没有 webServer 就自然
 *    跳过，面板装配照常返回。
 *
 * 2. **行配置页面策略**：`ctx.inject(['settings'])` → 在本插件实例上登记
 *    `configure({ auto: false }, ctx.fiber)`：本行自带配置页（浏览器半边的
 *    `plugins.row.config`）就是它唯一的编辑入口，不需要 DSH 再按 schema 自动
 *    生成一页。策略随本行的 effect 生命周期增删。
 *
 * 3. **旧 eng.json / atlas.json 一次性只读导入**：DSH 0.2 起设置就是正式
 *    Config（volatile，见 `src/config.js`），落盘由 configEditor 写进活动
 *    profile 的 cordis.patch.yml；`<dshHome>/eng.json` 与旧名 `atlas.json`
 *    不再被写入（**只读**），但第一次装配时会把里面的 `exitGuard` 搬进正式
 *    配置，之后旧的读取路径（预设本地守卫）即使被删也不丢开关。
 *
 *    迁移规则：
 *      - 只在 `settings` 服务可用、且 Loader 已把所有 entry 装配完（本行 fiber
 *        进入 active，`describe()` 才认得它）之后跑一次；
 *      - **当前 profile 显式给出的值优先**：`exitGuard` 已存在于用户层（哪怕是
 *        显式 `false`）时不覆盖——判断「存在」而不是「等于」，与 dsh-settings
 *        的 override 语义一致；
 *      - 值已经与生效值相同（等于 schema 默认）时不写盘，避免制造无意义的
 *        profile 覆盖层；
 *      - 旧文件永不改写、永不删除；导入失败只告警，不影响插件装载。
 *
 * 持久化与生效：写入经 `settings.update`（= configEditor 校验完整候选后落盘 +
 * Loader 调和）。因为 `exitGuard` 是 volatile 字段，写入不会重挂本行，运行中的
 * 消费方（预设守卫、CLI 路由）下一次读取即拿到新值。
 *
 * 零第三方依赖：只用 node 内置模块 + 本包 `src/config.js`。
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ENTRY_ID } from './config.js'
import { resolveDshHome } from './dsh-home.js'
import { installOwnsHostTap, registerCapabilitiesRoute } from './panel.js'

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
 * @returns `{ imported, reason, file?, patch? }`（不抛错，失败信息只用于日志）。
 */
export async function importLegacyConfig(ctx, env = process.env) {
  const legacy = readLegacyDocument(env)
  if (legacy === undefined) return { imported: false, reason: 'absent' }
  const settings = ctx.settings
  if (typeof settings?.describe !== 'function' || typeof settings.update !== 'function') {
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
 * 装配设置侧：延迟注册只读能力路由、登记行配置页面策略、一次性导入旧配置。
 *
 * 由宿主行（`src/index.js` 的 `apply`）调用。所有动作都延迟到服务出现时进行：
 * 没有 webServer / settings 的组合里本函数安静返回，插件其余部分照常工作。
 * @param ctx - 插件上下文。
 * @param config - 行配置（可能含 volatile 引用）。
 * @param options - 注入点（测试用）：`env`、`route`（探针依赖，透传
 *   {@link registerCapabilitiesRoute}）。
 */
export function mountSettings(ctx, config, options = {}) {
  const env = options.env ?? process.env

  // 反代部署标志：宿主行只调 mountSettings 时也必须装上（否则设置镜像降级 memory）。
  installOwnsHostTap(ctx, config)

  ctx.inject(['webServer'], (webCtx) => {
    registerCapabilitiesRoute(webCtx, () => config, options.route)
  })

  let started = false
  ctx.inject(['settings'], (settingsCtx) => {
    // 行配置页面策略：本行自带配置页，不需要自动生成的一页。
    try {
      const dispose = settingsCtx.settings.configure({ auto: false }, ctx.fiber)
      settingsCtx.effect(() => dispose, 'apollo-settings: row config page policy')
    } catch (error) {
      settingsCtx.logger?.warn?.(`apollo-settings: settings page policy was not registered: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (started) return
    started = true
    void importLegacyConfig(settingsCtx, env).then((result) => {
      if (result.imported) {
        settingsCtx.logger?.info?.(`apollo-settings: imported ${result.file} into the ${ENTRY_ID} config (exitGuard=${String(result.patch.exitGuard)})`)
      }
    }, (error) => {
      settingsCtx.logger?.warn?.(`apollo-settings: legacy config import skipped: ${error instanceof Error ? error.message : String(error)}`)
    })
  })
}
