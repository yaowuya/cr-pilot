#!/bin/sh
#
# 容器入口：修正数据/日志目录属主后，降权到 node 用户运行应用。
#
# 为什么需要这一步：
# 容器以 node(uid 1000) 运行，但两个挂载点的属主都不受镜像控制：
#   - /app/data：具名卷，首次挂载时 Docker 把**卷根目录属主设为 root**
#     （镜像里 chown 的设置不生效）→ 建 SQLite 库时报 "unable to open database file"
#   - /app/logs：宿主机 bind mount /data/logs/cr-pilot，目录不存在时由 Docker
#     以 root 创建 → 写日志时报 permission denied
#
# 每次都 chown 而不只在首次执行：目录通常为空或只有几个文件，开销可忽略；
# 这样不依赖卷/目录的初始化时机，也兼容已有历史文件属主是 root 的情况。
set -e

# 只在以 root 启动时修属主并降权。
# 若用户通过 compose 的 `user:` 指定了非 root（uid != 0），说明他自行接管了
# 权限管理：此时 chown 必然失败、su-exec 也降不了权，直接 exec 原命令。
if [ "$(id -u)" = "0" ]; then
  for dir in /app/data /app/logs; do
    if [ -d "$dir" ]; then
      # 递归修正：目录里可能已有历史文件（旧库、旧日志），属主同样是 root。
      # 失败不阻断启动（例如只读挂载）：让应用自己报出更具体的错误。
      chown -R node:node "$dir" 2>/dev/null || true
    fi
  done
  exec su-exec node "$@"
fi

exec "$@"
