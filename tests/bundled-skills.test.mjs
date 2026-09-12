/**
 * 捆绑技能目录测试：包内每个技能都能被 provider 发现并解析出合法 frontmatter，
 * 且技能正文引用的同目录资源（`tests.md`、`scripts/*.sh`）真实存在。
 *
 * 为什么需要：`skills/` 是纯内容目录，node --test 之外没有任何东西会检查它；
 * 漏一个 SKILL.md 或写坏 frontmatter 只会在运行期表现为「技能目录里少一个」。
 * 运行：node --test
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SKILLS_DIR = fileURLToPath(new URL('../skills/', import.meta.url))
/** madd 明示引用的两个技能：捆绑它们之前是悬空引用。 */
const REQUIRED_SKILLS = [
  'brainstorming',
  'code-review',
  'dev',
  'diagnosing-bugs',
  'exec',
  'handoff',
  'main-agent-driven-development',
  'tdd',
]

/** 技能目录 = 持有 SKILL.md 的直接子目录。 */
function skillDirs() {
  return readdirSync(SKILLS_DIR)
    .filter((entry) => statSync(join(SKILLS_DIR, entry)).isDirectory())
    .sort()
}

/** 取 frontmatter 的 `key: value`；值可带引号。 */
function frontmatterField(raw, key) {
  const lines = raw.split('\n')
  if (lines[0] !== '---') return undefined
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i] === '---') break
    const match = new RegExp(`^${key}:[ \\t]*(.*)$`).exec(lines[i])
    if (match !== null) return match[1].trim().replace(/^"(.*)"$/, '$1')
  }
  return undefined
}

test('技能目录与 REQUIRED_SKILLS 完全一致（不多不少）', () => {
  assert.deepEqual(skillDirs(), REQUIRED_SKILLS)
})

test('每个技能都有可解析的 frontmatter（name 与目录同名、description 非空）', () => {
  for (const skill of skillDirs()) {
    const raw = readFileSync(join(SKILLS_DIR, skill, 'SKILL.md'), 'utf8')
    assert.equal(frontmatterField(raw, 'name'), skill, `${skill}: frontmatter name 应等于目录名`)
    const description = frontmatterField(raw, 'description')
    assert.equal(typeof description === 'string' && description.length > 0, true, `${skill}: description 不能为空`)
  }
})

test('技能正文引用的同目录资源真实存在', () => {
  for (const skill of skillDirs()) {
    const raw = readFileSync(join(SKILLS_DIR, skill, 'SKILL.md'), 'utf8')
    // markdown 链接指向的同目录文件：[tests.md](tests.md)
    for (const [, target] of raw.matchAll(/\]\(([^)#\s]+)\)/g)) {
      if (/^[a-z]+:/i.test(target)) continue
      assert.equal(existsSync(join(SKILLS_DIR, skill, target)), true, `${skill}: 链接目标 ${target} 不存在`)
    }
    // 反引号里的 scripts/ 相对路径：`scripts/hitl-loop.template.sh`
    for (const [, target] of raw.matchAll(/`((?:scripts|assets)\/[^`\s]+)`/g)) {
      assert.equal(existsSync(join(SKILLS_DIR, skill, target)), true, `${skill}: 资源 ${target} 不存在`)
    }
  }
})

test('捆绑的第三方技能带署名 NOTICE，且 skill 目录里不放散落文件', () => {
  assert.equal(existsSync(join(SKILLS_DIR, '..', 'third-party', 'NOTICE-mattpocock-skills')), true)
  for (const skill of skillDirs()) {
    for (const entry of readdirSync(join(SKILLS_DIR, skill))) {
      const isSkillDoc = entry === 'SKILL.md'
      const isResource = statSync(join(SKILLS_DIR, skill, entry)).isDirectory() || entry.endsWith('.md') || entry.endsWith('.sh')
      assert.equal(isSkillDoc || isResource, true, `${skill}: 目录内出现非资源文件 ${entry}`)
    }
  }
})

test('madd 引用的 tdd / diagnosing-bugs 都在包内', () => {
  const madd = readFileSync(join(SKILLS_DIR, 'main-agent-driven-development', 'SKILL.md'), 'utf8')
  for (const skill of ['tdd', 'diagnosing-bugs']) {
    assert.match(madd, new RegExp(`\`${skill}\` skill`), `madd 应引用 ${skill}`)
    assert.equal(existsSync(join(dirname(SKILLS_DIR), 'skills', skill, 'SKILL.md')), true)
  }
})
