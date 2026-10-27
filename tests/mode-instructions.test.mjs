/**
 * 工程模式提示词段：只保留通用工程纪律与 job-only 退出守卫。
 * 子代理委派/分档/CLI 目录/child guard 由 dsh-better-subagent 的 per-Agent
 * section 提供，Apollo 不保留第二份生成器。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apply, renderInstructions } from '../presets/eng/plugins/mode-instructions/index.js'
import { normalizeConfig } from '../src/config.js'

/** fake ctx：configEditor 返回可替换的 apollo-skills 行配置，捕获注册的 section。 */
function mount() {
  let config = {}
  const sections = []
  const ctx = {
    effect: (factory) => factory(),
    systemPrompt: { section: (section) => { sections.push(section); return () => {} } },
    get: (name) => (name === 'configEditor' ? { entries: () => [{ options: { id: 'apollo-skills' }, fiber: { config } }] } : undefined),
  }
  apply(ctx, {})
  assert.equal(sections.length, 1)
  return { section: sections[0], set: (next) => { config = next } }
}

test('section 契约：名称、order、不插值、文本按次读取活配置', () => {
  const { section, set } = mount()
  assert.equal(section.name, 'eng:mode-instructions')
  assert.equal(section.order, 1)
  assert.equal(section.interpolate, false)
  assert.equal(typeof section.text, 'function')
  assert.match(section.text(), /# Engineering mode/)
  assert.doesNotMatch(section.text(), /## Exit guard/)
  set({ exitGuard: true })
  assert.match(section.text(), /## Exit guard/)
})

test('只保留通用纪律：不含委派、分档、CLI 目录或子代理守卫文本', () => {
  const text = renderInstructions(normalizeConfig({ exitGuard: true, tiers: { fast: { provider: 'p', model: 'm' } } }))
  assert.match(text, /## Principles/)
  assert.match(text, /## Avoid over-engineering and over-defending/)
  assert.match(text, /## Verification and reporting/)
  assert.match(text, /## Boundaries/)
  assert.match(text, /## Commands and processes/)
  assert.doesNotMatch(text, /## Delegation/)
  assert.doesNotMatch(text, /Subagent model tiers/)
  assert.doesNotMatch(text, /wait_subagent/)
  assert.doesNotMatch(text, /run_code/)
  assert.doesNotMatch(text, /workflow/)
  assert.doesNotMatch(text, /provider: `p`/)
})

test('退出守卫段只说后台任务：与 job-only 插件归属一致', () => {
  const off = renderInstructions(normalizeConfig({}))
  const on = renderInstructions(normalizeConfig({ exitGuard: true }))
  assert.doesNotMatch(off, /## Exit guard/)
  assert.match(on, /## Exit guard/)
  assert.match(on, /job_output/)
  assert.match(on, /job_kill/)
  assert.doesNotMatch(on, /subagent/i)
  assert.doesNotMatch(on, /childExitGuard/)
})

test('renderInstructions 不依赖分档配置，也不接受 ptc 选项', () => {
  const base = renderInstructions(normalizeConfig({}))
  const withTiers = renderInstructions(normalizeConfig({ tiers: { quality: { provider: 'x', model: 'y' } } }))
  assert.equal(base, withTiers)
  assert.equal(renderInstructions(normalizeConfig({}), { ptc: true }), base)
})
