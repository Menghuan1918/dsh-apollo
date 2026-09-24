/**
 * eng（工程模式）运行时配置读取（预设本地共享模块）。
 *
 * 配置文件：`<dshHome>/eng.json`，形如：`{"exitGuard": true}`。
 * `exitGuard` 是退出守卫的布尔开关（**默认关闭**，显式写 `true` 才开启）。
 * 曾经还有 `exitGuardIgnore` 豁免子串清单，已随豁免机制一并移除——遗留键被
 * 静默忽略，不影响行为。文件缺失、损坏或形状非法一律回退默认（关闭），绝不
 * 抛错：守卫是可选的行为约束，配置故障既不该让它意外生效，更不该让回合结束
 * 路径崩溃。
 *
 * 兼容：旧文件名 `<dshHome>/atlas.json` 仍被读取（仅当 `eng.json` 缺失时），
 * 新写入只落 `eng.json`——面板首次保存即完成迁移。
 *
 * 零 bare import：预设插件经 `dsh-apollo/presets/*` 裸子路径从 profile 的
 * node_modules 加载（包本体可达），包内相对引用即可回到 src/；dsh home 解析
 * 复用包内 src/dsh-home.js，eng.json 读写与 src/panel.js 同构——改一处请同步
 * 另一处。
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolveDshHome } from '../../../../src/dsh-home.js'

/** eng.json 的绝对路径（新文件名）。 */
export function engConfigPath(env = process.env) {
  return join(resolveDshHome(env), 'eng.json')
}

/** 旧文件名 atlas.json 的绝对路径（只读回退）。 */
export function legacyConfigPath(env = process.env) {
  return join(resolveDshHome(env), 'atlas.json')
}

/**
 * 读取并规整 eng 运行时配置。
 * @param env - 进程环境（测试注入点）。
 * @returns `{ exitGuard: boolean }`，任何读取/解析/校验失败都返回默认值。
 */
export function readEngConfig(env = process.env) {
  const raw = readConfigObject(engConfigPath(env)) ?? readConfigObject(legacyConfigPath(env))
  if (raw === undefined) return { exitGuard: false }
  return {
    exitGuard: typeof raw.exitGuard === 'boolean' ? raw.exitGuard : false,
  }
}

/**
 * 读取一个配置文件并确保是普通对象；缺失、损坏或形状非法返回 undefined。
 * @param path - 配置文件绝对路径。
 * @returns 解析后的对象，或 undefined。
 */
function readConfigObject(path) {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'))
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
    return raw
  } catch {
    return undefined
  }
}
