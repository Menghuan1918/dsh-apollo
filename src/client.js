/**
 * dsh-apollo — 工程模式设置面板（浏览器半边）。
 *
 * 本文件即最终产物（closure-factory 格式，与 dsh-web 生态 tsdown client 预设
 * 的输出同构）：执行时向 window.__ModuleLoader__ 注册工厂，externals（react）
 * 经注入的 require 从浏览器模块表解析。向官方 Plugins 设置分区的
 * `settings.plugins.tab` slot 注册「工程模式」标签页（dsh-plugin-manager 同款
 * 注入方式）：退出守卫开关，经 host 半边的 /eng-panel/api/config 读写。
 *
 * 注册 id 必须等于包名：client-modules 按包名建图行，校验脚本注册的 id
 * 与图行一致，否则启动即报 "loaded without registering"。
 *
 * 零构建（手写 createElement，不用 JSX）；文案经 ctx.locale 注册 zh/en。
 */

window.__ModuleLoader__.load({
	id: 'dsh-apollo',
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		const { createElement: h, useEffect, useState } = require('react');

		const NS = 'eng-panel';

		const zh = {
			tab: '工程模式',
			title: '工程模式',
			description: '工程模式预设的运行时配置，保存至 ~/.dsh/eng.json，保存后即时生效（无需重启）。',
			guardLabel: '退出守卫',
			guardHint: '仍有运行中的子代理或后台命令时，阻止回合结束并提醒用 wait_subagent / job_output 等待收取、job_kill 停止；全部处理完再收尾。用户中断（Esc）不受影响。',
			save: '保存',
			saving: '保存中…',
			saved: '已保存',
			loading: '加载中…',
			loadFailed: '读取配置失败',
			retry: '重试',
			saveFailed: '保存失败：',
		};

		const en = {
			tab: 'Eng Mode',
			title: 'Eng Mode',
			description: 'Runtime configuration for the eng preset, persisted to ~/.dsh/eng.json and applied immediately (no restart needed).',
			guardLabel: 'Exit guard',
			guardHint: 'Blocks turn end while subagents or background jobs are still running, prompting wait_subagent / job_output to collect and job_kill to stop; interrupt (Esc) always passes through.',
			save: 'Save',
			saving: 'Saving…',
			saved: 'Saved',
			loading: 'Loading…',
			loadFailed: 'Failed to load configuration',
			retry: 'Retry',
			saveFailed: 'Save failed: ',
		};

		// 默认中文；apply 挂上 locale 服务后由 ctx.locale.bind 接管。
		let t = (key) => zh[key] ?? key;

		const styles = {
			wrap: { display: 'flex', flexDirection: 'column', gap: '12px', maxWidth: '760px', color: 'var(--dsw-alias-label-primary, inherit)' },
			hint: { margin: 0, color: 'var(--dsw-alias-label-tertiary, #888)', fontSize: '13px', lineHeight: '20px' },
			row: { display: 'flex', alignItems: 'flex-start', gap: '10px', fontSize: '14px' },
			checkbox: { marginTop: '3px' },
			actions: { display: 'flex', alignItems: 'center', gap: '10px' },
			button: { font: 'inherit', cursor: 'pointer', border: '1px solid var(--dsw-alias-border-l2, #555)', borderRadius: '6px', background: 'var(--dsw-alias-bg-layer-1, transparent)', color: 'inherit', padding: '4px 12px' },
			ok: { color: 'var(--dsw-alias-state-success-primary, #3c3)', fontSize: '13px' },
			error: { color: 'var(--dsw-alias-state-error-primary, #c33)', fontSize: '13px' },
		};

		function EngAtlasPanelTab() {
			const [state, setState] = useState({ status: 'loading' });

			useEffect(() => {
				void (async () => {
					try {
						const res = await fetch('/eng-panel/api/config');
						const body = await res.json();
						if (!res.ok || body?.ok !== true) throw new Error(`HTTP ${res.status}`);
						setState({ status: 'ready', exitGuard: body.value.exitGuard === true, saving: false, saved: false, saveError: undefined });
					} catch (error) {
						setState({ status: 'error', message: String(error?.message ?? error) });
					}
				})();
			}, []);

			if (state.status === 'loading') return h('p', { style: styles.hint }, t('loading'));
			if (state.status === 'error') {
				return h('div', { style: styles.wrap },
					h('p', { style: styles.error }, `${t('loadFailed')} (${state.message})`),
					h('button', { style: styles.button, onClick: () => location.reload() }, t('retry')));
			}

			const save = async () => {
				setState((prev) => ({ ...prev, saving: true, saved: false, saveError: undefined }));
				try {
					const res = await fetch('/eng-panel/api/config', {
						method: 'PUT',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify({ exitGuard: state.exitGuard }),
					});
					const body = await res.json();
					if (!res.ok || body?.ok !== true) throw new Error(`HTTP ${res.status}`);
					setState((prev) => ({ ...prev, saving: false, saved: true, exitGuard: body.value.exitGuard === true }));
				} catch (error) {
					setState((prev) => ({ ...prev, saving: false, saveError: String(error?.message ?? error) }));
				}
			};

			return h('div', { style: styles.wrap },
				h('h3', { style: { margin: 0 } }, t('title')),
				h('p', { style: styles.hint }, t('description')),
				h('label', { style: styles.row },
					h('input', {
						style: styles.checkbox,
						type: 'checkbox',
						checked: state.exitGuard,
						onChange: (event) => setState((prev) => ({ ...prev, exitGuard: event.target.checked, saved: false })),
					}),
					h('span', null, t('guardLabel'))),
				h('p', { style: styles.hint }, t('guardHint')),
				h('div', { style: styles.actions },
					h('button', { style: styles.button, onClick: () => void save(), disabled: state.saving }, state.saving ? t('saving') : t('save')),
					state.saved ? h('span', { style: styles.ok }, t('saved')) : null,
					state.saveError !== undefined ? h('span', { style: styles.error }, t('saveFailed') + state.saveError) : null));
		}

		const inject = ['slots', 'locale'];

		function apply(ctx) {
			try {
				const dispose = ctx.locale.register(NS, { zh, en });
				t = ctx.locale.bind(NS);
				ctx.effect(() => dispose, 'eng-panel: dictionaries');
			} catch {
				// locale 服务缺失时保持中文默认。
			}
			ctx.slots.inject('settings.plugins.tab', () => {
				try {
					return ctx.slots.register({
						name: 'settings.plugins.tab',
						id: 'eng',
						order: 30,
						label: () => t('tab'),
						locale: NS,
						inject: () => ({}),
					}, EngAtlasPanelTab);
				} catch {
					return () => {};
				}
			});
		}

		exports.inject = inject;
		exports.apply = apply;
		return module.exports;
	},
});
