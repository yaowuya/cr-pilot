# cr-pilot FeaturePilot Manifest

**When To Read**: 进入本项目开发、评审、部署、归档、信息层维护时必读。它是信息层的唯一入口，优先级高于任何历史文档或缓存。

## Project Identity

- **Name**: cr-pilot
- **Description**: pi 驱动的 GitLab 代码评审服务。GitLab MR webhook 触发后，服务在后台拉取变更、按仓库自定义 prompt 分批评审、汇总成一份评论并回写到 MR。
- **Root Path**: `D:/01-code/cr-pilot`
- **Language/Stack**: TypeScript (Node 22+, ES modules)，pi SDK (`@earendil-works/pi-coding-agent`)，Express 5

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
| `fp-docs/settings/agent.md` | ❌ | Optional; will create on explicit approval |
| `fp-docs/settings/frontend.md` | ❌ | Optional; no frontend detected |
| `fp-docs/settings/backend.md` | ❌ | Optional; will offer after manifest |
| `fp-docs/settings/prototype-style.md` | ❌ | Optional; no frontend |
| `fp-docs/intel/project-facts.md` | ❌ | Optional; created on explicit discovery approval |
| `fp-docs/intel/.freshness.json` | ❌ | Metadata for generated facts only |
| `fp-docs/intel/unknowns.md` | ❌ | Human-owned, lazy |
| `fp-docs/intel/decisions.md` | ❌ | Human-owned, lazy |

## CodeGraph

| Item | Value |
|---|---|
| CLI Available | ✅ v1.6.0 |
| Project Graph | ✅ Built (32 files, 341 nodes, 1042 edges) |
| Manifest Code Map | ❌ Not created (needs explicit approval) |
| MCP Configured | ❌ Not configured |

*CodeGraph 为可选导航层，失败不阻塞 init。*

## Frontend Applicability

- **Status**: No frontend detected (pure backend Node.js service)
- **Detected Frameworks**: None
- **Prototype Base**: Not applicable

## Initialization Log

- `2026-10-07`: Created manifest (first-time `fp-init` on pre-existing fp-docs without manifest)
- `fp-docs/history/`, `fp-docs/archive/`, `fp-docs/changes/` already present from prior work

## Next Steps

- `/fp-prd <idea>` — 梳理需求产出 PRD
- `/fp-start <slug or feature description>` — 从 PRD 或特性描述进入设计→计划→执行
- `/fp-init` — 补全 CodeGraph、Settings、Discovery（可选）