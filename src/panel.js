/**
 * eng（工程模式）设置面板 —— host 半边。
 *
 * 注册仅限 loopback（或行配置 trustedHosts 列出的反向代理权威）+ 同源标志
 * 的 fenced HTTP 路由 `/eng-panel/api/config`，供浏览器半边的设置卡片读写
 * `<dshHome>/eng.json`。DSH 的设置 RPC 只服务白名单 namespace，第三方插件的
 * 可视化配置走自有路由（dsh-better-sidebar 的 /sidebar/api 同款模式）。
 *
 * 暴露面只有一个布尔开关（exitGuard，PUT 只改它并保留其他字段、顺手清掉
 * 已废弃的 exitGuardIgnore 遗留键），故安全模型是 DNS-rebinding /
 * 跨站防御而非认证：默认仅 loopback；经反向代理域名访问 GUI 时，把该权威加入
 * 本行 config 的 trustedHosts（后果上限：跨站请求翻转一个布尔开关）。
 *
 * 零依赖（node 内置模块）；dsh home 与 eng.json 读写和预设侧
 * presets/eng/plugins/lib/atlas-config.js 同构——改一处请同步另一处。
 * 旧文件名 atlas.json 只读回退：写入永远落 eng.json。
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'

export const name = 'eng-panel'

// 不在插件级 inject 里声明 webServer：headless 等无 webserver 的组合中，
// 面板装配必须照常返回（路由注册经 ctx.inject 延迟到服务出现时进行；服务
// 永远不出现则静默跳过，dsh-better-sidebar 对 settings 同款模式）。
export function mountPanel(ctx, config) {
  const trustedHosts = Array.isArray(config?.trustedHosts)
    ? config.trustedHosts.filter((entry) => typeof entry === 'string')
    : []
  ctx.inject(['webServer'], (webCtx) => {
    registerRoutes(webCtx, trustedHosts)
    if (config?.declareOwnsHost === true) {
      webCtx.effect(() => webCtx.webServer.tapIndex(declareOwnsHostTap), 'eng-panel: declareOwnsHost tap')
    }
  })
}

/**
 * 部署标志 tap：在 `<head>` 起始处注入 boot 全局 `__DSH_TRANSPORT__.ownsHost`，
 * 使官方 client 的 `connection.isLoopback` 判定为真。
 *
 * 背景（DSH 0.1.2-alpha）：client 对「浏览器非 loopback 页面」把 settings
 * 镜像/作用域设为 memory（不可用），官方没有受信反代配置口。经反向代理多设备
 * 访问时，声明「页面拥有宿主」让设置读写回到 host 持久化——安全边界随反代
 * 信任，仅应在受信代理下开启（行配置 `declareOwnsHost: true`，默认关闭）。
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

/** 请求体上限：本路由只接受一个布尔字段的 JSON。 */
const MAX_BODY_BYTES = 4096

// ── dsh home / eng.json ──────────────────────────────────────────────────────

function resolveDshHome(env = process.env, home = homedir()) {
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

function engConfigPath() {
  return join(resolveDshHome(), 'eng.json')
}

/** 旧文件名 atlas.json 的路径（只读回退）。 */
function legacyConfigPath() {
  return join(resolveDshHome(), 'atlas.json')
}

/** 读取一个配置文件并确保是普通对象；缺失、损坏或形状非法返回 undefined。 */
function readConfigObject(path) {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'))
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
    return raw
  } catch {
    return undefined
  }
}

/**
 * 读取规整配置；任何失败回退默认——与预设侧 readEngConfig 语义一致，
 * 即 `exitGuard` 默认关闭，显式写 `true` 才开启。
 * eng.json 缺失或损坏时回退旧名 atlas.json，保证迁移期不丢开关。
 */
function readEngConfig() {
  const raw = readConfigObject(engConfigPath()) ?? readConfigObject(legacyConfigPath())
  if (raw === undefined) return { exitGuard: false }
  return {
    exitGuard: typeof raw.exitGuard === 'boolean' ? raw.exitGuard : false,
  }
}

/**
 * 写入配置。面板只编辑 exitGuard 一个字段，但写入必须保留文件里已有的其他
 * 字段——先读旧值合并再落盘；顺手清掉已随豁免机制移除的 exitGuardIgnore
 * 遗留键（已无任何代码读取它）。读取只看 eng.json，不回退旧文件：首次保存
 * 即完成迁移。
 * @param value - `{ exitGuard: boolean }`。
 */
function writeEngConfig(value) {
  const path = engConfigPath()
  const previous = readConfigObject(path) ?? {}
  delete previous.exitGuardIgnore
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify({ ...previous, exitGuard: value.exitGuard }, null, 2)}\n`)
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
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(payload)
}

async function readJsonBody(req) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > MAX_BODY_BYTES) throw new Error('request body too large')
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (text === '') return undefined
  return JSON.parse(text)
}

/**
 * 注册 /eng-panel/api/config 路由。
 * @param ctx - 已注入 webServer 的插件上下文。
 * @param trustedHosts - 受信反向代理权威（host 或 host:port）。
 */
function registerRoutes(ctx, trustedHosts) {
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/eng-panel/api',
    handler: async (req, res) => {
      if (!isTrustedApiRequest(req, trustedHosts)) {
        writeJson(res, 403, { ok: false, error: { code: 'forbidden', message: 'forbidden' } })
        return
      }
      const pathname = new URL(req.url ?? '/', 'http://dsh.internal').pathname
      if (pathname !== '/eng-panel/api/config') {
        writeJson(res, 404, { ok: false, error: { code: 'not-found', message: 'unknown eng-panel API path' } })
        return
      }
      if (req.method === 'GET') {
        writeJson(res, 200, { ok: true, value: readEngConfig() })
        return
      }
      if (req.method === 'PUT') {
        let body
        try {
          body = await readJsonBody(req)
        } catch (error) {
          writeJson(res, 400, { ok: false, error: { code: 'bad-request', message: error instanceof Error ? error.message : String(error) } })
          return
        }
        if (body === null || typeof body !== 'object' || Array.isArray(body) || typeof body.exitGuard !== 'boolean') {
          writeJson(res, 400, { ok: false, error: { code: 'bad-request', message: 'expected { exitGuard: boolean }' } })
          return
        }
        writeEngConfig(body)
        writeJson(res, 200, { ok: true, value: readEngConfig() })
        return
      }
      writeJson(res, 405, { ok: false, error: { code: 'method-error', message: 'method not allowed' } })
    },
  }), 'eng-panel: /eng-panel/api routes')
}
