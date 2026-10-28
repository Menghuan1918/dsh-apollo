import { isDeepStrictEqual } from 'node:util'

/** Do not run a turn or manual summary using pre-migration defaults. */
export function mountMigrationAdmission(ctx) {
  let report = { status: 'pending' }
  let requiresReload = false
  const assertReady = () => {
    if (report.status !== 'complete') {
      const detail = report.error ?? report.compact?.error ?? report.compact?.reason ?? report.subagent?.error
      const error = new Error('Apollo 配置迁移尚未完成（' + report.status + '）。请检查迁移诊断，修复配置后重载 profile。' + (detail ? ' ' + detail : ''))
      error.code = 'APOLLO_MIGRATION_PENDING'
      throw error
    }
    if (requiresReload) {
      const error = new Error('Apollo 已迁移压缩配置，但当前引擎仍使用旧快照。请重载 profile 后继续；刷新网页不会应用压缩配置。')
      error.code = 'APOLLO_MIGRATION_RELOAD_REQUIRED'
      throw error
    }
  }
  ctx.on('agent/pre-step', (_payload, next) => {
    assertReady()
    return next()
  }, { prepend: true })
  // Manual /compact does not enter pre-step. Guard its provider boundary too,
  // without replacing the compaction service or changing any request messages.
  ctx.on('llm/stream', async function* (_options, next) {
    assertReady()
    yield* next()
  }, { prepend: true })
  return (result) => {
    report = result
    const compact = ctx.get?.('betterCompactConfig')
    requiresReload = result.status === 'complete' && result.compact?.fields?.length > 0
      && compact !== undefined && !isDeepStrictEqual(compact.snapshot(), compact.current())
  }
}
