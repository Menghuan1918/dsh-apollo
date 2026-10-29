# dsh-apollo 开发与实现说明

面向维护者、集成者和需要排查装配问题的用户。用户安装与配置请看 [README](../README.md)；本文保留 DSH 插件的实现细节、旧配置迁移、组合安装边界与验证方法。

当前实现版本：`0.6.5`；npm 包名是 `@menghuan1918/dsh-apollo`。纯 ESM，无构建步骤；宿主浏览器半边是直接加载的闭包工厂。

## 目录

1. [交付面与行模型](#交付面与行模型)
2. [Apollo 行：保留与弃用](#apollo-行保留与弃用)
3. [工程预设内部](#工程预设内部)
4. [旧配置迁移](#旧配置迁移)
5. [提示词归属与快照](#提示词归属与快照)
6. [独立安装、组合与只读限制](#独立安装组合与只读限制)
7. [安装、升级与卸载](#安装升级与卸载)
8. [测试与冒烟](#测试与冒烟)
9. [历史兼容](#历史兼容)
10. [实现入口、打包与发布](#实现入口打包与发布)

## 交付面与行模型

### 包清单

[package.json](../package.json) 声明了三份 bundle patch，按以下顺序加载：

1. [cordis.patch.yml](../cordis.patch.yml)：顶层宿主行；
2. [presets/eng.patch.yml](../presets/eng.patch.yml)：`eng` 预设；
3. [presets/eng-ptc.patch.yml](../presets/eng-ptc.patch.yml)：`eng-ptc` 预设。

浏览器半边由 `dsh.client` 的注入列表发现；`exports["./client"]` 指向 [src/client.js](../src/client.js)。`exports["./presets/*"]` 让预设里的本地插件通过裸子路径引用本包内的模块。

精确运行时依赖（**不提交 file/link/Git/范围说明符**）：

| 依赖 | 版本 | 所有权 |
|---|---|---|
| `dsh-better-goal` | `0.2.1` | 目标域（`questionTimeoutSeconds` 已弃用、仅保留读取） |
| `@menghuan1918/dsh-better-subagent` | `0.2.0` | 子代理 CLI/等待/child guard/分档/设置页；注册 `wait_subagent` PTC 豁免 |
| `dsh-better-compact` | `0.1.2` | 压缩 companion + engine + 设置页/诊断 |
| `dsh-better-ask-user` | `0.1.7` | 官方 `ask_user_question` 入参/返回 + 插件超时等待 + 历史预览行；注册 PTC 豁免；旧 goal 等待迁移 |
| `dsh-better-ptc` | `0.1.0` | 单例 PTC deadline 豁免服务 |
| `@deepseek-ai/schemastery` | `~3.18.4` | Apollo 行 Config |
| `react` | peer | 宿主提供 |

正式安装从 npm registry 获取上述精确版本，不需要本地 tarball 或 link：

```sh
npm install
```

发布顺序必须是先两个子包、后 Apollo（见[发布](#实现入口打包与发布)）。

### 顶层 patch 与稳定行

[cordis.patch.yml](../cordis.patch.yml) 携带：

禁用行（只按 id 生效，不能带 name/config）：

- `goal`、`goal-round-driver`、`command-goal`、`tool-goal`、`ui-goal` —— 原生 goal 域；
- `compaction-basic` —— 原生 host-plane 压缩默认实现。

插入行（id/name 与独立 bundle 逐字相同）：

- `dsh-better-goal` / `dsh-better-goal`；
- `dsh-better-compact` / `dsh-better-compact`；
- `dsh-better-compact-engine` / `dsh-better-compact/engine`；
- `dsh-better-subagent` / `@menghuan1918/dsh-better-subagent`；
- `apollo-skills` / `@menghuan1918/dsh-apollo`。

为什么 Apollo 要自己携带独立插件的行：DSH 只把**直接安装**的 bundle 加入 `dsh.profile.bundles`，不会自动应用传递依赖的 bundle patch。行 id 是 Loader 的去重键：两个 bundle 同时插入同名行时仍只激活一个实例；浏览器模块按包 manifest 的 name 解析，不能把 node/client 半边拆成两行。预设行不经过 node 插件加载，所以可以各自作为独立的 bundle patch。

[tests/assembly.test.mjs](../tests/assembly.test.mjs) 解析三份 patch 与已安装独立包的 patch，断言：

- Apollo 与独立 bundle 的原生禁用行、goal/subagent/compact/engine 插入行的 id/name 完全一致；
- 预设内的 engine 行 id/name 与独立 `better-compact` 预设中的 engine 行一致；
- 每个稳定 id 在顶层只出现一次；
- 预设不携带第二个 subagent registry、wait 工具或 compact companion 行；
- 依赖是精确版本，manifest 的包名/版本/repository/files 正确。

### 预设 ID 与历史会话

`presets/eng.patch.yml` 和 `presets/eng-ptc.patch.yml` 是预设行清单的唯一事实源。`config.id` 必须保持 `eng` / `eng-ptc`，因为历史会话按预设 ID 恢复；`config.order` 分别是 10 和 11。`eng-noask` 已在 0.4.0 删除。`presets/eng/` 只承载两套预设共用的本地插件模块（exit-guard、mode-instructions），不承载第二份行清单。

## Apollo 行：保留与弃用

`apollo-skills` 是 Apollo 的主宿主插件行，0.5.0 后只承担：

1. 向技能注册表的全局层注册包内 `skills/*/SKILL.md`（rank 600，用户技能根可覆盖）；
2. 挂载正式行 Config（[src/config.js](../src/config.js)）与最小浏览器行页；
3. 一次性只读导入旧 `<dshHome>/eng.json`（或 `atlas.json`）里的 `exitGuard`，并驱动一次性旧配置迁移（[src/migrate.js](../src/migrate.js)）；
4. 行配置 `declareOwnsHost: true` 时给 index HTML 注入 `__DSH_TRANSPORT__.ownsHost`（[src/owns-host.js](../src/owns-host.js)）。

**不再负责**：CLI 协议/适配/身份 KV、`wait_subagent`、能力/模型/路由 HTTP 探针、子代理设置页、模型分档与委派提示词生成、运行中子代理退出判断。Apollo 不注册任何 HTTP 路由；`/apollo/api/*` 由 better-subagent 作为只读兼容别名拥有，重复注册同一 `(kind, path)` 会被 webServer 拒绝。

PTC deadline 豁免由独立的 `dsh-better-ptc` 单例行提供（无浏览器半边、无设置页）：它包裹挂载的 PTC runtime 的 prototype `run`，在已注册工具（`wait_subagent` / `ask_user_question`）在途时暂停 `run_code` 的 elapsed budget，返回后继续剩余预算；普通嵌套工具仍消耗预算。ask-user 与 subagent 都只插入同一个稳定行并调用 `ctx.betterPtc.register(...)`，Loader 去重保证只有一份服务和一层包装。没有 `ptcRuntime` 或 runtime 不提供 numeric timeout 时注册为 no-op。

### 配置分类

```js
{
  exitGuard: false,                       // 活跃：只拦运行中后台 job
  tiers: { fast: {...}, quality: {...} }, // deprecated，仅旧 profile 装载/迁移
  subagents: { eng: true, global: false, codex: {...}, claude: {...} }, // deprecated
  trustedHosts: [],                       // deprecated（新插件拥有自己的）
  declareOwnsHost: false,                 // 活跃部署标志
}
```

- `exitGuard`、`tiers.*`、`subagents.*` 仍是 volatile：旧 profile 能保存/装载，不需要重挂。
- `trustedHosts`、`declareOwnsHost` 是非 volatile 部署字段。
- deprecated 字段在运行时**没有消费方**：job 守卫只读 `exitGuard`，工程提示词只读 `exitGuard`，客户端只展示 `exitGuard`。它们存在只为旧 profile 的 schema 兼容与迁移读取。保留旧默认值：
  - `subagents.eng = true`、`subagents.global = false`；
  - 两个 CLI `enabled = false`，Codex `permissionMode = read-only`、Claude `plan`；
  - 模型列表 `[]`、`defaultModel = ""`；
  - `trustedHosts = []`。
- 模型条目的旧形状 `{ id, efforts[], defaultEffort }` 仍被 `normalizeConfig` 规整，迁移时保留顺序与元数据。

`normalizeConfig(value)` 对任意来源（volatile 引用、旧 JSON、残缺对象）回退默认且不抛错；`currentConfig(ctx)` 经 configEditor 读取活 fiber 配置，找不到时用调用方 fallback（job 守卫、mode-instructions 使用）。`tests/config.test.mjs` 复刻宿主的 `volatileForm` / `projectForm` / `isVolatilePath` 纯函数锁定投影契约：deprecated 字段仍可编辑但不再被运行时消费，`trustedHosts` / `declareOwnsHost` 在表单之外。

### 最小行页

[src/client.js](../src/client.js) 只注册 `<包名>#apollo-skills` 与旧名 `<旧包名>#apollo-skills` 两个 `plugins.row.config` 键，closure id 必须是 npm 包名。页面：

- `summary` 只回一行；
- `page` 渲染 `exitGuard` 开关、保存/放弃、只读/不可用状态与迁移说明；
- 保存只提交 `{op:'set', path:['exitGuard'], value}`，带宿主 revision；
- 不 fetch 任何 `/apollo/api/*`，不注册新插件的页面键。

`exitGuard` 是 volatile：保存后不重挂本行；job 守卫下一次 `agent/turn-stopping` 即读取新值。

### 旧 eng.json 导入

[src/settings.js](../src/settings.js) 保留一次性只读导入：

- 文件：`<dshHome>/eng.json` 优先，损坏/缺失回退 `atlas.json`；
- 只导入 `exitGuard`（布尔）；
- 当前 profile 显式值优先（存在即优先，含显式 false）；
- 生效值与旧值相同就不写盘；旧文件永不改写/删除；
- 写入经 `settings.update('apollo-skills', patch, revision)`，volatile 不重挂。

`mountSettings` 返回 `{legacyImport}` Promise，迁移模块用它排序：先完成旧文件导入，再读取旧行值。行页面策略用 `settings.configure({ auto: false }, ctx.fiber)` 登记，避免宿主按 schema 再生成一页；策略失败只告警。headless 组合没有 settings/webServer 时其余装配照常。

### 反代部署标志

`declareOwnsHost` 为 true 时在 index HTML 的 `<head>` 起始注入：

```html
<script>globalThis.__DSH_TRANSPORT__={ownsHost:true}</script>
```

让官方 client 把反代页面当作 loopback，恢复 host 持久化的设置镜像。**它依赖反向代理本身的信任边界，不是身份认证**；代理仍需自行配置访问控制。`trustedHosts` 在 Apollo 行已弃用，不再影响任何 HTTP 路由（新插件各自拥有自己的 `trustedHosts`）。

## 工程预设内部

### eng / eng-ptc

[presets/eng.patch.yml](../presets/eng.patch.yml) 是 DSH 内置 `standard` 预设的整块 fork，差异：

- compaction 组内 `compaction-basic` → `dsh-better-compact-engine`（`dsh-better-compact/engine`），保留 `command-compact` 与 `tool-result-pruner`；engine 位于预设自己的 `isolate: { compaction, toolResultPruner }` 域，host-plane engine 检测到 preset-owned engine 后不重复压缩；
- 不挂 `tool-wait-subagent`（由 better-subagent 宿主行提供唯一工具）；
- 不挂 `tool-schedule`；
- 不挂原生 `command-goal` / `tool-goal`（goal 由独立插件提供）；
- `tool-jobs.maxConsecutiveWakes = 5000`；
- `tool-result-pruner` 阈值是上游 2 倍（16384/8192/2048）；
- 保留 `eng-exit-guard`、`eng-mode-instructions` 两个本地插件；
- 原生 delegation 工具行、tool-subagent 行保持一份，作为宿主 registry 的消费者；
- `tool-ask-user` 不再固定 `timeout`：基础行保留为 fallback/shadow 探针，新 ask-user 宿主行在每个 Agent 上注册 `ask_user_question` 影子，等待时长与超时行为来自 ask-user 行设置。

`eng-ptc` 是 eng 的拷贝，差异恰为上游 `ptc` 相对 `standard` 的差异：`tool-presentation { mode: ptc }`、`workflow-ptc` / `tool-workflow` disabled。0.5.0 起不再有 `eng-mode-instructions` 的 `ptc` 开关；better-subagent 自己识别 `eng-ptc` 追加 fan-out 规则。

[tests/upstream-drift.test.mjs](../tests/upstream-drift.test.mjs) 把 engine 行归一化回原生 `compaction-basic` 后，与上游预设逐字节比较；`eng-ptc` 与 `eng` 的差异必须恰好是上述 PTC 增量。设置 `DSH_PACKAGE_ROOT` 时严格运行，否则跳过（跳过不等于通过）。

### 退出守卫（job-only）

[presets/eng/plugins/exit-guard/index.js](../presets/eng/plugins/exit-guard/index.js)：

- 监听 `agent/turn-stopping`；`exitGuard` 开启且本会话仍有非终态后台 job 时 `agent.steer()` 注入提醒；
- **不检查子代理**：运行中直接子代理由 better-subagent 的 `childExitGuard` 拥有；
- jobs 经 `ctx.get('jobs').list(agent.id)` 读取（0.1.7 起参数是 SessionId；传 Agent 对象不会报错但恒不匹配）；
- 查询/注入失败 fail-open（告警放行）；用户中断（`payload.signal.aborted`）不触发；
- steer 消息 source 使用生产者自有 kind `better-apollo-job-exit-guard`（session format v4 拒绝旧的 `{kind:'plugin', plugin}` 形状；cold restore 也接受该非空自定义 kind）；
- 无豁免清单；外部常驻进程用 pm2/systemd/nohup 管理，不进 job 注册表。

### 工程模式提示词

[presets/eng/plugins/mode-instructions/index.js](../presets/eng/plugins/mode-instructions/index.js)（`eng:mode-instructions`，order 1）只保留：

- 通用工程纪律：KISS/YAGNI、检查先行、修复根因、一个连贯变更、既有约定、防过度设计与过度防御、验证与汇报、权限/Git 身份/依赖边界、命令与进程纪律；
- `exitGuard` 开启时的 job-only 退出守卫说明。

不含委派纪律、模型分档、PTC fan-out、CLI 目录或 child guard；这些是 better-subagent 的 per-Agent section，Apollo 不再生成第二份。文本是函数，每次组装读取活配置；改设置会让下一次请求的前缀缓存失效一次。

## 旧配置迁移

[src/migrate.js](../src/migrate.js) 在 Apollo apply 后运行，`mountMigration` 使用 `ctx.inject(['settings'])`；顺序为：

1. 有 Loader 时等待装配完成（`loader.await()`，有界）；
2. 等待 `legacyImport`（旧 eng.json）完成；
3. 有界轮询 `settings.describe()`，直到 `dsh-better-subagent` 与 `dsh-better-compact` 两个命名空间都出现（默认 5s，50ms 间隔）；
4. 子代理迁移 → 恢复 Apollo job 开关 → 压缩迁移，各自写入后重读验证；
5. 返回状态并记录日志（complete / pending / blocked / error）。

若目标命名空间一直不可读/不可写（例如双显式 bundle 导致写入被拒），日志明确要求重载 profile，迁移保持幂等，下次启动会再试；不宣告成功。迁移不删除旧值，也不创建迁移 sidecar。

来源缺失（旧预设行已被删除、或默认预设行不可读）时报告 `source-missing` 与需要处理的 row id；显式导入路径是把旧原生键手工写进 `dsh-better-compact` 行，或从升级前的 `cordis.patch.yml` 备份恢复该预设行。两个预设显式配置不同且无法确定活跃预设时报告 `ambiguous`，不猜。

### 子代理迁移

来源：`apollo-skills` 的**有效配置**。volatile 字段来自 `describe().value`；非 volatile 的 `trustedHosts` 来自旧行 raw config（`describe().value` 只投影 volatile 表单，不能用来判断 trustedHosts）。

**0.5.1 修复**：DSH 把 profile 覆盖行的 `name` 当 guard。旧 profile 若保留历史 `name: dsh-apollo`，Loader 会跳过该覆盖，`describe().value` 只剩默认值（例如用户显式 `subagents.eng: false` 会被看成默认 `true`）。迁移现在额外读取 `configEditor.configuration()` 中该行的 `override`，递归合并到有效配置之上：普通对象逐键合并，数组与所有标量（含 `false`/`0`/`""`/`[]`）整体覆盖。这样被跳过的显式值仍会迁移。`preset-eng` / `preset-eng-ptc` 的预设覆盖也按同样方式合并（`plugins` 数组整体替换），再读取原生 `compaction-basic`。

历史 name guard 同样会让仍活跃的 Apollo job `exitGuard` 静默回退到默认 false。现在迁移还会只把这个开关经 `settings.update` 恢复到 Apollo，并重读验证；不会激活其他已弃用字段。宿主 `describe().user` 会投影被跳过的旧覆盖，因此优先检查活动 Apollo entry 的 raw config：它已声明 `exitGuard` 时（尤其当前 scoped 行显式 false），不覆盖。child 目标仍按自己的 `user.childExitGuard` 存在性判断，不让两个开关互相覆盖。旧 unscoped 行保留，重复执行不重写。仅在子代理迁移完成/无需写入后恢复 job 开关，避免新 scoped 行遮蔽尚未导入的旧来源；写入拒绝为 pending，重读不一致为 error，均纳入顶层状态。

目标：`dsh-better-subagent` 的 `settings.describe()`：

- `target.user` 的存在性表示显式值（含 false/0/""/[]）；
- `target.base` 是目标继承层默认值；
- 只有目标缺失且来源值与目标默认值不同才写入，避免把默认值固化成覆盖层。

映射与规则：

| 来源（Apollo） | 目标 | 规则 |
|---|---|---|
| `tiers.fast` / `tiers.quality` | 同名 | 目标该档已有任一显式字段 → 整档不混写；否则来源档与目标默认不同才写 |
| `subagents.eng` / `global` | 同名 | 目标缺字段且值不同才写；显式 false 是值 |
| `subagents.codex/claude.*` | 同名 | 逐叶补齐：enabled、executable、profile（仅 codex）、permissionMode、defaultModel、models（含顺序/effort 元数据） |
| `exitGuard` | Apollo `exitGuard` + `childExitGuard` | 两份相同初值，随后独立配置；当前目标显式值（含 false）各自优先 |
| `trustedHosts` | `trustedHosts` | 非 volatile；目标 raw config 未声明且来源非空时用 `configEditor.edit` 写 |

写入：volatile 用 `settings.update(ns, patch, revision)`；非 volatile 用 target entry 的 `configEditor.edit`。`settings.update` 会触发 reconcile，可能替换目标 entry 对象，因此写 `trustedHosts` 前重新从 `entries()` 取目标 entry。写后重新 `describe()`/读 raw config 校验，任何字段不一致按 `error` 报告。

### 压缩迁移

来源：活跃 Apollo 预设（`preset-eng` / `preset-eng-ptc`）里的原生 `compaction-basic` **显式**配置。预设内部行不出现在 `configEditor.entries()`；Apollo 从预设声明行的 `options.config.plugins` 读取。

- 预设行从 `configEditor.entries()` 里按 `name === '@deepseek-ai/dsh-agent-preset'` 找到；
- `config.plugins` 内递归查找 `cordis:group` 里的 `compaction-basic` 行；没有 `config` 或空对象表示没有来源；
- 默认预设身份取 `agentPresets.defaultId`：
  - 它是 `eng` / `eng-ptc` → 该预设权威；
  - 否则只有一个预设带显式配置 → 用它；两个显式配置相同 → 用共同值；
  - 两个显式配置不同且无法确定活跃预设 → `ambiguous`，不写、不猜，报告需要处理的预设行。
- 携带字段：`auto`、`thresholdRatio`、`headroomTokens`、`retainRatio` / `retainTokens`（互斥，同时出现则拒绝）、`summarizationProvider` / `summarizationModel`（半对则拒绝）、`maxTokens`、`compactionRetries`、`maxOverflowRetries`、`modelPolicies`；
- 目标 `user` 已有显式值优先；等于目标默认值不写；
- 迁移发生实际写入且目标未显式设置 `mode`、目标默认不是 `goal` 时补 `mode: 'goal'`；
- 写入 `settings.update('dsh-better-compact', patch, revision)`，重读按 effective value 校验。

原生默认值不会变成目标显式值：只有来源行里显式存在的键才会被携带。压缩配置是 volatile 保存、引擎载入时冻结快照；迁移后的设置需要重载 profile 才会被运行中引擎采用（inspect 的 `requiresReload` 可观察）。

Apollo 在迁移挂载时先登记启动门禁：验证完成前，`agent/pre-step` 阻止任务步骤，`llm/stream` 同时阻止不经过 pre-step 的手动摘要调用。迁移 pending/blocked/error 不得按默认配置继续执行；应检查日志后修复来源或目标并重载。若本次迁移改变 compact 的载入快照，持久化验证完成后仍要求重载，重载后确认无差异才放行。普通后续设置保存不关闭已通过的启动门禁，仍按原有“当前快照继续、重载后应用新值”语义处理。

宿主行明确 `disabled: true` 时，跳过该增强的迁移，不将其缺少 settings namespace 误判为全宿主故障；活动行缺失 namespace 仍报 pending。子代理增强被禁用时保留尚未迁出的旧来源，并暂缓会遮蔽该来源的旧 job 开关恢复，待重新启用后再迁移；已生效的 Apollo job 配置不变。停用 compact 增强时仍需按卸载说明启用原生 `compaction-basic`，以恢复 `/compact`；启动门禁不替用户改写禁用选择。

### 迁移测试

- [tests/migrate.test.mjs](../tests/migrate.test.mjs)：纯函数与 fake host 编排。覆盖显式 false/空值、目标优先（分档整档、models 空列表、保留方式二选一）、缺失来源、ambiguity、trustedHosts、写入拒绝、幂等、重读验证、有界等待。
- [tests/migration.runtime.test.mjs](../tests/migration.runtime.test.mjs)：真实 headless temp profile（需 `DSH_PACKAGE_ROOT`）。seed 0.4.x 风格 `apollo-skills` 配置与旧 `preset-eng-ptc` 原生压缩配置，启动 Apollo 后等待迁移，断言两个目标行的 effective 值、trustedHosts raw config、旧来源保留、无 CLI KV、第二次 `runMigration` 为 no-change 且 profile patch 不变。

## 提示词归属与快照

| 来源 | section | 内容 |
|---|---|---|
| Apollo | `eng:mode-instructions` | 通用工程纪律 + job-only Exit guard |
| better-subagent | `better-subagent:delegation` | 委派纪律 + fast/quality 分档；`eng-ptc` 追加 PTC fan-out |
| better-subagent | `better-subagent:child-guard` | 仅 `childExitGuard` 开启 |
| better-subagent | `better-subagent:cli-subagents` | 仅 CLI 后端在范围内且启用时 |

[scripts/render-prompts.mjs](../scripts/render-prompts.mjs)：

- 用临时 `DSH_HOME` 建 headless profile；
- 按各包 `files` 清单复制 Apollo、goal、better-subagent、better-compact 的发布布局到 profile `node_modules`（可用 `APOLLO_GOAL_SOURCE` / `APOLLO_SUBAGENT_SOURCE` / `APOLLO_COMPACT_SOURCE` 指向源码目录）；
- 配置 Apollo 行 `exitGuard:false` 与 better-subagent 行的占位分档；
- 真实装配 `eng` / `eng-ptc`，写出 [prompts/eng.md](../prompts/eng.md) / [prompts/eng-ptc.md](../prompts/eng-ptc.md)。

[tests/prompts.test.mjs](../tests/prompts.test.mjs)：

- 从快照 JSON 设置块重渲染 Apollo 段并断言包含在快照中；
- 断言 `better-subagent:delegation` 真实出现在 sections 列表，分档占位值来自设置块（不硬编码第二份新插件文案）；
- child guard 默认不出现；`eng-ptc` 的 fan-out 规则出现。

改了 Apollo 提示词、独立插件版本的提示词、或 DSH 预设后运行：

```sh
DSH_PACKAGE_ROOT="/…/node_modules/@deepseek-ai/dsh" npm run prompts
```

## 独立安装、组合与只读限制

### 独立 bundle 与 Apollo 的关系

- 行 id/name、浏览器页面键、CLI 身份路由都不因独立/集成而改变；
- Apollo 集成槽别名由独立包注册（`@menghuan1918/dsh-apollo#<row>`、`dsh-apollo#<row>`），全部指向同一行同一份配置；
- 独立安装不需要 Apollo 的 `eng` / `eng-ptc` 预设；better-subagent 在无这些预设时用 `subagents.global` 决定是否渲染/路由；
- 不复制 CLI 身份 KV：命名空间仍是 `apollo_cli_<sha256(profile.dir)[:16]>`，包名变化不重命名、不复制、不清空。

### 双显式 bundle 限制（DSH 0.2.1-rc.2）

同一 profile 同时显式选择 Apollo 与独立 better-subagent / better-compact 时：

- Loader 按行 id 只激活**一个**实例；工具、提示词 section、压缩引擎不重复；
- `configEditor.entries()` 仍能看到该行，`settings.describe()` 仍能读到值；
- 但 `settings.update` / `configEditor.edit` 的写入被宿主拒绝（实测信息：`Configuration for "<id>" is overridden by a home patch or command-line overlay`），即配置**只读**；
- Web 插件管理器里的“组合行 unaddressable”标记属于 UI；headless 冒烟只验证了实际写入限制，未点验该标签。

恢复：只保留一个显式入口（移除独立 bundle 或移除 Apollo），重启 profile。不要用两份入口做“保险”。

`node scripts/runtime-smoke.mjs both` 用真实 Loader/settings/configEditor 验证：每行一个实例、目标行可读、两个目标写入都被拒绝、单实例工具/提示词仍工作。

### 禁用与回退

- bundle 与有效 row 不是一回事：移除独立 bundle 不会移除 Apollo 插入的同名行；反之亦然。
- compact：Apollo 预设内声明了 engine 行，**只禁用独立 compact bundle 不会恢复预设内的原生压缩**；要恢复原生实现需移除 Apollo 或恢复使用 `compaction-basic` 的预设覆盖。
- subagent：移除 Apollo（或禁用其 `dsh-better-subagent` 行）后原生 subagent 工具仍可用；CLI-only 旧会话需要重装 better-subagent 才能续接。
- 卸载不删除原生压缩事件、goal 日志或 CLI KV；handoff 文件不是必需依赖，删除后仍从原生 checkpoint 恢复。
- 0.5.0 不保留双套并行执行：旧 Apollo 实现已删除，回退需换回 0.4.x 包并重启 profile；升级前备份 `cordis.patch.yml`。

## 安装、升级与卸载

### npm 安装

```sh
dsh plugin --profile <profile> add @menghuan1918/dsh-apollo@0.6.5
```

包发布后即可用此命令安装，并带入五个精确依赖、应用三份 bundle patch。安装后需要重启对应 profile 的 DSH 进程。0.6.5 与 ask-user 0.1.7 的本地修复及隔离安装验证通过；实际 npm 发布待确认。

### GitHub 源码安装

```sh
dsh plugin --profile <profile> add github:Menghuan1918/dsh-apollo
```

GitHub main 仍是源码安装选项。它同样按 `package.json` 解析精确依赖；五个子包在 registry 可取得前，源码安装会因依赖 404 失败。

### 本地 link 安装

```sh
cd /absolute/path/to/dsh-apollo
# 五个子包尚未发布时不要直接 npm install（会因精确依赖 404 失败）。
# 先把本地目录/tarball 装进 Apollo 的 node_modules；本工作区已经就绪。
npm install --no-save /absolute/path/to/dsh-better-ptc /absolute/path/to/dsh-better-ask-user \
  /absolute/path/to/dsh-better-subagent /absolute/path/to/dsh-better-goal \
  /absolute/path/to/dsh-better-compact
dsh plugin --profile <profile> add link:/absolute/path/to/dsh-apollo
```

注意：

- `dsh plugin add link:` 只链接 Apollo 本身，不会代装它的依赖；必须先 `npm install`（子包未发布时用本地目录/tarball `--no-save` 仅作验证）；
- 不要提交 `file:` / `link:` / Git 依赖；发布版必须保持精确 npm 版本；
- 不需要启动额外服务或构建 Web 资源；宿主提供 React。

### 核对

```sh
dsh --profile <profile> --dump-config
```

应看到 `apollo-skills`、`dsh-better-goal`、`dsh-better-compact`、`dsh-better-compact-engine`、`dsh-better-subagent`、`dsh-better-ptc`、`dsh-better-ask-user` 行和两个工程预设；`ui-user-questions` 应被禁用。若缺少独立插件的行，先确认依赖是否安装；若同时显式选中了独立 bundle，参考上面的只读限制。

### 升级

- 升级包后重启 profile；0.4.x → 0.5.x 的迁移见 [旧配置迁移](#旧配置迁移)；
- 迁移写入的 compact 设置需要再重载一次才会被运行中引擎采用；
- 升级 DSH 后先跑 `npm test`，漂移测试会按目标 DSH 安装比较预设；
- 版本范围声明：Node `^22.19.0 || >=24.0.0`，DSH `>=0.2.1-rc.2 <0.3.0`；声明范围接受预发布版，不等于逐版验证保证。

### 卸载

```sh
dsh plugin --profile <profile> remove @menghuan1918/dsh-apollo
```

旧 unscoped 安装使用 `remove dsh-apollo`。卸载 Apollo 后，Apollo 插入的 goal / subagent / compact 行也会消失；如果之前单独安装过独立 bundle，需要按各自说明处理。卸载不删除 CLI KV、goal 日志或原生压缩历史。

### npm 发布顺序

两个子仓和 Apollo 都用 GitHub Release 触发 `.github/workflows/release.yml`，通过 npm trusted publishing（OIDC）发布，仓库里不存 npm token。tag 必须是 `v<package.json 的 version>`，CI 会先校验再跑测试和 `npm publish --provenance`。

1. 先发布 `dsh-better-ptc@0.1.0`、`dsh-better-ask-user@0.1.7`、`@menghuan1918/dsh-better-subagent@0.2.0`、`dsh-better-goal@0.2.1`、`dsh-better-compact@0.1.2`（各自仓库的 Release）；
2. 在官方 registry（`https://registry.npmjs.org/`）确认五个版本可取得、可安装；
3. 再把 Apollo 的精确依赖指向已发布版本，推 main 并发布 Apollo Release（本轮为 `v0.6.5`）；
4. 子包版本可取得前，不要把指向它们的精确依赖推到 Apollo main，否则 `npm install` / GitHub 源码安装会 404。

## 测试与冒烟

### 单元、组件与契约测试

```sh
npm install
npm test

# 严格指定真实 DSH 安装（漂移、真实迁移测试）
DSH_PACKAGE_ROOT=/path/to/node_modules/@deepseek-ai/dsh npm test
```

测试栈使用 Node 内置 `node:test`。额外依赖只有 `js-yaml`、React 和 React TestRenderer；不需要构建或启动 Web 服务。测试文件：

| 文件 | 覆盖重点 |
|---|---|
| [tests/apply.test.mjs](../tests/apply.test.mjs) | 插件导出契约；技能 provider；只注入 settings（不再注入 webServer） |
| [tests/assembly.test.mjs](../tests/assembly.test.mjs) | 顶层 patch 的禁用/插入行；精确依赖；与已安装独立 bundle 的跨包稳定行/engine 行比对；预设无第二份 registry/wait |
| [tests/bundled-skills.test.mjs](../tests/bundled-skills.test.mjs) | 技能目录集合、frontmatter、相对资源、NOTICE 与引用完整性 |
| [tests/client.test.mjs](../tests/client.test.mjs) | 最小行页：键注册、summary、exitGuard 保存/冲突/失败、只读/加载态、无网络/新插件页面键 |
| [tests/config.test.mjs](../tests/config.test.mjs) | 常量、默认值与权限枚举、volatile 投影、normalize 规则、活配置读取 |
| [tests/dsh-home.test.mjs](../tests/dsh-home.test.mjs) | `DSH_HOME` 的默认、绝对、`~`、相对与空白处理 |
| [tests/exit-guard.test.mjs](../tests/exit-guard.test.mjs) | job-only 判断、终态过滤、source kind、SessionId 参数、fail-open、用户中断、无豁免 |
| [tests/migrate.test.mjs](../tests/migrate.test.mjs) | 迁移纯函数与 fake host 编排（见上） |
| [tests/migration.runtime.test.mjs](../tests/migration.runtime.test.mjs) | 真实 temp-profile 迁移；含旧 `name: dsh-apollo` 被 Loader 跳过时从 `configuration().override` 恢复显式值的回归（无宿主时跳过） |
| [tests/mode-instructions.test.mjs](../tests/mode-instructions.test.mjs) | 只含通用纪律 + job 守卫；无委派/分档/CLI/PTC 文本；不依赖 tiers |
| [tests/owns-host.test.mjs](../tests/owns-host.test.mjs) | `declareOwnsHost` tap 注入位置、开关、去重、零路由 |
| [tests/packaging.test.mjs](../tests/packaging.test.mjs) | 真实 `npm pack --dry-run`：Specs/tests/scripts/prompts/tarball 不在清单 |
| [tests/prompts.test.mjs](../tests/prompts.test.mjs) | 快照与 Apollo 段一致；新插件 section 真实装配 |
| [tests/settings.test.mjs](../tests/settings.test.mjs) | 旧配置读取/导入优先级、Loader 等待、行页面策略、反代 tap、headless 降级 |
| [tests/upstream-drift.test.mjs](../tests/upstream-drift.test.mjs) | 预设结构、与上游 standard/ptc 差异白名单、engine 归一化、导出解析、engines 覆盖 |

`tests/upstream-drift.test.mjs` 与 `tests/migration.runtime.test.mjs` 在未设置 `DSH_PACKAGE_ROOT` 时跳过；显式设置后，无效路径/不兼容版本/缺失导出直接失败，而不是静默跳过。

### 真实宿主集成冒烟（无凭据、脚本化 LLM）

[scripts/runtime-smoke.mjs](../scripts/runtime-smoke.mjs) 使用 [scripts/lib/profile.mjs](../scripts/lib/profile.mjs) 建临时 home/profile，按各包 `files` 清单复制 Apollo + 三个独立包，注册脚本化适配器（不启动真实 CLI、不需要模型凭据）：

```sh
DSH_PACKAGE_ROOT=/path/to/node_modules/@deepseek-ai/dsh node scripts/runtime-smoke.mjs apollo
# 或 standalone / both / all
```

| 场景 | 覆盖 |
|---|---|
| `apollo` | 每个稳定行恰好一个实例；迁移旧行/旧预设配置并重载采用 engine 快照；真实 `eng` 回合与 prompt section；native `subagent` → `wait_subagent`；手动 `/compact` 经 better-compact 预设 engine；HTTP inspect；真实后台 job 退出守卫（启动 job → steer → 模型 job_kill → 回合收尾）；保存 compact 设置 → `requiresReload` → 重启 → `activeConfig` 更新 |
| `standalone` | 只选两个独立 bundle；无 Apollo 行/预设；global 范围渲染 delegation；`wait_subagent`/host-plane engine/手动压缩/inspect |
| `both` | Apollo + 两个独立 bundle 同时显式选中；每行一个实例；行可读但写入被拒（rc.2 只读限制）；单实例工具/提示词仍工作 |

通过标准：输出 `APOLLO_INTEGRATION_SMOKE_PASSED` 且进程退出码为 0。脚本不会修改用户当前 profile，也不会启动 Web GUI。

### 真实验证边界

- 本仓库不运行真实 Codex/Claude CLI；两个子包各自的 `cli-smoke` / runtime smoke 负责真实 CLI 生命周期。
- 真实模型摘要保真、缓存命中率、S3 可视化页面的 GUI 验收不在 Apollo 侧冒烟内。
- 未修改用户当前运行的 profile，未验证当前 GUI；当前 URL 以执行时 runtime context 为准。
- 单元测试通过不等于 registry 发布/安装路径通过；五个子包的目标版本尚未发布，registry 安装路径未验证。

## 历史兼容

### 旧版交付机制

早期版本用 `<dshHome>/.agent-presets` 同步预设副本。DSH 0.2.1 起预设由 bundle patch 的 `config.plugins` 直接承载，旧副本机制已删除。升级后残留旧目录不再被读取，可手动清理。

### CLI 身份与续接

- 外部 provider 仍是 `codex` / `claude`，内部 durable 路由仍是 `apollo-cli-codex` / `apollo-cli-claude`（定义在 better-subagent，Apollo 不复制）；
- CLI 身份 KV 命名空间 `apollo_cli_<sha256(profile.dir)[:16]>`、version、`sessions` 表与 per-record 布局不变；同 profile 路径升级后可续接；
- 会话 header 中的 child/parent、cwd、delivered、`remoteId`、profile 哈希含义不变；不为新包名伪造“同名子代理”；
- 已启动但没有可靠 `remoteId` 的会话拒绝恢复；发布后的失败轮次不自动重投已记 delivered 的输入（由 better-subagent 负责）。

### goal 与压缩

- 目标域继续使用原生 goal/change v1 日志与 projection（由 better-goal 拥有），安装/升级不自动改 phase、预算或 activation；
- 原生压缩事件/checkpoint 格式不变；better-compact 只替换公共 summarize 扩展并保留原生事务；回退原生压缩后仍可重放标准 checkpoint；
- `eng` / `eng-ptc` 预设 ID 不变；会话仍按这两个 ID 恢复。

### 版本范围

`engines.dsh` 是 `>=0.2.1-rc.2 <0.3.0`。写法包含预发布版，因此后续 RC 可能落在范围内；这不等于逐版验证。升级 DSH 后应运行漂移测试：上游新增而 eng 没跟上的行会失败；被有意剔除/替换的原生行会先断言仍存在于上游，再被过滤；本地新增行、engine 替换和调参必须精确匹配白名单。

## 实现入口、打包与发布

### 文件地图

| 文件 | 职责 |
|---|---|
| [package.json](../package.json) | 包元数据、bundle patch 顺序、浏览器注入、精确依赖 |
| [cordis.patch.yml](../cordis.patch.yml) | 原生 goal/compaction/官方 Web 提问卡片禁用；goal、compact companion/engine、subagent、shared ptc、ask-user、`apollo-skills` 顶层行 |
| [presets/eng.patch.yml](../presets/eng.patch.yml) / [presets/eng-ptc.patch.yml](../presets/eng-ptc.patch.yml) | 两套预设的行清单唯一事实源 |
| [presets/eng/plugins/exit-guard/index.js](../presets/eng/plugins/exit-guard/index.js) | job-only 退出守卫 |
| [presets/eng/plugins/mode-instructions/index.js](../presets/eng/plugins/mode-instructions/index.js) | 工程纪律 + job 守卫提示词 |
| [src/index.js](../src/index.js) | 主宿主行入口：技能 provider、settings、迁移 |
| [src/config.js](../src/config.js) | 正式配置 schema、deprecated 字段、规整与活配置读取 |
| [src/settings.js](../src/settings.js) | 行页面策略、旧文件导入、legacyImport 就绪 Promise |
| [src/owns-host.js](../src/owns-host.js) | `declareOwnsHost` index tap（唯一 web helper） |
| [src/migrate.js](../src/migrate.js) | 子代理/压缩迁移、有界等待、重读验证、pending/ambiguity |
| [src/client.js](../src/client.js) | 最小行页（exitGuard + 迁移说明），无构建闭包工厂 |
| [scripts/render-prompts.mjs](../scripts/render-prompts.mjs) / [prompts/](../prompts/) | 真实装配的系统提示词快照及生成脚本 |
| [scripts/runtime-smoke.mjs](../scripts/runtime-smoke.mjs) | 三组合真实宿主集成冒烟 |
| [scripts/lib/profile.mjs](../scripts/lib/profile.mjs) | 临时 profile、发布布局复制、鉴权与行计数 helper |

### 打包与 Specs 排除

私有设计 Specs（`docs/specs/`）不得进入 Git 或 npm：

- 本仓库 Git 私有排除规则忽略该目录（worktree 共享主仓库 `.git/info/exclude`）；
- `package.json` 的 `files` 只列 `src`、`docs/DEVELOPMENT.md`、`skills`、`presets`、`third-party`、`cordis.patch.yml`、`README.md`、`LICENSE`；
- [.npmignore](../.npmignore) 再次排除 `docs/specs/`、tests/scripts/prompts/.github/tarball/package-lock；
- [tests/packaging.test.mjs](../tests/packaging.test.mjs) 跑真实 `npm pack --dry-run --json` 断言清单。

### 发布

release workflow 使用 npm trusted publishing：tag 必须等于 `package.json` 版本，先 `npm install` / `npm test` 再 `npm publish --provenance`。Apollo 0.5.x 的 release job 只有在两个子包 0.1.0 可取得后才可能成功；不要硬编码 token、假发布或用开发 link 代替正式依赖。

## 许可与致谢

本包采用 **GPL-3.0-or-later**，全文见 [LICENSE](../LICENSE)。

| 内容 | 来源 | 许可 |
|---|---|---|
| `presets/eng.patch.yml` / `presets/eng-ptc.patch.yml` 的 `config.plugins` 块（改编自 DSH 标准 / PTC 预设） | DeepSeek Harness | MIT，见 [presets/eng/NOTICE](../presets/eng/NOTICE) 与 [third-party/LICENSE-MIT-dsh-standard-preset](../third-party/LICENSE-MIT-dsh-standard-preset) |
| `skills/tdd/`、`skills/diagnosing-bugs/` | [mattpocock/skills](https://github.com/mattpocock/skills) | MIT，Copyright © 2026 Matt Pocock，见 [third-party/NOTICE-mattpocock-skills](../third-party/NOTICE-mattpocock-skills) |

子代理与压缩实现及第三方内容分别在各自仓库保留版权/许可声明。
