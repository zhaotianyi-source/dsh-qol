# dsh-qol · DSH 体验优化合集

DeepSeek Harness 官方插件，把高频体验痛点的修补收进一个合集。插件 ID：
`dsh-qol`，展示名：**DSH 体验优化合集**。

## 能力

### 归档会话管理（V1）

DSH 的「归档」是单向的：`workspace.archiveSession` 把会话藏进
registry-global 归档集，从此任何列表面都看不到它——没有归档入口，没有
恢复，也没有删除，日志永久留在磁盘上。dsh-qol 补上这整条回路：

- **归档入口**：侧栏底部新增「归档」按钮（`sidebar.footer.action` 槽），
  点击打开归档会话面板。
- **归档列表**：面板按最近更新排序列出全部已归档会话（标题 / 所属工作区
  / 相对时间），数据来自框架全局钩子（`useSessions` + `useWorkspaces`），
  与主列表同源、实时联动。
- **打开**：直接跳转到该会话的对话视图（`sessions.open`）。
- **恢复（取消归档）**：`workspace.unarchiveSession`——归档从不触碰工作区
  记账槽，恢复后回到原位置。
- **删除**：`workspace.deleteSession`——两次点击确认（4 秒自动复位），
  永久删除：会话日志文件 + 工作区记账槽 + 归档集成员资格。运行中的会话
  会被宿主拒绝（`session-live`）。

## 前置条件：harness API 扩展（必须）

`unarchiveSession` / `deleteSession` 不在 rc.6 的 RPC 面里，本插件依赖
harness 侧的一处小补丁（纯增量，不改任何既有行为）：

1. `@deepseek-ai/dsh-workspace`：registry 新增 `unarchiveSession(sessionId)`
   与 `deleteSession(sessionId)`——只拒绝**正在运行**的会话
   （`agent.status === 'running'`）；删除前先经 `session/flush` 屏障排空
   闲置实例的挂起写，再摘除记账、清归档集、走 `sessionPersistence.delete`
   删日志。新增 `WorkspaceLiveSessionError`。
2. `@deepseek-ai/dsh-session-persistence`：`PersistenceCoordinator.forget(id)`
   清理删除会话的写状态 / 预读缓存 / 串行链，并摘除 live-but-idle 的写路径
   （删除后旧实例继续写会得到明确的 "session not found"，不会复活文件）；
   `SessionPersistence` 基类新增默认 `delete(id)`（无逐会话产物的后端抛不支持）。
3. `@deepseek-ai/dsh-session-persistence-jsonl`：实现 `delete(id)`——定位日志
   文件，删文件 + 删所属会话目录（含 `.corrupt-bak` 等恢复备份），再 forget。
4. `@deepseek-ai/dsh-host-apiproxy`：`workspace.unarchiveSession` /
   `workspace.deleteSession` 两个 RPC（请求/响应复用 `archiveSession` 的
   `{sessionId}` / `{archivedSessionIds}` 形状），宿主流新增
   `workspace/session-deleted` 监听 → 广播 `host/session-removed`（会话摘要
   移除帧；归档集与工作区帧由既有 `domain/changed` 通道自动广播）。
5. `@deepseek-ai/dsh-client-connection`：值 schema 表、`api.workspace`
   方法与 fixture 分发各加两项。
6. `@deepseek-ai/dsh-client-runtime`：`WorkspaceManager` 与 `WorkspaceRuntime`
   门面新增 `unarchiveSession` / `deleteSession`（成功即安装返回的归档集）。

补丁同时落在两处（内容一致）：

- **已打包运行时**：`<桌面应用>/resources/app/node_modules/@deepseek-ai/*`
  （宿主侧改完需重启桌面应用生效；浏览器侧在 Web 产物重建后生效）。
- **源码 checkout**：`deepseek-harness/packages/*`（重建
  `pnpm build:lib && pnpm build:web` 后同步 dist 到
  `@deepseek-ai/dsh-web-frontend/dist`）。

浏览器侧（connection/runtime/ui 包）编译进前端 bundle，因此仅改
node_modules 不会让浏览器生效——需要重建 Web 产物（见下）。

## 构建与安装

要求 Node `^22.19 || >=24`。

```bash
pnpm install
pnpm build          # tsc（宿主半 lib/index.js）+ tsdown（浏览器 bundle lib/client.js）
```

把插件加进 profile（官方流程，同 dsh-silly-tavern）：

```bash
dsh plugin --profile web add <本包绝对路径>
dsh web             # 重启 Web（DSH_HOME 决定数据目录）
```

`dsh-qol` 是一个 bundle：`dsh-client-modules` 只扫描 loader 入口的
`dsh.client` 声明，所以必须有一行让包进入 loader 图，浏览器 bundle
（`lib/client.js`）才会被注入 `__DSH_BOOT__` 并在 `/plugins/dsh-qol/client.js`
伺服。宿主半同时拦截官方 rc.6 没有的 `workspace.unarchiveSession` /
`workspace.deleteSession`。开发时可用 `pnpm run dev:web` 的 watcher 链
（宿主侧轮询 bundle 变更）免刷新热更。

## 开发

```bash
pnpm install
pnpm build          # 产出 lib/client.js
pnpm test           # vitest
```

- 浏览器半的 bundle 契约与官方 client 包一致（`window.__ModuleLoader__.load`
  闭包工厂 + 平台模块 external，见 `tsdown.config.ts`）。
- 新增 RPC 由 `src/client/rpc.ts` 以公开的信封协议直接调用（浏览器运行时
  的预构建 dist 没有这两个客户端方法，也不需要——宿主帧机制会同步状态）。

## 架构

```
src/
├── index.ts                 # 包入口（re-export 宿主半 + 类型）
├── host.ts                  # 宿主半：拦截 unarchive/deleteSession
├── cordis.patch.yml         # bundle patch：插入宿主插件行
└── client/
    ├── index.ts             # 浏览器半入口：字典注册 + sidebar.footer.action 注册
    ├── ArchivedPanel.tsx    # 归档按钮 + 模态面板（打开 / 恢复 / 删除）
    ├── ArchivedPanel.module.css
    ├── locales.ts           # zh / en 文案（qol 命名空间）
    ├── rpc.ts               # 公开信封协议直调宿主 RPC（unarchive/deleteSession）
    └── css-modules.d.ts
```

数据流：`useWorkspaces(archivedSessionIds)` + `useSessions(byId)` 交集合成
归档行；恢复/删除走 `rpc.ts` → 插件宿主拦截的 `workspace.*` RPC →
registry 改归档集 / 摘记账 →（删除时）删日志文件 → `domain/changed`
帧回推，所有列表面自动一致。

## 已知限制

- 删除只拒绝**正在运行**的会话（agent 的 turn 进行中，`session-live` /
  「the session is running」）；闲置会话（哪怕宿主还持有实例）可以直接删。
  删除不会拆除驻留的 agent 实例——删除后若继续向该会话发消息，会得到
  「session not found」错误，不会复活文件。
- 删除是物理删除（日志文件 + 目录），无回收站；面板内两次点击确认。
- 若 `sessionPersistence` 换成非 JSONL 后端，删除会得到
  「backend does not support session deletion」错误，恢复仍可用。
