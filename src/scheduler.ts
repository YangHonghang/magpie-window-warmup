// 调度器：任务的时间计算交给 rules，网关交互交给 gateway（可注入假件）。
// 并发模型：所有会改状态的入口（tick/upsert/remove/runNow）都过同一操作队列串行执行，
// 发送本体游离在队列外但登记在 inflight 里 —— 同一任务不重叠、删除/停用能等到收尾，
// 收尾写回前再查任务是否存在，杜绝「删除后异步完成把记录加回来」。
// 单个定时器，延迟 = min(最近到期 − now, 10 分钟)，每次醒来重算（抵御睡眠与改系统时间）。
import { randomUUID } from "node:crypto";
import { modelsForAccount, pinFor, pickAutoModel, windowsForAccount } from "./accounts";
import { fetchModels, fetchQuotas, modelProvider, pickEffort, send } from "./gateway";
import {
  magpieDirs,
  readKeyDirectory,
  readModelCache,
  type CachedModel,
  type KeyDirectoryEntry,
} from "./magpie-files";
import { hourFloorISO, lastDue, nextDaily, nextEvery, upcoming, windowDue } from "./rules";
import type { Store } from "./store";
import type { QuotaEntry, RawModel, Run, SendResult, Task } from "./types";

/** 单个定时器的最长睡眠：醒来重算，弥补系统睡眠/时钟跳变 */
const TIMER_CAP_MS = 600_000;
/** 窗口额度快照的刷新节奏：每 10 分钟及每次到期后 */
const QUOTA_REFRESH_MS = 600_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
/** snapshot 时间轴只画未来 24 小时 */

const INTERRUPTED_REASON = "Magpie 在发送中途退出，结果未知";
const OVERLAP_REASON = "上一次发送还没结束，本次跳过";
const DISABLED_REASON = "任务已停用，发送被取消";
const DELETED_REASON = "任务已删除，发送被取消";
/** HTTP 409：立即发送撞上正在进行的发送 */
export const CONFLICT_MESSAGE = "上一次发送还没结束，请稍后再试";
/** HTTP 404：任务不存在或已删除 */
export const NOT_FOUND_MESSAGE = "任务不存在";

export type SendFn = typeof send;
export type QuotasFn = typeof fetchQuotas;
/** 取模型元数据；signal 在停用/删除时传入，中止进行中的请求（测试假件可不实现） */
export type ModelsFn = (base: string, signal?: AbortSignal) => Promise<RawModel[]>;
/** 读 providers.json 的 key 目录；null = 读不出（指纹账号按「≥2 把 key」处理） */
export type KeyDirFn = () => Promise<Map<string, KeyDirectoryEntry> | null>;
/** 读某供应商的模型缓存；null = 没有缓存文件 */
export type ModelCacheFn = (providerId: string) => Promise<CachedModel[] | null>;
/** 注册定时器，返回取消函数；测试注入假时钟时用它截取回调 */
export type TimerSetter = (fn: () => void, ms: number) => () => void;

/** 新建/全量更新的任务输入；id 缺省表示新建，档位永不入参（发送时现算） */
export type TaskInput = Omit<Task, "id" | "createdAt" | "updatedAt"> & { id?: string };

export interface SchedulerDeps {
  store: Store;
  /** Magpie 网关地址（gatewayBase 的产物） */
  base: string;
  now?: () => Date;
  setTimer?: TimerSetter;
  sendFn?: SendFn;
  quotasFn?: QuotasFn;
  modelsFn?: ModelsFn;
  /** key 目录与模型缓存的读取器；缺省按 magpieDirs() 推导的默认位置读 */
  keyDirFn?: KeyDirFn;
  modelCacheFn?: ModelCacheFn;
}

export interface TimelinePoint {
  taskId: string;
  at: string;
}

/** snapshot() 的返回：页面状态的总览；window 任务的 next 依赖最新额度快照 */
export interface StateView {
  tasks: Task[];
  runs: Run[];
  /** taskId → 下一个执行点 ISO；停用任务为 null */
  next: Record<string, string | null>;
  /** 未来 24 小时内的计划点，按时间升序 */
  timeline: TimelinePoint[];
  /** 最近一次落盘失败的中文原因；成功保存后清除。非 null 时页面应提示「数据可能没保存」 */
  saveError: string | null;
}

type QuotaSnapshot = { at: Date; entries: QuotaEntry[] };
type WindowInfo = { at: Date; resetKey: string } | { at: Date; error: string };

interface Inflight {
  abort: AbortController;
  /** 停用/删除请求的取消标记；置位后收尾把记录改判 unknown */
  cancel: "disabled" | "deleted" | null;
  done: Promise<void>;
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export class Scheduler {
  private readonly store: Store;
  private readonly base: string;
  private readonly nowFn: () => Date;
  private readonly setTimerFn: TimerSetter;
  private readonly sendFn: SendFn;
  private readonly quotasFn: QuotasFn;
  private readonly modelsFn: ModelsFn;
  private readonly keyDirFn: KeyDirFn;
  private readonly modelCacheFn: ModelCacheFn;

  private started = false;
  /** 操作队列：串行执行所有改状态入口，前一个失败不阻塞后一个 */
  private chain: Promise<unknown> = Promise.resolve();
  /** 游离的发送收尾，flush() 等它们 */
  private background: Promise<unknown>[] = [];
  private lastWrite: Promise<void> = Promise.resolve();
  private cancelTimer: (() => void) | null = null;
  /** 当前定时器为每个 daily/every 任务排的到期点；唤醒时与之比对区分 schedule/catchup */
  private armedFor = new Map<string, Date>();
  private inflight = new Map<string, Inflight>();
  private quota: QuotaSnapshot | null = null;
  /** key 目录的最近一次读取：窗口任务的账号→窗口映射（同步路径）要用 */
  private keyDirMap: Map<string, KeyDirectoryEntry> | null = null;
  /** 发送改变额度状态，或上次刷新失败 → 下一轮先刷新快照再判断 */
  private quotaStale = false;
  private quotaTried = false;
  /** 最近一次落盘失败的原始原因；成功保存后清除。snapshot().saveError 组合展示文案 */
  private saveError: string | null = null;
  /** 评估抛错的去重：taskId → 「小时|原因」，同一小时同一原因只记一条 */
  private lastErrKey = new Map<string, string>();

  constructor(deps: SchedulerDeps) {
    this.store = deps.store;
    this.base = deps.base;
    this.nowFn = deps.now ?? (() => new Date());
    this.setTimerFn =
      deps.setTimer ??
      ((fn, ms) => {
        const t = setTimeout(fn, ms);
        return () => clearTimeout(t);
      });
    this.sendFn = deps.sendFn ?? send;
    this.quotasFn = deps.quotasFn ?? fetchQuotas;
    this.modelsFn = deps.modelsFn ?? fetchModels;
    // 目录位置进程内不变，构造时推导一次；providers.json 损坏按「读不出」处理（null）
    const dirs = magpieDirs();
    this.keyDirFn = deps.keyDirFn ?? (() => readKeyDirectory(dirs.config).catch(() => null));
    this.modelCacheFn = deps.modelCacheFn ?? ((pid) => readModelCache(dirs.cache, pid));
  }

  /** 启动：把遗留的 running 记录改判 unknown，再排定时器。可重复调用 */
  start(): void {
    this.started = true;
    const now = this.nowFn();
    let dirty = false;
    for (const r of this.store.data.runs) {
      if (r.outcome === "running") {
        r.outcome = "unknown";
        r.reason = INTERRUPTED_REASON;
        r.endedAt = now.toISOString();
        dirty = true;
      }
    }
    if (dirty) void this.trackSave();
    this.rearm();
  }

  /** 停止排程（进行中的发送照常收尾记录） */
  stop(): void {
    this.started = false;
    if (this.cancelTimer) {
      this.cancelTimer();
      this.cancelTimer = null;
    }
    this.armedFor = new Map();
  }

  /** 新建或全量更新任务；进行中的发送遇 enabled→false 会被中止并改判 unknown */
  upsert(input: TaskInput): Promise<Task> {
    return this.queueOp(async () => {
      const now = this.nowFn();
      if (input.id) {
        const idx = this.store.data.tasks.findIndex((t) => t.id === input.id);
        if (idx < 0) throw new Error(NOT_FOUND_MESSAGE);
        const prev = this.store.data.tasks[idx];
        // 白名单挑字段，档位等运行时字段永远进不了任务文件
        const next: Task = {
          id: prev.id,
          name: input.name,
          enabled: input.enabled,
          provider: input.provider,
          account: input.account,
          model: input.model,
          message: input.message,
          trigger: input.trigger,
          createdAt: prev.createdAt,
          updatedAt: now.toISOString(),
        };
        this.store.data.tasks[idx] = next;
        const flight = this.inflight.get(next.id);
        if (prev.enabled && !next.enabled && flight && !flight.cancel) {
          flight.cancel = "disabled";
          flight.abort.abort();
          await flight.done;
        }
        await this.store.save();
        this.rearm();
        return next;
      }
      const task: Task = {
        id: randomUUID(),
        name: input.name,
        enabled: input.enabled,
        provider: input.provider,
        account: input.account,
        model: input.model,
        message: input.message,
        trigger: input.trigger,
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      };
      this.store.data.tasks.push(task);
      this.store.data.marks[task.id] = { lastDue: null, resetKeys: [] };
      await this.store.save();
      this.rearm();
      return task;
    });
  }

  /** 删除任务、执行记录与 marks；进行中的发送先中止并等收尾 */
  async remove(id: string): Promise<void> {
    await this.queueOp(async () => {
      const exists = this.store.data.tasks.some((t) => t.id === id);
      const flight = this.inflight.get(id);
      if (!exists && !flight) throw new Error(NOT_FOUND_MESSAGE);
      if (flight) {
        flight.cancel = "deleted";
        flight.abort.abort();
        await flight.done;
      }
      this.store.data.tasks = this.store.data.tasks.filter((t) => t.id !== id);
      this.store.data.runs = this.store.data.runs.filter((r) => r.taskId !== id);
      delete this.store.data.marks[id];
      this.lastErrKey.delete(id);
      await this.store.save();
      this.rearm();
    });
  }

  /** 立即发送一次（source=manual），不动计划与 resetKey；正在发送时视为冲突抛错 */
  runNow(id: string): Promise<Run> {
    return this.queueOp(async () => {
      const task = this.store.data.tasks.find((t) => t.id === id);
      if (!task) throw new Error(NOT_FOUND_MESSAGE);
      if (this.inflight.has(id)) throw new Error(CONFLICT_MESSAGE);
      return this.fire(task, null, "manual", null);
    });
  }

  /** 页面状态总览（同步读，不发请求）；window 任务的 next 依赖已缓存的额度快照 */
  snapshot(): StateView {
    const now = this.nowFn();
    const next: Record<string, string | null> = {};
    const timeline: TimelinePoint[] = [];
    for (const task of this.store.data.tasks) {
      if (!task.enabled) {
        next[task.id] = null;
        continue;
      }
      // 与 tick/rearm 同策略：单个坏任务（如时区库变更后 state.json 里的旧时区失效）
      // 不能拖垮整页状态——否则 GET /api/state 500，用户连删除它的入口都没有。
      // 它的下次执行点置空、不进时间轴，失败本身由 tick 的评估记录
      const points: TimelinePoint[] = [];
      try {
        this.snapshotTask(task, now, next, points);
      } catch {
        next[task.id] = null;
        continue;
      }
      timeline.push(...points);
    }
    timeline.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
    return {
      tasks: [...this.store.data.tasks],
      runs: [...this.store.data.runs],
      next,
      timeline,
      saveError: this.saveError === null ? null : `状态文件写不进去：${this.saveError}`,
    };
  }

  /** 单任务的下次执行点与 24 小时时间轴点；时区/规则抛错时由调用方兜成「无计划」 */
  private snapshotTask(
    task: Task,
    now: Date,
    next: Record<string, string | null>,
    points: TimelinePoint[],
  ): void {
    if (task.trigger.kind === "window") {
      const info = this.windowInfo(task);
      let at: Date | null = null;
      if (info && !("error" in info)) {
        const tried = this.marksOf(task.id).resetKeys.includes(info.resetKey);
        if (info.at.getTime() > now.getTime()) {
          at = tried ? null : info.at;
        } else if (!tried) {
          at = new Date(now.getTime() + QUOTA_REFRESH_MS); // 空闲窗口：下次检查时刻
        }
      }
      next[task.id] = at ? at.toISOString() : null;
      if (at && at.getTime() > now.getTime() && at.getTime() <= now.getTime() + DAY_MS) {
        points.push({ taskId: task.id, at: at.toISOString() });
      }
    } else {
      const marks = this.store.data.marks[task.id];
      const lastMark = marks?.lastDue ? new Date(marks.lastDue) : null;
      const recent = lastDue(task.trigger, now);
      // && 直写会把布尔 false 混进类型，这里显式收敛成 Date | null
      const pendingCatchup =
        recent !== null &&
        (!lastMark || recent.getTime() > lastMark.getTime()) &&
        recent.getTime() > new Date(task.updatedAt).getTime()
          ? recent
          : null;
      const base = pendingCatchup ?? now;
      const at =
        task.trigger.kind === "daily" ? nextDaily(task.trigger, base) : nextEvery(task.trigger, base);
      next[task.id] = at.toISOString();
      for (const p of upcoming(task.trigger, now, 25)) {
        if (p.getTime() > now.getTime() + DAY_MS) break;
        points.push({ taskId: task.id, at: p.toISOString() });
      }
    }
  }

  /** 等待排队中的操作与发送收尾全部落盘（测试与优雅退出用） */
  async flush(): Promise<void> {
    for (let i = 0; i < 100; i++) {
      const bg = [...this.background];
      if (bg.length > 0) {
        // 有的发送（假件或极端网络）可能永不返回：等不动就先走
        await Promise.race([Promise.allSettled(bg), new Promise((r) => setTimeout(r, 0))]);
      }
      await this.chain.catch(() => {});
      await this.lastWrite;
      await new Promise((r) => setTimeout(r, 0));
      if (this.background.length === 0) {
        await this.chain.catch(() => {});
        await this.lastWrite;
        return;
      }
    }
  }

  private queueOp<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.then(
      () => {},
      () => {},
    );
    return run;
  }

  private track(p: Promise<unknown>): void {
    const wrapped = p.catch(() => {}).finally(() => {
      this.background = this.background.filter((x) => x !== wrapped);
    });
    this.background.push(wrapped);
  }

  /**
   * 落盘并如实上报本次成败（false = 失败）：调度内部不能吞掉保存错误——
   * 「发送前持久化成功」是发请求的前提，错误同时记入 saveError 供 snapshot 暴露。
   */
  private trackSave(): Promise<boolean> {
    const p = this.store.save().then(
      () => {
        this.saveError = null;
        return true;
      },
      (e) => {
        this.saveError = errText(e);
        return false;
      },
    );
    this.lastWrite = p.then(() => {});
    return p;
  }

  private marksOf(id: string): { lastDue: string | null; resetKeys: string[] } {
    let m = this.store.data.marks[id];
    if (!m) {
      m = { lastDue: null, resetKeys: [] };
      this.store.data.marks[id] = m;
    }
    return m;
  }

  private async tick(): Promise<void> {
    if (!this.started) return;
    const now = this.nowFn();
    const tasks = this.store.data.tasks;
    const hasWindow = tasks.some((t) => t.enabled && t.trigger.kind === "window");
    // 没有快照寸步难行：窗口任务存在但一条额度都没拿到过时先取一次
    if (hasWindow && !this.quota) await this.refreshQuotas();
    for (const task of [...tasks]) {
      if (!task.enabled) continue;
      try {
        if (task.trigger.kind === "window") await this.evaluateWindow(task, now);
        else await this.evaluateFixed(task, now);
      } catch (e) {
        // 单个任务评估出错不拖垮其他任务；同一小时同一原因只记一条，别每个 tick 刷屏
        const reason = `调度出错：${errText(e)}`;
        const key = `${hourFloorISO(now)}|${reason}`;
        if (this.lastErrKey.get(task.id) !== key) {
          this.lastErrKey.set(task.id, key);
          this.appendFailure(task, now, null, reason, null, "schedule");
        }
      }
    }
    if (hasWindow) await this.refreshQuotas(); // 到期后/每 10 分钟刷新，供下轮判断
    this.rearm();
  }

  /** 评估 daily/every 任务：最近应到点若晚于上次执行且晚于 updatedAt，就发一次 */
  private async evaluateFixed(task: Task, now: Date): Promise<void> {
    const marks = this.marksOf(task.id);
    const lastMark = marks.lastDue ? new Date(marks.lastDue) : null;
    const recent = lastDue(task.trigger, now);
    if (!recent) return;
    const pending =
      (!lastMark || recent.getTime() > lastMark.getTime()) &&
      recent.getTime() > new Date(task.updatedAt).getTime();
    if (!pending) return;
    const armed = this.armedFor.get(task.id) ?? null;
    const source: Run["source"] =
      armed !== null && armed.getTime() === recent.getTime() ? "schedule" : "catchup";
    await this.fire(task, recent, source, null);
  }

  private async evaluateWindow(task: Task, now: Date): Promise<void> {
    const marks = this.marksOf(task.id);
    const info = this.windowInfo(task);
    if (!info) return; // 没有快照（刷新一直失败）→ 等下轮
    if ("error" in info) {
      // 找不到账号/窗口：失败记一次，同一小时内不重复（key 按快照小时取整）
      const key = `missing:${hourFloorISO(info.at)}`;
      if (marks.resetKeys.includes(key)) return;
      marks.resetKeys.push(key);
      this.appendFailure(task, this.nowFn(), null, info.error, key, "schedule");
      return;
    }
    if (info.at.getTime() > now.getTime()) return; // 还没到 resetsAt+30s
    if (marks.resetKeys.includes(info.resetKey)) return; // 同一 resetKey 最多尝试一次
    marks.resetKeys.push(info.resetKey);
    // 同一实际重置只花一次额度：把本次到期所在小时的 idle key 一并消费，
    // 免得缓存随后丢掉 resetsAt 时，同一小时里又被当成新的空闲事件发一次
    const companion = `idle:${hourFloorISO(info.at)}`;
    if (companion !== info.resetKey) marks.resetKeys.push(companion);
    this.quotaStale = true; // 发送改变额度状态，下一轮先刷新快照再判断
    await this.fire(task, info.at, "schedule", info.resetKey);
  }

  /** 用当前快照判断窗口任务的到期点；null 表示拿不到（无快照） */
  private windowInfo(task: Task): WindowInfo | null {
    if (task.trigger.kind !== "window") return null;
    const snap = this.quota;
    if (!snap) return null;
    if (!task.account) return { at: snap.at, error: "窗口任务没有指定账号" };
    // 账号 → 窗口走统一账号列表：key 账号用指纹反查 key 名再匹配 ~keys 卡（accounts.ts 共用实现）
    const windows = windowsForAccount(task.provider, task.account, snap.entries, this.keyDirMap);
    if (windows === null) return { at: snap.at, error: `额度里没有账号 ${task.account}` };
    // 回调里拿不到外层的 kind 收窄（trigger 可变），先提成常量
    const windowName = task.trigger.kind === "window" ? task.trigger.window : "";
    const win = windows.find((w) => w.name === windowName);
    const due = windowDue(win, snap.at);
    if ("error" in due) return { at: snap.at, error: due.error };
    // windowDue 对「resetsAt 已过」也回 idle:小时取整——同一份旧重置每小时会换个新 key，
    // 会被误当成新的空闲事件反复发送。只要窗口带着可解析的 resetsAt，key 就用 resetsAt 本身：
    // 与重置发送同 key，消费过就绝不再发（刷新/跨小时/重启都一样），出现新 resetsAt 才是新事件；
    // truthy 但解析不了的 resetsAt 当缺失处理，保留按小时限频。
    const raw = win?.resetsAt;
    if (raw && !Number.isNaN(new Date(raw).getTime()) && due.resetKey.startsWith("idle:")) {
      return { at: due.at, resetKey: raw };
    }
    return due;
  }

  private async refreshQuotas(): Promise<void> {
    const now = this.nowFn();
    const quotaFresh =
      this.quota !== null &&
      !this.quotaStale &&
      now.getTime() - this.quota.at.getTime() < QUOTA_REFRESH_MS;
    // 快照还新鲜但 key 目录没读到（上轮失败）：也要再补读，指纹账号的窗口映射等着它
    if (quotaFresh && this.keyDirMap !== null) return;
    this.quotaTried = true;
    // key 目录与额度快照一起等完再返回：windowInfo 是同步路径，只等额度的话，
    // key 目录（真实文件 I/O）后到会让指纹账号在首轮误报「额度里没有账号」。
    // key 目录读失败保留旧值（可能仍是 null），不拿失败结果盖掉上一次的好数据
    const [keyDir, snap] = await Promise.all([
      this.keyDirFn().then(
        (m) => m,
        () => this.keyDirMap,
      ),
      quotaFresh
        ? Promise.resolve(this.quota)
        : this.quotasFn(this.base).catch(() => null),
    ]);
    this.keyDirMap = keyDir;
    if (snap) {
      this.quota = snap;
      this.quotaStale = false;
    } else if (!quotaFresh) {
      // 刷新失败保留旧快照，下个周期再试；额度读不到不值得记一条失败记录
      this.quotaStale = true;
    }
  }

  /** 发送一次：先落盘 running 与 lastDue，再解析档位、调用 sendFn；收尾游离，返回 running 记录 */
  private async fire(
    task: Task,
    due: Date | null,
    source: Run["source"],
    resetKey: string | null,
  ): Promise<Run> {
    const now = this.nowFn();
    if (this.inflight.has(task.id)) {
      // 同一任务不重叠：本次到期点作废，但仍算已消费，避免反复记「跳过」
      if (due && task.trigger.kind !== "window") this.marksOf(task.id).lastDue = due.toISOString();
      return this.appendFailure(task, now, due, OVERLAP_REASON, resetKey, source);
    }
    if (due && task.trigger.kind !== "window") this.marksOf(task.id).lastDue = due.toISOString();
    const run: Run = {
      id: randomUUID(),
      taskId: task.id,
      source,
      due: due?.toISOString() ?? null,
      startedAt: now.toISOString(),
      endedAt: null,
      outcome: "running",
      reason: "",
      effort: null,
      model: null,
      ms: null,
      resetKey,
    };
    this.store.data.runs.push(run);
    const abort = new AbortController();
    const entry: Inflight = { abort, cancel: null, done: Promise.resolve() };
    this.inflight.set(task.id, entry);
    const savedRunning = this.trackSave(); // 本次落盘的成败决定能不能发（见 sendAndFinalize）
    entry.done = this.sendAndFinalize(task, run, entry, savedRunning);
    this.track(entry.done);
    await savedRunning;
    return run;
  }

  /**
   * 发送前解析当次的账号头与模型（每次发送现取 /v1/models、key 目录与该供应商的模型缓存，
   * 配置变了下一次发送自动跟随）。固定模型只校验仍在 /v1/models，不校验账号权限（交给服务器）；
   * 自动模型按统一账号规则取该账号（或「自动选账号」）的可选模型列表现选。
   */
  private async resolveSend(
    task: Task,
    models: RawModel[],
  ): Promise<{ id: string; model: RawModel; pin: string | null } | { error: string }> {
    const [keyDir, cache] = await Promise.all([
      this.keyDirFn().catch(() => null),
      this.modelCacheFn(task.provider).catch(() => null),
    ]);
    const pin = pinFor(task.provider, task.account, keyDir, this.quota?.entries ?? []);
    if (task.model) {
      const model = models.find((m) => m.id === task.model);
      return model
        ? { id: task.model, model, pin }
        : { error: `模型 ${task.model} 已不在 Magpie 的模型列表里` };
    }
    const ids = models.filter((m) => modelProvider(m) === task.provider).map((m) => m.id);
    const list = modelsForAccount(task.provider, task.account, { models: ids, keyDir, cache }).list;
    if (list === null) {
      return { error: `供应商 ${task.provider} 还没有模型列表，无法自动选模型` };
    }
    if (list.length === 0) return { error: `账号 ${task.account || "自动"} 没有可用模型` };
    const chosen = pickAutoModel(list.map((id) => ({ id })));
    if (!chosen) return { error: `账号 ${task.account || "自动"} 没有可用模型` };
    const model = models.find((m) => m.id === chosen.id);
    // list 由第 3 层过滤过，一定还在 /v1/models 里；兜底防夹具不一致
    if (!model) return { error: `模型 ${chosen.id} 已不在 Magpie 的模型列表里` };
    return { id: chosen.id, model, pin };
  }

  private async sendAndFinalize(
    task: Task,
    run: Run,
    entry: Inflight,
    savedRunning: Promise<boolean>,
  ): Promise<void> {
    try {
      // 持久化是发送的前提：running 记录与已消费的 marks 没落盘就不发请求——
      // 否则进程一旦退出，磁盘上的到期点还没消费，重启会对同一点再发一次
      const persisted = await savedRunning;
      let effort: string | null = null;
      let result: SendResult;
      if (!persisted) {
        result = {
          outcome: "failed",
          reason: `状态文件写不进去，本次不发送：${this.saveError ?? "未知原因"}`,
          ms: 0,
        };
      } else {
        try {
          const models = await this.modelsFn(this.base, entry.abort.signal);
          const resolved = await this.resolveSend(task, models);
          if ("error" in resolved) {
            result = { outcome: "failed", reason: resolved.error, ms: 0 };
          } else {
            const pick = pickEffort(resolved.model);
            if ("error" in pick) {
              result = { outcome: "failed", reason: pick.error, ms: 0 };
            } else {
              effort = pick.send;
              run.model = resolved.id;
              result = await this.sendFn(
                this.base,
                { id: task.id, model: resolved.id },
                resolved.pin,
                effort,
                entry.abort.signal,
              );
            }
          }
        } catch (e) {
          result = { outcome: "failed", reason: errText(e), ms: 0 };
        }
      }
      run.effort = effort;

      if (entry.cancel === "disabled") {
        run.outcome = "unknown";
        run.reason = DISABLED_REASON;
      } else if (entry.cancel === "deleted") {
        run.outcome = "unknown";
        run.reason = DELETED_REASON; // remove 随后会清掉它，进程若在这里崩掉也能对上账
      } else {
        run.outcome = result.outcome;
        run.reason = result.reason;
      }
      run.ms = result.ms;
      run.endedAt = this.nowFn().toISOString();
      // 收尾与删除竞态的最后一道闸：任务已不在就什么都不写
      if (!this.store.data.tasks.some((t) => t.id === task.id)) return;
      await this.trackSave();
    } finally {
      this.inflight.delete(task.id);
    }
  }

  private appendFailure(
    task: Task,
    at: Date,
    due: Date | null,
    reason: string,
    resetKey: string | null,
    source: Run["source"],
  ): Run {
    const run: Run = {
      id: randomUUID(),
      taskId: task.id,
      source,
      due: due?.toISOString() ?? null,
      startedAt: at.toISOString(),
      endedAt: at.toISOString(),
      outcome: "failed",
      reason,
      effort: null,
      model: null,
      ms: 0,
      resetKey,
    };
    this.store.data.runs.push(run);
    this.trackSave();
    return run;
  }

  /** 重排唯一定时器：延迟 = min(各任务最近到期 − now, 10 分钟)；窗口任务没算得出到期点时按刷新节奏回头 */
  private rearm(): void {
    if (this.cancelTimer) {
      this.cancelTimer();
      this.cancelTimer = null;
    }
    this.armedFor = new Map();
    if (!this.started) return;
    const now = this.nowFn();
    let minDelay = Infinity;
    for (const task of this.store.data.tasks) {
      if (!task.enabled) continue;
      if (task.trigger.kind === "window") {
        const info = this.windowInfo(task);
        if (info && !("error" in info) && info.at.getTime() > now.getTime()) {
          minDelay = Math.min(minDelay, info.at.getTime() - now.getTime());
        } else {
          // 没有可用的未来到期点：按刷新节奏回头再看（从未取到过快照时尽快取一次）
          minDelay = Math.min(minDelay, this.quotaTried ? QUOTA_REFRESH_MS : 0);
        }
      } else {
        const marks = this.store.data.marks[task.id];
        const lastMark = marks?.lastDue ? new Date(marks.lastDue) : null;
        const updated = new Date(task.updatedAt);
        // 已执行点之后、编辑点之后的第一个到期点才有效，否则会围着作废点空转
        const base = lastMark && lastMark.getTime() > updated.getTime() ? lastMark : updated;
        let due: Date;
        try {
          due =
            task.trigger.kind === "daily" ? nextDaily(task.trigger, base) : nextEvery(task.trigger, base);
        } catch {
          // 单个坏任务（如时区库变更）不能打断重排——整个定时器排不出来等于调度停摆；
          // 它的失败已由 tick 的评估记录，这里跳过即可
          continue;
        }
        if (due.getTime() > now.getTime()) {
          this.armedFor.set(task.id, due);
          minDelay = Math.min(minDelay, due.getTime() - now.getTime());
        } else {
          // 已过期的应到点（服务中断/睡眠）：立即唤醒去补发评估
          minDelay = Math.min(minDelay, 0);
        }
      }
    }
    if (Number.isFinite(minDelay)) {
      const delay = Math.min(Math.max(minDelay, 0), TIMER_CAP_MS);
      this.cancelTimer = this.setTimerFn(() => {
        void this.queueOp(() => this.tick()).catch(() => {});
      }, delay);
    }
  }
}
