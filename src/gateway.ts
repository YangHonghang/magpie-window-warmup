// 和 Magpie 网关说话的客户端：列模型、读额度、发预热消息。
// 一切请求只打本地网关（base 由 gatewayBase 从 MAGPIE_ADDR 推出），超时都偏短：
// 网关不可达时调度层要把失败写进执行记录，而不是被挂住的请求拖死。

import type {
  Catalog,
  CatalogProvider,
  EffortPick,
  QuotaEntry,
  QuotaWindow,
  RawModel,
  SendResult,
  Task,
} from "./types";

/** MAGPIE_ADDR 缺省时的老端口 */
const DEFAULT_GATEWAY = "http://127.0.0.1:3425";
/** 单次发送的 token 上限：预热消息只是探活，不追求完整回答 */
const SEND_MAX_TOKENS = 16;
/** 发送超时；超了只能记 unknown（请求可能已送达上游） */
const SEND_TIMEOUT_MS = 30_000;
/** 目录/额度的读取超时：页面加载与调度刷新都不该被挂死的网关拖住 */
const READ_TIMEOUT_MS = 10_000;
/**
 * 完整额度读取（不带 kept）的超时。这一路会问上游要最新余额，magpie 侧自身限 12 秒
 * （internal/gateway/gateway.go quotas 的 ctx timeout），放宽到 15 秒兜住网络往返。
 */
const FULL_QUOTAS_TIMEOUT_MS = 15_000;
/** 两次完整额度读取的最小间隔：kept 缓存空窗期（magpie 刚启动）内的兜底读取不许每次都打 */
const MIN_FULL_GAP_MS = 5 * 60_000;
/** 上游错误原因截断长度，避免个别上游把整页 HTML 塞进 error.message */
const REASON_MAX = 200;

/** 超时属于「结果未知」：请求可能已被网关受理，不能当失败自动重发。文案带实际时长，测试注入短超时时不会谎报 30 秒 */
function timeoutReason(timeoutMs: number): string {
  const duration = timeoutMs % 1000 === 0 ? `${timeoutMs / 1000} 秒` : `${timeoutMs} 毫秒`;
  return `${duration}内没有结果，可能已发送`;
}

export function gatewayBase(env: Record<string, string | undefined> = process.env): string {
  const addr = env.MAGPIE_ADDR?.trim().replace(/\/+$/, "");
  if (!addr) return DEFAULT_GATEWAY;
  // 容忍直接给完整地址（含 https:// 的远程网关）
  if (/^https?:\/\//.test(addr)) return addr;
  return `http://${addr}`;
}

/** 已知名档的优先序；纯数字档（思考预算）低于所有命名档，未知名排在已知名之后 */
const KNOWN_EFFORT_RANK: Record<string, number> = {
  minimal: 0,
  low: 1,
  medium: 2,
  high: 3,
  xhigh: 4,
  max: 5,
};

/** "disabled"/"off" 是「支持关闭」的写法，归一成 none 才能参与档位比较；发送值保留模型原样 */
function normalizeLevel(s: string): string {
  const t = s.trim();
  const low = t.toLowerCase();
  if (low === "disabled" || low === "off") return "none";
  return t;
}

/**
 * 取模型的档位列表：reasoning_levels 优先，否则 supported_reasoning_levels[].effort
 * （字段形状随模型而变，这里运行时校验）。字段存在却提不出任何档位视为数据损坏。
 */
function levelList(model: RawModel): string[] | { error: string } {
  const raw = model.reasoning_levels;
  if (raw !== undefined && raw !== null) {
    // 宁可报错也不能把坏数据误判成「模型不思考」——那会漏发 reasoning_effort
    if (!Array.isArray(raw)) return { error: "模型的思考档位数据无法识别" };
    const list = raw.filter((s): s is string => typeof s === "string");
    if (raw.length > 0 && list.length === 0) return { error: "模型的思考档位数据无法识别" };
    return list;
  }
  const supported = model.supported_reasoning_levels;
  if (supported !== undefined && supported !== null) {
    if (!Array.isArray(supported)) return { error: "模型的思考档位数据无法识别" };
    const list = supported
      .map((x) => (typeof x === "object" && x !== null ? (x as { effort?: unknown }).effort : null))
      .filter((s): s is string => typeof s === "string");
    if (supported.length > 0 && list.length === 0) return { error: "模型的思考档位数据无法识别" };
    return list;
  }
  return [];
}

/**
 * 每次发送前从当次模型列表现算思考档位（任务不存档位，模型配置变了自动跟随）：
 * - reasoning 为假或列表为空 → 模型不思考，不带 reasoning_effort
 * - 含 none → 能关就关
 * - 否则取该模型自己的最低一档（必须思考就开最低）
 */
export function pickEffort(model: RawModel): EffortPick {
  const levels = levelList(model);
  if ("error" in levels) return levels;
  if (!model.reasoning || levels.length === 0) {
    return { send: null, label: "不适用" };
  }
  const normalized = levels.map(normalizeLevel).filter((s) => s !== "");
  if (normalized.length === 0) return { send: null, label: "不适用" };
  if (normalized.some((s) => s.toLowerCase() === "none")) {
    return { send: "none", label: "关闭（模型支持关闭）" };
  }
  // 稳定排序键：组别 → 组内次序 → 列表原序（未知名保持模型给出的顺序）
  const decorated = normalized.map((s, i) => {
    if (/^\d+$/.test(s)) return { s, group: 0, rank: Number(s), i };
    const known = KNOWN_EFFORT_RANK[s.toLowerCase()];
    return { s, group: known === undefined ? 2 : 1, rank: known ?? i, i };
  });
  decorated.sort((a, b) => a.group - b.group || a.rank - b.rank || a.i - b.i);
  const lowest = decorated[0].s;
  const allUnknown = decorated.every((d) => d.group === 2);
  return {
    send: lowest,
    label: allUnknown ? `${lowest}（按模型列表第一档）` : `${lowest}（模型必须思考，已用最低档）`,
  };
}

/** 提取上游错误说明；不是 JSON 就原样截断 */
function errorReason(text: string): string {
  try {
    const parsed = JSON.parse(text) as { error?: { message?: unknown } };
    const msg = parsed?.error?.message;
    if (typeof msg === "string" && msg.trim()) return msg.trim().slice(0, REASON_MAX);
  } catch {
    /* 非 JSON 响应体 */
  }
  return text.trim().slice(0, REASON_MAX) || "上游未返回错误说明";
}

async function requestJSON(
  base: string,
  path: string,
  signal?: AbortSignal,
  timeoutMs: number = READ_TIMEOUT_MS,
): Promise<unknown> {
  // 外部 signal（发送被停用/删除）与读超时一并生效，取元数据阶段也能被立即中止
  const timeout = AbortSignal.timeout(timeoutMs);
  let res: Response;
  try {
    res = await fetch(base + path, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
  } catch {
    throw new Error(`连不上 Magpie（${base}）`);
  }
  const text = await res.text().catch(() => "");
  if (!res.ok) throw new Error(`HTTP ${res.status}：${errorReason(text)}`);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`Magpie 返回的不是 JSON（${path}）`);
  }
}

/** 兼容裸数组与 {data:[...]} 两种包法 */
function dataArray(data: unknown): unknown[] {
  if (Array.isArray(data)) return data;
  if (typeof data === "object" && data !== null && Array.isArray((data as { data?: unknown }).data)) {
    return (data as { data: unknown[] }).data;
  }
  return [];
}

function coerceWindow(w: unknown): QuotaWindow {
  const raw = typeof w === "object" && w !== null ? (w as Record<string, unknown>) : {};
  return {
    name: typeof raw.name === "string" ? raw.name : "",
    used: typeof raw.used === "number" ? raw.used : null,
    resetsAt: typeof raw.resetsAt === "string" ? raw.resetsAt : null,
  };
}

/**
 * 远程 magpie 给每把网关 key 单独发一张限额卡，provider 记作 "<p>/~keys"、user 是 key 名
 * （magpie internal/provider/remote_key_limits.go 的 remoteKeyCard）。而 /v1/models 的
 * owned_by 是 "<p>" 本身——不归并的话这些 key 账号永远挂不上供应商，任务没法选它们。
 * 这里把卡归回供应商 <p>，账号 id 沿用 key 名。供应商 id 不含 "~"（同上出处），后缀不会撞车。
 */
function quotaProvider(raw: string): string {
  return raw.endsWith("/~keys") ? raw.slice(0, -"/~keys".length) : raw;
}

/** 把 /v1/magpie/quotas 的响应体归一成条目列表；没有归属的条目挂不到任务上，跳过 */
function parseQuotas(data: unknown): QuotaEntry[] {
  const entries: QuotaEntry[] = [];
  for (const item of dataArray(data)) {
    if (typeof item !== "object" || item === null) continue;
    const q = item as Record<string, unknown>;
    const provider = quotaProvider(typeof q.provider === "string" ? q.provider : "");
    const user = typeof q.user === "string" ? q.user : "";
    if (!provider || !user) continue;
    entries.push({
      provider,
      account: user,
      label: typeof q.name === "string" && q.name ? q.name : user,
      windows: (Array.isArray(q.windows) ? q.windows : []).map(coerceWindow),
    });
  }
  return entries;
}

export type QuotasFn = (base: string) => Promise<{ at: Date; entries: QuotaEntry[] }>;

/**
 * 额度读取：平时 ?kept=1 只读缓存（绝不触发上游探测）。magpie 刚启动时缓存为空，
 * 这时兜底读一次不带 kept 的完整接口（只读余额，不发模型请求，15 秒超时）。
 * 完整读取按「尝试时刻」节流：任何一次尝试（成功或失败）之后 5 分钟内不再发起新的尝试，
 * 期间直接用上次成功结果，没有就当空——否则 magpie 不可达时，页面 60 秒的目录轮询
 * 与调度器刷新会反复重打上游，还要各自等满 15 秒超时。失败同样吃节流，但发起那次
 * 的错误如实抛给调用方（页面目录兜成空账号，调度器保留旧快照）。
 * 并发的兜底读取合并成同一次尝试，保证「至少间隔 5 分钟」在并发下同样成立。
 * 目录（fetchCatalog）与调度器的窗口评估都走这里，共用同一份缓存。
 */
export function createQuotaReader(opts: { now?: () => Date } = {}): QuotasFn {
  const nowFn = opts.now ?? (() => new Date());
  /** base → 上次成功读到的额度：节流窗口内的兜底结果 */
  const lastGood = new Map<string, { at: Date; entries: QuotaEntry[] }>();
  /** base → 上次完整读取的尝试时刻（成功失败都记）：节流按尝试计，不看成败 */
  const lastAttempt = new Map<string, number>();
  const inflight = new Map<string, Promise<{ at: Date; entries: QuotaEntry[] }>>();
  return async (base) => {
    const kept = parseQuotas(await requestJSON(base, "/v1/magpie/quotas?kept=1"));
    if (kept.length > 0) return { at: nowFn(), entries: kept };
    // 正在进行的那次尝试不算新请求：先并入它，节流判断只管要不要「另起一次」
    let pending = inflight.get(base);
    if (!pending) {
      const now = nowFn().getTime();
      const attempted = lastAttempt.get(base);
      if (attempted !== undefined && now - attempted < MIN_FULL_GAP_MS) {
        return lastGood.get(base) ?? { at: nowFn(), entries: [] };
      }
      // 尝试时刻先记账再发请求：失败也吃节流，不许立刻重试
      lastAttempt.set(base, now);
      pending = requestJSON(base, "/v1/magpie/quotas", undefined, FULL_QUOTAS_TIMEOUT_MS)
        .then((data) => {
          const fresh = { at: nowFn(), entries: parseQuotas(data) };
          lastGood.set(base, fresh);
          return fresh;
        })
        .finally(() => {
          inflight.delete(base);
        });
      inflight.set(base, pending);
    }
    return pending;
  };
}

/** 默认读取器：进程内唯一，目录与调度器（未注入 quotasFn 时）共用同一份完整读取缓存 */
export const fetchQuotas: QuotasFn = createQuotaReader();

/**
 * 拉取原始模型列表（不做目录归并）：调度器每次发送前用它现算该模型的思考档位，
 * 模型配置变了下一次发送自动跟着变。路由组 group/ 一律不接受。
 * signal：调度器在停用/删除任务时传入，中止进行中的取元数据请求。
 */
export async function fetchModels(base: string, signal?: AbortSignal): Promise<RawModel[]> {
  const data = await requestJSON(base, "/v1/models", signal);
  const out: RawModel[] = [];
  for (const item of dataArray(data)) {
    if (typeof item !== "object" || item === null) continue;
    const m = item as RawModel;
    if (typeof m.id !== "string" || !m.id || m.id.startsWith("group/")) continue;
    out.push(m);
  }
  return out;
}

/** 模型归属的供应商 id：owned_by 优先（真正接住请求的一方），否则取 id 首段 */
export function modelProvider(m: RawModel): string {
  const owner = typeof m.owned_by === "string" ? m.owned_by.trim() : "";
  return owner || (m.id.includes("/") ? m.id.slice(0, m.id.indexOf("/")) : "");
}

/**
 * 自动选模型的规格词与优先序：越小越省额度（flash 最小），模型都不含的排最后。
 * 与 pickEffort 一样每次发送前现算，不落进任务。
 */
const AUTO_SPEC_WORDS = ["flash", "lite", "mini", "nano", "small", "turbo"] as const;
const AUTO_SPEC_RES = AUTO_SPEC_WORDS.map((w) => new RegExp(`\\b${w}\\b`, "i"));

/** id 最后一段命中了哪个规格档；单词匹配，"minimax" 不算 mini；都没命中返回词表长度 */
function specTier(id: string): number {
  const seg = id.slice(id.lastIndexOf("/") + 1);
  let best: number = AUTO_SPEC_WORDS.length;
  for (let i = 0; i < AUTO_SPEC_RES.length; i++) {
    if (i < best && AUTO_SPEC_RES[i].test(seg)) best = i;
  }
  return best;
}

/**
 * id 的数字感知比较（降序，新版本在前）：数字段按数值（10 > 9）、文本段按字典序，
 * 一方是另一方的前缀时更长（更具体/更新）的在前。
 */
function cmpNewerDesc(a: string, b: string): number {
  const ta = a.toLowerCase().match(/\d+|\D+/g) ?? [];
  const tb = b.toLowerCase().match(/\d+|\D+/g) ?? [];
  for (let i = 0; i < Math.max(ta.length, tb.length); i++) {
    const x = ta[i];
    const y = tb[i];
    if (x === undefined) return 1;
    if (y === undefined) return -1;
    const nx = /^\d+$/.test(x);
    const ny = /^\d+$/.test(y);
    if (nx && ny) {
      // 数字相等（如 "5" 与 "5.2" 的前段）不算分出胜负，继续比后面的 token
      const d = Number(y) - Number(x);
      if (d !== 0) return d;
    } else if (nx !== ny) {
      return nx ? -1 : 1;
    } else if (x !== y) {
      return y < x ? 1 : -1;
    }
  }
  return 0;
}

/**
 * 自动选模型：在（调用方已按供应商筛好的）候选里，按 id 最后一段的规格词
 * flash < lite < mini < nano < small < turbo 排序取第一个，都没有的排最后；
 * 同档按 id 数字感知降序（新版本优先）。选不到（空列表）返回 null。
 */
export function pickAutoModel(models: RawModel[]): RawModel | null {
  if (models.length === 0) return null;
  const decorated = models.map((m, i) => ({ m, tier: specTier(m.id), i }));
  decorated.sort((a, b) => a.tier - b.tier || cmpNewerDesc(a.m.id, b.m.id) || a.i - b.i);
  return decorated[0].m;
}

/**
 * 模型目录：按 owned_by（真正接住请求的一方）或 id 前缀归供应商，路由组 group/ 一律不列出。
 * 账号与窗口来自 quotas（key 限额卡已归并回供应商）；额度接口挂了不连累模型目录
 * （照搬 fingerprint 的取舍）。autoModel 用与调度器同一套规则在服务端算好，页面直接显示。
 */
export async function fetchCatalog(base: string): Promise<Catalog> {
  const [modelsData, quotas] = await Promise.all([
    requestJSON(base, "/v1/models"),
    fetchQuotas(base).catch(() => ({ at: new Date(), entries: [] as QuotaEntry[] })),
  ]);
  const providers = new Map<string, CatalogProvider>();
  const rawModels = new Map<string, RawModel[]>();
  const ensure = (id: string): CatalogProvider => {
    let p = providers.get(id);
    if (!p) {
      p = { id, accounts: [], models: [], autoModel: null };
      providers.set(id, p);
    }
    return p;
  };
  for (const item of dataArray(modelsData)) {
    if (typeof item !== "object" || item === null) continue;
    const m = item as RawModel;
    if (typeof m.id !== "string" || !m.id || m.id.startsWith("group/")) continue;
    const pid = modelProvider(m);
    // 归不到供应商的模型建不了任务（provider 必填），列出来只会是死选项
    if (!pid) continue;
    ensure(pid);
    const raws = rawModels.get(pid);
    if (raws) raws.push(m);
    else rawModels.set(pid, [m]);
  }
  const seenAccounts = new Set<string>();
  for (const q of quotas.entries) {
    const key = `${q.provider}/${q.account}`;
    if (seenAccounts.has(key)) continue;
    seenAccounts.add(key);
    ensure(q.provider).accounts.push({ id: q.account, label: q.label, windows: q.windows });
  }
  const list = [...providers.values()];
  for (const p of list) {
    const raws = rawModels.get(p.id) ?? [];
    p.models = raws
      .map((m) => ({ id: m.id, effort: pickEffort(m) }))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    p.autoModel = pickAutoModel(raws)?.id ?? null;
    p.accounts.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }
  list.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { providers: list };
}

/** 2xx 的 chat 响应体必须是 JSON 对象；Bun 在流中断时 text() 可能不抛错而返回占位内容，形状校验兜住 */
function usableChatBody(text: string): boolean {
  try {
    const parsed = JSON.parse(text) as unknown;
    return typeof parsed === "object" && parsed !== null;
  } catch {
    return false;
  }
}

/**
 * 发一次预热消息。只有一次请求，成败都如实上报：
 * - 2xx 且响应体是 JSON 对象 → ok
 * - HTTP 错误 → failed（原因 = 状态码 + 上游 error.message）
 * - 连不上 → failed
 * - 超时 / 外部取消 / 2xx 但响应体读不出来 → unknown（请求可能已送达，不允许上层据此自动重发）
 */
export async function send(
  base: string,
  task: Pick<Task, "id" | "account" | "model" | "message">,
  effort: string | null,
  signal: AbortSignal,
  timeoutMs: number = SEND_TIMEOUT_MS,
): Promise<SendResult> {
  const startedAt = Date.now();
  const elapsed = () => Date.now() - startedAt;
  const timer = AbortSignal.timeout(timeoutMs);
  const combined = AbortSignal.any([signal, timer]);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-magpie-session": `window-warmup/${task.id}`,
  };
  // 固定账号用头指定；留空则由网关自动选账号
  if (task.account) headers["x-magpie-account"] = task.account;
  const body: Record<string, unknown> = {
    model: task.model,
    messages: [{ role: "user", content: task.message }],
    max_tokens: SEND_MAX_TOKENS,
    stream: false,
  };
  if (effort) body.reasoning_effort = effort;

  let res: Response;
  try {
    res = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: combined,
    });
  } catch (e) {
    // 外部取消优先于超时上报；连接被重置说明请求多半已送达、响应丢了，
    // 属「结果未知」而不是「连不上」；都未触发才是连接层失败
    if (signal.aborted) return { outcome: "unknown", reason: "发送被取消", ms: elapsed() };
    if (timer.aborted) return { outcome: "unknown", reason: timeoutReason(timeoutMs), ms: elapsed() };
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ECONNRESET" || code === "EPIPE") {
      return { outcome: "unknown", reason: "连接中断，结果未知（可能已发送）", ms: elapsed() };
    }
    return { outcome: "failed", reason: `连不上 Magpie（${base}）`, ms: elapsed() };
  }
  let text = "";
  let bodyBroken = false;
  try {
    text = await res.text();
  } catch {
    bodyBroken = true;
    if (signal.aborted) return { outcome: "unknown", reason: "发送被取消", ms: elapsed() };
    if (timer.aborted) return { outcome: "unknown", reason: timeoutReason(timeoutMs), ms: elapsed() };
  }
  if (res.ok) {
    // 状态码到了但响应体没读出来/不完整：大概率已发送，但无法确认，不能记 ok
    return !bodyBroken && usableChatBody(text)
      ? { outcome: "ok", reason: "", ms: elapsed() }
      : { outcome: "unknown", reason: `HTTP ${res.status}，响应体读取失败，结果未知`, ms: elapsed() };
  }
  return { outcome: "failed", reason: `HTTP ${res.status}：${errorReason(text)}`, ms: elapsed() };
}
