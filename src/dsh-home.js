/**
 * DSH home 目录解析。
 *
 * 当前唯一消费方是 `src/settings.js`：它据此定位 `<dshHome>/eng.json`（旧名
 * `atlas.json`）做一次**只读**的旧配置导入。预设本地插件不再各持一份同构副本
 * ——`presets/<id>/plugins/lib/atlas-config.js` 已删除，预设插件改为直接读活配置
 * （`src/config.js` 的 `currentConfig`）：设置本身早已是正式 Config，落在活动
 * profile 的 `cordis.patch.yml` 里，本文件只服务于那次遗留文件迁移。
 *
 * 解析规则：DSH_HOME 环境变量优先（`~` 展开、相对路径基于进程 CWD），缺省
 * `<home>/.dsh`。只用 node 内置模块，可从任意位置加载。
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
