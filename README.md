# dsh-apollo

一次会话做不完的大任务，拆成可独立实现、可独立验证的子任务：逐波并行执行 → 子代理只读审查 → 验证通过才合入。

**DSH（DeepSeek Harness）插件，包含两部分**：

1. **流程技能**：把大型需求拆成协同 Spec，逐波 worktree 执行、内置子代理代码审查、验证后合入；单个边界明确的任务走 `main-agent-driven-development`，其实现节点依赖本包捆绑的 `tdd` 与 `diagnosing-bugs`。全部节点基于 DSH 原生能力（`subagent` / `workflow` / 后台任务），不依赖外部执行后端，对任何 preset 生效。
2. **「工程模式」（eng）agent 预设**：面向编码与基础设施任务的 preset（工具目录、委派、压缩与提示词组合），带**退出守卫**——回合结束前仍有运行中的子代理或后台任务时不允许收尾（默认关闭，在 `eng.json` 或设置面板里打开）。
3. **设置面板**：设置页 → Plugins → 「工程模式」，读写退出守卫开关，保存即时生效。

零依赖、无构建步骤，纯 ESM。

## 安装

```sh
# 从 GitHub 装（推荐）
dsh plugin --profile <name> add github:Menghuan1918/dsh-apollo

# 或本地目录
dsh plugin --profile <name> add link:/path/to/dsh-apollo

dsh --profile <name> --dump-config   # 应出现 "# == dsh-apollo" 层与 apollo-skills 行
```

重启该 profile 的 dsh 进程后生效：

- 新会话的技能目录包含下列流程技能（技能注册在全局层，任何挂载 `tool-skill` 的 preset 都看得到）；
- 包内 `presets/eng/` 被同步进 `<dshHome>/.agent-presets/eng`，预设选择器里出现「工程模式」。预设根虽在启动早期扫描，但同步发生在首个请求之前，**一次重启即可**（2026-09-12 在隔离 `DSH_HOME` 上实测：首次启动后副本已存在且与包内校验和一致）。

把工程模式设为默认（用户级设置，不随仓库分发）：

```yaml
# ~/.dsh/settings.yaml
agent-presets:
  default: eng
```

卸载：

```sh
dsh plugin --profile <name> remove dsh-apollo
# 同步副本不会自动删除，需要时手动清理：
rm -rf ~/.dsh/.agent-presets/eng
```

## 流程技能

| 技能 | 入口 | 职责 |
|---|---|---|
| brainstorming | `/brainstorming` | 把大型需求设计为获批的主 Spec + 子 Spec |
| exec | `/exec` | 逐 Spec worktree、波次 workflow 执行、合并、最终代码审查 |
| dev | 被 `/exec` 引用 | 实现与审查节点的 prompt 契约、报告 schema、失败语义 |
| main-agent-driven-development | `/main-agent-driven-development` | 单个边界明确的实现任务（预建/独立 worktree 模式） |
| tdd | 被 `main-agent-driven-development` 引用 | 红→绿循环的参考：好测试的标准、seam 选择、反模式 |
| diagnosing-bugs | 被 `main-agent-driven-development` 引用 | 难 bug 的诊断纪律：先建反馈循环，再假设、定位、修复 |
| code-review | `/code-review` | 双轴（Standards/Spec）并行子代理代码审查 |
| handoff | `/handoff` | 把当前对话压缩成交接文档 |

约定：

- Spec 落盘优先 `.workspace-docs/specs/`（工作区有该约定时），否则目标仓库自己的 specs 目录；写入 `.workspace-docs/` 时带 OKF 头。
- 交接文档（`/handoff`）同理落 `.workspace-docs/notes/`，会话内已有交接则整篇复写。
- 质量档 = 本会话可用的最强模型，在 `exec` 的 workflow 脚本顶部一处定义（`quality` 常量）；**留空即由子代理继承父会话路由**，任何环境都能跑。要固定档位就在那一处写 `provider` / `model`。
- 可视化辅助写自包含静态 HTML 到系统临时目录，不起服务；DSH 界面直接打开预览，反馈走对话。

捆绑的 `tdd` 与 `diagnosing-bugs` 来自 [mattpocock/skills](https://github.com/mattpocock/skills)（MIT，Copyright © 2026 Matt Pocock），许可证原文见 `third-party/NOTICE-mattpocock-skills`。

## 工程模式预设（eng）

`presets/eng/` 是一棵完整的 preset 树，启动时同步进用户预设根：

| 文件 | 作用 |
|---|---|
| `agent.cordis.yml` | preset 组合（改编自 DSH 内置 standard preset，MIT，见 `presets/eng/NOTICE`）：工具、委派、plan mode、压缩与提示词段 |
| `preset.yml` | 预设元数据（名称「工程模式」） |
| `plugins/exit-guard/` | 退出守卫：`agent/turn-stopping` 时若有运行中的直接子代理或后台任务，注入提醒强制回合继续 |
| `plugins/wait-subagent/` | `wait_subagent` 工具：一次调用并发等待全部直接子代理，只回短 done 行，内容交还框架的 settlement notice |
| `plugins/mode-instructions/` | eng 专属提示词段：退出守卫契约 + 子代理委派/编排纪律（只写其它表面未述的 delta；委派纪律原在全局 `~/.dsh/AGENTS.md`，2026-09-11 迁入；模型档位留在全局，因其跟随本机路由配置） |
| `plugins/lib/atlas-config.js` | `<dshHome>/eng.json` 读取（旧名 `atlas.json` 只读回退） |

预设是内置 `standard` 的整棵拷贝（DSH 没有 extends/include 机制，插件也无法新增预设根）。拷贝就会漂移：`node --test` 里的 `tests/upstream-drift.test.mjs` 拿本机 DSH 的 `standard` 对照，**上游有而 eng 没有的行直接判失败并列出该补哪一行**，并挡住未声明的配置差异。2026-09-12 补回的上游行是 `@deepseek-ai/dsh-tool-present`（缺失时静默没有 `present` 工具）。

同步是**整体覆盖**：包内树与副本不一致时整棵重写，并删除源树没有的文件。不要把自己的内容放进 `<dshHome>/.agent-presets/eng`——首次启动就被清掉。

## 运行时配置

`<dshHome>/eng.json`：

```json
{
  "exitGuard": false
}
```

- `exitGuard`（默认 `false`，**显式开关**）：退出守卫总开关。每次回合结束前重读，改配置即时生效，无需重启。
- 旧文件名 `atlas.json` 仍会被读取（仅当 `eng.json` 缺失或损坏）；写入永远落 `eng.json`，面板首次保存即完成迁移。
- 文件缺失/损坏/形状非法一律回退默认关闭，绝不抛错：配置故障既不该让守卫意外生效，也不该让回合结束路径崩溃。

守卫只在开启时介入，且只看 DSH 本地的 job 注册表与直接子代理：需要跨回合常驻的服务（dev server、watcher）用 pm2/systemd/`nohup` 等脱离 job 注册表的方式管理，或保持开关关闭。用户中断（Esc）不受守卫影响。

### 设置面板

设置页 → Plugins 分区 → 「工程模式」标签页（开关 + 保存，即时生效）。面板经 host 半边的自有路由 `/eng-panel/api/config` 读写 `eng.json`，默认**仅接受 loopback Host + 同源标志**（DNS-rebinding / 跨站防御）。

经反向代理域名访问 GUI 时，把该权威加入 profile 层这一行的 config：

```yaml
# ~/.dsh/profiles/<name>/cordis.patch.yml
- id: apollo-skills
  config:
    trustedHosts: [dsh.example.com]
    # 可选：让官方 client 把反代页面视作 loopback，设置页回到 host 持久化。
    # 安全边界随反代信任，仅在受信代理下开启。
    declareOwnsHost: true
```

## 机制

`cordis.patch.yml` 只插入**一行**宿主插件 `apollo-skills`（裸包名 `dsh-apollo`）。单行是硬约束，不是偏好：

- 浏览器半边（`dsh.client` → `exports["./client"]`）由该行的**包清单**发现，而 `dsh-client-modules` 只接受裸包名或两段 scoped 名，并且拒绝第二个解析到同一包名的活跃行；
- DSH 只扫描内置预设根与 `<dshHome>/.agent-presets`，profile patch 无法新增预设根——所以包内预设只能在上电时同步进用户根（sync-on-boot，参照 dsh-web 生态的 dsh-liangshen）。

因此这一行的 node 半边（`src/index.js`）承担三件事：

1. `src/index.js` — 扫描包内 `skills/*/SKILL.md`，解析 frontmatter（`name` / `description` / `whenToUse` / `disable-model-invocation` / `user-invocable`，其余键进 metadata），以 rank 600 注册到 `ctx.skills` 全局层。技能正文中的相对资源引用按该技能目录解析。
2. `src/preset-sync.js` — 把 `presets/` 逐字节幂等同步进 `<dshHome>/.agent-presets`：已一致则跳过，变更整体重写并清理源树不含的多余文件，不触碰插件不拥有的预设目录。
3. `src/panel.js` — 注册 `/eng-panel/api/config` 路由；`declareOwnsHost: true` 时装配 `<head>` 注入 tap。

无 watcher：技能与预设内容随包版本走，改动在进程重启后生效。

## 已知限制

- 技能内容与预设无热更新，改完需重启对应 profile 的 dsh 进程。
- `exec` 的 `quality` 常量默认为空（子代理继承父会话路由），要固定质量档就在 `skills/exec/SKILL.md` 脚本顶部那一处写 `provider` / `model`；会话若启用了 `subagent-model-selection` 策略，路由必须落在本机允许清单内，否则显式档位会被直接拒绝。
- `presets/eng/agent.cordis.yml` 逐行引用上游 `@deepseek-ai/dsh-*` 包名，跨版本升级 DSH 后先 `node --test`：漂移自检会列出上游新增而 eng 未跟上的行；再重启。
- `package.json` 只声明了 `react` peer，没有声明 `@deepseek-ai/cordis` 与各 `@deepseek-ai/dsh-*` 的版本 peer——同生态插件（如 dsh-better-sidebar）会声明这些，缺了它们升级 DSH 时没有版本门禁，pnpm 的严格 peer 配置下也可能装不上。
- 技能正文是中文的（含进技能目录的 `description`），`/exec` 注入子代理的 prompt 也是中文；非中文用户需要自行改文案。
- 本包按 `link:` 或本地路径安装使用；未发布到任何 registry，仓库也还没有 remote。

## 开发

```sh
node --test          # 72 例：技能 provider、捆绑技能目录、预设同步、预设漂移自检、配置读取、退出守卫、wait_subagent、面板路由
```

`presets/eng/` 是仓库内的唯一事实源，`<dshHome>/.agent-presets/eng` 是启动时同步出来的副本——**不要直接编辑副本**，下次启动会被覆盖。跑 `node --test` 会顺带把源树同步进副本（漂移自检的一部分），所以改完预设先跑测试再重启。

## 许可

本包整体以 **GPL-3.0-or-later** 发布，全文见 `LICENSE`。

捆绑的两部分来自 MIT 许可的上游，其原始许可与署名一并保留（GPL-3.0 与 MIT 兼容）：

| 内容 | 来源 | 许可 |
|---|---|---|
| `presets/eng/agent.cordis.yml`（改编自 DSH 内置 `standard` 预设） | DeepSeek Harness | MIT，见 `presets/eng/NOTICE` 与 `third-party/LICENSE-MIT-dsh-standard-preset` |
| `skills/tdd/`、`skills/diagnosing-bugs/` | [mattpocock/skills](https://github.com/mattpocock/skills) | MIT，Copyright © 2026 Matt Pocock，见 `third-party/NOTICE-mattpocock-skills` |
