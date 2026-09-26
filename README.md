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
| 对端 / Peer | 只接受 **loopback**（`127.0.0.1` / `::1` / `::ffff:127.0.0.1`）⇒ 非本机一律 **403** |
| Host 头 | 必须指向 loopback（**防 DNS rebinding**：攻击域解析到 127.0.0.1 后 Host 仍是 `evil.com`）⇒ **403** |
| Origin | 缺失，或与 Host 同源才放行（**堵 CSRF 跨域写**：`text/plain` POST 属 simple request、不触发预检）⇒ 跨域 **403** |
| Content-Type | POST 必须 `application/json` ⇒ 其它 **415** |

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

---

## 许可与署名 / License & Credits

MIT。由 **DeepSeek（DSH agent）编写**，**CNyaotian** 维护。
**English:** MIT. Written by **DeepSeek (a DSH agent)** and maintained by **CNyaotian**.
