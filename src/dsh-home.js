/**
 * DSH home 目录解析：本包内的唯一事实源——宿主半边 `src/panel.js` 与预设本地
 * 插件 `presets/<id>/plugins/lib/atlas-config.js` 都从这里取，不再各持同构副本。
 *
 * 解析规则：DSH_HOME 环境变量优先（`~` 展开、相对路径基于进程 CWD），缺省
 * `<home>/.dsh`。零依赖（只用 node 内置模块），可从任意位置加载。
 */

import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'

/**
 * 解析 DSH home 目录。
 * @param env - 读取 DSH_HOME 的进程环境（测试注入点）。
 * @param home - 平台 home 目录回退（测试注入点）。
 * @returns 绝对 DSH home 路径。
 */
export function resolveDshHome(env = process.env, home = homedir()) {
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

/** 从当前环境解析 DSH home 目录。 */
export function dshHome() {
  return resolveDshHome()
}
