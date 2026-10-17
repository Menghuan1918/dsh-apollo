import { createHash } from 'node:crypto'

/** Durable CLI identities live outside the compactable conversation surface. */
export async function openCliSessions(ctx) {
  const profile = ctx.get('profileContext')
  const namespace = createHash('sha256').update(profile?.dir ?? 'default').digest('hex').slice(0, 16)
  const backend = ctx.storage.backend.get('json')
  if (!backend?.kv) throw new Error('Apollo CLI subagents require the JSON storage backend')
  const unit = await backend.kv.open({
    name: `apollo_cli_${namespace}`, version: 1, tables: ['sessions'], hasGlobal: false, layout: 'per-record',
  })
  try {
    const snapshot = await unit.loadAll()
    return new CliSessions(unit, snapshot.tables.sessions ?? {})
  } catch (error) {
    await unit.close()
    throw error
  }
}

export class CliSessions {
  constructor(unit, records = {}) {
    this.unit = unit
    this.records = new Map(Object.entries(records))
    this.writes = Promise.resolve()
    this.closed = false
  }

  get(id) {
    const value = this.records.get(id)
    if (value === undefined) return undefined
    if (value?.version !== 1 || !['codex', 'claude'].includes(value.cli) || value.id !== id
      || typeof value.parentId !== 'string' || typeof value.cwd !== 'string'
      || typeof value.model !== 'string' || typeof value.effort !== 'string'
      || typeof value.executable !== 'string' || !Array.isArray(value.delivered)) {
      throw new Error(`Apollo CLI session ${id} has invalid stored state`)
    }
    return structuredClone(value)
  }

  async put(record) {
    if (!/^[a-zA-Z0-9_-]+$/.test(record.id)) throw new Error('Invalid Apollo CLI session id')
    const detached = structuredClone(record)
    await this.enqueue(async () => {
      await this.unit.putRecord('sessions', detached.id, detached)
      this.records.set(detached.id, detached)
    })
  }

  async delete(id) {
    await this.enqueue(async () => {
      await this.unit.deleteRecord('sessions', id)
      this.records.delete(id)
    })
  }

  enqueue(write) {
    if (this.closed) return Promise.reject(new Error('Apollo CLI session store is closed'))
    const pending = this.writes.then(write)
    this.writes = pending.catch(() => {})
    return pending
  }

  async close() {
    this.closed = true
    await this.writes
    await this.unit.close()
  }
}
