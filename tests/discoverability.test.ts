import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// 可发现性回归。依据（magpie 源码）：
// - 仓库发现只看 GitHub 话题 topic:magpie-plugin（internal/plugin/github.go:235，archived:false fork:false，按 star 排序）。
// - 插件页搜索框把 [仓库名, owner/repo, owner, 安装名, 摘要].join(" ") 转小写后做整串子串匹配
//   （不分词，空格也算字符）：internal/gui/assets/plugins.js:671（ghMatch）与 :939（match）。
//   摘要只取 GitHub 仓库设置里的 description（ghListing 只填 summary.en）。
// - package.json 的 keywords、description 与仓库其他 topics 都不参与 magpie 搜索
//   （keywords 只服务 npm/GitHub 自身搜索），改 keywords 对插件页可发现性无效；
//   唯一可控的搜索文本是仓库名与 GitHub 仓库描述，发布约定：仓库描述与 package.json description 逐字一致。

type Pkg = {
  name: string;
  description: string;
  repository: { url: string };
  keywords: string[];
};

const pkg: Pkg = JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf8")) as Pkg;
const readme = readFileSync(join(import.meta.dir, "..", "README.md"), "utf8");

const ownerRepo = pkg.repository.url.replace(/^git\+https:\/\/github\.com\//, "").replace(/\.git$/, "");
const owner = ownerRepo.split("/")[0];
// 与 magpie ghMatch 同一公式：GitHub 来源卡片的搜索串
const searchable = [pkg.name, ownerRepo, owner, `github:${ownerRepo}`, pkg.description].join(" ").toLowerCase();

// README 开头（第一个二级标题之前）：英文引言 + 中文核心段
const intro = readme.slice(0, readme.indexOf("\n## ")).toLowerCase();

// 用户会搜的词（中英混合），来自 plan「Task 3 补充」的定稿清单
const SEARCH_WORDS = [
  "窗口预热", "预热", "窗口", "额度", "配额", "定时", "定时消息", "保活", "重置", "订阅", "5小时", "每天",
  "codex", "claude", "glm", "智谱", "zcode",
  "quota", "warmup", "warm up", "keep-alive", "schedule", "cron", "reset", "rate limit", "usage",
];

// description 与 README 开头必须共有的核心主张（各自语言表述），任一侧缺失即视为两份文本走样
const CORE_CLAIMS: Array<[string, string[], string[]]> = [
  ["插件名 Window Warmup", ["window warmup"], ["window warmup"]],
  ["保活短消息", ["keep-alive", "短消息"], ["keep-alive", "短消息"]],
  ["订阅额度窗口", ["额度", "订阅", "窗口"], ["quota", "subscription", "window"]],
  ["触发：窗口重置后", ["重置后"], ["resets"]],
  ["触发：每天定时", ["每天"], ["fixed time of day"]],
  ["触发：每隔几小时", ["每隔几小时"], ["every few hours"]],
];

describe("插件页搜索可发现性", () => {
  test("description ≤350 字符", () => {
    expect(pkg.description.length).toBeLessThanOrEqual(350);
  });

  test("每个搜索词按 magpie 规则都能命中搜索串", () => {
    for (const w of SEARCH_WORDS) {
      expect(searchable, `搜索词「${w}」未命中 [仓库名, owner/repo, owner, 安装名, description] 拼串`).toContain(w);
    }
  });

  test("仓库名本身命中 magpie / window / warmup", () => {
    for (const w of ["magpie", "window", "warmup"]) {
      expect(pkg.name.toLowerCase(), `仓库名 ${pkg.name} 缺「${w}」`).toContain(w);
    }
  });

  test("keywords 保留插件发现契约词（npm/GitHub 自身搜索用）", () => {
    for (const w of ["magpie", "magpie-plugin", "magpie-page"]) {
      expect(pkg.keywords, `keywords 缺「${w}」`).toContain(w);
    }
  });

  test("description 与 README 开头的核心表述不矛盾", () => {
    const desc = pkg.description.toLowerCase();
    for (const [claim, inDesc, inIntro] of CORE_CLAIMS) {
      for (const w of inDesc) {
        expect(desc, `description 缺「${w}」（核心主张：${claim}）`).toContain(w);
      }
      for (const w of inIntro) {
        expect(intro, `README 开头缺「${w}」（核心主张：${claim}）`).toContain(w);
      }
    }
  });
});
