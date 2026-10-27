/**
 * dsh-apollo (npm: @menghuan1918/dsh-apollo) —— 宿主半边只读面板（src/panel.js）。
 *
 * 注册仅限 loopback（或行配置 `trustedHosts` 列出的反向代理权威）+ 同源标志的
 * fenced HTTP 路由：
 *   - `/apollo/api/capabilities`——**能力探针**：两个 CLI 后端配置的可执行文件
 *     在 PATH 上的解析结果与版本、以及 Codex 的 profile 名称；
 *   - `/apollo/api/models?cli=codex|claude`——**模型自动发现**：Codex 读
 *     `codex debug models` 的 JSON catalog，Claude 读 Anthropic Messages 的
 *     `GET /v1/models`（凭据来自进程 env 或 Claude 设置文件，只在内存里用）；
 *   - `/apollo/api/routes`——**分档路由**：子代理模型选择白名单里的
 *     provider/model 及其 reasoning effort（供模型分档下拉框）。
 * 三者都供浏览器半边（`exports["./client"]` 的 `plugins.row.config` 页面）读取。
 *
 * 为什么是「能力」而不是「配置」：设置本身已经是正式 Config（volatile），读写
 * 走 DSH 自己的 configForms/行配置页面（`src/settings.js` 只做一次旧文件导入），
 * 不再需要本包自有的配置路由。这里只暴露**从本机探测出来的、设置表单无法自己
 * 知道**的事实——用户手输的可执行文件名到底解析到了哪里、版本是什么、Codex 有
 * 哪些 profile 可选。
 *
 * 暴露面（写死在契约里，测试守护）：
 *   capabilities：`{ executables: { codex: { executable, path, version }, claude: {...} },
 *      codexProfiles: string[] }`
 *   models：`{ cli, models: [{ id, efforts, defaultEffort }], source, error }`
 *     （`error` 只含 `code` 与可选 `status`）
 * **绝不返回配置正文，也绝不返回任何凭据**：只回可执行文件名/路径/版本行、
 * profile 名称、模型 id 与 effort；Claude 凭据只在本进程内拼进请求头。
 * 只读：GET 之外的方法一律 405，且从不读取请求体。
 *
 * 安全模型仍是 DNS-rebinding / 跨站防御而非认证（默认只信 loopback；经反向
 * 代理域名访问 GUI 时把该权威加入行配置 `trustedHosts`，后果上限是泄露本机
 * 上某个可执行文件的路径与版本号、或模型清单）。边界判定与 dsh-better-sidebar 的
 * src/trust-fence.ts 同源（其源头为 BSD-3-Clause 的
 * @deepseek-ai/dsh-client-connection api-request-trust + loopback-hostname）。
 *
 * 职责边界：路由的**注册**由 `src/settings.js` 的 `mountSettings` 负责（一处
 * 注册，避免 webServer 的重复 (kind,path) 抛错）；本文件提供处理器、探针与
 * `installOwnsHostTap`（`mountSettings` 会调用它，`mountPanel` 是兼容别名，
 * 同一上下文重复调用只装一次）。
 *
 * 零第三方依赖：只用 node 内置模块。
 */

import { execFile } from 'node:child_process'
import { accessSync, constants, readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, isAbsolute, join } from 'node:path'
import { currentConfig, normalizeConfig } from './config.js'

/** 宿主半边模块标识（用于 effect 标签与日志）。 */
export const name = 'apollo-panel'

/** 能力探针的完整路径。 */
export const CAPABILITIES_PATH = '/apollo/api/capabilities'
/** 注册在 webServer 上的前缀（精确路径由处理器自己校验）。 */
export const CAPABILITIES_PREFIX = '/apollo/api'

/** Codex 新版「一个 profile 一个文件」的后缀：`<CODEX_HOME>/<name>.config.toml`。 */
export const CODEX_PROFILE_SUFFIX = '.config.toml'

/** 版本探测的兜底超时（毫秒）。 */
export const VERSION_TIMEOUT_MS = 2000
/** 探针结果缓存时长（毫秒）：避免每次打开设置页都 fork 两个 CLI。 */
export const CAPABILITY_TTL_MS = 30_000
/** 版本行最大长度（防止 CLI 打印整段 banner）。 */
const VERSION_MAX_CHARS = 120
/** 合法的 profile 名（同时挡住路径分隔符，名称只会被当显示文本用）。 */
const PROFILE_NAME = /^[A-Za-z0-9._-]+$/

// ── 模型自动发现（/apollo/api/models）────────────────────────────────────────

/** 自动发现的完整路径（GET，查询参数 `cli=codex|claude`）。 */
export const MODELS_PATH = '/apollo/api/models'
/** 自动发现接受的 CLI（同时是查询参数取值）。 */
export const DISCOVERY_CLIS = Object.freeze(['codex', 'claude'])
/** 单次自动发现的兜底超时（毫秒）。 */
export const DISCOVERY_TIMEOUT_MS = 10_000
/** Codex 在线目录失败后 `--bundled` 离线兜底的超时（毫秒）。 */
export const DISCOVERY_FALLBACK_TIMEOUT_MS = 3_000
/** Claude `--effort` 的实测取值（`claude --help`；与 src/cli/claude.js 同步）。 */
export const CLAUDE_EFFORTS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max'])
/** Claude 发现结果的默认 effort：五档中偏上的安全值。 */
const CLAUDE_DEFAULT_EFFORT = 'high'
/** Anthropic Messages 的模型清单协议版本。 */
const ANTHROPIC_VERSION = '2023-06-01'
/** Anthropic 模型清单单页上限（与 DSH pi-ai 的发现实现一致）。 */
const ANTHROPIC_MODEL_LIMIT = 1000
/** 发现结果的数量与长度上限：清单来自本机 CLI 或用户配置的端点，不能无限长。 */
const MAX_MODELS = 200
const MAX_MODEL_ID_CHARS = 120
const MAX_EFFORT_CHARS = 32
const MAX_LISTING_BYTES = 4 * 1024 * 1024
/** 模型 id / effort 的安全字符集：argv 不经 shell，但仍拒绝空白、引号与控制字符。 */
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@+\[\]-]*$/
const EFFORT = /^[A-Za-z][A-Za-z0-9._-]*$/

// ── 子代理分档路由（/apollo/api/routes）──────────────────────────────────────

/** 分档下拉框数据源的完整路径（GET）。 */
export const ROUTES_PATH = '/apollo/api/routes'

/** 读一个宿主服务；不可见或抛错返回 undefined。 */
function hostService(ctx, name) {
  try { return ctx.get?.(name) ?? undefined } catch { return undefined }
}

/**
 * 列出子代理模型选择白名单里的路由及各自的 reasoning effort。
 *
 * 白名单来自宿主 `subagentModelSelection.current()`（「插件 → 子代理 → 模型
 * 选择」），effort 来自 `llm.resolveModelInfo`；单条解析失败只让该条 efforts
 * 为空，不影响其他条目。服务缺失或白名单非法时返回未启用的空清单。
 * @param ctx - 插件上下文。
 * @returns `{ enabled, routes: [{ provider, model, efforts, defaultEffort }] }`。
 */
export async function collectTierRoutes(ctx) {
  let selection
  try { selection = hostService(ctx, 'subagentModelSelection')?.current() } catch { selection = undefined }
  if (!isRecord(selection) || !Array.isArray(selection.allowedModels)) return { enabled: false, routes: [] }
  const llm = hostService(ctx, 'llm')
  const routes = await Promise.all(selection.allowedModels.map(async ({ provider, model }) => {
    try {
      const reasoning = (await llm?.resolveModelInfo?.(provider, model))?.reasoning
      const efforts = Array.isArray(reasoning?.efforts)
        ? reasoning.efforts.map((effort) => effort?.id).filter((id) => typeof id === 'string' && id !== '')
        : []
      const defaultEffort = efforts.includes(reasoning?.defaultEffort) ? reasoning.defaultEffort : ''
      return { provider, model, efforts, defaultEffort }
    } catch {
      return { provider, model, efforts: [], defaultEffort: '' }
    }
  }))
  return { enabled: selection.enabled === true, routes }
}

// ── 部署标志 tap ────────────────────────────────────────────────────────────

/**
 * 部署标志 tap：在 `<head>` 起始处注入 boot 全局 `__DSH_TRANSPORT__.ownsHost`，
 * 使官方 client 的 `connection.isLoopback` 判定为真。
 *
 * 背景：client 对「浏览器非 loopback 页面」把 settings 镜像/作用域设为 memory
 * （不可用），官方没有受信反代配置口。经反向代理多设备访问时，声明「页面拥有
 * 宿主」让设置读写回到 host 持久化——安全边界随反代信任，仅应在受信代理下
 * 开启（行配置 `declareOwnsHost: true`，默认关闭）。
 * 脚本位于所有 head 注入行之前，先于 boot 执行。
 * @param html - 渲染后的 index HTML。
 * @returns 插入了传输全局的 HTML。
 */
export function declareOwnsHostTap(html) {
  const script = '<script>globalThis.__DSH_TRANSPORT__={ownsHost:true}</script>'
  return /<head(?:\s[^>]*)?>/i.test(html)
    ? html.replace(/<head(?:\s[^>]*)?>/i, (open) => `${open}${script}`)
    : `${script}${html}`
}

/** 已经装过 tap 的插件上下文（防止 mountSettings 与 mountPanel 同时调用时装两次）。 */
const tappedContexts = new WeakSet()

/**
 * 装配 `declareOwnsHost` tap：行配置 `declareOwnsHost: true` 时给 index 注入
 * boot 全局（一次性；同一插件上下文重复调用只装一次）。
 *
 * 由 `src/settings.js` 的 `mountSettings` 调用——宿主行只调 mountSettings 与
 * mountSubagents 时 tap 也必须装上，否则反代部署下官方 client 会把设置镜像降级
 * 成 memory。
 * @param ctx - 插件上下文。
 * @param config - 行配置（可能含 volatile 引用）。
 */
export function installOwnsHostTap(ctx, config) {
  if (normalizeConfig(config).declareOwnsHost !== true) return
  if (ctx !== null && typeof ctx === 'object') {
    if (tappedContexts.has(ctx)) return
    tappedContexts.add(ctx)
  }
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => webCtx.webServer.tapIndex(declareOwnsHostTap), 'apollo-panel: declareOwnsHost tap')
  })
}

/**
 * 宿主半边装配入口（兼容保留）：等价于 {@link installOwnsHostTap}。
 *
 * 不注册 HTTP 路由——`/apollo/api/capabilities` 由 `src/settings.js` 的
 * `mountSettings` 注册（一处注册，headless 组合里没有 webServer 就自然跳过）。
 * 宿主行只调 `mountSettings` 即可；同时调用本函数也不会重复注入 tap。
 * @param ctx - 插件上下文。
 * @param config - 行配置（可能含 volatile 引用）。
 */
export function mountPanel(ctx, config) {
  installOwnsHostTap(ctx, config)
}

// ── 探针：PATH 解析 / 版本 / Codex profile 名 ───────────────────────────────

/** 展开 `~` 前缀（不解析其他 shell 语法）。 */
function expandHome(value, home) {
  if (value === '~') return home
  if (value.startsWith('~/') || value.startsWith('~\\')) return join(home, value.slice(2))
  return value
}

/** 是否是可执行普通文件（非 win32 要求 X_OK 位）。 */
function isExecutableFile(path) {
  try {
    if (!statSync(path).isFile()) return false
    if (process.platform !== 'win32') accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * 解析可执行文件：绝对/相对路径按路径校验，裸名字按 PATH 查找。
 *
 * 默认值只写命令名（`codex`/`claude`），**不写死本机路径**；用户可以在设置里
 * 手输绝对路径或 `~/...`。
 * @param executable - 配置里的可执行文件名或路径。
 * @param options - 注入点：`env`（PATH/CODEX_HOME）、`home`（`~` 展开）、`cwd`（相对路径基准）。
 * @returns 可执行文件的绝对路径，或 null。
 */
export function resolveExecutable(executable, options = {}) {
  const env = options.env ?? process.env
  const home = options.home ?? homedir()
  if (typeof executable !== 'string') return null
  const expanded = expandHome(executable.trim(), home)
  if (expanded === '') return null
  if (expanded.includes('/') || expanded.includes('\\')) {
    const candidate = isAbsolute(expanded) ? expanded : join(options.cwd ?? process.cwd(), expanded)
    return isExecutableFile(candidate) ? candidate : null
  }
  const extensions = process.platform === 'win32'
    ? String(env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter((entry) => entry !== '')
    : ['']
  for (const dir of String(env.PATH ?? '').split(delimiter)) {
    if (dir === '') continue
    for (const extension of extensions) {
      const candidate = join(dir, expanded + extension)
      if (isExecutableFile(candidate)) return candidate
    }
  }
  return null
}

/** 取第一行非空文本做版本号：剥掉控制字符并截断。 */
function parseVersion(text) {
  for (const raw of String(text ?? '').split('\n')) {
    const line = raw.replace(/[\u0000-\u001f\u007f]/g, '').trim()
    if (line === '') continue
    return line.slice(0, VERSION_MAX_CHARS)
  }
  return null
}

/**
 * 运行 `<path> --version` 取版本行（无 shell 展开，超时即杀）。
 *
 * 只有进程正常退出且确有输出时才返回版本；启动失败（EACCES/ENOEXEC/超时）
 * 返回 null——探针失败不该让整个能力接口失败。
 * @param path - 已解析的可执行文件路径。
 * @param options - `timeoutMs` 覆盖。
 * @returns 版本行，或 null。
 */
export function probeVersion(path, options = {}) {
  const timeoutMs = options.timeoutMs ?? VERSION_TIMEOUT_MS
  return new Promise((resolve) => {
    execFile(path, ['--version'], {
      timeout: timeoutMs,
      killSignal: 'SIGKILL',
      maxBuffer: 64 * 1024,
      windowsHide: true,
    }, (error, stdout, stderr) => {
      if (error !== null) {
        resolve(null)
        return
      }
      resolve(parseVersion(String(stdout ?? '')) ?? parseVersion(String(stderr ?? '')))
    })
  })
}

/** 读取一个文本文件的所有行；缺失或不可读返回空数组。 */
function readLines(path) {
  try {
    return readFileSync(path, 'utf8').split('\n')
  } catch {
    return []
  }
}

/** 是否是合法的 Codex profile 名（拒绝 `.`/`..`，名称只会当显示文本用）。 */
function isProfileName(value) {
  return typeof value === 'string' && value !== '' && value !== '.' && value !== '..' && PROFILE_NAME.test(value)
}

/**
 * 列出 Codex profile **名称**（不读内容、不回内容）。
 *
 * 两种来源都兼容：
 *   - 新版 `<CODEX_HOME>/<name>.config.toml`（一个 profile 一个文件）；
 *   - 旧版 `<CODEX_HOME>/config.toml` 里的 `[profiles.<name>]` 段。
 * `CODEX_HOME` 缺省 `<home>/.codex`。
 * @param options - 注入点：`env`、`home`。
 * @returns 排序去重后的 profile 名。
 */
export function listCodexProfiles(options = {}) {
  const env = options.env ?? process.env
  const home = options.home ?? homedir()
  const configured = typeof env.CODEX_HOME === 'string' ? env.CODEX_HOME.trim() : ''
  const dir = configured === '' ? join(home, '.codex') : expandHome(configured, home)
  const names = new Set()
  let entries = []
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    entries = []
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(CODEX_PROFILE_SUFFIX)) continue
    const candidate = entry.name.slice(0, -CODEX_PROFILE_SUFFIX.length)
    if (isProfileName(candidate)) names.add(candidate)
  }
  for (const line of readLines(join(dir, 'config.toml'))) {
    const match = /^\s*\[\s*profiles\s*\.\s*(?:"([^"]+)"|'([^']+)'|([^\]\s]+))\s*\]/.exec(line)
    if (match === null) continue
    const candidate = match[1] ?? match[2] ?? match[3] ?? ''
    if (isProfileName(candidate)) names.add(candidate)
  }
  return [...names].sort()
}

/** 同步调用并吞掉异常。 */
function attempt(run) {
  try {
    return run()
  } catch {
    return undefined
  }
}

/** 异步调用并吞掉异常（拒绝）。 */
async function attemptAsync(run) {
  try {
    return await run()
  } catch {
    return undefined
  }
}

/**
 * 采集能力探针数据（无缓存；`createCapabilitiesReader` 负责缓存）。
 *
 * 探针的每一步都独立失败：解析不到就是 `path: null`，版本取不到就是
 * `version: null`，profile 目录不存在就是空列表——接口本身不因本机缺一个 CLI
 * 而失败。
 * @param config - 当前配置（含 volatile 引用也可）。
 * @param deps - 注入点：`env`、`home`、`resolveExecutable`、`probeVersion`、
 *   `listCodexProfiles`、`versionTimeoutMs`。
 * @returns `{ executables, codexProfiles }`（普通 JSON）。
 */
export async function collectCapabilities(config, deps = {}) {
  const env = deps.env ?? process.env
  const home = deps.home ?? homedir()
  const resolve = deps.resolveExecutable ?? resolveExecutable
  const probe = deps.probeVersion ?? probeVersion
  const listProfiles = deps.listCodexProfiles ?? listCodexProfiles
  const options = { env, home }
  const backends = normalizeConfig(config).subagents
  const executables = {}
  for (const cli of ['codex', 'claude']) {
    const executable = backends[cli].executable
    const path = attempt(() => resolve(executable, options)) ?? null
    const version = path === null
      ? null
      : await attemptAsync(() => probe(path, { timeoutMs: deps.versionTimeoutMs ?? VERSION_TIMEOUT_MS })) ?? null
    executables[cli] = {
      executable,
      path: typeof path === 'string' && path !== '' ? path : null,
      version: typeof version === 'string' && version !== '' ? version : null,
    }
  }
  const profiles = attempt(() => listProfiles(options))
  return {
    executables,
    codexProfiles: Array.isArray(profiles) ? profiles.filter(isProfileName) : [],
  }
}

/** 探针缓存的键：两个可执行文件名 + PATH/CODEX_HOME/home 的变化都要失效。 */
function capabilityKey(config, deps) {
  const env = deps.env ?? process.env
  const backends = normalizeConfig(config).subagents
  return JSON.stringify([
    backends.codex.executable,
    backends.claude.executable,
    env.PATH ?? '',
    env.CODEX_HOME ?? '',
    deps.home ?? '',
  ])
}

/**
 * 造一个带 TTL 缓存与并发去重的探针读取器。
 *
 * 设置页每次挂载都会拉一次能力；同键的并发请求共享一次探测，TTL 内的重复
 * 请求直接回缓存，避免反复 fork CLI。
 * @param deps - 同 {@link collectCapabilities}，另加 `ttlMs`、`now`（测试注入）。
 * @returns `read(config)` → 探针数据。
 */
export function createCapabilitiesReader(deps = {}) {
  const ttlMs = deps.ttlMs ?? CAPABILITY_TTL_MS
  const now = deps.now ?? Date.now
  let entry
  let pending
  return async function read(config) {
    const key = capabilityKey(config, deps)
    if (entry !== undefined && entry.key === key && now() - entry.at < ttlMs) return entry.value
    if (pending !== undefined && pending.key === key) return pending.promise
    const promise = collectCapabilities(config, deps).then((value) => {
      entry = { key, at: now(), value }
      return value
    })
    pending = { key, promise }
    try {
      return await promise
    } finally {
      if (pending !== undefined && pending.promise === promise) pending = undefined
    }
  }
}

// ── 模型自动发现 ────────────────────────────────────────────────────────────

/** 普通数据对象（数组、null、类实例都不算）。 */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 规整模型 id：去空白、限长、拒绝空白/引号/控制字符。 */
function modelIdOf(value) {
  if (typeof value !== 'string') return null
  const id = value.trim()
  if (id === '' || id.length > MAX_MODEL_ID_CHARS || !MODEL_ID.test(id)) return null
  return id
}

/** 规整 effort 名：去空白、限长、拒绝空白/引号/控制字符。 */
function effortOf(value) {
  if (typeof value !== 'string') return null
  const effort = value.trim()
  if (effort === '' || effort.length > MAX_EFFORT_CHARS || !EFFORT.test(effort)) return null
  return effort
}

/**
 * 解析 `codex debug models` 的 JSON catalog。
 *
 * 只收 `visibility === 'list'` 的模型（隐藏条目是内部/评审模型）；id 取 `slug`；
 * effort 来自 `supported_reasoning_levels[].effort`，默认 effort 取
 * `default_reasoning_level`（不在列表里时退回第一个）。
 * @param text - 命令 stdout。
 * @returns 模型数组；JSON 不可解析时返回 null（调用方报 parse 错误）。
 */
export function parseCodexCatalog(text) {
  let parsed
  try {
    parsed = JSON.parse(String(text))
  } catch {
    return null
  }
  const entries = isRecord(parsed) && Array.isArray(parsed.models) ? parsed.models : []
  const models = []
  for (const entry of entries) {
    if (!isRecord(entry)) continue
    if (typeof entry.visibility === 'string' && entry.visibility !== 'list') continue
    const id = modelIdOf(entry.slug ?? entry.id)
    if (id === null || models.some((model) => model.id === id)) continue
    const efforts = []
    const levels = Array.isArray(entry.supported_reasoning_levels) ? entry.supported_reasoning_levels : []
    for (const level of levels) {
      if (!isRecord(level)) continue
      const effort = effortOf(level.effort)
      if (effort !== null && !efforts.includes(effort)) efforts.push(effort)
      if (efforts.length >= 16) break
    }
    const preferred = effortOf(entry.default_reasoning_level)
    models.push({
      id,
      efforts,
      defaultEffort: preferred !== null && efforts.includes(preferred) ? preferred : (efforts[0] ?? ''),
    })
    if (models.length >= MAX_MODELS) break
  }
  return models
}

/**
 * 解析 Anthropic Messages `GET /v1/models` 的响应。
 *
 * Claude CLI 本身没有模型清单命令，端点只回 id/display_name；effort 取
 * `claude --effort` 的固定五档，默认 high。
 * @param text - 响应正文。
 * @returns 模型数组；JSON 不可解析时返回 null。
 */
export function parseClaudeModelList(text) {
  let parsed
  try {
    parsed = JSON.parse(String(text))
  } catch {
    return null
  }
  const entries = isRecord(parsed) && Array.isArray(parsed.data) ? parsed.data : []
  const models = []
  for (const entry of entries) {
    if (!isRecord(entry)) continue
    const id = modelIdOf(entry.id)
    if (id === null || models.some((model) => model.id === id)) continue
    models.push({ id, efforts: [...CLAUDE_EFFORTS], defaultEffort: CLAUDE_DEFAULT_EFFORT })
    if (models.length >= MAX_MODELS) break
  }
  return models
}

/**
 * Anthropic 模型清单 URL：根路径去掉末尾 `/` 与一个末尾 `/v1`，再接 `/v1/models`
 * （兼容网关文档的两种写法；与 DSH pi-ai 的发现规则一致）。
 * @param baseURL - `ANTHROPIC_BASE_URL`（已去空白）。
 * @returns 清单 URL。
 */
export function anthropicListingUrl(baseURL) {
  const base = String(baseURL).trim().replace(/\/+$/, '')
  const root = base.endsWith('/v1') ? base.slice(0, -3) : base
  return `${root}/v1/models?limit=${String(ANTHROPIC_MODEL_LIMIT)}`
}

/** 读取 Claude 设置文件（可注入 readFile；缺失/坏 JSON 都当空对象）。 */
function readClaudeSettings(path, readFile) {
  try {
    const parsed = JSON.parse(String(readFile(path)))
    return isRecord(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

/**
 * 读取 Claude 的有效端点与凭据：`ANTHROPIC_BASE_URL` 逐键回退（进程 env →
 * Claude 用户设置 `<CLAUDE_CONFIG_DIR 或 ~/.claude>/settings.json` 的 `env`），
 * **凭据来源整体优先**——进程 env 里出现任一凭据时整套用 env 的凭据，否则整套
 * 用 settings；不把两边的 token/key 各取一半。
 *
 * **凭据只在内存里用于请求头，绝不进入响应**；本函数导出仅为测试。
 * @param options - `env`、`home`、`readFile` 注入点。
 * @returns `{ baseURL, authToken, apiKey }`（后两者可能为 undefined）。
 */
export function claudeApiConfig(options = {}) {
  const env = options.env ?? process.env
  const home = options.home ?? homedir()
  const readFile = options.readFile ?? ((file) => readFileSync(file, 'utf8'))
  const configured = typeof env.CLAUDE_CONFIG_DIR === 'string' && env.CLAUDE_CONFIG_DIR.trim() !== ''
    ? expandHome(env.CLAUDE_CONFIG_DIR.trim(), home)
    : join(home, '.claude')
  const settings = readClaudeSettings(join(configured, 'settings.json'), readFile)
  const settingsEnv = isRecord(settings.env) ? settings.env : {}
  const read = (source, key) => {
    const value = source[key]
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
  }
  const baseURL = read(env, 'ANTHROPIC_BASE_URL')
    ?? read(settingsEnv, 'ANTHROPIC_BASE_URL')
    ?? 'https://api.anthropic.com'
  const envToken = read(env, 'ANTHROPIC_AUTH_TOKEN')
  const envKey = read(env, 'ANTHROPIC_API_KEY')
  if (envToken !== undefined || envKey !== undefined) {
    return { baseURL, authToken: envToken, apiKey: envToken === undefined ? envKey : undefined }
  }
  const settingsToken = read(settingsEnv, 'ANTHROPIC_AUTH_TOKEN')
  return {
    baseURL,
    authToken: settingsToken,
    apiKey: settingsToken === undefined ? read(settingsEnv, 'ANTHROPIC_API_KEY') : undefined,
  }
}

/** Claude 请求头：AUTH_TOKEN 走 Bearer，API key 走 x-api-key；都没有返回 null。 */
function claudeAuthHeaders(api) {
  const headers = { accept: 'application/json', 'anthropic-version': ANTHROPIC_VERSION }
  if (api.authToken !== undefined) headers.authorization = `Bearer ${api.authToken}`
  else if (api.apiKey !== undefined) headers['x-api-key'] = api.apiKey
  else return null
  return headers
}

/** 统一成功结果。 */
function discovered(cli, models, source) {
  return { cli, models, source, error: null }
}

/** 统一失败结果（models 为空，error 只含 code/status）。 */
function discoveryFailed(cli, code, status) {
  return {
    cli,
    models: [],
    source: null,
    error: status === undefined ? { code } : { code, status },
  }
}

/**
 * 发现 Claude 模型：`GET {ANTHROPIC_BASE_URL}/v1/models`。
 *
 * 只读凭据来源与 CLI 相同（见 {@link claudeApiConfig}），但不 spawn CLI；
 * 响应有字节上限，错误只回 code/status，不回凭据或 URL。
 * @param deps - `env`、`home`、`readFile`、`fetch`、`timeoutMs` 注入点。
 * @returns `{ cli, models, source, error }`。
 */
export async function discoverClaudeModels(deps = {}) {
  const api = claudeApiConfig(deps)
  const headers = claudeAuthHeaders(api)
  if (headers === null) return discoveryFailed('claude', 'no-credentials')
  const fetcher = deps.fetch ?? globalThis.fetch
  if (typeof fetcher !== 'function') return discoveryFailed('claude', 'network')
  const timeoutMs = deps.timeoutMs ?? DISCOVERY_TIMEOUT_MS
  let response
  try {
    response = await fetcher(anthropicListingUrl(api.baseURL), {
      method: 'GET',
      headers,
      // 不跟随重定向：跨域重定向时自定义鉴权头的剥离规则不一致，直接失败更安全。
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch {
    return discoveryFailed('claude', 'network')
  }
  if (response.status === 401 || response.status === 403) {
    return discoveryFailed('claude', 'unauthorized', response.status)
  }
  if (response.ok !== true) return discoveryFailed('claude', 'http', response.status)
  const declared = Number(response.headers?.get?.('content-length') ?? NaN)
  if (Number.isFinite(declared) && declared > MAX_LISTING_BYTES) return discoveryFailed('claude', 'too-large')
  let text
  try {
    text = String(await response.text())
  } catch {
    return discoveryFailed('claude', 'network')
  }
  if (Buffer.byteLength(text) > MAX_LISTING_BYTES) return discoveryFailed('claude', 'too-large')
  const models = parseClaudeModelList(text)
  if (models === null) return discoveryFailed('claude', 'parse')
  if (models.length === 0) return discoveryFailed('claude', 'empty')
  return discovered('claude', models, 'claude-models-api')
}

/** 运行 `codex debug models`：成功返回 stdout，失败/超时返回 undefined。 */
function runCodexOutput(path, args, options = {}) {
  const timeoutMs = options.timeoutMs ?? DISCOVERY_TIMEOUT_MS
  return new Promise((resolve) => {
    execFile(path, args, {
      timeout: timeoutMs,
      killSignal: 'SIGKILL',
      maxBuffer: MAX_LISTING_BYTES,
      windowsHide: true,
    }, (error, stdout) => {
      if (error !== null) {
        resolve(undefined)
        return
      }
      const text = String(stdout ?? '')
      resolve(Buffer.byteLength(text) > MAX_LISTING_BYTES ? undefined : text)
    })
  })
}

/**
 * 发现 Codex 模型：本机 `codex debug models`（在线目录）；失败时退回
 * `--bundled`（离线内置目录）。
 *
 * 目录跟随 `~/.codex/config.toml` 的 model_provider，所以填进来的 id 与 CLI
 * 实际可用模型一致；stdout 只含 JSON（告警走 stderr）。
 * @param config - 行配置（取 codex 的 executable）。
 * @param deps - `env`、`home`、`resolveExecutable`、`runCommand`、`timeoutMs`、
 *   `fallbackTimeoutMs` 注入点。
 * @returns `{ cli, models, source, error }`。
 */
export async function discoverCodexModels(config, deps = {}) {
  const backend = normalizeConfig(config).subagents.codex
  const env = deps.env ?? process.env
  const home = deps.home ?? homedir()
  const resolve = deps.resolveExecutable ?? resolveExecutable
  const run = deps.runCommand ?? runCodexOutput
  const path = attempt(() => resolve(backend.executable, { env, home }))
  if (typeof path !== 'string' || path === '') return discoveryFailed('codex', 'missing')
  let text = await run(path, ['debug', 'models'], { timeoutMs: deps.timeoutMs ?? DISCOVERY_TIMEOUT_MS })
  if (text === undefined) {
    text = await run(path, ['debug', 'models', '--bundled'], {
      timeoutMs: deps.fallbackTimeoutMs ?? DISCOVERY_FALLBACK_TIMEOUT_MS,
    })
  }
  if (text === undefined) return discoveryFailed('codex', 'failed')
  const models = parseCodexCatalog(text)
  if (models === null) return discoveryFailed('codex', 'parse')
  if (models.length === 0) return discoveryFailed('codex', 'empty')
  return discovered('codex', models, 'codex-catalog')
}

/**
 * 按 CLI 分派模型发现。
 * @param cli - `codex` 或 `claude`（调用方已校验）。
 * @param config - 行配置。
 * @param deps - 两个发现函数的注入点合集。
 * @returns `{ cli, models, source, error }`。
 */
export async function discoverModels(cli, config, deps = {}) {
  if (cli === 'codex') return discoverCodexModels(config, deps)
  if (cli === 'claude') return discoverClaudeModels(deps)
  throw new Error(`unknown discovery cli: ${String(cli)}`)
}

// ── 安检（loopback Host + 同源标志）─────────────────────────────────────────
// 改编自 dsh-better-sidebar src/trust-fence.ts（其源头为 BSD-3-Clause 的
// @deepseek-ai/dsh-client-connection api-request-trust + loopback-hostname）。

function headerOf(req, name) {
  const value = req.headers?.[name]
  return typeof value === 'string' ? value : undefined
}

function parseAuthority(authority) {
  try {
    return new URL(`http://${authority}`)
  } catch {
    return undefined
  }
}

function isLoopbackHostname(hostname) {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  const parts = hostname.split('.')
  return parts.length === 4
    && parts[0] === '127'
    && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

/** Host 是 loopback（或配置的受信权威）且浏览器标志同源。 */
function isTrustedApiRequest(req, trustedHosts) {
  const host = headerOf(req, 'host')
  if (host === undefined) return false
  const hostUrl = parseAuthority(host)
  if (hostUrl === undefined) return false
  const trusted = trustedHosts.some((entry) => {
    const entryUrl = parseAuthority(entry)
    return entryUrl !== undefined && entryUrl.host === hostUrl.host
  })
  if (!isLoopbackHostname(hostUrl.hostname) && !trusted) return false
  if (headerOf(req, 'sec-fetch-site') === 'cross-site') return false
  const origin = headerOf(req, 'origin')
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}

// ── 路由 ─────────────────────────────────────────────────────────────────────

function writeJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

/**
 * 注册只读 `/apollo/api/capabilities` 与 `/apollo/api/models` 路由
 * （由 `src/settings.js` 调用）。
 *
 * 信任边界按请求重读活配置的 `trustedHosts`（反代部署下改完即时生效），读不到
 * 活配置时退回 `configFor` 的规整值。发现接口只回模型 id/efforts，绝不回
 * Claude 的端点凭据。
 * @param ctx - 已注入 webServer 的插件上下文。
 * @param configFor - 返回当前配置的函数（或配置值本身）。
 * @param deps - 探针注入点；`read` / `discover` 可直接替换实现（测试用）。
 * @returns disposer 由 `ctx.effect` 持有。
 */
export function registerCapabilitiesRoute(ctx, configFor, deps = {}) {
  const read = deps.read ?? createCapabilitiesReader(deps)
  const discover = deps.discover ?? discoverModels
  const routes = deps.routes ?? (() => collectTierRoutes(ctx))
  const configOf = () => (typeof configFor === 'function' ? attempt(configFor) : configFor)
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: CAPABILITIES_PREFIX,
    handler: async (req, res) => {
      try {
        const config = currentConfig(ctx, configOf())
        if (!isTrustedApiRequest(req, config.trustedHosts)) {
          writeJson(res, 403, { ok: false, error: { code: 'forbidden', message: 'forbidden' } })
          return
        }
        const url = new URL(req.url ?? '/', 'http://dsh.internal')
        if (url.pathname === ROUTES_PATH) {
          if (req.method !== 'GET') {
            writeJson(res, 405, { ok: false, error: { code: 'method-error', message: 'method not allowed' } })
            return
          }
          const value = await routes()
          res.setHeader?.('cache-control', 'no-store')
          writeJson(res, 200, { ok: true, value })
          return
        }
        if (url.pathname === MODELS_PATH) {
          if (req.method !== 'GET') {
            writeJson(res, 405, { ok: false, error: { code: 'method-error', message: 'method not allowed' } })
            return
          }
          const cli = url.searchParams.get('cli')
          if (!DISCOVERY_CLIS.includes(cli)) {
            writeJson(res, 400, { ok: false, error: { code: 'bad-request', message: 'unknown cli' } })
            return
          }
          const value = await discover(cli, config)
          // 发现是按需触发的探测，不能被浏览器缓存成旧清单。
          res.setHeader?.('cache-control', 'no-store')
          writeJson(res, 200, { ok: true, value })
          return
        }
        if (url.pathname !== CAPABILITIES_PATH) {
          writeJson(res, 404, { ok: false, error: { code: 'not-found', message: 'unknown apollo API path' } })
          return
        }
        if (req.method !== 'GET') {
          writeJson(res, 405, { ok: false, error: { code: 'method-error', message: 'method not allowed' } })
          return
        }
        writeJson(res, 200, { ok: true, value: await read(config) })
      } catch (error) {
        // 探针已经各自吞掉失败；这里只剩意外错误——日志留细节，响应只给通用文案。
        ctx.logger?.warn?.(`apollo-panel: probe failed: ${error instanceof Error ? error.message : String(error)}`)
        writeJson(res, 500, { ok: false, error: { code: 'probe-failed', message: 'capability probe failed' } })
      }
    },
  }), 'apollo-panel: /apollo/api capabilities route')
}
