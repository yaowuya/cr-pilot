#!/bin/sh
#
# 容器入口：修正数据/日志卷属主后，降权到 node 用户运行应用。
#
# 为什么需要这一步：
# 具名卷（docker-compose 的 cr-pilot-data / cr-pilot-logs）首次挂载到镜像内
# 已存在的目录时，Docker 只复制目录内容，**卷根目录属主会被设为 root**。
# 镜像里 chown 成 node 的设置因此不生效，容器内 uid 1000 无法：
#   - 在 /app/data 创建 SQLite 库 → 报 "unable to open database file"
#   - 往 /app/logs 写日志        → 报 permission denied
#
# 每次都 chown 而不只在首次执行：目录通常为空或只有几个文件，开销可忽略；
# 这样不依赖卷的初始化时机，也兼容用户手工替换卷内容后重启的场景。
set -e

# 只在以 root 启动时修属主并降权。
# 若用户通过 compose 的 `user:` 指定了非 root（uid != 0），说明他自行接管了
# 权限管理：此时 chown 必然失败、su-exec 也降不了权，直接 exec 原命令。
if [ "$(id -u)" = "0" ]; then
  for dir in /app/data /app/logs; do
    if [ -d "$dir" ]; then
      # 递归修正：卷里可能已有历史文件（旧库、旧日志），属主同样是 root。
      # 失败不阻断启动（例如只读挂载）：让应用自己报出更具体的错误。
      chown -R node:node "$dir" 2>/dev/null || true
    fi
  done
  exec su-exec node "$@"
fi

exec "$@"
