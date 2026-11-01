// 窗口预热页面：Magpie 式单列任务列表 + 行内展开编辑（按已确认原型 v10 实现）。
// 纯函数（statusOf / trigText / runReason / 各下拉选项构造等）导出供测试与渲染复用；
// DOM 一律 createElement + textContent 组装，不拼 HTML（下拉箭头是固定 SVG 常量），任务名等数据没有注入面。
// 模块被测试直接 import 时不碰 DOM（见文件尾部的守卫）。
import type { Catalog, CatalogProvider, EffortPick, QuotaWindow, Run, Task, Trigger } from "../src/types";

/** GET /api/state 的响应体；timeline 仍由服务端计算，v10 页面不再展示 */
export interface StateView {
  tasks: Task[];
  runs: Run[];
  next: Record<string, string | null>;
  timeline: { taskId: string; at: string }[];
  saveError: string | null;
  /** 状态文件损坏时服务不启动调度，页面显示原因 */
  fatal?: string | null;
  /** 单实例锁被别的进程持有（0 = 持有者身份无法判断），页面只读 */
  lockedBy?: number | null;
}

/** 状态字的着色：空 = 常规灰，ok = 发送中，bad = 红，unk = 琥珀 */
export type Tone = "" | "ok" | "bad" | "unk";

/** 下拉选项：value 存进任务，text 是显示文字，aux 是右侧不截断的附注 */
export interface SelOption {
  value: string;
  text: string;
  aux?: string;
}

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const NAME_MAX = 40;
/** 窗口到期的宽限与调度器 rules.ts 一致：resetsAt + 30s */
const RESET_GRACE_MS = 30_000;
const POLL_MS = 3_000;
const CATALOG_POLL_MS = 60_000;
/** 执行记录默认条数与上限（store 每任务只留最近 50 条） */
const RUNS_PREVIEW = 5;
const RUNS_MAX = 50;
/** 删除的两步确认窗口 */
export const DELETE_CONFIRM_MS = 3000;

/** 提示 A（常驻灰字）：模型列表的来源与账号对不上时的解法 */
const MODEL_SOURCE_HINT =
  "模型列表来自 Magpie 上次获取的结果。账号和模型对不上时，到 Magpie「供应商」里打开这个供应商，点「获取模型」，再回来刷新本页。";
/** 提示 B：整个供应商还没有模型列表（替代提示 A，此时模型下拉禁用） */
const NO_MODELS_HINT = "还没有这个供应商的模型列表。请到 Magpie「供应商」里打开它，点「获取模型」。";
/** 三种触发；「窗口重置后」只在所选账号确实有窗口时才出现（账号没有窗口时建了也必然失败） */
const TRIGGERS = [
  ["window", "窗口重置后"],
  ["daily", "每天定时"],
  ["every", "固定间隔"],
] as const;

// ---------- 纯函数 ----------

/** 任务当前状态字：正常不显示文字（照原型），失败不暂停，失败/未知都照常显示下次时间 */
export function statusOf(
  task: Pick<Task, "id" | "enabled">,
  runs: Run[],
): { tone: Tone; text: string } {
  if (!task.enabled) return { tone: "", text: "已停用" };
  let latest: Run | null = null;
  for (const r of runs) {
    if (r.taskId !== task.id) continue;
    if (!latest || r.startedAt >= latest.startedAt) latest = r;
  }
  if (latest?.outcome === "running") return { tone: "ok", text: "发送中" };
  if (latest?.outcome === "failed") return { tone: "bad", text: "上次失败" };
  if (latest?.outcome === "unknown") return { tone: "unk", text: "上次结果未知" };
  return { tone: "", text: "" };
}

/** 「下次发送」文案：今天给 HH:MM，明天给「明天 HH:MM」，其余给 M/D HH:MM */
export function nextLabel(iso: string | null | undefined, now: Date): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const fmt = new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const time = fmt.format(d);
  const startOfDay = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const day = Math.round((startOfDay(d) - startOfDay(now)) / DAY_MS);
  if (day === 0) return time;
  if (day === 1) return `明天 ${time}`;
  return `${d.getMonth() + 1}/${d.getDate()} ${time}`;
}

/** 执行记录的时刻：今天/昨天相对化，更早给 M/D HH:MM */
export function runTimeLabel(iso: string, now: Date): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const startOfDay = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const day = Math.round((startOfDay(d) - startOfDay(now)) / DAY_MS);
  const hm = `${p2(d.getHours())}:${p2(d.getMinutes())}`;
  if (day === 0) return `今天 ${hm}`;
  if (day === -1) return `昨天 ${hm}`;
  return `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
}

/** 行内副标题：触发 · 账号 · 模型；账号显示目录里的 label（旧值/目录暂缺用原值），未定给「自动」 */
export function rowSub(
  task: Pick<Task, "provider" | "trigger" | "account" | "model">,
  providers: CatalogProvider[],
): string {
  const acct = providers
    .find((p) => p.id === task.provider)
    ?.accounts.find((a) => a.id === task.account);
  const who = task.account ? acct?.label || task.account : "自动选账号";
  return `${trigText(task.trigger)} · ${who} · ${task.model ? shortModel(task.model) : "自动选模型"}`;
}

export function trigText(trigger: Trigger): string {
  switch (trigger.kind) {
    case "window":
      return `窗口 ${trigger.window} 重置后`;
    case "daily":
      return `每天 ${trigger.time}`;
    case "every":
      return `每 ${trigger.hours} 小时`;
  }
}

/** 模型 id 的末段，行内与记录里都显示短名 */
export function shortModel(id: string): string {
  return id.split("/").pop() ?? id;
}

/** 下拉里的模型显示：剥掉与供应商相同的 id 前缀，其余原样 */
export function modelDisplay(modelId: string, providerId: string): string {
  return providerId && modelId.startsWith(`${providerId}/`) ? modelId.slice(providerId.length + 1) : modelId;
}

/** 思考档位的一句话结论 */
export function effortLabel(pick: EffortPick): string {
  if ("error" in pick) return `思考档位无法识别：${pick.error}`;
  return `思考：${pick.label}`;
}

/** 执行记录的结果字与着色：成功灰、失败红、未知琥珀 */
export function runOutcome(outcome: Run["outcome"]): { text: string; tone: Tone } {
  switch (outcome) {
    case "ok":
      return { text: "成功", tone: "" };
    case "failed":
      return { text: "失败", tone: "bad" };
    case "unknown":
      return { text: "未知", tone: "unk" };
    case "running":
      return { text: "发送中", tone: "" };
    default:
      return { text: "未知", tone: "unk" };
  }
}

const SOURCE_TEXT: Record<Run["source"], string> = {
  manual: "手动",
  catchup: "补发",
  schedule: "按计划",
};

/** 执行记录的原因列：成功拼实际模型与思考档位，失败/未知直接用服务端给的人话原因 */
export function runReason(r: Run): string {
  if (r.outcome !== "ok") return r.reason;
  const parts: string[] = ["已发送"];
  if (r.model) parts.push(shortModel(r.model));
  if (r.effort) parts.push(`思考 ${r.effort}`);
  if (r.ms !== null) parts.push(`${(r.ms / 1000).toFixed(1)} 秒`);
  parts.push(SOURCE_TEXT[r.source] ?? r.source);
  return parts.join(" · ");
}

/** 账号下拉：来自目录；窗口触发（allowAuto=false）不给自动项；旧任务存的账号保留并标注 */
export function accountOptions(
  providerId: string,
  current: string,
  allowAuto: boolean,
  providers: CatalogProvider[],
): SelOption[] {
  const list: SelOption[] = [];
  if (allowAuto) list.push({ value: "", text: "自动（由 Magpie 选）" });
  const provider = providers.find((p) => p.id === providerId);
  if (current && !provider?.accounts.some((a) => a.id === current)) {
    list.push({ value: current, text: `${current}（不在当前账号列表）` });
  }
  for (const a of provider?.accounts ?? []) {
    // 起了名的 key：名字做主文字、指纹做次要附注；没起名的（label 就是指纹）与订阅账号不重复
    if (a.kind === "key" && a.label && a.label !== a.id) list.push({ value: a.id, text: a.label, aux: a.id });
    else list.push({ value: a.id, text: a.label || a.id });
  }
  if (!list.length) list.push({ value: "", text: "该供应商没有账号" });
  return list;
}

/** 当前账号的模型视图：models 是下拉的可选列表，autoModel 是「自动」项实际会选中的模型 */
export interface AccountModelView {
  /** null = 没有任何模型列表（提示 B，模型下拉禁用） */
  models: string[] | null;
  /** models 为 null 或空时为 null */
  autoModel: string | null;
  /** false = 该账号列的是全部模型（供应商没有模型缓存）；null = 自动账号或目录暂缺，无从判断 */
  perAccount: boolean | null;
}

/**
 * 当前账号的模型视图：指定账号用其 models/autoModel；「自动（由 Magpie 选）」与目录暂缺的
 * 旧账号退回供应商全集（autoAccountModels/autoModel）——旧账号不自动改写，也不该被禁用；
 * 此时无法判断是否按账号区分（perAccount = null，不显示那条提示）。
 */
export function accountModelView(
  provider: CatalogProvider | undefined,
  accountId: string,
): AccountModelView {
  const acct = accountId ? provider?.accounts.find((a) => a.id === accountId) : undefined;
  if (!acct) {
    return {
      models: provider?.autoAccountModels ?? null,
      autoModel: provider?.autoModel ?? null,
      perAccount: null,
    };
  }
  return { models: acct.models, autoModel: acct.autoModel, perAccount: acct.perAccount };
}

/** 模型下拉：首项「自动」附注当前账号的自动模型；其余来自该账号的列表；旧值保留不自动改写 */
export function modelOptions(
  providerId: string,
  accountId: string,
  current: string,
  providers: CatalogProvider[],
): SelOption[] {
  const provider = providers.find((p) => p.id === providerId);
  const view = accountModelView(provider, accountId);
  const list: SelOption[] = [];
  const auto: SelOption = { value: "", text: "自动" };
  if (view.autoModel) auto.aux = modelDisplay(view.autoModel, providerId);
  list.push(auto);
  const known = view.models ?? [];
  if (current && !known.includes(current)) list.push({ value: current, text: current });
  for (const id of view.models ?? []) list.push({ value: id, text: modelDisplay(id, providerId) });
  return list;
}

/** 窗口附注：已用百分比（最要紧的信息）+ 重置时间；都没读到给「空闲」 */
function windowAux(w: QuotaWindow): string {
  const parts: string[] = [];
  if (w.used !== null) parts.push(`已用 ${Math.round(w.used)}%`);
  parts.push(w.resetsAt ? `${hm(new Date(w.resetsAt))} 重置` : "空闲");
  return parts.join(" · ");
}

/** 窗口下拉：所选账号的额度窗口；没账号 / 没窗口给占位，目录暂缺的已存窗口名保留原值 */
/** 这个账号有没有可跟随的窗口（不限额的 Limit 已在服务端剔除）；没有就不提供「窗口重置后」 */
export function accountHasWindows(
  providerId: string,
  accountId: string,
  providers: CatalogProvider[],
): boolean {
  if (!accountId) return false;
  const acct = providers.find((p) => p.id === providerId)?.accounts.find((a) => a.id === accountId);
  return (acct?.windows.length ?? 0) > 0;
}

export function windowOptions(
  providerId: string,
  accountId: string,
  current: string,
  providers: CatalogProvider[],
): SelOption[] {
  const provider = providers.find((p) => p.id === providerId);
  const acct = provider?.accounts.find((a) => a.id === accountId);
  const list: SelOption[] = [];
  if (current && !acct?.windows.some((w) => w.name === current)) {
    list.push({ value: current, text: current });
  }
  for (const w of acct?.windows ?? []) list.push({ value: w.name, text: w.name, aux: windowAux(w) });
  if (!list.length) list.push({ value: "", text: accountId ? "该账号没有窗口信息" : "先选定账号" });
  return list;
}

/** 窗口触发必须有账号：缺账号时取该供应商的第一个，没有则空（保存时会被拦下） */
export function forceWindowAccount(providerId: string, providers: CatalogProvider[]): string {
  return providers.find((p) => p.id === providerId)?.accounts[0]?.id ?? "";
}

/** 发送到下方的提示行：自动给「自动选中 X」（按所选账号），两种情况都给思考结论与一句说明 */
export function modelHint(
  model: string,
  provider: CatalogProvider | undefined,
  accountId: string,
): { main: string; sub: string } {
  const autoSub = "名字带 flash / lite / mini 的小模型优先，每次发送前重新选；思考能关就关，不能关用最低档。";
  const fixedSub = "思考档位按这个模型的配置自动决定：能关就关，不能关用最低档。";
  if (model) {
    const m = provider?.models.find((x) => x.id === model);
    return { main: m ? effortLabel(m.effort) : "思考：目录里暂时没有这个模型", sub: fixedSub };
  }
  const autoId = accountModelView(provider, accountId).autoModel;
  // 归因要看是谁没有：指定了账号就是该账号的列表空了（key 的模型限制与 /v1/models 对不上）
  if (!autoId) {
    return { main: accountId ? "这个账号没有可用模型" : "该供应商没有可用模型", sub: autoSub };
  }
  const m = provider?.models.find((x) => x.id === autoId);
  const think = m ? effortLabel(m.effort) : "思考：目录里暂时没有这个模型";
  return { main: `自动选中 ${shortModel(autoId)} · ${think}`, sub: autoSub };
}

/** 顶栏摘要：启用数与所有启用任务里最近的下一个执行点 */
export function sumView(
  tasks: Task[],
  next: Record<string, string | null>,
): { enabled: number; next: { at: string; name: string } | null } {
  let enabled = 0;
  let best: { at: string; name: string } | null = null;
  for (const t of tasks) {
    if (!t.enabled) continue;
    enabled++;
    const at = next[t.id];
    if (at && (!best || at < best.at)) best = { at, name: t.name };
  }
  return { enabled, next: best };
}

/** 保存前的客户端校验：只拦缺名称 / 缺供应商 / 窗口缺账号缺窗口名 / 缺时刻，其余交给服务端 */
export function validateDraft(
  d: Pick<Task, "name" | "provider" | "account" | "trigger">,
): { error: string; field: string } | null {
  const name = d.name.trim();
  if (!name) return { error: "给任务起个名字", field: "name" };
  if ([...name].length > NAME_MAX) return { error: `名称不能超过 ${NAME_MAX} 字`, field: "name" };
  if (!d.provider.trim()) return { error: "必须选择供应商", field: "provider" };
  if (d.trigger.kind === "window") {
    if (!d.account.trim()) return { error: "窗口任务必须指定账号，不支持自动选择", field: "account" };
    if (!d.trigger.window) return { error: "必须填写额度窗口名", field: "window" };
  }
  if (d.trigger.kind === "daily" && !/^([01]\d|2[0-3]):[0-5]\d$/.test(d.trigger.time)) {
    return { error: "时间需为 24 小时制的 HH:MM", field: "time" };
  }
  return null;
}

/** 轮询时对展开中任务的处理策略：未保存编辑优先，外部更新只提示不覆盖 */
export function syncDraftOnPoll(
  saved: Task | null,
  openUpdatedAt: string | null,
  dirty: boolean,
): "adopt" | "keep" | "stale" | "gone" {
  if (!saved) return "gone";
  if (!dirty) return "adopt";
  return saved.updatedAt === openUpdatedAt ? "keep" : "stale";
}

/** 删除两步确认是否处于「确认删除」态；0 = 未进入确认 */
export function deleteArmed(confirmDeleteAt: number, now: number): boolean {
  return confirmDeleteAt > 0 && now - confirmDeleteAt <= DELETE_CONFIRM_MS;
}

/**
 * 这次滚动是否应关掉打开的菜单：菜单本体（.pop 自带 max-height + overflow:auto）
 * 及其内部的滚动不关——时区这类长列表靠它滚动；页面其余地方一滚就关。
 */
export function shouldCloseOnScroll(
  target: unknown,
  pop: { contains(x: unknown): boolean } | null,
): boolean {
  if (!pop) return false;
  if (target === pop) return false;
  return !pop.contains(target);
}

// ---------- 展示用的本地时间推算（权威计算在调度器，页面只做显示） ----------

const fmtCache = new Map<string, Intl.DateTimeFormat>();

function wallParts(
  t: Date,
  timeZone: string,
): { y: number; mo: number; d: number; h: number; mi: number } {
  let f = fmtCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
    fmtCache.set(timeZone, f);
  }
  const p: Record<string, number> = {};
  for (const part of f.formatToParts(t)) {
    if (part.type !== "literal") p[part.type] = Number(part.value);
  }
  return { y: p.year, mo: p.month, d: p.day, h: p.hour, mi: p.minute };
}

function tzOffsetMs(t: Date, timeZone: string): number {
  const w = wallParts(t, timeZone);
  return Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi) - Math.floor(t.getTime() / 60_000) * 60_000;
}

/** 展示用的下一个墙上时刻：两轮偏移修正，覆盖绝大多数夏令时场景 */
function nextDailyLocal(time: string, timeZone: string, after: Date): Date {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(time);
  const hh = Number(m?.[1] ?? 6);
  const mm = Number(m?.[2] ?? 0);
  const w = wallParts(after, timeZone);
  let y = w.y;
  let mo = w.mo;
  let d = w.d;
  for (let i = 0; i < 3; i++) {
    const guess = Date.UTC(y, mo - 1, d, hh, mm);
    let t = guess - tzOffsetMs(new Date(guess), timeZone);
    t = guess - tzOffsetMs(new Date(t), timeZone);
    if (t > after.getTime()) return new Date(t);
    const nd = new Date(Date.UTC(y, mo - 1, d + 1));
    y = nd.getUTCFullYear();
    mo = nd.getUTCMonth() + 1;
    d = nd.getUTCDate();
  }
  return new Date(after.getTime() + DAY_MS);
}

function nextEveryLocal(hours: number, anchor: string, after: Date): Date {
  const a = new Date(anchor).getTime();
  if (!Number.isFinite(a) || after.getTime() < a) {
    return new Date(Number.isFinite(a) ? a : after.getTime());
  }
  const step = Math.max(hours, 1) * HOUR_MS;
  const k = Math.floor((after.getTime() - a) / step) + 1;
  return new Date(a + k * step);
}

/** 「接下来」一行的展示推算：daily/every 沿规则往后数 count 个点；窗口不外推（重置时刻只有额度接口知道） */
export function nextPointsAfter(trigger: Trigger, after: Date, count: number): Date[] {
  const out: Date[] = [];
  if (trigger.kind === "window") return out;
  let cursor = after;
  for (let i = 0; i < count; i++) {
    cursor = trigger.kind === "daily"
      ? nextDailyLocal(trigger.time, trigger.timeZone, cursor)
      : nextEveryLocal(trigger.hours, trigger.anchor, cursor);
    out.push(cursor);
  }
  return out;
}

// ---------- 小工具 ----------

const p2 = (n: number): string => String(n).padStart(2, "0");
const hm = (d: Date): string => `${p2(d.getHours())}:${p2(d.getMinutes())}`;

function b64decode(s: string): string {
  const bin = atob(s);
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

function localTZ(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

function timezones(): string[] {
  const supported = (Intl as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf;
  const list = supported ? supported("timeZone") : [];
  const fallback = ["UTC", "Asia/Shanghai", "Asia/Hong_Kong", "Asia/Taipei", "Asia/Tokyo", "Europe/London", "Europe/Berlin", "America/New_York"];
  const all = list.length ? list : fallback;
  return all.includes(localTZ()) ? all : [localTZ(), ...all];
}

function isoToLocalInput(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}T${p2(d.getHours())}:${p2(d.getMinutes())}`;
}

function localInputToISO(v: string): string | null {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function cloneTask(t: Task): Task {
  return JSON.parse(JSON.stringify(t)) as Task;
}

/** 编辑签名：只有这六个字段会被保存；探活消息固定 hi，由服务端填写，页面不再收发 */
export function contentOf(d: Task): Pick<Task, "name" | "enabled" | "provider" | "account" | "model" | "trigger"> {
  return {
    name: d.name,
    enabled: d.enabled,
    provider: d.provider,
    account: d.account,
    model: d.model,
    trigger: d.trigger,
  };
}

// ---------- 应用状态 ----------

interface BootData {
  token: string;
  theme?: string;
  tokens?: string;
}

const NEW_ID = "__new__";

let boot: BootData | null = null;
let state: StateView | null = null;
let catalog: Catalog | null = null;
let catalogError = "";
let netError = "";
/** 行内操作（开关/删除）失败时的提示；成功刷新后清除 */
let actionError = "";
let openId: string | null = null;
let draft: Task | null = null;
/** 展开（或上次采纳）时服务端版本，轮询据此判断是否被别处更新 */
let openUpdatedAt: string | null = null;
let dirty = false;
let isNew = false;
let staleNote: string | null = null;
let formError: string | null = null;
let confirmDeleteAt = 0;
let runsExpanded = false;
let catalogTimer: ReturnType<typeof setInterval> | undefined;

// 页面所有请求都走相对路径：magpie web 把服务转发在自己的前缀路径下时，
// 根绝对路径会解析到宿主根上而 404；本地直达时相对与根绝对等价。
async function apiJSON<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: {
      "content-type": "application/json",
      "x-window-warmup-token": boot?.token ?? "",
      ...init.headers,
    },
  });
  const body: unknown = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (body as { error?: unknown }).error;
    throw new Error(typeof msg === "string" && msg ? msg : `HTTP ${res.status}`);
  }
  return body as T;
}

function isReadonly(): boolean {
  return !!(state?.fatal || (state && typeof state.lockedBy === "number"));
}

function currentSavedTask(): Task | null {
  if (!openId || isNew) return null;
  return state?.tasks.find((t) => t.id === openId) ?? null;
}

function latestRunOf(taskId: string): Run | null {
  let latest: Run | null = null;
  for (const r of state?.runs ?? []) {
    if (r.taskId !== taskId) continue;
    if (!latest || r.startedAt >= latest.startedAt) latest = r;
  }
  return latest;
}

// ---------- DOM 小工具 ----------

type Tag = keyof HTMLElementTagNameMap;

function el<K extends Tag>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** 仅当内容签名变化才重建子节点，保住滚动位置，也避免轮询打断焦点 */
function replaceChildrenIfChanged(container: HTMLElement, sig: string, build: () => Node[]): void {
  if (container.dataset.sig === sig) return;
  container.dataset.sig = sig;
  const top = container.scrollTop;
  container.replaceChildren(...build());
  container.scrollTop = top;
}

// ---------- 自定义下拉（不用原生 select：原生控件的 key 与值基线对不齐） ----------

const CHEV = '<svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="m5.5 6.5 2.5 2.5 2.5-2.5"/></svg>';

type PopRef = HTMLDivElement & { btn: HTMLButtonElement };

let popEl: PopRef | null = null;

function closePop(): void {
  if (!popEl) return;
  popEl.btn.classList.remove("open");
  popEl.btn.setAttribute("aria-expanded", "false");
  popEl.remove();
  popEl = null;
}

/**
 * 下拉按钮：key/值/附注按基线对齐，值超长省略、附注不截断，悬停 title 给全文；
 * 菜单挂 body 上（轮询重建列表不会关掉它），跟随按钮放置、贴边往回收，键盘可用。
 * disabled 时按钮只展示当前值（如该账号没有任何模型列表，见提示 B）。
 */
function sel(
  label: string,
  opts: SelOption[],
  val: string,
  onchange: (v: string) => void,
  disabled = false,
): HTMLButtonElement {
  const b = el("button", "field") as HTMLButtonElement;
  b.type = "button";
  if (disabled) b.disabled = true;
  else {
    // 禁用时不声明弹层，免得读屏播报一个打不开的菜单
    b.setAttribute("aria-haspopup", "listbox");
    b.setAttribute("aria-expanded", "false");
  }
  const cur = opts.find((o) => o.value === val) ?? opts[0];
  const kv = el("span", "kv");
  if (label) kv.append(el("span", "k", label));
  const v = el("span", "v", cur?.text ?? "");
  b.title = (cur?.text ?? "") + (cur?.aux ? ` · ${cur.aux}` : "");
  const c = el("span", "chev");
  c.innerHTML = CHEV; // 固定常量，无用户数据
  kv.append(v);
  if (cur?.aux) kv.append(el("span", "aux", cur.aux));
  b.append(kv, c);
  b.addEventListener("click", () => {
    if (popEl && popEl.btn === b) {
      closePop();
      return;
    }
    closePop();
    const m = el("div", "pop") as PopRef;
    m.setAttribute("role", "listbox");
    let focusIdx = 0;
    opts.forEach((o, i) => {
      const it = el("button", "it") as HTMLButtonElement;
      it.type = "button";
      it.setAttribute("role", "option");
      const on = o.value === val;
      if (on) {
        it.setAttribute("aria-selected", "true");
        focusIdx = i;
      }
      const tx = el("span", "tx", o.text);
      tx.title = o.text;
      it.append(el("span", "tick", on ? "✓" : ""), tx);
      if (o.aux) it.append(el("span", "aux", o.aux));
      it.addEventListener("click", () => {
        closePop();
        if (o.value !== val) onchange(o.value);
      });
      m.append(it);
    });
    m.btn = b;
    document.body.append(m);
    popEl = m;
    b.classList.add("open");
    b.setAttribute("aria-expanded", "true");
    // 跟着按钮放，宽度至少同按钮；贴右边或底边时往回收，不撑出横向滚动条
    const r = b.getBoundingClientRect();
    m.style.minWidth = `${Math.max(180, r.width)}px`;
    const w = m.offsetWidth;
    const hgt = m.offsetHeight;
    m.style.left = `${Math.max(12, Math.min(r.left, window.innerWidth - w - 12))}px`;
    m.style.top = `${r.bottom + 4 + hgt > window.innerHeight - 8 ? Math.max(8, r.top - 4 - hgt) : r.bottom + 4}px`;
    const items = [...m.querySelectorAll<HTMLButtonElement>(".it")];
    items[focusIdx]?.focus();
    m.addEventListener("keydown", (ev: KeyboardEvent) => {
      const idx = items.indexOf(document.activeElement as HTMLButtonElement);
      let next = -1;
      if (ev.key === "ArrowDown") next = Math.min(items.length - 1, idx + 1);
      else if (ev.key === "ArrowUp") next = Math.max(0, idx - 1);
      else if (ev.key === "Home") next = 0;
      else if (ev.key === "End") next = items.length - 1;
      if (next >= 0) {
        ev.preventDefault();
        items[next].focus();
      }
    });
  });
  return b;
}

/** 原生 time / datetime-local 输入裹进 .field，与下拉同款外观 */
function field(label: string, control: HTMLElement): HTMLLabelElement {
  const f = el("label", "field");
  const kv = el("span", "kv");
  if (label) kv.append(el("span", "k", label));
  kv.append(control);
  f.append(kv);
  return f;
}

/** 编辑区一行：右侧标签 + 内容 */
function row(ed: HTMLElement, label: string, ...kids: HTMLElement[]): void {
  const v = el("div", "v");
  v.append(...kids);
  ed.append(el("label", undefined, label), v);
}

// ---------- 时区下拉（含 UTC 偏移附注，建一次缓存） ----------

let tzOptionsCache: SelOption[] | null = null;

function tzOffsetLabel(tz: string, at: Date): string {
  try {
    const min = tzOffsetMs(at, tz) / 60_000;
    const abs = Math.abs(min);
    return `UTC${min < 0 ? "-" : "+"}${Math.floor(abs / 60)}${abs % 60 ? `:${p2(abs % 60)}` : ""}`;
  } catch {
    return "";
  }
}

function timezoneOptions(): SelOption[] {
  if (!tzOptionsCache) {
    const now = new Date();
    tzOptionsCache = timezones().map((z) => ({
      value: z,
      text: z,
      aux: tzOffsetLabel(z, now),
    }));
  }
  return tzOptionsCache;
}

// ---------- 编辑区 ----------

interface EditorRefs {
  name: HTMLInputElement;
}

let f: EditorRefs | null = null;

function markDirty(): void {
  dirty = true;
}

/** 名称输入：首次改动才重建（出现保存/取消），重建后把焦点与光标位置还回来 */
function onNameInput(apply: () => void): void {
  const caret = f?.name.selectionStart ?? null;
  apply();
  formError = null;
  if (!dirty) {
    dirty = true;
    render();
    const again = f?.name;
    if (again) {
      again.focus();
      const pos = Math.min(caret ?? again.value.length, again.value.length);
      again.setSelectionRange(pos, pos);
    }
  }
}

function openTask(task: Task): void {
  openId = task.id;
  draft = cloneTask(task);
  openUpdatedAt = task.updatedAt;
  dirty = false;
  isNew = false;
  runsExpanded = false;
  staleNote = null;
  formError = null;
  confirmDeleteAt = 0; // 删除确认不跨任务泄漏
}

function openNew(): void {
  const providers = catalog?.providers ?? [];
  const provider = providers[0]?.id ?? "";
  const account = forceWindowAccount(provider, providers);
  const win = windowOptions(provider, account, "", providers).find((o) => o.value)?.value ?? "";
  draft = {
    id: "",
    name: "",
    enabled: true,
    provider,
    account,
    model: "",
    message: "hi",
    trigger: { kind: "window", window: win },
    createdAt: "",
    updatedAt: "",
  };
  openId = NEW_ID;
  openUpdatedAt = null;
  dirty = true; // 新任务从打开起就处于「未保存」，取消即丢弃
  isNew = true;
  runsExpanded = false;
  staleNote = null;
  formError = null;
  confirmDeleteAt = 0;
  render();
  f?.name.focus();
}

function closeEditor(): void {
  openId = null;
  draft = null;
  openUpdatedAt = null;
  dirty = false;
  isNew = false;
  runsExpanded = false;
  staleNote = null;
  formError = null;
  confirmDeleteAt = 0;
  f = null;
}

function cancelEdit(): void {
  if (isNew || !openId) {
    closeEditor();
    render();
    return;
  }
  const saved = currentSavedTask();
  if (!saved) {
    closeEditor();
    render();
    return;
  }
  // 还原到已保存的版本（比还原到展开时的快照更安全：别处刚保存过也不会复活旧内容）
  draft = cloneTask(saved);
  openUpdatedAt = saved.updatedAt;
  dirty = false;
  formError = null;
  staleNote = null;
  render();
}

async function save(): Promise<void> {
  const d = draft;
  if (!d || !openId) return;
  const check = validateDraft(d);
  if (check) {
    formError = check.error;
    render();
    if (check.field === "name") f?.name.focus();
    return;
  }
  const content = contentOf(d);
  const input = {
    ...content,
    name: content.name.trim(),
    provider: content.provider.trim(),
    account: content.account.trim(),
    model: content.model.trim(),
  };
  try {
    if (isNew) await apiJSON<Task>("api/tasks", { method: "POST", body: JSON.stringify(input) });
    else await apiJSON<Task>(`api/tasks/${encodeURIComponent(openId)}`, { method: "PUT", body: JSON.stringify(input) });
  } catch (e) {
    formError = errText(e);
    render();
    return;
  }
  // 请求期间用户可能已切到别的任务，成功状态只落回发起保存的那个
  if (!draft || !openId || d !== draft) {
    return;
  }
  dirty = false;
  formError = null;
  if (isNew) closeEditor(); // 保存成功即收起，列表里见（注意：原型实为保持展开仅清脏标记，见报告）
  await refreshState();
}

async function removeCurrent(): Promise<void> {
  const saved = currentSavedTask();
  if (!saved) {
    closeEditor(); // 新任务未保存：放弃即丢弃
    render();
    return;
  }
  if (!deleteArmed(confirmDeleteAt, Date.now())) {
    confirmDeleteAt = Date.now();
    render();
    window.setTimeout(() => {
      if (confirmDeleteAt !== 0 && !deleteArmed(confirmDeleteAt, Date.now())) {
        confirmDeleteAt = 0;
        render();
      }
    }, DELETE_CONFIRM_MS + 100);
    return;
  }
  confirmDeleteAt = 0;
  try {
    await apiJSON<{ ok: boolean }>(`api/tasks/${encodeURIComponent(saved.id)}`, { method: "DELETE" });
    closeEditor();
    await refreshState();
  } catch (e) {
    actionError = errText(e);
    render();
  }
}

async function runNow(): Promise<void> {
  const task = currentSavedTask();
  if (!task) return;
  try {
    await apiJSON<Run>(`api/tasks/${encodeURIComponent(task.id)}/run`, { method: "POST" });
    await refreshState();
  } catch (e) {
    formError = errText(e);
    render();
  }
}

/** 行内开关：已保存任务立即落库（只翻 enabled，不带上未保存的修改）；未保存草稿就地翻转 */
async function toggleEnabled(saved: Task | null): Promise<void> {
  if (!saved) {
    if (!draft) return;
    draft.enabled = !draft.enabled;
    dirty = true;
    render();
    return;
  }
  const input = { ...contentOf(saved), enabled: !saved.enabled };
  try {
    const updated = await apiJSON<Task>(`api/tasks/${encodeURIComponent(saved.id)}`, { method: "PUT", body: JSON.stringify(input) });
    // 自家开关的落库不算「别处更新」：对齐展开中任务的版本基准，避免误显琥珀提示
    if (openId === saved.id) openUpdatedAt = updated.updatedAt;
    await refreshState();
  } catch (e) {
    actionError = errText(e);
    render();
  }
}

function buildEditor(): HTMLElement {
  const d = draft;
  if (!d) return el("div");
  const providers = catalog?.providers ?? [];
  const provider = providers.find((p) => p.id === d.provider);
  const ed = el("div", "editor");
  // 所选账号没有可跟随的窗口时，不再提供「窗口重置后」；已存任务若正用着它，
  // 这次打开就落到每天定时（需要点保存才写入，取消即还原），免得留一个必然失败的任务
  let droppedWindow = false;
  if (d.trigger.kind === "window" && !accountHasWindows(d.provider, d.account, providers)) {
    d.trigger = { kind: "daily", time: "06:00", timeZone: localTZ() };
    droppedWindow = true;
  }

  // 上次失败红字（只看已保存任务自己的记录）
  const saved = currentSavedTask();
  if (saved && d.enabled) {
    const last = latestRunOf(saved.id);
    if (last && last.outcome === "failed") {
      const n = el("div", "note full");
      n.append(`上次失败（${runTimeLabel(last.startedAt, new Date())}）：`);
      n.append(el("span", undefined, `${last.reason}。任务没有暂停，下一次照常发送。`));
      ed.append(n);
    }
  }
  if (staleNote) ed.append(el("div", "stale full", staleNote));
  if (formError) ed.append(el("div", "note full", formError));

  // 名称
  const name = el("input", "text") as HTMLInputElement;
  name.value = d.name;
  name.maxLength = NAME_MAX; // 与校验同上限，别让 41+ 字输进去才在保存时报错
  name.placeholder = "给任务起个名字";
  name.addEventListener("input", () => onNameInput(() => {
    if (draft) draft.name = name.value;
  }));
  row(ed, "名称", name);

  // 发送到：供应商 / 账号 / 模型
  const fs = el("div", "fields c3");
  const provOpts: SelOption[] = providers.map((p) => ({ value: p.id, text: p.id }));
  if (d.provider && !provOpts.some((o) => o.value === d.provider)) provOpts.unshift({ value: d.provider, text: d.provider });
  if (!provOpts.length) provOpts.push({ value: "", text: "选择供应商" });
  fs.append(sel("供应商", provOpts, d.provider, (v) => {
    markDirty();
    if (!draft) return;
    draft.provider = v;
    // 换供应商后账号与模型都回到未定状态；窗口触发立即挑一个账号，窗口名挑该账号的第一个
    draft.account = draft.trigger.kind === "window" ? forceWindowAccount(v, providers) : "";
    if (draft.trigger.kind === "window") {
      draft.trigger = { kind: "window", window: windowOptions(v, draft.account, "", providers).find((o) => o.value)?.value ?? "" };
    }
    draft.model = "";
    formError = null;
    render();
  }));
  if (d.trigger.kind === "window" && !d.account) d.account = forceWindowAccount(d.provider, providers);
  /** 切账号：当前固定模型不在该账号列表里就回「自动」。打开已存任务不重置，只有主动切换才重置 */
  const adoptAccount = (v: string): void => {
    if (!draft) return;
    draft.account = v;
    if (draft.model && !accountModelView(provider, v).models?.includes(draft.model)) draft.model = "";
  };
  const allowAuto = d.trigger.kind !== "window";
  fs.append(sel("账号", accountOptions(d.provider, d.account, allowAuto, providers), d.account, (v) => {
    markDirty();
    adoptAccount(v);
    if (draft && draft.trigger.kind === "window") {
      draft.trigger = { kind: "window", window: windowOptions(draft.provider, v, "", providers).find((o) => o.value)?.value ?? "" };
    }
    formError = null;
    render();
  }));
  const view = accountModelView(provider, d.account);
  fs.append(sel("模型", modelOptions(d.provider, d.account, d.model, providers), d.model, (v) => {
    markDirty();
    if (draft) draft.model = v;
    formError = null;
    render();
  }, view.models === null));
  const parts: HTMLElement[] = [fs];
  if (view.models === null) {
    parts.push(el("div", "hint warn", NO_MODELS_HINT));
  } else {
    const mh = modelHint(d.model, provider, d.account);
    parts.push(el("div", "hint", mh.main), el("div", "hint mute", mh.sub));
    if (view.perAccount === false) {
      parts.push(el("div", "hint mute", "这个供应商没有按账号区分的模型列表，列出的是全部模型"));
    }
    parts.push(el("div", "hint mute", MODEL_SOURCE_HINT));
  }
  if (d.trigger.kind === "window") {
    parts.push(el("div", "hint mute", "跟随窗口重置时必须指定账号，每个账号的窗口各自计时。"));
  }
  row(ed, "发送到", ...parts);

  // 触发：按所选账号有没有窗口决定是否给「窗口重置后」，其余两档始终可用
  const hasWindows = accountHasWindows(d.provider, d.account, providers);
  const seg = el("div", "seg");
  for (const [k, txt] of TRIGGERS) {
    if (k === "window" && !hasWindows) continue;
    const b = el("button", d.trigger.kind === k ? "on" : "", txt) as HTMLButtonElement;
    b.type = "button";
    b.addEventListener("click", () => {
      if (!draft || draft.trigger.kind === k) return;
      markDirty();
      if (k === "window") {
        adoptAccount(draft.account || forceWindowAccount(draft.provider, providers));
        draft.trigger = { kind: "window", window: windowOptions(draft.provider, draft.account, "", providers).find((o) => o.value)?.value ?? "" };
      } else if (k === "daily") {
        draft.trigger = { kind: "daily", time: "06:00", timeZone: localTZ() };
      } else {
        draft.trigger = { kind: "every", hours: 24, anchor: new Date().toISOString() };
      }
      formError = null;
      render();
    });
    seg.append(b);
  }
  const line = el("div", "fields " + (d.trigger.kind === "window" ? "c1" : "c2"));
  line.style.marginTop = "8px";
  if (d.trigger.kind === "window") {
    const winName = d.trigger.window;
    line.append(sel("窗口", windowOptions(d.provider, d.account, winName, providers), winName, (v) => {
      markDirty();
      if (draft && draft.trigger.kind === "window") draft.trigger = { kind: "window", window: v };
      formError = null;
      render();
    }));
  } else if (d.trigger.kind === "daily") {
    const ti = el("input") as HTMLInputElement;
    ti.type = "time";
    ti.value = d.trigger.time;
    ti.addEventListener("change", () => {
      markDirty();
      if (draft && draft.trigger.kind === "daily") draft.trigger = { ...draft.trigger, time: ti.value };
      formError = null;
      render();
    });
    const tz = sel("时区", timezoneOptions(), d.trigger.timeZone, (v) => {
      markDirty();
      if (draft && draft.trigger.kind === "daily") draft.trigger = { ...draft.trigger, timeZone: v };
      render();
    });
    line.append(field("时间", ti), tz);
  } else {
    const hoursOpts: SelOption[] = [1, 2, 3, 4, 5, 6, 8, 12, 24, 48, 72, 168].map((n) => ({ value: String(n), text: `${n} 小时` }));
    const hv = String(d.trigger.hours);
    if (!hoursOpts.some((o) => o.value === hv)) hoursOpts.unshift({ value: hv, text: `${hv} 小时` });
    line.append(sel("每", hoursOpts, hv, (v) => {
      markDirty();
      if (draft && draft.trigger.kind === "every") draft.trigger = { ...draft.trigger, hours: Number(v) };
      formError = null;
      render();
    }));
    const an = el("input") as HTMLInputElement;
    an.type = "datetime-local";
    an.value = isoToLocalInput(d.trigger.anchor);
    an.addEventListener("change", () => {
      markDirty();
      if (draft && draft.trigger.kind === "every") {
        draft.trigger = { ...draft.trigger, anchor: localInputToISO(an.value) ?? draft.trigger.anchor };
      }
      formError = null;
      render();
    });
    line.append(field("从", an));
  }
  const nextEl = el("div", "next");
  const now = new Date();
  const useServer = !!(saved && !dirty && state);
  if (d.trigger.kind === "window") {
    const winName = d.trigger.window;
    let first = "";
    const nextIso = useServer && saved ? state?.next[saved.id] ?? null : null;
    if (nextIso) first = nextLabel(nextIso, now);
    if (!first) {
      const win = provider?.accounts.find((a) => a.id === d.account)?.windows.find((w) => w.name === winName);
      if (win?.resetsAt) {
        first = nextLabel(new Date(new Date(win.resetsAt).getTime() + RESET_GRACE_MS).toISOString(), now);
      }
    }
    nextEl.append("接下来 ", el("b", undefined, first ? `${first}，之后跟随每次重置` : "等下一次额度刷新，之后跟随每次重置"));
  } else {
    const dates: Date[] = [];
    const trig = saved?.trigger ?? null;
    const nextIso = useServer && saved ? state?.next[saved.id] ?? null : null;
    if (useServer && trig && trig.kind !== "window" && nextIso) {
      // 服务端权威的第一个点起，往后按规则展示两个
      let cursor = new Date(nextIso);
      dates.push(cursor);
      for (let i = 0; i < 2; i++) {
        cursor = trig.kind === "daily"
          ? nextDailyLocal(trig.time, trig.timeZone, cursor)
          : nextEveryLocal(trig.hours, trig.anchor, cursor);
        dates.push(cursor);
      }
    } else {
      dates.push(...nextPointsAfter(d.trigger, now, 3));
    }
    nextEl.append("接下来 ", el("b", undefined, dates.length ? dates.map((x) => nextLabel(x.toISOString(), now)).join(" · ") : "—"));
  }
  if (droppedWindow) {
    nextEl.prepend(el("div", "hint mute", "这个账号没有可跟随的窗口，已改为每天定时，保存后生效。"));
  }
  row(ed, "触发", seg, line, nextEl);

  // 操作行：删除靠左；有未保存修改才出现提示、取消与保存
  const act = el("div", "actions full");
  const del = el("button", "btn danger", saved ? (deleteArmed(confirmDeleteAt, Date.now()) ? "确认删除" : "删除") : "放弃") as HTMLButtonElement;
  del.type = "button";
  del.disabled = isReadonly();
  del.addEventListener("click", () => void removeCurrent());
  act.append(del, el("span", "sp"));
  if (dirty) {
    act.append(el("span", "dirty-tip", "有未保存的修改"));
    const cancel = el("button", "btn", "取消") as HTMLButtonElement;
    cancel.type = "button";
    cancel.addEventListener("click", cancelEdit);
    const saveBtn = el("button", "btn primary", "保存") as HTMLButtonElement;
    saveBtn.type = "button";
    saveBtn.disabled = isReadonly();
    saveBtn.addEventListener("click", () => void save());
    act.append(cancel, saveBtn);
  }
  ed.append(act);

  // 执行记录直接展示在编辑区底部
  const box = el("div", "full");
  const rh = el("div", "runs-h");
  rh.append(el("b", undefined, "执行记录"), el("span", undefined, "最近 50 次"), el("span", "sp"));
  const runBtn = el("button", "link", "立即发送一次") as HTMLButtonElement;
  runBtn.type = "button";
  runBtn.disabled = isNew || isReadonly();
  runBtn.title = isNew
    ? "先保存任务"
    : dirty
      ? "按已保存的设置发送，不含未保存的修改"
      : "马上按当前设置发一条，不影响计划";
  runBtn.addEventListener("click", () => void runNow());
  rh.append(runBtn);
  box.append(rh);
  const runsBox = el("div", "runs");
  const all = saved
    ? (state?.runs ?? []).filter((r) => r.taskId === saved.id).slice().sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1))
    : [];
  const shown = all.slice(0, runsExpanded ? RUNS_MAX : RUNS_PREVIEW);
  if (!shown.length) {
    const e = el("div", "empty", "还没有执行过。");
    e.style.padding = "14px";
    runsBox.append(e);
  }
  for (const r of shown) {
    const out = runOutcome(r.outcome);
    const lineEl = el("div", "run");
    lineEl.append(
      el("span", "t", runTimeLabel(r.startedAt, now)),
      el("span", `r ${out.tone}`.trim(), out.text),
      el("span", "why", runReason(r)),
    );
    runsBox.append(lineEl);
  }
  if (!runsExpanded && all.length > RUNS_PREVIEW) {
    const more = el("button", "more", "显示更多") as HTMLButtonElement;
    more.type = "button";
    more.addEventListener("click", () => {
      runsExpanded = true;
      render();
    });
    runsBox.append(more);
  }
  box.append(runsBox);
  ed.append(box);
  f = { name }; // 回填 refs：重建后的焦点/光标恢复与校验聚焦都靠它
  return ed;
}

// ---------- 列表与顶栏 ----------

/** 行视图签名：已存任务看服务端版本，展开中的任务看草稿的结构字段（名称不算，避免打字重建） */
function draftDisplaySig(): string | null {
  if (!draft) return null;
  const d = draft;
  return JSON.stringify([d.enabled, d.provider, d.account, d.model, d.trigger]);
}

function catalogSig(): string {
  // 页面渲染吃到的目录字段都在这里：账号的模型列表/自动模型/perAccount 变了也要重建下拉与提示
  return JSON.stringify(
    (catalog?.providers ?? []).map((p) => [
      p.id,
      p.autoModel,
      p.autoAccountModels,
      p.accounts.map((a) => [
        a.id,
        a.label,
        a.kind,
        a.perAccount,
        a.autoModel,
        a.models,
        a.windows.map((w) => [w.name, w.used, w.resetsAt]),
      ]),
      p.models.map((m) => m.id),
    ]),
  );
}

function runsViewSig(): string {
  const saved = currentSavedTask();
  const runs = saved ? (state?.runs ?? []).filter((r) => r.taskId === saved.id) : [];
  return JSON.stringify(runs.map((r) => [r.id, r.outcome, r.reason, r.effort, r.model, r.ms, r.source, r.startedAt]));
}

function rowEl(view: Task, saved: Task | null, isOpen: boolean): HTMLElement {
  const status = statusOf(view, state?.runs ?? []);
  const r = el("div", "row" + (isOpen ? " open" : "") + (view.enabled ? "" : " dim"));
  r.tabIndex = 0;
  r.setAttribute("role", "button");
  r.setAttribute("aria-expanded", isOpen ? "true" : "false");
  const who = el("div", "who");
  who.append(el("div", "name", view.name || "未命名任务"), el("div", "sub", rowSub(view, catalog?.providers ?? [])));
  const when = el("div", "when");
  if (view.enabled) {
    const at = saved ? state?.next[saved.id] ?? null : null;
    when.append(el("div", "t", nextLabel(at, new Date())));
  }
  if (status.text) when.append(el("div", `s ${status.tone}`.trim(), status.text));
  const sw = el("button", "sw" + (view.enabled ? " on" : "")) as HTMLButtonElement;
  sw.type = "button";
  sw.setAttribute("role", "switch");
  sw.setAttribute("aria-label", "启用");
  sw.setAttribute("aria-checked", view.enabled ? "true" : "false");
  sw.addEventListener("click", (e) => {
    e.stopPropagation();
    void toggleEnabled(saved);
  });
  r.append(who, when, sw, el("span", "chev", "›"));
  r.addEventListener("click", () => {
    // 再点一次收起 = 取消：已存任务丢弃未保存修改，未保存的新任务直接不要了
    if (isOpen) {
      closeEditor();
      render();
    } else if (saved) {
      openTask(saved);
      render();
    }
  });
  r.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      r.click();
    }
  });
  return r;
}

function renderList(): void {
  const list = document.getElementById("list");
  if (!list) return;
  const tasks = state?.tasks ?? [];
  const confirming = deleteArmed(confirmDeleteAt, Date.now());
  const sig = JSON.stringify([
    tasks.map((t) => [t.id, t.updatedAt, t.enabled, state?.next[t.id] ?? null, statusOf(t, state?.runs ?? [])]),
    openId,
    isNew,
    draftDisplaySig(),
    dirty,
    formError,
    staleNote,
    isReadonly(),
    runsExpanded,
    confirming,
    catalogSig(),
    runsViewSig(),
    state === null,
  ]);
  replaceChildrenIfChanged(list, sig, () => {
    if (!state) return []; // 首次状态没到之前先空着，避免闪「还没有任务」
    const nodes: Node[] = [];
    if (isReadonly()) {
      const e = el("div", "empty", "当前无法编辑任务。");
      nodes.push(e);
      return nodes;
    }
    if (!tasks.length && !isNew) {
      const e = el("div", "empty");
      e.append(el("b", undefined, "还没有任务"), "点「新建任务」，选好账号和触发方式即可。");
      nodes.push(e);
      return nodes;
    }
    if (isNew && draft) nodes.push(rowEl(draft, null, true));
    for (const t of tasks) {
      const open = openId === t.id;
      nodes.push(rowEl(open && draft ? draft : t, t, open));
    }
    if (openId && draft) nodes.push(buildEditor());
    return nodes;
  });
}

function renderSum(): void {
  const sum = document.getElementById("sum");
  if (!sum) return;
  sum.replaceChildren();
  if (!state) return;
  const view = sumView(state.tasks, state.next);
  if (!view.enabled) {
    sum.textContent = "没有启用的任务";
    return;
  }
  // 窗口任务等额度刷新期间可能全都没有下次执行点，此时不留悬空的「下一次」
  sum.append(`${view.enabled} 个任务启用`);
  if (view.next) {
    sum.append(" · 下一次 ", el("b", undefined, nextLabel(view.next.at, new Date())), ` ${view.next.name}`);
  }
}

function renderBars(): void {
  const bars = document.getElementById("bars");
  if (!bars) return;
  const nodes: HTMLElement[] = [];
  if (netError) nodes.push(el("div", "notice bad", `页面与服务断开了：${netError}（服务可能已退出，重新打开页面试试）`));
  if (state?.fatal) nodes.push(el("div", "notice bad", `服务处于故障状态，任务没有在运行：${state.fatal}`));
  if (state && typeof state.lockedBy === "number") {
    nodes.push(el("div", "notice warn", state.lockedBy > 0
      ? `另一个实例正在运行（进程 ${state.lockedBy}），本页只读。`
      : "另一个实例可能正在运行（无法确认持有者进程），本页只读。"));
  }
  if (state?.saveError) nodes.push(el("div", "notice warn", `数据可能没保存：${state.saveError}`));
  if (catalogError) nodes.push(el("div", "notice warn", `模型目录读取失败：${catalogError}（稍后自动重试）`));
  if (actionError) nodes.push(el("div", "notice bad", actionError));
  bars.replaceChildren(...nodes);
}

function render(): void {
  renderBars();
  renderSum();
  renderList();
  const newBtn = document.getElementById("new") as HTMLButtonElement | null;
  if (newBtn) newBtn.disabled = isReadonly();
}

// ---------- 数据刷新 ----------

async function refreshState(): Promise<void> {
  try {
    state = await apiJSON<StateView>("api/state");
    netError = "";
    actionError = "";
  } catch (e) {
    netError = errText(e);
    render();
    return;
  }
  syncOpen();
  render();
}

/** 轮询与展开中草稿的和解：未保存编辑不覆盖；无编辑则采纳服务端版本；任务没了就收起 */
function syncOpen(): void {
  if (!openId || isNew || !draft) return;
  const saved = state?.tasks.find((t) => t.id === openId) ?? null;
  const act = syncDraftOnPoll(saved, openUpdatedAt, dirty);
  if (act === "gone") {
    closeEditor();
    return;
  }
  if (act === "adopt" && saved) {
    draft = cloneTask(saved);
    openUpdatedAt = saved.updatedAt;
    staleNote = null;
    return;
  }
  if (act === "stale") {
    staleNote = "这个任务刚在别处被更新。下面保留的是你未保存的修改，直接保存会覆盖新版本。";
  }
}

async function refreshCatalog(): Promise<void> {
  try {
    catalog = await apiJSON<Catalog>("api/catalog");
    catalogError = "";
  } catch (e) {
    catalogError = errText(e);
  }
  render();
}

// ---------- 启动 ----------

function applyTheme(): void {
  if (!boot) return;
  if (boot.theme === "dark") document.body.classList.add("dark");
  else if (boot.theme === "light") document.body.classList.remove("dark");
  if (boot.tokens) {
    try {
      const vars = JSON.parse(b64decode(boot.tokens)) as Record<string, unknown>;
      for (const [k, v] of Object.entries(vars)) {
        if (k.startsWith("--") && typeof v === "string" && v) {
          document.documentElement.style.setProperty(k, v);
        }
      }
    } catch { /* 令牌解不出来就只带主题 */ }
  }
}

function init(): void {
  const raw = document.getElementById("boot")?.textContent ?? "";
  try {
    boot = JSON.parse(raw) as BootData;
  } catch {
    boot = null;
  }
  if (!boot?.token) {
    document.getElementById("bars")?.replaceChildren(el("div", "notice bad", "页面缺少访问口令，请从 Magpie 的插件页重新打开。"));
    return;
  }
  applyTheme();
  document.getElementById("new")?.addEventListener("click", () => {
    if (!isReadonly() && !isNew) openNew();
  });
  document.addEventListener("mousedown", (e) => {
    if (popEl && e.target instanceof Node && !popEl.contains(e.target) && !popEl.btn.contains(e.target)) closePop();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closePop();
  });
  document.addEventListener("scroll", (e) => {
    if (shouldCloseOnScroll(e.target, popEl)) closePop();
  }, true);
  void refreshCatalog().then(() => refreshState());
  setInterval(() => {
    if (document.hidden) return;
    void refreshState();
  }, POLL_MS);
  catalogTimer = setInterval(() => {
    if (document.hidden) return;
    void refreshCatalog();
  }, CATALOG_POLL_MS);
}

// 测试环境没有 DOM，直接 import 不初始化；浏览器里模块脚本执行时 DOM 已就绪
if (typeof document !== "undefined") {
  if (document.getElementById("boot")) init();
  else document.addEventListener("DOMContentLoaded", init);
}
