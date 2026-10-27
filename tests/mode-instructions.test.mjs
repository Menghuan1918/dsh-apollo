/** 工程模式提示词段：按活配置渲染分档、退出守卫与 PTC 变体。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apply, Config, renderInstructions, renderTier } from '../presets/eng/plugins/mode-instructions/index.js'
import { normalizeConfig } from '../src/config.js'

/** fake ctx：configEditor 返回可替换的 apollo-skills 行配置，捕获注册的 section。 */
function mount(rowConfig) {
  let config = {}
  const sections = []
  const ctx = {
    effect: (factory) => factory(),
    systemPrompt: { section: (section) => { sections.push(section); return () => {} } },
    get: (name) => (name === 'configEditor' ? { entries: () => [{ options: { id: 'apollo-skills' }, fiber: { config } }] } : undefined),
  }
  apply(ctx, rowConfig)
  assert.equal(sections.length, 1)
  return { section: sections[0], set: (next) => { config = next } }
}

test('section 契约：名称、order、不插值、文本按次读取活配置', () => {
  const { section, set } = mount(Config({}))
  assert.equal(section.name, 'eng:mode-instructions')
  assert.equal(section.order, 1)
  assert.equal(section.interpolate, false)
  assert.equal(typeof section.text, 'function')
  assert.match(section.text(), /Fast tier[^\n]*inherit the parent route/)
  set({ tiers: { fast: { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'max' } } })
  assert.match(section.text(), /Fast tier[^\n]*provider: `deepseek-official` · model: `deepseek-flash` · reasoning_effort: `max`/)
  assert.match(section.text(), /Quality tier[^\n]*inherit the parent route/)
})

test('renderTier：未配置沿用父路由；effort 为空时省略', () => {
  assert.match(renderTier({ provider: '', model: '' }), /inherit the parent route/)
  assert.equal(renderTier({ provider: 'p', model: 'm', reasoningEffort: '' }), 'provider: `p` · model: `m`')
})

test('退出守卫段只在开关开启时出现', () => {
  assert.doesNotMatch(renderInstructions(normalizeConfig({})), /## Exit guard/)
  assert.match(renderInstructions(normalizeConfig({ exitGuard: true })), /## Exit guard/)
})

test('ptc 开关：追加 run_code 内派发子代理规则；两种模式都不写 workflow 用法', () => {
  const native = renderInstructions(normalizeConfig({}))
  const ptc = renderInstructions(normalizeConfig({}), { ptc: true })
  assert.doesNotMatch(native, /workflow/)
  assert.doesNotMatch(native, /run_code/)
  assert.match(native, /## Avoid over-engineering and over-defending/)
  assert.doesNotMatch(ptc, /workflow/)
  assert.doesNotMatch(ptc, /Promise\.all/)
  assert.match(ptc, /dispatch all subagents inside one run_code program/)
  assert.equal(Config({ ptc: true }).ptc, true)
  assert.equal(Config({}).ptc, false)
})
