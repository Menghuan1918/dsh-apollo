/**
 * apply 冒烟测试：以临时 DSH_HOME 调用宿主插件 apply，验证技能 provider
 * 注册路径端到端可用，且不再向 DSH_HOME 写任何 `.agent-presets` 副本
 * （0.1.7 起预设经 bundle patch 交付，sync-on-boot 已删除）。
 *
 * 0.5.0 起 apply 只装配：技能 provider、行设置（含旧 exitGuard 导入与
 * `/apollo-settings/api` 聚合路由）、旧配置迁移。CLI 路由、wait 工具、
 * 能力/探针路由与子代理提示词由独立插件行拥有——webServer 只为聚合
 * 设置路由注入，不注册任何 `/apollo/api/*` 能力面。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, name } from '../src/index.js'

test('插件导出契约：name / apply', () => {
  assert.equal(name, 'apollo-skills')
  assert.equal(typeof apply, 'function')
})

test('apply：注册技能 provider，且不向 DSH_HOME 写 .agent-presets', async () => {
  const home = mkdtempSync(join(tmpdir(), 'eng-home-'))
  const providers = []
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    apply({ skills: { registerProvider: (provider) => providers.push(provider) }, logger: console })
    apply({ skills: { registerProvider: (provider) => providers.push(provider) }, logger: console })
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
  assert.equal(providers.length, 2, '每次挂载都应注册一个技能 provider 工厂')
  // registerProvider 收到的是惰性工厂；调用它拿 provider 本体。
  const provider = providers[0]()
  assert.equal(typeof provider.list, 'function')
  assert.equal(typeof provider.get, 'function')
  const skills = await provider.list()
  assert.equal(skills.length > 0, true, '包内技能目录应被发现')
  // 旧机制残留检查：预设交付已不走文件同步，home 里不应出现任何副本目录。
  assert.equal(existsSync(join(home, '.agent-presets')), false, 'apply 不应再写 <dshHome>/.agent-presets')
  rmSync(home, { recursive: true, force: true })
})

test('apply：有 inject 时装配 settings / 聚合路由 / 迁移', () => {
  const injections = []
  const ctx = {
    skills: { registerProvider: () => {} },
    inject: (names) => { injections.push(names) },
    logger: console,
  }
  apply(ctx, {})
  assert.deepEqual(injections, [
    ['webServer', 'settings'],
    ['settings'],
    ['settings'],
  ], '聚合路由、行策略与旧配置迁移各注入一次')
})
