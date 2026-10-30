/**
 * dsh-apollo (npm: @menghuan1918/dsh-apollo) — 浏览器半边。
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
	id: '@menghuan1918/dsh-apollo',
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
		const PACKAGE_NAME = '@menghuan1918/dsh-apollo';
		const LEGACY_PACKAGE_NAME = 'dsh-apollo';
		// 新键是 Plugins 页按“bundle 依赖名 + 行 id”算出的（= npm 包名 + #apollo-skills）；
		// 旧键并排注册，只为仍把依赖槽记成旧 unscoped 名的 profile 保留配置入口。
		const ROW_KEYS = ['@menghuan1918/dsh-apollo#apollo-skills', 'dsh-apollo#apollo-skills'];
		const DETAIL_ACTIONS_SLOT = 'plugins.detail.actions';
		const ROW_CONFIG_SLOT = 'plugins.row.config';
		const HUB_ENTRY_ID = 'apollo-settings-hub';

		/** 聚合弹窗展示的设置命名空间（= 行 id），按 nav 顺序排列。 */
		const HUB_ROWS = [
			{ rowId: 'apollo-skills', icon: 'M4 5h16M4 12h16M4 19h16M8 3v4m8 3v4M10 17v4', titleKey: 'pluginApollo' },
			{ rowId: 'dsh-better-subagent', icon: 'M8 7V4h8v3M6 17H3v-6h6v6H6Zm12 0h-3v-6h6v6h-3ZM6 11V8h12v3M6 17v3m12-3v3', titleKey: 'pluginSubagent' },
			{ rowId: 'dsh-better-compact', icon: 'M4 4h16v16H4ZM8 9l4 4 4-4M12 6v7M8 17h8', titleKey: 'pluginCompact' },
			{ rowId: 'dsh-better-goal', icon: 'M12 8a4 4 0 1 0 4 4M12 3a9 9 0 1 0 9 9M12 12l8-8m-4 0h4v4', titleKey: 'pluginGoal' },
			{ rowId: 'dsh-better-ask-user', icon: 'M21 11a8 8 0 0 1-8 8H8l-5 3V11a8 8 0 0 1 8-8h2a8 8 0 0 1 8 8ZM9 9a3 3 0 0 1 6 0c0 2-3 2-3 4m0 3h.01', titleKey: 'pluginAskUser' },
		];

		const zh = {
			summary: '后台任务退出守卫与兼容性说明',
			title: '通用',
			connectionTitle: '连接与访问',
			ownsHostLabel: '将反代页面声明为可信宿主',
			ownsHostHint: '仅在你控制访问权限的可信反向代理后启用。这会允许该页面写入宿主设置；不改变子代理 API 的可信地址列表。',
			ownsHostReload: '保存后需重载 profile 并刷新页面。',
			savedReload: '已保存；重载 profile 并刷新页面后生效。',
			guardEnd: '回合结束',
			guardJobs: '后台任务',
			guardContinue: '有任务则继续',
			guardAllow: '允许结束',
			compatTitle: '兼容性',
			migratedBody: 'CLI 子代理、wait_subagent、运行中子代理守卫、模型分档与子代理设置页由 @menghuan1918/dsh-better-subagent 拥有；压缩模式与预算由 dsh-better-compact 拥有。请到 Plugins 中对应的行配置，或使用包详情页的集成设置弹窗。',
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
			hubTitle: 'Apollo',
			hubEmpty: '暂无可用的子插件设置：子插件客户端尚未注册设置页，或本部署未组合设置服务。',
			close: '关闭',
			entryError: '此设置区加载失败：',
			pluginApollo: '通用',
			pluginSubagent: '子代理',
			pluginCompact: '上下文压缩',
			pluginGoal: '目标',
			pluginAskUser: '提问',
		};

		const en = {
			summary: 'Background-job exit guard and compatibility notes',
			title: 'General',
			connectionTitle: 'Connection and access',
			ownsHostLabel: 'Trust this reverse-proxied page as the host',
			ownsHostHint: 'Enable only behind a trusted proxy whose access you control. This allows the page to write host settings; it does not change the subagent API’s trusted authorities.',
			ownsHostReload: 'Save, then reload the profile and refresh the page.',
			savedReload: 'Saved. Reload the profile and refresh the page to apply.',
			guardEnd: 'Turn ends',
			guardJobs: 'Background jobs',
			guardContinue: 'Continue if running',
			guardAllow: 'Allow completion',
			compatTitle: 'Compatibility',
			migratedBody: 'CLI subagents, wait_subagent, the running-child guard, model tiers and the subagent settings page are owned by @menghuan1918/dsh-better-subagent; compaction modes and budgets are owned by dsh-better-compact. Configure their rows under Plugins, or use the integrated settings dialog on the package page.',
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
			hubTitle: 'Apollo',
			hubEmpty: 'No sub-plugin settings are available yet: the sub-plugin clients have not registered their pages, or this deployment does not compose the settings service.',
			close: 'Close',
			entryError: 'This settings pane failed to load: ',
			pluginApollo: 'General',
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

		const STYLE_ID = '@menghuan1918/dsh-apollo/settings.css';
		const CSS = [
			/* Apollo accent is scoped to these settings; host surfaces follow the active theme. */
			'.apollo-cfg,.apollo-root,.apollo-hub,.apollo-modal,.apollo-modalCard,.apollo-button[data-apollo-hub=trigger]{--cfg-accent:#3388BB;--cfg-accent-fill:color-mix(in srgb,var(--cfg-accent) 85%,black);--cfg-accent-hover:color-mix(in srgb,var(--cfg-accent) 72%,black);--cfg-accent-fg:#fff;--cfg-accent-ink:color-mix(in srgb,var(--cfg-accent) 72%,var(--dsw-alias-label-primary));--cfg-accent-soft:color-mix(in srgb,var(--cfg-accent) 9%,transparent);--cfg-border:var(--dsw-alias-border-l2,color-mix(in srgb, currentColor 14%, transparent));--cfg-border-strong:var(--dsw-alias-border-l3,color-mix(in srgb, currentColor 22%, transparent));--cfg-surface:var(--dsw-alias-bg-layer-1,transparent);--cfg-surface-2:var(--dsw-alias-bg-layer-3,color-mix(in srgb, currentColor 4%, transparent));--cfg-ink:var(--dsw-alias-label-primary,currentColor);--cfg-ink-2:var(--dsw-alias-label-secondary,color-mix(in srgb, currentColor 74%, transparent));--cfg-ink-3:var(--dsw-alias-label-tertiary,color-mix(in srgb, currentColor 56%, transparent));--cfg-hover:var(--dsw-alias-interactive-bg-hover,color-mix(in srgb, currentColor 6%, transparent));--cfg-mono:var(--dsw-font-mono,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:14px;line-height:22px;color:var(--cfg-ink)}',
			'.apollo-cfg{display:flex;flex-direction:column;gap:24px;max-width:960px;min-width:0}',
			'.apollo-pageTitle{margin:0;font-size:18px;font-weight:500;line-height:26px;color:var(--cfg-ink)}',
			'.apollo-note{margin:0;padding:8px 10px;border-radius:6px;font-size:12px;line-height:17px;background:var(--cfg-surface-2);color:var(--cfg-ink-2)}',
			'.apollo-note[data-tone=error]{background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, transparent);color:var(--dsw-alias-state-error-primary)}',
			'.apollo-note[data-tone=warn]{background:var(--dsw-alias-state-warn-tertiary)}',
			'.apollo-pulse{animation:apollo-pulse 2s cubic-bezier(.36,0,.64,1) infinite}',
			'@keyframes apollo-pulse{0%{opacity:1}40%{opacity:.6}80%,to{opacity:1}}',
			'.apollo-hint{margin:0;font-size:12px;line-height:17px;color:var(--cfg-ink-3)}',
			'.apollo-mono{font-family:var(--cfg-mono);font-variant-numeric:tabular-nums}',
			/* 兼容性等技术细节收进默认折叠的 details。 */
			'.apollo-details{min-width:0;border-bottom:1px solid var(--cfg-border);padding:0 0 8px;font-size:13px;line-height:20px}',
			'.apollo-details:last-of-type{border-bottom:0}.apollo-details>summary{display:flex;align-items:center;gap:10px;list-style:none;cursor:pointer;padding:10px 0;font-size:14px;line-height:22px;font-weight:500;color:var(--cfg-ink-2)}.apollo-details>summary::-webkit-details-marker{display:none}.apollo-details>summary:before{content:"";width:6px;height:6px;flex:none;border-right:1.5px solid currentColor;border-bottom:1.5px solid currentColor;transform:rotate(-45deg);transition:transform 160ms ease}.apollo-details[open]>summary:before{transform:rotate(45deg)}.apollo-details>summary:hover{color:var(--cfg-ink)}',
			'.apollo-details>summary:focus-visible{outline:2px solid var(--cfg-accent);outline-offset:2px;border-radius:4px}',
			'.apollo-detailsBody{display:flex;flex-direction:column;gap:12px;padding:8px 0 16px;color:var(--cfg-ink-2)}',
			/* 设置行：标签/提示居左，控件居右。 */
			'.apollo-row{display:flex;align-items:flex-start;justify-content:space-between;gap:24px;padding:12px 0}',
			'.apollo-rowText{display:flex;flex-direction:column;gap:4px;min-width:0;flex:1}',
			'.apollo-rowTitle{font-size:14px;line-height:22px;font-weight:500;color:var(--cfg-ink)}',
			'.apollo-rowDesc{max-width:560px;font-size:13px;line-height:20px;color:var(--cfg-ink-3)}',
			/* Switch：36x20 track，accent 实心 + 白点滑动。 */
			'.apollo-switch{box-sizing:border-box;position:relative;flex:none;width:36px;height:20px;margin:2px 0 0;padding:2px;border:1px solid var(--cfg-border-strong);border-radius:10px;background:var(--cfg-surface-2);cursor:pointer;appearance:none;transition:background 140ms ease,border-color 140ms ease}',
			'.apollo-switch:hover:not(:disabled){border-color:var(--cfg-ink-3)}',
			'.apollo-switch[aria-checked=true]{border-color:var(--cfg-accent);background:var(--cfg-accent)}',
			'.apollo-switch:disabled{opacity:.4;cursor:not-allowed}',
			'.apollo-switchThumb{display:block;width:14px;height:14px;border-radius:50%;background:var(--cfg-ink-3);transition:transform 140ms ease,background 140ms ease}',
			'.apollo-switch[aria-checked=true] .apollo-switchThumb{transform:translateX(16px);background:var(--cfg-accent-fg)}',
			'.apollo-switch:before{content:"";position:absolute;inset:-11px 0 -11px -8px}',
			'.apollo-switch:focus-visible{outline:2px solid var(--cfg-accent);outline-offset:2px}',
			/* 按钮：primary=accent 实心；outline=1px 边；hover 走中性填充。 */
			'.apollo-button{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:6px;height:32px;padding:0 12px;border:.5px solid transparent;border-radius:6px;font:inherit;font-size:13px;line-height:20px;font-weight:500;color:var(--cfg-ink);background:transparent;cursor:pointer;transition:background 140ms ease,border-color 140ms ease,color 140ms ease}',
			'.apollo-button:disabled{opacity:.4;cursor:not-allowed}',
			'.apollo-button[data-variant=primary]{background:var(--cfg-accent-fill);color:var(--cfg-accent-fg)}',
			'.apollo-button[data-variant=primary]:hover:not(:disabled){background:var(--cfg-accent-hover)}',
			'.apollo-button[data-variant=outline]{border-color:var(--cfg-border-strong)}',
			'.apollo-button[data-variant=outline]:hover:not(:disabled),.apollo-button[data-variant=ghost]:hover:not(:disabled){background:var(--cfg-hover)}',
			'.apollo-button:focus-visible{outline:2px solid var(--cfg-accent);outline-offset:2px}',
			'.apollo-input,.apollo-select{box-sizing:border-box;min-width:0;height:30px;padding:0 10px;border:1px solid var(--cfg-border);border-radius:6px;background:var(--cfg-surface-2);color:var(--cfg-ink);font:inherit;font-size:13px;line-height:20px}',
			'.apollo-input:hover,.apollo-select:hover{border-color:var(--cfg-ink-3)}',
			'.apollo-input:focus,.apollo-select:focus{outline:none;border-color:var(--cfg-accent)}',
			'.apollo-input:focus-visible,.apollo-select:focus-visible{outline:2px solid var(--cfg-accent);outline-offset:1px}',
			'.apollo-input:disabled,.apollo-select:disabled{opacity:.4;cursor:not-allowed}',
			'.apollo-input[aria-invalid=true]{border-color:var(--dsw-alias-state-error-primary)}',
			'.apollo-select{appearance:none;padding-right:26px;background-image:url("data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' width=\'10\' height=\'6\' viewBox=\'0 0 10 6\'%3E%3Cpath d=\'M1 1l4 4 4-4\' stroke=\'%23999\' stroke-width=\'1.5\' fill=\'none\' stroke-linecap=\'round\'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right 9px center}',
			'.apollo-footer{display:flex;align-items:center;gap:8px;padding-top:20px;margin-top:4px;border-top:1px solid var(--cfg-border)}',
			'.apollo-status{flex:1;min-width:0;font-size:12px;line-height:18px;color:var(--cfg-ink-3)}',
			'.apollo-status[data-tone=ok]{color:var(--dsw-alias-state-success-primary)}',
			'.apollo-status[data-tone=error]{color:var(--dsw-alias-state-error-primary)}',
			'.apollo-status[data-tone=warn]{color:var(--dsw-alias-state-warn-label,var(--cfg-ink-2))}',
			/* ── 集成设置弹窗：中性侧栏 + 独立滚动内容区。 */
			'.apollo-hubGlyph{flex:none;color:var(--cfg-ink-3)}',
			/* ui-primitives Modal 加宽（双类提升优先级，同 better-sidebar 做法）。 */
			'.apollo-modal.apollo-modal{width:min(1040px,calc(100vw - 32px));max-width:calc(100vw - 32px);max-height:calc(100dvh - 32px);padding-bottom:0;border:1px solid var(--cfg-border);border-radius:12px}.apollo-hubModalContent>:first-child{margin:0;padding:16px 20px;border-bottom:1px solid var(--cfg-border)}.apollo-hubModalContent>:first-child h2{font-size:16px;line-height:24px;font-weight:500}.apollo-hubModalContent>:last-child{margin:0;padding:0}',
			'.apollo-hub{display:flex;gap:0;height:min(680px,76dvh);min-height:280px;width:100%;overflow:hidden}',
			'.apollo-hubNav{box-sizing:border-box;flex:none;width:176px;display:flex;flex-direction:column;gap:2px;padding:16px 8px;border-right:1px solid var(--cfg-border);background:color-mix(in srgb,var(--cfg-ink) 2%,var(--cfg-surface));overflow-y:auto;scrollbar-width:thin}',
			'.apollo-hubNavItem{display:flex;align-items:center;gap:8px;flex-shrink:0;min-height:36px;padding:8px 12px;border:0;border-radius:6px;background:transparent;font:inherit;font-size:13px;line-height:20px;text-align:left;cursor:pointer;color:var(--cfg-ink-2);transition:background 140ms ease,color 140ms ease;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
			'.apollo-hubNavItem:hover{background:var(--cfg-hover);color:var(--cfg-ink)}',
			'.apollo-hubNavItem[data-active]{background:var(--cfg-hover);color:var(--cfg-ink);font-weight:500}.apollo-hubNavItem svg{flex:none;opacity:.72}.apollo-hubNavItem[data-active] svg{opacity:1;color:var(--cfg-accent-ink)}',
			'.apollo-hubNavItem:focus-visible{outline:2px solid var(--cfg-accent);outline-offset:1px}',
			'.apollo-hubContent{flex:1;min-width:0;min-height:0;overflow-y:auto;overscroll-behavior:contain;padding:28px 32px 0;scrollbar-width:thin;scrollbar-gutter:stable}.apollo-hubContent .apollo-footer{position:sticky;bottom:0;background:var(--cfg-surface);padding-bottom:24px;z-index:1}.apollo-hubModalContent{padding:0!important;overflow:hidden}.apollo-hubPane{min-width:0;overflow-wrap:anywhere}',
			'.apollo-hubPane[hidden]{display:none}',
			'@media (max-width:800px){.apollo-hub{flex-direction:column;height:80dvh}.apollo-hubNav{width:auto;flex-direction:row;gap:4px;padding:8px;border-right:0;border-bottom:1px solid var(--cfg-border);overflow-x:auto}.apollo-hubNavItem{min-height:44px}.apollo-hubContent{padding:24px 20px 0}.apollo-cfg{gap:24px}.apollo-pageTitle{font-size:18px}.apollo-hubContent .apollo-footer{bottom:0}.apollo-mask{padding:12px}.apollo-modalCard{max-height:calc(100dvh - 24px)}}',
			/* 自绘 overlay（ui-primitives 缺失时的兜底弹窗）。 */
			'.apollo-mask{position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;padding:24px;box-sizing:border-box;background:rgba(0,0,0,.4)}',
			'.apollo-modalCard{display:flex;flex-direction:column;width:min(1040px,100%);max-height:calc(100vh - 64px);box-sizing:border-box;border:1px solid var(--cfg-border);border-radius:12px;background:var(--dsw-alias-bg-layer-1);box-shadow:0 12px 48px rgba(0,0,0,.22)}',
			'.apollo-sectionTitle{margin:0;font-size:14px;line-height:20px;font-weight:500}.apollo-connectionSection{border-top:.5px solid var(--cfg-border);padding-top:24px}.apollo-guardSection{padding-bottom:0}.apollo-guardFlow{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;margin-top:8px;padding:16px 12px;border:.5px solid var(--cfg-border);border-radius:8px;background:color-mix(in srgb,var(--cfg-ink) 1.5%,var(--cfg-surface))}',
			'.apollo-flowStep{position:relative;display:flex;flex-direction:column;align-items:center;gap:6px;min-width:0;text-align:center;color:var(--cfg-ink-2)}.apollo-flowStep svg{box-sizing:content-box;display:block;padding:6px;border:.5px solid var(--cfg-border);border-radius:8px;background:var(--cfg-surface)}.apollo-flowLabel{font-size:12px;line-height:18px;max-width:130px;overflow-wrap:normal}',
			'.apollo-flowStep:not(:last-child):after{content:"";position:absolute;left:calc(50% + 24px);top:15px;width:calc(100% - 40px);border-top:1px solid var(--cfg-border)}',
			'.apollo-guardFlow[data-enabled=true] .apollo-flowStep:last-child{color:var(--cfg-accent-ink)}.apollo-guardFlow[data-enabled=true] .apollo-flowStep:last-child svg{border-color:color-mix(in srgb,var(--cfg-accent) 35%,var(--cfg-border));background:var(--cfg-accent-soft)}',
			'.apollo-modalHead{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px 16px;border-bottom:1px solid var(--cfg-border)}',
			'.apollo-modalTitle{margin:0;font-size:15px;font-weight:500;line-height:22px}',
			'.apollo-modalBody{flex:1;min-height:0;overflow:hidden;display:flex}',
			'.apollo-iconBtn{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border:0;border-radius:6px;background:transparent;color:var(--cfg-ink-3);font-size:16px;line-height:1;cursor:pointer}',
			'.apollo-iconBtn:hover{background:var(--cfg-hover);color:var(--cfg-ink)}',
			'.apollo-iconBtn:focus-visible{outline:2px solid var(--cfg-accent);outline-offset:1px}',
			'@media (pointer:coarse),(max-width:640px){.apollo-iconBtn{width:44px;height:44px}}',
			'@media (prefers-reduced-motion:reduce){.apollo-pulse{animation:none}.apollo-switch,.apollo-switchThumb,.apollo-button,.apollo-hubNavItem{transition:none}}',
		].join('\n');

		/** 宿主快照只投影当前仍生效的可编辑字段。 */
		function shape(value) {
			const source = typeof value === 'object' && value !== null && !Array.isArray(value) ? value : {};
			return { exitGuard: source.exitGuard === true, declareOwnsHost: source.declareOwnsHost === true };
		}

		function SwitchRow({ id, label, hint, checked, disabled, onChange }) {
			const hintId = hint === undefined ? undefined : id + '-hint';
			return h('div', { className: 'apollo-row' },
				h('div', { className: 'apollo-rowText' },
					h('label', { className: 'apollo-rowTitle', htmlFor: id }, label),
					hint === undefined ? null : h('span', { className: 'apollo-rowDesc', id: hintId }, hint)),
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

			return h('div', { className: 'apollo-cfg' },
				h('h2', { className: 'apollo-pageTitle' }, translate('title')),
				writable ? null : h('p', { className: 'apollo-note', 'data-tone': 'warn' }, translate('readonly')),
				h('section', { className: 'apollo-guardSection' },
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
				h('section', { className: 'apollo-connectionSection' },
					h('h3', { className: 'apollo-sectionTitle' }, translate('connectionTitle')),
					h('div', { className: 'apollo-detailsBody' },
						h(SwitchRow, { id: 'apollo-owns-host', label: translate('ownsHostLabel'), hint: translate('ownsHostHint'),
							checked: live.declareOwnsHost, disabled: !writable || busy, onChange: (next) => edit({ declareOwnsHost: next }) }),
						h('p', { className: 'apollo-hint' }, translate('ownsHostReload')))),
				h('details', { className: 'apollo-details' },
					h('summary', null, translate('compatTitle')),
					h('div', { className: 'apollo-detailsBody' },
						h('p', { className: 'apollo-hint' }, translate('migratedBody')),
						h('p', { className: 'apollo-hint' }, translate('deprecatedBody')),
						h('p', { className: 'apollo-hint' }, translate('reloadBody')))),
				h('div', { className: 'apollo-footer' },
					status,
					h('button', {
						type: 'button', className: 'apollo-button', 'data-variant': 'ghost',
						disabled: busy || !dirty, onClick: reset,
					}, translate('reset')),
					h('button', {
						type: 'button', className: 'apollo-button', 'data-variant': 'primary',
						disabled: !writable || busy || !dirty, onClick: () => void save(),
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
					return h('p', { className: 'apollo-note', 'data-tone': 'error', role: 'alert' },
						t('entryError') + String(this.state.error?.message ?? this.state.error));
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
			const [active, setActive] = useState(null);
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
				if (moveFocus === true) focusTab(rowId);
			};
			// 方向键漫游：上下为主，窄屏横排时左右同义；Home/End 跳到两端。
			const onTabListKeyDown = (event) => {
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
		function FallbackModal({ onClose, children }) {
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
				const onKey = (event) => { if (event.key === 'Escape') closeRef.current(); };
				doc.addEventListener('keydown', onKey);
				return () => {
					doc.removeEventListener('keydown', onKey);
					const back = restoreRef.current;
					restoreRef.current = null;
					if (back !== null && typeof back.focus === 'function') back.focus();
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
						h('h2', { className: 'apollo-modalTitle', id: titleId }, t('hubTitle')),
						h('button', { type: 'button', className: 'apollo-iconBtn', 'aria-label': t('close'), onClick: onClose }, '×')),
					h('div', { className: 'apollo-modalBody' }, children)));
		}

		function SettingsModal({ ctx, onClose }) {
			const body = h(HubBody, { ctx });
			if (Modal === null) return h(FallbackModal, { onClose }, body);
			return h(Modal, {
				open: true,
				onClose,
				title: t('hubTitle'),
				closeLabel: t('close'),
				className: 'apollo-modal',
				contentClassName: 'apollo-hubModalContent',
			}, body);
		}

		/** `plugins.detail.actions` 入口：仅 Apollo bundle 详情页渲染触发按钮。 */
		function HubEntry(props) {
			const subject = props.subject;
			const isApolloBundle = subject?.kind === 'bundle'
				&& (subject.pkg?.name === PACKAGE_NAME || subject.pkg?.name === LEGACY_PACKAGE_NAME);
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
					onClick: () => setOpen(true),
				}, gearGlyph(), (props.t ?? t)('hubButton')),
				open ? h(SettingsModal, { ctx: props.ctx, onClose: close }) : null);
		}

		const inject = ['slots', 'locale'];

		function apply(ctx) {
			try {
				const dispose = ctx.locale.register(NS, { zh, en });
				t = ctx.locale.bind(NS);
				ctx.effect(() => dispose, '@menghuan1918/dsh-apollo: dictionaries');
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
			}), '@menghuan1918/dsh-apollo: row config page');

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
						sctx.effect(register, '@menghuan1918/dsh-apollo: settings hub');
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
