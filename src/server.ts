import { createServer, type Server } from "node:http";
import { pathToFileURL } from "node:url";
import { createApp } from "./app.ts";
import { loadConfig, type AppConfig } from "./config.ts";
import { createPiReviewer, type Reviewer } from "./reviewer.ts";

/**
 * 装配应用并监听端口。
 *
 * 显式创建 http server 并在 `listen()` 之前挂好事件监听：`app.listen(port, host, cb)`
 * 的回调并不对应 `listening` 事件，端口被占用时它会先于 `error` 触发，导致启动失败
 * 被当成成功。这里只认 `listening` 与 `error` 两个事件，启动错误以 reject 抛出。
 */
export function startServer(config: AppConfig, reviewer: Reviewer): Promise<Server> {
  const app = createApp({ reviewer, promptPath: config.promptPath, timeoutMs: config.timeoutMs });
  const server = createServer(app);
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.once("listening", () => resolve(server));
    server.listen(config.port, config.host);
  });
}

// 仅在直接执行本文件时启动服务。测试会导入本模块，因此必须有这层判定，
// 否则一次 import 就会占用端口并留下一个不会退出的进程。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config = loadConfig();
  const server = await startServer(config, createPiReviewer());
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : config.port;
  console.log(`cr-pilot 正在监听 http://${config.host}:${port}/review/webhook`);
}
