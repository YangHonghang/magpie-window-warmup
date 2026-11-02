# AGENTS.md

本仓库是 magpie 的页面插件「窗口预热（Window Warmup）」：在 magpie 宿主进程里按计划向指定供应商 / 账号 / 模型发一条 `hi`（`max_tokens: 16`），提前开启订阅额度窗口。用户可见行为、触发规则、去重与费用说明以 `README.md` 为准，改行为时同步更新 README。

## 命令

运行时、包管理器、构建与测试都用 Bun（`engines.bun >= 1.4.2`），不引入其他构建工具。

```sh
bun install
bun run build        # scripts/build.ts → dist/plugin.js、dist/ui/{app.js,index.html,style.css}
bun run typecheck    # tsc --noEmit，覆盖 src、scripts、tests、web
bun test             # 全部测试
bun test tests/rules.test.ts          # 单个文件
bun test tests/scheduler.test.ts -t "关键字"   # 按用例名过滤
```

- **`dist/` 入库**，宿主直接加载 `dist/plugin.js`（`package.json` 的 `main`），服务从 `dist/ui` 提供静态页。改了 `src/` 或 `web/` 必须 `bun run build` 并一并提交 `dist/`。
- `tests/server.test.ts` 的 `beforeAll` 会调用 `buildAll()` 重建 `dist/`。
- `tests/fake-gateway.ts` 是假的 magpie 网关，网关 / 调度相关测试都靠它，不打真实网关。

## 发布

- **推送 `main` 即发包**（`.github/workflows/publish.yml`）：先跑 typecheck、测试，并校验 `dist/` 与源码一致（不一致直接失败）；`package.json` 的版本 npm 上还没有才 `npm publish`，没改版本只校验不发。要发新版就把版本号加一并随改动一起推送。
- 凭据走 npm **Trusted Publishing**（GitHub OIDC），仓库不存 npm token。npmjs.com 上 `magpie-window-warmup` 的 Trusted Publisher 绑定的是本仓库的 `publish.yml`：**改工作流文件名或仓库名会让发布 403**，需在 npm 上同步改。npm 账号 2FA 只有通行密钥，本地手动发布要在交互终端里走浏览器认证。
- **官方插件市场**：已登记在 [magpie-community/plugins](https://github.com/magpie-community/plugins) 的 `registry.json`（`kind: "page"`，只记包名），magpie 自己从 npm 取最新版，**发版无需同步社区仓库**。只有名称、图标、中英文简介变化时，才去该仓库改 `registry.json` 并提 PR（fork：`YangHonghang/plugins`）。

## 架构

两层入口 + 一个带路页：

- **`page/index.html` + `page/boot.js`（带路页）**：magpie 页面框架里加载的页面。CSP 为 `connect-src 'none'`，脚本不能联网探测，只能整页跳转到本地服务；跳转时带上 magpie bridge 给的主题、语言、设计令牌，`magpie web` 场景优先跳 `window.magpie.service` 转发地址。
- **`src/plugin.ts`（宿主入口）**：`server()` 先探测端口上是否已有本插件（所有响应带 `x-window-warmup: 1`），有就复用；没有才迁移旧数据并 `startService`。**模块不要导出额外函数**——宿主会把导出的每个函数都当插件函数调用。
- **`src/server.ts`**：只监听 `127.0.0.1` 的 Bun 服务。每进程随机 token 注入首页，`/api/*` 必须带 `x-window-warmup-token`；校验 Host / Origin（防 DNS 重绑定）、CSP。store 损坏 → fatal（只展示原因、不调度、拒绝写）；锁被他人持有 → 只读。
- **`web/app.ts`（页面 UI）**：DOM 一律 `createElement` + `textContent`，不拼 HTML。导出的纯函数供测试复用，被 import 时不碰 DOM（文件尾部守卫）。编辑区由 `buildEditor` 按区块拼装（`sendToParts` / `triggerSeg` / `triggerFields` / `nextPreview` / `editorActions` / `runsSection`）。i18n 在 `web/i18n.ts`（`app.ts` 原样转出，测试从 app 取用），键即中文原文，en / zh-TW / ja 三张表键集合必须一致（`tests/i18n.test.ts` 守卫）。

核心模块分工：

- **`src/rules.ts`**：纯时间计算（每天定时含时区 / 夏令时、固定间隔、窗口到期 = `resetsAt` + 30s、补发回看 48 小时）、任务校验与探活消息常量。**页面直接打包本模块**（编辑区预览与调度器用同一个 `upcoming`），所以它只能依赖 `types.ts`，不得引入 `node:*` 或网关模块（`tests/rules.test.ts` 有守卫）。`types.ts` 同理，另放各层共用的 `errText`。
- **`src/scheduler.ts`**：所有改状态入口（tick / upsert / remove / runNow）走同一操作队列串行；发送本体在队列外但登记在 inflight，保证同任务不重叠、删除后异步完成不会把记录写回。单定时器，最长睡 10 分钟后重算。窗口任务发送前后让 magpie 单卡重读额度（`readAt` 早于上次发送的空闲读数不信）。判断逻辑集中在几个私有函数：`pendingFixedDue`（定时/间隔该不该补发）、`currentWindowDue` + `windowReady`（窗口到期且本轮未尝试，纯计算）；`lastReset` 只在 `recordResets` 里写（额度刷新后与 `rearm` 时），不要再把写盘塞回查询路径。
- **`src/gateway.ts`**：与本地 magpie 网关（`MAGPIE_ADDR`，默认 `127.0.0.1:3425`）通信：`/v1/models`、`/v1/magpie/quotas`（含单卡 refresh）、`/v1/chat/completions`；思考档位 `pickEffort` 每次发送前现算。
- **`src/accounts.ts`**：**统一账号规则的唯一实现**——`/api/catalog` 与调度器共用（账号合并、key 卡挂回、按账号收窄模型、`pickAutoModel`）。禁止在别处另写一套，否则页面显示与实际发送会不一致。
- **`src/magpie-files.ts`**：只读 magpie 的 `providers.json` 与模型缓存。`readDefaultKeyDirectory` / `readDefaultModelCache` 是目录与调度器共用的默认读取入口；`xdgConfigHome` 是插件数据目录、旧包迁移与 Magpie 配置目录共用的 XDG 解析（只认绝对路径）。**红线**：key 原文只允许在 `readKeyDirectory` 内「读 → 算指纹（sha256 前 5 字节 hex）」后即丢，不得进入返回值、日志、错误信息或缓存；JSON 解析失败一律换成固定文案 `BROKEN_PROVIDERS_MESSAGE`。
- **`src/store.ts`**：`state.json` 临时文件 + rename 落盘，损坏时拒绝启动且绝不改动原文件；`service.lock` 原子排他创建 + pid 活性判断（活性不明不抢占，pid 存活但端口无本插件应答视为陈旧锁接管）；一次性从旧包 `scheduled-messages` 迁移 `state.json`。

## 供应商 → 账号 → 模型级联（无官方接口的绕行路径）

Magpie 不提供「供应商 / 账号 / 每账号可用模型」的列表接口，目录是拼出来的。用户视角的完整说明见 README「供应商 → 账号 → 模型」一节，改规则时两处同步。

**数据链路**：`fetchCatalog`（`src/gateway.ts`）并发读取 `/v1/models` 与额度卡（`fetchQuotas`：平时 `?kept=1` 只读缓存，缓存空时兜底读完整接口，至少间隔 5 分钟），再经 `readDefaultKeyDirectory` / `readDefaultModelCache` 读 `providers.json` 和 `<缓存目录>/models/<pid>.json`，逐个供应商调用 `accountsOf` 生成 `/api/catalog`。页面（`web/app.ts` 的 `accountOptions` / `modelOptions` / `windowOptions` / `accountModelView`）只消费目录、不做推算，每 60 秒刷新。调度器 `resolveSend`（`src/scheduler.ts`）发送前重新读同样的数据，再调用同一组函数（`modelsForAccount`、`pickAutoModel`、`pinFor`、`windowsForAccount`）。

**关键绕行点**（都在 `src/accounts.ts` 与 `src/magpie-files.ts`）：

- **供应商**：模型按 `owned_by`、否则按 id 首段归属（`modelProvider`），跳过 `group/`；额度卡的 provider 也算，`<p>/~keys` 归一为 `<p>` 并标记 `viaKey`（`parseQuotas`）。
- **key 账号**：`providers.json` 的 `key` + 未停用的 `keys[]`，取 `sha256(key)` 前 5 字节 hex 作为指纹，与 Magpie `internal/provider/keys.go` 的 keyID 同一算法。这个指纹是连接三方的唯一桥梁：模型缓存的 `Keys`、`accountModels` 的键、发送头 `<P>#<指纹>`。改算法会让三处同时失配。
- **订阅账号**：非 key 卡的额度卡 `user`。
- **key 账号的窗口**：用指纹反查 key 名，匹配 `<p>/~keys` 卡的 `user`（不分大小写相等，或以 `名字 · ` 开头）；无名 key 接受无窗口。
- **模型三层过滤**（`modelsForAccount`）：
  1. 缓存 `Keys` 可见性（仅缓存存在且账号是指纹时）；
  2. `accountModels[指纹或小写账号名]`，比对不带供应商前缀的 id；
  3. 必须仍在 `/v1/models` 里。

  无缓存时退化为 `/v1/models` 全量（`perAccount: false`），两者皆无时返回 `list: null`。
- **发送头**（`pinFor`）：订阅账号原样发；key 指纹在启用 key 不少于 2 把（目录读不出时按 2 把处理）时发 `<P>#<指纹>`，只有 1 把时不带头，因为此时候选 ID 就是供应商 id；其余值（旧任务存的 key 名）原样发。非 ASCII 头值按 UTF-8 字节写入（`send`）。
- **文件位置**（`magpieDirs`）：从插件安装路径 `<配置目录>/plugins/node_modules/magpie-window-warmup/dist` 上溯 4 级得到配置目录，再据此区分安装版和便携版的缓存目录。`tests/magpie-files.test.ts` 覆盖了 Windows 路径与便携版。

## 约定

- 默认端口 3492 同时出现在 `package.json`（`magpie.options` / `magpie.page.service`）、`src/plugin.ts` 的 `DEFAULT_PORT`、`page/boot.js`，改动需三处一致。
- `package.json` 的 `description` 必须与 GitHub 仓库描述逐字一致（它是 magpie 插件页的搜索文本与卡片说明），`tests/discoverability.test.ts` 有回归守卫；`keywords` 不影响插件页搜索。
- 除本地 magpie 网关外不得引入任何对外连接；预热消息内容固定，不提供自定义。
- Commit 格式：`[type] 中文简述`（`feat` / `fix` / `doc` / `refactor` / `test` / `chore`），参见 `git log`。
