// web/app.ts
var DAY_MS = 86400000;
var HOUR_MS = 3600000;
var NAME_MAX = 40;
var RESET_GRACE_MS = 30000;
var POLL_MS = 3000;
var CATALOG_POLL_MS = 60000;
var RUNS_PREVIEW = 5;
var RUNS_MAX = 50;
var DELETE_CONFIRM_MS = 3000;
function statusOf(task, runs) {
  if (!task.enabled)
    return { tone: "", text: "已停用" };
  let latest = null;
  for (const r of runs) {
    if (r.taskId !== task.id)
      continue;
    if (!latest || r.startedAt >= latest.startedAt)
      latest = r;
  }
  if (latest?.outcome === "running")
    return { tone: "ok", text: "发送中" };
  if (latest?.outcome === "failed")
    return { tone: "bad", text: "上次失败" };
  if (latest?.outcome === "unknown")
    return { tone: "unk", text: "上次结果未知" };
  return { tone: "", text: "" };
}
function nextLabel(iso, now) {
  if (!iso)
    return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime()))
    return "—";
  const fmt = new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const time = fmt.format(d);
  const startOfDay = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const day = Math.round((startOfDay(d) - startOfDay(now)) / DAY_MS);
  if (day === 0)
    return time;
  if (day === 1)
    return `明天 ${time}`;
  return `${d.getMonth() + 1}/${d.getDate()} ${time}`;
}
function runTimeLabel(iso, now) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime()))
    return "—";
  const startOfDay = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const day = Math.round((startOfDay(d) - startOfDay(now)) / DAY_MS);
  const hm = `${p2(d.getHours())}:${p2(d.getMinutes())}`;
  if (day === 0)
    return `今天 ${hm}`;
  if (day === -1)
    return `昨天 ${hm}`;
  return `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
}
function rowSub(task) {
  return `${trigText(task.trigger)} · ${task.account || "自动选账号"} · ${task.model ? shortModel(task.model) : "自动选模型"}`;
}
function trigText(trigger) {
  switch (trigger.kind) {
    case "window":
      return `窗口 ${trigger.window} 重置后`;
    case "daily":
      return `每天 ${trigger.time}`;
    case "every":
      return `每 ${trigger.hours} 小时`;
  }
}
function shortModel(id) {
  return id.split("/").pop() ?? id;
}
function modelDisplay(modelId, providerId) {
  return providerId && modelId.startsWith(`${providerId}/`) ? modelId.slice(providerId.length + 1) : modelId;
}
function effortLabel(pick) {
  if ("error" in pick)
    return `思考档位无法识别：${pick.error}`;
  return `思考：${pick.label}`;
}
function runOutcome(outcome) {
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
var SOURCE_TEXT = {
  manual: "手动",
  catchup: "补发",
  schedule: "按计划"
};
function runReason(r) {
  if (r.outcome !== "ok")
    return r.reason;
  const parts = ["已发送"];
  if (r.model)
    parts.push(shortModel(r.model));
  if (r.effort)
    parts.push(`思考 ${r.effort}`);
  if (r.ms !== null)
    parts.push(`${(r.ms / 1000).toFixed(1)} 秒`);
  parts.push(SOURCE_TEXT[r.source] ?? r.source);
  return parts.join(" · ");
}
function accountOptions(providerId, current, allowAuto, providers) {
  const list = [];
  if (allowAuto)
    list.push({ value: "", text: "自动选择" });
  const provider = providers.find((p) => p.id === providerId);
  if (current && !provider?.accounts.some((a) => a.id === current)) {
    list.push({ value: current, text: current });
  }
  for (const a of provider?.accounts ?? []) {
    list.push({ value: a.id, text: a.label && a.label !== a.id ? `${a.label}（${a.id}）` : a.id });
  }
  if (!list.length)
    list.push({ value: "", text: "该供应商没有账号" });
  return list;
}
function modelOptions(providerId, current, providers) {
  const list = [{ value: "", text: "自动", aux: "小模型优先" }];
  const provider = providers.find((p) => p.id === providerId);
  if (current && !provider?.models.some((m) => m.id === current)) {
    list.push({ value: current, text: current });
  }
  for (const m of provider?.models ?? []) {
    list.push({ value: m.id, text: modelDisplay(m.id, providerId) });
  }
  return list;
}
function windowAux(w) {
  const parts = [];
  if (w.used !== null)
    parts.push(`已用 ${Math.round(w.used)}%`);
  parts.push(w.resetsAt ? `${hm(new Date(w.resetsAt))} 重置` : "空闲");
  return parts.join(" · ");
}
function windowOptions(providerId, accountId, current, providers) {
  const provider = providers.find((p) => p.id === providerId);
  const acct = provider?.accounts.find((a) => a.id === accountId);
  const list = [];
  if (current && !acct?.windows.some((w) => w.name === current)) {
    list.push({ value: current, text: current });
  }
  for (const w of acct?.windows ?? [])
    list.push({ value: w.name, text: w.name, aux: windowAux(w) });
  if (!list.length)
    list.push({ value: "", text: accountId ? "该账号没有窗口信息" : "先选定账号" });
  return list;
}
function forceWindowAccount(providerId, providers) {
  return providers.find((p) => p.id === providerId)?.accounts[0]?.id ?? "";
}
function modelHint(model, provider) {
  const autoSub = "名字带 flash / lite / mini 的小模型优先，每次发送前重新选；思考能关就关，不能关用最低档。";
  const fixedSub = "思考档位按这个模型的配置自动决定：能关就关，不能关用最低档。";
  if (model) {
    const m = provider?.models.find((x) => x.id === model);
    return { main: m ? effortLabel(m.effort) : "思考：目录里暂时没有这个模型", sub: fixedSub };
  }
  const autoId = provider?.autoModel ?? null;
  if (!autoId)
    return { main: "该供应商没有可用模型", sub: autoSub };
  const m = provider?.models.find((x) => x.id === autoId);
  const think = m ? effortLabel(m.effort) : "思考：目录里暂时没有这个模型";
  return { main: `自动选中 ${shortModel(autoId)} · ${think}`, sub: autoSub };
}
function sumView(tasks, next) {
  let enabled = 0;
  let best = null;
  for (const t of tasks) {
    if (!t.enabled)
      continue;
    enabled++;
    const at = next[t.id];
    if (at && (!best || at < best.at))
      best = { at, name: t.name };
  }
  return { enabled, next: best };
}
function validateDraft(d) {
  const name = d.name.trim();
  if (!name)
    return { error: "给任务起个名字", field: "name" };
  if ([...name].length > NAME_MAX)
    return { error: `名称不能超过 ${NAME_MAX} 字`, field: "name" };
  if (!d.provider.trim())
    return { error: "必须选择供应商", field: "provider" };
  if (d.trigger.kind === "window") {
    if (!d.account.trim())
      return { error: "窗口任务必须指定账号，不支持自动选择", field: "account" };
    if (!d.trigger.window)
      return { error: "必须填写额度窗口名", field: "window" };
  }
  if (d.trigger.kind === "daily" && !/^([01]\d|2[0-3]):[0-5]\d$/.test(d.trigger.time)) {
    return { error: "时间需为 24 小时制的 HH:MM", field: "time" };
  }
  return null;
}
function syncDraftOnPoll(saved, openUpdatedAt, dirty) {
  if (!saved)
    return "gone";
  if (!dirty)
    return "adopt";
  return saved.updatedAt === openUpdatedAt ? "keep" : "stale";
}
function deleteArmed(confirmDeleteAt, now) {
  return confirmDeleteAt > 0 && now - confirmDeleteAt <= DELETE_CONFIRM_MS;
}
function shouldCloseOnScroll(target, pop) {
  if (!pop)
    return false;
  if (target === pop)
    return false;
  return !pop.contains(target);
}
var fmtCache = new Map;
function wallParts(t, timeZone) {
  let f = fmtCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit"
    });
    fmtCache.set(timeZone, f);
  }
  const p = {};
  for (const part of f.formatToParts(t)) {
    if (part.type !== "literal")
      p[part.type] = Number(part.value);
  }
  return { y: p.year, mo: p.month, d: p.day, h: p.hour, mi: p.minute };
}
function tzOffsetMs(t, timeZone) {
  const w = wallParts(t, timeZone);
  return Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi) - Math.floor(t.getTime() / 60000) * 60000;
}
function nextDailyLocal(time, timeZone, after) {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(time);
  const hh = Number(m?.[1] ?? 6);
  const mm = Number(m?.[2] ?? 0);
  const w = wallParts(after, timeZone);
  let y = w.y;
  let mo = w.mo;
  let d = w.d;
  for (let i = 0;i < 3; i++) {
    const guess = Date.UTC(y, mo - 1, d, hh, mm);
    let t = guess - tzOffsetMs(new Date(guess), timeZone);
    t = guess - tzOffsetMs(new Date(t), timeZone);
    if (t > after.getTime())
      return new Date(t);
    const nd = new Date(Date.UTC(y, mo - 1, d + 1));
    y = nd.getUTCFullYear();
    mo = nd.getUTCMonth() + 1;
    d = nd.getUTCDate();
  }
  return new Date(after.getTime() + DAY_MS);
}
function nextEveryLocal(hours, anchor, after) {
  const a = new Date(anchor).getTime();
  if (!Number.isFinite(a) || after.getTime() < a) {
    return new Date(Number.isFinite(a) ? a : after.getTime());
  }
  const step = Math.max(hours, 1) * HOUR_MS;
  const k = Math.floor((after.getTime() - a) / step) + 1;
  return new Date(a + k * step);
}
function nextPointsAfter(trigger, after, count) {
  const out = [];
  if (trigger.kind === "window")
    return out;
  let cursor = after;
  for (let i = 0;i < count; i++) {
    cursor = trigger.kind === "daily" ? nextDailyLocal(trigger.time, trigger.timeZone, cursor) : nextEveryLocal(trigger.hours, trigger.anchor, cursor);
    out.push(cursor);
  }
  return out;
}
var p2 = (n) => String(n).padStart(2, "0");
var hm = (d) => `${p2(d.getHours())}:${p2(d.getMinutes())}`;
function b64decode(s) {
  const bin = atob(s);
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}
function localTZ() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}
function timezones() {
  const supported = Intl.supportedValuesOf;
  const list = supported ? supported("timeZone") : [];
  const fallback = ["UTC", "Asia/Shanghai", "Asia/Hong_Kong", "Asia/Taipei", "Asia/Tokyo", "Europe/London", "Europe/Berlin", "America/New_York"];
  const all = list.length ? list : fallback;
  return all.includes(localTZ()) ? all : [localTZ(), ...all];
}
function isoToLocalInput(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime()))
    return "";
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}T${p2(d.getHours())}:${p2(d.getMinutes())}`;
}
function localInputToISO(v) {
  if (!v)
    return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
function errText(e) {
  return e instanceof Error ? e.message : String(e);
}
function cloneTask(t) {
  return JSON.parse(JSON.stringify(t));
}
function contentOf(d) {
  return {
    name: d.name,
    enabled: d.enabled,
    provider: d.provider,
    account: d.account,
    model: d.model,
    message: d.message,
    trigger: d.trigger
  };
}
var NEW_ID = "__new__";
var boot = null;
var state = null;
var catalog = null;
var catalogError = "";
var netError = "";
var actionError = "";
var openId = null;
var draft = null;
var openUpdatedAt = null;
var dirty = false;
var isNew = false;
var staleNote = null;
var formError = null;
var confirmDeleteAt = 0;
var runsExpanded = false;
var catalogTimer;
async function apiJSON(path, init = {}) {
  const res = await fetch(path, {
    ...init,
    headers: {
      "content-type": "application/json",
      "x-window-warmup-token": boot?.token ?? "",
      ...init.headers
    }
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = body.error;
    throw new Error(typeof msg === "string" && msg ? msg : `HTTP ${res.status}`);
  }
  return body;
}
function isReadonly() {
  return !!(state?.fatal || state && typeof state.lockedBy === "number");
}
function currentSavedTask() {
  if (!openId || isNew)
    return null;
  return state?.tasks.find((t) => t.id === openId) ?? null;
}
function latestRunOf(taskId) {
  let latest = null;
  for (const r of state?.runs ?? []) {
    if (r.taskId !== taskId)
      continue;
    if (!latest || r.startedAt >= latest.startedAt)
      latest = r;
  }
  return latest;
}
function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls)
    node.className = cls;
  if (text !== undefined)
    node.textContent = text;
  return node;
}
function replaceChildrenIfChanged(container, sig, build) {
  if (container.dataset.sig === sig)
    return;
  container.dataset.sig = sig;
  const top = container.scrollTop;
  container.replaceChildren(...build());
  container.scrollTop = top;
}
var CHEV = '<svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="m5.5 6.5 2.5 2.5 2.5-2.5"/></svg>';
var popEl = null;
function closePop() {
  if (!popEl)
    return;
  popEl.btn.classList.remove("open");
  popEl.btn.setAttribute("aria-expanded", "false");
  popEl.remove();
  popEl = null;
}
function sel(label, opts, val, onchange) {
  const b = el("button", "field");
  b.type = "button";
  b.setAttribute("aria-haspopup", "listbox");
  b.setAttribute("aria-expanded", "false");
  const cur = opts.find((o) => o.value === val) ?? opts[0];
  const kv = el("span", "kv");
  if (label)
    kv.append(el("span", "k", label));
  const v = el("span", "v", cur?.text ?? "");
  b.title = (cur?.text ?? "") + (cur?.aux ? ` · ${cur.aux}` : "");
  const c = el("span", "chev");
  c.innerHTML = CHEV;
  kv.append(v);
  if (cur?.aux)
    kv.append(el("span", "aux", cur.aux));
  b.append(kv, c);
  b.addEventListener("click", () => {
    if (popEl && popEl.btn === b) {
      closePop();
      return;
    }
    closePop();
    const m = el("div", "pop");
    m.setAttribute("role", "listbox");
    let focusIdx = 0;
    opts.forEach((o, i) => {
      const it = el("button", "it");
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
      if (o.aux)
        it.append(el("span", "aux", o.aux));
      it.addEventListener("click", () => {
        closePop();
        if (o.value !== val)
          onchange(o.value);
      });
      m.append(it);
    });
    m.btn = b;
    document.body.append(m);
    popEl = m;
    b.classList.add("open");
    b.setAttribute("aria-expanded", "true");
    const r = b.getBoundingClientRect();
    m.style.minWidth = `${Math.max(180, r.width)}px`;
    const w = m.offsetWidth;
    const hgt = m.offsetHeight;
    m.style.left = `${Math.max(12, Math.min(r.left, window.innerWidth - w - 12))}px`;
    m.style.top = `${r.bottom + 4 + hgt > window.innerHeight - 8 ? Math.max(8, r.top - 4 - hgt) : r.bottom + 4}px`;
    const items = [...m.querySelectorAll(".it")];
    items[focusIdx]?.focus();
    m.addEventListener("keydown", (ev) => {
      const idx = items.indexOf(document.activeElement);
      let next = -1;
      if (ev.key === "ArrowDown")
        next = Math.min(items.length - 1, idx + 1);
      else if (ev.key === "ArrowUp")
        next = Math.max(0, idx - 1);
      else if (ev.key === "Home")
        next = 0;
      else if (ev.key === "End")
        next = items.length - 1;
      if (next >= 0) {
        ev.preventDefault();
        items[next].focus();
      }
    });
  });
  return b;
}
function field(label, control) {
  const f = el("label", "field");
  const kv = el("span", "kv");
  if (label)
    kv.append(el("span", "k", label));
  kv.append(control);
  f.append(kv);
  return f;
}
function row(ed, label, ...kids) {
  const v = el("div", "v");
  v.append(...kids);
  ed.append(el("label", undefined, label), v);
}
var tzOptionsCache = null;
function tzOffsetLabel(tz, at) {
  try {
    const min = tzOffsetMs(at, tz) / 60000;
    const abs = Math.abs(min);
    return `UTC${min < 0 ? "-" : "+"}${Math.floor(abs / 60)}${abs % 60 ? `:${p2(abs % 60)}` : ""}`;
  } catch {
    return "";
  }
}
function timezoneOptions() {
  if (!tzOptionsCache) {
    const now = new Date;
    tzOptionsCache = timezones().map((z) => ({
      value: z,
      text: z,
      aux: tzOffsetLabel(z, now)
    }));
  }
  return tzOptionsCache;
}
var f = null;
function markDirty() {
  dirty = true;
}
function onTextEdit(kind, apply) {
  const node = kind === "name" ? f?.name : f?.msg;
  const caret = node?.selectionStart ?? null;
  apply();
  formError = null;
  if (!dirty) {
    dirty = true;
    render();
    const again = kind === "name" ? f?.name : f?.msg;
    if (again) {
      again.focus();
      const pos = Math.min(caret ?? again.value.length, again.value.length);
      again.setSelectionRange(pos, pos);
    }
  }
}
function openTask(task) {
  openId = task.id;
  draft = cloneTask(task);
  openUpdatedAt = task.updatedAt;
  dirty = false;
  isNew = false;
  runsExpanded = false;
  staleNote = null;
  formError = null;
  confirmDeleteAt = 0;
}
function openNew() {
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
    updatedAt: ""
  };
  openId = NEW_ID;
  openUpdatedAt = null;
  dirty = true;
  isNew = true;
  runsExpanded = false;
  staleNote = null;
  formError = null;
  confirmDeleteAt = 0;
  render();
  f?.name.focus();
}
function closeEditor() {
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
function cancelEdit() {
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
  draft = cloneTask(saved);
  openUpdatedAt = saved.updatedAt;
  dirty = false;
  formError = null;
  staleNote = null;
  render();
}
async function save() {
  const d = draft;
  if (!d || !openId)
    return;
  const check = validateDraft(d);
  if (check) {
    formError = check.error;
    render();
    if (check.field === "name")
      f?.name.focus();
    return;
  }
  const content = contentOf(d);
  const input = {
    ...content,
    name: content.name.trim(),
    provider: content.provider.trim(),
    account: content.account.trim(),
    model: content.model.trim()
  };
  try {
    if (isNew)
      await apiJSON("api/tasks", { method: "POST", body: JSON.stringify(input) });
    else
      await apiJSON(`api/tasks/${encodeURIComponent(openId)}`, { method: "PUT", body: JSON.stringify(input) });
  } catch (e) {
    formError = errText(e);
    render();
    return;
  }
  if (!draft || !openId || d !== draft) {
    return;
  }
  dirty = false;
  formError = null;
  if (isNew)
    closeEditor();
  await refreshState();
}
async function removeCurrent() {
  const saved = currentSavedTask();
  if (!saved) {
    closeEditor();
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
    await apiJSON(`api/tasks/${encodeURIComponent(saved.id)}`, { method: "DELETE" });
    closeEditor();
    await refreshState();
  } catch (e) {
    actionError = errText(e);
    render();
  }
}
async function runNow() {
  const task = currentSavedTask();
  if (!task)
    return;
  try {
    await apiJSON(`api/tasks/${encodeURIComponent(task.id)}/run`, { method: "POST" });
    await refreshState();
  } catch (e) {
    formError = errText(e);
    render();
  }
}
async function toggleEnabled(saved) {
  if (!saved) {
    if (!draft)
      return;
    draft.enabled = !draft.enabled;
    dirty = true;
    render();
    return;
  }
  const input = { ...contentOf(saved), enabled: !saved.enabled };
  try {
    const updated = await apiJSON(`api/tasks/${encodeURIComponent(saved.id)}`, { method: "PUT", body: JSON.stringify(input) });
    if (openId === saved.id)
      openUpdatedAt = updated.updatedAt;
    await refreshState();
  } catch (e) {
    actionError = errText(e);
    render();
  }
}
function buildEditor() {
  const d = draft;
  if (!d)
    return el("div");
  const providers = catalog?.providers ?? [];
  const provider = providers.find((p) => p.id === d.provider);
  const ed = el("div", "editor");
  const saved = currentSavedTask();
  if (saved && d.enabled) {
    const last = latestRunOf(saved.id);
    if (last && last.outcome === "failed") {
      const n = el("div", "note full");
      n.append(`上次失败（${runTimeLabel(last.startedAt, new Date)}）：`);
      n.append(el("span", undefined, `${last.reason}。任务没有暂停，下一次照常发送。`));
      ed.append(n);
    }
  }
  if (staleNote)
    ed.append(el("div", "stale full", staleNote));
  if (formError)
    ed.append(el("div", "note full", formError));
  const name = el("input", "text");
  name.value = d.name;
  name.maxLength = NAME_MAX;
  name.placeholder = "给任务起个名字";
  name.addEventListener("input", () => onTextEdit("name", () => {
    if (draft)
      draft.name = name.value;
  }));
  row(ed, "名称", name);
  const fs = el("div", "fields c3");
  const provOpts = providers.map((p) => ({ value: p.id, text: p.id }));
  if (d.provider && !provOpts.some((o) => o.value === d.provider))
    provOpts.unshift({ value: d.provider, text: d.provider });
  if (!provOpts.length)
    provOpts.push({ value: "", text: "选择供应商" });
  fs.append(sel("供应商", provOpts, d.provider, (v) => {
    markDirty();
    if (!draft)
      return;
    draft.provider = v;
    draft.account = draft.trigger.kind === "window" ? forceWindowAccount(v, providers) : "";
    if (draft.trigger.kind === "window") {
      draft.trigger = { kind: "window", window: windowOptions(v, draft.account, "", providers).find((o) => o.value)?.value ?? "" };
    }
    draft.model = "";
    formError = null;
    render();
  }));
  if (d.trigger.kind === "window" && !d.account)
    d.account = forceWindowAccount(d.provider, providers);
  const allowAuto = d.trigger.kind !== "window";
  fs.append(sel("账号", accountOptions(d.provider, d.account, allowAuto, providers), d.account, (v) => {
    markDirty();
    if (!draft)
      return;
    draft.account = v;
    if (draft.trigger.kind === "window") {
      draft.trigger = { kind: "window", window: windowOptions(draft.provider, v, "", providers).find((o) => o.value)?.value ?? "" };
    }
    formError = null;
    render();
  }));
  fs.append(sel("模型", modelOptions(d.provider, d.model, providers), d.model, (v) => {
    markDirty();
    if (draft)
      draft.model = v;
    formError = null;
    render();
  }));
  const mh = modelHint(d.model, provider);
  const parts = [fs, el("div", "hint", mh.main), el("div", "hint mute", mh.sub)];
  if (d.trigger.kind === "window") {
    parts.push(el("div", "hint mute", "跟随窗口重置时必须指定账号，每个账号的窗口各自计时。"));
  }
  row(ed, "发送到", ...parts);
  const seg = el("div", "seg");
  for (const [k, txt] of [["window", "窗口重置后"], ["daily", "每天定时"], ["every", "固定间隔"]]) {
    const b = el("button", d.trigger.kind === k ? "on" : "", txt);
    b.type = "button";
    b.addEventListener("click", () => {
      if (!draft || draft.trigger.kind === k)
        return;
      markDirty();
      if (k === "window") {
        if (!draft.account)
          draft.account = forceWindowAccount(draft.provider, providers);
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
      if (draft && draft.trigger.kind === "window")
        draft.trigger = { kind: "window", window: v };
      formError = null;
      render();
    }));
  } else if (d.trigger.kind === "daily") {
    const ti = el("input");
    ti.type = "time";
    ti.value = d.trigger.time;
    ti.addEventListener("change", () => {
      markDirty();
      if (draft && draft.trigger.kind === "daily")
        draft.trigger = { ...draft.trigger, time: ti.value };
      formError = null;
      render();
    });
    const tz = sel("时区", timezoneOptions(), d.trigger.timeZone, (v) => {
      markDirty();
      if (draft && draft.trigger.kind === "daily")
        draft.trigger = { ...draft.trigger, timeZone: v };
      render();
    });
    line.append(field("时间", ti), tz);
  } else {
    const hoursOpts = [1, 2, 3, 4, 5, 6, 8, 12, 24, 48, 72, 168].map((n) => ({ value: String(n), text: `${n} 小时` }));
    const hv = String(d.trigger.hours);
    if (!hoursOpts.some((o) => o.value === hv))
      hoursOpts.unshift({ value: hv, text: `${hv} 小时` });
    line.append(sel("每", hoursOpts, hv, (v) => {
      markDirty();
      if (draft && draft.trigger.kind === "every")
        draft.trigger = { ...draft.trigger, hours: Number(v) };
      formError = null;
      render();
    }));
    const an = el("input");
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
  const now = new Date;
  const useServer = !!(saved && !dirty && state);
  if (d.trigger.kind === "window") {
    const winName = d.trigger.window;
    let first = "";
    const nextIso = useServer && saved ? state?.next[saved.id] ?? null : null;
    if (nextIso)
      first = nextLabel(nextIso, now);
    if (!first) {
      const win = provider?.accounts.find((a) => a.id === d.account)?.windows.find((w) => w.name === winName);
      if (win?.resetsAt) {
        first = nextLabel(new Date(new Date(win.resetsAt).getTime() + RESET_GRACE_MS).toISOString(), now);
      }
    }
    nextEl.append("接下来 ", el("b", undefined, first ? `${first}，之后跟随每次重置` : "等下一次额度刷新，之后跟随每次重置"));
  } else {
    const dates = [];
    const trig = saved?.trigger ?? null;
    const nextIso = useServer && saved ? state?.next[saved.id] ?? null : null;
    if (useServer && trig && trig.kind !== "window" && nextIso) {
      let cursor = new Date(nextIso);
      dates.push(cursor);
      for (let i = 0;i < 2; i++) {
        cursor = trig.kind === "daily" ? nextDailyLocal(trig.time, trig.timeZone, cursor) : nextEveryLocal(trig.hours, trig.anchor, cursor);
        dates.push(cursor);
      }
    } else {
      dates.push(...nextPointsAfter(d.trigger, now, 3));
    }
    nextEl.append("接下来 ", el("b", undefined, dates.length ? dates.map((x) => nextLabel(x.toISOString(), now)).join(" · ") : "—"));
  }
  row(ed, "触发", seg, line, nextEl);
  const msg = el("textarea", "text");
  msg.rows = 1;
  msg.maxLength = 200;
  msg.value = d.message;
  msg.addEventListener("input", () => onTextEdit("msg", () => {
    if (draft)
      draft.message = msg.value;
  }));
  row(ed, "消息", msg, el("div", "hint mute", "回复最多 16 个 token；30 秒没结果记为「结果未知」，不会自动重发。"));
  const act = el("div", "actions full");
  const del = el("button", "btn danger", saved ? deleteArmed(confirmDeleteAt, Date.now()) ? "确认删除" : "删除" : "放弃");
  del.type = "button";
  del.disabled = isReadonly();
  del.addEventListener("click", () => void removeCurrent());
  act.append(del, el("span", "sp"));
  if (dirty) {
    act.append(el("span", "dirty-tip", "有未保存的修改"));
    const cancel = el("button", "btn", "取消");
    cancel.type = "button";
    cancel.addEventListener("click", cancelEdit);
    const saveBtn = el("button", "btn primary", "保存");
    saveBtn.type = "button";
    saveBtn.disabled = isReadonly();
    saveBtn.addEventListener("click", () => void save());
    act.append(cancel, saveBtn);
  }
  ed.append(act);
  const box = el("div", "full");
  const rh = el("div", "runs-h");
  rh.append(el("b", undefined, "执行记录"), el("span", undefined, "最近 50 次"), el("span", "sp"));
  const runBtn = el("button", "link", "立即发送一次");
  runBtn.type = "button";
  runBtn.disabled = isNew || isReadonly();
  runBtn.title = isNew ? "先保存任务" : dirty ? "按已保存的设置发送，不含未保存的修改" : "马上按当前设置发一条，不影响计划";
  runBtn.addEventListener("click", () => void runNow());
  rh.append(runBtn);
  box.append(rh);
  const runsBox = el("div", "runs");
  const all = saved ? (state?.runs ?? []).filter((r) => r.taskId === saved.id).slice().sort((a, b) => a.startedAt < b.startedAt ? 1 : -1) : [];
  const shown = all.slice(0, runsExpanded ? RUNS_MAX : RUNS_PREVIEW);
  if (!shown.length) {
    const e = el("div", "empty", "还没有执行过。");
    e.style.padding = "14px";
    runsBox.append(e);
  }
  for (const r of shown) {
    const out = runOutcome(r.outcome);
    const lineEl = el("div", "run");
    lineEl.append(el("span", "t", runTimeLabel(r.startedAt, now)), el("span", `r ${out.tone}`.trim(), out.text), el("span", "why", runReason(r)));
    runsBox.append(lineEl);
  }
  if (!runsExpanded && all.length > RUNS_PREVIEW) {
    const more = el("button", "more", "显示更多");
    more.type = "button";
    more.addEventListener("click", () => {
      runsExpanded = true;
      render();
    });
    runsBox.append(more);
  }
  box.append(runsBox);
  ed.append(box);
  f = { name, msg };
  return ed;
}
function draftDisplaySig() {
  if (!draft)
    return null;
  const d = draft;
  return JSON.stringify([d.enabled, d.provider, d.account, d.model, d.trigger]);
}
function catalogSig() {
  return JSON.stringify((catalog?.providers ?? []).map((p) => [
    p.id,
    p.autoModel,
    p.accounts.map((a) => [a.id, a.label, a.windows.map((w) => [w.name, w.used, w.resetsAt])]),
    p.models.map((m) => m.id)
  ]));
}
function runsViewSig() {
  const saved = currentSavedTask();
  const runs = saved ? (state?.runs ?? []).filter((r) => r.taskId === saved.id) : [];
  return JSON.stringify(runs.map((r) => [r.id, r.outcome, r.reason, r.effort, r.model, r.ms, r.source, r.startedAt]));
}
function rowEl(view, saved, isOpen) {
  const status = statusOf(view, state?.runs ?? []);
  const r = el("div", "row" + (isOpen ? " open" : "") + (view.enabled ? "" : " dim"));
  r.tabIndex = 0;
  r.setAttribute("role", "button");
  r.setAttribute("aria-expanded", isOpen ? "true" : "false");
  const who = el("div", "who");
  who.append(el("div", "name", view.name || "未命名任务"), el("div", "sub", rowSub(view)));
  const when = el("div", "when");
  if (view.enabled) {
    const at = saved ? state?.next[saved.id] ?? null : null;
    when.append(el("div", "t", nextLabel(at, new Date)));
  }
  if (status.text)
    when.append(el("div", `s ${status.tone}`.trim(), status.text));
  const sw = el("button", "sw" + (view.enabled ? " on" : ""));
  sw.type = "button";
  sw.setAttribute("role", "switch");
  sw.setAttribute("aria-label", "启用");
  sw.setAttribute("aria-checked", view.enabled ? "true" : "false");
  sw.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleEnabled(saved);
  });
  r.append(who, when, sw, el("span", "chev", "›"));
  r.addEventListener("click", () => {
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
function renderList() {
  const list = document.getElementById("list");
  if (!list)
    return;
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
    state === null
  ]);
  replaceChildrenIfChanged(list, sig, () => {
    if (!state)
      return [];
    const nodes = [];
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
    if (isNew && draft)
      nodes.push(rowEl(draft, null, true));
    for (const t of tasks) {
      const open = openId === t.id;
      nodes.push(rowEl(open && draft ? draft : t, t, open));
    }
    if (openId && draft)
      nodes.push(buildEditor());
    return nodes;
  });
}
function renderSum() {
  const sum = document.getElementById("sum");
  if (!sum)
    return;
  sum.replaceChildren();
  if (!state)
    return;
  const view = sumView(state.tasks, state.next);
  if (!view.enabled) {
    sum.textContent = "没有启用的任务";
    return;
  }
  sum.append(`${view.enabled} 个任务启用`);
  if (view.next) {
    sum.append(" · 下一次 ", el("b", undefined, nextLabel(view.next.at, new Date)), ` ${view.next.name}`);
  }
}
function renderBars() {
  const bars = document.getElementById("bars");
  if (!bars)
    return;
  const nodes = [];
  if (netError)
    nodes.push(el("div", "notice bad", `页面与服务断开了：${netError}（服务可能已退出，重新打开页面试试）`));
  if (state?.fatal)
    nodes.push(el("div", "notice bad", `服务处于故障状态，任务没有在运行：${state.fatal}`));
  if (state && typeof state.lockedBy === "number") {
    nodes.push(el("div", "notice warn", state.lockedBy > 0 ? `另一个实例正在运行（进程 ${state.lockedBy}），本页只读。` : "另一个实例可能正在运行（无法确认持有者进程），本页只读。"));
  }
  if (state?.saveError)
    nodes.push(el("div", "notice warn", `数据可能没保存：${state.saveError}`));
  if (catalogError)
    nodes.push(el("div", "notice warn", `模型目录读取失败：${catalogError}（稍后自动重试）`));
  if (actionError)
    nodes.push(el("div", "notice bad", actionError));
  bars.replaceChildren(...nodes);
}
function render() {
  renderBars();
  renderSum();
  renderList();
  const newBtn = document.getElementById("new");
  if (newBtn)
    newBtn.disabled = isReadonly();
}
async function refreshState() {
  try {
    state = await apiJSON("api/state");
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
function syncOpen() {
  if (!openId || isNew || !draft)
    return;
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
async function refreshCatalog() {
  try {
    catalog = await apiJSON("api/catalog");
    catalogError = "";
  } catch (e) {
    catalogError = errText(e);
  }
  render();
}
function applyTheme() {
  if (!boot)
    return;
  if (boot.theme === "dark")
    document.body.classList.add("dark");
  else if (boot.theme === "light")
    document.body.classList.remove("dark");
  if (boot.tokens) {
    try {
      const vars = JSON.parse(b64decode(boot.tokens));
      for (const [k, v] of Object.entries(vars)) {
        if (k.startsWith("--") && typeof v === "string" && v) {
          document.documentElement.style.setProperty(k, v);
        }
      }
    } catch {}
  }
}
function init() {
  const raw = document.getElementById("boot")?.textContent ?? "";
  try {
    boot = JSON.parse(raw);
  } catch {
    boot = null;
  }
  if (!boot?.token) {
    document.getElementById("bars")?.replaceChildren(el("div", "notice bad", "页面缺少访问口令，请从 Magpie 的插件页重新打开。"));
    return;
  }
  applyTheme();
  document.getElementById("new")?.addEventListener("click", () => {
    if (!isReadonly() && !isNew)
      openNew();
  });
  document.addEventListener("mousedown", (e) => {
    if (popEl && e.target instanceof Node && !popEl.contains(e.target) && !popEl.btn.contains(e.target))
      closePop();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape")
      closePop();
  });
  document.addEventListener("scroll", (e) => {
    if (shouldCloseOnScroll(e.target, popEl))
      closePop();
  }, true);
  refreshCatalog().then(() => refreshState());
  setInterval(() => {
    if (document.hidden)
      return;
    refreshState();
  }, POLL_MS);
  catalogTimer = setInterval(() => {
    if (document.hidden)
      return;
    refreshCatalog();
  }, CATALOG_POLL_MS);
}
if (typeof document !== "undefined") {
  if (document.getElementById("boot"))
    init();
  else
    document.addEventListener("DOMContentLoaded", init);
}
export {
  DELETE_CONFIRM_MS,
  accountOptions,
  deleteArmed,
  effortLabel,
  forceWindowAccount,
  modelDisplay,
  modelHint,
  modelOptions,
  nextLabel,
  nextPointsAfter,
  rowSub,
  runOutcome,
  runReason,
  runTimeLabel,
  shortModel,
  shouldCloseOnScroll,
  statusOf,
  sumView,
  syncDraftOnPoll,
  trigText,
  validateDraft,
  windowOptions
};
