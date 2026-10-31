# 窗口预热（Window Warmup）

Window Warmup is a page plugin for [magpie](https://usemagpie.ai) that sends a short keep-alive message to a provider, account and model of your choice — right after a quota window resets, at a fixed time of day, or every few hours — so the next subscription usage window opens early. It runs inside the Magpie host process; a local page manages tasks and shows run history.

在 magpie 窗口里按计划给指定供应商、账号和模型发一条短消息，用来提前开启下一轮额度（订阅）窗口。消息固定 `max_tokens: 16`，只当探活用；**每条消息都会真实发给所选模型并计费**。

## 安装

```sh
magpie plugin add github:YangHonghang/magpie-window-warmup
```

也可以在 magpie 插件页的搜索框里搜 `warmup`，在「非官方插件 · GitHub」区找到它（仓库已打 `magpie-plugin` 话题，详见文末「发布到插件页」）。装好后在侧边栏 Plugins 下出现 **Window Warmup**（窗口预热）标签页。

### 从旧版「定时消息」升级，或与其并存

本插件与旧包 `scheduled-messages`（定时消息）默认都占 `127.0.0.1:3492`，后启动的一方起不来；若旧包先占了端口，本插件的带路页会跳到 3492 加载到**旧插件的界面**（页面自身无法探测这种张冠李戴）。两者的数据目录与锁文件各自独立，不会互相污染，但端口冲突必须处理其一：

- **从旧版升级**：先 `magpie plugin rm scheduled-messages`，再安装本插件。首次启动会自动把旧任务数据迁移过来（见「数据在哪」）。
- **确实要并存**：把其中一个的端口改掉，例如 `magpie plugin options magpie-window-warmup '{"port":3493}'`；带路页会跟随这个选项跳转，改完重新打开页面即可。

## 三种触发

| 触发 | 到期点 | 去重 |
|---|---|---|
| 窗口重置后 | 账号额度窗口的 `resetsAt` 加 30 秒宽限（确保 magpie 侧已完成重置）；窗口空闲（重置点已过或没有）则立即到期 | 同一 `resetKey` 最多尝试一次，成功、失败、未知都算；有重置点时 key 就是重置点本身，同一轮重置只发一次；没有重置点的空闲窗口按快照所在小时计 key |
| 每天定时 | 指定 IANA 时区的 `HH:MM`；夏令时跳过的时刻顺延到跳变后第一个有效时刻，重复时刻取较早一次 | 按到期点记 |
| 固定间隔 | 起点 anchor 之后每 1–168 小时一个点 | 按到期点记 |

窗口任务必须锁定账号（同一 `resetKey` 只试一次，自动选账号会让去重失真）；每天定时与固定间隔任务可以不选账号，交给网关自动选。调度器只保留一个定时器，最长睡 10 分钟就醒来重算，系统睡眠、改系统时间都能自愈。额度快照约每 10 分钟及每次发送后刷新。

## 模型与思考档位

模型选「自动」时，任务里不存选中值，每次发送前在该供应商的模型里现选：

- 按模型 id 最后一段出现的规格词排序 `flash < lite < mini < nano < small < turbo`（整词匹配、不分大小写，"minimax" 不算 mini），都不含的排最后；
- 同档按 id 数字感知降序（新版本优先），取第一个；
- 一个模型都选不到 → 本次失败「供应商 X 下没有可用模型」。

插件页的目录会直接显示「自动」当前会选中谁。

思考档位同样不保存在任务里，每次发送前从当次 `/v1/models` 取该模型自己的档位列表现算，模型配置变了下次发送自动跟随：

- 模型不支持思考或档位列表为空 → 不带 `reasoning_effort`；
- 档位里有 `none`（`disabled`/`off` 视同）→ `reasoning_effort: "none"`，能关就关；
- 否则取该模型列表里最低一档（已知名按 `minimal < low < medium < high < xhigh < max` 排，纯数字思考预算低于所有命名档；全部是不知名的取列表第一档）。

每次执行记录都会写下当次实际用的模型与档位。

## 失败与补发

- **失败不暂停**：失败、超时（30 秒内没有结果，记 `unknown`，「可能已发送」）只写进执行记录，原因原样显示在页面上，任务保持启用，下一个时刻照常；不自动重发本次。
- **同一任务不重叠**：上一次发送还没结束，本次记「跳过」。
- **Magpie 关闭期间不执行**：调度跑在 magpie 宿主进程里，magpie 没开就没有发送。重新打开（或从睡眠恢复）后，每个任务最多补发一次：每天定时/固定间隔任务补发最近错过的应到点（须晚于任务最后一次编辑；每天定时只回看最近 48 小时），多个错过的点只补一个；窗口任务由 `resetKey` 去重兜着，同一轮重置不会发第二次。
- 找不到账号或窗口时记失败原因，不发送；额度快照取不到（刷新一直失败）时静默等下一轮刷新，不写执行记录。
- magpie 刚启动、额度缓存还是空的时候，插件会兜底读一次完整额度接口（只读余额，不发模型请求，15 秒超时）；两次兜底读取至少间隔 5 分钟。

## 账号与远程 key

「发送到」的账号下拉来自 magpie 的额度目录。远程 magpie 会给每把网关 key 单独发一张限额卡（供应商标成 `<p>/~keys`），插件把这些卡归并回供应商 `<p>`，账号名就是 key 名，任务里可以直接选到某把 key。窗口任务必须指定账号；其余触发可以留空由网关自动选。

## 数据在哪

- 数据目录：`WINDOW_WARMUP_DIR` 优先，否则 `${XDG_CONFIG_HOME:-~/.config}/magpie/window-warmup/`。
- **从旧版自动迁移一次**：第一次启动时，若新目录还没有 `state.json` 而旧版定时消息的 `…/magpie/scheduled-messages/state.json` 存在，就只把这一个文件复制过来（锁文件不带，旧文件原地不动，方便回退）；新目录已有 `state.json` 就什么都不做，条件本身保证只做一次。
- `state.json` 存任务、执行记录与去重标记，每任务保留最近 50 条记录；写入用临时文件加 rename。
- 已知边界：落盘没有 fsync，断电极端情况可能留下损坏文件。程序会拒绝启动并显示原因，**原文件一个字节不动**，需要你确认后手动删除或修复。
- 单实例锁 `service.lock` 写入持有者 pid；锁内容读不出或解析不了时按「活性不明」处理，页面提示另一个实例可能正在运行并只读展示，不会抢占。若确认没有别的实例，删掉残留的锁文件再打开页面即可。

## 安全与端口

本地服务只监听 `127.0.0.1`（默认端口 3492，可在插件设置里改）。每次启动生成随机口令，经首页注入，`/api/*` 全部要求带 `x-window-warmup-token` 头；服务同时校验 `Host` 与 `Origin`（防 DNS 重绑定），响应按沙箱框架给 CORS 与 CSP，别的页面读不到接口。除 magpie 本地网关（发消息、读额度、读模型，地址取 `MAGPIE_ADDR`，默认 `http://127.0.0.1:3425`）外没有任何对外连接。

## 费用

每条消息都会真实发给所选模型并计费（固定 `max_tokens: 16`，只当探活）。窗口触发以 magpie 额度快照为准，同一轮窗口只发一次；额度缓存长时间不更新时，空闲窗口按小时计 key，同一小时内最多尝试一次。

## 发布到插件页

magpie 的插件页按 GitHub 话题 `magpie-plugin`（`archived:false fork:false`）发现仓库，按 star 排序，列在「非官方插件 · GitHub」区。搜索框把仓库名、owner/repo、owner、安装名与 **GitHub 仓库描述**拼成一串做小写子串匹配（不分词）——`package.json` 的 keywords、description 与其他话题都不参与搜索，所以仓库描述既是搜索文本也是卡片上的说明，改它要慎重。

本仓库的现状：仓库描述与 `package.json` 的 `description` 逐字一致；话题已加 `magpie-plugin`（必需）与 `magpie`、`quota`、`warmup`、`keep-alive`（后几个只影响 GitHub 自身搜索）。
