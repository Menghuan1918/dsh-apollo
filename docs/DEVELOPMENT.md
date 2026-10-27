# dsh-apollo 开发与实现说明

面向维护者、集成者和需要排查装配问题的用户。用户安装与配置请看 [README](../README.md)；本文保留 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）插件的实现细节、历史兼容与验证方法。

当前实现版本：`0.4.0`；npm 包名是 `@menghuan1918/dsh-apollo`。纯 ESM，无构建步骤；宿主浏览器半边是直接加载的闭包工厂，不需要打包。

## 目录

1. [交付面与行模型](#交付面与行模型)
2. [配置与投影](#配置与投影)
3. [工程预设内部](#工程预设内部)
4. [CLI 子代理桥](#cli-子代理桥)
5. [能力探针与反向代理](#能力探针与反向代理)
6. [安装、升级与卸载](#安装升级与卸载)
7. [测试与冒烟](#测试与冒烟)
8. [历史兼容与迁移](#历史兼容与迁移)
9. [实现入口](#实现入口)
10. [许可与致谢](#许可与致谢)

## 交付面与行模型

### 包清单

[package.json](../package.json) 声明了三份 bundle patch，按以下顺序加载：

1. [cordis.patch.yml](../cordis.patch.yml)：顶层宿主行；
2. [presets/eng.patch.yml](../presets/eng.patch.yml)：`eng` 预设；
3. [presets/eng-ptc.patch.yml](../presets/eng-ptc.patch.yml)：`eng-ptc` 预设。

浏览器半边由 `dsh.client` 的注入列表发现；`exports["./client"]` 指向 [src/client.js](../src/client.js)。`exports["./presets/*"]` 让预设里的本地插件通过裸子路径引用本包内的模块。

运行时依赖：

- `@deepseek-ai/schemastery`：行配置 schema；
- `dsh-better-goal`：独立的 goal 插件，依赖精确的 npm 版本 `0.1.0`（见 `dependencies`），不是 Git commit、分支、范围或 `file:` 说明符；
- `react` 是 peer dependency，由宿主提供。

### 为什么宿主只有一行 `apollo-skills`

`apollo-skills` 是 Apollo 唯一的宿主插件行，同时承担：

1. 向技能注册表的全局层注册包内 `skills/*/SKILL.md`；
2. 挂载正式行配置（`src/config.js` 的 Schemastery schema）和浏览器配置页；
3. 注册只读能力探针 `/apollo/api/capabilities` 与模型自动发现 `/apollo/api/models`；
4. 在已有 `subagent` 工具上安装 CLI 路由桥；
5. 在行配置开启 `declareOwnsHost` 时注入宿主声明。

技能 provider 以 rank 600 注册到全局层；用户技能根目录中的同名技能可以覆盖它。

浏览器半边的模块发现依赖行的**包清单**。`dsh-client-modules` 只接受裸包名或两段 scoped 名，并拒绝第二个解析到同一包名的活跃行。因此不能把 node 半边和浏览器半边拆成两行——拆开会导致浏览器模块加载失败。预设行不经过 node 插件加载，所以可以各自作为独立的 bundle patch。

### 行配置键与稳定标识

浏览器半边按 `<npm 包名>#<行 id>` 注册 `plugins.row.config`。包名改为 scoped 后，Apollo 并排注册两个键：

- `@menghuan1918/dsh-apollo#apollo-skills`：当前包名对应的主键；
- `dsh-apollo#apollo-skills`：旧 unscoped 包名的历史键，只为仍按旧依赖槽记录配置的 profile 保留入口。

goal 行由独立插件提供，并注册三个键，都指向同一份配置和同一个行 id：

- `dsh-better-goal#dsh-better-goal`：独立安装；
- `@menghuan1918/dsh-apollo#dsh-better-goal`：Apollo 以 scoped 包装配；
- `dsh-apollo#dsh-better-goal`：历史 Apollo 装配。

npm 包名和浏览器 closure id 已随发行名改为 scoped，但**行 id/name、预设 ID 和 CLI 路由名不随之改名**：`apollo-skills`、`dsh-better-goal`、`eng` / `eng-ptc`、外部 provider `codex` / `claude` 和内部路由 `apollo-cli-codex` / `apollo-cli-claude` 都是兼容契约。只改发行名时，不迁移行 id、不重命名预设，也不改 CLI 路由。

### 顶层 patch 与 goal 行去重

[cordis.patch.yml](../cordis.patch.yml) 先禁用原生 goal 域：

- `goal`
- `goal-round-driver`
- `command-goal`
- `tool-goal`
- `ui-goal`

然后插入两行：

- `dsh-better-goal`：独立插件的稳定行，id 和 name 都是 `dsh-better-goal`；
- `apollo-skills`：Apollo 的宿主行。

为什么 Apollo 要自己携带这些行，而不是只声明依赖：

- DSH 只把**直接安装**的 bundle 加入 `dsh.profile.bundles`，不会自动应用传递依赖的 bundle patch；
- 所以即使 `dsh-better-goal` 是 Apollo 的 npm 依赖，它的 patch 也不会自动生效；
- Apollo 的顶层 patch 因此复制了同一组原生禁用行和同一个 `dsh-better-goal` 插入行。

稳定行去重规则：

- 两个 bundle 插入的顶层行 id/name 都是 `dsh-better-goal`；Loader 按行 id 去重，插件只激活一次，浏览器模块也只有一个 active source。
- 不要手写第三行 `dsh-better-goal`。
- **禁用或移除独立的 `dsh-better-goal` bundle，不等于禁用 Apollo 插入的 `dsh-better-goal` 行**：只要 Apollo 还在，goal 仍然可用。
- 要彻底移除 goal 能力，需要同时移除 Apollo，或显式禁用该行。
- 只安装 Apollo、未单独选中 `dsh-better-goal` bundle 时，不需要任何额外操作。
- 卸载 Apollo 后，profile 不再有 Apollo 插入的 goal 行；如果之前单独添加过 `dsh-better-goal` bundle，需要自行决定是否一并移除。

DSH `0.2.1-rc.2` 的已知限制：

- 同时显式选中两个 bundle 时，Loader 仍只激活一个实例，但管理器会把组合行开关标成只读（`unaddressable`），目标设置保存也可能被拒绝。
- 因此通常只保留 Apollo 入口，不要重复 `add`。
- 若只需开关有效行，可在 profile 覆盖中写 `id: dsh-better-goal`、`disabled: true/false`；不要重新启用原生 `goal` 行。

### 预设 ID 与历史会话

`presets/eng.patch.yml` 和 `presets/eng-ptc.patch.yml` 是预设行清单的唯一事实源。`config.id` 必须保持 `eng` / `eng-ptc`，因为历史会话按预设 ID 恢复。`config.order` 分别是 10 和 11。`eng-noask` 已在 0.4.0 删除，用它开的历史会话不再能按原预设恢复。

`presets/eng/` 目录只承载两套预设共用的本地插件模块（exit-guard、wait-subagent、mode-instructions），不承载第二份行清单。旧机制中的 `agent.cordis.yml` / `preset.yml` 已删除，结构测试会拒绝它们复活；旧的 `<dshHome>/.agent-presets` 同步副本机制也已移除。

## 配置与投影

### 行配置

[src/config.js](../src/config.js) 是设置的唯一事实源，默认值如下：

```js
{
  exitGuard: false,
  subagents: {
    eng: true,
    global: false,
    codex: {
      enabled: false,
      executable: 'codex',
      profile: '',
      permissionMode: 'read-only',
      defaultModel: '',
      models: [],
    },
    claude: {
      enabled: false,
      executable: 'claude',
      permissionMode: 'plan',
      defaultModel: '',
      models: [],
    },
  },
  trustedHosts: [],
  declareOwnsHost: false,
}
```

字段分为两类：

- **volatile 运行时字段**：`exitGuard`、`tiers.fast`、`tiers.quality`、`subagents.eng`、`subagents.global`、`subagents.codex.*`、`subagents.claude.*`。保存后不重挂插件，消费方每次读取都拿到最新值。
- **部署标志**：`trustedHosts`、`declareOwnsHost`。只在行配置里声明，改动会让 Loader 正常重挂本行。

浏览器表单只允许写入 volatile 路径；`dsh-settings` 会拒绝其他路径。部署标志不能从网页改写。

模型条目形状是 `{ id, efforts[], defaultEffort }`。前端校验要求：

- 模型 id 非空且不重复；
- **已启用**的后端至少有一个模型；
- 默认模型在模型列表中；
- 该模型的 `efforts` 非空，且 `defaultEffort` 属于 `efforts`。

手工配置可以绕过网页校验，但 CLI 路由在调用时会重新校验，非法组合会直接报错。`normalizeConfig` 对任意来源（活配置、旧 JSON、残缺对象）都回退默认且不抛错；`currentConfig` 经 configEditor 读取活 fiber 配置，找不到时使用调用方给的 fallback。

### 设置持久化与热更新

表单写入经 DSH 原生设置接口落到当前 profile 的 `cordis.patch.yml`，不再有 Apollo 自有的写配置路由，也不再有 `<dshHome>/eng.json` 写入路径。

热更新机制：

- `exitGuard` 在每次 `agent/turn-stopping` 读取当前配置；
- CLI 路由在每次子代理创建 / 每轮执行时读取活配置；
- goal 的三个设置也是 volatile，由独立插件在自己的行上读取；
- 技能与预设是装配内容，改动文件后需要重启 profile；
- 浏览器刷新不能替换宿主实现。

[src/settings.js](../src/settings.js) 还负责：

- 用 `settings.configure({ auto: false }, ctx.fiber)` 登记本行自带配置页，避免宿主按 schema 自动生成第二页；
- 延迟注入 `webServer`，注册只读能力路由与模型发现路由；
- 一次性只读导入旧配置文件。

### 旧配置导入

旧文件：

- `<dshHome>/eng.json`
- `<dshHome>/atlas.json`（旧名，只读回退）

规则：

- 只导入有映射关系的字段，目前是 `exitGuard`；
- 当前 profile 的显式值优先，包括显式 `false`；
- 生效值已与旧值相同则不再写盘；
- 旧文件永不改写、永不删除；
- 导入失败只告警，不影响插件装载；
- `eng.json` 优先，缺失或损坏时回退 `atlas.json`。

这套逻辑在 [src/settings.js](../src/settings.js)，测试在 [tests/settings.test.mjs](../tests/settings.test.mjs)。

### goal 行设置

goal 行由独立插件拥有，三个字段都是 volatile：

| 设置 | 默认 | 解析规则 |
|---|---|---|
| `roundLimitMode` | `agent` | `agent` / `unlimited` / `fixed` |
| `roundLimit` | `256` | 仅 `fixed` 使用；必须是正安全整数 |
| `questionTimeoutSeconds` | `120` | `-1` 或 `[1, 2147483]` 的整数 |

`agent` 模式下，工具可以提供可选轮数上限；创建时省略表示不施加策略性硬上限，编辑/恢复时省略保留已有上限。`fixed` 模式统一使用设置值，陈旧调用不能覆盖它。`unlimited` 在原生 goal/change v1 中保存为 `Number.MAX_SAFE_INTEGER` 兼容哨兵；驱动不对它另加策略性轮数限制，界面显示为“无上限”，回退到原生实现时会显示一个极大的有限数。

提问超时只影响新发起的等待，正在等待的问题保留原期限；超时返回原生 pending，不伪造答案、不等于用户同意。

重开、恢复或 fork 会话时，目标和计数恢复，但自动续跑保持 disarmed；需要 UI 继续或显式 `resume` 才会启动。fork 按原生 goal 日志前缀恢复，不引入独立 sidecar 状态或日志截断式 rewind。失败可立即以具体原因结束（持久化为 native blocked），完成需按当前证据核验，不设三回合门槛。

### 投影

有两类“投影”，不要混淆：

- **配置投影**：`dsh-settings` 把 schema 中的 volatile 字段投影成网页表单，`trustedHosts` / `declareOwnsHost` 永远在表单之外。测试 [tests/config.test.mjs](../tests/config.test.mjs) 复刻了宿主的 `volatileForm` / `projectForm` / `isVolatilePath` 三个纯函数来锁定这个契约。
- **goal 状态投影**：独立 `dsh-better-goal` 插件保持原生 goal/change v1 日志和 `stateVersion: 6` 的 projection，可读取并回放既有目标。Apollo 不保留 goal 域实现，也不引入 sidecar 状态或日志截断式 rewind。用户操作见独立插件 README；协议与恢复细节见[独立插件开发文档](https://github.com/Menghuan1918/dsh-better-goal/blob/main/docs/DEVELOPMENT.md)。

## 工程预设内部

### eng 的构成

[presets/eng.patch.yml](../presets/eng.patch.yml) 是 DSH 内置 `standard` 预设的整块 fork，额外包含：

- 本地插件 [wait-subagent](../presets/eng/plugins/wait-subagent/index.js)：`wait_subagent` 工具；
- 本地插件 [exit-guard](../presets/eng/plugins/exit-guard/index.js)：可选退出守卫；
- 本地插件 [mode-instructions](../presets/eng/plugins/mode-instructions/index.js)：工程模式提示词段。

有意的差异：

- 不挂 `tool-schedule`（`schedule_create/list/update/delete` 不存在于工程模式会话）；
- 不挂原生 `command-goal` / `tool-goal`，goal 由独立插件提供；
- `tool-jobs.maxConsecutiveWakes` 调到 5000（上游 `standard` 是 3）；
- `tool-result-pruner` 阈值是上游的 2 倍：`thresholdChars: 16384`、`headChars: 8192`、`tailChars: 2048`；
- `tool-plugin-manager` / `tool-plugin-market` 保持上游默认禁用；
- 宿主行使用 `persona`、`agent-instructions`、`time-context` 等与 0.2.1 标准预设对齐的配置。

### eng-ptc 的构成

[presets/eng-ptc.patch.yml](../presets/eng-ptc.patch.yml) 是 eng 的拷贝，差异恰好是上游 `ptc` 相对 `standard` 的差异，外加一个提示词开关：

- 在 `present` 前加 `tool-presentation { mode: ptc }`，所有工具经 `run_code` 的 TypeScript SDK 调用（依赖宿主 `ptc-runtime` 行）；
- `workflow-ptc` / `tool-workflow` 设为 `disabled: true`，与上游一致；
- `eng-mode-instructions` 行带 `config: { ptc: true }`，追加「在一个 run_code 里派发多个子代理」的扇出规则（工程模式段不写 workflow 用法，eng 下以内置 workflow 说明为准）；run_code 本身的用法由内置的 `tools:sdk` / `tools:ptc-only` 段说明，不重复。

本地插件直接复用 `presets/eng/plugins/*`。维护时先改 eng，再重做这几处差异；[tests/upstream-drift.test.mjs](../tests/upstream-drift.test.mjs) 同时把 eng 对齐上游 `standard`、把 eng-ptc 对齐上游 `ptc`，并断言 eng-ptc 与 eng 的差异恰为上述几处。

### 工程模式提示词

`eng:mode-instructions`（order 1）是两套预设共用的提示词段，`text` 是函数，每次组装时读取活配置渲染：

- 通用纪律：KISS / YAGNI、检查先行、修复根因、一个连贯变更、尊重既有约定、思考不预演代码与防循环、防过度设计与过度防御（借鉴 opencode AGENTS.md 的 General Principles）、验证与汇报、权限 / Git 身份 / 依赖边界、禁止全盘搜索、命令与进程纪律。这部分原在用户级 `~/.dsh/AGENTS.md`，0.4.0 起归插件所有；AGENTS.md 只留本机约定（ws-search、find-docs、rexec）。
- 委派与编排，以及按 `tiers.fast` / `tiers.quality` 渲染的模型分档；未配置的档位提示「省略 provider / model / reasoning_effort，沿用父会话路由」。
- `exitGuard` 开启时追加退出守卫说明；`ptc: true` 时切换扇出规则。
- 写法是弱约束：开头声明用户的明确指示优先。改设置会让下一次请求的提示词变化并失去一次前缀缓存。

### 组装后的提示词快照

[prompts/eng.md](../prompts/eng.md) 和 [prompts/eng-ptc.md](../prompts/eng-ptc.md) 是真实宿主为两套预设组装出的完整系统提示词，供人审查；不要手改，改了提示词后用下面的命令重新生成：

```sh
DSH_PACKAGE_ROOT=/path/to/node_modules/@deepseek-ai/dsh npm run prompts
```

[scripts/render-prompts.mjs](../scripts/render-prompts.mjs) 用临时 home 启动 headless 宿主（与冒烟相同，不启动 Web 服务），设置为退出守卫关闭、分档用 `<fast-provider>` 等占位路由，渲染时去掉每次请求的运行时上下文（时间、工作目录），也不展开工具 schema；Web GUI 宿主独有的段落不在其中。[tests/prompts.test.mjs](../tests/prompts.test.mjs) 校验快照里的工程模式段与当前代码一致，忘了重新生成时普通 `npm test` 就会失败；内置段落随 DSH 版本变化，只在重新生成时更新。

### 模型分档

设置页的分档下拉框读取 `GET /apollo/api/routes`（[src/panel.js](../src/panel.js) 的 `collectTierRoutes`）：路由来自宿主 `subagentModelSelection.current()` 的 `allowedModels`，effort 来自 `llm.resolveModelInfo(...).reasoning`；单条解析失败只让该条 efforts 为空。白名单外的已存路由会阻止保存。分档只影响提示词，真正的路由校验仍由 `tool-subagent` 的模型选择策略执行。

### wait_subagent

预设本地工具，接收 `subagent_id` 数组，并发等待所有直接子代理，每个 id 返回一行短结果（done + stop reason）。子代理的完整内容由框架的 settlement notice 投递，不在工具结果里重复。

行为细节：

- 只接受当前 Agent 的直接子代理（depth 1）；出现未知 id 时整批快速失败，不等待任何子代理；
- 多个 id 共享一个 `timeout_ms` 窗口；传入值低于 15 分钟时自动提升到 15 分钟（子代理结束本就会通知父会话，短超时只会白白消耗回合）；
- 刚派发、尚未启动的子代理有 30 秒启动宽限，避免误报 “not running”；
- 用户中断会中止等待；
- 不操作 `agent.inbox`，不吞掉中途消息或结算通知。

测试在 [tests/wait-subagent.test.mjs](../tests/wait-subagent.test.mjs)。

### exit guard

监听 `agent/turn-stopping`。开启后，如果当前 Agent 仍有：

- 运行中的直接子代理，或
- DSH 本地 job 注册表中非终态的后台任务，

就通过 `agent.steer` 注入运行清单，强制回合继续，直到用 `wait_subagent` / `job_output` / `job_kill` 处理完毕。

边界：

- 默认关闭；每次回合读取当前 `exitGuard`；
- 用户中断（signal aborted）不触发；
- 查询失败按 fail-open 处理：告警并放行，避免卡死；
- 只看 DSH 本地注册表和直接子代理，不管理 pm2、systemd、nohup 等外部常驻进程；
- 没有 `exitGuardIgnore` 豁免清单（旧机制已移除，避免静默绕过守卫）。

测试在 [tests/exit-guard.test.mjs](../tests/exit-guard.test.mjs)。

## CLI 子代理桥

### 路由与开关

CLI 桥不注册新工具；它在宿主已有的 `subagent` / `subagent_fork` / `list_subagent_models` 工具上安装 `tools.guard` 和 `tools.execute` 拦截。

- 外部可见 provider 名：`codex`、`claude`；
- 内部路由名：`apollo-cli-codex`、`apollo-cli-claude`，只能由桥内部使用；把它们当 provider 传入会被拒绝；
- `subagent_fork` 不能创建 CLI 子代理；
- `agent_preset` 对 CLI 子代理不支持；
- `run_in_background` 参数已移除，CLI 子代理由桥固定为后台运行；
- `enabledIn` 判断：`subagents.global || (subagents.eng && 当前预设是 eng/eng-ptc)`。当前预设优先从 `sessionProjections.stateOf(..., 'agentPreset')` 读取，取不到时退回 session header。
- 工程预设的 `tool-subagent` 行声明 `modelSelectionSettings: true`；该策略在会话创建时固定，旧会话缺少 `provider` / `model` 参数时需要新建会话。

### 模型、effort 与身份

创建时用 `selectCli` 解析并校验：

- 后端必须已启用；
- 模型必须在 `models` 白名单中；省略 `model` 时使用 `defaultModel`；
- effort 必须在所选模型的 `efforts` 中；省略时使用 `defaultEffort`；
- Codex 可选 profile，Claude 没有 profile 概念。

创建记录会固定：

- CLI 类型、父 Agent、初始工作目录；
- 可执行文件的绝对路径；
- 模型、effort、Codex profile；
- CLI 配置目录（`CODEX_HOME` / `CLAUDE_CONFIG_DIR`，或默认 home）。

后续轮次只允许使用记录中的模型 / effort / profile / 可执行文件；请求不一致会拒绝，不会静默降级。权限模式是例外：每轮读取最新设置。

### 工作目录与会话

`cwd` 解析规则：

- 绝对路径直接使用；
- 相对路径相对于父 Agent 的**当前工作目录**（`workingDirectory.ensure`），不是 session header 里可能过期的目录；
- 省略则继承当前目录；
- 创建后固定，不跟随父会话后续切换。

原生 CLI 会话 ID 和投递记录存放在 profile 范围的 DSH KV 中，不依赖对话正文。它们可以跨上下文压缩和宿主重启续接；但 CLI 回合失败不会自动重跑。

### 命令与权限

Codex（[src/cli/codex.js](../src/cli/codex.js)）：

- 使用 `codex exec --json`；
- `-p` / `-s` / `-a` / `-C` 必须放在 `exec` 之前，`resume <id>` 紧跟 `exec`；
- 审批固定 `-a never`，避免非交互管道挂起；
- `-s` 使用行配置的 `permissionMode`；
- 正文通过 stdin 传入。

Claude（[src/cli/claude.js](../src/cli/claude.js)）：

- 使用 `claude --print --output-format stream-json --verbose`；
- `--permission-mode` 使用行配置的档位；
- 额外传 `--permission-prompts none`：权限提问自动拒绝，而不是等待人工回答；
- 续接使用 `--resume <id>`；不传 `--no-session-persistence`；
- Claude 没有 cwd 选项，工作目录由 spawn 的 `cwd` 决定。

通用行为：

- 只支持文本；非文本块会被拒绝；
- 每个 CLI 回合只投递尚未 delivered 的用户消息，投递记录在 spawn 前落盘，避免崩溃后重发；
- 每轮执行前重新校验模型 / effort 白名单和当前权限；
- 身份相关字段固定，权限每轮更新；
- 不支持自动重试。

已实测基准：DSH `0.2.1-rc.2` + Claude Code `2.1.305` 的 fresh 完整生命周期通过。其他 CLI 版本、认证方式、模型名称仍需按实际环境验证。

### Claude 配置目录

Claude 的默认登录态与显式 `CLAUDE_CONFIG_DIR` 语义不同：

- 未设置 `CLAUDE_CONFIG_DIR` 时，桥会记录 `claudeDefaultHome: true`，续接时保留默认 `HOME` / 钥匙串查找；
- 显式设置时，按该目录传给托管子进程；
- 不要在桥外临时改变全局配置目录来“修复”续接，否则可能改变认证或钥匙串定位；
- Claude 首轮可能在转录写入失败时仍返回成功，随后续接报 `No conversation found`；此时应检查 `EPERM` / `EACCES` 和宿主沙箱，而不是复制凭据或改配置目录绕过。

## 能力探针与反向代理

### 只读接口

[src/panel.js](../src/panel.js) 提供两个只读接口。

`GET /apollo/api/capabilities`：

```text
{
  executables: {
    codex:  { executable, path, version },
    claude: { executable, path, version }
  },
  codexProfiles: string[]
}
```

`GET /apollo/api/models?cli=codex|claude`（按需触发，不缓存）：

```text
{
  cli,
  models: [{ id, efforts: string[], defaultEffort }],
  source: 'codex-catalog' | 'claude-models-api' | null,
  error: null | { code, status? }
}
```

发现来源：

- **Codex**：本机 `<executable> debug models` 的 JSON catalog（失败退回
  `debug models --bundled`）。只收 `visibility: "list"`，id 取 `slug`，effort 取
  `supported_reasoning_levels[].effort`，默认 effort 取 `default_reasoning_level`。
  `codex debug models` 不接受 `-p`，所以发现结果反映基础配置的 model_provider，
  不反映 Apollo 的 profile 设置。
- **Claude**：Claude CLI 没有模型清单命令，改读 Anthropic Messages 的
  `GET {ANTHROPIC_BASE_URL}/v1/models`。端点取进程 env 的
  `ANTHROPIC_BASE_URL`，其次 `<CLAUDE_CONFIG_DIR 或 ~/.claude>/settings.json` 的
  `env`；凭据来源整体优先（进程 env 有任一凭据时整套用 env，不把两边的
  token/key 各取一半）。effort 固定为 `--effort` 的实测五档，默认 `high`。
  系统钥匙串里的 OAuth 订阅凭据不参与发现。

约束：

- 只返回可执行文件名、解析路径、版本行、profile 名称、模型 id 与 effort；
- **绝不返回配置正文或凭据**；Claude 的 token 只在内存里拼进请求头，错误只回
  `code`/`status`，不回 URL 或响应正文；
- 只接受 GET；其他方法 405，且从不读取请求体；`/apollo/api/models` 缺省/未知
  `cli` 返回 400，并带 `cache-control: no-store`；
- 能力探针结果缓存 30 秒，避免每次打开设置页都 fork 两个 CLI；发现按按钮触发，
  不缓存；两者都有超时与结果长度上限（模型清单 200 条、响应 4 MiB）；
- 探针/发现失败各自降级成 `error.code`，不拖垮接口。

### 信任边界

默认只接受：

- loopback Host；
- 同源请求。

使用受信反向代理时，在活动 profile 手工声明：

```yaml
# ~/.dsh/profiles/<profile>/cordis.patch.yml
- id: apollo-skills
  config:
    trustedHosts: [dsh.example.com]
    # 仅受信代理下按需开启：让官方 client 把此部署视为自有宿主
    declareOwnsHost: true
```

`declareOwnsHost` 会在 index HTML 的 `<head>` 起始处注入 boot 全局，让官方 client 把反代页面当作 loopback，从而让设置镜像回到 host 持久化。**这依赖反向代理本身的信任边界，不是身份认证**；代理仍需自行配置访问控制。

`trustedHosts` / `declareOwnsHost` 是部署标志，不在网页表单中；修改后 Loader 会重挂本行。

## 安装、升级与卸载

### npm 安装

```sh
dsh plugin --profile <profile> add @menghuan1918/dsh-apollo@0.4.0
```

包发布到 npm 官方 registry 后即可用此命令安装，并带入精确依赖 `dsh-better-goal@0.1.0`，同时应用三份 bundle patch。安装后需要重启对应 profile 的 DSH 进程。README 中的 npm 命令是发布后的安装路径；首发完成前不要宣称 registry 已有该版本。

### GitHub 源码安装

```sh
dsh plugin --profile <profile> add github:Menghuan1918/dsh-apollo
```

GitHub main 仍是源码安装选项。它同样按 `package.json` 解析精确依赖 `dsh-better-goal@0.1.0`，因此不能早于 Goal 的 npm 发布推进 main：Goal 尚未在 registry 可取得时，源码安装会因依赖 404 失败。安装后重启 profile。

### 本地 link 安装

```sh
cd /absolute/path/to/dsh-apollo
npm install
dsh plugin --profile <profile> add link:/absolute/path/to/dsh-apollo
```

注意：

- `dsh plugin add link:` 只链接 Apollo 本身，不会代装它的依赖；所以必须先 `npm install`；
- 开发时可将 `dsh-better-goal` 临时改为 `file:../dsh-better-goal`，但不要提交该改动；发布版必须保持精确 npm 版本 `0.1.0`，不要写成 Git SHA、分支或范围；
- 不需要启动额外服务或构建 Web 资源；宿主提供 React。

### 核对

```sh
dsh --profile <profile> --dump-config
```

应看到 `apollo-skills`、`dsh-better-goal` 两行和两个工程预设。若缺少 `dsh-better-goal` 行，先确认是否安装了依赖；若同时显式选中了独立 bundle，参考上面的去重限制。

### 升级

- 升级包后重启 profile；
- 升级 DSH 后先跑 `npm test`，漂移测试会按目标 DSH 安装比较预设；
- 版本范围声明：Node `^22.19.0 || >=24.0.0`，DSH `>=0.2.1-rc.2 <0.3.0`；
- DSH 的兼容检查会纳入预发布版，因此声明范围可能接受尚未逐版验证的后续 RC；版本范围不是逐版验证保证。

### 卸载

```sh
dsh plugin --profile <profile> remove @menghuan1918/dsh-apollo
```

旧 unscoped 安装使用 `remove dsh-apollo`。卸载 Apollo 后，Apollo 插入的 `dsh-better-goal` 行也会消失。如果之前单独安装过独立 bundle，需要按独立插件的说明处理；不要留下两个 goal 状态服务或续跑驱动同时工作。

### npm 首发顺序

首发只做人工发布，不把登录、2FA 或 publish 放进脚本：

1. 在 Goal 仓库人工发布 `dsh-better-goal@0.1.0` tarball；发布目标必须是 `https://registry.npmjs.org/`，`access` 为 `public`。
2. 在官方 registry 验证 `0.1.0` 已可取得（查询版本并下载 tarball），排除镜像或本地缓存造成的假象。
3. 再人工发布 `@menghuan1918/dsh-apollo@0.4.0` tarball，同样指向 `https://registry.npmjs.org/` 且 `access` 为 `public`。
4. 登录、2FA 和 publish 都由维护者在真实终端完成；OTP、token 和恢复码不得写入脚本、环境文件或仓库。
5. 在 Goal 发布并验证通过前，不要把 Apollo 的 `package.json` 精确依赖 `0.1.0` 合并或推送到 main，否则 GitHub 源码安装会解析到尚不存在的 Goal 版本并 404。

## 测试与冒烟

### 单元与装配测试

```sh
npm install
npm test

# 严格指定一个真实 DSH 安装作为漂移基准
DSH_PACKAGE_ROOT=/path/to/node_modules/@deepseek-ai/dsh npm test
```

测试栈使用 Node 内置 `node:test`。额外依赖只有 `js-yaml`、React 和 React TestRenderer；不需要构建或启动 Web 服务。

测试文件完整清单：

| 文件 | 覆盖重点 |
|---|---|
| [tests/apply.test.mjs](../tests/apply.test.mjs) | 插件导出契约；技能 provider 注册；不向 `<dshHome>` 写 `.agent-presets` |
| [tests/assembly.test.mjs](../tests/assembly.test.mjs) | 顶层 patch 的原生 goal 禁用行、稳定 goal 行、Apollo 行；依赖声明；与已安装独立 bundle 的 patch 比对 |
| [tests/bundled-skills.test.mjs](../tests/bundled-skills.test.mjs) | 技能目录集合、frontmatter、相对资源、NOTICE 与引用完整性 |
| [tests/cli-adapter.test.mjs](../tests/cli-adapter.test.mjs) | 适配器元数据、白名单、身份固定、env 快照、并发、错误与不自动重试、投递游标 |
| [tests/cli-sessions.test.mjs](../tests/cli-sessions.test.mjs) | profile 范围 KV 命名空间、记录校验、原子写、重开、关闭与失败路径 |
| [tests/cli.test.mjs](../tests/cli.test.mjs) | JSONL 读取、错误脱敏、Codex / Claude 命令构造、事件解析与失败语义 |
| [tests/client.test.mjs](../tests/client.test.mjs) | 浏览器半边装载、表单渲染、只读态、编辑与冲突、模型 effort 校验、能力探针降级、自动发现合并与失败 |
| [tests/config.test.mjs](../tests/config.test.mjs) | 常量、schema 默认值与权限枚举、volatile 投影、normalize 规则、活配置读取 |
| [tests/dsh-home.test.mjs](../tests/dsh-home.test.mjs) | `DSH_HOME` 的默认、绝对、`~`、相对与空白处理 |
| [tests/exit-guard.test.mjs](../tests/exit-guard.test.mjs) | 运行中子代理 / 后台任务、终态过滤、fail-open、无豁免、用户中断 |
| [tests/panel.test.mjs](../tests/panel.test.mjs) | `declareOwnsHost` tap、可执行文件与版本探测、profile 读取、能力接口、模型解析与来源、发现接口、信任边界、只读方法 |
| [tests/settings.test.mjs](../tests/settings.test.mjs) | 旧配置读取与导入优先级、Loader 等待、行配置页策略、反代 tap、headless 降级 |
| [tests/subagents.test.mjs](../tests/subagents.test.mjs) | CLI 路由开关与范围、guard、只后台、fork 拒绝、白名单、稳定 id、cwd 解析 |
| [tests/tap.test.mjs](../tests/tap.test.mjs) | index HTML 的 `<head>` 注入位置与匹配 |
| [tests/upstream-drift.test.mjs](../tests/upstream-drift.test.mjs) | 预设结构、与上游 standard 的差异白名单、原生 goal 行存在性、导出解析、engines 覆盖 |
| [tests/wait-subagent.test.mjs](../tests/wait-subagent.test.mjs) | 注册契约、直接子代理、批量等待、启动宽限、超时、去重、inbox 不被改写 |

`tests/upstream-drift.test.mjs` 的行为：

- 优先使用 `DSH_PACKAGE_ROOT` 指向的 `@deepseek-ai/dsh` 安装；
- 未设置时从 Node 安装路径和模块解析路径寻找兼容安装；
- 找不到兼容安装时跳过外部基准检查；
- 显式设置后，无效路径、不兼容版本或缺失导出都会直接失败，而不是静默跳过。

### 真实宿主与 CLI 冒烟

[scripts/runtime-smoke.mjs](../scripts/runtime-smoke.mjs) 使用临时 home 和 profile，不启动 Web 服务，也不替换当前 GUI。先清除可能复用或跳过阶段的变量：

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
| `APOLLO_SMOKE_HOST_ONLY=1` | 仅验宿主、双预设、配置与原生委派；仍需模型占位值，但不调用 CLI |
| `APOLLO_SMOKE_LIFECYCLE=1` | 追加中断续接、可写与只读权限切换 |
| `APOLLO_SMOKE_HOME` | 复用已通过首次两轮检查的临时 home，跳过首次两轮检查；仍需设置对应模型变量 |
| `APOLLO_SMOKE_PHASE=read-only` | 生命周期检查只追加只读阶段 |

默认检查：

- 两轮记忆；
- 创建时的当前目录解析；
- 父会话结果通知；
- 宿主重载后续接。

完整生命周期额外检查：

- 进行中回合中断后续接；
- 可写模式切回只读模式。

验收通过必须同时满足：

1. 输出包含 `APOLLO_RUNTIME_SMOKE_PASSED`；
2. 进程退出码为 0；
3. 临时 home 中 `results.json` 的对应阶段全部为 `passed: true`。

完整验收应从 fresh home 开始；复用失败 home 或跳过阶段的结果不能代替完整验收。**真实 CLI 验证需要登录和可用额度，会产生实际调用费用。** 单元测试或宿主检查通过，不代表对应 CLI 的真机流程通过。

已验证基准：DSH `0.2.1-rc.2` 上，Claude Code `2.1.305` 的 fresh 完整生命周期实测通过，覆盖两轮记忆、目录、通知、重载、中断续接及权限切换，且重载、中断、权限切换后原生会话 ID 保持不变。注意：

- 中断检查证明回合取消与续接，不代表验证了长命令进程树终止；
- 权限切换检查不代表额外验证了权限提问流程；
- 新会话的宿主重载恢复不等同于旧版本会话迁移。

## 历史兼容与迁移

### 旧版交付机制

早期版本用 `<dshHome>/.agent-presets` 同步预设副本。DSH `0.2.1` 起预设由 bundle patch 的 `config.plugins` 直接承载，旧副本机制已删除。升级后如果本机还残留旧目录，可按需手动清理；它们不再被读取。

### 旧配置文件

`<dshHome>/eng.json` 和旧名 `atlas.json` 只用于一次性导入 `exitGuard`。当前实现：

- 不写回旧文件；
- 不删除旧文件；
- 当前 profile 的显式值优先；
- 导入失败只告警。

### 原生 goal 与旧工具

独立 goal 插件会禁用原生 goal 服务、round driver、`/goal` 命令、模型工具和 GoalBar UI，并隐藏旧的 `get_goal` / `create_goal` / `update_goal` 三工具，替换为单个 `goal` 工具。`todo_write` 仍然只管理步骤，不管理目标。Apollo 不保留 goal 域代码。

### 版本范围

`engines.dsh` 是 `>=0.2.1-rc.2 <0.3.0`。写法包含预发布版，因此后续 RC 可能落在范围内；这不等于逐版验证。升级 DSH 后应运行漂移测试：

- 上游新增而 eng 没跟上的行会失败，并列出需要补的行；
- 被有意剔除的原生行会先断言仍存在于上游，再被过滤；
- 本地新增行、本地调参和禁用状态必须精确匹配白名单。

## 实现入口

| 文件 | 职责 |
|---|---|
| [package.json](../package.json) | 包元数据、bundle patch 顺序、浏览器注入、运行时依赖 |
| [cordis.patch.yml](../cordis.patch.yml) | 原生 goal 行禁用、goal 与 `apollo-skills` 顶层行 |
| [presets/eng.patch.yml](../presets/eng.patch.yml) / [presets/eng-ptc.patch.yml](../presets/eng-ptc.patch.yml) | 两套预设的行清单唯一事实源 |
| [presets/eng/plugins/wait-subagent/index.js](../presets/eng/plugins/wait-subagent/index.js) | `wait_subagent` 工具 |
| [presets/eng/plugins/exit-guard/index.js](../presets/eng/plugins/exit-guard/index.js) | 退出守卫 |
| [presets/eng/plugins/mode-instructions/index.js](../presets/eng/plugins/mode-instructions/index.js) | 工程模式提示词段（纪律、委派、分档、退出守卫、PTC 变体） |
| [src/index.js](../src/index.js) | 宿主行入口；注册技能 provider、设置与 CLI 桥 |
| [src/config.js](../src/config.js) | 正式配置 schema、默认值、规整与活配置读取 |
| [src/settings.js](../src/settings.js) | 设置页策略、能力路由装配、旧配置导入 |
| [src/client.js](../src/client.js) | Plugins 浏览器表单，无构建闭包工厂 |
| [src/panel.js](../src/panel.js) | 能力探针、模型自动发现、分档路由、可执行文件 / 版本 / profile 探测、信任检查、反代 tap |
| [src/subagents.js](../src/subagents.js) | 在现有子代理工具上安装 CLI 路由与 guard |
| [src/cli-adapter.js](../src/cli-adapter.js) | CLI 会话适配、权限与身份校验、事件流接线 |
| [src/cli-sessions.js](../src/cli-sessions.js) | profile 范围 KV 记录、原子写与恢复 |
| [src/cli/codex.js](../src/cli/codex.js) / [src/cli/claude.js](../src/cli/claude.js) | 命令构造与事件解析 |
| [src/cli/jsonl.js](../src/cli/jsonl.js) | JSONL 读取、参数校验、错误脱敏 |
| [scripts/runtime-smoke.mjs](../scripts/runtime-smoke.mjs) | 真实宿主 / CLI 冒烟脚本 |
| [scripts/render-prompts.mjs](../scripts/render-prompts.mjs) / [prompts/](../prompts/) | 组装后的系统提示词快照及其生成脚本 |

## 许可与致谢

本包采用 **GPL-3.0-or-later**，全文见 [LICENSE](../LICENSE)。

| 内容 | 来源 | 许可 |
|---|---|---|
| `presets/eng.patch.yml` / `presets/eng-ptc.patch.yml` 的 `config.plugins` 块（改编自 DSH 标准 / PTC 预设） | DeepSeek Harness | MIT，见 [presets/eng/NOTICE](../presets/eng/NOTICE) 与 [third-party/LICENSE-MIT-dsh-standard-preset](../third-party/LICENSE-MIT-dsh-standard-preset) |
| `skills/tdd/`、`skills/diagnosing-bugs/` | [mattpocock/skills](https://github.com/mattpocock/skills) | MIT，Copyright © 2026 Matt Pocock，见 [third-party/NOTICE-mattpocock-skills](../third-party/NOTICE-mattpocock-skills) |
| 能力探针的请求信任边界 | dsh-better-sidebar，源自 DSH client connection | BSD-3-Clause |
