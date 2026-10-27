/** prompts/<preset>.md must contain the Apollo section the current code renders. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { renderInstructions } from '../presets/eng/plugins/mode-instructions/index.js'
import { normalizeConfig } from '../src/config.js'

for (const [preset, ptc] of [['eng', false], ['eng-ptc', true]]) {
  test(`prompts/${preset}.md 与当前工程模式段一致（改了提示词请运行 npm run prompts）`, () => {
    const file = readFileSync(new URL(`../prompts/${preset}.md`, import.meta.url), 'utf8')
    const settings = JSON.parse(file.match(/```json\n([\s\S]*?)\n```/)[1])
    assert.ok(file.includes(renderInstructions(normalizeConfig(settings), { ptc })), `prompts/${preset}.md 已过期`)
  })
}
