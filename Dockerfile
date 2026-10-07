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
# 2. builder 阶段：复制源码与配置（无需编译，Node 22 原生跑 TS）
# ------------------------------------------------------------
FROM node:22-alpine AS builder
WORKDIR /app

# 从 deps 拷贝 node_modules
COPY --from=deps /app/node_modules ./node_modules

# 复制应用代码与运行期必须的配置目录
COPY package.json package-lock.json ./
COPY src ./src
COPY prompts ./prompts
COPY pi-agent ./pi-agent

# ------------------------------------------------------------
# 3. runner 阶段：最小运行镜像，非 root 用户
# ------------------------------------------------------------
FROM node:22-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=5001
# pi 凭证闭环：配置目录固定在镜像内的 /app/pi-agent（models.json 用
# $LLMGW_API_KEY 环境变量插值取密钥），密钥经挂载的 .env 注入，不依赖宿主机。
ENV PI_CODING_AGENT_DIR=/app/pi-agent

# 把 node_modules、源码、配置从 builder 拷入
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/src ./src
COPY --from=builder /app/prompts ./prompts
# pi-agent 目录必须对运行用户可写：pi SDK 首次评审时会写入缓存/状态文件
# （如 models-store.json），只读会导致 internal error → No API key found。
# COPY --chown 在拷贝时直接设属主，避免额外的 chown RUN 层。
COPY --chown=node:node --from=builder /app/pi-agent ./pi-agent
COPY --from=builder /app/package.json ./

# 创建非 root 用户并切换（Alpine 自带 node 用户 uid=1000）
USER node

EXPOSE 5001

# Node 22 原生支持 TS 扩展名，无需编译
CMD ["node", "src/bootstrap.ts"]
