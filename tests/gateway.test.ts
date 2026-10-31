import { afterEach, describe, expect, test } from "bun:test";
import {
  createQuotaReader,
  fetchCatalog,
  fetchQuotas,
  gatewayBase,
  modelProvider,
  pickAutoModel,
  pickEffort,
  send,
} from "../src/gateway";
import type { EffortPick, RawModel, Task } from "../src/types";
import { fakeGateway, type FakeGateway, type FakeGatewayOpts } from "./fake-gateway";

const started: FakeGateway[] = [];
function start(opts: FakeGatewayOpts = {}): FakeGateway {
  const gw = fakeGateway(opts);
  started.push(gw);
  return gw;
}
afterEach(() => {
  for (const gw of started.splice(0)) gw.stop();
});

function mkTask(over: Partial<Task> = {}): Task {
  return {
    id: "t1",
    name: "早报",
    enabled: true,
    provider: "openai",
    account: "",
    model: "openai/gpt-5",
    message: "hi",
    trigger: { kind: "daily", time: "06:00", timeZone: "Asia/Shanghai" },
    createdAt: "",
    updatedAt: "",
    ...over,
  };
}

const chatReqs = (gw: FakeGateway) => gw.requests.filter((r) => r.path === "/v1/chat/completions");
const bodyOf = (r: FakeGateway["requests"][number]) => r.body as Record<string, unknown>;

function okPick(pick: EffortPick): { send: string | null; label: string } {
  if ("error" in pick) throw new Error(`意外的 error 结果：${pick.error}`);
  return pick;
}

const FUTURE = new Date(Date.now() + 2 * 3_600_000).toISOString();

describe("gatewayBase", () => {
  test("MAGPIE_ADDR host:port → 拼 http://", () => {
    expect(gatewayBase({ MAGPIE_ADDR: "127.0.0.1:9" })).toBe("http://127.0.0.1:9");
  });

  test("缺省 127.0.0.1:3425", () => {
    expect(gatewayBase({})).toBe("http://127.0.0.1:3425");
  });

  test("已是完整地址 → 原样保留并去掉尾部斜杠", () => {
    expect(gatewayBase({ MAGPIE_ADDR: "http://127.0.0.1:9/" })).toBe("http://127.0.0.1:9");
  });
});

describe("pickEffort", () => {
  const m = (over: Partial<RawModel>): RawModel => ({ id: "m", ...over });

  test("档位列表为空 → 不适用", () => {
    expect(pickEffort(m({ reasoning: true, reasoning_levels: [] }))).toEqual({
      send: null,
      label: "不适用",
    });
  });

  test("reasoning 为假 → 不适用（即使列表里有 none）", () => {
    expect(pickEffort(m({ reasoning: false, reasoning_levels: ["none", "high"] }))).toEqual({
      send: null,
      label: "不适用",
    });
  });

  test("reasoning 缺失 → 视为不思考，不适用", () => {
    expect(pickEffort(m({ reasoning_levels: ["low", "high"] }))).toEqual({
      send: null,
      label: "不适用",
    });
  });

  test("disabled 归一为 none → 关闭", () => {
    expect(pickEffort(m({ reasoning: true, reasoning_levels: ["disabled", "high"] }))).toEqual({
      send: "none",
      label: "关闭（模型支持关闭）",
    });
  });

  test("off 同样归一为 none", () => {
    expect(okPick(pickEffort(m({ reasoning: true, reasoning_levels: ["off", "high"] }))).send).toBe(
      "none",
    );
  });

  test("minimal < low", () => {
    expect(okPick(pickEffort(m({ reasoning: true, reasoning_levels: ["minimal", "low"] }))).send).toBe(
      "minimal",
    );
  });

  test("乱序 → low", () => {
    expect(okPick(pickEffort(m({ reasoning: true, reasoning_levels: ["high", "low"] }))).send).toBe(
      "low",
    );
  });

  test("low/high → low，标签注明已用最低档", () => {
    expect(pickEffort(m({ reasoning: true, reasoning_levels: ["low", "high"] }))).toEqual({
      send: "low",
      label: "low（模型必须思考，已用最低档）",
    });
  });

  test("纯数字档低于命名档 → 2048", () => {
    expect(okPick(pickEffort(m({ reasoning: true, reasoning_levels: ["2048", "low"] }))).send).toBe(
      "2048",
    );
  });

  test("数字档按数值取最小", () => {
    expect(
      okPick(pickEffort(m({ reasoning: true, reasoning_levels: ["8192", "2048", "low"] }))).send,
    ).toBe("2048");
  });

  test("已知名低于未知名 → high", () => {
    expect(okPick(pickEffort(m({ reasoning: true, reasoning_levels: ["high", "turbo"] }))).send).toBe(
      "high",
    );
  });

  test("只有未知名 → 列表第一档，标签注明", () => {
    const pick = pickEffort(m({ reasoning: true, reasoning_levels: ["turbo", "fast"] }));
    expect("error" in pick).toBe(false);
    if (!("error" in pick)) {
      expect(pick.send).toBe("turbo");
      expect(pick.label.includes("按模型列表第一档")).toBe(true);
    }
  });

  test("supported_reasoning_levels[].effort 同样识别", () => {
    const pick = pickEffort(m({ reasoning: true, supported_reasoning_levels: [{ effort: "medium" }] }));
    expect(okPick(pick).send).toBe("medium");
  });

  test("档位字段损坏（提不出任何档位）→ error", () => {
    const levels = [42] as unknown as string[];
    expect("error" in pickEffort(m({ reasoning: true, reasoning_levels: levels }))).toBe(true);
  });

  test("档位字段存在但不是数组 → error（宁可报错也不误判成模型不思考）", () => {
    const levels = "low,high" as unknown as string[];
    expect("error" in pickEffort(m({ reasoning: true, reasoning_levels: levels }))).toBe(true);
    const supported = "low" as unknown as { effort: string }[];
    expect("error" in pickEffort(m({ reasoning: true, supported_reasoning_levels: supported }))).toBe(
      true,
    );
  });
});

describe("send", () => {
  test("请求体与会话头：max_tokens 16、stream false、无 reasoning_effort、无账号头", async () => {
    const gw = start();
    const r = await send(gw.base, mkTask(), null, new AbortController().signal);
    expect(r.outcome).toBe("ok");
    expect(r.reason).toBe("");
    expect(typeof r.ms).toBe("number");
    const [req] = chatReqs(gw);
    expect(req.method).toBe("POST");
    expect(bodyOf(req)).toEqual({
      model: "openai/gpt-5",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 16,
      stream: false,
    });
    expect(req.headers["x-magpie-session"]).toBe("window-warmup/t1");
    expect(req.headers["x-magpie-account"]).toBeUndefined();
  });

  test("带 effort 与固定账号 → reasoning_effort 与 X-Magpie-Account", async () => {
    const gw = start();
    await send(gw.base, mkTask({ account: "acc-1" }), "low", new AbortController().signal);
    const [req] = chatReqs(gw);
    expect(bodyOf(req).reasoning_effort).toBe("low");
    expect(req.headers["x-magpie-account"]).toBe("acc-1");
  });

  test("429 + 上游 message → failed，原因含状态码与原文", async () => {
    const gw = start({ chat: { status: 429, body: { error: { message: "余额不足" } } } });
    const r = await send(gw.base, mkTask(), null, new AbortController().signal);
    expect(r.outcome).toBe("failed");
    expect(r.reason.includes("429")).toBe(true);
    expect(r.reason.includes("余额不足")).toBe(true);
  });

  test("固定账号 403 → 只请求一次，不改用其他账号", async () => {
    const gw = start({ chat: { status: 403, body: { error: { message: "该账号无权使用此模型" } } } });
    const r = await send(gw.base, mkTask({ account: "acc-1" }), null, new AbortController().signal);
    expect(r.outcome).toBe("failed");
    expect(chatReqs(gw)).toHaveLength(1);
  });

  test("网关不可达 → failed 连不上 Magpie", async () => {
    const gw = start();
    const base = gw.base;
    gw.stop();
    const r = await send(base, mkTask(), null, new AbortController().signal);
    expect(r.outcome).toBe("failed");
    expect(r.reason.startsWith("连不上 Magpie")).toBe(true);
  });

  test("超过注入的超时 → unknown，原因按实际超时时长生成（不硬写 30 秒）", async () => {
    const gw = start({ chat: { delayMs: 500 } });
    const r = await send(gw.base, mkTask(), null, new AbortController().signal, 50);
    expect(r.outcome).toBe("unknown");
    expect(r.reason).toBe("50 毫秒内没有结果，可能已发送");

    const gw2 = start({ chat: { delayMs: 2500 } });
    const r2 = await send(gw2.base, mkTask(), null, new AbortController().signal, 2000);
    expect(r2.outcome).toBe("unknown");
    expect(r2.reason).toBe("2 秒内没有结果，可能已发送");
  });

  test("HTTP 200 但响应体不完整 → unknown（不能判 ok）", async () => {
    const gw = start({ chat: { breakBody: "truncate" } });
    const r = await send(gw.base, mkTask(), null, new AbortController().signal);
    expect(r.outcome).toBe("unknown");
    expect(r.reason).toContain("响应");
  });

  test("响应中途连接重置 → unknown（可能已发送，不是连不上）", async () => {
    const gw = start({ chat: { breakBody: "reset" } });
    const r = await send(gw.base, mkTask(), null, new AbortController().signal);
    expect(r.outcome).toBe("unknown");
    expect(r.reason).toContain("可能已发送");
  });

  test("外部 signal 中止 → unknown 发送被取消", async () => {
    const gw = start({ chat: { delayMs: 500 } });
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 30);
    const r = await send(gw.base, mkTask(), null, ac.signal, 10_000);
    expect(r.outcome).toBe("unknown");
    expect(r.reason).toBe("发送被取消");
  });
});

describe("fetchCatalog", () => {
  test("归供应商、排除 group/、带上账号与窗口", async () => {
    const gw = start({
      models: [
        { id: "openai/gpt-5", owned_by: "openai", reasoning: true, reasoning_levels: ["low", "high"] },
        {
          id: "openai/gpt-5-mini",
          owned_by: "openai",
          reasoning: true,
          reasoning_levels: ["disabled", "high"],
        },
        {
          id: "vertex/gemini-3-pro",
          owned_by: "google",
          reasoning: true,
          reasoning_levels: ["minimal", "low", "medium"],
        },
        { id: "group/auto", owned_by: "openai", reasoning: false },
      ],
      quotas: [
        {
          provider: "openai",
          user: "acct-1",
          name: "Yang",
          kind: "subscription",
          windows: [{ name: "5h", used: 2, resetsAt: FUTURE }],
        },
        { provider: "moonshot", user: "acct-9", name: "", windows: [] },
      ],
    });
    const catalog = await fetchCatalog(gw.base);
    expect(catalog.providers.map((p) => p.id)).toEqual(["google", "moonshot", "openai"]);

    const openai = catalog.providers.find((p) => p.id === "openai");
    if (!openai) throw new Error("缺 openai 供应商");
    expect(openai.models.map((x) => x.id)).toEqual(["openai/gpt-5", "openai/gpt-5-mini"]);
    expect(okPick(openai.models[0].effort).send).toBe("low");
    expect(okPick(openai.models[1].effort).send).toBe("none");
    expect(openai.accounts).toEqual([
      { id: "acct-1", label: "Yang", windows: [{ name: "5h", used: 2, resetsAt: FUTURE }] },
    ]);

    const google = catalog.providers.find((p) => p.id === "google");
    if (!google) throw new Error("缺 google 供应商");
    // 供应商归属优先看 owned_by（真正接住请求的一方），id 前缀只做回退
    expect(google.models.map((x) => x.id)).toEqual(["vertex/gemini-3-pro"]);

    const moonshot = catalog.providers.find((p) => p.id === "moonshot");
    if (!moonshot) throw new Error("缺 moonshot 供应商");
    expect(moonshot.models).toEqual([]);
    expect(moonshot.accounts[0].label).toBe("acct-9");
  });

  test("quotas 挂了 → 目录仍可用（账号为空）", async () => {
    const gw = start({
      models: [{ id: "openai/gpt-5", owned_by: "openai", reasoning: false }],
      quotasStatus: 500,
    });
    const catalog = await fetchCatalog(gw.base);
    expect(catalog.providers).toHaveLength(1);
    expect(catalog.providers[0].accounts).toEqual([]);
  });

  test("key 限额卡账号归到供应商名下，与模型同一供应商", async () => {
    const gw = start({
      models: [{ id: "office/gpt-5", owned_by: "office", reasoning: false }],
      quotas: [
        { provider: "office/~keys", user: "key-a", name: "Key A", windows: [] },
        { provider: "office/~keys", user: "key-b", name: "", windows: [] },
      ],
    });
    const catalog = await fetchCatalog(gw.base);
    expect(catalog.providers.map((p) => p.id)).toEqual(["office"]);
    const office = catalog.providers[0];
    expect(office.accounts.map((a) => a.id)).toEqual(["key-a", "key-b"]);
    expect(office.accounts[0].label).toBe("Key A");
    expect(office.accounts[1].label).toBe("key-b"); // 没有名字就用 key 名
  });

  test("每个供应商给出 autoModel（服务端同一套规则算好）", async () => {
    const gw = start({
      models: [
        { id: "openai/gpt-5.2", owned_by: "openai", reasoning: false },
        { id: "openai/gpt-5.2-mini", owned_by: "openai", reasoning: false },
        { id: "openai/gpt-5.2-turbo", owned_by: "openai", reasoning: false },
        { id: "moonshot/kimi", owned_by: "moonshot", reasoning: false },
      ],
      quotas: [{ provider: "moonshot", user: "acct-9", name: "", windows: [] }],
    });
    const catalog = await fetchCatalog(gw.base);
    const openai = catalog.providers.find((p) => p.id === "openai");
    const moonshot = catalog.providers.find((p) => p.id === "moonshot");
    if (!openai || !moonshot) throw new Error("缺供应商");
    expect(openai.autoModel).toBe("openai/gpt-5.2-mini");
    expect(moonshot.autoModel).toBe("moonshot/kimi");
  });

  test("网关不可达 → 抛「连不上 Magpie」", async () => {
    const gw = start();
    const base = gw.base;
    gw.stop();
    await expect(fetchCatalog(base)).rejects.toThrow("连不上 Magpie");
  });
});

describe("fetchQuotas", () => {
  test("返回快照时间与归一化条目", async () => {
    const gw = start({
      quotas: [
        {
          provider: "openai",
          user: "acct-1",
          name: "Yang",
          windows: [{ name: "5h", used: 2, resetsAt: FUTURE }],
        },
      ],
    });
    const snap = await fetchQuotas(gw.base);
    expect(snap.at).toBeInstanceOf(Date);
    expect(snap.entries).toEqual([
      {
        provider: "openai",
        account: "acct-1",
        label: "Yang",
        windows: [{ name: "5h", used: 2, resetsAt: FUTURE }],
      },
    ]);
  });

  test("远程 key 限额卡（<p>/~keys）归并到供应商 <p>，账号 id 用 key 名", async () => {
    const gw = start({
      quotas: [
        {
          provider: "office/~keys",
          user: "key-yang",
          name: "office @ yang",
          windows: [{ name: "5h", used: 1, resetsAt: FUTURE }],
        },
        { provider: "openai", user: "acct-1", name: "Yang", windows: [] },
      ],
    });
    const snap = await fetchQuotas(gw.base);
    expect(snap.entries).toEqual([
      {
        provider: "office",
        account: "key-yang",
        label: "office @ yang",
        windows: [{ name: "5h", used: 1, resetsAt: FUTURE }],
      },
      { provider: "openai", account: "acct-1", label: "Yang", windows: [] },
    ]);
  });
});

describe("pickAutoModel", () => {
  const m = (id: string): RawModel => ({ id, owned_by: "p", reasoning: false });

  test("规格词排序 flash < lite < mini < nano < small < turbo", () => {
    const picked = pickAutoModel([
      m("p/turbo"),
      m("p/small"),
      m("p/nano"),
      m("p/mini"),
      m("p/lite"),
      m("p/flash"),
    ]);
    expect(picked?.id).toBe("p/flash");
  });

  test("按单词匹配且不区分大小写：Mini 命中、minimax 不算 mini", () => {
    expect(pickAutoModel([m("p/gpt-5-Mini"), m("p/gpt-5")])?.id).toBe("p/gpt-5-Mini");
    // 两个都不含规格词 → 都排最后，比较落到数字感知降序
    expect(pickAutoModel([m("p/minimax"), m("p/gpt-6"), m("p/gpt-5")])?.id).toBe("p/gpt-6");
  });

  test("都不含规格词的排最后；同档按 id 数字感知降序（新版本优先）", () => {
    expect(pickAutoModel([m("p/gpt-5"), m("p/gpt-5.2"), m("p/gpt-4")])?.id).toBe("p/gpt-5.2");
    expect(pickAutoModel([m("p/model-9"), m("p/model-10")])?.id).toBe("p/model-10");
  });

  test("规格词只看 id 的最后一段", () => {
    expect(pickAutoModel([m("turbo/flash"), m("p/turbo")])?.id).toBe("turbo/flash");
    expect(pickAutoModel([m("flash/turbo"), m("p/flash-lite")])?.id).toBe("p/flash-lite");
  });

  test("空列表 → null", () => {
    expect(pickAutoModel([])).toBeNull();
  });
});

describe("modelProvider", () => {
  test("owned_by 优先（真正接住请求的一方），其次 id 首段，都没有则空", () => {
    expect(modelProvider({ id: "a/b", owned_by: "x" })).toBe("x");
    expect(modelProvider({ id: "a/b" })).toBe("a");
    expect(modelProvider({ id: "bare" })).toBe("");
  });
});

describe("额度兜底读取（kept 为空时读完整接口）", () => {
  const ENTRY = { provider: "openai", user: "acct-1", name: "A", windows: [] };
  function fakeClock(): { now: () => Date; tick: (ms: number) => void } {
    let t = 1_700_000_000_000;
    return { now: () => new Date(t), tick: (ms: number) => { t += ms; } };
  }
  const fulls = (gw: FakeGateway) =>
    gw.requests.filter((r) => r.path === "/v1/magpie/quotas" && r.search === "");
  const kepts = (gw: FakeGateway) =>
    gw.requests.filter((r) => r.path === "/v1/magpie/quotas" && r.search === "?kept=1");

  test("kept 有数据 → 只读缓存，不触发完整读取", async () => {
    const gw = start({ keptQuotas: [ENTRY] });
    const read = createQuotaReader(fakeClock());
    const snap = await read(gw.base);
    expect(snap.entries).toHaveLength(1);
    expect(fulls(gw)).toHaveLength(0);
    expect(kepts(gw)).toHaveLength(1);
  });

  test("kept 为空 → 完整读取一次；5 分钟内再读不重复；跨过 5 分钟才再读", async () => {
    const clock = fakeClock();
    const gw = start({ keptQuotas: [], quotas: [ENTRY] });
    const read = createQuotaReader({ now: clock.now });

    const first = await read(gw.base);
    expect(first.entries).toEqual([
      { provider: "openai", account: "acct-1", label: "A", windows: [] },
    ]);
    expect(fulls(gw)).toHaveLength(1);

    const second = await read(gw.base);
    expect(second.entries).toHaveLength(1);
    expect(fulls(gw)).toHaveLength(1); // 仍在 5 分钟内：复用完整读取结果
    expect(kepts(gw)).toHaveLength(2); // kept 是便宜读，每次照常
    expect(second.at.getTime()).toBe(first.at.getTime()); // 缓存快照保留原读取时刻

    clock.tick(5 * 60_000 + 1);
    await read(gw.base);
    expect(fulls(gw)).toHaveLength(2);
  });

  test("完整读取失败 → 5 分钟内不再发起尝试（没有上次成功就当空），跨过 5 分钟才重试", async () => {
    const clock = fakeClock();
    const opts: FakeGatewayOpts = { keptQuotas: [], quotas: [ENTRY] };
    const gw = start(opts);
    const read = createQuotaReader({ now: clock.now });

    opts.fullQuotasStatus = 500;
    await expect(read(gw.base)).rejects.toThrow(/500/); // 首次尝试如实报错
    const second = await read(gw.base); // 窗口内：不重试，也没有上次成功 → 空条目
    expect(second.entries).toEqual([]);
    expect(fulls(gw)).toHaveLength(1);

    opts.fullQuotasStatus = 200;
    const third = await read(gw.base); // 仍在窗口内：上游已恢复也不会立刻被打
    expect(third.entries).toEqual([]);
    expect(fulls(gw)).toHaveLength(1);

    clock.tick(5 * 60_000 + 1);
    const fourth = await read(gw.base); // 跨过 5 分钟：重试并拿到数据
    expect(fourth.entries).toHaveLength(1);
    expect(fulls(gw)).toHaveLength(2);
  });

  test("完整读取失败 → 5 分钟内复用上一次成功结果", async () => {
    const clock = fakeClock();
    const opts: FakeGatewayOpts = { keptQuotas: [], quotas: [ENTRY] };
    const gw = start(opts);
    const read = createQuotaReader({ now: clock.now });

    const good = await read(gw.base); // 成功一次
    expect(good.entries).toHaveLength(1);

    opts.quotas = []; // 上游真坏了：即便重试也拿不到数据
    opts.fullQuotasStatus = 500;
    clock.tick(5 * 60_000 + 1);
    await expect(read(gw.base)).rejects.toThrow(/500/); // 窗口外重试失败
    const fallback = await read(gw.base); // 窗口内：用上次成功，不再打上游
    expect(fallback.entries).toHaveLength(1);
    expect(fallback.at.getTime()).toBe(good.at.getTime());
    expect(fulls(gw)).toHaveLength(2); // 失败后的窗口内没有第三次尝试
  });

  test("kept 为空时并发兜底读取合并为一次完整读取", async () => {
    const gw = start({ keptQuotas: [], quotas: [ENTRY], fullQuotasDelayMs: 50 });
    const read = createQuotaReader(fakeClock());
    const [a, b, c] = await Promise.all([read(gw.base), read(gw.base), read(gw.base)]);
    expect(fulls(gw)).toHaveLength(1);
    expect(a.entries).toEqual(b.entries);
    expect(b.entries).toEqual(c.entries);
    expect(a.entries).toHaveLength(1);
  });
});
