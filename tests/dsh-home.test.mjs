/**
 * DSH home 解析单元测试（src/preset-sync.js）：DSH_HOME 环境变量、~ 展开、
 * 相对路径、缺省值。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { resolveDshHome } from '../src/preset-sync.js'

test('缺省：<home>/.dsh', () => {
  assert.equal(resolveDshHome({}, '/home/tester'), join('/home/tester', '.dsh'))
})

test('DSH_HOME 绝对路径：原样使用', () => {
  assert.equal(resolveDshHome({ DSH_HOME: '/custom/dsh-home' }, '/home/tester'), '/custom/dsh-home')
})

test('DSH_HOME 为 ~：展开为 home', () => {
  assert.equal(resolveDshHome({ DSH_HOME: '~' }, '/home/tester'), '/home/tester')
  assert.equal(resolveDshHome({ DSH_HOME: '~/dsh' }, '/home/tester'), join('/home/tester', 'dsh'))
})

test('DSH_HOME 相对路径：基于 process.cwd()', () => {
  assert.equal(resolveDshHome({ DSH_HOME: 'rel/dsh' }, '/home/tester'), join(process.cwd(), 'rel', 'dsh'))
})

test('DSH_HOME 空白：视为未设置', () => {
  assert.equal(resolveDshHome({ DSH_HOME: '   ' }, '/home/tester'), join('/home/tester', '.dsh'))
})
