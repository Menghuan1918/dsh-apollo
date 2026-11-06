/**
 * dsh-better-dsh (npm: dsh-better-dsh) — 浏览器半边。
 *
 * 两块 UI：
 *
 * 1. **行配置页**（`plugins.row.config`，键 `<包名>#apollo-skills`）：后台任务
 *    `exitGuard` 开关 + 迁移/弃用说明。保存即生效（volatile），写入当前
 *    profile 的行配置（cordis.patch.yml）。
 *
 * 2. **集成设置弹窗**（`plugins.detail.actions` 的 "Apollo 集成设置" 按钮，
 *    只在 subject 为 Apollo bundle 详情页时渲染）：弹窗左 nav + 右内容，聚合
 *    渲染各子插件自己注册到 `plugins.row.config` 的设置组件——entry 组件经
 *    `ctx.slots.entriesOfSlot` 按 `#<rowId>` 键后缀找到，`form` 用
 *    `ctx.configForms.get(rowId)` 复刻官方 `formFor`（`{state,mutate}`），
 *    `t` 用 `ctx.locale.bind(entry.locale)` 补齐。子插件页面永远是单一事实
 *    源，本文件不复制任何字段定义。
 *
 * 主题：局部强调色 #3388BB，中性表面与文字继承宿主 --dsw-alias-* 令牌。
 * 零构建：closure factory，只 require('react') + 可选 ui-primitives（Modal
 * 兜底为自绘 overlay）；不 fetch、不直接写 DOM。
 */

window.__ModuleLoader__.load({
	id: 'dsh-better-dsh',
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		const React = require('react');
		const { createElement: h, useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } = React;

		/** ui-primitives 是可选依赖：拿不到时弹窗退化为自绘 overlay。 */
		let Primitives = null;
		try {
			Primitives = require('@deepseek-ai/dsh-client-ui-primitives');
		} catch {
			Primitives = null;
		}
		const Modal = Primitives?.Modal ?? null;

		const NS = 'apollo';
		const PACKAGE_NAME = 'dsh-better-dsh';
		const LEGACY_SCOPED_PACKAGE_NAME = '@menghuan1918/dsh-apollo';
		const LEGACY_PACKAGE_NAME = 'dsh-apollo';
		// 新键是 Plugins 页按“bundle 依赖名 + 行 id”算出的（= npm 包名 + #apollo-skills）；
		// 旧键并排注册，只为仍把依赖槽记成旧 unscoped 名的 profile 保留配置入口。
		const ROW_KEYS = ['dsh-better-dsh#apollo-skills', '@menghuan1918/dsh-apollo#apollo-skills', 'dsh-apollo#apollo-skills'];
		const DETAIL_ACTIONS_SLOT = 'plugins.detail.actions';
		const ROW_CONFIG_SLOT = 'plugins.row.config';
		const HUB_ENTRY_ID = 'apollo-settings-hub';

		/** 聚合弹窗展示的设置命名空间（= 行 id），按 nav 顺序排列。 */
		const HUB_ROWS = [
			{ rowId: 'apollo-skills', icon: 'M4 5h16M4 12h16M4 19h16M8 3v4m8 3v4M10 17v4', titleKey: 'pluginBetterDsh' },
			{ rowId: 'dsh-better-subagent', icon: 'M8 7V4h8v3M6 17H3v-6h6v6H6Zm12 0h-3v-6h6v6h-3ZM6 11V8h12v3M6 17v3m12-3v3', titleKey: 'pluginSubagent' },
			{ rowId: 'dsh-better-compact', icon: 'M4 4h16v16H4ZM8 9l4 4 4-4M12 6v7M8 17h8', titleKey: 'pluginCompact' },
			{ rowId: 'dsh-better-goal', icon: 'M12 8a4 4 0 1 0 4 4M12 3a9 9 0 1 0 9 9M12 12l8-8m-4 0h4v4', titleKey: 'pluginGoal' },
			{ rowId: 'dsh-better-ask-user', icon: 'M21 11a8 8 0 0 1-8 8H8l-5 3V11a8 8 0 0 1 8-8h2a8 8 0 0 1 8 8ZM9 9a3 3 0 0 1 6 0c0 2-3 2-3 4m0 3h.01', titleKey: 'pluginAskUser' },
		];

		const zh = {
			summary: '后台任务退出守卫与兼容性说明',
			title: '通用',
			connectionTitle: '连接与访问',
			guardTitle: '退出守卫',
			ownsHostLabel: '将反代页面声明为可信宿主',
			ownsHostHint: '仅在你控制访问权限的可信反向代理后启用。这会允许该页面写入宿主设置；不改变子代理 API 的可信地址列表。',
			ownsHostReload: '保存后需重载 profile 并刷新页面。',
			savedReload: '已保存；重载 profile 并刷新页面后生效。',
			guardEnd: '回合结束',
			guardJobs: '后台任务',
			guardContinue: '有任务则继续',
			guardAllow: '允许结束',
			compatTitle: '兼容性',
			migratedBody: 'CLI 子代理、wait_subagent、运行中子代理守卫、模型分档与子代理设置页由 @oh-my-dsh/dsh-better-subagent 拥有；压缩模式与预算由 dsh-better-compact 拥有。请到 Plugins 中对应的行配置，或使用包详情页的集成设置弹窗。',
			deprecatedBody: '旧 Apollo 行里的 tiers / subagents / trustedHosts 只为迁移旧 profile 保留，运行时不再生效；迁移在启动后自动补齐新插件的缺失值，目标行已有显式设置时不会被覆盖。',
			reloadBody: '从 0.4.x 升级、或同时显式选中了独立 bundle 时，行可能显示为只读/不可寻址；请只保留一个显式入口并重载 profile。压缩设置的保存需要重载 profile 才会被引擎采用。',
			loading: '正在读取配置…',
			waitingForm: '正在等待宿主提供这一行的配置快照…',
			noFormHint: '长时间停在这里说明宿主没有为这一行提供可编辑配置：本部署没组合 dsh-settings/config-editor，或本行的 Config 未被识别。',
			unavailable: '当前连接下该配置不可用：请通过 loopback 地址访问，或在宿主部署层把该权威加入受信反代。',
			readonly: '当前连接只读（设置镜像为进程内 memory），无法写入宿主配置。',
			exitGuardLabel: '等待后台任务结束',
			exitGuardHint: '回合结束时仍有运行中的后台命令会注入提醒强制继续处理；Esc 中断始终放行。',
			save: '保存',
			saving: '保存中…',
			reset: '放弃改动',
			saved: '已保存，即时生效。',
			conflict: '宿主拒绝了这次写入：配置可能已被其他改动更新或被更高优先级配置覆盖，已重新读取宿主值。',
			saveFailed: '保存失败：',
			readonlyNote: '只读：当前无法写入宿主配置。',
			unavailableNote: '不可写：当前连接下该配置不可用。',
			hubButton: '集成设置',
			hubTitle: 'Better DSH',
			hubEmpty: '暂无可用的子插件设置：子插件客户端尚未注册设置页，或本部署未组合设置服务。',
			close: '关闭',
			unsavedTitle: '有未保存的改动',
			unsavedBody: '关闭将放弃各页面尚未保存的设置。',
			keepEditing: '继续编辑',
			discardClose: '放弃并关闭',
			entryError: '此设置区加载失败：',
			retry: '重新加载',
			pluginBetterDsh: '核心',
			pluginSubagent: '子代理',
			pluginCompact: '上下文压缩',
			pluginGoal: '目标',
			pluginAskUser: '提问',
		};

		const en = {
			summary: 'Background-job exit guard and compatibility notes',
			title: 'General',
			connectionTitle: 'Connection and access',
			guardTitle: 'Exit guard',
			ownsHostLabel: 'Trust this reverse-proxied page as the host',
			ownsHostHint: 'Enable only behind a trusted proxy whose access you control. This allows the page to write host settings; it does not change the subagent API’s trusted authorities.',
			ownsHostReload: 'Save, then reload the profile and refresh the page.',
			savedReload: 'Saved. Reload the profile and refresh the page to apply.',
			guardEnd: 'Turn ends',
			guardJobs: 'Background jobs',
			guardContinue: 'Continue if running',
			guardAllow: 'Allow completion',
			compatTitle: 'Compatibility',
			migratedBody: 'CLI subagents, wait_subagent, the running-child guard, model tiers and the subagent settings page are owned by @oh-my-dsh/dsh-better-subagent; compaction modes and budgets are owned by dsh-better-compact. Configure their rows under Plugins, or use the integrated settings dialog on the package page.',
			deprecatedBody: 'The old Apollo tiers / subagents / trustedHosts fields are kept only so 0.4.x profiles load; they are inert at runtime. After boot the migration fills the new plugins’ missing values and never overwrites an explicit target setting.',
			reloadBody: 'Upgrading from 0.4.x, or selecting both the standalone and Apollo bundles explicitly, can make the row read-only/unaddressable: keep a single explicit entry and reload the profile. Saved compaction settings take effect only after the profile reloads.',
			loading: 'Loading configuration…',
			waitingForm: 'Waiting for the host to provide this row’s configuration snapshot…',
			noFormHint: 'Staying here means the host exposes no editable config for this row: dsh-settings/config-editor is not composed, or this row’s Config was not recognized.',
			unavailable: 'This configuration is unavailable on the current connection: use a loopback address, or trust this authority in the host deployment.',
			readonly: 'This connection is read-only (settings mirror is process-local memory); host configuration cannot be written.',
			exitGuardLabel: 'Wait for background work',
			exitGuardHint: 'Blocks turn end while background commands still run; Esc always passes through.',
			save: 'Save',
			saving: 'Saving…',
			reset: 'Discard',
			saved: 'Saved and applied.',
			conflict: 'The host refused this write: the configuration changed elsewhere or a higher layer overrides it. Host values were reloaded.',
			saveFailed: 'Save failed: ',
			readonlyNote: 'Read-only: host configuration cannot be written.',
			unavailableNote: 'Not writable: this configuration is unavailable on the current connection.',
			hubButton: 'Integrated settings',
			hubTitle: 'Better DSH',
			hubEmpty: 'No sub-plugin settings are available yet: the sub-plugin clients have not registered their pages, or this deployment does not compose the settings service.',
			close: 'Close',
			unsavedTitle: 'Unsaved changes',
			unsavedBody: 'Closing discards unsaved settings on all pages.',
			keepEditing: 'Keep editing',
			discardClose: 'Discard and close',
			entryError: 'This settings pane failed to load: ',
			retry: 'Retry',
			pluginBetterDsh: 'Core',
			pluginSubagent: 'Subagents',
			pluginCompact: 'Compaction',
			pluginGoal: 'Goals',
			pluginAskUser: 'Questions',
		};

		function interpolate(text, params) {
			if (params === undefined || params === null) return text;
			return text.replace(/\{(\w+)\}/g, (match, key) => (key in params ? String(params[key]) : match));
		}

		let t = (key, params) => interpolate(zh[key] ?? key, params);

		const STYLE_ID = 'dsh-better-dsh/settings.css';
		const CSS = `
/* UI-KIT v1 — keep in sync with docs/UI-KIT.md. Flat surfaces, 1px lines, one accent. */
.apollo-cfg,.apollo-root,.apollo-hub,.apollo-modal,.apollo-modalCard,.apollo-button[data-apollo-hub=trigger]{--cfg-accent:#3388BB;--cfg-accent-solid:#20709e;--cfg-accent-text:#14587f;--cfg-accent-fg:#fff;--cfg-accent-soft:color-mix(in srgb,var(--cfg-accent) 10%,transparent);--cfg-accent-ink:color-mix(in srgb,var(--cfg-accent) 70%,var(--dsw-alias-label-primary));--cfg-surface:var(--dsw-alias-bg-layer-1);--cfg-raised:var(--dsw-alias-bg-layer-2);--cfg-overlay:var(--dsw-alias-bg-layer-3);--cfg-sunken:color-mix(in srgb,var(--dsw-alias-label-primary) 4%,var(--cfg-surface));--cfg-ink:var(--dsw-alias-label-primary);--cfg-ink-2:var(--dsw-alias-label-secondary);--cfg-ink-3:color-mix(in srgb,var(--dsw-alias-label-tertiary) 80%,var(--dsw-alias-label-primary));--cfg-border:var(--dsw-alias-border-l2,color-mix(in srgb,currentColor 14%,transparent));--cfg-border-strong:var(--dsw-alias-border-l3,color-mix(in srgb,currentColor 22%,transparent));--cfg-line:var(--dsw-alias-border-l1,color-mix(in srgb,currentColor 8%,transparent));--cfg-hover:var(--dsw-alias-interactive-bg-hover,color-mix(in srgb,currentColor 6%,transparent));--cfg-danger:var(--dsw-alias-state-error-primary);--cfg-success:color-mix(in srgb,var(--dsw-alias-state-success-primary) 60%,var(--dsw-alias-label-primary));--cfg-warn:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 60%,var(--dsw-alias-label-primary));--cfg-mono:ui-monospace,SFMono-Regular,Menlo,monospace;--cfg-control:32px;--cfg-radius:8px;--cfg-dur:140ms;font-size:13px;line-height:20px;color:var(--cfg-ink);font-variant-numeric:tabular-nums}
[data-ds-dark-theme] :is(.apollo-cfg,.apollo-root,.apollo-hub,.apollo-modal,.apollo-modalCard,.apollo-button[data-apollo-hub=trigger]){--cfg-accent:#4eb0e8;--cfg-accent-solid:#4eb0e8;--cfg-accent-text:#6fc0ee;--cfg-accent-fg:#0e1014;--cfg-accent-soft:color-mix(in srgb,var(--cfg-accent) 14%,transparent);--cfg-accent-ink:#6fc0ee}
.apollo-cfg{display:flex;flex-direction:column;gap:24px;max-width:920px;width:100%;margin:0 auto;min-width:0}
.apollo-pageHead{display:flex;align-items:center;justify-content:space-between;gap:12px;min-width:0}
.apollo-pageTitle{margin:0;font-size:20px;line-height:28px;font-weight:500;letter-spacing:-.01em;color:var(--cfg-ink)}
.apollo-badge{display:inline-flex;align-items:center;height:20px;padding:0 8px;border:1px solid var(--cfg-border);border-radius:999px;background:var(--cfg-raised);font-size:11px;line-height:18px;color:var(--cfg-ink-3);white-space:nowrap}
.apollo-note{margin:0;padding:8px 10px;border:1px solid var(--cfg-border);border-radius:8px;font-size:12px;line-height:18px;background:var(--cfg-sunken);color:var(--cfg-ink-2)}
.apollo-note[data-tone=error]{border-color:color-mix(in srgb,var(--cfg-danger) 35%,var(--cfg-border));background:color-mix(in srgb,var(--cfg-danger) 8%,var(--cfg-surface));color:var(--cfg-danger)}
.apollo-note[data-tone=warn]{border-color:color-mix(in srgb,var(--cfg-warn) 35%,var(--cfg-border));background:color-mix(in srgb,var(--cfg-warn) 7%,var(--cfg-surface));color:var(--cfg-ink-2)}
.apollo-pulse{animation:apollo-pulse 2s cubic-bezier(.36,0,.64,1) infinite}
@keyframes apollo-pulse{0%{opacity:1}40%{opacity:.6}80%,to{opacity:1}}
.apollo-hint{margin:0;font-size:12px;line-height:18px;color:var(--cfg-ink-3)}
.apollo-mono{font-family:var(--cfg-mono);font-variant-numeric:tabular-nums}
.apollo-card{display:flex;flex-direction:column;gap:12px;min-width:0;padding:16px 0 0;border:0;border-top:1px solid var(--cfg-border);border-radius:0;background:transparent}
.apollo-sectionTitle{margin:0;font-size:12px;line-height:18px;font-weight:500;color:var(--cfg-ink-3)}
.apollo-row{display:flex;align-items:flex-start;justify-content:space-between;gap:24px;padding:10px 0;min-width:0;border-bottom:1px solid var(--cfg-line)}
.apollo-row:last-child{border-bottom:0;padding-bottom:0}
.apollo-rowText{display:flex;flex-direction:column;gap:3px;min-width:0;flex:1}
.apollo-rowTitle{font-size:13px;line-height:20px;font-weight:500;color:var(--cfg-ink);cursor:default}
.apollo-rowDesc{max-width:560px;font-size:12px;line-height:18px;color:var(--cfg-ink-3)}
.apollo-rowLabel{display:flex;align-items:center;gap:6px;min-width:0}
.apollo-help{position:relative;flex:none;font-size:12px}
.apollo-help>button{display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;padding:0;border:0;border-radius:999px;background:transparent;color:var(--cfg-ink-3);cursor:pointer;appearance:none}
.apollo-help>button:hover,.apollo-help>button[aria-expanded=true]{background:var(--cfg-hover);color:var(--cfg-ink)}
.apollo-help>button:focus-visible{outline:2px solid var(--cfg-accent);outline-offset:2px}
.apollo-help>p{position:absolute;left:0;top:26px;z-index:40;width:320px;max-width:min(320px,70vw);margin:0;padding:10px 12px;border:1px solid var(--cfg-border-strong);border-radius:8px;background:var(--cfg-overlay);color:var(--cfg-ink-2);font-size:12px;line-height:18px;font-weight:400;box-shadow:0 12px 32px -16px rgb(0 0 0/.45)}
.apollo-help>p[hidden]{display:none}
.apollo-switch{box-sizing:border-box;position:relative;flex:none;width:34px;height:20px;margin:1px 0 0;padding:2px;border:1px solid var(--cfg-border-strong);border-radius:999px;background:var(--cfg-sunken);cursor:pointer;appearance:none;transition:background var(--cfg-dur) ease,border-color var(--cfg-dur) ease}
.apollo-switch:hover:not(:disabled){border-color:var(--cfg-ink-3)}
.apollo-switch[aria-checked=true]{border-color:var(--cfg-accent);background:var(--cfg-accent-solid)}
.apollo-switch:disabled{opacity:.4;cursor:not-allowed}
.apollo-switchThumb{display:block;width:14px;height:14px;border-radius:50%;background:var(--cfg-ink-3);transition:transform var(--cfg-dur) ease,background var(--cfg-dur) ease}
.apollo-switch[aria-checked=true] .apollo-switchThumb{transform:translateX(14px);background:var(--cfg-accent-fg)}
.apollo-switch:before{content:"";position:absolute;inset:-11px 0 -11px -8px}
.apollo-switch:focus-visible{outline:2px solid var(--cfg-accent);outline-offset:2px}
.apollo-button{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:6px;height:32px;padding:0 12px;border:1px solid transparent;border-radius:8px;font:inherit;font-size:13px;line-height:20px;font-weight:500;color:var(--cfg-ink);background:transparent;cursor:pointer;transition:background var(--cfg-dur) ease,border-color var(--cfg-dur) ease,color var(--cfg-dur) ease}
.apollo-button:disabled{opacity:.4;cursor:not-allowed}
.apollo-button[data-variant=primary]{background:var(--cfg-accent-solid);color:var(--cfg-accent-fg)}
.apollo-button[data-variant=primary]:hover:not(:disabled){background:color-mix(in srgb,var(--cfg-accent-solid) 88%,black)}
.apollo-button[data-variant=outline]{border-color:var(--cfg-border-strong)}
.apollo-button[data-variant=outline]:hover:not(:disabled),.apollo-button[data-variant=ghost]:hover:not(:disabled){background:var(--cfg-hover)}
.apollo-button:focus-visible{outline:2px solid var(--cfg-accent);outline-offset:2px}
.apollo-input{box-sizing:border-box;min-width:0;height:32px;padding:0 10px;border:1px solid var(--cfg-border);border-radius:8px;background:var(--cfg-raised);color:var(--cfg-ink);font:inherit;font-size:13px;line-height:20px}
.apollo-input:hover{border-color:var(--cfg-border-strong)}
.apollo-input:focus{outline:none;border-color:var(--cfg-accent);box-shadow:0 0 0 2px var(--cfg-accent-soft)}
.apollo-input:disabled{opacity:.4;cursor:not-allowed}
.apollo-input[aria-invalid=true]{border-color:var(--cfg-danger)}
.apollo-footer{position:sticky;bottom:0;z-index:10;display:flex;align-items:center;gap:8px;padding:12px 0;border-top:1px solid var(--cfg-border);background:var(--cfg-surface)}
.apollo-status{flex:1;min-width:0;font-size:12px;line-height:18px;color:var(--cfg-ink-3)}
.apollo-status[data-tone=ok]{color:var(--cfg-success)}
.apollo-status[data-tone=error]{color:var(--cfg-danger)}
.apollo-status[data-tone=warn]{color:var(--cfg-warn)}
.apollo-details{min-width:0;border-top:1px solid var(--cfg-border);padding:8px 0 0;font-size:13px;line-height:20px}
.apollo-details>summary{display:flex;align-items:center;gap:8px;list-style:none;cursor:pointer;min-height:32px;padding:4px 0;font-size:13px;line-height:20px;font-weight:500;color:var(--cfg-ink-2)}
.apollo-details>summary::-webkit-details-marker{display:none}
.apollo-details>summary:before{content:"";width:6px;height:6px;flex:none;border-right:1px solid currentColor;border-bottom:1px solid currentColor;transform:rotate(-45deg);transition:transform var(--cfg-dur) ease}
.apollo-details[open]>summary:before{transform:rotate(45deg)}
.apollo-details>summary:hover{color:var(--cfg-ink)}
.apollo-details>summary:focus-visible{outline:2px solid var(--cfg-accent);outline-offset:2px;border-radius:4px}
.apollo-detailsBody{display:flex;flex-direction:column;gap:10px;padding:6px 0 4px;color:var(--cfg-ink-2)}
.apollo-guardFlow{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:0;margin:2px 0 0;padding:14px 12px;border:1px solid var(--cfg-border);border-radius:8px;background:var(--cfg-sunken)}
.apollo-flowStep{position:relative;display:flex;flex-direction:column;align-items:center;gap:6px;min-width:0;text-align:center;color:var(--cfg-ink-2)}
.apollo-flowStep svg{box-sizing:content-box;display:block;padding:6px;border:1px solid var(--cfg-border);border-radius:8px;background:var(--cfg-raised);color:var(--cfg-ink-2)}
.apollo-flowLabel{font-size:12px;line-height:18px;max-width:130px;overflow-wrap:normal;white-space:nowrap;text-overflow:ellipsis;overflow:hidden}
.apollo-flowStep:not(:last-child):after{content:"";position:absolute;left:calc(50% + 24px);top:15px;width:calc(100% - 40px);border-top:1px solid var(--cfg-border)}
.apollo-guardFlow[data-enabled=true] .apollo-flowStep:last-child{color:var(--cfg-accent-text)}
.apollo-guardFlow[data-enabled=true] .apollo-flowStep:last-child svg{border-color:color-mix(in srgb,var(--cfg-accent) 35%,var(--cfg-border));background:var(--cfg-accent-soft);color:var(--cfg-accent-text)}
.apollo-hubGlyph{flex:none;color:var(--cfg-ink-3)}
.apollo-closeConfirm{box-sizing:border-box;display:flex;flex-direction:column;justify-content:center;gap:16px;min-height:280px;width:100%;padding:32px}
.apollo-closeConfirm p{margin:0;color:var(--cfg-ink-2);font-size:13px;line-height:20px}
.apollo-closeActions{display:flex;justify-content:flex-end;gap:8px}
.apollo-modal.apollo-modal{width:min(1240px,calc(100vw - 32px));max-width:calc(100vw - 32px);max-height:calc(100dvh - 32px);padding-bottom:0;border:1px solid var(--cfg-border);border-radius:12px}
.apollo-hubModalContent>:first-child{margin:0;padding:14px 20px;border-bottom:1px solid var(--cfg-border)}
.apollo-hubModalContent>:first-child h2{font-size:15px;line-height:22px;font-weight:500}
.apollo-hubModalContent>:last-child{margin:0;padding:0}
.apollo-hub{display:flex;gap:0;height:min(760px,calc(100dvh - 96px));min-height:320px;width:100%;overflow:hidden}
.apollo-hubNav{box-sizing:border-box;flex:none;width:200px;display:flex;flex-direction:column;gap:2px;padding:12px 8px;border-right:1px solid var(--cfg-border);background:color-mix(in srgb,var(--cfg-ink) 2%,var(--cfg-surface));overflow-y:auto;scrollbar-width:thin}
.apollo-hubNavItem{display:flex;align-items:center;gap:10px;flex-shrink:0;min-height:36px;padding:0 10px;border:1px solid transparent;border-radius:8px;background:transparent;font:inherit;font-size:13px;line-height:20px;text-align:left;cursor:pointer;color:var(--cfg-ink-2);transition:background var(--cfg-dur) ease,color var(--cfg-dur) ease,border-color var(--cfg-dur) ease;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.apollo-hubNavItem:hover{background:var(--cfg-hover);color:var(--cfg-ink)}
.apollo-hubNavItem[data-active]{background:var(--cfg-accent-soft);border-color:color-mix(in srgb,var(--cfg-accent) 25%,var(--cfg-border));color:var(--cfg-accent-ink);font-weight:500}
.apollo-hubNavItem svg{flex:none;opacity:.7}
.apollo-hubNavItem[data-active] svg{opacity:1;color:var(--cfg-accent-ink)}
.apollo-hubNavItem:focus-visible{outline:2px solid var(--cfg-accent);outline-offset:1px}
.apollo-hubContent{flex:1;min-width:0;min-height:0;overflow-y:auto;overscroll-behavior:contain;padding:24px 32px 32px;scrollbar-width:thin;scrollbar-gutter:stable}
.apollo-hubContent .apollo-footer{position:sticky;bottom:-1px;background:var(--cfg-surface);padding-bottom:12px;margin-top:auto}.apollo-hubPane{display:flex;flex-direction:column;min-height:100%}.apollo-hubPane>:first-child{flex:1 0 auto;min-height:0;display:flex;flex-direction:column}.apollo-root{flex:1;min-height:0;display:flex;flex-direction:column}.apollo-cfg{flex:1;min-height:0}.apollo-footer{margin-top:auto}
.apollo-hubModalContent{padding:0!important;overflow:hidden}
.apollo-hubPane{min-width:0;width:100%;overflow-wrap:anywhere}
.apollo-modalBodyWrap{min-width:0;flex:1}
.apollo-modalBodyWrap[hidden],.apollo-hubPane[hidden],.apollo-footer[hidden],.apollo-button[hidden]{display:none}
.apollo-cfg button:active:not(:disabled){filter:brightness(.96)}
.apollo-mask{position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;padding:24px;box-sizing:border-box;background:rgb(0 0 0/.4)}
.apollo-modalCard{display:flex;flex-direction:column;width:min(1240px,100%);max-height:calc(100vh - 64px);box-sizing:border-box;border:1px solid var(--cfg-border);border-radius:12px;background:var(--cfg-surface);box-shadow:0 12px 48px rgb(0 0 0/.22)}
.apollo-modalHead{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px 16px;border-bottom:1px solid var(--cfg-border)}
.apollo-modalTitle{margin:0;font-size:15px;font-weight:500;line-height:22px}
.apollo-modalBody{flex:1;min-height:0;overflow:hidden;display:flex}
.apollo-iconBtn{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border:0;border-radius:6px;background:transparent;color:var(--cfg-ink-3);font-size:16px;line-height:1;cursor:pointer}
.apollo-iconBtn:hover{background:var(--cfg-hover);color:var(--cfg-ink)}
.apollo-iconBtn:focus-visible{outline:2px solid var(--cfg-accent);outline-offset:1px}
@media (max-width:800px){.apollo-help>p{position:static;width:auto;max-width:none;margin-top:6px}.apollo-hub{flex-direction:column;height:min(80dvh,calc(100dvh - 24px))}.apollo-hubNav{width:auto;flex-direction:row;gap:4px;padding:8px;border-right:0;border-bottom:1px solid var(--cfg-border);overflow-x:auto}.apollo-hubNavItem{min-height:44px;flex:none}.apollo-hubContent{padding:20px 16px 24px}.apollo-cfg{gap:24px}.apollo-pageTitle{font-size:18px}.apollo-hubContent .apollo-footer{bottom:0}.apollo-mask{padding:12px}.apollo-modalCard{max-height:calc(100dvh - 24px)}}
@media (max-width:640px){.apollo-row{flex-direction:column;gap:8px}.apollo-row .apollo-switch{align-self:flex-start}.apollo-guardFlow{padding:10px 6px}.apollo-flowLabel{font-size:11px}.apollo-footer{flex-wrap:wrap}.apollo-status{flex-basis:100%}}
@media (pointer:coarse),(max-width:640px){.apollo-iconBtn{width:44px;height:44px}.apollo-button{height:44px}}
@media (prefers-reduced-motion:reduce){.apollo-pulse{animation:none}.apollo-switch,.apollo-switchThumb,.apollo-button,.apollo-hubNavItem,.apollo-help>button{transition:none}}
		`.trim();

		/** 宿主快照只投影当前仍生效的可编辑字段。 */
		function shape(value) {
			const source = typeof value === 'object' && value !== null && !Array.isArray(value) ? value : {};
			return { exitGuard: source.exitGuard === true, declareOwnsHost: source.declareOwnsHost === true };
		}

		function Help({ label, id, children }) {
			const [open, setOpen] = useState(false);
			return h('div', { className: 'apollo-help',
				onBlur: (event) => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); },
				onKeyDown: (event) => {
					if (event.key !== 'Escape' || !open) return;
					event.preventDefault(); event.stopPropagation(); setOpen(false);
				},
			},
				h('button', { type: 'button', 'aria-label': label, title: label, 'aria-expanded': open, 'aria-controls': id, onClick: () => setOpen(!open) },
					h('svg', { width: 14, height: 14, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, 'aria-hidden': true },
						h('circle', { cx: 12, cy: 12, r: 9 }), h('path', { d: 'M9.7 9.2a2.5 2.5 0 1 1 3.4 2.3c-.7.3-1.1.9-1.1 1.7v.3M12 17h.01' }))),
				h('p', { id, hidden: !open, role: 'note' }, children));
		}

		function SwitchRow({ id, label, hint, checked, disabled, onChange }) {
			const hintId = hint === undefined ? undefined : id + '-hint';
			return h('div', { className: 'apollo-row' },
				h('div', { className: 'apollo-rowText' },
					h('div', { className: 'apollo-rowLabel' },
						h('label', { className: 'apollo-rowTitle', htmlFor: id }, label),
						hint === undefined ? null : h(Help, { label, id: hintId }, hint))),
				h('button', {
					type: 'button',
					id,
					className: 'apollo-switch',
					role: 'switch',
					'aria-checked': checked,
					'aria-label': label,
					'aria-describedby': hintId,
					disabled,
					onClick: () => onChange(!checked),
				}, h('span', { className: 'apollo-switchThumb' })));
		}

		/** 行配置页面主体。 */
		function ApolloConfigPage({ form, t: translate }) {
			const state = form?.state;
			const [draft, setDraft] = useState(null);
			const [busy, setBusy] = useState(false);
			const [notice, setNotice] = useState(null);
			useEffect(() => {
				if (notice?.tone !== 'ok') return undefined;
				const timer = setTimeout(() => setNotice(null), 4000);
				return () => clearTimeout(timer);
			}, [notice]);

			if (state === undefined) {
				// 官方页面在镜像读到该命名空间前不传 form：这是正常加载窗口，
				// 长期停在这里才说明本部署缺少 settings/config-editor。
				return h('div', { className: 'apollo-cfg' },
					h('p', { className: 'apollo-note apollo-pulse', role: 'status' }, translate('waitingForm')),
					h('p', { className: 'apollo-hint' }, translate('noFormHint')));
			}
			if (state.status === 'loading') {
				return h('div', { className: 'apollo-cfg' },
					h('p', { className: 'apollo-note apollo-pulse', role: 'status' }, translate('loading')));
			}
			if (state.status !== 'ready') {
				return h('div', { className: 'apollo-cfg' },
					h('p', { className: 'apollo-note', 'data-tone': 'warn' }, translate('unavailable')));
			}
			const host = shape(state.value);
			const live = draft !== null && draft.revision === state.revision ? draft.value : host;
			const writable = state.writable === true && state.mode !== 'memory';
			const dirty = Object.keys(host).some((key) => live[key] !== host[key]);
			const edit = (patch) => { setDraft({ revision: state.revision, value: { ...live, ...patch } }); setNotice(null); };

			const save = async () => {
				if (!dirty || !writable || busy) return;
				setBusy(true);
				setNotice(null);
				try {
					const ops = Object.keys(host).filter((key) => host[key] !== live[key]).map((key) => ({ op: 'set', path: [key], value: live[key] }));
					const accepted = await form.mutate(ops, state.revision);
					if (accepted) setNotice({ tone: 'ok', text: translate(live.declareOwnsHost !== host.declareOwnsHost ? 'savedReload' : 'saved') });
					else {
						setDraft(null);
						setNotice({ tone: 'warn', text: translate('conflict') });
					}
				} catch (error) {
					setNotice({ tone: 'error', text: translate('saveFailed') + String(error?.message ?? error) });
				} finally {
					setBusy(false);
				}
			};
			const reset = () => { setDraft(null); setNotice(null); };

			const status = notice !== null
				? h('span', { className: 'apollo-status', 'data-tone': notice.tone, role: notice.tone === 'error' ? 'alert' : 'status' }, notice.text)
				: h('span', { className: 'apollo-status', role: 'status' }, writable ? '' : translate('readonlyNote'));

			return h('div', { className: 'apollo-cfg', 'data-settings-dirty': dirty, 'data-settings-busy': busy },
				h('div', { className: 'apollo-pageHead' },
					h('h2', { className: 'apollo-pageTitle' }, translate('title'))),
				writable ? null : h('p', { className: 'apollo-note', 'data-tone': 'warn' }, translate('readonlyNote')),
				h('section', { className: 'apollo-card' },
					h('h3', { className: 'apollo-sectionTitle' }, translate('guardTitle')),
					h(SwitchRow, {
						id: 'apollo-exit-guard',
						label: translate('exitGuardLabel'),
						hint: translate('exitGuardHint'),
						checked: live.exitGuard,
						disabled: !writable || busy,
						onChange: (next) => edit({ exitGuard: next }),
					}),
					h('div', { className: 'apollo-guardFlow', 'aria-hidden': 'true', 'data-enabled': live.exitGuard },
						['guardEnd', 'guardJobs', live.exitGuard ? 'guardContinue' : 'guardAllow'].map((key, index) => h('div', { key, className: 'apollo-flowStep' },
							h('svg', { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round' },
								h('path', { d: ['M5 12h14m-6-6 6 6-6 6', 'M4 5h16v14H4ZM8 9l3 3-3 3m6 0h3', live.exitGuard ? 'M12 8v4l3 2M5 4 2 7m20 0-3-3M12 4a8 8 0 1 0 8 8' : 'M5 12l4 4L19 6'][index] })),
							h('span', { className: 'apollo-flowLabel' }, translate(key)))))),
				h('section', { className: 'apollo-card' },
					h('h3', { className: 'apollo-sectionTitle' }, translate('connectionTitle')),
					h(SwitchRow, {
						id: 'apollo-owns-host',
						label: translate('ownsHostLabel'),
						hint: translate('ownsHostHint') + ' ' + translate('ownsHostReload'),
						checked: live.declareOwnsHost,
						disabled: !writable || busy,
						onChange: (next) => edit({ declareOwnsHost: next }),
					})),
				h('details', { className: 'apollo-details' },
					h('summary', null, translate('compatTitle')),
					h('div', { className: 'apollo-detailsBody' },
						h('p', { className: 'apollo-hint' }, translate('migratedBody')),
						h('p', { className: 'apollo-hint' }, translate('deprecatedBody')),
						h('p', { className: 'apollo-hint' }, translate('reloadBody')))),
				h('div', { className: 'apollo-footer', hidden: !dirty && !busy && notice === null },
					status,
					h('button', {
						type: 'button', className: 'apollo-button', 'data-variant': 'ghost',
						hidden: !dirty && !busy, disabled: busy || !dirty, onClick: reset,
					}, translate('reset')),
					h('button', {
						type: 'button', className: 'apollo-button', 'data-variant': 'primary',
						hidden: !dirty && !busy, 'aria-busy': busy, disabled: !writable || busy || !dirty, onClick: () => void save(),
					}, busy ? translate('saving') : translate('save'))));
		}

		/**
		 * 行配置入口：`summary` 只回一行描述；`page` 渲染样式表 + 表单主体。
		 * 样式随组件树内的 <style> 挂载一次（不写 DOM，重复渲染不重复注入）。
		 */
		function ApolloPanel(props) {
			if (props.view === 'summary') return h('span', null, (props.t ?? t)('summary'));
			return h('div', { className: 'apollo-root' },
				h('style', { 'data-plugin-css': STYLE_ID }, CSS),
				h(ApolloConfigPage, { form: props.form, t: props.t ?? t }));
		}

		// ── 集成设置弹窗 ─────────────────────────────────────────────────

		function gearGlyph() {
			return h('svg', { width: 13, height: 13, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true', className: 'apollo-hubGlyph' },
				h('path', {
					d: 'M8 10.4a2.4 2.4 0 1 0 0-4.8 2.4 2.4 0 0 0 0 4.8Z',
					stroke: 'currentColor', strokeWidth: 1.4,
				}),
				h('path', {
					d: 'M13.3 8c0-.4-.1-.8-.2-1.2l1.1-.9-1.2-2-1.3.5c-.6-.5-1.2-.8-1.9-1L9.3 1.7H6.7l-.5 1.7c-.7.2-1.3.5-1.9 1l-1.3-.5-1.2 2 1.1.9a4.9 4.9 0 0 0 0 2.4l-1.1.9 1.2 2 1.3-.5c.6.5 1.2.8 1.9 1l.5 1.7h2.6l.5-1.7c.7-.2 1.3-.5 1.9-1l1.3.5 1.2-2-1.1-.9c.1-.4.2-.8.2-1.2Z',
					stroke: 'currentColor', strokeWidth: 1.2, strokeLinejoin: 'round',
				}));
		}

		/**
		 * 按 HUB_ROWS 顺序收集已注册的子插件设置组件：entry.options.key 以
		 * `#<rowId>` 结尾即归该行；同 rowId 多个键（独立/Apollo 两种装配）内容
		 * 相同，优先取 Apollo bundle 键。
		 */
		function collectPluginEntries(ctx) {
			const read = typeof ctx.slots.entriesOfSlot === 'function'
				? () => ctx.slots.entriesOfSlot(ROW_CONFIG_SLOT)
				: () => (typeof ctx.slots.entries === 'function' ? ctx.slots.entries(ROW_CONFIG_SLOT) : []);
			let entries = [];
			try {
				entries = read() ?? [];
			} catch {
				entries = [];
			}
			const found = new Map();
			for (const row of HUB_ROWS) {
				const suffix = '#' + row.rowId;
				for (const entry of entries) {
					const key = entry?.options?.key;
					if (typeof key !== 'string' || !key.endsWith(suffix) || entry.component === undefined || entry.component === null) continue;
					const score = key.startsWith(PACKAGE_NAME + '#') ? 0 : 1;
					const prev = found.get(row.rowId);
					if (prev === undefined || score < prev.score) found.set(row.rowId, { entry, score });
				}
			}
			const items = [];
			for (const row of HUB_ROWS) {
				const hit = found.get(row.rowId);
				if (hit !== undefined) items.push({ ...row, entry: hit.entry });
			}
			return items;
		}

		/** describe 只通知命名空间变化；值与 revision 必须订阅对应的共享表单。 */
		function HubPane({ ctx, mirror, item }) {
			const namespaces = mirror?.view?.namespaces;
			const available = Array.isArray(namespaces) && namespaces.some((view) => view?.ns === item.rowId);
			const controller = useMemo(() => available ? ctx.configForms.get(item.rowId) : undefined, [ctx, available, item.rowId]);
			const subscribe = useCallback((listener) => controller?.subscribe(listener) ?? (() => {}), [controller]);
			const snapshot = useCallback(() => controller?.getSnapshot(), [controller]);
			const state = useSyncExternalStore(subscribe, snapshot);
			const form = useMemo(() => controller === undefined ? undefined : { state, mutate: (ops, revision) => controller.mutate(ops, revision) }, [controller, state]);
			return h(item.entry.component, { view: 'page', form, t: boundT(ctx, item.entry) });
		}

		/** entry 声明的 locale 命名空间 → t；没有则给 undefined（组件自带兜底）。 */
		function boundT(ctx, entry) {
			if (typeof entry?.locale !== 'string' || entry.locale === '') return undefined;
			try {
				return typeof ctx.locale?.bind === 'function' ? ctx.locale.bind(entry.locale) : undefined;
			} catch {
				return undefined;
			}
		}

		function subscribeSlot(ctx, listener) {
			try {
				return typeof ctx.slots.subscribe === 'function' ? ctx.slots.subscribe(ROW_CONFIG_SLOT, listener) : () => {};
			} catch {
				return () => {};
			}
		}

		function slotVersion(ctx) {
			try {
				return typeof ctx.slots.getVersion === 'function' ? ctx.slots.getVersion(ROW_CONFIG_SLOT) : 0;
			} catch {
				return 0;
			}
		}

		/** 单个设置面板崩溃不炸掉整个弹窗。 */
		class EntryBoundary extends React.Component {
			constructor(props) {
				super(props);
				this.state = { error: null };
			}
			static getDerivedStateFromError(error) {
				return { error };
			}
			render() {
				if (this.state.error !== null) {
					return h('div', { className: 'apollo-note', 'data-tone': 'error', role: 'alert' },
						h('p', null, t('entryError') + String(this.state.error?.message ?? this.state.error)),
						h('button', { type: 'button', className: 'apollo-button', 'data-variant': 'outline', onClick: () => this.setState({ error: null }) }, t('retry')));
				}
				return this.props.children;
			}
		}

		/** 弹窗主体：左 nav + 右面板（全部挂载，hidden 保住未存草稿）。 */
		function HubBody({ ctx }) {
			const version = useSyncExternalStore((listener) => subscribeSlot(ctx, listener), () => slotVersion(ctx));
			const items = useMemo(() => collectPluginEntries(ctx), [ctx, version]);
			const describe = ctx.configForms.describe();
			const mirror = useSyncExternalStore(
				(listener) => (typeof describe?.subscribe === 'function' ? describe.subscribe(listener) : () => {}),
				() => describe?.getSnapshot?.());
			useEffect(() => { void describe?.ensure?.(); }, [describe]);
			const [active, setActive] = useState(() => {
				const search = globalThis['window']?.location?.search;
				return search ? new URLSearchParams(search).get('apolloTab') : null;
			});
			const tabRefs = useRef({});
			const prefix = 'apollo-hub-' + useId().replace(/[^a-zA-Z0-9_-]/g, '');
			const contentRef = useRef(null);
			const current = items.find((item) => item.rowId === active) ?? items[0];
			// 布局断点（与 CSS @media 800px 一致）驱动 aria-orientation。
			const [narrow, setNarrow] = useState(() => {
				return globalThis['window']?.matchMedia?.('(max-width:800px)').matches ?? false;
			});
			useEffect(() => {
				const query = globalThis['window']?.matchMedia?.('(max-width:800px)');
				if (query === undefined) return undefined;
				setNarrow(query.matches);
				const onChange = (event) => setNarrow(event.matches);
				if (typeof query.addEventListener === 'function') {
					query.addEventListener('change', onChange);
					return () => query.removeEventListener('change', onChange);
				}
				if (typeof query.addListener === 'function') {
					query.addListener(onChange);
					return () => query.removeListener(onChange);
				}
				return undefined;
			}, []);

			if (items.length === 0) {
				return h('p', { className: 'apollo-note', role: 'status' }, t('hubEmpty'));
			}

			const focusTab = (rowId) => {
				const node = tabRefs.current[rowId];
				if (node !== null && node !== undefined && typeof node.focus === 'function') {
					node.focus();
				}
			};
			const select = (rowId, moveFocus) => {
				if (rowId !== current.rowId) contentRef.current?.scrollTo?.({ top: 0 });
				setActive(rowId);
				const win = globalThis['window'];
				if (win?.location && win.history?.replaceState) {
					const url = new URL(win.location.href);
					url.searchParams.set('apolloTab', rowId);
					win.history.replaceState(win.history.state, '', url);
				}
				if (moveFocus === true) focusTab(rowId);
				tabRefs.current[rowId]?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
			};
			// 方向键漫游：上下为主，窄屏横排时左右同义；Home/End 跳到两端。
			const onTabListKeyDown = (event) => {
				if (event.defaultPrevented || event.repeat) return;
				const count = items.length;
				const at = Math.max(0, items.indexOf(current));
				let next = null;
				if (event.key === 'ArrowDown' || event.key === 'ArrowRight') next = items[(at + 1) % count].rowId;
				else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') next = items[(at - 1 + count) % count].rowId;
				else if (event.key === 'Home') next = items[0].rowId;
				else if (event.key === 'End') next = items[count - 1].rowId;
				if (next === null) return;
				event.preventDefault();
				select(next, true);
			};

			return h('div', { className: 'apollo-hub' },
				h('div', { className: 'apollo-hubNav', role: 'tablist', 'aria-label': t('hubTitle'), 'aria-orientation': narrow ? 'horizontal' : 'vertical', onKeyDown: onTabListKeyDown },
					items.map((item) => h('button', {
						key: item.rowId,
						type: 'button',
						role: 'tab',
						id: prefix + '-tab-' + item.rowId,
						'aria-controls': prefix + '-panel-' + item.rowId,
						className: 'apollo-hubNavItem',
						'data-active': item === current ? true : undefined,
						'aria-selected': item === current,
						tabIndex: item === current ? 0 : -1,
						ref: (node) => { tabRefs.current[item.rowId] = node; },
						onClick: () => select(item.rowId, false),
					}, h('svg', { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true }, h('path', { d: item.icon })), h('span', null, t(item.titleKey))))),
				h('div', { className: 'apollo-hubContent', ref: contentRef },
					items.map((item) => h('div', {
						key: item.rowId,
						className: 'apollo-hubPane',
						role: 'tabpanel',
						id: prefix + '-panel-' + item.rowId,
						'aria-labelledby': prefix + '-tab-' + item.rowId,
						hidden: item !== current,
					},
						h(EntryBoundary, null, h(HubPane, { ctx, mirror, item }))))));
		}

		const FOCUSABLE = 'button,[href],input,select,textarea,summary,[tabindex]';
		function focusableIn(card) {
			const doc = globalThis['document'];
			const view = doc?.defaultView;
			return Array.prototype.slice.call(card.querySelectorAll(FOCUSABLE)).filter((node) => {
				if (node.disabled === true || node.tabIndex < 0 || node.type === 'hidden') return false;
				if (node.closest('[hidden],[inert]') !== null) return false;
				for (let parent = node.parentElement; parent !== null && parent !== card; parent = parent.parentElement) {
					if (parent.tagName !== 'DETAILS' || parent.open) continue;
					const summary = Array.from(parent.children).find((child) => child.tagName === 'SUMMARY');
					if (summary === undefined || !summary.contains(node)) return false;
				}
				if (typeof node.getClientRects === 'function' && node.getClientRects().length === 0) return false;
				const style = view !== undefined && view !== null && typeof view.getComputedStyle === 'function' ? view.getComputedStyle(node) : undefined;
				if (style !== undefined && (style.visibility === 'hidden' || style.visibility === 'collapse' || style.display === 'none')) return false;
				return true;
			});
		}

		/**
		 * 自绘弹窗兜底：fixed mask + card，Esc/遮罩点击关闭（不依赖 ui-primitives）。
		 * a11y：aria-modal + 标题 labelledby，挂载时把焦点收进卡片、Tab 在卡内
		 * 循环、卸载时把焦点还给打开前的元素；DOM 只在 effects/事件里读写。
		 */
		function FallbackModal({ onClose, children, title = t('hubTitle') }) {
			const cardRef = useRef(null);
			const restoreRef = useRef(null);
			const titleId = 'apollo-modal-' + useId().replace(/[^a-zA-Z0-9_-]/g, '');
			const closeRef = useRef(onClose);
			closeRef.current = onClose;
			useEffect(() => {
				const doc = globalThis['document'];
				if (doc === undefined || doc === null) return undefined;
				restoreRef.current = doc.activeElement ?? null;
				const card = cardRef.current;
				const focusables = () => (card === null ? [] : focusableIn(card));
				const first = focusables()[0];
				if (first !== undefined && typeof first.focus === 'function') first.focus();
				else if (card !== null && typeof card.focus === 'function') card.focus();
				const onKey = (event) => { if (event.key === 'Escape' && !event.defaultPrevented) closeRef.current(); };
				doc.addEventListener('keydown', onKey);
				return () => {
					doc.removeEventListener('keydown', onKey);
					const back = restoreRef.current;
					restoreRef.current = null;
					if (back !== null && doc.contains(back) && typeof back.focus === 'function') back.focus();
				};
			}, []);
			const onKeyDown = (event) => {
				if (event.key === 'Escape') {
					event.stopPropagation();
					closeRef.current();
					return;
				}
				if (event.key !== 'Tab') return;
				const card = cardRef.current;
				if (card === null || typeof card.querySelectorAll !== 'function') return;
				const items = focusableIn(card);
				if (items.length === 0) {
					event.preventDefault();
					card.focus();
					return;
				}
				const active = globalThis['document']?.activeElement;
				const first = items[0];
				const last = items[items.length - 1];
				if (event.shiftKey) {
					if (active === first || !(typeof card.contains === 'function' && card.contains(active))) {
						event.preventDefault();
						last.focus();
					}
				} else if (active === last || !(typeof card.contains === 'function' && card.contains(active))) {
					event.preventDefault();
					first.focus();
				}
			};
			return h('div', {
				className: 'apollo-mask',
				role: 'presentation',
				onClick: (event) => { if (event.target === event.currentTarget) onClose(); },
			},
				h('div', {
					className: 'apollo-modalCard',
					role: 'dialog',
					'aria-modal': 'true',
					'aria-labelledby': titleId,
					tabIndex: -1,
					ref: cardRef,
					onKeyDown,
				},
					h('div', { className: 'apollo-modalHead' },
						h('h2', { className: 'apollo-modalTitle', id: titleId }, title),
						h('button', { type: 'button', className: 'apollo-iconBtn', 'aria-label': t('close'), onClick: onClose }, '×')),
					h('div', { className: 'apollo-modalBody' }, children)));
		}

		function SettingsModal({ ctx, onClose }) {
			const bodyRef = useRef(null);
			const keepRef = useRef(null);
			const returnRef = useRef(null);
			const [confirm, setConfirm] = useState(false);
			useEffect(() => {
				if (confirm) keepRef.current?.focus();
				else if (returnRef.current?.isConnected) returnRef.current.focus();
			}, [confirm]);
			const requestClose = () => {
				if (confirm) { setConfirm(false); return; }
				if (bodyRef.current?.querySelector('[data-settings-busy=true]')) return;
				if (bodyRef.current?.querySelector('[data-settings-dirty=true]')) {
					returnRef.current = globalThis['document']?.activeElement;
					setConfirm(true);
				} else onClose();
			};
			const body = h(React.Fragment, null,
				h('div', { className: 'apollo-modalBodyWrap', ref: bodyRef, hidden: confirm }, h(HubBody, { ctx })),
				confirm ? h('div', { className: 'apollo-closeConfirm' },
					h('p', null, t('unsavedBody')),
					h('div', { className: 'apollo-closeActions' },
						h('button', { type: 'button', className: 'apollo-button', 'data-variant': 'outline', ref: keepRef, onClick: () => setConfirm(false) }, t('keepEditing')),
						h('button', { type: 'button', className: 'apollo-button', 'data-variant': 'primary', onClick: onClose }, t('discardClose')))) : null);
			const title = t(confirm ? 'unsavedTitle' : 'hubTitle');
			if (Modal === null) return h(FallbackModal, { onClose: requestClose, title }, body);
			return h(Modal, {
				open: true,
				onClose: requestClose,
				title,
				closeLabel: t('close'),
				className: 'apollo-modal',
				contentClassName: 'apollo-hubModalContent',
			}, body);
		}

		/** `plugins.detail.actions` 入口：仅 Apollo bundle 详情页渲染触发按钮。 */
		function HubEntry(props) {
			const subject = props.subject;
			const isApolloBundle = subject?.kind === 'bundle'
				&& (subject.pkg?.name === PACKAGE_NAME || subject.pkg?.name === LEGACY_SCOPED_PACKAGE_NAME || subject.pkg?.name === LEGACY_PACKAGE_NAME);
			const [open, setOpen] = useState(false);
			const close = useCallback(() => setOpen(false), []);
			if (!isApolloBundle) return null;
			return h(React.Fragment, null,
				h('style', { 'data-plugin-css': STYLE_ID + ':hub' }, CSS),
				h('button', {
					type: 'button',
					className: 'apollo-button',
					'data-variant': 'outline',
					'data-apollo-hub': 'trigger',
					'aria-haspopup': 'dialog',
					'aria-expanded': open,
					onClick: () => setOpen(true),
				}, gearGlyph(), (props.t ?? t)('hubButton')),
				open ? h(SettingsModal, { ctx: props.ctx, onClose: close }) : null);
		}

		const inject = ['slots', 'locale'];

		function apply(ctx) {
			try {
				const dispose = ctx.locale.register(NS, { zh, en });
				t = ctx.locale.bind(NS);
				ctx.effect(() => dispose, 'dsh-better-dsh: dictionaries');
			} catch {
				// locale 服务缺失时保持中文默认。
			}
			ctx.effect(() => ctx.slots.inject(ROW_CONFIG_SLOT, () => {
				const disposers = [];
				for (const key of ROW_KEYS) {
					try {
						const dispose = ctx.slots.register({
							name: ROW_CONFIG_SLOT,
							key,
							locale: NS,
						}, ApolloPanel);
						if (typeof dispose === 'function') disposers.push(dispose);
					} catch {
						// 一个键被槽账本拒绝时，另一个键仍应注册。
					}
				}
				return () => {
					for (const dispose of disposers) dispose();
				};
			}), 'dsh-better-dsh: row config page');

			// 集成设置弹窗依赖 configForms（读取各子插件命名空间的共享表单）；
			// 服务缺失时仅弹窗缺席，行配置页照常工作。
			try {
				ctx.inject(['configForms'], (sctx) => {
					const register = () => sctx.slots.inject(DETAIL_ACTIONS_SLOT, () =>
						sctx.slots.register({
							name: DETAIL_ACTIONS_SLOT,
							id: HUB_ENTRY_ID,
							order: 0,
							locale: NS,
						}, (props) => h(HubEntry, { ctx: sctx, subject: props.subject, t: props.t ?? t })));
					if (typeof sctx.effect === 'function') {
						sctx.effect(register, 'dsh-better-dsh: settings hub');
						return undefined;
					}
					return register();
				});
			} catch {
				// 无 configForms 的组合：集成弹窗不注册。
			}
		}

		exports.inject = inject;
		exports.apply = apply;
		return module.exports;
	},
});
