# dsh-qol

> DSH 体验优化合集：归档会话管理。
> 基于 DeepSeek Harness 官方 Web 客户端构建，插件 ID `dsh-qol`。

[English](README.en.md)

## 功能

### 归档会话管理

DSH 的「归档」是单向操作：归档后的会话会从所有列表面消失，但官方
没有提供归档入口、恢复或删除，日志会永久留在磁盘上。dsh-qol 补全
这条回路：

- **归档入口**：侧栏底部「归档」按钮（`sidebar.footer.action` 槽），
  点击打开归档面板，按最近更新列出全部已归档会话。
- **恢复**：一键恢复，会话回到原工作区位置（归档不触碰记账槽）。
- **删除**：两步确认（点「删除」→「确定」），永久删除会话日志文件、
  工作区记账槽与归档集成员资格；运行中的会话会被拒绝（`session-live`）。
  删除完成后立即从所有列表消失，且不会留下残留条目。

## 架构

```
src/
├── index.ts                    # 包入口（re-export 宿主半）
├── host.ts                     # 宿主半：/dsh-qol RPC（恢复/删除）
├── ops.ts                      # 宿主半核心逻辑（纯函数，可单测）
├── cordis.patch.yml            # bundle patch：插入宿主插件行
└── client/
    ├── index.ts                # 浏览器半入口：字典 + 侧栏注册
    ├── ArchivedPanel.tsx       # 归档面板（恢复 / 删除）
    ├── ArchivedPanel.module.css
    ├── locales.ts              # zh / en 文案（qol 命名空间）
    ├── rpc.ts                  # 信封协议直调宿主 RPC
    └── css-modules.d.ts
```

### 宿主半

`host.ts` 通过 `/dsh-qol` RPC 通道接管官方 rc.6 缺失的能力：
`workspace.unarchiveSession`、`workspace.deleteSession`。核心逻辑在
`ops.ts`，以服务对象为参数的纯函数（可单测）；删除走完整链路：
拒绝运行中会话 → flush → 移除帧先广播（`host/session-removed`）→
清归档集 → 摘记账 → 删日志文件，保证浏览器侧不会短暂看到残留条目。

### 浏览器半

`client/` 通过 `sidebar.footer.action` 槽注册归档面板。数据走框架全局
钩子（`useSessions` / `useWorkspaces`），操作走宿主 RPC 直调
（`workspace.unarchiveSession` / `workspace.deleteSession`）；UI 状态
同步由宿主帧机制自动完成。

## 运行时补丁

dsh-qol 不修改官方 API 包，只对官方 host 包做一处最小增量补丁
（纯增量，不改既有行为）：

| 位置 | 补丁内容 |
| --- | --- |
| `dsh-host-apiproxy` | 宿主流新增 `workspace/session-deleted` 监听 → 广播 `host/session-removed`（会话摘要移除帧） |

补丁同时落在两处（内容一致）：

- **已打包运行时**：`<桌面应用>/resources/app/node_modules/@deepseek-ai/*`
  （改完重启桌面应用生效）。
- **源码 checkout**：`deepseek-harness/packages/*`（`api-proxy.ts`）
  同步修改保持一致。

## 安装与构建

要求 Node `^22.19 || >=24`。

```bash
pnpm install
pnpm build          # tsc（宿主半 lib/index.js）+ tsdown（浏览器 bundle lib/client.js）
```

加入 Web profile（官方流程）：

```bash
dsh plugin --profile web add <本包绝对路径>
dsh web             # 重启 Web（DSH_HOME 决定数据目录）
```

## 开发

```bash
pnpm install
pnpm build          # 产出 lib/client.js
pnpm test           # vitest
```

- 浏览器半遵循官方 client bundle 契约（`window.__ModuleLoader__.load`
  闭包工厂 + 平台模块 external，见 `tsdown.config.ts`）。
- 新增 RPC 经 `src/client/rpc.ts` 以公开信封协议直调（浏览器运行时无需
  对应客户端方法，宿主帧机制负责状态同步）。

## 测试

```bash
pnpm test           # vitest（node 环境 + 组件 spec 的 jsdom pragma）
```

- `test/ops.test.ts`：宿主半纯逻辑（恢复 / 删除），假服务对象驱动，
  覆盖运行中拒绝、未知会话、帧顺序（移除帧先于归档 / 记账）、后端删兜底。
- `test/archived-panel.test.tsx`：组件 spec（jsdom + @testing-library/react），
  props 直喂断言可见行为：按钮、空态、列表、恢复、两步删除、错误横幅。
- `test/rpc.test.ts`：信封协议形状、业务错误、HTTP 404 映射、传输失败。
- `test/locales.test.ts`：zh / en 字典键对等。

组件 spec 需要 react 18（与官方 rc.6 包的 peer 一致）；测试专用 devDeps
不影响运行时——react 在浏览器侧是平台模块，由 loader 表提供。

## 已知限制

- 删除为物理删除（日志文件 + 目录），无回收站；面板内两步确认防误删。
- 删除只拒绝**正在运行**的会话；闲置会话可直接删除。删除后若继续向
  该会话发送消息，会得到「session not found」错误，不会复活文件。
- 若 `sessionPersistence` 换为非 JSONL 后端，删除会得到
  「backend does not support session deletion」错误，恢复仍可用。

## Model Experience

本插件是纯 UI / 宿主编排插件，不向模型上下文注入任何内容。

### Request context and condition

不适用：无系统提示词贡献，无请求上下文改写。

#### What the model sees

无变化。

#### Token effect

零直接 token 影响。

#### KV Cache effect

不适用：不生成或改写任何前缀。

## Known Limitations and Deferred Work

见上方「已知限制」。
