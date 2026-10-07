# 项目变更历史

## 2026-10-06: review-webhook

**目标：** `cr-pilot` 除 README 外为空仓库，需要一个能按自定义 prompt 调用 pi 产出评审意见的最小服务。参考项目 AI-CodeReview 自带多平台 webhook 解析、LLM 客户端工厂、通知渠道与 Dashboard，对最小可用版本过重；pi 已提供 agent 运行时，评审因此可收敛为「读 prompt、拼代码、调 pi、取文本」。

**变更点：**
- 新建 Node.js 22 + TypeScript 服务骨架，含 npm 项目、类型检查配置、忽略规则与 start / test / typecheck 三条脚本。
- 新增 `POST /review/webhook` 接口：同时兼容 GitLab 原始 payload（提取 merge_request 与 push 元数据作上下文）与请求体直接传代码，同步返回 `{review, model, duration_ms}`。
- 自定义 prompt 从单个 Markdown 文件 `prompts/review.md` 读取，整体作为 pi 的 system prompt，路径可用环境变量覆盖。
- 新增 pi 适配层：进程内嵌入 `@earendil-works/pi-coding-agent`，每个请求一个内存会话，用隔离工作目录、三个 `no*` 开关与双 system prompt 覆盖，把评审上下文限制为 prompt 文件与请求里的代码。
- 接口不做鉴权，服务默认只监听 `127.0.0.1`。

**结构冲突：** None

**归档路径：** `fp-docs/archive/2026-10-06-review-webhook/`

## 2026-10-06: gitlab-integration

**目标：** 接入 GitLab MR webhook，替代旧「纯代码同步接口」，实现后台串行队列分批评审并回写 MR 评论。

**变更点：**
- 端口默认 5001，`POST /review/webhook` 仅接受 GitLab `merge_request` 事件
- `X-Gitlab-Token` 校验、旧纯代码接口停止支持（返回 400/401）
- GitLab 客户端：拉取 changes/commits、回写 MR note、TLS 开关、重试
- 内存串行队列：全局 Promise 链，单批失败整任务结束
- 仓库级 YAML 规则 + 三级兜底（仓库 > default > md）
- 分批评审：字符/4 估算 + 85% 阈值，每批独立 pi 会话，逐批评审 → 汇总 → 回写 MR 评论
- 新增唯一运行时依赖 `yaml@^2.9.1`；删死代码 `gitlab.ts`/`prompt.ts`/对应测试
- README 重写：配置、webhook 配置、规则目录、企微推送、日志全记录

**结构冲突：** None

**归档路径：** `fp-docs/archive/2026-10-06-gitlab-integration/`
