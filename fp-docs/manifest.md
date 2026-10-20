# cr-pilot FeaturePilot Manifest

**When To Read**: 进入本项目开发、评审、部署、归档、信息层维护时必读。它是信息层的唯一入口，优先级高于任何历史文档或缓存。

## Project Identity

- **Name**: cr-pilot
- **Description**: pi 驱动的 GitLab 代码评审服务。GitLab MR webhook 触发后，服务在后台拉取变更、按仓库自定义 prompt 分批评审、汇总成一份评论并回写到 MR。
- **Root Path**: `D:/01-code/cr-pilot`
- **Language/Stack**: TypeScript (Node 22+, ES modules)，pi SDK (`@earendil-works/pi-coding-agent`)，Express 5；前端为 Vue 3 + Vite 6 + Element Plus（`web/`）

## External Project Docs

| Path | Priority | Note |
|---|---|---|
| `README.md` | 1 | 部署、配置、架构、运行、仓库规则、企微推送、日志完整记录 |

## Artifacts

| Kind | Path | Status |
|---|---|---|
| changes | `fp-docs/changes/` | Active: `admin-console-inline-comments` |
| archive | `fp-docs/archive/` | `2026-10-06-review-webhook`、`2026-10-06-gitlab-integration` |
| history | `fp-docs/history/history.md` | 2 entries |

## Information Layer (v2 manifest-only default)

| File | Exists | Note |
|---|---|---|
| `fp-docs/manifest.md` | ✅ | This file |
| `fp-docs/settings/agent.md` | ✅ | 通用工作流策略；前后端细节分别维护 |
| `fp-docs/settings/frontend.md` | ✅ | Vue preset，仅适用于 `web/` |
| `fp-docs/settings/backend.md` | ✅ | Express / TypeScript，preset 为 none |
| `fp-docs/settings/prototype-style.md` | ✅ | 现有源码视觉基线；不代表已创建原型基座 |
| `fp-docs/intel/project-facts.md` | ❌ | 本轮不生成，用户选择保持轻量 |
| `fp-docs/intel/.freshness.json` | ❌ | 本轮不生成，未创建项目事实缓存 |
| `fp-docs/intel/unknowns.md` | ❌ | Human-owned, lazy |
| `fp-docs/intel/decisions.md` | ❌ | Human-owned, lazy |

## CodeGraph

| Item | Value |
|---|---|
| CLI Available | ✅ v1.6.2（2026-10-20 实测） |
| Project Graph | ✅ 已建图：93 files、1,577 nodes、3,959 edges；无待同步变化 |
| Manifest Code Map | `.codegraph/`；仅作候选导航，使用前实时校验 |
| MCP Configured | 本轮跳过；用户选择仅建图，未修改用户级配置 |

*CodeGraph 为可选导航层，失败不阻塞 init。*

## Frontend Applicability

- **Status**: 已确认 Web 前端，appRoot 为 `web/`
- **Detected Frameworks**: Vue `^3.5.13`、Vite `^6.0.7`、Element Plus `^2.9.1`（依赖声明范围）
- **Evidence**: `web/package.json`、`web/src/main.ts`、`web/vite.config.ts`
- **Prototype Base**: 本轮未创建；可选原型阶段因安装资源缺失停止，修复后可另行运行 `/fp-prototype-init`

## Initialization Log

- `2026-10-07`: Created manifest (first-time `fp-init` on pre-existing fp-docs without manifest)
- `fp-docs/history/`, `fp-docs/archive/`, `fp-docs/changes/` already present from prior work
- `2026-10-20`：仅为当前项目建立 CodeGraph，并按批准修正前端与代码图记录；历史变更状态未复核。
- `2026-10-20`：按逐项批准创建四个 settings；未生成 intel；原型阶段因插件校验脚本缺失停止，未创建基座。

## Next Steps

- `/fp-prd <idea>` — 梳理需求产出 PRD
- `/fp-start <slug or feature description>` — 从 PRD 或特性描述进入设计→计划→执行
- `/fp-init` — 补全 CodeGraph、Settings、Discovery（可选）