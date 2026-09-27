/**
 * dsh-open-watchdog — 宿主半边
 * ============================================================================
 *
 * 给「切换会话偶发永久卡死」做**旁观记录**：Host 侧只负责"接收 + 落盘 + 读回"。
 *
 * ⚠️ 安全须知（v0.2.0 按安全审查加固）
 *    DSH 的 `webServer` **不带 TLS / 认证 / 来源策略**，策略由「路由所有者」自负。
 *    所以这两个 handler **自己做四道闸**：
 *      ① 只接受 **loopback** 对端（127.0.0.1 / ::1 / ::ffff:127.0.0.1）；
 *      ② 校验 **Host** 头指向 loopback（防 DNS rebinding）；
 *      ③ 校验 **Origin**：缺失或与 Host 同源才放行（堵 CSRF 跨域写）；
 *      ④ POST 必须 `content-type: application/json`。
 *    ⚠️ 这**不是鉴权** —— 同机其它进程仍可读可写；本插件假定「本机可信、网络不可信」。
 *    若要更强，请把 DSH 的 `host` 保持默认 `127.0.0.1`（别配 `0.0.0.0`）。
 *
 * ⚠️ 写入侧**逐行校验**（修复"日志注入"）：body 必须能 `JSON.parse` 成**对象**，
 *    再重新 `JSON.stringify` 后落盘 ⇒ 一次 POST 无法注入多条伪造记录
 *    （那会毁掉这份证据的可信度，比"写满磁盘"更致命）。
 *
 * ⚠️ 容量防护（修复"写满磁盘"）：单条按**字节**限长、文件总量上限 + 轮转、按对端限速。
 *
 * 路由：
 *   POST /dsh-open-watchdog/log   收一条记录（JSON 对象）
 *   GET  /dsh-open-watchdog/log   读回最近 N 条（默认 50，`?n=200` 可调，上限 500）
 *
 * 落盘：$DSH_HOME/logs/dsh-open-watchdog/switch-log.jsonl（超出上限时轮转为 .1）
 */

import { appendFileSync, mkdirSync, existsSync, statSync, renameSync, lstatSync, openSync, readSync, closeSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const name = 'dsh-open-watchdog';

const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const LOG_DIR = path.join(DSH_HOME, 'logs', 'dsh-open-watchdog');
const LOG_FILE = path.join(LOG_DIR, 'switch-log.jsonl');
const LOG_FILE_ROTATED = LOG_FILE + '.1';

/** 单条记录的最大**字节**数（不是字符数 —— 中文 UTF-8 是 3 字节）。 */
const MAX_RECORD_BYTES = 192 * 1024;
/** 日志文件总量上限：超过就轮转（只留一代），防止被灌满磁盘。 */
const MAX_LOG_BYTES = 32 * 1024 * 1024;
/** 读回时最多读取的字节数（只读尾部，别把 GB 级文件整个读进内存）。 */
const MAX_READ_BYTES = 4 * 1024 * 1024;
/** GET 单次最多返回条数。 */
const MAX_RETURN = 500;
/** 每个对端的限速：窗口内最多多少次写入。 */
const RATE_WINDOW_MS = 10_000;
const RATE_MAX = 60;

const rateBuckets = new Map();

/**
 * 跨机部署开关（2026-09-28 新增，主人定：「**写明 allowHosts 开关，否则默认坚挺本机**」）。
 *
 * ⚠️ **默认空 ⇒ 只允许 loopback**（与 v0.2.0 行为一致，安全默认不变）。
 * 需要「浏览器在另一台机器、经 LAN / Tailscale 访问宿主」时，**两个都要设**：
 *   DSH_OPEN_WATCHDOG_ALLOW_HOSTS="10.0.0.5,10.0.0.5:3080"    # Host 头白名单（**精确**匹配，可带端口）
 *   DSH_OPEN_WATCHDOG_ALLOW_PEERS="10.0.0.0/24,192.168.0.0/16"  # 来源白名单（精确 IP 或 CIDR；示例网段，换成你自己的）
 * 只设其中一个 ⇒ 另一个闸门仍会 403（这正是"默认坚挺本机"的体现）。
 * ⚠️ 这是**显式开关**，不是把闸门关掉：白名单之外仍然 403。
 */
const ALLOW_HOSTS = parseAllowList(process.env.DSH_OPEN_WATCHDOG_ALLOW_HOSTS);
const ALLOW_PEERS = parseAllowList(process.env.DSH_OPEN_WATCHDOG_ALLOW_PEERS);

function parseAllowList(value) {
	return String(value || '')
		.split(',')
		.map((s) => s.trim().toLowerCase())
		.filter((s) => s !== '');
}

/** 去掉 Host 头的端口（`[::1]:3080` 这种 IPv6 形式也处理）。返回 `''` 表示**这个 Host 头不合法**。
 *  🩸 v2.4 加固（2026-09-27 红队两路都报了）：原来只按 `lastIndexOf(':')` 切，
 *  于是 `Host: 10.0.0.5:3080@evil.com`、`10.0.0.5:3080:evil.com` 会被切出"裸主机名 `10.0.0.5`"
 *  而**命中白名单**（违反"精确匹配"承诺）。浏览器造不出这种 Host，但解析不该这么松。 */
function hostWithoutPort(hostHeader) {
	const h = String(hostHeader || '').toLowerCase().trim();
	if (h === '') return '';
	if (h.includes('@') || /[\s\u0000-\u001f]/.test(h)) return '';
	if (h.startsWith('[')) {
		const end = h.indexOf(']');
		if (end < 0) return '';
		const rest = h.slice(end + 1);
		if (rest === '') return h.slice(0, end + 1);
		return /^:\d{1,5}$/.test(rest) ? h.slice(0, end + 1) : '';
	}
	const colon = h.lastIndexOf(':');
	if (colon >= 0) {
		const port = h.slice(colon + 1);
		if (!/^\d{1,5}$/.test(port)) return '';
		const hostPart = h.slice(0, colon);
		if (hostPart.includes(':')) return ''; // 非方括号的 IPv6 / 多余冒号 ⇒ 拒
		return hostPart;
	}
	return h;
}

/** Host 头是否被允许（loopback，或白名单里**精确**命中 `10.0.0.5` / `10.0.0.5:3080`）。 */
function hostAllowed(hostHeader) {
	if (isLoopbackHost(hostHeader)) return true;
	if (ALLOW_HOSTS.length === 0) return false;
	const raw = String(hostHeader || '').toLowerCase().trim();
	const bare = hostWithoutPort(raw);
	return ALLOW_HOSTS.some((entry) => entry === raw || entry === bare);
}

/** 把 `::ffff:10.0.0.5` 归一成 `10.0.0.5`。 */
function normalizePeerAddr(addr) {
	let a = String(addr || '').toLowerCase().trim();
	if (a.startsWith('::ffff:')) a = a.slice(7);
	return a;
}

function ipv4ToInt(s) {
	const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
	if (m === null) return null;
	const parts = m.slice(1).map((x) => Number(x));
	if (parts.some((p) => p > 255)) return null;
	return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

function inCidr(addr, cidr) {
	const slash = cidr.indexOf('/');
	if (slash < 0) return false;
	const rawBits = cidr.slice(slash + 1);
	// 🩸 严格校验位数（2026-09-27 红队 A 发现）：`Number('') === 0` ⇒ `'10.0.0.0/'` 会被当成 `/0`
	// ⇒ mask=0 ⇒ 恒真 ⇒ **一个字符的配置残尾就让白名单形同不存在**（实测公网 peer 也被放行）。
	if (!/^\d{1,2}$/.test(rawBits)) return false;
	const bits = Number(rawBits);
	if (bits < 0 || bits > 32) return false;
	const ip = ipv4ToInt(addr);
	const base = ipv4ToInt(cidr.slice(0, slash));
	if (ip === null || base === null) return false;
	const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
	return (ip & mask) === (base & mask);
}

/** 来源地址是否被允许（loopback，或白名单里的精确 IP / CIDR）。 */
function peerAllowed(addr) {
	if (isLoopbackAddress(addr)) return true;
	if (ALLOW_PEERS.length === 0) return false;
	const a = normalizePeerAddr(addr);
	return ALLOW_PEERS.some((entry) => (entry.includes('/') ? inCidr(a, entry) : entry === a));
}

function isLoopbackAddress(addr) {
	const a = String(addr || '').toLowerCase();
	return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
}

/** Host 头是否是 loopback（防 DNS rebinding：攻击域解析到 127.0.0.1 后 Host 仍是 evil.com）。 */
function isLoopbackHost(hostHeader) {
	const h = String(hostHeader || '').toLowerCase().trim();
	if (h === '') return false;
	// 去掉端口
	let host = h;
	if (host.startsWith('[')) {
		const end = host.indexOf(']');
		host = end >= 0 ? host.slice(0, end + 1) : host;
	} else {
		const colon = host.lastIndexOf(':');
		if (colon >= 0) host = host.slice(0, colon);
	}
	return host === '127.0.0.1' || host === 'localhost' || host === '[::1]' || host === '::1';
}

/** 取出 Host 头里的端口（没有则返回 null）。`[::1]:3080` 也处理。 */
function hostPort(hostHeader) {
	const h = String(hostHeader || '').toLowerCase().trim();
	if (h === '') return null;
	if (h.startsWith('[')) {
		const end = h.indexOf(']');
		if (end < 0) return null;
		const rest = h.slice(end + 1);
		return rest.startsWith(':') ? rest.slice(1) : null;
	}
	const colon = h.lastIndexOf(':');
	return colon >= 0 ? h.slice(colon + 1) : null;
}

/**
 * 请求是否来自"可信的页面"：
 * ① 对端必须是 loopback，或 `DSH_OPEN_WATCHDOG_ALLOW_PEERS` 白名单里的精确 IP / CIDR；
 * ② Host 必须指向 loopback，或 `DSH_OPEN_WATCHDOG_ALLOW_HOSTS` 白名单里**精确**命中；
 * ③ Origin 缺失（非浏览器客户端）或**与 Host 完整同源**（协议 + 主机 + 端口）。
 *
 * 🩸 **v2.4 修正（2026-09-27 红队 A 实测推翻旧注释）**：
 *   旧注释写「攻击者的页面无法让这两者相等」—— **那是错的**。旧实现只比 **hostname**，
 *   于是「同机另一个端口」的页面（**异源**）也能通过；红队用真浏览器实测：页面 `127.0.0.1:18098`
 *   → 目标 `127.0.0.1:18099`，**伪记录成功落盘**。
 *   ⇒ 现在比 **`URL.origin`**（协议 + 主机 + 端口），Host 头没写端口时才不比端口。
 * 🩸 另：`Origin: null`（`<iframe sandbox>` / `data:` / `file:`）**对写路径一律拒** ——
 *   它不携带任何来源信息，红队实测它能**四闸全过**并让伪记录落盘。
 * ⚠️ 但要说清：**①② 才是主闸**。Host / Origin 都是**客户端可伪造的头** ⇒ 对非浏览器客户端，
 *   真正拦得住的是 `ALLOW_PEERS`（这也是"它被写错一个字符就等于白名单不存在"很严重的原因）。
 */
function checkTrusted(req) {
	const socketAddr = req?.socket?.remoteAddress;
	if (!peerAllowed(socketAddr)) return { ok: false, code: 403, reason: 'peer not allowed' };
	const host = req?.headers?.host;
	if (!hostAllowed(host)) return { ok: false, code: 403, reason: 'host not allowed' };
	const origin = req?.headers?.origin;
	if (origin !== undefined && origin !== null && String(origin) !== '') {
		if (String(origin) === 'null') return { ok: false, code: 403, reason: 'null origin rejected' };
		try {
			const o = new URL(String(origin));
			// ⚠️ 协议维度只能这样判：**DSH 的 `webServer` 不带 TLS** ⇒ 本服务永远是 `http:`
			//    ⇒ 任何 `https:` 的 Origin 一律拒。（Host 头不携带协议，无法与它比较。）
			//    本鲸第一版写成 `protocol === 'http:' || protocol === 'https:'` —— 那是恒真，等于没判，
			//    被自己的回归用例 R5 抓出来。
			const sameProto = o.protocol === 'http:';
			// 🩸 缺陷 D（2026-09-27 红队最终报告，中危）：**两侧必须同一规范化**。
			//    原来只给 Host 侧剥方括号，而 `new URL('http://[::1]:3080').hostname` 自带 `[::1]`
			//    ⇒ 两边不对称 ⇒ 合法的 IPv6 同源被静默拒（实测 `Host: [::1]:3080` + `Origin: http://[::1]:3080` 变 403）。
			const bareHost = (h) => String(h || '').replace(/^\[|\]$/g, '').toLowerCase();
			const sameHost = bareHost(o.hostname) === bareHost(hostWithoutPort(host));
			const originPort = o.port !== '' ? o.port : (o.protocol === 'https:' ? '443' : '80');
			const hp = hostPort(host);
			const samePort = hp === null || hp === originPort;
			if (!sameProto || !sameHost || !samePort) return { ok: false, code: 403, reason: 'cross-origin' };
		} catch {
			return { ok: false, code: 403, reason: 'bad origin' };
		}
	}
	return { ok: true };
}

function rateLimited(key) {
	const now = Date.now();
	const bucket = rateBuckets.get(key);
	if (bucket === undefined || now - bucket.start > RATE_WINDOW_MS) {
		rateBuckets.set(key, { start: now, count: 1 });
		return false;
	}
	bucket.count += 1;
	if (bucket.count > RATE_MAX) return true;
	return false;
}

function writeJson(res, code, obj) {
	try {
		res.writeHead(code, {
			'content-type': 'application/json; charset=utf-8',
			'cache-control': 'no-store',
			'x-content-type-options': 'nosniff',
		});
		res.end(JSON.stringify(obj));
	} catch {
		/* 连接已死，忽略 */
	}
}

/** 读 body，返回 { text, bytes, truncated }。按**字节**计数，超限即标记 truncated 并断开。 */
function readBody(req, maxBytes) {
	return new Promise((resolve) => {
		const chunks = [];
		let bytes = 0;
		let truncated = false;
		let settled = false;
		const done = () => {
			if (settled) return;
			settled = true;
			resolve({ text: Buffer.concat(chunks).toString('utf8'), bytes, truncated });
		};
		try {
			req.on('data', (chunk) => {
				if (truncated) return;
				bytes += chunk.length;
				if (bytes > maxBytes) {
					truncated = true;
					try { req.destroy(); } catch { /* ignore */ }
					done();
					return;
				}
				chunks.push(chunk);
			});
			req.on('end', done);
			req.on('error', done);
			req.on('close', done);
		} catch {
			done();
		}
	});
}

/** 日志文件超上限就轮转（留一代），返回是否发生了轮转。 */
function rotateIfNeeded() {
	try {
		if (!existsSync(LOG_FILE)) return false;
		if (statSync(LOG_FILE).size <= MAX_LOG_BYTES) return false;
		renameSync(LOG_FILE, LOG_FILE_ROTATED);
		return true;
	} catch {
		return false;
	}
}

/** 只读日志尾部（真·只读尾部：openSync/readSync 定位读，不把大文件整个读进内存）。 */
function readTail(maxBytes) {
	if (!existsSync(LOG_FILE)) return { lines: [], size: 0, tailTruncated: false };
	const size = statSync(LOG_FILE).size;
	const start = Math.max(0, size - maxBytes);
	const len = size - start;
	let text = '';
	if (len > 0) {
		const buf = Buffer.allocUnsafe(len);
		const fd = openSync(LOG_FILE, 'r');
		try {
			let read = 0;
			while (read < len) {
				const got = readSync(fd, buf, read, len - read, start + read);
				if (got <= 0) break;
				read += got;
			}
			text = buf.subarray(0, read).toString('utf8');
		} finally {
			try { closeSync(fd); } catch { /* ignore */ }
		}
	}
	// 若从中间截断，丢掉第一段残行
	if (start > 0) {
		const nl = text.indexOf('\n');
		text = nl >= 0 ? text.slice(nl + 1) : '';
	}
	const lines = text.split('\n').filter((l) => l.trim().length > 0);
	return { lines, size, tailTruncated: start > 0 };
}

export function apply(ctx) {
	try {
		ctx?.logger?.info?.('[dsh-open-watchdog] host half loaded（只读探针的记录端；已按安全审查加固）');
	} catch {
		/* 打不出日志不影响加载 */
	}

	// 🩸 启动期把白名单策略**打出来**（2026-09-27 红队 A 要求：不能再静默）。
	//    动机：`ALLOW_PEERS` 是"非浏览器客户端面前唯一真闸"，配错一个字符就等于白名单不存在
	//    （红队实测 `ALLOW_PEERS='10.0.0.0/'` 会被当成 `/0` 放行一切 IPv4），而旧版**零启动日志** ⇒ 无从发现。
	try {
		const hostEnv = String(process.env.DSH_OPEN_WATCHDOG_ALLOW_HOSTS || '').trim();
		const peerEnv = String(process.env.DSH_OPEN_WATCHDOG_ALLOW_PEERS || '').trim();
		if (hostEnv === '' && peerEnv === '') {
			ctx?.logger?.info?.('[dsh-open-watchdog] 四道闸策略：**只允许 loopback**（未配置白名单）');
		} else {
			ctx?.logger?.info?.(
				'[dsh-open-watchdog] 四道闸策略：白名单已启用 ⇒ HOSTS=[' + ALLOW_HOSTS.join(', ') + '] PEERS=[' + ALLOW_PEERS.join(', ') + ']',
			);
			const cidrRe = /^\d{1,3}(\.\d{1,3}){3}\/\d{1,2}$/;
			const badPeers = ALLOW_PEERS.filter((e) => e.includes('/') && !cidrRe.test(e));
			if (badPeers.length > 0) {
				ctx?.logger?.warn?.('[dsh-open-watchdog] ⚠️ 以下 PEERS 白名单项**无法解析**（永不匹配、等于没写）：' + badPeers.join(', '));
			}
			const allOpen = ALLOW_PEERS.filter((e) => /\/0$/.test(e));
			if (allOpen.length > 0) {
				ctx?.logger?.warn?.('[dsh-open-watchdog] ⚠️ 白名单含 /0 ⇒ 等于**放行整个 IPv4 空间**：' + allOpen.join(', '));
			}
		}
	} catch {
		/* 日志失败不影响加载 */
	}

	let registered = false;
	let tries = 0;
	let timer = null;

	const tryRegister = () => {
		if (registered) return;
		tries += 1;
		let ws;
		try {
			ws = typeof ctx?.get === 'function' ? ctx.get('webServer') : undefined;
		} catch {
			ws = undefined;
		}
		if (ws === undefined || typeof ws.register !== 'function') {
			if (tries >= 20) {
				// M7 修复：不能只 warn 一句就永久放弃 —— 要"响亮"地留下痕迹
				try {
					ctx?.logger?.error?.('[dsh-open-watchdog] webServer 20s 内未就绪：路由未注册，浏览器半边的记录将全部丢失（POST 会失败）。请检查插件加载顺序。');
				} catch { /* ignore */ }
				try {
					mkdirSync(LOG_DIR, { recursive: true });
					appendFileSync(
						path.join(LOG_DIR, 'route-not-registered.log'),
						`[${new Date().toISOString()}] webServer not ready after ${tries} tries; route NOT registered; records will be lost.\n`,
						'utf8',
					);
				} catch { /* ignore */ }
				return;
			}
			timer = setTimeout(tryRegister, 1000);
			return;
		}

		const registerOne = (route) => {
			try {
				ctx.effect(() => ws.register(route));
				return true;
			} catch (e) {
				try { ctx?.logger?.warn?.(`[dsh-open-watchdog] 路由 ${route.path} 注册失败: ${e?.message ?? String(e)}`); } catch { /* ignore */ }
				return false;
			}
		};

		registerOne({
			kind: 'exact',
			path: '/dsh-open-watchdog/log',
			handler: (req, res) => {
				// ① 可信来源四道闸
				const trust = checkTrusted(req);
				if (!trust.ok) {
					try { ctx?.logger?.warn?.(`[dsh-open-watchdog] 拒绝请求：${trust.reason}`); } catch { /* ignore */ }
					writeJson(res, trust.code, { ok: false, error: trust.reason });
					return;
				}

				const method = (req?.method || 'GET').toUpperCase();

				if (method === 'POST') {
					// 🩸 v2.4 修正（2026-09-27 红队 A 发现）：原来是 `ct.includes('application/json')`，
					//   于是 `Content-Type: text/plain; application/json` 会**通过** —— 而它的
					//   MIME essence 是 `text/plain`，属于 **CORS 简单请求**（不触发预检），
					//   ⇒ 正好是 CSRF 能被真浏览器"一键利用"的使能条件。改为**严格解析 MIME essence**。
					const ctRaw = String(req?.headers?.['content-type'] || '');
					const essence = ctRaw.split(';')[0].trim().toLowerCase();
					if (essence !== 'application/json') {
						writeJson(res, 415, { ok: false, error: 'content-type must be application/json' });
						return;
					}
					const peer = String(req?.socket?.remoteAddress || '?');
					if (rateLimited(peer)) {
						writeJson(res, 429, { ok: false, error: 'rate limited' });
						return;
					}
					void (async () => {
						const { text, bytes, truncated } = await readBody(req, MAX_RECORD_BYTES);
						if (truncated) {
							// M2 修复：截断/超限 ⇒ **不落盘**（半截 JSON 会污染证据）
							writeJson(res, 413, { ok: false, error: 'payload too large or truncated', bytes });
							return;
						}
						// H3 修复：必须能解析成**对象**，再重新序列化落盘（剥掉内部换行 ⇒ 无法注入多条）
						let record;
						try {
							record = JSON.parse(text);
						} catch {
							writeJson(res, 400, { ok: false, error: 'body must be a JSON object' });
							return;
						}
						if (record === null || typeof record !== 'object' || Array.isArray(record)) {
							writeJson(res, 400, { ok: false, error: 'body must be a JSON object' });
							return;
						}
						let line;
						try {
							line = JSON.stringify(record) + '\n';
						} catch {
							writeJson(res, 400, { ok: false, error: 'body is not serializable' });
							return;
						}
						const lineBytes = Buffer.byteLength(line, 'utf8');
						if (lineBytes > MAX_RECORD_BYTES) {
							writeJson(res, 413, { ok: false, error: 'record too large', bytes: lineBytes });
							return;
						}
						try {
							mkdirSync(LOG_DIR, { recursive: true });
							// L2：拒绝写入"指向别处的符号链接"
							try { if (lstatSync(LOG_FILE).isSymbolicLink()) { writeJson(res, 500, { ok: false, error: 'log file is a symlink; refusing' }); return; } } catch { /* 不存在 ⇒ 正常 */ }
							rotateIfNeeded();
							appendFileSync(LOG_FILE, line, 'utf8');
							writeJson(res, 200, { ok: true, bytes: lineBytes });
						} catch (e) {
							// M8 修复：错误细节进服务端日志，响应只回一个 code
							try { ctx?.logger?.warn?.(`[dsh-open-watchdog] 写入失败: ${e?.message ?? String(e)}`); } catch { /* ignore */ }
							writeJson(res, 500, { ok: false, error: 'write failed' });
						}
					})();
					return;
				}

				// GET：读回最近 N 条
				try {
					const url = String(req?.url || '');
					const m = /[?&]n=(\d+)/.exec(url);
					const n = Math.min(Math.max(Number(m?.[1] ?? 50), 1), MAX_RETURN);
					const { lines, size, tailTruncated } = readTail(MAX_READ_BYTES);
					const tail = lines.slice(-n);
					const records = tail.map((l) => {
						try { return JSON.parse(l); } catch { return { parseError: true }; }
					});
					// M8 修复：不回传 `file` 绝对路径
					writeJson(res, 200, {
						ok: true,
						total: lines.length,
						count: records.length,
						logBytes: size,
						tailTruncated,
						records,
					});
				} catch (e) {
					try { ctx?.logger?.warn?.(`[dsh-open-watchdog] 读取失败: ${e?.message ?? String(e)}`); } catch { /* ignore */ }
					writeJson(res, 500, { ok: false, error: 'read failed' });
				}
			},
		});

		registered = true;
		try { ctx?.logger?.info?.(`[dsh-open-watchdog] 路由已注册（第 ${tries} 次尝试）: /dsh-open-watchdog/log`); } catch { /* ignore */ }
	};

	tryRegister();

	// 插件卸载时停掉重试定时器
	try {
		ctx?.effect?.(() => () => { if (timer !== null) clearTimeout(timer); });
	} catch {
		/* ignore */
	}
}
