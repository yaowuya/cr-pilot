# 多阶段构建：只把生产依赖与源码打进最终镜像
# ------------------------------------------------------------
# 1. deps 阶段：安装生产依赖（利用层缓存，package.json 不变则不重装）
# ------------------------------------------------------------
FROM node:22-alpine AS deps
WORKDIR /app

# 只复制依赖声明，先安装生产依赖（omit=dev 跳过 typescript 等）
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ------------------------------------------------------------
# 2. frontend 阶段：构建管理前端（产物为静态文件，运行期不需要 Node）
# ------------------------------------------------------------
FROM node:22-alpine AS frontend
WORKDIR /app/web

# 只复制前端依赖声明，利用层缓存：仅改源码时不重装依赖
COPY web/package.json web/package-lock.json* ./
# 用 npm ci 而非 npm install：ci 严格按 lock 文件安装、不会改写 lock，
# 构建可复现；install 在依赖声明与 lock 不一致时会静默改 lock。
RUN npm ci --no-audit --no-fund

COPY web/ ./
RUN npm run build

# ------------------------------------------------------------
# 3. builder 阶段：复制源码与配置（无需编译，Node 22 原生跑 TS）
# ------------------------------------------------------------
FROM node:22-alpine AS builder
WORKDIR /app

# 从 deps 拷贝 node_modules
COPY --from=deps /app/node_modules ./node_modules

# 复制应用代码与运行期必须的配置目录
COPY package.json package-lock.json ./
COPY src ./src
# scripts 是运维脚本（import-prompts 等），README 要求用
# `docker compose exec cr-pilot node scripts/import-prompts.ts` 在容器内执行。
# 不拷进来会让那条文档指引直接报 Cannot find module。
COPY scripts ./scripts
COPY prompts ./prompts
COPY pi-agent ./pi-agent

# ------------------------------------------------------------
# 4. runner 阶段：最小运行镜像，非 root 用户
# ------------------------------------------------------------
FROM node:22-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV HOST=0.0.0.0
# 主端口（API + webhook）与管理界面端口，对齐团队既有「5001=API、5002=UI」约定。
# 同一 Express 实例同时监听两者，不需要第二个进程。
ENV PORT=5001
ENV UI_PORT=5002
# pi 凭证闭环：配置目录固定在镜像内的 /app/pi-agent（models.json 用
# $LLMGW_API_KEY 环境变量插值取密钥），密钥经挂载的 .env 注入，不依赖宿主机。
ENV PI_CODING_AGENT_DIR=/app/pi-agent
# 数据库默认路径指向持久卷挂载点（compose 把 /data/cr-pilot 挂到 /app/data）。
ENV DB_PATH=/app/data/cr-pilot.db

# 把 node_modules、源码、配置从 builder 拷入
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/src ./src
COPY --from=builder /app/scripts ./scripts
COPY --from=builder /app/prompts ./prompts
# pi-agent 目录必须对运行用户可写：pi SDK 首次评审时会写入缓存/状态文件
# （如 models-store.json），只读会导致 internal error → No API key found。
# COPY --chown 在拷贝时直接设属主，避免额外的 chown RUN 层。
COPY --chown=node:node --from=builder /app/pi-agent ./pi-agent
COPY --from=builder /app/package.json ./
# 前端构建产物：Express 静态托管 dist（见 src/bootstrap.ts 的 WEB_DIST_DIR）。
# 目录必须对 node 用户可读；用 --chown 一并设好属主，避免运行时权限问题。
COPY --chown=node:node --from=frontend /app/dist ./dist

# 数据与日志目录：两者都是 compose 里的具名卷挂载点，必须在镜像内预建。
RUN mkdir -p /app/data /app/logs && chown -R node:node /app/data /app/logs

# su-exec：极小的降权工具（~10KB），用于 entrypoint 以 root 修完属主后切回 node。
# Alpine 不预装 gosu，su-exec 是官方推荐替代。
RUN apk add --no-cache su-exec

# 启动脚本：以 root 修正卷属主后降权运行。
#
# 为什么需要它：具名卷首次挂载到已存在目录时，Docker 会复制目录**内容**，
# 但**卷根目录属主被设为 root**——镜像里 chown 成 node 的设置不生效。
# 于是 node(uid 1000) 无法在 /app/data 建库、无法往 /app/logs 写日志，
# 表现为「unable to open database file」。
# 每次启动都 chown 一次（幂等、目录为空时开销可忽略），不依赖卷的初始化时机。
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# 对外声明两个端口：5001（API/webhook）、5002（管理界面，等同 5001 的服务）
EXPOSE 5001 5002

# entrypoint 负责修属主并 exec 降权；CMD 只用 exec 形式避免信号丢失
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "src/bootstrap.ts"]
