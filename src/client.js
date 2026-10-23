/**
 * dsh-apollo (npm: @menghuan1918/dsh-apollo) — 浏览器半边：官方 Plugins 页的行配置表单。
 *
 * 宿主行导出正式 volatile Config，dsh-settings 把它投影成行配置表单；本文件注册
 * `plugins.row.config`（键 `<npm 包名>#apollo-skills`，与 src/config.js 的
 * ROW_CONFIG_KEY/LEGACY_ROW_CONFIG_KEY 同步），自画紧凑表单并只在保存时一次提交全部改动。零构建：
 * closure factory，只 require('react')，不 import 任何 DSH client 包；样式随组件
 * 树内一个 <style> 渲染（不写 DOM）。注册 id 必须等于 npm 包名（client closure id）。
 */

window.__ModuleLoader__.load({
	id: '@menghuan1918/dsh-apollo',
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		const { createElement: h, useEffect, useState } = require('react');

		const NS = 'apollo';
		// 新键是 Plugins 页按“bundle 依赖名 + 行 id”算出的（= npm 包名 + #apollo-skills）；
		// 旧键并排注册，只为仍把依赖槽记成旧 unscoped 名的 profile 保留配置入口。
		const ROW_KEYS = ['@menghuan1918/dsh-apollo#apollo-skills', 'dsh-apollo#apollo-skills'];
		const CAPABILITIES_URL = '/apollo/api/capabilities';
		const MODELS_URL = '/apollo/api/models';

		/** Codex CLI 权限档（与 src/config.js 的 CODEX_PERMISSION_MODES 同步）。 */
		const CODEX = {
			cli: 'codex',
			executable: 'codex',
			permission: 'read-only',
			permissions: ['read-only', 'workspace-write', 'danger-full-access'],
			profile: true,
		};
		/** Claude Code CLI 权限档（与 src/config.js 的 CLAUDE_PERMISSION_MODES 同步）。 */
		const CLAUDE = {
			cli: 'claude',
			executable: 'claude',
			permission: 'plan',
			permissions: ['plan', 'manual', 'dontAsk', 'acceptEdits', 'auto', 'bypassPermissions'],
			profile: false,
		};
		const BACKENDS = [CODEX, CLAUDE];

		const zh = {
			summary: '工程模式运行时设置：退出守卫、子代理 CLI 后端与接入范围',
			title: '工程模式运行时设置',
			intro: '保存后即时生效，无需重启。配置写入当前 profile 的行配置（cordis.patch.yml）。',
			loading: '正在读取配置…',
			waitingForm: '正在等待宿主提供这一行的配置快照…',
			noFormHint: '长时间停在这里说明宿主没有为这一行提供可编辑配置：本部署没组合 dsh-settings/config-editor，或本行的 Config 未被识别。',
			unavailable: '当前连接下该配置不可用：请通过 loopback 地址访问，或在行配置里把该权威加入 trustedHosts。',
			readonly: '当前连接只读（设置镜像为进程内 memory），无法写入宿主配置。',
			exitGuardLabel: '退出守卫',
			exitGuardHint: '回合结束时若仍有运行中的子代理或后台命令，注入提醒强制继续处理；用户中断（Esc）始终放行。',
			scopeTitle: '接入范围',
			scopeEng: '工程模式预设',
			scopeEngHint: 'eng / eng-noask 会话可以看到下面这些 CLI 子代理路由。',
			scopeGlobal: '全部预设',
			scopeGlobalHint: '所有预设的会话都能看到这些路由（影响面更大）。',
			scopeNone: '两个范围都关闭时，这些 CLI 路由不会出现在任何会话里。',
			codexTitle: 'Codex 后端',
			claudeTitle: 'Claude 后端',
			backendEnable: '启用',
			executableLabel: '可执行文件',
			executableHint: '只写命令名则从 PATH 查找；也可手输绝对路径或 ~ 开头的路径。',
			profileLabel: 'Profile',
			profileHint: '名称来自 CODEX_HOME 下的 <name>.config.toml 与旧式 [profiles.*] 段。',
			profileNone: '（不指定）',
			permissionLabel: '权限档',
			permissionHint: '完全由这里的设置决定，不继承会话的权限状态。',
			defaultModelLabel: '默认模型',
			defaultModelNone: '（未指定）',
			modelsLabel: '模型与 effort',
			modelsHint: '每行一个模型：id + 允许的 effort（逗号分隔）+ 默认 effort。',
			modelsEmpty: '还没有配置模型；启用后端前至少加一个模型。',
			discover: '自动发现模型',
			discovering: '正在发现…',
			discoverHint: '从本机 CLI 或 Anthropic 端点读取模型，只追加列表里还没有的条目。',
			discoverDone: '已发现 {count} 个模型，新增 {added} 个。',
			discoverFailed: '自动发现失败：{reason}',
			discoverUnknown: '未知原因',
			discoverReasonMissing: '没找到可执行文件',
			discoverReasonFailed: 'CLI 命令执行失败',
			discoverReasonNoCredentials: '没找到 ANTHROPIC_AUTH_TOKEN / ANTHROPIC_API_KEY',
			discoverReasonUnauthorized: '模型端点拒绝了凭据（HTTP {status}）',
			discoverReasonHttp: '模型端点返回 HTTP {status}',
			discoverReasonNetwork: '无法连接模型端点',
			discoverReasonParse: '返回内容不是可解析的模型清单',
			discoverReasonEmpty: '模型清单为空',
			discoverReasonTooLarge: '返回内容过大',
			modelIdPlaceholder: '模型 id',
			modelEffortsPlaceholder: 'low, medium, high',
			modelDefaultEffort: '默认 effort',
			modelEffortNone: '（无默认）',
			modelAdd: '添加模型',
			modelRemove: '移除',
			probing: '正在探测本机可执行文件…',
			detected: '已检测到 {path}（{version}）',
			detectedNoVersion: '已检测到 {path}（版本未知）',
			missing: 'PATH 上没找到 {executable}，可直接填绝对路径。',
			capabilitiesError: '读取本机探测信息失败（不影响保存）。',
			save: '保存',
			saving: '保存中…',
			reset: '放弃改动',
			saved: '已保存，即时生效。',
			conflict: '宿主拒绝了这次写入：配置可能已被其他改动更新或被更高优先级配置覆盖，已重新读取宿主值。',
			saveFailed: '保存失败：',
			invalidEmptyId: '{backend}里有模型缺少 id，请补齐后再保存。',
			invalidDuplicateId: '{backend}的模型 id 不能重复。',
			invalidNoModels: '{backend}已启用，但还没有配置任何模型。',
			invalidDefaultModel: '{backend}已启用，请把默认模型设为模型列表里的一个。',
			invalidDefaultEffort: '{backend}的默认模型需要 effort 列表，并指定一个属于它的默认 effort。',
			readonlyNote: '只读：当前无法写入宿主配置。',
			unavailableNote: '不可写：当前连接下该配置不可用。',
		};

		const en = {
			summary: 'Eng mode runtime settings: exit guard, CLI subagent backends, and scope',
			title: 'Eng mode runtime settings',
			intro: 'Saving applies immediately, no restart. Values persist in the active profile row config (cordis.patch.yml).',
			loading: 'Loading configuration…',
			waitingForm: 'Waiting for the host to provide this row’s configuration snapshot…',
			noFormHint: 'Staying here means the host exposes no editable config for this row: dsh-settings/config-editor is not composed, or this row’s Config was not recognized.',
			unavailable: 'This configuration is unavailable on the current connection: use a loopback address, or list this authority in the row config trustedHosts.',
			readonly: 'This connection is read-only (settings mirror is process-local memory); host configuration cannot be written.',
			exitGuardLabel: 'Exit guard',
			exitGuardHint: 'Blocks turn end while subagents or background jobs are still running; interrupt (Esc) always passes through.',
			scopeTitle: 'Scope',
			scopeEng: 'Eng preset',
			scopeEngHint: 'eng / eng-noask sessions see the CLI subagent routes below.',
			scopeGlobal: 'All presets',
			scopeGlobalHint: 'Every preset’s sessions see these routes (broader impact).',
			scopeNone: 'With both scopes off, these CLI routes appear in no session.',
			codexTitle: 'Codex backend',
			claudeTitle: 'Claude backend',
			backendEnable: 'Enabled',
			executableLabel: 'Executable',
			executableHint: 'A bare command name is resolved from PATH; an absolute or ~ path is also accepted.',
			profileLabel: 'Profile',
			profileHint: 'Names come from <name>.config.toml under CODEX_HOME and from legacy [profiles.*] sections.',
			profileNone: '(none)',
			permissionLabel: 'Permission',
			permissionHint: 'Decided entirely by this setting; the session’s permission state is never inherited.',
			defaultModelLabel: 'Default model',
			defaultModelNone: '(unset)',
			modelsLabel: 'Models and efforts',
			modelsHint: 'One model per row: id + allowed efforts (comma separated) + default effort.',
			modelsEmpty: 'No model yet; add at least one before enabling the backend.',
			discover: 'Discover models',
			discovering: 'Discovering…',
			discoverHint: 'Reads models from the local CLI or the Anthropic endpoint; appends only entries not already listed.',
			discoverDone: 'Found {count} models, added {added}.',
			discoverFailed: 'Discovery failed: {reason}',
			discoverUnknown: 'unknown reason',
			discoverReasonMissing: 'executable not found',
			discoverReasonFailed: 'the CLI command failed',
			discoverReasonNoCredentials: 'no ANTHROPIC_AUTH_TOKEN / ANTHROPIC_API_KEY',
			discoverReasonUnauthorized: 'the model endpoint rejected the credential (HTTP {status})',
			discoverReasonHttp: 'the model endpoint answered HTTP {status}',
			discoverReasonNetwork: 'the model endpoint could not be reached',
			discoverReasonParse: 'the reply is not a parseable model list',
			discoverReasonEmpty: 'the model list is empty',
			discoverReasonTooLarge: 'the reply is too large',
			modelIdPlaceholder: 'model id',
			modelEffortsPlaceholder: 'low, medium, high',
			modelDefaultEffort: 'Default effort',
			modelEffortNone: '(none)',
			modelAdd: 'Add model',
			modelRemove: 'Remove',
			probing: 'Probing local executables…',
			detected: 'Found {path} ({version})',
			detectedNoVersion: 'Found {path} (version unknown)',
			missing: '{executable} was not found on PATH; type an absolute path if needed.',
			capabilitiesError: 'Could not read local probe data (saving still works).',
			save: 'Save',
			saving: 'Saving…',
			reset: 'Discard',
			saved: 'Saved and applied.',
			conflict: 'The host refused this write: the configuration changed elsewhere or a higher layer overrides it. Host values were reloaded.',
			saveFailed: 'Save failed: ',
			invalidEmptyId: 'Every model in {backend} needs an id before saving.',
			invalidDuplicateId: 'Model ids in {backend} must be unique.',
			invalidNoModels: '{backend} is enabled but has no model configured.',
			invalidDefaultModel: '{backend} is enabled: set the default model to one of its model ids.',
			invalidDefaultEffort: '{backend}’s default model needs an effort list and a default effort from that list.',
			readonlyNote: 'Read-only: host configuration cannot be written.',
			unavailableNote: 'Not writable: this configuration is unavailable on the current connection.',
		};

		/** 宿主发现接口的 error.code → 文案键（未知 code 回退通用原因）。 */
		const DISCOVERY_REASON_KEYS = {
			missing: 'discoverReasonMissing',
			failed: 'discoverReasonFailed',
			'no-credentials': 'discoverReasonNoCredentials',
			unauthorized: 'discoverReasonUnauthorized',
			http: 'discoverReasonHttp',
			network: 'discoverReasonNetwork',
			parse: 'discoverReasonParse',
			empty: 'discoverReasonEmpty',
			'too-large': 'discoverReasonTooLarge',
		};

		// ── 文案（locale 服务缺失时保持中文默认）───────────────────────────────

		function interpolate(text, params) {
			if (params === undefined || params === null) return text;
			return text.replace(/\{(\w+)\}/g, (match, key) => (key in params ? String(params[key]) : match));
		}

		let t = (key, params) => interpolate(zh[key] ?? key, params);

		// ── 样式（组件树内的 <style>；复用 DSH 设计令牌，与官方设置页同观感）──────────

		const STYLE_ID = '@menghuan1918/dsh-apollo/settings.css';
		const CSS = [
			'.apollo-cfg{display:flex;flex-direction:column;gap:12px;max-width:760px;font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary)}',
			'.apollo-note{margin:0;padding:8px 10px;border-radius:var(--dsw-radius-md);font-size:12.5px;line-height:18px;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-secondary)}',
			'.apollo-note[data-tone=error]{background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, transparent);color:var(--dsw-alias-state-error-primary)}',
			'.apollo-note[data-tone=warn]{background:var(--dsw-alias-state-warn-tertiary);color:var(--dsw-alias-label-secondary)}',
			'.apollo-note[data-tone=ok]{color:var(--dsw-alias-state-success-primary)}',
			'.apollo-pulse{animation:apollo-pulse 2s cubic-bezier(.36,0,.64,1) infinite}',
			'@keyframes apollo-pulse{0%{opacity:1}40%{opacity:.6}80%,to{opacity:1}}',
			'@media (prefers-reduced-motion:reduce){.apollo-pulse{animation:none}}',
			'.apollo-title{margin:0;font-size:14px;font-weight:500;line-height:22px}',
			'.apollo-hint{margin:0;font-size:12px;line-height:16px;color:var(--dsw-alias-label-tertiary)}',
			'.apollo-hint[data-tone=error]{color:var(--dsw-alias-state-error-primary)}',
			'.apollo-hint[data-tone=ok]{color:var(--dsw-alias-state-success-primary)}',
			'.apollo-actions{display:flex;flex-wrap:wrap;gap:6px}',
			'.apollo-intro{margin:0;font-size:12.5px;line-height:18px;color:var(--dsw-alias-label-secondary)}',
			'.apollo-section{display:flex;flex-direction:column;gap:2px;padding-top:12px;border-top:.5px solid var(--dsw-alias-border-l2)}',
			'.apollo-sectionHead{display:flex;flex-direction:column;gap:2px;padding-bottom:4px}',
			'.apollo-field{display:grid;grid-template-columns:minmax(120px,168px) minmax(0,1fr);gap:2px 12px;padding:6px 0;align-items:start}',
			'.apollo-fieldLabel{padding-top:5px;font-size:13px;font-weight:500;color:var(--dsw-alias-label-primary)}',
			'.apollo-fieldBody{display:flex;flex-direction:column;gap:4px;min-width:0}',
			'.apollo-input,.apollo-select{box-sizing:border-box;width:100%;min-width:0;height:28px;padding:0 8px;font:inherit;font-size:13px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md)}',
			'.apollo-select{appearance:none;background-image:none;padding-right:24px}',
			'.apollo-input::placeholder{color:var(--dsw-alias-label-dimmed)}',
			'.apollo-input:focus,.apollo-select:focus{border-color:var(--dsw-alias-state-business-primary);outline:none}',
			'.apollo-input:focus-visible,.apollo-select:focus-visible,.apollo-switch:focus-visible,.apollo-button:focus-visible,.apollo-iconButton:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px}',
			'.apollo-input:disabled,.apollo-select:disabled{opacity:.4;cursor:not-allowed}',
			'.apollo-input[aria-invalid=true]{border-color:var(--dsw-alias-state-error-primary)}',
			'.apollo-switchRow{display:flex;align-items:flex-start;gap:12px;padding:6px 0}',
			'.apollo-switchMain{display:flex;flex-direction:column;gap:2px;flex:1;min-width:0}',
			'.apollo-switchLabel{font-size:13px;font-weight:500}',
			'.apollo-switch{box-sizing:border-box;position:relative;flex:none;width:36px;height:20px;margin:2px 0 0;padding:2px;border:0;border-radius:999px;background:var(--dsw-alias-border-l3);cursor:pointer;appearance:none}',
			'.apollo-switch[aria-checked=true]{background:var(--dsw-alias-brand-primary,var(--dsw-alias-state-business-primary))}',
			'.apollo-switch:disabled{opacity:.4;cursor:not-allowed}',
			'.apollo-switchThumb{display:block;width:16px;height:16px;border-radius:50%;background:var(--dsw-alias-label-primary-foreground);transition:transform 120ms ease}',
			'.apollo-switch[aria-checked=false] .apollo-switchThumb{background:var(--dsw-alias-switch-thumb,var(--dsw-alias-label-primary-foreground))}',
			'.apollo-switch[aria-checked=true] .apollo-switchThumb{transform:translateX(16px)}',
			'@media (prefers-reduced-motion:reduce){.apollo-switchThumb{transition:none}}',
			'.apollo-card{display:flex;flex-direction:column;gap:2px;padding:10px 12px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-layer-1)}',
			'.apollo-cardOff{opacity:.72}',
			'.apollo-cardHead{display:flex;align-items:flex-start;gap:12px}',
			'.apollo-cardTitle{flex:1;min-width:0;font-size:13.5px;font-weight:500}',
			'.apollo-models{display:flex;flex-direction:column;gap:6px}',
			'.apollo-model{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.4fr) minmax(0,132px) auto;gap:6px;align-items:center}',
			'.apollo-modelHead{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.4fr) minmax(0,132px) auto;gap:6px;font-size:11.5px;color:var(--dsw-alias-label-tertiary)}',
			'@media (max-width:640px){.apollo-field,.apollo-model,.apollo-modelHead{grid-template-columns:minmax(0,1fr)}.apollo-fieldLabel{padding-top:0}}',
			'.apollo-button{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:4px;height:28px;padding:0 10px;border:0;border-radius:var(--dsw-radius-sm);font:inherit;font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary);background:transparent;cursor:pointer}',
			'.apollo-button:disabled{opacity:.4;cursor:not-allowed}',
			'.apollo-button[data-variant=primary]{background:var(--dsw-alias-button-primary-fill,var(--dsw-alias-label-primary));color:var(--dsw-alias-label-primary-foreground,var(--dsw-alias-bg-layer-3))}',
			'.apollo-button[data-variant=primary]:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover,var(--dsw-alias-label-primary))}',
			'.apollo-button[data-variant=outline]{border:.5px solid var(--dsw-alias-border-l3)}',
			'.apollo-button[data-variant=outline]:hover:not(:disabled),.apollo-button[data-variant=ghost]:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
			'.apollo-iconButton{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border:0;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer;font:inherit;font-size:14px;line-height:1}',
			'.apollo-iconButton:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
			'.apollo-iconButton:disabled{opacity:.4;cursor:not-allowed}',
			'.apollo-footer{display:flex;align-items:center;gap:8px;padding-top:12px;border-top:.5px solid var(--dsw-alias-border-l2)}',
			'.apollo-status{flex:1;min-width:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}',
			'.apollo-status[data-tone=ok]{color:var(--dsw-alias-state-success-primary)}',
			'.apollo-status[data-tone=error]{color:var(--dsw-alias-state-error-primary)}',
			'.apollo-status[data-tone=warn]{color:var(--dsw-alias-state-warn-label,var(--dsw-alias-label-secondary))}',
		].join('\n');


		// ── 取值/形状（与 src/config.js 的默认形状一致；浏览器半边不能 import 宿主模块）──

		function isRecord(value) {
			return typeof value === 'object' && value !== null && !Array.isArray(value);
		}

		function stringOr(value, fallback) {
			return typeof value === 'string' ? value : fallback;
		}

		function modelList(value) {
			if (!Array.isArray(value)) return [];
			return value.filter(isRecord).map((entry) => {
				const efforts = Array.isArray(entry.efforts) ? entry.efforts.filter((item) => typeof item === 'string') : [];
				const defaultEffort = stringOr(entry.defaultEffort, '');
				return {
					id: stringOr(entry.id, ''),
					efforts,
					// 与 src/config.js 同规则：默认 effort 必须属于该模型的 effort 列表。
					defaultEffort: efforts.indexOf(defaultEffort) >= 0 ? defaultEffort : '',
				};
			});
		}

		function backendShape(value, spec) {
			const source = isRecord(value) ? value : {};
			const backend = {
				enabled: source.enabled === true,
				executable: typeof source.executable === 'string' && source.executable.trim() !== ''
					? source.executable.trim()
					: spec.executable,
			};
			if (spec.profile) backend.profile = stringOr(source.profile, '');
			backend.permissionMode = spec.permissions.indexOf(source.permissionMode) >= 0
				? source.permissionMode
				: spec.permission;
			backend.defaultModel = stringOr(source.defaultModel, '');
			backend.models = modelList(source.models);
			return backend;
		}

		/** 把宿主快照值（或 undefined）规整成表单可安全读写的形状。 */
		function shape(value) {
			const source = isRecord(value) ? value : {};
			const subagents = isRecord(source.subagents) ? source.subagents : {};
			const result = {
				exitGuard: source.exitGuard === true,
				subagents: {
					eng: subagents.eng !== false,
					global: subagents.global === true,
				},
			};
			for (const spec of BACKENDS) result.subagents[spec.cli] = backendShape(subagents[spec.cli], spec);
			return result;
		}

		/** 逗号分隔的 effort 文本 → 去重后的字符串数组。 */
		function parseEfforts(text) {
			const result = [];
			for (const part of String(text ?? '').split(',')) {
				const trimmed = part.trim();
				if (trimmed === '' || result.indexOf(trimmed) >= 0) continue;
				result.push(trimmed);
			}
			return result;
		}

		/** 只在用户按下保存时才写入：把差异摊成一组 set 操作（数组整段替换）。 */
		function diffOps(host, current) {
			const ops = [];
			if (host.exitGuard !== current.exitGuard) {
				ops.push({ op: 'set', path: ['exitGuard'], value: current.exitGuard });
			}
			for (const key of ['eng', 'global']) {
				if (host.subagents[key] !== current.subagents[key]) {
					ops.push({ op: 'set', path: ['subagents', key], value: current.subagents[key] });
				}
			}
			for (const spec of BACKENDS) {
				const before = host.subagents[spec.cli];
				const after = current.subagents[spec.cli];
				for (const field of Object.keys(after)) {
					if (JSON.stringify(before[field]) === JSON.stringify(after[field])) continue;
					ops.push({ op: 'set', path: ['subagents', spec.cli, field], value: after[field] });
				}
			}
			return ops;
		}

		/**
		 * 前端校验（宿主 schema 管不到跨字段关联，这里补齐）：
		 * 模型 id 非空且唯一；**启用的**后端必须有默认模型，且该模型的 effort
		 * 列表与默认 effort 齐备——CLI 路由按这三元组选档，缺一项运行时就报错。
		 * @returns `{ key, titleKey }`（key 用 `{backend}` 参数渲染后端名），或 null。
		 */
		function validate(current) {
			for (const spec of BACKENDS) {
				const backend = current.subagents[spec.cli];
				const titleKey = spec.cli === 'codex' ? 'codexTitle' : 'claudeTitle';
				const fail = (key) => ({ key, titleKey });
				const ids = backend.models.map((model) => model.id.trim());
				if (ids.indexOf('') >= 0) return fail('invalidEmptyId');
				if (new Set(ids).size !== ids.length) return fail('invalidDuplicateId');
				if (!backend.enabled) continue;
				if (backend.models.length === 0) return fail('invalidNoModels');
				const selected = backend.models.find((model) => model.id.trim() === backend.defaultModel.trim());
				if (selected === undefined) return fail('invalidDefaultModel');
				if (selected.efforts.length === 0) return fail('invalidDefaultEffort');
				if (selected.defaultEffort === '' || selected.efforts.indexOf(selected.defaultEffort) < 0) {
					return fail('invalidDefaultEffort');
				}
			}
			return null;
		}

		// ── 能力探针（host 半边的只读接口）─────────────────────────────────────

		/** 拉取 `/apollo/api/capabilities`；失败只降级显示，不阻塞表单。 */
		function useCapabilities() {
			const [state, setState] = useState({ status: 'loading' });
			useEffect(() => {
				let active = true;
				const controller = typeof AbortController === 'function' ? new AbortController() : undefined;
				const done = (next) => {
					if (active) setState(next);
				};
				void (async () => {
					try {
						const res = await fetch(CAPABILITIES_URL, controller === undefined ? undefined : { signal: controller.signal });
						const body = await res.json().catch(() => undefined);
						if (!res.ok || body?.ok !== true) throw new Error('HTTP ' + String(res.status));
						done({ status: 'ready', value: body.value });
					} catch (error) {
						done({ status: 'error', message: String(error?.message ?? error) });
					}
				})();
				return () => {
					active = false;
					controller?.abort();
				};
			}, []);
			return state;
		}

		/** 一行探针结论：已检测到 <路径>（版本）/ 未找到。 */
		function detectionOf(capabilities, spec, backend, translate) {
			if (capabilities.status === 'loading') return translate('probing');
			if (capabilities.status !== 'ready') return translate('capabilitiesError');
			const info = isRecord(capabilities.value?.executables) ? capabilities.value.executables[spec.cli] : undefined;
			if (typeof info?.path === 'string' && info.path !== '') {
				return typeof info.version === 'string' && info.version !== ''
					? translate('detected', { path: info.path, version: info.version })
					: translate('detectedNoVersion', { path: info.path });
			}
			return translate('missing', { executable: backend.executable });
		}

		// ── 基础控件 ───────────────────────────────────────────────────────────

		/** 标签 + 控件 + 提示的紧凑两列字段。 */
		function Field({ id, label, hint, children }) {
			return h('div', { className: 'apollo-field' },
				h('label', id === undefined ? { className: 'apollo-fieldLabel' } : { className: 'apollo-fieldLabel', htmlFor: id }, label),
				h('div', { className: 'apollo-fieldBody' },
					children,
					hint === undefined ? null : h('p', { className: 'apollo-hint' }, hint)));
		}

		/** 开关行（role=switch + aria-checked，与官方 Switch 同观感）。 */
		function SwitchRow({ id, label, hint, checked, disabled, onChange }) {
			const labelId = id + '-label';
			return h('div', { className: 'apollo-switchRow' },
				h('div', { className: 'apollo-switchMain' },
					h('span', { className: 'apollo-switchLabel', id: labelId }, label),
					hint === undefined ? null : h('p', { className: 'apollo-hint' }, hint)),
				h('button', {
					type: 'button',
					id,
					role: 'switch',
					className: 'apollo-switch',
					'aria-checked': checked === true,
					'aria-labelledby': labelId,
					disabled: disabled === true,
					onClick: () => onChange(checked !== true),
				}, h('span', { className: 'apollo-switchThumb' })));
		}

		/** 下拉选项：保留当前值（外部写入的值不在候选里时也不能被静默改掉）。 */
		function optionNodes(values, current, noneLabel) {
			const nodes = [];
			if (noneLabel !== undefined) nodes.push(h('option', { key: '__none', value: '' }, noneLabel));
			const seen = new Set();
			for (const value of values) {
				if (typeof value !== 'string' || value === '' || seen.has(value)) continue;
				seen.add(value);
				nodes.push(h('option', { key: value, value }, value));
			}
			if (typeof current === 'string' && current !== '' && !seen.has(current)) {
				nodes.push(h('option', { key: current, value: current }, current));
			}
			return nodes;
		}

		/** 一个模型的编辑行：effort 用本地文本缓冲（直接回填解析结果会吃掉未输完的逗号）。 */
		function ModelRow({ model, index, disabled, t: translate, onPatch, onRemove }) {
			const [effortsText, setEffortsText] = useState(model.efforts.join(', '));
			return h('div', { className: 'apollo-model' },
				h('input', {
					className: 'apollo-input',
					type: 'text',
					value: model.id,
					placeholder: translate('modelIdPlaceholder'),
					disabled,
					'aria-label': translate('modelIdPlaceholder') + ' ' + String(index + 1),
					onChange: (event) => onPatch({ id: event.target.value }),
				}),
				h('input', {
					className: 'apollo-input',
					type: 'text',
					value: effortsText,
					placeholder: translate('modelEffortsPlaceholder'),
					disabled,
					'aria-label': translate('modelsLabel') + ' ' + String(index + 1),
					onChange: (event) => {
						const efforts = parseEfforts(event.target.value);
						setEffortsText(event.target.value);
						// 默认 effort 不属于新的列表时清空（宿主读回同规则）。
						onPatch({
							efforts,
							defaultEffort: efforts.indexOf(model.defaultEffort) >= 0 ? model.defaultEffort : '',
						});
					},
				}),
				h('select', {
					className: 'apollo-select',
					value: model.defaultEffort,
					disabled,
					'aria-label': translate('modelDefaultEffort') + ' ' + String(index + 1),
					onChange: (event) => {
						const next = event.target.value;
						if (next !== '' && model.efforts.indexOf(next) < 0) return;
						onPatch({ defaultEffort: next });
					},
				}, optionNodes(model.efforts, model.defaultEffort, translate('modelEffortNone'))),
				h('button', {
					type: 'button',
					className: 'apollo-iconButton',
					title: translate('modelRemove'),
					'aria-label': translate('modelRemove'),
					disabled,
					onClick: onRemove,
				}, '−'));
		}

		/** 一个 CLI 后端的配置卡片。 */
		function BackendCard({ spec, backend, disabled, capabilities, discovery, t: translate, onPatch, onModelPatch, onModelAdd, onModelRemove, onDiscover, generation }) {
			const title = translate(spec.cli === 'codex' ? 'codexTitle' : 'claudeTitle');
			const status = discovery === undefined ? undefined : discovery[spec.cli];
			const profileNames = capabilities.status === 'ready' && Array.isArray(capabilities.value?.codexProfiles)
				? capabilities.value.codexProfiles.filter((name) => typeof name === 'string')
				: [];
			const modelIds = backend.models.map((model) => model.id.trim()).filter((id) => id !== '');
			const cards = [];
			cards.push(h(SwitchRow, {
				key: 'enable',
				id: 'apollo-' + spec.cli + '-enabled',
				label: translate('backendEnable'),
				checked: backend.enabled,
				disabled,
				onChange: (next) => onPatch({ enabled: next }),
			}));
			cards.push(h(Field, {
				key: 'executable',
				id: 'apollo-' + spec.cli + '-executable',
				label: translate('executableLabel'),
				hint: translate('executableHint'),
			},
			h('input', {
				className: 'apollo-input',
				type: 'text',
				id: 'apollo-' + spec.cli + '-executable',
				value: backend.executable,
				spellCheck: false,
				autoComplete: 'off',
				disabled,
				onChange: (event) => onPatch({ executable: event.target.value }),
			}),
			h('p', { className: 'apollo-hint' }, detectionOf(capabilities, spec, backend, translate))));
			if (spec.profile) {
				cards.push(h(Field, {
					key: 'profile',
					id: 'apollo-' + spec.cli + '-profile',
					label: translate('profileLabel'),
					hint: translate('profileHint'),
				},
				h('select', {
					className: 'apollo-select',
					id: 'apollo-' + spec.cli + '-profile',
					value: backend.profile,
					disabled,
					onChange: (event) => onPatch({ profile: event.target.value }),
				}, optionNodes(profileNames, backend.profile, translate('profileNone')))));
			}
			cards.push(h(Field, {
				key: 'permission',
				id: 'apollo-' + spec.cli + '-permission',
				label: translate('permissionLabel'),
				hint: translate('permissionHint'),
			},
			h('select', {
				className: 'apollo-select',
				id: 'apollo-' + spec.cli + '-permission',
				value: backend.permissionMode,
				disabled,
				onChange: (event) => onPatch({ permissionMode: event.target.value }),
			}, optionNodes(spec.permissions, backend.permissionMode))));
			cards.push(h(Field, {
				key: 'defaultModel',
				id: 'apollo-' + spec.cli + '-default-model',
				label: translate('defaultModelLabel'),
			},
			h('select', {
				className: 'apollo-select',
				id: 'apollo-' + spec.cli + '-default-model',
				value: backend.defaultModel,
				disabled,
				onChange: (event) => onPatch({ defaultModel: event.target.value }),
			}, optionNodes(modelIds, backend.defaultModel, translate('defaultModelNone')))));
			cards.push(h(Field, {
				key: 'models',
				label: translate('modelsLabel'),
				hint: translate('modelsHint'),
			},
			backend.models.length === 0
				? h('p', { className: 'apollo-hint' }, translate('modelsEmpty'))
				: h('div', { className: 'apollo-models' },
					h('div', { className: 'apollo-modelHead' },
						h('span', null, translate('modelIdPlaceholder')),
						h('span', null, translate('modelEffortsPlaceholder')),
						h('span', null, translate('modelDefaultEffort')),
						h('span', null, '')),
					backend.models.map((model, index) => h(ModelRow, {
						key: generation + ':' + index,
						model,
						index,
						disabled,
						t: translate,
						onPatch: (patch) => onModelPatch(index, patch),
						onRemove: () => onModelRemove(index),
					}))),
			h('div', { className: 'apollo-actions' },
				h('button', {
					type: 'button',
					id: 'apollo-' + spec.cli + '-discover',
					className: 'apollo-button',
					'data-variant': 'outline',
					disabled: disabled || status?.status === 'loading',
					onClick: onDiscover,
				}, status?.status === 'loading' ? translate('discovering') : translate('discover')),
				h('button', {
					type: 'button',
					className: 'apollo-button',
					'data-variant': 'outline',
					disabled,
					onClick: onModelAdd,
				}, translate('modelAdd'))),
			h('p', {
				className: 'apollo-hint',
				...(status?.status === 'error' ? { 'data-tone': 'error' }
					: status?.status === 'ok' ? { 'data-tone': 'ok' } : {}),
			}, status?.text ?? translate('discoverHint'))));
			return h('div', { className: backend.enabled ? 'apollo-card' : 'apollo-card apollo-cardOff' },
				h('div', { className: 'apollo-cardHead' },
					h('span', { className: 'apollo-cardTitle' }, title)),
				cards);
		}

		/** 行配置页面主体。 */
		function ApolloConfigPage({ form, t: translate }) {
			const capabilities = useCapabilities();
			const state = form?.state;
			const revision = state?.revision;
			const [draft, setDraft] = useState(null);
			const [generation, setGeneration] = useState(0);
			const [busy, setBusy] = useState(false);
			const [notice, setNotice] = useState(null);
			/** 每个后端的发现状态：`{ status: 'loading' | 'ok' | 'error', text? }`。 */
			const [discovery, setDiscovery] = useState({});

			const host = state?.status === 'ready' ? shape(state.value) : null;
			const live = draft !== null && draft.revision === revision ? draft.value : host;
			const writable = state?.status === 'ready' && state?.writable === true && state?.mode !== 'memory';
			const dirty = live !== null && host !== null && JSON.stringify(live) !== JSON.stringify(host);
			const invalid = live === null ? null : validate(live);

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
			if (host === null) {
				return h('div', { className: 'apollo-cfg' },
					h('p', { className: 'apollo-note', 'data-tone': 'warn' }, translate('unavailable')));
			}

			/** 记一次草稿修改（函数式叠加：连续编辑不丢改动；换 revision 即失效）。 */
			const edit = (mutate) => {
				setDraft((previous) => {
					const base = previous !== null && previous.revision === revision ? previous.value : live;
					return { revision, value: mutate(base) };
				});
				setNotice(null);
			};
			const patchBackend = (spec, patch) => edit((current) => ({
				...current,
				subagents: {
					...current.subagents,
					[spec.cli]: { ...current.subagents[spec.cli], ...patch },
				},
			}));
			/** 按 index 做函数式补丁：不依赖触发那一帧的数组快照。 */
			const patchModel = (spec, index, patch) => edit((current) => {
				const backend = current.subagents[spec.cli];
				const models = backend.models.map((model, at) => (at === index ? { ...model, ...patch } : model));
				return { ...current, subagents: { ...current.subagents, [spec.cli]: { ...backend, models } } };
			});
			const addModel = (spec) => edit((current) => {
				const backend = current.subagents[spec.cli];
				return {
					...current,
					subagents: {
						...current.subagents,
						[spec.cli]: { ...backend, models: [...backend.models, { id: '', efforts: [], defaultEffort: '' }] },
					},
				};
			});
			const removeModel = (spec, index) => edit((current) => {
				const backend = current.subagents[spec.cli];
				return {
					...current,
					subagents: {
						...current.subagents,
						[spec.cli]: { ...backend, models: backend.models.filter((model, at) => at !== index) },
					},
				};
			});
			/** 发现失败原因：只认宿主给的 error.code，不回显可能含凭据的细节。 */
			const discoveryReason = (error) => {
				const key = DISCOVERY_REASON_KEYS[String(error?.code ?? '')];
				if (key === undefined) return translate('discoverUnknown');
				return translate(key, { status: String(error?.status ?? '') });
			};
			/** 拉取发现结果并并入草稿：保留已有条目，只追加新 id。 */
			const discoverModels = async (spec) => {
				if (discovery[spec.cli]?.status === 'loading' || !writable) return;
				setDiscovery((previous) => ({ ...previous, [spec.cli]: { status: 'loading' } }));
				try {
					const response = await fetch(MODELS_URL + '?cli=' + encodeURIComponent(spec.cli));
					const body = await response.json().catch(() => undefined);
					if (!response.ok || body?.ok !== true) throw new Error('HTTP ' + String(response.status));
					const value = isRecord(body.value) ? body.value : {};
					const found = modelList(value.models).filter((model) => model.id.trim() !== '');
					if (found.length === 0) {
						setDiscovery((previous) => ({
							...previous,
							[spec.cli]: {
								status: 'error',
								text: translate('discoverFailed', { reason: discoveryReason(value.error) }),
							},
						}));
						return;
					}
					const known = new Set(live.subagents[spec.cli].models
						.map((model) => model.id.trim()).filter((id) => id !== ''));
					const added = found.filter((model) => !known.has(model.id)).length;
					edit((current) => {
						const backend = current.subagents[spec.cli];
						const existing = new Set(backend.models
							.map((model) => model.id.trim()).filter((id) => id !== ''));
						const models = [...backend.models];
						for (const model of found) {
							if (existing.has(model.id)) continue;
							existing.add(model.id);
							models.push(model);
						}
						const defaultModel = backend.defaultModel.trim() !== '' ? backend.defaultModel : (models[0]?.id ?? '');
						return {
							...current,
							subagents: {
								...current.subagents,
								[spec.cli]: { ...backend, models, defaultModel },
							},
						};
					});
					setDiscovery((previous) => ({
						...previous,
						[spec.cli]: {
							status: 'ok',
							text: translate('discoverDone', { count: found.length, added }),
						},
					}));
				} catch (error) {
					setDiscovery((previous) => ({
						...previous,
						[spec.cli]: {
							status: 'error',
							text: translate('discoverFailed', { reason: String(error?.message ?? error) }),
						},
					}));
				}
			};
			const save = async () => {
				if (!dirty || invalid !== null || !writable) return;
				const ops = diffOps(host, live);
				if (ops.length === 0) return;
				setBusy(true);
				setNotice(null);
				try {
					const accepted = await form.mutate(ops, revision);
					if (accepted) {
						// 草稿保留：mirror 折叠后 revision 前进、草稿自动失效（避免回显旧值闪烁）。
						setNotice({ tone: 'ok', text: translate('saved') });
					} else {
						setDraft(null);
						setGeneration((value) => value + 1);
						setNotice({ tone: 'warn', text: translate('conflict') });
					}
				} catch (error) {
					setNotice({ tone: 'error', text: translate('saveFailed') + String(error?.message ?? error) });
				} finally {
					setBusy(false);
				}
			};
			const reset = () => {
				setDraft(null);
				setGeneration((value) => value + 1);
				setNotice(null);
			};

			const status = notice !== null
				? h('span', { className: 'apollo-status', 'data-tone': notice.tone, role: notice.tone === 'error' ? 'alert' : 'status' }, notice.text)
				: invalid !== null
					? h('span', { className: 'apollo-status', 'data-tone': 'error', role: 'alert' },
						translate(invalid.key, { backend: translate(invalid.titleKey) }))
					: h('span', { className: 'apollo-status', role: 'status' }, writable
						? (state.mode === 'host' ? '' : '')
						: (state.status === 'unavailable' ? translate('unavailableNote') : translate('readonlyNote')));

			return h('div', { className: 'apollo-cfg' },
				h('div', { className: 'apollo-sectionHead' },
					h('h3', { className: 'apollo-title' }, translate('title')),
					h('p', { className: 'apollo-intro' }, translate('intro'))),
				writable ? null : h('p', { className: 'apollo-note', 'data-tone': 'warn' },
					state.status === 'unavailable' ? translate('unavailable') : translate('readonly')),
				h('div', { className: 'apollo-section' },
					h(SwitchRow, {
						id: 'apollo-exit-guard',
						label: translate('exitGuardLabel'),
						hint: translate('exitGuardHint'),
						checked: live.exitGuard,
						disabled: !writable || busy,
						onChange: (next) => edit((current) => ({ ...current, exitGuard: next })),
					})),
				h('div', { className: 'apollo-section' },
					h('div', { className: 'apollo-sectionHead' },
						h('h3', { className: 'apollo-title' }, translate('scopeTitle'))),
					h(SwitchRow, {
						id: 'apollo-scope-eng',
						label: translate('scopeEng'),
						hint: translate('scopeEngHint'),
						checked: live.subagents.eng,
						disabled: !writable || busy,
						onChange: (next) => edit((current) => ({ ...current, subagents: { ...current.subagents, eng: next } })),
					}),
					h(SwitchRow, {
						id: 'apollo-scope-global',
						label: translate('scopeGlobal'),
						hint: translate('scopeGlobalHint'),
						checked: live.subagents.global,
						disabled: !writable || busy,
						onChange: (next) => edit((current) => ({ ...current, subagents: { ...current.subagents, global: next } })),
					}),
					live.subagents.eng || live.subagents.global
						? null
						: h('p', { className: 'apollo-note', 'data-tone': 'warn' }, translate('scopeNone'))),
				...BACKENDS.map((spec) => h(BackendCard, {
					key: spec.cli,
					spec,
					backend: live.subagents[spec.cli],
					disabled: !writable || busy,
					capabilities,
					discovery,
					t: translate,
					generation,
					onPatch: (patch) => patchBackend(spec, patch),
					onModelPatch: (index, patch) => patchModel(spec, index, patch),
					onModelAdd: () => addModel(spec),
					onModelRemove: (index) => removeModel(spec, index),
					onDiscover: () => discoverModels(spec),
				})),
				h('div', { className: 'apollo-footer' },
					h('button', {
						type: 'button',
						className: 'apollo-button',
						'data-variant': 'primary',
						disabled: !writable || busy || !dirty || invalid !== null,
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
