<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/omdsh-dev/dsh-better-dsh/main/docs/assets/hero-dark.svg">
    <img src="https://raw.githubusercontent.com/omdsh-dev/dsh-better-dsh/main/docs/assets/hero-light.svg" width="100%" alt="Better DSH — 一个 bundle，五种能力">
  </picture>
</p>

<h1 align="center">dsh-better-dsh</h1>

<p align="center">
  <strong>一个 bundle，五种能力。</strong><br>
  DeepSeek Harness 的插件集合入口：一次安装，把五个独立插件装配进同一个 profile。
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/dsh-better-dsh"><img src="https://img.shields.io/npm/v/dsh-better-dsh.svg" alt="npm 版本"></a>
  <a href="LICENSE"><img alt="License" src="https://img.shields.io/github/license/omdsh-dev/dsh-better-dsh?color=blue"></a>
  <a href="package.json"><img alt="Node &gt;=24.9.0" src="https://img.shields.io/badge/node-%3E%3D24.9.0-339933?logo=node.js&amp;logoColor=white"></a>
  <a href="package.json"><img alt="DSH 0.2.2-rc.1" src="https://img.shields.io/badge/DSH-0.2.2--rc.1-4B32C3"></a>
  <a href="https://github.com/omdsh-dev/dsh-better-dsh"><img alt="GitHub" src="https://img.shields.io/badge/GitHub-omdsh--dev-181717?logo=github"></a>
</p>

<p align="center">
  <a href="#一分钟看懂">一分钟看懂</a> ·
  <a href="#安装">安装</a> ·
  <a href="#架构">架构</a> ·
  <a href="#能力地图">能力地图</a> ·
  <a href="#设置">设置</a> ·
  <a href="#升级">升级</a> ·
  <a href="#独立使用">独立使用</a> ·
  <a href="#开发与发布">开发</a>
</p>

## 一分钟看懂

| | |
|---|---|
| **一次安装** | `dsh plugin add dsh-better-dsh` 之后，五个插件作为精确依赖自动安装，五行由 bundle patch 插入。 |
| **五个独立插件** | goal、subagent、compact、ask-user、ptc 各自有独立的 npm 包、仓库、设置页和生命周期；也可以单独安装。 |
| **一份设置** | Better DSH 详情页的「集成设置」聚合五个设置页；保存写回同一份 profile，不产生第二份配置。 |
| **一套工作流** | 流程技能、两套工程预设、长期目标、CLI 子代理、压缩与提问增强，开箱即用。 |
| **纯 ESM** | 零构建步骤；浏览器半边是直接加载的 closure factory。 |
| **Apache-2.0** | 六个仓库统一使用 Apache License 2.0。 |

## 安装

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/omdsh-dev/dsh-better-dsh/main/docs/assets/quickstart-dark.svg">
    <img src="https://raw.githubusercontent.com/omdsh-dev/dsh-better-dsh/main/docs/assets/quickstart-light.svg" width="100%" alt="安装 Better DSH 的四个步骤">
  </picture>
</p>

需要 Node.js `>=24.9.0`；验收基线是 DSH `0.2.2-rc.1`。

```sh
# npm
dsh plugin --profile <profile> add dsh-better-dsh@0.10.0

# 或从 GitHub tag 安装
dsh plugin --profile <profile> add github:omdsh-dev/dsh-better-dsh#v0.10.0
```

> 安装、升级或换包后必须**重启对应 profile**；只刷新网页不够。
>
> 不要同时显式添加 Better DSH 和独立插件 bundle：行实例仍只有一个，但 DSH 0.2.2-rc.1 会把同一 id 的配置写入拒绝为只读。只保留一个显式入口。

本轮版本：**Better DSH `0.10.0`**，搭配 goal `0.4.1`、subagent `0.5.0`、compact `0.3.1`、ask-user `0.3.1`、ptc `0.2.0`。

## 架构

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/omdsh-dev/dsh-better-dsh/main/docs/assets/architecture-dark.svg">
    <img src="https://raw.githubusercontent.com/omdsh-dev/dsh-better-dsh/main/docs/assets/architecture-light.svg" width="100%" alt="Better DSH 架构：一次安装，五条稳定行">
  </picture>
</p>

Better DSH 只做三件事：

1. **装配**：把五个插件的稳定行插入当前 profile；
2. **收口**：提供流程技能、两套工程预设、后台任务退出守卫；
3. **迁移**：把旧 Apollo 配置幂等地补进新的插件行。

每个插件仍然是独立包：自己的 npm 名、自己的行 id、自己的设置页、自己的生命周期。Better DSH 不复制它们的实现，也不产生第二份配置。

<details>
<summary><strong>五条稳定行与包名</strong></summary>

| 行 id | npm 包 | 拥有什么 |
|---|---|---|
| `apollo-skills` | `dsh-better-dsh` | 流程技能、工程预设、后台 job 守卫、旧配置迁移 |
| `dsh-better-goal` | `dsh-better-goal` | 长期目标、暂停、轮数策略 |
| `dsh-better-subagent` | `@oh-my-dsh/dsh-better-subagent` | CLI 子代理、`wait_subagent`、运行中子代理守卫、模型分档 |
| `dsh-better-compact` | `dsh-better-compact` | native / goal / handoff 压缩、预算、摘要路由、诊断 |
| `dsh-better-ask-user` | `dsh-better-ask-user` | 提问等待、输入续期、Markdown/移动端卡片、超时 |
| `dsh-better-ptc` | `dsh-better-ptc` | ask-user 与 subagent 共享的 PTC deadline 豁免单例 |

Better DSH 的 bundle patch 直接声明这些行；DSH 不会自动应用传递依赖的 bundle patch，所以需要在这里重复同一组稳定行。行 id 与设置命名空间保持不变，改名不会破坏旧 profile。
</details>

## 能力地图

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/omdsh-dev/dsh-better-dsh/main/docs/assets/plugins-dark.svg">
    <img src="https://raw.githubusercontent.com/omdsh-dev/dsh-better-dsh/main/docs/assets/plugins-light.svg" width="100%" alt="Better DSH 能力地图">
  </picture>
</p>

- **[dsh-better-goal](https://github.com/omdsh-dev/dsh-better-goal)**：长期目标、暂停与轮数策略；
- **[dsh-better-subagent](https://github.com/omdsh-dev/dsh-better-subagent)**（`@oh-my-dsh/dsh-better-subagent`）：Codex / Claude 可续接 CLI 子代理、`wait_subagent`、运行中子代理守卫、模型分档；
- **[dsh-better-compact](https://github.com/omdsh-dev/dsh-better-compact)**：native / goal / file-handoff 三种压缩模式与只读诊断；
- **[dsh-better-ask-user](https://github.com/omdsh-dev/dsh-better-ask-user)**：提问等待、输入续期、Markdown/移动端卡片、超时行为；
- **[dsh-better-ptc](https://github.com/omdsh-dev/dsh-better-ptc)**：ask-user 与 subagent 共享的 PTC deadline 豁免单例。

<details>
<summary><strong>流程技能</strong></summary>

| 技能 | 用途 |
|---|---|
| `/brainstorming` | 把大型需求设计为获批的主 Spec 与子 Spec |
| `/exec` | 按依赖分波：worktree → 并行子代理实现 → 审查 → 验证与合并 |
| `/dev` | 实现与审查节点的 prompt、报告结构与失败契约 |
| `/main-agent-driven-development` | 实现一个边界明确的单个任务 |
| `/tdd` | 测试先行、红绿循环、测试边界与反模式 |
| `/diagnosing-bugs` | 先建立反馈循环，再定位和修复根因 |
| `/code-review` | 并行检查仓库标准与原始需求，并排报告 |
| `/handoff` | 把当前上下文整理为交接文档；仅由用户手动触发 |

技能需要在所选预设中挂载 DSH 的技能工具；两套工程预设已挂载。
</details>

<details>
<summary><strong>两套工程预设</strong></summary>

| 预设（ID） | 适合 | 关键差异 |
|---|---|---|
| 工程模式（旧版，不建议使用）— `eng` | 编码 / 基础设施任务 | 原生工具调用；保留 workflow 工具 |
| 工程（PTC）模式 — `eng-ptc` | 多步、循环、需要过滤汇总的任务 | 工具经 `run_code` 的 TypeScript SDK 调用；与官方 PTC 模式一致不提供 workflow |

两套预设共用 Better DSH 的通用工程纪律（KISS、证据先行、修复根因、防过度设计与过度防御、权限与依赖边界、命令与进程纪律）。**委派规则与模型分档不在 Better DSH**：由 better-subagent 在 `agent/created` 时按预设与活配置注册自己的 prompt section。完整组装结果见 [prompts/eng.md](prompts/eng.md) 与 [prompts/eng-ptc.md](prompts/eng-ptc.md)。

在 PTC 模式里，`wait_subagent` / `ask_user_question` / `exit_plan_mode` 的等待不消耗 `run_code` 的 elapsed budget；普通嵌套工具仍按原预算计时。单例 `dsh-better-ptc` 行自身注册 `exit_plan_mode`，ask-user 与 subagent 各自注册另外两个工具。**计划审批无限期等待、不自动批准、不受普通提问超时/默认选择影响**；外层取消、会话中断及卸载仍有效。
</details>

## 设置

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/omdsh-dev/dsh-better-dsh/main/docs/assets/settings-dark.svg">
    <img src="https://raw.githubusercontent.com/omdsh-dev/dsh-better-dsh/main/docs/assets/settings-light.svg" width="100%" alt="Better DSH 集成设置">
  </picture>
</p>

Better DSH 包详情里的「集成设置」按 Core、Subagents、Compaction、Goals、Questions 组织。切换页面保留草稿，保存后订阅宿主新值与 revision；每个区复用独立插件自己的配置组件。

- **保存即生效**：`exitGuard`、子代理行、增强 goal 轮数策略这类 volatile 字段不需要重挂。
- **需要重载**：goal 实现选择、原生参数、compact 引擎快照、安装 / 升级 / 换包。界面会明确标注。
- **只保留一个入口**：同时显式添加 Better DSH 与独立 bundle 会让同一 id 的行配置变为只读。

<details>
<summary><strong>五行设置与生效方式</strong></summary>

| 行 | 所属包 | 主要设置 | 生效 |
|---|---|---|---|
| `apollo-skills` | Better DSH | `exitGuard`（只拦运行中后台 job）、`declareOwnsHost` | volatile 保存；`declareOwnsHost` 装配时读取，需重载 profile |
| `dsh-better-subagent` | better-subagent | `childExitGuard`、`tiers.*`、两个 CLI 后端、`subagents.eng/global`、`trustedHosts` | volatile，保存即生效 |
| `dsh-better-compact` | better-compact | 模式、auto、阈值/headroom/保留、摘要模型、重试、模型规则 | volatile 保存；引擎快照需重载 profile |
| `dsh-better-goal` | goal | 实现选择（增强/原生）、轮数策略、原生参数 | 轮数策略保存即生效；实现与原生参数需重载 profile |
| `dsh-better-ask-user` | ask-user | 等待时长、输入续期、普通/Goal 超时行为 | volatile，保存即生效；旧 goal 值一次性迁移 |

运行中子代理的拦截与 Better DSH 的后台 job 守卫是**两个独立开关**；任意一个关闭都不影响原生工具。原生 `subagent` / `subagent_fork` / `send_message` / `interrupt_agent` 注册表不变。
</details>

## 升级

> 本轮从 Apollo `0.9.0` 升级到 Better DSH `0.10.0`：包名、部分设置键和依赖名变化；旧 profile 的配置由幂等迁移补齐，不删除旧值。

```sh
# 旧入口
dsh plugin --profile <profile> remove @menghuan1918/dsh-apollo
# 新入口
dsh plugin --profile <profile> add dsh-better-dsh@0.10.0
# subagent 独立安装的用户
dsh plugin --profile <profile> remove @menghuan1918/dsh-better-subagent
dsh plugin --profile <profile> add @oh-my-dsh/dsh-better-subagent@0.5.0
```

<details>
<summary><strong>迁移规则与旧配置兼容</strong></summary>

0.6.0 把提问等待从 better-goal 移到独立的 dsh-better-ask-user，并把 PTC deadline 豁免移到共享 dsh-better-ptc；better-goal 的旧 `questionTimeoutSeconds` 仍可读取，ask-user 行会做一次性迁移。旧 profile 不需要手工重填配置：Better DSH 启动后在 settings/loader 可用时运行一次**幂等迁移**（[src/migrate.js](src/migrate.js)）。

- **目标行已有的显式用户值优先**；迁移只补缺失字段，不覆盖你在新设置页里改过的值。显式 `false` / `0` / `""` / `[]` 都是值。
- 旧 `exitGuard` 的初值同时复制到 better-subagent 的 `childExitGuard`；Better DSH 自己的 `exitGuard` 继续作为后台 job/通用守卫开关，之后两者可独立配置。
- 旧原生 `compaction-basic` 的显式配置补进 better-compact；目标缺失的模式采用默认 `goal`。
- `trustedHosts` 经宿主 configEditor 写到目标行 raw config，不绕过字段限制。
- 迁移**不删除**旧配置、不复制 CLI 身份 KV、不复制 goal 状态；写入后重读验证，失败/目标行尚不可写时明确报告“待迁移/需重载”。
- 旧 `apollo-skills` 行里的 `tiers` / `subagents` / `trustedHosts` 降级为 deprecated、运行时无效，只为装载旧 profile 与迁移保留。

升级后重启 profile；迁移写入的压缩设置需要再重载一次才会被运行中的引擎采用。
</details>

## 独立使用

五个插件都可以单独安装；独立安装和 Better DSH 组合使用的是**同一组稳定行**。

```sh
dsh plugin --profile <profile> add dsh-better-goal@0.4.1
dsh plugin --profile <profile> add @oh-my-dsh/dsh-better-subagent@0.5.0
dsh plugin --profile <profile> add dsh-better-compact@0.3.1
dsh plugin --profile <profile> add dsh-better-ask-user@0.3.1 dsh-better-ptc@0.2.0
```

<details>
<summary><strong>组合安装、只读限制与回退</strong></summary>

| 组合 | 结果 |
|---|---|
| 只有 Better DSH | 插入 goal / subagent / compact companion+engine / ask-user / ptc 行；工程预设内带 compact engine |
| 只有独立 bundle | 各自插入同样的行；没有 Better DSH 的工程预设、技能或 job 守卫 |
| Better DSH + 独立 bundle 同时显式选中 | Loader 仍按行 id 只激活一行实例，但 DSH 0.2.2-rc.1 会拒绝为同一 id 写入配置：行可读、配置只读 |

恢复方法：**只保留一个显式入口**，然后重启 profile。不要为了“多一层保险”同时安装两套入口。

- 移除独立 bundle **不会**移除 Better DSH 仍然装配的同一稳定行；反之亦然。按“有效 row 的来源”判断，而不是 bundle 名。
- 彻底移除压缩增强：从组合中移除 Better DSH，或把预设/组合改回原生压缩。只禁用独立 compact bundle 不会恢复 Better DSH 预设内的 engine 行。
</details>

## 开发与发布

- 开发文档：[docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)
- UI kit：[docs/UI-KIT.md](docs/UI-KIT.md)
- API / 迁移实现：[src/](src/)
- 测试：`npm test`；运行时冒烟：`npm run smoke`

<details>
<summary><strong>提示词归属、Specs 与发布顺序</strong></summary>

**提示词归属**：工程纪律由 Better DSH 提供；委派规则、模型分档和子代理提示词由 better-subagent 在 `agent/created` 时注册；目标与提问提示词由对应插件拥有。Better DSH 不重复生成子插件已经拥有的 prompt section。

**发布顺序**：先发布独立包，再发布 Better DSH（精确依赖必须已存在）：

1. `dsh-better-ptc@0.2.0`（不变）
2. `dsh-better-ask-user@0.3.1`
3. `dsh-better-compact@0.3.1`
4. `dsh-better-goal@0.4.1`
5. `@oh-my-dsh/dsh-better-subagent@0.5.0`
6. `dsh-better-dsh@0.10.0`

各仓库使用 npm trusted publishing（OIDC）；创建对应 GitHub Release 会发布 tag 指向的版本。旧包 `@menghuan1918/dsh-apollo` 与 `@menghuan1918/dsh-better-subagent` 已标记 deprecate，仅作为历史入口保留。
</details>

## 许可

[Apache License 2.0](LICENSE)。Better DSH 与五个附属插件仓库统一使用 Apache-2.0。
