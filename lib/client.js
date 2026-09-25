/**
 * dsh-open-watchdog — 浏览器半边（v2：旁观记录器，抗节流版）
 * ============================================================================
 *
 * ⚠️ 手写产物（零构建路线），形状沿用同类 DSH 插件的写法：
 *    window.__ModuleLoader__.load({ id, factory: (require) => { ...; return module.exports } })
 *
 * ⚠️ **只读（有一处例外，已披露）**：不点按钮、不改 openState、不替换原生 API。
 *    **例外**：为记录"会话历史展开失败"的现场，`installReplaceHook()` 会**原地包装**
 *    `ClientAssistantStream.prototype.replace` —— 这是一次 **monkey-patch**（行为保持等价：调用原方法后
 *    **原样 rethrow**）。**不接受的话，删掉 `installReplaceHook(...)` 的调用即可**（只损失该项诊断）。
 *    只用浏览器自带的只读观察器：MutationObserver（DOM）+ PerformanceObserver（网络）。
 *
 * 两件事：
 *   ① 【探针】把 `sessions` 服务挂到 window.__watchdog_sessions（供现场取证）；
 *   ② 【记录器 v2】捕获"点击会话行"，记录这一次切换的完整时间线：
 *        · 加载文案何时出现 / 何时消失（**MutationObserver 驱动，后台标签页也不靠定时器**）
 *        · 每次轮询的**实际间隔**（用来发现浏览器节流：远大于 50ms 即被降频）
 *        · `document.visibilityState` 变化（前台/后台切换时刻）
 *        · 期间发起的**网络请求**（路径 / 耗时，只读采样）
 *        · 尽力读 `openState`（sessions 服务可用时，会把 id 的几种形态都试一遍）
 *      收尾：文案出现过又消失 / 25 秒到。
 *
 * 为什么改 v2：v1 只用 setTimeout 轮询，而**浏览器会对后台/失焦窗口降频**，
 * 用户切到别的窗口时"文案消失"会被记晚（曾把 16~18 s 记成卡顿）。v2 用观察器 + 记录实际间隔来区分。
 */

window.__ModuleLoader__.load({
	id: 'dsh-open-watchdog',
	factory: (require) => {
		const NS = 'dsh-open-watchdog';
		const LOG_PATH = '/dsh-open-watchdog/log';
		const OBSERVE_MAX_MS = 25000;
		const POLL_EVERY_MS = 50;
		const LOADING_PATTERNS = ['正在加载', '载入历史', '加载历史', '正在读取会话'];

		/**
		 * ★ 安全审查修复（H5）：这个 WeakSet 原本声明在 `readOpenState()` **函数体内**，
		 *   而该函数每 50 ms 被调一次 ⇒ 每次进来都是**新的空集合** ⇒ 去重彻底失效 ⇒
		 *   同一个 `openPromise` 在 25 s 窗口内被重复挂 `.then` 最多约 500 次
		 *   （内存随 tick 线性增长；promise settle 时一次性 fan-out 上百条重复记录）。
		 *   ⇒ 提升到**模块级**（插件生命周期内持久），才是真正的"已挂载"去重。
		 */
		const hookedPromises = new WeakSet();

		const inject = [];

		/**
		 * ★ 安全审查修复（M6）：客户端半边原本**没有卸载路径** —— 插件被禁用 / HMR 重载后，
		 *   document 级监听、window 监听、被包装的 `proto.replace`、`window.__watchdog_*` 会**永久残留**
		 *   （继续 POST、继续占内存）。这里登记所有需要在卸载时还原的清理函数，
		 *   由 `apply(ctx)` 通过 `ctx.effect` 挂钩；宿主侧原本就有 `ctx.effect`，客户端侧补上。
		 */
		const cleanups = [];
		function onCleanup(fn) {
			try { cleanups.push(fn); } catch { /* ignore */ }
		}
		function dispose() {
			const list = cleanups.splice(0);
			for (const fn of list) {
				try { fn(); } catch { /* ignore */ }
			}
			for (const k of ['__watchdog_sessions', '__watchdog_replace_hooked', '__watchdog_rejection_listener', '__watchdog_switch_listener', '__watchdog_version', '__watchdog_lastOpenState']) {
				try { delete window[k]; } catch { /* ignore */ }
			}
			activeObserver = null;
		}

		function snapshotService(label, s) {
			const info = { label, type: typeof s };
			if (s === null || s === void 0) return info;
			try {
				info.keys = Object.keys(s).slice(0, 60);
			} catch (e) {
				info.keysErr = String(e.message);
			}
			try {
				info.proto = Object.getOwnPropertyNames(Object.getPrototypeOf(s) || {}).slice(0, 60);
			} catch (e) {
				info.protoErr = String(e.message);
			}
			info.hasSessionOf = typeof s.sessionOf === 'function';
			info.hasList = typeof s.list === 'function';
			return info;
		}

		// ─────────────────────────── ② 记录器 v2 ───────────────────────────

		/** ★ 安全审查修复（M5）：原来用 `document.body.innerText` —— 它会触发**强制同步重排**，
		 *  而本插件在 **DOM 每次变动**时都要读一次 ⇒ 聊天流式输出时等于每秒做几十上百次全页排版，
		 *  **自己制造了它要诊断的那种卡顿**，观测结果也被自身开销污染。
		 *  改法：① 换 `textContent`（不触发排版）；② 加 **100 ms 节流缓存**，
		 *  把"N 次 DOM 变动 ⇒ N 次全页读取"降成"每 100 ms 最多读一次"。
		 *  ⚠️ 代价：`textContent` 会把**隐藏元素**的文字也算进来，可能偶发"多记一次 loading" ——
		 *  相比"插件自己卡"，这个代价可以接受。 */
		let loadingTextCache = null;
		let loadingTextAt = 0;
		function loadingTextNow() {
			const now = Date.now();
			if (now - loadingTextAt < 100) return loadingTextCache;
			loadingTextAt = now;
			try {
				const t = document.body ? document.body.textContent || '' : '';
				loadingTextCache = null;
				for (const p of LOADING_PATTERNS) if (t.indexOf(p) >= 0) { loadingTextCache = p; break; }
			} catch {
				loadingTextCache = null;
			}
			return loadingTextCache;
		}

		/**
		 * 尽力读某会话的运行态。
		 * ⚠️ 2026-09-25 实测：`sessionOf(id)` 在新客户端里**一律找不到**（它查的是"当前活跃 scope"，
		 *    无头 / 新标签页对不上）；但 `sessions.scopes` 是个 **Map**，key = `session-<uuid>`（**裸的**，
		 *    不带列表里的 `session:` 前缀），`value.binding.session` 里就带着 `openState` / `openError` /
		 *    `openPromise` / `loadingOlder` / `running` / `baseSeq` / `hasMore`。⇒ 优先走 scopes。
		 */
		function readOpenState(sessionKey) {
			try {
				const svc = window.__watchdog_sessions;
				if (!svc) return { tried: false };
				const raw = String(sessionKey || '');
				const stripped = raw.replace(/^session:/, '');
				const uuid = stripped.replace(/^session-/, '');
				const cands = [stripped, 'session-' + uuid, raw, uuid];
				const triedIds = [];

				/** ★ 安全审查修复（H5）：`hookedPromises` 已提升到模块级（见文件上方），此处不再新建。 */

				/** ★ 安全审查修复（H6）：不再把**整个** `activeAttempt.stream`（含会话/助手正文）写进明文日志，
				 *  只记**结构摘要**：条数 + 每条的类型/键 + 一个短哈希 —— 够对照复现，但不泄露正文。 */
				function summarizeStream(stream) {
					try {
						if (!Array.isArray(stream)) return null;
						const items = stream.slice(0, 40).map((r) => {
							if (r === null || typeof r !== 'object') return { t: typeof r };
							let keys = [];
							try { keys = Object.keys(r).slice(0, 12); } catch { keys = []; }
							const chunk = r.chunk;
							const chunkType = chunk !== null && typeof chunk === 'object'
								? (chunk.type === void 0 ? null : String(chunk.type))
								: (chunk === undefined ? 'undefined' : typeof chunk);
							return { type: r.type === void 0 ? null : String(r.type), keys, chunkType };
						});
						let hash = null;
						try {
							const s = JSON.stringify(stream);
							let h = 0;
							for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
							hash = h;
						} catch { hash = null; }
						return { count: stream.length, items, hash };
					} catch {
						return null;
					}
				}

				/** ★ v2.4：包装 `ClientAssistantStream.prototype.replace`，失败时把出错记录的形状落盘。
				 *  为什么必须这样抓：`reason` 字段（900 字上限）会被超长 plugin URL 吃满 ⇒ 看不到坏记录形状；
				 *  而这条钩子能直接拿到 `baseline.activeAttempt.stream` 的形状 + `e.cause`
				 *  （用来区分"裸抛"与"带 cause"两个分支）。
				 *
				 *  ⚠️ **诚实声明（安全审查 H4）**：这**是**一次 monkey-patch —— 它会**原地包装**
				 *     `ClientAssistantStream.prototype.replace`，影响所有共享该原型的实例与调用点。
				 *     行为上保持等价（调用 `orig.call` 后**原样 rethrow**，不吞异常、不改返回值），
				 *     但确实会改变该方法的 `function.name` / `length`，也可能干扰其它插件的同类钩子。
				 *     **如果你不能接受 monkey-patch，删掉下面 `installReplaceHook(...)` 的调用即可**
				 *     （只损失这一项诊断能力，其余功能不受影响）。 */
				function installReplaceHook(svc) {
					try {
						if (window.__watchdog_replace_hooked) return;
						const scopes = svc && svc.scopes;
						if (!(scopes instanceof Map)) return;
						let proto = null;
						for (const entry of scopes.values()) {
							const s = entry && entry.binding && entry.binding.session;
							const as = s && s.assistantStream;
							if (as && typeof as.replace === 'function') { proto = Object.getPrototypeOf(as); break; }
						}
						if (!proto || typeof proto.replace !== 'function') return;
						const orig = proto.replace;
						proto.replace = function (entries, baseline) {
							try {
								return orig.call(this, entries, baseline);
							} catch (e) {
								try {
									const aa = baseline && baseline.activeAttempt;
									const stream = aa && aa.stream;
									post({
										ns: NS, ver: 2, type: 'replace-failed', at: new Date().toISOString(),
										err: String((e && e.message) || e),
										cause: e && e.cause ? String(e.cause.message || e.cause) : null,
										revision: baseline ? baseline.revision : null,
										attemptId: aa ? aa.attemptId : null,
										nextIndex: aa ? aa.nextIndex : null,
										streamLength: Array.isArray(stream) ? stream.length : null,
										entriesLength: Array.isArray(entries) ? entries.length : null,
										stream: summarizeStream(stream)
									});
								} catch { /* ignore */ }
								throw e;
							}
						};
						window.__watchdog_replace_hooked = true;
						onCleanup(() => { try { proto.replace = orig; } catch { /* ignore */ } }); // ★ M6：卸载时还原原型方法
					} catch { /* ignore */ }
				}
				/** ★ v2.3（E 路建议）：attach 到 openPromise，记录它的 resolved / rejected。
				 *  为什么必须这样抓：上游 `dsh-client-ui-workspace:970` 那条链上的 `ready.catch(()=>{})`
				 *  会把 rejection 吞掉 ⇒ 全局 unhandledrejection **根本不会触发**（实测 0 条）。
				 *  这是"真实客户端那次抛的到底是什么异常"的唯一抓手。 */
				function hookOpenPromise(s) {
					try {
						const p = s && s.openPromise;
						if (!p || typeof p.then !== 'function' || hookedPromises.has(p)) return;
						hookedPromises.add(p);
						p.then(
							() => {
								try {
									post({
										ns: NS, ver: 2, type: 'open-promise', result: 'resolved', at: new Date().toISOString(),
										sessionId: s.sessionId === void 0 ? null : String(s.sessionId),
										openState: s.openState === void 0 ? null : s.openState
									});
								} catch { /* ignore */ }
							},
							(err) => {
								try {
									const text = err && (err.stack || err.message) ? String(err.stack || err.message) : String(err);
									post({
										ns: NS, ver: 2, type: 'open-promise', result: 'rejected', at: new Date().toISOString(),
										sessionId: s.sessionId === void 0 ? null : String(s.sessionId),
										errorName: err && err.name ? String(err.name) : null,
										reason: text.slice(0, 900),
										openState: s.openState === void 0 ? null : s.openState
									});
								} catch { /* ignore */ }
							}
						);
					} catch {
						/* ignore */
					}
				}

				const shape = (s) => {
					hookOpenPromise(s);
					return {
						openState: s.openState === void 0 ? null : s.openState,
						openError: s.openError ? String(s.openError).slice(0, 80) : null,
						pending: s.openPromise !== null && s.openPromise !== void 0,
						loadingOlder: s.loadingOlder === void 0 ? null : s.loadingOlder,
						running: s.running === void 0 ? null : s.running,
						baseSeq: s.baseSeq === void 0 ? null : s.baseSeq,
						hasMore: s.hasMore === void 0 ? null : s.hasMore,
						// ★ v2.2：openGeneration 每被 ++ 一次就说明"有人换代"（resync / dispose / failEventStream）
						openGeneration: s.openGeneration === void 0 ? null : s.openGeneration,
						addressMode: s.address === void 0 ? null : (s.address === null ? null : String(s.address.mode === void 0 ? 'addr' : s.address.mode))
					};
				};

				// ① 首选：scopes Map 里直接取（实测唯一可行的路子）
				const scopes = svc.scopes;
				if (scopes instanceof Map) {
					for (const c of cands) {
						if (triedIds.indexOf(c) >= 0) continue;
						triedIds.push(c);
						try {
							const entry = scopes.get(c);
							const s = entry && entry.binding && entry.binding.session;
							if (s) return Object.assign({ tried: true, via: 'scopes', key: c }, shape(s));
						} catch {
							/* 试下一个 key */
						}
					}
				}

				// ② 退路：sessionOf
				if (typeof svc.sessionOf === 'function') {
					for (const c of cands) {
						try {
							const s = svc.sessionOf(c);
							if (s) return Object.assign({ tried: true, via: 'sessionOf', key: c }, shape(s));
						} catch {
							/* 试下一个 */
						}
					}
				}
				return { tried: true, found: false, via: scopes instanceof Map ? 'scopes' : 'none', triedIds, scopeSize: scopes instanceof Map ? scopes.size : null };
			} catch (e) {
				return { tried: true, err: String(e && e.message ? e.message : e).slice(0, 80) };
			}
		}

		function post(record) {
			try {
				fetch(LOG_PATH, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(record), keepalive: true }).catch(() => void 0);
			} catch {
				/* 路由不可用 ⇒ 静默放弃 */
			}
			try {
				window.__watchdog_switch_log = window.__watchdog_switch_log || [];
				window.__watchdog_switch_log.push(record);
				if (window.__watchdog_switch_log.length > 100) window.__watchdog_switch_log.shift();
			} catch {
				/* ignore */
			}
		}

		/** ★ 安全审查修复（M4）：数组硬上限 —— 原来只在"上报时" slice，
		 *  但 25 s 窗口内连点多次会话行会让内存里的数组**无界增长**。 */
		const PUSH_CAP = 60;
		function pushCapped(arr, item) {
			if (arr.length < PUSH_CAP) arr.push(item);
		}
		/** ★ 安全审查修复（M4）：观察 single-flight —— 正在观察时忽略新的点击，
		 *  否则 25 s 内连点 N 次会同时开 N 个 MutationObserver + N 条 50 ms tick 链 + N 份全页文本读取。 */
		let activeObserver = null;

		function observeSwitch(sessionKey, source) {
			if (activeObserver !== null) return; // ★ M4：single-flight
			activeObserver = true; // 闸门；由 cleanup() 释放（最迟 25 s 后）
			const t0 = performance.now();
			const rel = () => Math.round(performance.now() - t0);
			const timeline = [];
			const net = [];
			const netSeen = new Set();
			const openStates = [];
			let firstLoadingMs = null;
			let loadingGoneMs = null;
			let lastLoading = loadingTextNow();
			let lastOpenKey = null;
			let pollCount = 0;
			let maxPollGapMs = 0;
			let lastPollAt = t0;
			let stopped = false;

			if (lastLoading !== null) {
				firstLoadingMs = 0;
				pushCapped(timeline, { ms: 0, ev: 'loading:' + lastLoading });
			} else {
				pushCapped(timeline, { ms: 0, ev: 'no-loading-at-click' });
			}
			pushCapped(timeline, { ms: 0, ev: 'visibility:' + document.visibilityState });

			// ① DOM 观察（观察器回调不依赖定时器 ⇒ 后台标签页也照样能触发）
			let mo = null;
			try {
				mo = new MutationObserver(() => {
					const lt = loadingTextNow();
					if (lt !== lastLoading) {
						lastLoading = lt;
						if (lt !== null) {
							if (firstLoadingMs === null) firstLoadingMs = rel();
							pushCapped(timeline, { ms: rel(), ev: 'loading:' + lt });
						} else {
							if (firstLoadingMs !== null && loadingGoneMs === null) loadingGoneMs = rel();
							pushCapped(timeline, { ms: rel(), ev: 'loading-gone' });
						}
					}
				});
				mo.observe(document.body || document.documentElement, { childList: true, subtree: true, characterData: true });
			} catch {
				/* 观察器不可用 ⇒ 靠轮询兜底 */
			}

			// ② 网络观察（只读，不 patch fetch/XHR）
			let po = null;
			try {
				po = new PerformanceObserver((list) => {
					for (const e of list.getEntries()) {
						if (netSeen.has(e.name)) continue;
						netSeen.add(e.name);
						const p = String(e.name).replace(/^https?:\/\/[^/]+/, '');
						pushCapped(net, { path: p.split('?')[0].slice(0, 90), durMs: Math.round(e.duration) });
					}
				});
				po.observe({ type: 'resource', buffered: false });
			} catch {
				/* 不支持就跳过 */
			}

			// ③ 可见性变化
			const onVis = () => {
				pushCapped(timeline, { ms: rel(), ev: 'visibility:' + document.visibilityState });
			};
			try { document.addEventListener('visibilitychange', onVis); } catch { /* ignore */ }

			const cleanup = () => {
				try { if (mo) mo.disconnect(); } catch { /* ignore */ }
				try { if (po) po.disconnect(); } catch { /* ignore */ }
				try { document.removeEventListener('visibilitychange', onVis); } catch { /* ignore */ }
				activeObserver = null; // ★ M4：释放 single-flight 闸门
			};

			// ④ 轮询兜底 + 记录"实际间隔"（远大于 50ms ⇒ 被节流）
			const tick = () => {
				if (stopped) return;
				const elapsed = rel();
				const nowPerf = performance.now();
				const gap = nowPerf - lastPollAt;
				if (gap > maxPollGapMs) maxPollGapMs = gap;
				lastPollAt = nowPerf;
				pollCount++;

				const lt = loadingTextNow();
				if (lt !== lastLoading) {
					lastLoading = lt;
					if (lt !== null) {
						if (firstLoadingMs === null) firstLoadingMs = elapsed;
						pushCapped(timeline, { ms: elapsed, ev: 'loading:' + lt });
					} else {
						if (firstLoadingMs !== null && loadingGoneMs === null) loadingGoneMs = elapsed;
						pushCapped(timeline, { ms: elapsed, ev: 'loading-gone' });
					}
				}

				const st = readOpenState(sessionKey);
				// ★ v2.2：把 openGeneration 也纳入变化判据 ⇒ 换代本身就会留下一条记录
				const key = st && st.openState !== void 0 && st.openState !== null ? String(st.openState) + '/' + String(st.pending) + '/g' + String(st.openGeneration) : JSON.stringify(st);
				if (key !== lastOpenKey) {
					lastOpenKey = key;
					pushCapped(openStates, { ms: elapsed, state: st });
				}

				const done = firstLoadingMs !== null && loadingGoneMs !== null;
				if (done || elapsed >= OBSERVE_MAX_MS) {
					stopped = true;
					cleanup();
					const sampledMs = rel();
					post({
						ns: NS,
						ver: 2,
						at: new Date().toISOString(),
						sessionKey,
						source: source || 'click',
						firstLoadingMs,
						loadingGoneMs,
						sampledMs,
						pollCount,
						maxPollGapMs: Math.round(maxPollGapMs),
						throttledLikely: maxPollGapMs > 200,
						visibilityAtEnd: document.visibilityState,
						openStates: openStates.slice(0, 12),
						netCount: net.length,
						net: net.slice(0, 25),
						timeline: timeline.slice(0, 40),
						hasSessionsService: !!window.__watchdog_sessions,
						verdict:
							firstLoadingMs === null
								? '没看到加载文案：这次切换是秒开（或页面根本没有加载态）'
								: loadingGoneMs === null
									? '❌ 加载文案持续 ' + sampledMs + ' ms 仍未消失' + (maxPollGapMs > 200 ? '（⚠️ 采样被节流，最长间隔 ' + Math.round(maxPollGapMs) + ' ms，结论需打折）' : '')
									: '✅ 加载文案在 ' + loadingGoneMs + ' ms 后消失' + (maxPollGapMs > 200 ? '（⚠️ 期间采样被节流，最长间隔 ' + Math.round(maxPollGapMs) + ' ms）' : ''),
					});
					return;
				}
				setTimeout(tick, POLL_EVERY_MS);
			};
			setTimeout(tick, POLL_EVERY_MS);
		}

		/** 安装全局「未处理的 rejection」监听：A 路判定 H1（doOpen 把非 RemoteFailure 异常 throw 出去）的关键证据。 */
		function installRejectionListener() {
			try {
				const onRejection = (ev) => {
					try {
						const r = ev && ev.reason;
						const text = r && (r.stack || r.message) ? String(r.stack || r.message) : String(r);
						post({
							ns: NS,
							ver: 2,
							at: new Date().toISOString(),
							type: 'unhandledrejection',
							reason: text.slice(0, 600),
							openState: window.__watchdog_lastOpenState === void 0 ? null : window.__watchdog_lastOpenState
						});
					} catch {
						/* ignore */
					}
				};
				window.addEventListener('unhandledrejection', onRejection);
				window.__watchdog_rejection_listener = true;
				// ★ M6：卸载时移除（原来匿名 ⇒ 永远摘不掉）
				onCleanup(() => { try { window.removeEventListener('unhandledrejection', onRejection); } catch { /* ignore */ } });
			} catch {
				/* ignore */
			}
		}

		/** 点击捕获：只在「点了会话行」时开记录；绝不 preventDefault、绝不改行为。 */
		function installClickListener() {
			try {
				const onClick = (ev) => {
					try {
						const el = ev.target && ev.target.closest ? ev.target.closest('[data-row-key^="session:"]') : null;
						if (!el) return;
						observeSwitch(String(el.getAttribute('data-row-key') || ''), 'click');
					} catch {
						/* ignore */
					}
				};
				document.addEventListener('click', onClick, true);
				window.__watchdog_switch_listener = true;
				// ★ M6：卸载时移除（原来匿名 ⇒ 永远摘不掉）
				onCleanup(() => { try { document.removeEventListener('click', onClick, true); } catch { /* ignore */ } });
			} catch {
				/* ignore */
			}
		}

		// ─────────────────────────── ① 探针 ───────────────────────────

		function apply(ctx) {
			const dump = { ok: true, ns: NS, ver: 2, at: new Date().toISOString(), steps: [] };
			try {
				try {
					dump.ctxKeys = Object.keys(ctx).slice(0, 80);
				} catch (e) {
					dump.ctxKeysErr = String(e.message);
				}

				for (const k of ['sessions', 'sessionProjections', 'store', 'slots', 'locale', 'configForms']) {
					try {
						const v = ctx[k];
						dump.steps.push('ctx.' + k + ' = ' + (v === void 0 ? 'undefined' : typeof v));
					} catch (e) {
						dump.steps.push('ctx.' + k + ' 取值抛错: ' + String(e.message));
					}
				}

				if (typeof ctx.get === 'function') {
					for (const k of ['sessions', 'sessionProjections']) {
						try {
							const v = ctx.get(k);
							dump.steps.push("ctx.get('" + k + "') = " + (v === void 0 ? 'undefined' : typeof v));
						} catch (e) {
							dump.steps.push("ctx.get('" + k + "') 抛错: " + String(e.message));
						}
					}
				}

				if (typeof ctx.inject === 'function') {
					try {
						ctx.inject(['sessions'], (c) => {
							const s = (c && c.sessions) || c;
							window.__watchdog_sessions = s;
							window.__watchdog_version = 2;
							window.__probe_watchdog = Object.assign(window.__probe_watchdog || {}, {
								injected: { at: new Date().toISOString(), service: snapshotService('sessions', s) }
							});
						});
						dump.steps.push('已注册 ctx.inject(["sessions"])');
					} catch (e) {
						dump.steps.push('ctx.inject(["sessions"]) 抛错: ' + String(e.message));
					}
					try {
						ctx.inject(['sessionProjections'], (c) => {
							const s = (c && c.sessionProjections) || c;
							window.__probe_watchdog = Object.assign(window.__probe_watchdog || {}, {
								injectedProj: { at: new Date().toISOString(), service: snapshotService('sessionProjections', s) }
							});
						});
					} catch (e) {
						dump.steps.push('ctx.inject(["sessionProjections"]) 抛错: ' + String(e.message));
					}
				} else {
					dump.steps.push('没有 ctx.inject');
				}
			} catch (e) {
				dump.err = String((e && e.stack) || e);
			}
			window.__probe_watchdog = Object.assign(window.__probe_watchdog || {}, { apply: dump });

			installRejectionListener();
			installClickListener();

			// ★ M6：把卸载清理挂到 ctx.effect（宿主/客户端都会在插件卸载时调用返回的函数）
			try {
				if (ctx !== null && ctx !== void 0 && typeof ctx.effect === 'function') {
					ctx.effect(() => () => dispose());
					dump.steps.push('已注册 ctx.effect(dispose)');
				} else {
					dump.steps.push('无 ctx.effect ⇒ 卸载清理不可用');
				}
			} catch (e) {
				dump.steps.push('ctx.effect(dispose) 抛错: ' + String(e.message));
			}
		}

		const module = { exports: {} };
		module.exports = { name: NS, inject, apply };
		return module.exports;
	}
});
