/**
 * dsh-apollo (npm: @menghuan1918/dsh-apollo) — 浏览器半边：官方 Plugins 页的最小行配置页。
 *
 * 0.5.0 起 Apollo 只保留两件事需要网页入口：
 *   - `exitGuard`：运行中**后台 job** 的退出守卫开关（volatile，保存即生效）；
 *   - 迁移/弃用说明：CLI 子代理、模型分档、运行中子代理守卫与压缩设置分别由
 *     `@menghuan1918/dsh-better-subagent` 与 `dsh-better-compact` 的行拥有。
 *     Apollo 的旧字段仍能装载（供一次性迁移读取），但不再作为可编辑的子代理设置。
 *
 * 本文件注册 `plugins.row.config`（键 `<npm 包名>#apollo-skills`，与
 * src/config.js 的 ROW_CONFIG_KEY/LEGACY_ROW_CONFIG_KEY 同步），自画紧凑表单并只在
 * 保存时一次提交全部改动。零构建：closure factory，只 require('react')，不 import
 * 任何 DSH client 包；样式随组件树内一个 <style> 渲染（不写 DOM）。注册 id 必须等于
 * npm 包名（client closure id）。不注册新插件的页面键——那些由各自的包拥有。
 */

window.__ModuleLoader__.load({
	id: '@menghuan1918/dsh-apollo',
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		const { createElement: h, useState } = require('react');

		const NS = 'apollo';
		// 新键是 Plugins 页按“bundle 依赖名 + 行 id”算出的（= npm 包名 + #apollo-skills）；
		// 旧键并排注册，只为仍把依赖槽记成旧 unscoped 名的 profile 保留配置入口。
		const ROW_KEYS = ['@menghuan1918/dsh-apollo#apollo-skills', 'dsh-apollo#apollo-skills'];

		const zh = {
			summary: 'Apollo 集成设置：后台任务退出守卫与迁移说明',
			title: 'Apollo 集成设置',
			intro: 'Apollo 负责技能、工程预设和独立插件的装配。这里只保留后台任务退出守卫；保存后即时生效，配置写入当前 profile 的行配置（cordis.patch.yml）。',
			migratedTitle: '已迁移的能力',
			migratedBody: 'CLI 子代理、wait_subagent、运行中子代理守卫、模型分档与子代理设置页由 @menghuan1918/dsh-better-subagent 拥有；压缩模式与预算由 dsh-better-compact 拥有。请到 Plugins 中对应的行配置。',
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
		};

		const en = {
			summary: 'Apollo integration settings: background-job exit guard and migration notes',
			title: 'Apollo integration settings',
			intro: 'Apollo owns the skills, the engineering presets and the assembly of the independent plugins. Only the background-job exit guard remains here; saving applies immediately and persists in the active profile row config (cordis.patch.yml).',
			migratedTitle: 'Migrated capabilities',
			migratedBody: 'CLI subagents, wait_subagent, the running-child guard, model tiers and the subagent settings page are owned by @menghuan1918/dsh-better-subagent; compaction modes and budgets are owned by dsh-better-compact. Use their rows under Plugins.',
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
		};

		function interpolate(text, params) {
			if (params === undefined || params === null) return text;
			return text.replace(/\{(\w+)\}/g, (match, key) => (key in params ? String(params[key]) : match));
		}

		let t = (key, params) => interpolate(zh[key] ?? key, params);

		const STYLE_ID = '@menghuan1918/dsh-apollo/settings.css';
		const CSS = [
			'.apollo-cfg{display:flex;flex-direction:column;gap:12px;max-width:760px;font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary)}',
			'.apollo-note{margin:0;padding:8px 10px;border-radius:var(--dsw-radius-md);font-size:12.5px;line-height:18px;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-secondary)}',
			'.apollo-note[data-tone=error]{background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, transparent);color:var(--dsw-alias-state-error-primary)}',
			'.apollo-note[data-tone=warn]{background:var(--dsw-alias-state-warn-tertiary);color:var(--dsw-alias-label-secondary)}',
			'.apollo-pulse{animation:apollo-pulse 2s cubic-bezier(.36,0,.64,1) infinite}',
			'@keyframes apollo-pulse{0%{opacity:1}40%{opacity:.6}80%,to{opacity:1}}',
			'@media (prefers-reduced-motion:reduce){.apollo-pulse{animation:none}}',
			'.apollo-title{margin:0;font-size:14px;font-weight:500;line-height:22px}',
			'.apollo-hint{margin:0;font-size:12px;line-height:16px;color:var(--dsw-alias-label-tertiary)}',
			'.apollo-intro{margin:0;font-size:12.5px;line-height:18px;color:var(--dsw-alias-label-secondary)}',
			'.apollo-section{display:flex;flex-direction:column;gap:2px;padding-top:12px;border-top:.5px solid var(--dsw-alias-border-l2)}',
			'.apollo-sectionHead{display:flex;flex-direction:column;gap:2px;padding-bottom:4px}',
			'.apollo-switchRow{display:flex;align-items:flex-start;gap:12px;padding:6px 0}',
			'.apollo-switchMain{display:flex;flex-direction:column;gap:2px;flex:1;min-width:0}',
			'.apollo-switchLabel{font-size:13px;font-weight:500}',
			'.apollo-switch{box-sizing:border-box;position:relative;flex:none;width:36px;height:20px;margin:2px 0 0;padding:2px;border:0;border-radius:999px;background:var(--dsw-alias-border-l3);cursor:pointer;appearance:none}',
			'.apollo-switch[aria-checked=true]{background:var(--dsw-alias-brand-primary,var(--dsw-alias-state-business-primary))}',
			'.apollo-switch:disabled{opacity:.4;cursor:not-allowed}',
			'.apollo-switchThumb{display:block;width:16px;height:16px;border-radius:50%;background:var(--dsw-alias-label-primary-foreground);transition:transform 120ms ease}',
			'.apollo-switch[aria-checked=true] .apollo-switchThumb{transform:translateX(16px)}',
			'@media (prefers-reduced-motion:reduce){.apollo-switchThumb{transition:none}}',
			'.apollo-button{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:4px;height:28px;padding:0 10px;border:0;border-radius:var(--dsw-radius-sm);font:inherit;font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary);background:transparent;cursor:pointer}',
			'.apollo-button:disabled{opacity:.4;cursor:not-allowed}',
			'.apollo-button[data-variant=primary]{background:var(--dsw-alias-button-primary-fill,var(--dsw-alias-label-primary));color:var(--dsw-alias-label-primary-foreground,var(--dsw-alias-bg-layer-3))}',
			'.apollo-button[data-variant=outline]{border:.5px solid var(--dsw-alias-border-l3)}',
			'.apollo-button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
			'.apollo-footer{display:flex;align-items:center;gap:8px;padding-top:12px;border-top:.5px solid var(--dsw-alias-border-l2)}',
			'.apollo-status{flex:1;min-width:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}',
			'.apollo-status[data-tone=ok]{color:var(--dsw-alias-state-success-primary)}',
			'.apollo-status[data-tone=error]{color:var(--dsw-alias-state-error-primary)}',
			'.apollo-status[data-tone=warn]{color:var(--dsw-alias-state-warn-label,var(--dsw-alias-label-secondary))}',
		].join('\n');

		/** 宿主快照只投影这一个可编辑字段。 */
		function shape(value) {
			const source = typeof value === 'object' && value !== null && !Array.isArray(value) ? value : {};
			return { exitGuard: source.exitGuard === true };
		}

		function SwitchRow({ id, label, hint, checked, disabled, onChange }) {
			return h('div', { className: 'apollo-switchRow' },
				h('div', { className: 'apollo-switchMain' },
					h('label', { className: 'apollo-switchLabel', htmlFor: id }, label),
					hint === undefined ? null : h('p', { className: 'apollo-hint' }, hint)),
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
				h('div', { className: 'apollo-sectionHead' },
					h('h3', { className: 'apollo-title' }, translate('title')),
					h('p', { className: 'apollo-intro' }, translate('intro'))),
				writable ? null : h('p', { className: 'apollo-note', 'data-tone': 'warn' }, translate('readonly')),
				h('div', { className: 'apollo-section' },
					h('div', { className: 'apollo-sectionHead' },
						h('h3', { className: 'apollo-title' }, translate('exitGuardLabel'))),
					h(SwitchRow, {
						id: 'apollo-exit-guard',
						label: translate('exitGuardLabel'),
						hint: translate('exitGuardHint'),
						checked: live.exitGuard,
						disabled: !writable || busy,
						onChange: (next) => { setDraft({ revision: state.revision, value: { exitGuard: next } }); setNotice(null); },
					})),
				h('div', { className: 'apollo-section' },
					h('div', { className: 'apollo-sectionHead' },
						h('h3', { className: 'apollo-title' }, translate('migratedTitle'))),
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
			if (props.view === 'summary') return h('span', null, t('summary'));
			return h('div', { className: 'apollo-root' },
				h('style', { 'data-plugin-css': STYLE_ID }, CSS),
				h(ApolloConfigPage, { form: props.form, t: props.t ?? t }));
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
			ctx.effect(() => ctx.slots.inject('plugins.row.config', () => {
				const disposers = [];
				for (const key of ROW_KEYS) {
					try {
						const dispose = ctx.slots.register({
							name: 'plugins.row.config',
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
		}

		exports.inject = inject;
		exports.apply = apply;
		return module.exports;
	},
});
