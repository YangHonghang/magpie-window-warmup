// 宿主入口：magpie 加载本包并调用 server() 时启动本地服务（只起一次）。
// 单纯 import 不占端口、不读写磁盘；启动失败清空单例，宿主下次调用可重试。
import { homedir } from "node:os";
import { join } from "node:path";
import { gatewayBase } from "./gateway";
import { startService, type ServiceHandle } from "./server";
import { migrateLegacyState } from "./store";

/** 默认服务端口，与 package.json 的 magpie.options 和带路页（page/boot.js）一致 */
export const DEFAULT_PORT = 3492;

/** 数据目录：WINDOW_WARMUP_DIR 优先，否则 XDG 配置目录下的 magpie/window-warmup。
 * 不导出：宿主会把模块导出的每个函数都当插件函数调（scripts/check.mjs 的约定） */
function defaultDir(env: Record<string, string | undefined> = process.env): string {
  const custom = env.WINDOW_WARMUP_DIR?.trim();
  if (custom) return custom;
  const xdg = env.XDG_CONFIG_HOME?.trim();
  return join(xdg || join(homedir(), ".config"), "magpie", "window-warmup");
}

let instance: Promise<ServiceHandle> | undefined;

export default {
  id: "magpie-window-warmup",
  /** magpie 宿主入口；options.port 来自 package.json 的 magpie.options */
  server: async (_input: unknown, opts: { port?: number } = {}) => {
    const port = Number(opts?.port);
    instance ??= (async () => {
      const dir = defaultDir();
      // 首次启动（新目录还没有 state.json）时把旧包的数据接过来；迁移在打开 store 之前完成
      await migrateLegacyState(dir);
      return startService({
        port: Number.isFinite(port) && port > 0 ? port : DEFAULT_PORT,
        dir,
        base: gatewayBase(),
      });
    })().catch((e: unknown) => {
      instance = undefined;
      throw e;
    });
    await instance;
    return {};
  },
};
