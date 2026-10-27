/** prompts/<preset>.md must contain the Apollo section the current code renders,
 *  while the subagent sections come from dsh-better-subagent (no second copy). */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { renderInstructions } from '../presets/eng/plugins/mode-instructions/index.js'
import { normalizeConfig } from '../src/config.js'

for (const [preset, ptc] of [['eng', false], ['eng-ptc', true]]) {
  test(`prompts/${preset}.md 与当前工程模式段一致（改了提示词请运行 npm run prompts）`, () => {
    const file = readFileSync(new URL(`../prompts/${preset}.md`, import.meta.url), 'utf8')
    const settings = JSON.parse(file.match(/```json\n([\s\S]*?)\n```/)[1])
    assert.ok(file.includes(renderInstructions(normalizeConfig(settings['apollo-skills']))), `prompts/${preset}.md 已过期`)
  })

  test(`prompts/${preset}.md 由真实装配生成：新插件段落来自其运行时实现，不是 Apollo 的第二份副本`, () => {
    const file = readFileSync(new URL(`../prompts/${preset}.md`, import.meta.url), 'utf8')
    const settings = JSON.parse(file.match(/```json\n([\s\S]*?)\n```/)[1])
    const tiers = settings['dsh-better-subagent'].tiers
    assert.match(file, /`better-subagent:delegation`/, 'per-agent delegation section must assemble in the real prompt')
    assert.match(file, /## Delegation/)
    assert.match(file, /## Subagent model tiers/)
    // 分档值来自快照设置块，而不是测试里写死的第二份提示词文本。
    for (const tier of ['fast', 'quality']) {
      assert.ok(file.includes(`provider: \`${tiers[tier].provider}\` · model: \`${tiers[tier].model}\` · reasoning_effort: \`${tiers[tier].reasoningEffort}\``))
    }
    assert.equal(file.includes('better-subagent:child-guard'), false, 'childExitGuard 默认关闭时没有 child guard 段')
    // Apollo 的工程模式段只保留通用纪律与 job-only 守卫。
    assert.match(file, /# Engineering mode/)
    assert.doesNotMatch(file, /## Exit guard/)
    if (ptc) {
      assert.match(file, /dispatch all subagents inside one run_code program/, 'eng-ptc 的 PTC fan-out 由新插件识别预设后追加')
    }
  })
}
