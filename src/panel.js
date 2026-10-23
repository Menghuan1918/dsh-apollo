/**
 * dsh-apollo (npm: @menghuan1918/dsh-apollo) —— 宿主半边只读面板（src/panel.js）。
 *
 * 注册仅限 loopback（或行配置 `trustedHosts` 列出的反向代理权威）+ 同源标志的
 * fenced HTTP 路由 `/apollo/api/capabilities`，供浏览器半边（`exports["./client"]`
 * 的 `plugins.row.config` 页面）读取**能力探针**：两个 CLI 后端配置的可执行文件
 * 在 PATH 上的解析结果与版本、以及 Codex 的 profile 名称。
 *
 * 为什么是「能力」而不是「配置」：设置本身已经是正式 Config（volatile），读写
 * 走 DSH 自己的 configForms/行配置页面（`src/settings.js` 只做一次旧文件导入），
 * 不再需要本包自有的配置路由。这里只暴露**从本机探测出来的、设置表单无法自己
 * 知道**的事实——用户手输的可执行文件名到底解析到了哪里、版本是什么、Codex 有
 * 哪些 profile 可选。
 *
 * 暴露面（写死在契约里，测试守护）：
 *   `{ executables: { codex: { executable, path, version }, claude: {...} },
 *      codexProfiles: string[] }`
 * **绝不返回配置正文，也绝不返回任何凭据**：只回可执行文件名/路径/版本行与
 * profile 名称（profile 文件内容只在本进程内用于抽名称）。只读：GET 之外的
 * 方法一律 405，且从不读取请求体。
 *
 * 安全模型仍是 DNS-rebinding / 跨站防御而非认证（默认只信 loopback；经反向
 * 代理域名访问 GUI 时把该权威加入行配置 `trustedHosts`，后果上限是泄露本机
 * 上某个可执行文件的路径与版本号）。边界判定与 dsh-better-sidebar 的
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
 * 注册只读 `/apollo/api/capabilities` 路由（由 `src/settings.js` 调用）。
 *
 * 信任边界按请求重读活配置的 `trustedHosts`（反代部署下改完即时生效），读不到
 * 活配置时退回 `configFor` 的规整值。
 * @param ctx - 已注入 webServer 的插件上下文。
 * @param configFor - 返回当前配置的函数（或配置值本身）。
 * @param deps - 探针注入点；`read` 可直接替换整个读取器（测试用）。
 * @returns disposer 由 `ctx.effect` 持有。
 */
export function registerCapabilitiesRoute(ctx, configFor, deps = {}) {
  const read = deps.read ?? createCapabilitiesReader(deps)
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
        const pathname = new URL(req.url ?? '/', 'http://dsh.internal').pathname
        if (pathname !== CAPABILITIES_PATH) {
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
        ctx.logger?.warn?.(`apollo-panel: capabilities probe failed: ${error instanceof Error ? error.message : String(error)}`)
        writeJson(res, 500, { ok: false, error: { code: 'probe-failed', message: 'capability probe failed' } })
      }
    },
  }), 'apollo-panel: /apollo/api capabilities route')
}
