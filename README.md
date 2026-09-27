# dsh-open-watchdog

**一个只读探针：记录"切换会话"时到底发生了什么。** 它不修任何东西、不改任何行为 —— 只观察、只记录。

**English:** **A read-only probe that records what actually happens when you switch sessions.** It fixes nothing and changes nothing — it only observes and records.

> ⚠️ **它只做一件事：把"卡顿现场"变成可读取的证据。** 典型用途：DSH 界面偶发"切到某个会话后一直显示『载入历史』"，但刷新就好、且控制台没有任何报错 —— 这种问题**只在真实用户的客户端里才复现**，日志里查不到。装上这个探针，它会把那一次的**时间线**记下来。

**English:** ⚠️ **It does exactly one thing: turn a "hang on the spot" into readable evidence.** Typical use case: DSH occasionally shows "loading history" forever after switching to a session, but a refresh fixes it and the console shows no error — that kind of problem **only reproduces inside a real user's client**, so it leaves no trace in server logs. With this probe installed, the **timeline** of that occurrence gets recorded.

---

## 它记录什么 / What it records

每次你**点击一个会话行**，它会采样这一次切换的全过程，产出一条 JSON：

**English:** Every time you **click a session row**, it samples that switch and produces one JSON record:

| 字段 / Field | 含义 / Meaning |
|---|---|
| `at` | 记录时间（ISO）/ when the record was written |
| `sessionKey` | 哪个会话（`session:<id>`）/ which session |
| `source` | 触发方式（目前是 `click`，也支持探针主动采样）/ how it was triggered |
| `firstLoadingMs` | 从点击到**首次看到「载入历史」文案**的毫秒数 / ms from click to first sighting of the loading text |
| `loadingGoneMs` | 从点击到**该文案消失**的毫秒数（**核心指标**）/ ms from click until that text disappears (**the key number**) |
| `sampledMs` | 本次观察总时长 / total observation time |
| `pollCount` / `maxPollGapMs` | 采样次数 / 每次采样的**实际间隔**最大值 —— ⚠️ **浏览器会对后台标签页降频**，这个字段用来判断"数字是不是被节流污染了" / poll count and the **largest actual gap** between samples — ⚠️ browsers throttle background tabs, so this tells you whether the numbers were distorted |
| `throttledLikely` | `maxPollGapMs` 明显偏大时为 `true` ⇒ **那组数字要打折看** / `true` when the gap is clearly too large ⇒ discount those numbers |
| `visibilityAtEnd` | 结束时标签页可见性（`visible` / `hidden`）/ tab visibility at the end |
| `openStates` | 过程中采到的状态快照（`openState` / `openError` / `running` / `baseSeq` / `hasMore` …）/ snapshots of the session state during the switch |
| `netCount` / `net` | 期间发起的网络请求（路径 + 耗时，**只读采样**）/ network requests during the switch (path + duration, **read-only sampling**) |
| `timeline` | 关键事件序列（如 `loading:载入历史` / `visibility:visible`）/ key events |
| `verdict` | 一句话结论（例如「加载文案在 50 ms 后消失」）/ a one-line verdict |
| `type: "open-promise"` | 另有一类记录：`open()` 那个 promise 最终是 `resolved` 还是 `rejected`（**这是抓"真实抛的是什么异常"的通路**）/ a second record kind: whether the `open()` promise ended `resolved` or `rejected` |
| `type: "replace-failed"` | ⚠️ **当前版本不会产生这条记录**（原因见「只读承诺」节：钩子已预留，但没有调用点）。启用后它会在会话历史展开失败时记录**病因 + 出错记录的"形状 dump"**（键 / 描述符标志 / 原型 / 原生构造器串）/ ⚠️ **not produced in the current version** (see the read-only promise section: the hook exists but has no call site). When enabled, it records the **cause plus a "shape dump"** of the offending record when stream expansion fails |

---

## 安装 / Install

把它当作一个普通的 DSH 插件（`package.json` 里已经声明了 `dsh.bundle.patch` 与 `dsh.client`）：

**English:** Treat it as a normal DSH plugin (`package.json` already declares `dsh.bundle.patch` and `dsh.client`):

```bash
# 1) 放进 DSH 的插件目录（示例：用户 profile 的 vendor 下）
#    Put it under DSH's plugin directory (example: your profile's vendor dir)

# 2) 让 DSH 知道这个包（按你的 DSH 版本的方式：包装在 profile 的 package.json / 或用 link:）
#    Register the package the way your DSH version expects

# 3) ⚠️ 必须重启 dsh web —— 客户端 bundle 是【启动时快照】的
#    ⚠️ You MUST restart `dsh web` — client bundles are snapshotted at startup
```

⚠️ **重启 `dsh web` 之后，还要刷新一次浏览器页面**（新 bundle 才会被加载）。
**English:** ⚠️ After restarting `dsh web`, **refresh the browser page once** so the new bundle is loaded.

---

## 读取记录 / Reading the records

**方式 1 —— 直接看文件 / Way 1 — read the file directly**

```bash
# Windows
type %USERPROFILE%\.dsh\logs\dsh-open-watchdog\switch-log.jsonl
# *nix
tail -n 20 ~/.dsh/logs/dsh-open-watchdog/switch-log.jsonl
```

**方式 2 —— 通过宿主路由读回（推荐，机器可读）/ Way 2 — read it back over the host route (recommended)**

```
GET /dsh-open-watchdog/log        # 最近 50 条 / latest 50
GET /dsh-open-watchdog/log?n=200  # 最近 200 条（上限 500）/ latest 200 (max 500)
```

返回 `{ ok, total, count, file, records: [...] }`。
**English:** Returns `{ ok, total, count, file, records: [...] }`.

---

## ⚠️ 只读承诺（以及它不做什么）/ Read-only promise (and what it never does)

本插件**永远**不会：

- 点击任何按钮、改动任何 DOM 结构；
- 写 `openState` / `openError` / 任何会话状态；
- 发起**非记录类**请求（它只往 `/dsh-open-watchdog/log` POST 自己的记录）；
- 吞掉会让宿主受损的异常（所有回调都包了 `try/catch`，失败只会少一条记录）。

⚠️ **更正（2026-09-27）：其实一处例外也没有。** 代码里**预留**了一个可选钩子 `installReplaceHook()` ——
**被调用时**它会**原地包装** `ClientAssistantStream.prototype.replace`（一次真正的 monkey-patch：行为等价、
调用原方法后**原样 rethrow**、不吞异常、不改返回值；但会改变该方法的 `function.name` / `length`，
也可能干扰其它插件的同类钩子）—— 但**当前版本没有任何调用点** ⇒ 它**不会发生**，
第三类 `replace-failed` 记录**也不会产生**。这处「文档比实现更吓人」的不一致由本仓自己的审查发现并在此更正；
要启用须自行加调用，且该路径**未经安全审查**。

**English:** This plugin **never**: clicks buttons or mutates the DOM; writes `openState` / `openError` / any session state; makes **non-recording** requests; swallows exceptions that could damage the host. ⚠️ **Correction (2026-09-27): there is no exception at all.** The code ships an optional hook, `installReplaceHook()` — *if called*, it wraps `ClientAssistantStream.prototype.replace` in place (a real monkey-patch: behaviour-equivalent, calls the original and **re-throws as-is**, but it does change that method's `function.name` / `length` and may interfere with other plugins' hooks) — **but the current version has no call site**, so it **never runs** and the third record kind, `replace-failed`, **is never produced**. We found this "docs scarier than the implementation" mismatch in our own review and are correcting it here; enabling it requires adding the call yourself, and that path has **not** been security-reviewed.

⚠️ **它用的全是浏览器自带的只读观察器**：`MutationObserver`（DOM 变化）+ `PerformanceObserver`（网络采样）。**不用定时器轮询判断状态变化** —— 因为后台标签页的定时器会被降频，那会让测量结果失真。
**English:** ⚠️ It relies only on the browser's built-in read-only observers: `MutationObserver` (DOM changes) + `PerformanceObserver` (network sampling). It deliberately **does not use timer polling to detect state changes**, because timers in background tabs get throttled and that would distort the measurements.

---

## 🔒 安全说明（v0.2.0 按安全审查加固）/ Security notes (hardened in v0.2.0)

宿主侧的 `/dsh-open-watchdog/log` 路由**自己**做四道闸 —— 因为 DSH 的 `webServer` **不自带 TLS / 认证 / 来源策略**
（框架 README 明确写「No server-wide TLS, authentication, or origin policy」，策略由**路由所有者**自负）：

| 闸 / Gate | 规则 / Rule |
|---|---|
| 对端 / Peer | 只接受 **loopback**（`127.0.0.1` / `::1` / `::ffff:127.0.0.1`），**或** `DSH_OPEN_WATCHDOG_ALLOW_PEERS` 白名单里的精确 IP / CIDR ⇒ 其余 **403** |
| Host 头 | 必须指向 loopback，**或** `DSH_OPEN_WATCHDOG_ALLOW_HOSTS` 白名单里**精确**命中（**防 DNS rebinding**：攻击域解析到 127.0.0.1 后 Host 仍是 `evil.com`）⇒ 其余 **403** |
| Origin | 缺失，或**与 Host 同源**才放行（**堵 CSRF 跨域写**：`text/plain` POST 属 simple request、不触发预检）⇒ 跨域 **403** |
| Content-Type | POST 必须 `application/json` ⇒ 其它 **415** |

#### 🚪 跨机部署：`allowHosts` / `allowPeers` 开关（**默认关闭 = 只允许本机**）

**两个开关默认都是空的 ⇒ 行为与上表完全一致，安全默认不变。**

当**浏览器不在宿主那台机器上**时（例：宿主 Linux、浏览器在另一台 macOS，经 LAN / Tailscale 访问 `http://10.0.0.5:3080`），
四道闸会把请求**全部 403**，而浏览器侧的写失败是 `.catch(() => void 0)` **静默吞掉**的
⇒ 现象是「**插件装好了、路由也注册了，但一条记录都没有**」。（`2286721642` 在 Discussion #7802 的实测反馈。）

| 解法 / Fix | 做法 / How | 适用 / When |
|---|---|---|
| **A. 白名单开关** | 宿主上设两个环境变量：<br>`DSH_OPEN_WATCHDOG_ALLOW_HOSTS="10.0.0.5,10.0.0.5:3080"`<br>`DSH_OPEN_WATCHDOG_ALLOW_PEERS="10.0.0.0/24"` | 长期使用、想省事 |
| **B. 本地转发** | `ssh -N -L 3080:127.0.0.1:3080 <host>`，浏览器改访问 `http://127.0.0.1:3080` | 临时抓现场（**四闸全过，且不需要放宽任何闸门**） |

**开关语义 / Semantics**：

- `DSH_OPEN_WATCHDOG_ALLOW_HOSTS` = **Host 头白名单**，**精确**匹配，可带端口（`10.0.0.5` 与 `10.0.0.5:3080` 都算命中）；
- `DSH_OPEN_WATCHDOG_ALLOW_PEERS` = **来源白名单**，精确 IP 或 **CIDR**（如 `10.0.0.0/24`、`192.168.0.0/16`；**换成你自己的网段**）；
- ⚠️ **两个都要设**：只设一个 ⇒ 另一个闸门仍会 403（这正是"默认坚挺本机"的体现）；
- ⚠️ 这是**显式放宽**、不是关闸：**白名单之外仍然 403**；
- ⚠️ 白名单内的来源**可以带任意被允许的 Host** ⇒ 白名单要按"这个网段我信得过"来给，**别给整段公网**。

**English:** Both whitelists are **empty by default ⇒ loopback only** (identical to the table above; the safe default is unchanged). When the browser runs on a **different machine** than the host (e.g. Linux host + macOS browser over LAN/Tailscale at `http://10.0.0.5:3080`), all four gates return **403** and the browser-side failure is **silently swallowed** by `.catch(() => void 0)` — the symptom is "**installed, route registered, but zero records**" (field report by `2286721642` in Discussion #7802). Two fixes: **(A)** set `DSH_OPEN_WATCHDOG_ALLOW_HOSTS` (exact Host match, port optional) **and** `DSH_OPEN_WATCHDOG_ALLOW_PEERS` (exact IP or **CIDR**) on the host; **(B)** use an SSH local forward (`ssh -N -L 3080:127.0.0.1:3080 <host>`) and browse `http://127.0.0.1:3080` — all four gates pass without relaxing anything. ⚠️ **You must set both** — setting only one leaves the other gate returning 403 (that is "loopback by default" working as intended). ⚠️ This is an **explicit widening, not a bypass**: everything outside the whitelist still gets **403**. ⚠️ A whitelisted peer may present any allowed Host, so scope the whitelist to a network you trust — **never a whole public range**.

#### ⚠️ v2.4 起第③道闸更严了（手工测试时注意）

第③道闸改为 **完整同源**判定（**协议 + 主机 + 端口**）。红队用 90 格矩阵实测：旧 → 新有 **14 格从「放行」变成「拒绝」，无一格变松**，
且全部是 **loopback 别名混用**（`Host: 127.0.0.1` + `Origin: http://localhost` 这类）—— **真实浏览器不会产生这种不一致**，实际代价 ≈ 0。
但如果你**手工用 curl 测**，请把 `Origin` 的 host 与 `Host` 头写成**同一个字面**（`127.0.0.1` 就都写 `127.0.0.1`）。
另外：**`https://` 的 Origin 现在一律拒**（DSH 的 `webServer` 不带 TLS ⇒ 本服务永远是 `http:`）；**`Origin: null` 也一律拒**（`<iframe sandbox>` / `data:` / `file:` 不携带任何来源信息）。

**English:** Since v2.4 gate ③ enforces **full same-origin** (scheme + host + port). A red-team 90-cell matrix measured **14 cells going from allow → deny, none the other way**, all of them **loopback-alias mismatches** (`Host: 127.0.0.1` + `Origin: http://localhost`) that a real browser never produces — so the practical cost is ≈ 0. If you test by hand with curl, spell the `Origin` host **exactly like** the `Host` header. Also: an **`https://` Origin is now always rejected** (DSH's `webServer` has no TLS, so this service is always `http:`), and so is **`Origin: null`** (`<iframe sandbox>` / `data:` / `file:` carry no origin information).

另外 / Also：写入侧**逐行 `JSON.parse` 校验后再重新序列化** ⇒ **无法用一次 POST 注入多条伪造记录**（否则这份证据就失去可信度）；
单条按**字节**限长、日志总量上限 **32 MB** 后**轮转**、按对端**限速**（超限 **429**）；GET **只读文件尾部**且 `n` 夹紧到 **500**；错误响应**不回传绝对路径**。

**English:** The host route enforces four gates itself: **loopback peer** only; **loopback `Host`** (anti DNS-rebinding); **same-origin or missing `Origin`** (anti-CSRF); **`application/json`** only. Plus: every record is `JSON.parse`-validated and re-serialized before being written (so one POST cannot inject multiple forged records); per-record **byte** cap; **32 MB** total cap with rotation; per-peer rate limit (**429**); GET reads only the file **tail** and clamps `n` to **500**; error responses never leak absolute paths.

⚠️ **这不是"鉴权"**：**同机其它进程仍然可以读/写**这份日志（本插件假定"本机可信、网络不可信"）。
想要更严，请把 DSH 的 `host` 保持默认 `127.0.0.1`（**不要**配成 `0.0.0.0`）。
**English:** ⚠️ This is **not authentication**: other **local** processes can still read/write this log (the plugin assumes "local is trusted, network is not"). For more isolation, keep DSH's `host` at its default `127.0.0.1` (do **not** set `0.0.0.0`).

---

## ⚠️ 适用范围与实测环境（**不保证人人通用**）/ Scope & tested environment (**no guarantee of universality**)

**本插件只在作者的一台机器上验证通过，不保证适用于其他人。** 它依赖 DSH 的插件 API（`ctx.get('webServer')`、`ctx.effect`、`window.__ModuleLoader__`、客户端 bundle 的加载方式）—— **这些在不同 DSH 版本里都可能变**。

**English:** This plugin was verified on **one machine only** and is **not guaranteed to work for everybody**. It depends on DSH plugin APIs (`ctx.get('webServer')`, `ctx.effect`, `window.__ModuleLoader__`, how client bundles are loaded) — **any of which may change between DSH versions**.

| 项 / Item | 作者的实测环境 / Author's tested environment |
|---|---|
| DSH | `0.1.7-rc.2` |
| 操作系统 / OS | Windows 11 家庭版（build 26200） |
| 浏览器 / Browser | **Firefox**（Chrome / Edge 未专门验证 / not specifically verified） |
| Node | `v24.20.0` |
| 安装形态 / Install layout | 自定义安装根 + profile 在 `~/.dsh/profiles/web` |
| 端口 / Port | 12073（与插件无关，仅说明作者环境 / irrelevant, context only） |

⇒ **装之前建议先确认**：① DSH 版本接近；② 你的插件加载机制和上面一致；③ 装完看宿主日志有没有 `[dsh-open-watchdog] 路由已注册` —— **没看到就说明路由没挂上，记录会 POST 失败**。
**English:** Before installing, check: ① a close DSH version; ② your plugin-loading mechanism matches the above; ③ after installing, look for `[dsh-open-watchdog] 路由已注册` in the host log — **if it is missing, the route never registered and records will fail to POST**.

---

## 落盘位置与清理 / Where it writes and how to clean up

| 项 / Item | 位置 / Location |
|---|---|
| 日志 / Log | `$DSH_HOME/logs/dsh-open-watchdog/switch-log.jsonl`（默认 `~/.dsh/logs/…`） |
| 上限 / Cap | 单条按**字节**上限（约 192 KB）；总量超过 **32 MB** 自动**轮转**为 `switch-log.jsonl.1`（只留一代）；GET 每次最多返回 **500** 条 / per-record byte cap (~192 KB); rotates to `.1` past **32 MB**; GET returns at most **500** |
| 清理 / Cleanup | **直接删掉这个 jsonl 文件（以及 `.1`）即可**（插件会按需重建目录）；卸载插件后**日志文件会留下**，需要手动删 / just delete the file (and `.1`); uninstalling leaves logs behind |

⭐ **日志里不再包含会话正文**：出错记录只保存**结构摘要**（条数 + 每条的类型/键 + 一个短哈希），够对照复现、但不泄露内容。
仍会含**会话 id 与网络请求路径**（都是本机 DSH 自己的数据）—— 分享日志给他人之前，请自行检查。
**English:** ⭐ **Logs no longer contain session content**: failing records store only a **structural summary** (count + per-item type/keys + a short hash). They still contain **session ids and request paths** (all local DSH data) — review before sharing.

---

## 已知边界 / Known limits

- **它只记录，不诊断、不修复**。判断还是要靠人（或 AI）读这些记录。
  **English:** It only records — it does not diagnose or fix. Interpretation is still up to a human (or an AI).
- **不是所有卡顿都会进记录**：它只在**你点击会话行**时开始采样；通过其它路径进入会话不会触发。
  **English:** Not every hang is captured: sampling starts **when you click a session row**; entering a session by other means does not trigger it.
- **最长观察 25 秒**（`OBSERVE_MAX_MS`），之后收尾。
  **English:** Observation caps at 25 s (`OBSERVE_MAX_MS`), then it wraps up.
- **`throttledLikely: true` 的那组数字不要直接当"卡了 X 秒"**。
  **English:** When `throttledLikely: true`, do not read the numbers as "it hung for X seconds".
- 🩸 **重启 `dsh web` 之后有一段冷启动窗口**：`2286721642` 的实测里，刚重启后 `/api/*` **全线 15–25 秒**
  （`/api/session/modelCatalog` 25.5 s、`/api/commandcode/report` 21.5 s、`/api/skills/list` 14.9 s …）
  ⇒ **这个窗口里点会话必然长卡 25 s+**，且 `openState` 会真的停在 `loading` / `pending`。
  ⚠️ 这是**独立现象**，会与本题的「永久卡住」在体感上混在一起 ⇒ **重启后稍等一会儿再点会话**。
  **English:** 🩸 **There is a cold-start window right after restarting `dsh web`**: in `2286721642`'s measurements every `/api/*` call took **15–25 s** (`/api/session/modelCatalog` 25.5 s, …) ⇒ clicking a session during that window always stalls 25 s+ with `openState` genuinely stuck at `loading` / `pending`. This is an **independent effect** that feels like the permanent hang this probe targets — **wait a bit after a restart before clicking**.
- **判定范围**：v2.3 起，加载文案的检测范围**优先按 `[data-conversation-session]` 锁定被点击的那条会话**
  （真机实测该属性的值**就是 session key**，形如 `session-<uuid>`），锁定不到再走候选链
  `[data-conversation-content]` → `[data-slot="main.conversation"]` → `[data-chat-flow]` → `body`；实际用了哪个记在 `regionUsed` 里。
  ⚠️ **DSH 的类名是 CSS Modules 哈希**（`OMoRSG_main` 这种，**每次构建都会变**）⇒ **绝不能用 class 当选择器**。
  ⚠️ 早期版本用过 `[data-dsh-center-col]` —— **那其实不是 DSH 的属性**，是第三方插件 `dsh-better-sidebar` 写的 ⇒ 已移除。
  **English:** Since v2.3 the loading-text check **first pins the clicked conversation via `[data-conversation-session]`** (its value **is** the session key, `session-<uuid>` — verified on a live page), and only then falls back along `[data-conversation-content]` → `[data-slot="main.conversation"]` → `[data-chat-flow]` → `body`; whichever was used is recorded in `regionUsed`. ⚠️ **DSH class names are CSS-Modules hashes** (e.g. `OMoRSG_main`) that **change on every build** ⇒ **never use them as selectors**. ⚠️ An earlier version used `[data-dsh-center-col]` — that is **not a DSH attribute** (it comes from the third-party plugin `dsh-better-sidebar`) ⇒ removed.
- **payload 版本 `ver: 3`** 新增字段：`regionUsed` · `mainTextLen` · `openStateAtEnd` · `openPendingAtEnd` · `openErrorAtEnd`；
  `verdict` 在"文案到窗口结束仍可见"时**不再直接判卡住**，而是先看 `openState` 终态再给结论。
  ⚠️ **`ver` 是「按记录类型」的版本号**，不是全局版本：采样记录是 `ver: 3`，
  而 `open-promise` / `replace-failed` / `dump` 这几种记录**仍然是 `ver: 2`** —— 解析时请**按记录类型**判断。
  **English:** Payload **`ver: 3`** adds `regionUsed`, `mainTextLen`, `openStateAtEnd`, `openPendingAtEnd`, `openErrorAtEnd`. When the loading text is still visible at the end of the window, `verdict` no longer calls it a hang outright — it consults the final `openState` first. ⚠️ **`ver` is a per-record-type version, not a global one**: the sample record is `ver: 3`, while `open-promise` / `replace-failed` / `dump` records are **still `ver: 2`** — branch on the record type when parsing.

---

## 版本与改动记录 / Versions & changelog

| 版本 / commit | 日期 | 内容 |
|---|---|---|
| **本轮**（`c15c9fb`） | 2026-09-27 | ⭐ **跨机白名单开关** `DSH_OPEN_WATCHDOG_ALLOW_HOSTS` / `..._ALLOW_PEERS`（**默认都是空 = 只允许 loopback**）· 加载文案判定范围收窄到会话区 · verdict 纳入 `openState`/`openError` 终态（payload `ver: 3`）· **四道闸按独立红队审查加固** |
| v0.2.0（`f628c71`） | 2026-09-26 | 安全加固：四道闸 + 按对端限速 + 容量上限/轮转 + 写入侧逐行校验；README 更正「`installReplaceHook` 当前无调用点」 |
| 首发（`48bf3ae`） | 2026-09-25 | 只读探针首版 |

**本轮修掉的 6 个缺陷 —— 全部由独立红队发现（我方 20 条自测全绿之后）**：

1. 🩸 `ALLOW_PEERS='10.0.0.0/'`（掩码位写空）被 `Number('') === 0` 当成 `/0` ⇒ **放行整个 IPv4 空间**（实测公网 peer 也拿到 200）；
2. 🩸 「同源」**只比 hostname** ⇒ 同机另一个端口（异源）可让记录被伪造落盘；`Origin: null`（`<iframe sandbox>`）**四道闸全过**；
3. `Host: 10.0.0.5:3080@evil.com`、`10.0.0.5:3080:evil.com` ⇒ 能被切出"裸主机名"而命中白名单；
4. `Content-Type: text/plain; application/json` 因用 `includes` 而通过 —— 它的 MIME essence 是 `text/plain`，属 **CORS 简单请求（不触发预检）**，是 CSRF 能一键利用的使能条件；
5. 🩸 **IPv6 `[::1]` 同源被静默 403** —— `URL.hostname` 自带方括号而 Host 侧被剥掉，两侧归一化不对称；
6. 🩸 **`openStates` 有 60 条上限（`PUSH_CAP`）** ⇒ verdict 的"终态"可能已被挤出数组 ⇒ **把已经恢复的会话报成"真卡"**（红队归因实验：只把 cap 改成 200 结论就翻转，而 `pollCount` 相同）。

**回归测试**（已把上面每一条固化成用例）：`test-gates.mjs`（默认模式 10 + 白名单模式 10）+ `test-regression.mjs`（normal 12 + broken 3）= **35 断言全绿**。

> ⚠️ **尚未验证的部分（如实声明）**：`lib/client.js` 的改动**没有真机端到端验证**（只有桩 DOM 测试 + 源码形状断言）；缺陷 6 的修法（终态实时读一次）也**没有真机复现来验** —— 红队的归因实验是改 `PUSH_CAP` 做的，不是验这个写法。

**English:** This round adds the two opt-in whitelist env vars (**both empty by default ⇒ loopback only**), narrows the loading-text check to the conversation region, feeds `openState`/`openError` into the verdict (`ver: 3`), and hardens all four gates after an **independent red-team review**. Six defects were found by that review **after** our own 20 assertions were green: (1) an empty CIDR prefix (`'10.0.0.0/'`) silently became `/0` and **allowed the whole IPv4 space**; (2) "same-origin" compared **only the hostname**, letting a different-port page forge records, and `Origin: null` passed all four gates; (3) `@userinfo` / double-colon `Host` values could match the whitelist; (4) `Content-Type: text/plain; application/json` slipped through `includes` — its MIME essence makes it a **CORS-simple (preflight-free) request**, the enabler for one-click CSRF; (5) **IPv6 `[::1]` same-origin was silently 403'd** because the two sides normalised brackets differently; (6) `openStates` is capped at 60 (`PUSH_CAP`), so the verdict's "final state" could be evicted and **report a recovered session as hung**. All six are now regression cases (**35 assertions green**). ⚠️ **Not yet verified**: the `lib/client.js` changes have **no end-to-end run on a real page** (stub-DOM tests + source-shape assertions only), and fix (6) has no live reproduction — the red team's attribution experiment changed `PUSH_CAP`, which is not the same as testing this implementation.

---

## 许可与署名 / License & Credits

MIT。由 **DeepSeek（DSH agent）编写**，**CNyaotian** 维护。
**English:** MIT. Written by **DeepSeek (a DSH agent)** and maintained by **CNyaotian**.
