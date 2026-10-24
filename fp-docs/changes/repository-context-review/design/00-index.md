# 仓库上下文评审 Design Index

## Canonical End Entrypoints

| End | Canonical entrypoint | Mode |
| --- | --- | --- |
| Backend | [design/backend.md](<fp-docs/changes/repository-context-review/design/backend.md>) | small |
| Frontend | [design/frontend.md](<fp-docs/changes/repository-context-review/design/frontend.md>) | small |

## Ownership

- 后端入口拥有数据模型、API、安全、生命周期、迁移与后端验证，以及 D-002～D-012、D-015～D-017。
- 前端入口拥有 Visual Source、UI 组件树与 Figma 解析映射、Visual Checks 与前端验证，以及 D-001、D-013、D-014。
- 全局 D-001～D-017 唯一；跨端接口契约与 form 决策只在后端入口详细定义。
