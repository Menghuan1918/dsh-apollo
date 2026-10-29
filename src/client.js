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
 * 主题：#3388BB（`--cfg-accent`），其余全部走 --dsw-alias-* 中性令牌。
 * 零构建：closure factory，只 require('react') + 可选 ui-primitives（Modal
 * 兜底为自绘 overlay）；不 fetch、不直接写 DOM。
 */

window.__ModuleLoader__.load({
	id: '@menghuan1918/dsh-apollo',
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		const React = require('react');
		const { createElement: h, useEffect, useMemo, useState, useSyncExternalStore } = React;

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
			{ rowId: 'apollo-skills', titleKey: 'pluginApollo' },
			{ rowId: 'dsh-better-subagent', titleKey: 'pluginSubagent' },
			{ rowId: 'dsh-better-compact', titleKey: 'pluginCompact' },
			{ rowId: 'dsh-better-goal', titleKey: 'pluginGoal' },
			{ rowId: 'dsh-better-ask-user', titleKey: 'pluginAskUser' },
		];

		const zh = {
			summary: 'Apollo 集成设置：后台任务退出守卫与迁移说明',
			title: 'Apollo 集成设置',
			intro: 'Apollo 负责技能、工程预设和独立插件的装配。这里只保留后台任务退出守卫；保存后即时生效，配置写入当前 profile 的行配置（cordis.patch.yml）。',
			migratedTitle: '已迁移的能力',
			migratedBody: 'CLI 子代理、wait_subagent、运行中子代理守卫、模型分档与子代理设置页由 @menghuan1918/dsh-better-subagent 拥有；压缩模式与预算由 dsh-better-compact 拥有。请到 Plugins 中对应的行配置，或使用包详情页的集成设置弹窗。',
			deprecatedBody: '旧 Apollo 行里的 tiers / subagents / trustedHosts 只为迁移旧 profile 保留，运行时不再生效；迁移在启动后自动补齐新插件的缺失值，目标行已有显式设置时不会被覆盖。',
			reloadBody: '从 0.4.x 升级、或同时显式选中了独立 bundle 时，行可能显示为只读/不可寻址；请只保留一个显式入口并重载 profile。压缩设置的保存需要重载 profile 才会被引擎采用。',
			loading: '正在读取配置…',
			waitingForm: '正在等待宿主提供这一行的配置快照…',
			noFormHint: '长时间停在这里说明宿主没有为这一行提供可编辑配置：本部署没组合 dsh-settings/config-editor，或本行的 Config 未被识别。',
			unavailable: '当前连接下该配置不可用：请通过 loopback 地址访问，或在宿主部署层把该权威加入受信反代。',
			readonly: '当前连接只读（设置镜像为进程内 memory），无法写入宿主配置。',
			exitGuardLabel: '后台任务退出守卫',
			exitGuardHint: '回合结束时若本会话仍有运行中的后台命令，注入提醒强制继续处理；用户中断（Esc）始终放行。运行中子代理的拦截由 dsh-better-subagent 的 childExitGuard 单独控制。',
			save: '保存',
			saving: '保存中…',
			reset: '放弃改动',
			saved: '已保存，即时生效。',
			conflict: '宿主拒绝了这次写入：配置可能已被其他改动更新或被更高优先级配置覆盖，已重新读取宿主值。',
			saveFailed: '保存失败：',
			readonlyNote: '只读：当前无法写入宿主配置。',
			unavailableNote: '不可写：当前连接下该配置不可用。',
			hubButton: '集成设置',
			hubTitle: 'Apollo 集成设置',
			hubIntro: '统一查看和修改 Apollo 及各子插件的设置；各页面与各插件行配置共用同一份表单。',
			hubEmpty: '暂无可用的子插件设置：子插件客户端尚未注册设置页，或本部署未组合设置服务。',
			done: '完成',
			close: '关闭',
			entryError: '此设置区加载失败：',
			pluginApollo: 'Apollo 核心',
			pluginSubagent: 'Better Subagent',
			pluginCompact: 'Better Compact',
			pluginGoal: 'Better Goal',
			pluginAskUser: 'Better Ask User',
		};

		const en = {
			summary: 'Apollo integration settings: background-job exit guard and migration notes',
			title: 'Apollo integration settings',
			intro: 'Apollo owns the skills, the engineering presets and the assembly of the independent plugins. Only the background-job exit guard remains here; saving applies immediately and persists in the active profile row config (cordis.patch.yml).',
			migratedTitle: 'Migrated capabilities',
			migratedBody: 'CLI subagents, wait_subagent, the running-child guard, model tiers and the subagent settings page are owned by @menghuan1918/dsh-better-subagent; compaction modes and budgets are owned by dsh-better-compact. Configure their rows under Plugins, or use the integrated settings dialog on the package page.',
			deprecatedBody: 'The old Apollo tiers / subagents / trustedHosts fields are kept only so 0.4.x profiles load; they are inert at runtime. After boot the migration fills the new plugins’ missing values and never overwrites an explicit target setting.',
			reloadBody: 'Upgrading from 0.4.x, or selecting both the standalone and Apollo bundles explicitly, can make the row read-only/unaddressable: keep a single explicit entry and reload the profile. Saved compaction settings take effect only after the profile reloads.',
			loading: 'Loading configuration…',
			waitingForm: 'Waiting for the host to provide this row’s configuration snapshot…',
			noFormHint: 'Staying here means the host exposes no editable config for this row: dsh-settings/config-editor is not composed, or this row’s Config was not recognized.',
			unavailable: 'This configuration is unavailable on the current connection: use a loopback address, or trust this authority in the host deployment.',
			readonly: 'This connection is read-only (settings mirror is process-local memory); host configuration cannot be written.',
			exitGuardLabel: 'Background-job exit guard',
			exitGuardHint: 'Blocks turn end while background commands are still running; interrupt (Esc) always passes through. The running-child guard is controlled separately by dsh-better-subagent’s childExitGuard.',
			save: 'Save',
			saving: 'Saving…',
			reset: 'Discard',
			saved: 'Saved and applied.',
			conflict: 'The host refused this write: the configuration changed elsewhere or a higher layer overrides it. Host values were reloaded.',
			saveFailed: 'Save failed: ',
			readonlyNote: 'Read-only: host configuration cannot be written.',
			unavailableNote: 'Not writable: this configuration is unavailable on the current connection.',
			hubButton: 'Integrated settings',
			hubTitle: 'Apollo integrated settings',
			hubIntro: 'Review and edit Apollo and every sub-plugin’s settings in one place; each pane shares the same form as that plugin’s row configuration page.',
			hubEmpty: 'No sub-plugin settings are available yet: the sub-plugin clients have not registered their pages, or this deployment does not compose the settings service.',
			done: 'Done',
			close: 'Close',
			entryError: 'This settings pane failed to load: ',
			pluginApollo: 'Apollo core',
			pluginSubagent: 'Better Subagent',
			pluginCompact: 'Better Compact',
			pluginGoal: 'Better Goal',
			pluginAskUser: 'Better Ask User',
		};

		function interpolate(text, params) {
			if (params === undefined || params === null) return text;
			return text.replace(/\{(\w+)\}/g, (match, key) => (key in params ? String(params[key]) : match));
		}

		let t = (key, params) => interpolate(zh[key] ?? key, params);

		const STYLE_ID = '@menghuan1918/dsh-apollo/settings.css';
		const CSS = [
			/* 主题：#3388BB accent；其余全部中性 --dsw-alias-* 令牌。 */
			'.apollo-cfg,.apollo-root{--cfg-accent:#3388BB;--cfg-accent-hover:#2e7aa8;--cfg-accent-fg:#fff}',
			'.apollo-cfg{display:flex;flex-direction:column;gap:16px;max-width:760px;font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary)}',
			'.apollo-intro{margin:0;padding:0 2px;font-size:13px;line-height:20px;color:var(--dsw-alias-label-tertiary)}',
			'.apollo-note{margin:0;padding:10px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;font-size:12px;line-height:18px;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-secondary)}',
			'.apollo-note[data-tone=error]{background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 8%, transparent);border-color:color-mix(in srgb, var(--dsw-alias-state-error-primary) 30%, transparent);color:var(--dsw-alias-state-error-primary)}',
			'.apollo-note[data-tone=warn]{background:var(--dsw-alias-state-warn-tertiary);color:var(--dsw-alias-label-secondary)}',
			'.apollo-pulse{animation:apollo-pulse 2s cubic-bezier(.36,0,.64,1) infinite}',
			'@keyframes apollo-pulse{0%{opacity:1}40%{opacity:.6}80%,to{opacity:1}}',
			'@media (prefers-reduced-motion:reduce){.apollo-pulse{animation:none}}',
			/* 分组容器卡：1px hairline + 16px 圆角 + layer-3 底。 */
			'.apollo-group{display:flex;flex-direction:column;gap:6px;padding:16px 18px;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);border-radius:16px;background:var(--dsw-alias-bg-layer-3)}',
			'.apollo-groupHead{display:flex;align-items:baseline;gap:7px;padding:0 2px 8px;font-size:13px;line-height:20px;font-weight:600;color:var(--dsw-alias-label-primary)}',
			'.apollo-count{padding:1px 8px;border-radius:999px;background:color-mix(in srgb, var(--cfg-accent) 10%, transparent);font-size:11px;line-height:16px;font-weight:500;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}',
			'.apollo-title{margin:0;font-size:14px;font-weight:600;line-height:22px;color:var(--dsw-alias-label-primary)}',
			'.apollo-hint{margin:0;font-size:12px;line-height:17px;color:var(--dsw-alias-label-tertiary)}',
			/* 设置行：标题/描述居左，控件居右，行间 hairline。 */
			'.apollo-row{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:11px 2px;border-bottom:1px solid var(--dsw-alias-border-l2)}',
			'.apollo-row:last-child{border-bottom:none}',
			'.apollo-rowText{display:flex;flex-direction:column;gap:3px;min-width:0;flex:1}',
			'.apollo-rowTitle{font-size:13.5px;line-height:20px;font-weight:500;color:var(--dsw-alias-label-primary)}',
			'.apollo-rowDesc{font-size:12px;line-height:17px;color:var(--dsw-alias-label-tertiary)}',
			/* Switch：36x20 track，accent 实心 + 白点滑动。 */
			'.apollo-switch{box-sizing:border-box;position:relative;flex:none;width:36px;height:20px;margin:2px 0 0;padding:2px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-2);cursor:pointer;appearance:none;transition:background 150ms ease,border-color 150ms ease}',
			'.apollo-switch:hover{border-color:var(--dsw-alias-label-dimmed)}',
			'.apollo-switch[aria-checked=true]{border-color:var(--cfg-accent);background:var(--cfg-accent)}',
			'.apollo-switch:disabled{opacity:.4;cursor:not-allowed}',
			'.apollo-switchThumb{display:block;width:14px;height:14px;border-radius:50%;background:var(--dsw-alias-label-tertiary);transition:transform 150ms ease,background 150ms ease}',
			'.apollo-switch[aria-checked=true] .apollo-switchThumb{transform:translateX(16px);background:var(--cfg-accent-fg)}',
			'.apollo-switch:focus-visible{outline:2px solid var(--cfg-accent);outline-offset:2px}',
			'@media (prefers-reduced-motion:reduce){.apollo-switch,.apollo-switchThumb{transition:none}}',
			/* 按钮：primary=accent 实心白字；outline=1px 边；hover 走中性填充。 */
			'.apollo-button{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:6px;height:30px;padding:0 14px;border:1px solid transparent;border-radius:8px;font:inherit;font-size:12.5px;line-height:18px;font-weight:500;color:var(--dsw-alias-label-primary);background:transparent;cursor:pointer;transition:background 120ms ease,border-color 120ms ease,color 120ms ease}',
			'.apollo-button:disabled{opacity:.4;cursor:not-allowed}',
			'.apollo-button[data-variant=primary]{background:var(--cfg-accent);color:var(--cfg-accent-fg)}',
			'.apollo-button[data-variant=primary]:hover:not(:disabled){background:var(--cfg-accent-hover)}',
			'.apollo-button[data-variant=outline]{border-color:var(--dsw-alias-border-l3)}',
			'.apollo-button[data-variant=outline]:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
			'.apollo-button[data-variant=ghost]:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
			'.apollo-button:focus-visible{outline:2px solid var(--cfg-accent);outline-offset:2px}',
			'.apollo-input,.apollo-select{box-sizing:border-box;min-width:0;height:30px;padding:0 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:20px}',
			'.apollo-input:hover,.apollo-select:hover{border-color:var(--dsw-alias-label-dimmed)}',
			'.apollo-input:focus,.apollo-select:focus{outline:none;border-color:var(--cfg-accent);box-shadow:0 0 0 2px color-mix(in srgb, var(--cfg-accent) 25%, transparent)}',
			'.apollo-input:disabled,.apollo-select:disabled{opacity:.4;cursor:not-allowed}',
			'.apollo-input[aria-invalid=true]{border-color:var(--dsw-alias-state-error-primary)}',
			'.apollo-select{appearance:none;padding-right:26px;background-image:url("data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' width=\'10\' height=\'6\' viewBox=\'0 0 10 6\'%3E%3Cpath d=\'M1 1l4 4 4-4\' stroke=\'%23999\' stroke-width=\'1.5\' fill=\'none\' stroke-linecap=\'round\'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right 9px center}',
			'.apollo-footer{display:flex;align-items:center;gap:8px;padding-top:14px;border-top:1px solid var(--dsw-alias-border-l2)}',
			'.apollo-status{flex:1;min-width:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}',
			'.apollo-status[data-tone=ok]{color:var(--dsw-alias-state-success-primary)}',
			'.apollo-status[data-tone=error]{color:var(--dsw-alias-state-error-primary)}',
			'.apollo-status[data-tone=warn]{color:var(--dsw-alias-state-warn-label,var(--dsw-alias-label-secondary))}',
			/* ── 集成设置弹窗 ────────────────────────────────────────────── */
			'.apollo-hubGlyph{flex:none;color:var(--cfg-accent)}',
			/* ui-primitives Modal 加宽（双类提升优先级，同 better-sidebar 做法）。 */
			'.apollo-modal.apollo-modal{width:min(880px, calc(100% - 32px))}',
			'.apollo-hub{display:flex;gap:0;min-height:320px;max-height:60vh;--cfg-accent:#3388BB;--cfg-accent-hover:#2e7aa8;--cfg-accent-fg:#fff}',
			'.apollo-hubNav{flex:none;width:184px;display:flex;flex-direction:column;gap:2px;padding-right:12px;border-right:1px solid var(--dsw-alias-border-l2);overflow-y:auto;scrollbar-width:thin}',
			'.apollo-hubNavItem{display:flex;flex-direction:column;gap:1px;padding:8px 10px;border:0;border-radius:8px;background:transparent;font:inherit;text-align:left;cursor:pointer;color:var(--dsw-alias-label-secondary);transition:background 120ms ease,color 120ms ease}',
			'.apollo-hubNavItem:hover{background:var(--dsw-alias-interactive-bg-hover)}',
			'.apollo-hubNavItem[data-active]{background:color-mix(in srgb, var(--cfg-accent) 10%, transparent);color:var(--dsw-alias-label-primary)}',
			'.apollo-hubNavItem:focus-visible{outline:2px solid var(--cfg-accent);outline-offset:1px}',
			'.apollo-hubNavName{font-size:13px;line-height:18px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
			'.apollo-hubNavId{font-size:11px;line-height:15px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
			'.apollo-hubContent{flex:1;min-width:0;overflow-y:auto;padding-left:18px;scrollbar-width:thin}',
			'.apollo-hubPane[hidden]{display:none}',
			'@media (max-width:640px){.apollo-hub{flex-direction:column}.apollo-hubNav{width:auto;flex-direction:row;gap:4px;padding:0 0 10px;border-right:0;border-bottom:1px solid var(--dsw-alias-border-l2);overflow-x:auto}.apollo-hubNavId{display:none}.apollo-hubContent{padding-left:0;padding-top:12px}}',
			/* 自绘 overlay（ui-primitives 缺失时的兜底弹窗）。 */
			'.apollo-mask{position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;padding:24px;box-sizing:border-box;background:rgba(0,0,0,.4)}',
			'.apollo-modalCard{display:flex;flex-direction:column;width:min(880px,100%);max-height:calc(100vh - 64px);box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);border-radius:14px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);box-shadow:0 12px 48px rgba(0,0,0,.22)}',
			'.apollo-modalHead{display:flex;flex-direction:column;gap:4px;padding:18px 20px 12px;border-bottom:1px solid var(--dsw-alias-border-l2)}',
			'.apollo-modalTitleRow{display:flex;align-items:center;justify-content:space-between;gap:12px}',
			'.apollo-modalTitle{margin:0;font-size:15px;font-weight:600;line-height:22px}',
			'.apollo-modalDesc{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}',
			'.apollo-modalBody{flex:1;min-height:0;overflow:hidden;display:flex;padding:14px 20px}',
			'.apollo-modalFoot{display:flex;justify-content:flex-end;gap:8px;padding:12px 20px;border-top:1px solid var(--dsw-alias-border-l2)}',
			'.apollo-iconBtn{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-tertiary);font-size:16px;line-height:1;cursor:pointer}',
			'.apollo-iconBtn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
		].join('\n');

		/** 宿主快照只投影这一个可编辑字段。 */
		function shape(value) {
			const source = typeof value === 'object' && value !== null && !Array.isArray(value) ? value : {};
			return { exitGuard: source.exitGuard === true };
		}

		function SwitchRow({ id, label, hint, checked, disabled, onChange }) {
			return h('div', { className: 'apollo-row' },
				h('div', { className: 'apollo-rowText' },
					h('label', { className: 'apollo-rowTitle', htmlFor: id }, label),
					hint === undefined ? null : h('span', { className: 'apollo-rowDesc' }, hint)),
				h('button', {
					type: 'button',
					id,
					className: 'apollo-switch',
					role: 'switch',
					'aria-checked': checked,
					'aria-label': label,
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
			const dirty = live.exitGuard !== host.exitGuard;

			const save = async () => {
				if (!dirty || !writable || busy) return;
				setBusy(true);
				setNotice(null);
				try {
					const accepted = await form.mutate([{ op: 'set', path: ['exitGuard'], value: live.exitGuard }], state.revision);
					if (accepted) setNotice({ tone: 'ok', text: translate('saved') });
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
				h('p', { className: 'apollo-intro' }, translate('intro')),
				writable ? null : h('p', { className: 'apollo-note', 'data-tone': 'warn' }, translate('readonly')),
				h('div', { className: 'apollo-group' },
					h('div', { className: 'apollo-groupHead' }, translate('title')),
					h(SwitchRow, {
						id: 'apollo-exit-guard',
						label: translate('exitGuardLabel'),
						hint: translate('exitGuardHint'),
						checked: live.exitGuard,
						disabled: !writable || busy,
						onChange: (next) => { setDraft({ revision: state.revision, value: { exitGuard: next } }); setNotice(null); },
					})),
				h('div', { className: 'apollo-group' },
					h('div', { className: 'apollo-groupHead' }, translate('migratedTitle')),
					h('p', { className: 'apollo-note' }, translate('migratedBody')),
					h('p', { className: 'apollo-note' }, translate('deprecatedBody')),
					h('p', { className: 'apollo-note', 'data-tone': 'warn' }, translate('reloadBody'))),
				h('div', { className: 'apollo-footer' },
					h('button', {
						type: 'button',
						className: 'apollo-button',
						'data-variant': 'primary',
						disabled: !writable || busy || !dirty,
						onClick: () => void save(),
					}, busy ? translate('saving') : translate('save')),
					h('button', {
						type: 'button',
						className: 'apollo-button',
						'data-variant': 'outline',
						disabled: busy || !dirty,
						onClick: reset,
					}, translate('reset')),
					status));
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
					if (prev === undefined || score < prev.score) found.set(row.rowId, { entry });
				}
			}
			const items = [];
			for (const row of HUB_ROWS) {
				const hit = found.get(row.rowId);
				if (hit !== undefined) items.push({ rowId: row.rowId, titleKey: row.titleKey, entry: hit.entry });
			}
			return items;
		}

		/** 复刻官方插件页的 formFor：describe 镜像决定可见性，get() 拿共享表单。 */
		function formFor(ctx, mirror, rowId) {
			const namespaces = mirror?.view?.namespaces;
			if (!Array.isArray(namespaces) || !namespaces.some((view) => view?.ns === rowId)) return undefined;
			try {
				const form = ctx.configForms.get(rowId);
				return { state: form.getSnapshot(), mutate: (ops, revision) => form.mutate(ops, revision) };
			} catch {
				return undefined;
			}
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

		/** 弹窗主体：左 nav + 右面板（全部挂载，display:none 保住未存草稿）。 */
		function HubBody({ ctx }) {
			const version = useSyncExternalStore((listener) => subscribeSlot(ctx, listener), () => slotVersion(ctx));
			const items = useMemo(() => collectPluginEntries(ctx), [ctx, version]);
			const describe = ctx.configForms.describe();
			const mirror = useSyncExternalStore(
				(listener) => (typeof describe?.subscribe === 'function' ? describe.subscribe(listener) : () => {}),
				() => describe?.getSnapshot?.());
			useEffect(() => { void describe?.ensure?.(); }, [describe]);
			const [active, setActive] = useState(null);
			const current = items.find((item) => item.rowId === active) ?? items[0];

			if (items.length === 0) {
				return h('p', { className: 'apollo-note', role: 'status' }, t('hubEmpty'));
			}
			return h('div', { className: 'apollo-hub' },
				h('div', { className: 'apollo-hubNav', role: 'tablist', 'aria-label': t('hubTitle') },
					items.map((item) => h('button', {
						key: item.rowId,
						type: 'button',
						role: 'tab',
						className: 'apollo-hubNavItem',
						'data-active': item === current ? true : undefined,
						'aria-selected': item === current,
						onClick: () => setActive(item.rowId),
					},
						h('span', { className: 'apollo-hubNavName' }, t(item.titleKey)),
						h('span', { className: 'apollo-hubNavId' }, item.rowId)))),
				h('div', { className: 'apollo-hubContent', role: 'tabpanel' },
					items.map((item) => h('div', {
						key: item.rowId,
						className: 'apollo-hubPane',
						hidden: item !== current,
					},
						h(EntryBoundary, null,
							h(item.entry.component, {
								view: 'page',
								form: formFor(ctx, mirror, item.rowId),
								t: boundT(ctx, item.entry),
							}))))));
		}

		/** 自绘弹窗兜底：fixed mask + card，Esc/遮罩点击关闭（不依赖 ui-primitives）。 */
		function FallbackModal({ onClose, children }) {
			useEffect(() => {
				const doc = globalThis['document'];
				if (doc === undefined || doc === null) return undefined;
				const onKey = (event) => { if (event.key === 'Escape') onClose(); };
				doc.addEventListener('keydown', onKey);
				return () => doc.removeEventListener('keydown', onKey);
			}, [onClose]);
			return h('div', {
				className: 'apollo-mask',
				role: 'presentation',
				onClick: (event) => { if (event.target === event.currentTarget) onClose(); },
			},
				h('div', { className: 'apollo-modalCard', role: 'dialog', 'aria-label': t('hubTitle') },
					h('div', { className: 'apollo-modalHead' },
						h('div', { className: 'apollo-modalTitleRow' },
							h('h2', { className: 'apollo-modalTitle' }, t('hubTitle')),
							h('button', { type: 'button', className: 'apollo-iconBtn', 'aria-label': t('close'), onClick: onClose }, '×')),
						h('p', { className: 'apollo-modalDesc' }, t('hubIntro'))),
					h('div', { className: 'apollo-modalBody' }, children),
					h('div', { className: 'apollo-modalFoot' },
						h('button', { type: 'button', className: 'apollo-button', 'data-variant': 'primary', onClick: onClose }, t('done')))));
		}

		function SettingsModal({ ctx, onClose }) {
			const body = h(HubBody, { ctx });
			if (Modal === null) return h(FallbackModal, { onClose }, body);
			return h(Modal, {
				open: true,
				onClose,
				title: t('hubTitle'),
				description: t('hubIntro'),
				closeLabel: t('close'),
				className: 'apollo-modal',
				contentClassName: 'apollo-hubModalContent',
				footer: h('button', { type: 'button', className: 'apollo-button', 'data-variant': 'primary', onClick: onClose }, t('done')),
			}, body);
		}

		/** `plugins.detail.actions` 入口：仅 Apollo bundle 详情页渲染触发按钮。 */
		function HubEntry(props) {
			const subject = props.subject;
			const isApolloBundle = subject?.kind === 'bundle'
				&& (subject.pkg?.name === PACKAGE_NAME || subject.pkg?.name === LEGACY_PACKAGE_NAME);
			const [open, setOpen] = useState(false);
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
				open ? h(SettingsModal, { ctx: props.ctx, onClose: () => setOpen(false) }) : null);
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
