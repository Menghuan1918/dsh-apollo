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
 * 零 bare import（预设目录的 node_modules 向上走不到 harness 安装）；
 * dsh home 解析与包内 src/preset-sync.js 同构，读写与 src/panel.js 同构
 * ——改一处请同步另一处。
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'

/**
 * 解析 DSH home 目录：DSH_HOME 环境变量优先（~ 展开、相对路径基于 CWD），
 * 缺省 `<home>/.dsh`。
 * @param env - 读取 DSH_HOME 的进程环境（测试注入点）。
 * @param home - 平台 home 目录回退（测试注入点）。
 * @returns 绝对 DSH home 路径。
 */
function resolveDshHome(env = process.env, home = homedir()) {
  const raw = env.DSH_HOME
  if (raw !== undefined && raw.trim() !== '') {
    const trimmed = raw.trim()
    const expanded = trimmed === '~' ? home
      : trimmed.startsWith('~/') || trimmed.startsWith('~\\') ? join(home, trimmed.slice(2))
      : trimmed
    return isAbsolute(expanded) ? expanded : join(process.cwd(), expanded)
  }
  return join(home, '.dsh')
}

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
