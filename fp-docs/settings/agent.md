# FeaturePilot Agent Settings

## Purpose

为 cr-pilot 提供轻量工作流入口；只保留跨领域策略，技术细节按任务读取对应域设置。当前源码与配置用于核实事实，已批准需求用于确认目标行为。

## Authoritative Project Docs

- 进入工作流先读 [主索引](<fp-docs/manifest.md>)，仅沿当前阶段需要的指针继续读取。
- 运行、部署和配置说明见 [README](<README.md>)；命令以当前 [根包配置](<package.json>) 和 [前端包配置](<web/package.json>) 为准。
- 本轮未发现项目级 CLAUDE / AGENTS / GEMINI / Cursor 指令文档；后续新增时由 fp-init 按独立批准登记引用。

## Workflow Preferences

- Branching: Unknown；沿当前用户确认的目标分支操作，不从历史分支名称推定全局策略。
- Commit style: Unknown；提交与推送分别以当前明确授权为界，具体文件暂存并核对提交快照。
- Review expectations: 对照已批准需求检查完整相关 diff，区分规范符合性、功能缺陷和未验证项；只处理本次新增或触发的问题。

## General Allowed / Forbidden Areas

- Allowed: 当前需求批准的源码、测试、配置和所属阶段产物；保留用户已有修改。
- Forbidden: 凭据、真实运行数据及无关历史变更不作为默认上下文；跨越原批准范围前先确认。
- 信息层维护由 fp-init 负责；原型基座和变更产物分别服从其所属工作流，避免多处维护同一事实。

## General Validation Expectations

- 根据改动范围选择现有验证入口，区分静态检查、单测、构建、浏览器与真实环境结果；未执行项说明原因。
- 验证外部边界时使用隔离环境和合成数据；真实消息、业务写入、安装依赖、迁移及服务启动均核对本次授权。
- 初始化或纯文档更新不自动授权测试、构建、部署或 Git 发布操作。

## General Security / Data Notes

- 只记录配置名称和契约，不复制真实密钥、token、数据库内容或敏感日志；提交前检查实际暂存文件。
- 认证、数据、实例隔离和运维细则见 [后端设置](<fp-docs/settings/backend.md>)；UI 权限展示与交互细则见 [前端设置](<fp-docs/settings/frontend.md>)。

## Related Domain Settings

- 前端、UI 与视觉：[frontend.md](<fp-docs/settings/frontend.md>)。
- 后端、API、数据与安全：[backend.md](<fp-docs/settings/backend.md>)。
- 明确选择生成或更新原型时：[prototype-style.md](<fp-docs/settings/prototype-style.md>)。基座创建仍须独立批准。

## Unknowns

- 团队强制分支命名、提交消息格式、发布审批和 CI 必过门禁：Unknown；实施相关流程前向用户确认。
