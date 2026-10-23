# dsh-apollo

为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 提供流程技能、工程模式、独立长期目标，以及 **Codex / Claude CLI 可续接后台子代理**。

- **规划与执行**：把大型需求拆为可验证的 Spec，按依赖分波并行执行，再由子代理审查。
- **工程预设**：提供「工程模式」与「工程模式（无提问）」，包含等待子代理工具和可选退出守卫。
- **长期目标**：依赖独立的 `dsh-better-goal` 插件，一个持久目标配单个 `goal` 工具与 `/goal` 命令；回合上限和提问超时在它自己的 Plugins 行配置，Apollo 不保留 goal 域代码。
- **CLI 子代理**：复用 DSH 的委派、消息和中断工具；模型、effort、Codex profile 与 CLI 权限集中配置。
- **统一设置**：Apollo 表单接入 DSH Plugins 页的行配置槽位，使用正式 Config 存储，保存后即时生效。

纯 ESM，无构建步骤。**最低支持 DSH `0.2.1-rc.2`**；不兼容旧版子代理接口。

## 安装

需要 Node.js `^22.19.0 || >=24.0.0`，DSH 版本范围为 `>=0.2.1-rc.2 <0.3.0`。已验证基准为 `0.2.1-rc.2`。DSH 的兼容检查会纳入预发布版，因此该声明也可能接受尚未验证的后续 RC（包括 `0.3.0` 的预发布版）；版本范围不等于逐版验证保证，见 [兼容声明](<package.json>)。

```sh
dsh plugin --profile <profile> add github:Menghuan1918/dsh-apollo

# 本地开发安装：先在 Apollo 根目录安装依赖
cd /absolute/path/to/dsh-apollo && npm install
dsh plugin --profile <profile> add link:/absolute/path/to/dsh-apollo
```

本地 link 开发必须先在 Apollo 根目录执行 `npm install`：开发时可将 `dsh-better-goal` 临时改为 `file:../dsh-better-goal`，发布版固定到独立仓库的 commit；`dsh plugin add link:` 只链接 Apollo 本身，不会代装其依赖。

重启对应 profile 的 DSH 进程后，可以看到：

1. 技能目录中的 8 个流程技能。
2. 预设选择器中的「工程模式」和「工程模式（无提问）」。
3. **Plugins → dsh-apollo → `apollo-skills` 行**的运行时配置表单。
4. **Plugins → dsh-apollo → dsh-better-goal 行** 的目标设置行（回合上限模式、固定上限、提问超时）。

技能需要所选预设挂载 DSH 的技能工具。CLI 后端默认关闭，安装插件不会自动安装、登录或启用 Codex / Claude。

```sh
# 检查装配结果：应包含 apollo-skills、dsh-better-goal 行和两个工程预设
dsh --profile <profile> --dump-config

# 卸载
dsh plugin --profile <profile> remove dsh-apollo
```

### goal 依赖与稳定行去重

Apollo 把独立的 `dsh-better-goal` 声明为运行时依赖，依赖只安装一份；它的 bundle patch **不会**作为传递依赖自动应用——DSH 只把直接安装的 bundle 加入 `dsh.profile.bundles`，所以 Apollo 的顶层 patch 自己携带了原生 goal 行的禁用与替换行。

- 两个 bundle 各自插入的顶层行 id/name 都是 `dsh-better-goal`；同时选中时 Loader 按行 id 去重，插件只激活一次，浏览器模块也只有一个 active source。不要手写第三行。
- **禁用/移除 `dsh-better-goal` bundle 不等于禁用 Apollo 插入的 `dsh-better-goal` 行**：只要 Apollo 仍在，goal 插件仍会加载。要彻底移除 goal 能力，需要同时移除 Apollo 或显式禁用该行。
- 未单独选中 `dsh-better-goal` bundle 时无需任何额外操作：Apollo 安装依赖后，顶层 patch 已提供该行。
- 卸载 Apollo 后，profile 不再有 Apollo 插入的 goal 行；若之前单独添加过 `dsh-better-goal` bundle，需自行决定是否一并移除。
- DSH `0.2.1-rc.2` 对同时显式选中两个 bundle 的同 ID 组合行，会把行开关标成只读（`unaddressable`），目标设置保存也可能被拒绝。无需重复 add：保留 Apollo 入口即可，子插件依赖和能力仍然保留；脱离 Apollo 使用时再独立安装。此限制不影响单实例运行，不为它改动 DSH 核心。若只需开关有效行，可在 profile 覆盖中写 `id: dsh-better-goal`、`disabled: true/false`，不要重新启用原生 `goal` 行。

## 流程技能

| 技能 | 用途 |
|---|---|
| `/brainstorming` | 把大型需求设计为主 Spec 与子 Spec，提交用户批准 |
| `/exec` | 按依赖分波执行：独立 worktree → 并行实现 → 审查 → 验证与合并 |
| `dev` | 执行与审查节点的 prompt、报告结构及失败处理契约 |
| `/main-agent-driven-development` | 实现一个边界明确的任务 |
| `tdd` | 测试先行、红绿循环、测试边界与反模式 |
| `diagnosing-bugs` | 为难 bug 建立反馈循环，再定位和修复根因 |
| `/code-review` | 并行检查编码标准与需求符合性 |
| `/handoff` | 把当前上下文整理为交接文档 |

技能正文中英混合。工作区已有文档约定时，Spec 优先写入 `.workspace-docs/specs/`，交接文档写入 `.workspace-docs/notes/`；否则使用目标仓库自己的文档目录。

## 工程预设

| 预设 | ID | 说明 |
|---|---|---|
| 工程模式 | `eng` | 工程纪律、`wait_subagent`、可选退出守卫 |
| 工程模式（无提问） | `eng-noask` | 不提供 `ask_user_question`；自主决策，并在报告中列明假设 |

两份预设在 DSH 标准预设基础上保留工程模式的委派纪律、工具结果保留阈值与任务唤醒配置。新版标准预设的时间上下文已同步；**自动化任务工具（`schedule_create/list/update/delete`）有意从两个工程预设剔除**（host 的 `schedule` 服务与侧栏「自动化任务」页面不受影响，其他预设照常可用）；插件市场工具保持上游默认禁用状态。

- 两个工程预设不挂 `tool-schedule`：页面「自动化任务」仍可查看/管理已有任务，但工程模式会话里模型无法创建或修改任务；需要在会话里创建任务时使用其它预设。
- 两个工程预设也不挂原生 `command-goal` / `tool-goal`：目标控制由独立的 `dsh-better-goal` 插件统一提供，工程模式和其他预设都使用同一个 `goal` 工具与 `/goal` 命令。

- `wait_subagent` 仅随这两个预设提供；其他预设仍可使用 DSH 原生的 `list_agents`、`send_message` 和 `interrupt_agent`。
- 退出守卫默认关闭。启用后，若回合结束时仍有运行中的直接子代理或 DSH 后台任务，会提醒 Agent 继续处理；用户中断始终放行。
- 守卫不管理 pm2、systemd、nohup 等外部常驻进程。
- 技能与预设内容更新需要重启 profile；运行时设置不需要。

## 长期目标（goal）

目标域由独立的 `dsh-better-goal` 插件拥有，Apollo 只负责装配：顶层 patch 禁用原生 goal 服务、round driver、`/goal` 命令、模型工具和 GoalBar UI，再插入该插件的稳定行。goal 的配置与功能不在 Apollo 表单里。

- 每个会话一个持久目标。模型侧只有单个 `goal` 工具，动作覆盖 `get` / `create` / `edit` / `pause` / `resume` / `complete` / `fail` / `clear`；人侧使用 `/goal` 命令。旧 `get_goal` / `create_goal` / `update_goal` 三个原生工具会被隐藏并替换为单 `goal` 工具，`todo_write` 仍只管理步骤。
- 目标按 DSH 原生 goal/change v1 日志持久化。会话重开、恢复或 fork 后状态恢复为 disarmed，需显式 `/goal resume`（或 UI 操作）才开始自动续跑；用户中断会停止自动续跑。
- 失败可立即以具体原因标记（持久化为 native blocked），完成需要对着当前证据逐条核验；不再有 blocked 三回合门槛。
- `roundLimitMode`（`agent` / `unlimited` / `fixed`）、`roundLimit` 和 `questionTimeoutSeconds` 都在 **Plugins → dsh-apollo → dsh-better-goal 行** 行配置，均为 volatile。提问超时只影响之后新建的等待，`-1` 表示永不超时，超时不会被当作同意。
- `unlimited` 在 UI 中显示为「无限」，内部沿用 `Number.MAX_SAFE_INTEGER` 兼容哨兵。

目标设置的完整语义以独立插件自身的 README 为准。

## 配置

打开 **Plugins → dsh-apollo → `apollo-skills` 行**。配置持久化到活动 profile 的覆盖文件，保存后即时生效，不会重挂插件。goal 的回合上限与提问超时在 **Plugins → dsh-apollo → dsh-better-goal 行** 行，见上一节。

### 启用 CLI 子代理

1. 在运行 DSH 的环境中安装并登录 Codex CLI 或 Claude Code，确认账户有可用额度。
2. 启用 DSH 的「子代理模型选择」。本包预设已声明 `modelSelectionSettings: true`；该策略在会话创建时固定，旧会话缺少 `provider` / `model` 参数时需新建会话。
3. 在 Apollo 配置中启用对应后端，填写可执行文件、模型允许列表与默认模型。
4. 为默认模型配置非空 effort 列表，并选择其中一个作为默认 effort；Codex 可额外选择 profile。
5. 选择接入范围与 CLI 权限，保存后使用。

> **CLI 权限独立于父会话。** 父会话的只读或审批状态不会自动限制 CLI 子代理。默认 Codex 为 `read-only`，Claude 为 `plan`；请谨慎启用更宽权限。

### 主要设置

| 设置 | 默认 | 说明 |
|---|---|---|
| `exitGuard` | `false` | 开启两个工程预设的退出守卫 |
| `subagents.eng` | `true` | 在 `eng` / `eng-noask` 中接入 CLI 路由 |
| `subagents.global` | `false` | 在所有具备所需工具和服务的预设中接入 |
| `subagents.<cli>.enabled` | `false` | 启用 `codex` 或 `claude` 后端 |
| `subagents.<cli>.executable` | `codex` / `claude` | PATH 命令名、绝对路径或 `~/` 路径 |
| `subagents.<cli>.defaultModel` | 空 | 省略 `model` 时使用的模型 |
| `subagents.<cli>.models` | `[]` | `{ id, efforts, defaultEffort }` 允许列表 |
| `subagents.codex.profile` | 空 | 可选 Codex profile；兼容独立 profile 配置文件与旧 `[profiles.*]` 段 |
| `subagents.codex.permissionMode` | `read-only` | `read-only` / `workspace-write` / `danger-full-access` |
| `subagents.claude.permissionMode` | `plan` | `plan` / `manual` / `dontAsk` / `acceptEdits` / `auto` / `bypassPermissions` |

接入范围按 `global || (eng && 当前预设是工程模式)` 判断。**接入开关不会安装缺失的 `subagent` 工具或扩展其参数 schema**；对应工具与宿主服务必须已存在。

完整字段与默认值见 [配置定义](<src/config.js>)。需要手工配置时，只写要覆盖的字段即可，例如：

```yaml
# ~/.dsh/profiles/<profile>/cordis.patch.yml
- id: apollo-skills
  config:
    subagents:
      codex:
        enabled: true
        executable: codex
        permissionMode: read-only
        defaultModel: <model-id>
        models:
          - id: <model-id>
            efforts: [low, medium, high]
            defaultEffort: medium
```

模型 ID、effort 和 profile 名必须以所用 CLI 及账户实际支持的值为准。网页表单会拒绝启用空模型列表的后端；手写配置虽可装载，但调用会失败。启用前至少配置一个模型。

### 旧配置

旧的 `<dshHome>/eng.json` 或 `atlas.json` 仅用于一次性导入可映射字段（目前为 `exitGuard`）。当前 profile 的显式配置优先，包括 `false`；旧文件不改写、不删除，导入失败只告警。

## 使用 CLI 子代理

通过已有的 `subagent` 工具指定 `provider: "codex"` 或 `provider: "claude"`：

```json
{
  "provider": "codex",
  "description": "检查模块边界",
  "prompt": "只读检查当前模块的依赖关系，列出问题及证据。",
  "cwd": "packages/example"
}
```

`model` 和 `reasoning_effort` 可省略，使用配置中的默认值。先调用 `list_subagent_models` 并指定对应 provider，可查看当前允许的模型和 effort。

创建立即返回 `{ "kind": "activation", "subagentId": "…" }`，结束后由 DSH 通知父会话并转发最终正文。

| 操作 | 工具 |
|---|---|
| 续聊或追加任务 | `send_message` |
| 查看子代理 | `list_agents` |
| 中断当前执行 | `interrupt_agent` |
| 等待结束 | `wait_subagent`（工程预设） |

### 行为边界

- **始终后台执行**：旧参数 `run_in_background` 已移除；CLI 桥不接受 `agent_preset`，也不支持用 `subagent_fork` 创建。
- **工作目录独立**：`cwd` 可为绝对路径或相对路径，省略则继承父会话当前目录；创建后固定，不跟随父会话后续切换。
- **身份固定**：可执行文件、模型、effort、Codex profile 与 CLI 配置目录在创建时持久化。修改设置不会改变已有子代理的这些值。
- **允许列表每轮校验**：移除某个模型或 effort 后，使用它的旧子代理会被拒绝执行，不会静默降级。
- **权限每轮更新**：新一轮使用最新权限设置。Codex 固定非交互审批，Claude 的权限提问自动拒绝，不会挂起等待人工回答。
- **可恢复、不自动重试**：原生 CLI 会话 ID 与投递记录存放在 DSH KV 中，不依赖对话正文，因此可跨压缩和宿主重启续接；CLI 回合失败后不自动重跑。
- **仅文本**：不支持图片等非文本输入。

Claude 的默认配置模式与显式 `CLAUDE_CONFIG_DIR` 分开保存，避免续接时改变全局配置或钥匙串定位。未设置该变量与显式设置为 `~/.claude` 的行为不同；使用默认登录态时应保持未设置。认证、CLI 版本、账户额度和模型可用性仍由对应 CLI 管理。

续接同时依赖 DSH KV 和原生 CLI 的会话文件。运行环境必须允许 CLI 正常访问其配置、缓存和会话目录；CLI 自身的权限模式不会解除外层进程的文件沙箱限制。Claude 首轮可能在转录写入失败时仍返回成功，随后续接报 `No conversation found`；此时应检查转录写入是否出现 `EPERM` / `EACCES`，按宿主机制为该次调用申请必要权限，避免通过复制凭据或改配置目录绕过。

## 反向代理

Apollo 的只读能力探针默认仅接受 loopback Host 与同源请求。使用受信反向代理时，在活动 profile 中手工声明：

```yaml
- id: apollo-skills
  config:
    trustedHosts: [dsh.example.com]
    # 仅受信代理下按需开启：让官方 client 将此部署视为自有宿主
    declareOwnsHost: true
```

这两个部署字段不在网页表单中编辑，修改后会正常重挂插件。**Host 信任检查不是身份认证**，代理仍需自行配置访问控制。

`GET /apollo/api/capabilities` 只返回 CLI 路径、版本与 Codex profile 名称，不返回配置正文或凭据；结果缓存 30 秒。配置保存使用 DSH 原生设置接口，Apollo 不提供独立写配置路由。

## 开发与验证

从源码仓库运行；生产依赖为 Schemastery 和独立的 `dsh-better-goal` 插件，浏览器端使用宿主 React。测试额外使用 `js-yaml` 与 React TestRenderer，无需构建或启动 Web 服务。

```sh
npm install
npm test

# 严格使用指定版本的真实 DSH 安装作为漂移基准
DSH_PACKAGE_ROOT=/path/to/node_modules/@deepseek-ai/dsh npm test
```

[预设漂移测试](<tests/upstream-drift.test.mjs>)比较完整 YAML 配置树，覆盖行序、嵌套配置、隔离域和禁用状态，仅放行声明的本地插件、有意剔除的原生行及调参；被剔除的原生行仍会先断言存在于上游。 [装配测试](<tests/assembly.test.mjs>)解析顶层 patch：原生 goal 禁用行、`dsh-better-goal` 稳定行和运行时依赖声明；安装依赖后还会与独立 bundle 的 patch 逐行比对。测试仅从 Node 安装路径和模块解析路径查找 DSH，未找到兼容安装时会跳过外部基准检查。使用 Desktop 自带运行时等其他安装布局时，请显式设置 `DSH_PACKAGE_ROOT`；指定后，无效路径、不兼容版本或缺失导出均直接失败。

### 真实宿主与 CLI 冒烟

[冒烟脚本](<scripts/runtime-smoke.mjs>)使用临时 home 和 profile，不启动 Web 服务，也不替换当前 GUI。先清除复用和跳过阶段的变量，再选择一个后端运行完整验收：

```sh
unset APOLLO_SMOKE_HOME APOLLO_SMOKE_HOST_ONLY APOLLO_SMOKE_PHASE

# Codex
DSH_PACKAGE_ROOT=/path/to/node_modules/@deepseek-ai/dsh \
APOLLO_SMOKE_CLI=codex \
APOLLO_CODEX_MODEL='your-model-id' \
APOLLO_SMOKE_LIFECYCLE=1 \
node scripts/runtime-smoke.mjs

# Claude Code
DSH_PACKAGE_ROOT=/path/to/node_modules/@deepseek-ai/dsh \
APOLLO_SMOKE_CLI=claude \
APOLLO_CLAUDE_MODEL='your-model-id' \
APOLLO_SMOKE_LIFECYCLE=1 \
node scripts/runtime-smoke.mjs
```

| 环境变量 | 用途 |
|---|---|
| `APOLLO_SMOKE_CLI` | `codex` 或 `claude`；省略则验证两者 |
| `APOLLO_CODEX_MODEL` / `APOLLO_CLAUDE_MODEL` | 所选后端的实际可用模型 |
| `APOLLO_CODEX_BIN` / `APOLLO_CLAUDE_BIN` | 可选可执行文件路径 |
| `APOLLO_CODEX_PROFILE` | 可选 Codex profile |
| `APOLLO_SMOKE_HOST_ONLY=1` | 仅验宿主、双预设、配置与原生委派；仍需设置模型占位值，但不会调用 CLI |
| `APOLLO_SMOKE_LIFECYCLE=1` | 追加中断续接、可写与只读权限切换 |
| `APOLLO_SMOKE_HOME` | 复用已通过首次两轮检查的临时 home，跳过首次两轮检查；仍需设置对应模型变量 |
| `APOLLO_SMOKE_PHASE=read-only` | 生命周期检查只追加只读阶段 |

默认检查两轮记忆、创建时的当前目录解析、父会话结果通知及宿主重载续接。完整生命周期还检查进行中回合中断后续接，以及可写模式切回只读模式。验收通过必须同时满足：输出 `APOLLO_RUNTIME_SMOKE_PASSED`、进程退出码为 0、临时 home 中 `results.json` 的对应阶段全部为 `passed: true`。完整验收应从 fresh home 开始；复用失败 home 或跳过阶段的结果不能代替它。

在 DSH `0.2.1-rc.2` 上，Claude Code `2.1.305` 的 fresh 完整生命周期已实测通过，覆盖上述阶段，且重载、中断及权限切换后原生会话 ID 保持不变。中断检查证明回合取消与续接，不代表验证了长命令进程树终止；权限切换检查不代表额外验证了权限提问流程。新会话的宿主重载恢复也不等同于旧版本会话迁移。

**真实 CLI 验证需要登录和可用额度，会产生实际调用费用。** 单元测试或宿主检查通过，不代表对应 CLI 的真机流程通过。

## 实现入口

- [宿主插件](<src/index.js>)：注册技能、配置和 CLI 桥。
- [顶层装配](<cordis.patch.yml>)：禁用原生 goal 行，插入 `apollo-skills` 与独立的 `dsh-better-goal` 稳定行。
- [配置 schema](<src/config.js>)、[设置服务](<src/settings.js>)、[浏览器表单](<src/client.js>)。
- [子代理路由](<src/subagents.js>)、[CLI 适配器](<src/cli-adapter.js>)、[会话存储](<src/cli-sessions.js>)。
- [eng 预设](<presets/eng.patch.yml>)、[eng-noask 预设](<presets/eng-noask.patch.yml>)：各自行清单的唯一来源。保持 `eng` / `eng-noask` ID 不变，以支持历史会话恢复。

宿主声明 `apollo-skills` 和 `dsh-better-goal` 两行；两个预设由独立 bundle patch 提供。`dsh-better-goal` 的 goal 服务、单工具、命令、UI 与配置行都在独立包内，Apollo 不保留 goal 域实现。不要为同一个包重复添加宿主插件行；与独立 bundle 同时选中时相同 id/name 会去重。

## 许可与致谢

本包采用 **GPL-3.0-or-later**，见 [LICENSE](<LICENSE>)。

- 工程预设改编自 DeepSeek Harness 的 MIT 标准预设，见 [eng 声明](<presets/eng/NOTICE>)、[eng-noask 声明](<presets/eng-noask/NOTICE>)及 [MIT 许可](<third-party/LICENSE-MIT-dsh-standard-preset>)。
- `tdd` / `diagnosing-bugs` 改编自 [mattpocock/skills](https://github.com/mattpocock/skills)，见 [第三方声明](<third-party/NOTICE-mattpocock-skills>)。
- 能力探针的请求信任边界改编自 dsh-better-sidebar，源自 BSD-3-Clause 的 DSH client connection 实现。
