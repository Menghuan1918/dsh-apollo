/**
 * dsh-apollo (npm: @menghuan1918/dsh-apollo) —— 正式插件配置（Config）与配置读取/规整。
 *
 * 这里是本包「设置」的唯一事实源。宿主行 `apollo-skills` 由 `src/index.js`
 * 重新导出本文件的 `Config`（schemastery schema），DSH 据此校验并解析行配置：
 *
 *   - 标了 `.volatile()` 的字段在配置变更时**不重挂插件**——Loader 只把新值写回
 *     运行中 fiber 的稳定引用（`createVolatile` 协议 + `loader/volatile-update`），
 *     消费方每次读取都拿到最新值。退出守卫按回合读取、CLI 子代理路由按次读取，
 *     因此这些开关无需重启或重挂即可即时生效。
 *   - `declareOwnsHost` 可在表单保存，但 index tap 在装配时读取，需重载
 *     profile 并刷新页面才应用；`trustedHosts` 仅为旧 profile 装载保留。
 *
 * 0.5.0 的所有权边界：
 *   - **仍在运行时使用**：`exitGuard`（只控制运行中后台 job 的退出守卫）与
 *     `declareOwnsHost`（宿主部署标志）。行配置页展示 `exitGuard`，并把
 *     `declareOwnsHost` 收在「连接与访问」折叠组。
 *   - **deprecated、运行时不再读取**：`tiers.*`、`subagents.*`、`trustedHosts`。
 *     它们只保留旧默认值，让 0.4.x 的 profile 能正常装载；`src/migrate.js`
 *     在启动后把用户值一次性补进 dsh-better-subagent 的同名路径
 *     （`exitGuard` → `childExitGuard`），之后这些字段保持惰性，客户端也不把
 *     它们当作可用的子代理设置。不要新增消费方。
 *
 * 可编辑范围（volatile，即 dsh-settings 投影出的行配置表单字段）：
 * `exitGuard`、以及 deprecated 的 `tiers.*` / `subagents.*`。表单写入只能落在
 * volatile 路径上（dsh-settings 会拒绝其他路径）；`declareOwnsHost` 也可编辑。
 *
 * 持久化：DSH 的 configEditor 把表单写入落到活动 profile 的 cordis.patch.yml
 * （本行 id 的 `config` 覆盖层），不再有 `<dshHome>/eng.json` 写入路径；旧文件
 * 只由 `src/settings.js` 一次性只读导入。
 *
 * 读取入口：
 *   - `normalizeConfig(value)`——把任意来源（volatile 引用、解析后的配置、旧
 *     JSON、残缺对象）规整成**普通 JSON**，形状 EXACT 且与 `DEFAULT_CONFIG`
 *     一致；一切非法值回退默认，绝不抛错。
 *   - `currentConfig(ctx, fallback)`——经 configEditor 找到本行的活 fiber，读取
 *     其已解析配置并规整（volatile 引用按当前值展开）；找不到时退回 `fallback`
 *     （默认形状）。预设本地守卫与 CLI 路由用它读活配置。
 */

import z from '@deepseek-ai/schemastery'

/** 本包在 profile roster 里的行 id；也是 dsh-settings 的命名空间（= Loader entry id）。 */
export const ENTRY_ID = 'apollo-skills'
/** 包的 npm 名（scoped）。 */
export const PACKAGE_NAME = '@menghuan1918/dsh-apollo'
/**
 * 旧 unscoped 包名。只用于旧 profile 的 config slot 兼容（浏览器半边并排注册
 * 旧键）；新的 bundle 行、模块 specifier 与 client closure id 一律用 PACKAGE_NAME。
 */
export const LEGACY_PACKAGE_NAME = 'dsh-apollo'
/** 浏览器半边注册 `plugins.row.config` 用的键：`<包名>#<行 id>`。 */
export const ROW_CONFIG_KEY = `${PACKAGE_NAME}#${ENTRY_ID}`
/** 旧包名对应的行配置键；仅与 {@link ROW_CONFIG_KEY} 并排注册以兼容旧 profile。 */
export const LEGACY_ROW_CONFIG_KEY = `${LEGACY_PACKAGE_NAME}#${ENTRY_ID}`

/** Codex CLI 沙箱/权限档（对应 `codex --sandbox <值>` 一族）。 */
export const CODEX_PERMISSION_MODES = Object.freeze(['read-only', 'workspace-write', 'danger-full-access'])
/** Claude Code CLI 权限档（`claude --permission-mode` 的实测 help 取值；没有 `default`）。 */
export const CLAUDE_PERMISSION_MODES = Object.freeze(['plan', 'manual', 'dontAsk', 'acceptEdits', 'auto', 'bypassPermissions'])

/** 默认可执行文件名（**不写死本机路径**：从 PATH 解析，找不到由用户在设置里手输）。 */
export const DEFAULT_CODEX_EXECUTABLE = 'codex'
/** @see DEFAULT_CODEX_EXECUTABLE */
export const DEFAULT_CLAUDE_EXECUTABLE = 'claude'

/** cosmokit volatile 引用的写入符号（全局符号注册表，跨包副本一致）。 */
const VOLATILE_WRITE = Symbol.for('cosmokit.volatile.write')

/** 后端默认值表（两个 CLI 的差异只有可执行文件名、权限档与 profile 字段）。 */
const BACKENDS = Object.freeze({
  codex: Object.freeze({
    executable: DEFAULT_CODEX_EXECUTABLE,
    permissionMode: 'read-only',
    permissionModes: CODEX_PERMISSION_MODES,
    profile: true,
  }),
  claude: Object.freeze({
    executable: DEFAULT_CLAUDE_EXECUTABLE,
    permissionMode: 'plan',
    permissionModes: CLAUDE_PERMISSION_MODES,
    profile: false,
  }),
})

/** 一个后端的一个模型条目：id + 允许的 effort 列表 + 默认 effort。 */
const ModelSchema = z.object({
  id: z.string().required(),
  efforts: z.array(z.string()).default([]),
  defaultEffort: z.string().default(''),
})

/** 一个 CLI 后端的可编辑配置（整体 volatile：任一字段变更都不重挂）。 */
function backendSchema(spec) {
  const dict = {
    enabled: z.boolean().default(false),
    executable: z.string().default(spec.executable),
  }
  if (spec.profile) dict.profile = z.string().default('')
  dict.permissionMode = z.union(spec.permissionModes).default(spec.permissionMode)
  dict.defaultModel = z.string().default('')
  dict.models = z.array(ModelSchema).default([])
  return z.object(dict).volatile()
}

/** 子代理模型分档的一档：provider/model 为空表示沿用父会话路由。 */
const TierSchema = z.object({
  provider: z.string().default(''),
  model: z.string().default(''),
  reasoningEffort: z.string().default(''),
}).volatile()

/** 分档名（提示词按此顺序渲染）。 */
export const TIER_NAMES = Object.freeze(['fast', 'quality'])

/**
 * 本插件行的正式配置 schema。
 *
 * `exitGuard` 与 deprecated 的 `subagents.{eng,global}`、`subagents.{codex,claude}`
 * 标 volatile（即时生效、不重挂）；`trustedHosts`（deprecated）与
 * `declareOwnsHost` 是普通部署标志（改动重挂本行后生效）。
 */
export const Config = z.object({
  /**
   * 退出守卫总开关（默认关闭）：只控制运行中**后台 job** 的拦截。
   * 运行中子代理的拦截由 dsh-better-subagent 的 childExitGuard 拥有。
   */
  exitGuard: z.boolean().default(false).volatile(),
  /**
   * @deprecated 0.5.0 起重命名为 dsh-better-subagent 的 `tiers.*`，本字段只供
   * 迁移读取；运行时提示词不再从这里生成。保留旧默认值以装载旧 profile。
   */
  tiers: z.object({
    fast: TierSchema,
    quality: TierSchema,
  }),
  /**
   * @deprecated 0.5.0 起由 dsh-better-subagent 拥有同名字段；这里只为旧 profile
   * 装载与一次性迁移保留。运行时（CLI 路由、范围判断、提示词）不再读取。
   */
  subagents: z.object({
    /** 工程模式预设（`eng`/`eng-ptc`）可见这些后端。 */
    eng: z.boolean().default(true).volatile(),
    /** 所有预设可见这些后端。 */
    global: z.boolean().default(false).volatile(),
    codex: backendSchema(BACKENDS.codex),
    claude: backendSchema(BACKENDS.claude),
  }),
  /**
   * @deprecated 0.5.0 起由 dsh-better-subagent 的 `trustedHosts` 拥有（只约束
   * 该插件的只读接口）；这里只为旧 profile 装载与迁移保留，Apollo 不再注册
   * HTTP 路由，字段在运行时无效。
   */
  trustedHosts: z.array(z.string()).default([]),
  /** 注入 `__DSH_TRANSPORT__.ownsHost` 让官方 client 把反代页面当 loopback（默认关闭）。 */
  declareOwnsHost: z.boolean().default(false).volatile(),
})

// ── 规整（volatile 引用 → 普通 JSON）────────────────────────────────────────

/** 是否是 cosmokit volatile 引用（跨库副本按共享符号识别）。 */
function isVolatileRef(value) {
  return typeof value === 'object' && value !== null
    && typeof value.get === 'function' && VOLATILE_WRITE in value
}

/** 递归展开 volatile 引用，返回与输入同形的普通 JSON 数据。 */
function plain(value) {
  if (isVolatileRef(value)) return plain(value.get())
  if (Array.isArray(value)) return value.map((entry) => plain(entry))
  if (value !== null && typeof value === 'object') {
    const result = {}
    for (const [key, entry] of Object.entries(value)) result[key] = plain(entry)
    return result
  }
  return value
}

/** 是否是普通数据对象（数组、null、类实例都不算）。 */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 布尔读取：非布尔一律回退默认。 */
function booleanOf(value, fallback) {
  return typeof value === 'boolean' ? value : fallback
}

/** 字符串读取：非字符串或空串回退默认；否则去首尾空白。 */
function stringOf(value, fallback) {
  if (typeof value !== 'string') return fallback
  const trimmed = value.trim()
  return trimmed === '' ? fallback : trimmed
}

/** 枚举读取：不在允许集合内一律回退默认。 */
function oneOf(value, allowed, fallback) {
  return typeof value === 'string' && allowed.includes(value) ? value : fallback
}

/** 字符串数组读取：丢弃非字符串/空串，去重并保持顺序。 */
function stringList(value) {
  if (!Array.isArray(value)) return []
  const result = []
  for (const entry of value) {
    if (typeof entry !== 'string') continue
    const trimmed = entry.trim()
    if (trimmed === '' || result.includes(trimmed)) continue
    result.push(trimmed)
  }
  return result
}

/**
 * 模型列表读取：丢弃无 id 的条目与重复 id，`efforts` 去重，`defaultEffort`
 * 只在属于该模型 `efforts` 时保留（否则清空——消费方会拒绝不一致的组合）。
 */
function modelsOf(value) {
  if (!Array.isArray(value)) return []
  const result = []
  const seen = new Set()
  for (const entry of value) {
    if (!isRecord(entry)) continue
    const id = stringOf(entry.id, '')
    if (id === '' || seen.has(id)) continue
    seen.add(id)
    const efforts = stringList(entry.efforts)
    const defaultEffort = stringOf(entry.defaultEffort, '')
    result.push({
      id,
      efforts,
      defaultEffort: efforts.includes(defaultEffort) ? defaultEffort : '',
    })
  }
  return result
}

/** 一个后端对象读取。 */
function backendOf(value, spec) {
  const source = isRecord(value) ? value : {}
  const backend = {
    enabled: booleanOf(source.enabled, false),
    executable: stringOf(source.executable, spec.executable),
  }
  if (spec.profile) backend.profile = stringOf(source.profile, '')
  backend.permissionMode = oneOf(source.permissionMode, spec.permissionModes, spec.permissionMode)
  backend.defaultModel = stringOf(source.defaultModel, '')
  backend.models = modelsOf(source.models)
  return backend
}

/** 一档读取：provider 或 model 任一为空则整档清空（= 沿用父会话路由）。 */
function tierOf(value) {
  const source = isRecord(value) ? value : {}
  const provider = stringOf(source.provider, '')
  const model = stringOf(source.model, '')
  if (provider === '' || model === '') return { provider: '', model: '', reasoningEffort: '' }
  return { provider, model, reasoningEffort: stringOf(source.reasoningEffort, '') }
}

/**
 * 把任意配置来源规整成普通 JSON（形状 EXACT，非法值回退默认）。
 *
 * 输入可以是 `entry.fiber.config`（volatile 字段是引用对象）、旧 JSON 文档、
 * 残缺对象或 `undefined`；返回值总是全新的、可安全改写的普通对象。
 * @param config - 任意配置值。
 * @returns `{ exitGuard, tiers: { fast, quality }, subagents: { eng, global, codex, claude }, trustedHosts, declareOwnsHost }`。
 */
export function normalizeConfig(config) {
  const projected = plain(config)
  const source = isRecord(projected) ? projected : {}
  const subagents = isRecord(source.subagents) ? source.subagents : {}
  const tiers = isRecord(source.tiers) ? source.tiers : {}
  return {
    exitGuard: booleanOf(source.exitGuard, false),
    tiers: { fast: tierOf(tiers.fast), quality: tierOf(tiers.quality) },
    subagents: {
      eng: booleanOf(subagents.eng, true),
      global: booleanOf(subagents.global, false),
      codex: backendOf(subagents.codex, BACKENDS.codex),
      claude: backendOf(subagents.claude, BACKENDS.claude),
    },
    trustedHosts: stringList(source.trustedHosts),
    declareOwnsHost: booleanOf(source.declareOwnsHost, false),
  }
}

/** 默认配置形状（`normalizeConfig(undefined)` 的结果）。 */
export const DEFAULT_CONFIG = normalizeConfig(undefined)

// ── 活配置读取 ──────────────────────────────────────────────────────────────

/**
 * 读取一个可选服务：`ctx.get(name)` 不要求 inject 且不会抛错（预设本地插件
 * 用它读宿主服务），`ctx[name]` 只在没注入时会抛——两层都包住。
 * @param ctx - 任意插件上下文。
 * @param name - 服务名。
 * @returns 服务实例，或 undefined。
 */
function readService(ctx, name) {
  if (ctx === undefined || ctx === null) return undefined
  try {
    if (typeof ctx.get === 'function') {
      const service = ctx.get(name)
      if (service !== undefined && service !== null) return service
    }
  } catch {
    // 服务不可见（未注入/隔离/未激活）→ 退回属性读取。
  }
  try {
    return ctx[name]
  } catch {
    return undefined
  }
}

/**
 * 经 configEditor 找到本行的活 entry（按行 id，其次按新包名，最后按旧包名）。
 * @param ctx - 任意插件上下文。
 * @returns Loader entry，或 undefined。
 */
export function liveConfigEntry(ctx) {
  const editor = readService(ctx, 'configEditor')
  if (editor === undefined || typeof editor.entries !== 'function') return undefined
  try {
    const entries = editor.entries()
    if (!Array.isArray(entries)) return undefined
    return entries.find((row) => row?.options?.id === ENTRY_ID)
      ?? entries.find((row) => row?.options?.name === PACKAGE_NAME)
      ?? entries.find((row) => row?.options?.name === LEGACY_PACKAGE_NAME)
  } catch {
    return undefined
  }
}

/**
 * 读取本行的**活**配置并规整（volatile 引用按当前值展开）。
 *
 * 配置缺失、configEditor 不可见或 entry 已被替换时返回 `fallback` 的规整值
 * （默认形状），绝不抛错——调用方是回合结束/子代理路径，不能因配置故障崩。
 * @param ctx - 插件上下文（预设守卫可直接用 `ctx.get('configEditor')` 读，无需 inject）。
 * @param fallback - 找不到活 entry 时使用的配置来源（通常是 apply 收到的 config）。
 * @returns 规整后的普通 JSON 配置。
 */
export function currentConfig(ctx, fallback) {
  const entry = liveConfigEntry(ctx)
  if (entry === undefined) return normalizeConfig(fallback)
  return normalizeConfig(entry.fiber?.config ?? fallback)
}
