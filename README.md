# dsh-apollo

为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 提供流程技能、工程模式，以及 **Codex / Claude CLI 可续接后台子代理**。

- **规划与执行**：把大型需求拆为可验证的 Spec，按依赖分波并行执行，再由子代理审查。
- **工程预设**：提供「工程模式」与「工程模式（无提问）」，包含等待子代理工具和可选退出守卫。
- **CLI 子代理**：复用 DSH 的委派、消息和中断工具；模型、effort、Codex profile 与 CLI 权限集中配置。
- **统一设置**：Apollo 表单接入 DSH Plugins 页的行配置槽位，使用正式 Config 存储，保存后即时生效。

纯 ESM，无构建步骤。**最低支持 DSH `0.2.1-rc.2`**；不兼容旧版子代理接口。

## 安装

需要 Node.js `^22.19.0 || >=24.0.0`，DSH 版本范围为 `>=0.2.1-rc.2 <0.3.0`。已验证基准为 `0.2.1-rc.2`。DSH 的兼容检查会纳入预发布版，因此该声明也可能接受尚未验证的后续 RC（包括 `0.3.0` 的预发布版）；版本范围不等于逐版验证保证，见 [兼容声明](<package.json>)。

```sh
dsh plugin --profile <profile> add github:Menghuan1918/dsh-apollo

# 本地开发安装
dsh plugin --profile <profile> add link:/absolute/path/to/dsh-apollo
```

如果新 RC 适配尚未合入默认分支，安装对应分支：

```sh
dsh plugin --profile <profile> add 'github:Menghuan1918/dsh-apollo#compat/dsh-0.2.1-rc.2'
```

重启对应 profile 的 DSH 进程后，可以看到：

1. 技能目录中的 8 个流程技能。
2. 预设选择器中的「工程模式」和「工程模式（无提问）」。
3. **Plugins → dsh-apollo → `apollo-skills` 行**的运行时配置表单。

技能需要所选预设挂载 DSH 的技能工具。CLI 后端默认关闭，安装插件不会自动安装、登录或启用 Codex / Claude。

```sh
# 检查装配结果：应包含 apollo-skills 和两个工程预设
dsh --profile <profile> --dump-config

# 卸载
dsh plugin --profile <profile> remove dsh-apollo
```

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

技能正文以中文为主。工作区已有文档约定时，Spec 优先写入 `.workspace-docs/specs/`，交接文档写入 `.workspace-docs/notes/`；否则使用目标仓库自己的文档目录。

## 工程预设

| 预设 | ID | 说明 |
|---|---|---|
| 工程模式 | `eng` | 工程纪律、`wait_subagent`、可选退出守卫 |
| 工程模式（无提问） | `eng-noask` | 不提供 `ask_user_question`；自主决策，并在报告中列明假设 |

两份预设跟随 DSH 标准预设，保留工程模式的委派纪律、工具结果保留阈值与任务唤醒配置。新版标准预设的时间上下文和调度工具也已同步；插件市场工具保持上游默认禁用状态。

- `wait_subagent` 仅随这两个预设提供；其他预设仍可使用 DSH 原生的 `list_agents`、`send_message` 和 `interrupt_agent`。
- 退出守卫默认关闭。启用后，若回合结束时仍有运行中的直接子代理或 DSH 后台任务，会提醒 Agent 继续处理；用户中断始终放行。
- 守卫不管理 pm2、systemd、nohup 等外部常驻进程。
- 技能与预设内容更新需要重启 profile；运行时设置不需要。

## 配置

打开 **Plugins → dsh-apollo → `apollo-skills` 行**。配置持久化到活动 profile 的覆盖文件，保存后即时生效，不会重挂插件。

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

Claude 的默认配置模式与显式 `CLAUDE_CONFIG_DIR` 分开保存，避免续接时改变全局配置或钥匙串定位。认证、CLI 版本、账户额度和模型可用性仍由对应 CLI 管理。

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

从源码仓库运行；生产依赖为 Schemastery，浏览器端使用宿主 React。测试额外使用 `js-yaml` 与 React TestRenderer，无需构建或启动 Web 服务。

```sh
npm install
npm test

# 严格使用指定版本的真实 DSH 安装作为漂移基准
DSH_PACKAGE_ROOT=/path/to/node_modules/@deepseek-ai/dsh npm test
```

[预设漂移测试](<tests/upstream-drift.test.mjs>)比较完整 YAML 配置树，覆盖行序、嵌套配置、隔离域和禁用状态，仅放行声明的本地插件及调参。测试仅从 Node 安装路径和模块解析路径查找 DSH，未找到兼容安装时会跳过外部基准检查。使用 Desktop 自带运行时等其他安装布局时，请显式设置 `DSH_PACKAGE_ROOT`；指定后，无效路径、不兼容版本或缺失导出均直接失败。

### 真实宿主与 CLI 冒烟

[冒烟脚本](<scripts/runtime-smoke.mjs>)使用临时 home 和 profile，不启动 Web 服务，也不替换当前 GUI。以下示例仅验证 Codex：

```sh
DSH_PACKAGE_ROOT=/path/to/node_modules/@deepseek-ai/dsh \
APOLLO_SMOKE_CLI=codex \
APOLLO_CODEX_MODEL=<model-id> \
APOLLO_SMOKE_LIFECYCLE=1 \
node scripts/runtime-smoke.mjs
```

| 环境变量 | 用途 |
|---|---|
| `APOLLO_SMOKE_CLI` | `codex` 或 `claude`；省略则验证两者 |
| `APOLLO_CODEX_MODEL` / `APOLLO_CLAUDE_MODEL` | 所选后端的实际可用模型 |
| `APOLLO_CODEX_BIN` / `APOLLO_CLAUDE_BIN` | 可选可执行文件路径 |
| `APOLLO_CODEX_PROFILE` | 可选 Codex profile |
| `APOLLO_SMOKE_HOST_ONLY=1` | 仅验宿主、双预设、配置与原生委派，不启动 CLI；模型变量仅作配置占位 |
| `APOLLO_SMOKE_LIFECYCLE=1` | 追加中断续接、可写与只读权限切换 |
| `APOLLO_SMOKE_HOME` | 复用脚本生成的临时 home，跳过首次两轮检查 |
| `APOLLO_SMOKE_PHASE=read-only` | 生命周期检查只追加只读阶段 |

默认检查两轮记忆、当前目录、结果通知及宿主重载续接。成功输出 `APOLLO_RUNTIME_SMOKE_PASSED`，明细保存在临时 home 的结果文件中；历史证据与本轮结果分别记录。

**真实 CLI 验证需要登录和可用额度，会产生实际调用费用。** 单元测试或宿主检查通过，不代表对应 CLI 的真机流程通过。

## 实现入口

- [宿主插件](<src/index.js>)：注册技能、配置和 CLI 桥。
- [配置 schema](<src/config.js>)、[设置服务](<src/settings.js>)、[浏览器表单](<src/client.js>)。
- [子代理路由](<src/subagents.js>)、[CLI 适配器](<src/cli-adapter.js>)、[会话存储](<src/cli-sessions.js>)。
- [eng 预设](<presets/eng.patch.yml>)、[eng-noask 预设](<presets/eng-noask.patch.yml>)：各自行清单的唯一来源。保持 `eng` / `eng-noask` ID 不变，以支持历史会话恢复。

宿主只声明一行 `apollo-skills`；两个预设由独立 bundle patch 提供。不要为同一个包重复添加宿主插件行。

## 许可与致谢

本包采用 **GPL-3.0-or-later**，见 [LICENSE](<LICENSE>)。

- 工程预设改编自 DeepSeek Harness 的 MIT 标准预设，见 [eng 声明](<presets/eng/NOTICE>)、[eng-noask 声明](<presets/eng-noask/NOTICE>)及 [MIT 许可](<third-party/LICENSE-MIT-dsh-standard-preset>)。
- `tdd` / `diagnosing-bugs` 改编自 [mattpocock/skills](https://github.com/mattpocock/skills)，见 [第三方声明](<third-party/NOTICE-mattpocock-skills>)。
- 能力探针的请求信任边界改编自 dsh-better-sidebar，源自 BSD-3-Clause 的 DSH client connection 实现。
