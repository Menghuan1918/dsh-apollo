/**
 * Apollo's only remaining host-web helper: the `declareOwnsHost` index tap.
 *
 * Why it still lives in Apollo: the flag lets the official client treat a
 * reverse-proxied page as loopback, which is what makes the *host* settings
 * mirror writable. It is a deployment flag of Apollo's own row
 * (`declareOwnsHost`, off by default), not a subagent or compaction concern —
 * dsh-better-subagent and dsh-better-compact intentionally removed their own
 * trust switches, and Apollo must not turn its flag into a trust bypass for
 * them.
 *
 * The old capability/model/route probes and the `/apollo/api/*` handlers were
 * deleted in 0.5.0. dsh-better-subagent owns those routes (canonical
 * `/better-subagent/api/*` plus the `/apollo/api/*` read aliases), and Apollo
 * must not register the same prefix again: webServer throws on a duplicate
 * `(kind, path)` route.
 *
 * Zero third-party dependencies.
 */

import { normalizeConfig } from './config.js'

/**
 * Deployment-flag tap: inject the boot global `__DSH_TRANSPORT__.ownsHost` at
 * the start of `<head>` so the official client's `connection.isLoopback` is
 * true.
 *
 * Background: for a non-loopback browser page the client sets the settings
 * mirror/scope to memory (unusable); there is no official trusted-proxy
 * setting. When reaching the GUI through a reverse proxy, declaring that the
 * page owns the host restores host-backed settings writes — the security
 * boundary follows the proxy trust, so only enable it behind a trusted proxy
 * (`declareOwnsHost: true`, default off). The script sits before every other
 * head injection and runs before boot.
 * @param html - rendered index HTML.
 * @returns HTML with the transport global inserted.
 */
export function declareOwnsHostTap(html) {
  const script = '<script>globalThis.__DSH_TRANSPORT__={ownsHost:true}</script>'
  return /<head(?:\s[^>]*)?>/i.test(html)
    ? html.replace(/<head(?:\s[^>]*)?>/i, (open) => `${open}${script}`)
    : `${script}${html}`
}

/** Plugin contexts that already installed the tap (mountSettings may run twice). */
const tappedContexts = new WeakSet()

/**
 * Install the `declareOwnsHost` tap when the row config enables it (once per
 * plugin context).
 *
 * Called by `src/settings.js`'s `mountSettings`; headless compositions without
 * a webServer simply never resolve the injection.
 * @param ctx - plugin context.
 * @param config - row config (volatile references allowed).
 */
export function installOwnsHostTap(ctx, config) {
  if (normalizeConfig(config).declareOwnsHost !== true) return
  if (ctx !== null && typeof ctx === 'object') {
    if (tappedContexts.has(ctx)) return
    tappedContexts.add(ctx)
  }
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => webCtx.webServer.tapIndex(declareOwnsHostTap), 'apollo: declareOwnsHost tap')
  })
}
