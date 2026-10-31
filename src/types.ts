// 窗口预热插件的共享数据类型。运行时结构见 src/rules.ts 与后续任务的调度/服务模块。

export type Trigger =
  | { kind: "window"; window: string } // 额度窗口名，如 "5h"
  | { kind: "daily"; time: string; timeZone: string } // "HH:MM" + IANA 时区
  | { kind: "every"; hours: number; anchor: string }; // 1–168 小时，anchor 为 ISO 起点

export interface Task {
  id: string;
  name: string;
  enabled: boolean;
  provider: string;
  /** "" 表示由供应商自动选账号；窗口触发不允许（同一 resetKey 只试一次，必须锁定账号） */
  account: string;
  /** "" 表示自动选模型：每次发送前按 pickAutoModel 现算，任务里不存选中值 */
  model: string;
  /** 1–200 字，缺省 "hi" */
  message: string;
  trigger: Trigger;
  createdAt: string;
  updatedAt: string;
}

export type Outcome = "ok" | "failed" | "unknown";

export interface Run {
  id: string;
  taskId: string;
  source: "schedule" | "catchup" | "manual";
  due: string | null;
  startedAt: string;
  endedAt: string | null;
  /** "running" 只存在于发送中途的落盘记录 */
  outcome: Outcome | "running";
  /** 失败/未知时必须是人能看懂的中文原因 */
  reason: string;
  /** 当次实际使用的思考档位；模型不思考或不适用时为 null */
  effort: string | null;
  /** 当次实际使用的模型 id；固定模型即任务所配，自动选择即当次选中，解析不出来为 null */
  model: string | null;
  ms: number | null;
  resetKey: string | null;
}

export type EffortPick = { send: string | null; label: string } | { error: string };

/** send() 的结果；失败/未知时 reason 必须是人能看懂的中文 */
export interface SendResult {
  outcome: Outcome;
  reason: string;
  ms: number;
}

export interface QuotaWindow {
  name: string;
  used: number | null;
  resetsAt: string | null;
}

export interface QuotaEntry {
  provider: string;
  account: string;
  label: string;
  windows: QuotaWindow[];
}

/** /v1/models 的单条原始对象；档位字段形状随模型而变，使用前需运行时校验 */
export interface RawModel {
  id: string;
  owned_by?: string;
  reasoning?: boolean | string | null;
  reasoning_levels?: string[];
  supported_reasoning_levels?: { effort: string }[];
}

export interface CatalogAccount {
  id: string;
  label: string;
  windows: QuotaWindow[];
}

export interface CatalogModel {
  id: string;
  effort: EffortPick;
}

export interface CatalogProvider {
  id: string;
  accounts: CatalogAccount[];
  models: CatalogModel[];
  /** 服务端用与调度器同一套规则算好的自动选模型；供应商没有模型时为 null */
  autoModel: string | null;
}

/** GET /api/catalog 的响应体 */
export interface Catalog {
  providers: CatalogProvider[];
}
