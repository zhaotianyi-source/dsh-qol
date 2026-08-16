# dsh-qol

> DSH 体验优化合集：归档管理、对话导出、工作区导出。
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

### 对话导出（JSONL）

会话行 `···` 菜单（「分叉」与「归档」之间）新增「导出对话」：把该会话的
原始日志导出为明文 JSONL（`session.jsonl.zstd` 解码后的存储原文，
逐字节对应磁盘产物），经浏览器保存对话框下载为
`dsh-session-<id>.jsonl`。

### 工作区导出（ZIP）

工作区行 `···` 菜单新增「导出工作区对话」：把该工作区下所有会话的明文
JSONL 打包为一个 ZIP（每个会话一个 `<sessionId>/session.jsonl` 条目，
与官方 `session.export` 的目录布局一致），经浏览器保存对话框下载为
`dsh-workspace-<workspaceId>.zip`。

## 架构

```
src/
├── index.ts                    # 包入口（re-export 宿主半）
├── host.ts                     # 宿主半：/dsh-qol RPC（恢复/删除/导出）
├── workspaceExport.ts          # 宿主半：工作区 ZIP 打包（webServer 路由）
├── cordis.patch.yml            # bundle patch：插入宿主插件行
└── client/
    ├── index.ts                # 浏览器半入口：字典 + 事件监听 + 侧栏注册
    ├── ArchivedPanel.tsx       # 归档面板（恢复 / 删除）
    ├── ArchivedPanel.module.css
    ├── exportSession.tsx       # 导出监听（会话 JSONL / 工作区 ZIP）
    ├── locales.ts              # zh / en 文案（qol 命名空间）
    ├── rpc.ts                  # 信封协议直调宿主 RPC
    └── css-modules.d.ts
```

### 宿主半

`host.ts` 通过 `/dsh-qol` RPC 通道接管官方 rc.6 缺失的能力：
`workspace.unarchiveSession`、`workspace.deleteSession`、
`session.exportJsonl`。删除走完整链路：拒绝运行中会话 → flush →
移除帧先广播（`host/session-removed`）→ 清归档集 → 摘记账 →
删日志文件，保证浏览器侧不会短暂看到残留条目。

`workspaceExport.ts` 注册 `GET /dsh-qol/workspace.export?workspaceId=…`
路由，用 fflate 流式打包 ZIP：逐个会话 `readRaw`（zstd 解码后的明文），
同一时刻只持有一个会话的文本，内存占用有界。

### 浏览器半

`client/` 通过 `sidebar.footer.action` 槽注册归档面板；导出菜单项由官方
补丁派发自定义事件（`dsh-qol:export-session` / `dsh-qol:export-workspace`），
浏览器半监听后经 RPC 或导航执行下载，失败以 Toast 反馈。

## 运行时补丁

dsh-qol 不修改官方 API 包，只对官方 UI bundle 做两处最小增量补丁
（无 slot 扩展点，纯插入，不改既有行为）：

| 位置 | 补丁内容 |
| --- | --- |
| `dsh-client-ui-workspace` | 会话行菜单插入「导出对话」（分叉与归档之间）；工作区行菜单插入「导出工作区对话」；点击派发对应自定义事件 |
| `dsh-host-apiproxy` | 宿主流新增 `workspace/session-deleted` 监听 → 广播 `host/session-removed`（会话摘要移除帧） |

补丁同时落在两处（内容一致）：

- **已打包运行时**：`<桌面应用>/resources/app/node_modules/@deepseek-ai/*`
  （改完重启桌面应用生效；`dsh-client-ui-workspace` 的浏览器 bundle 由
  `dsh-client-modules` 直接 serve `lib/client.js`，改完重启 DSH 即生效，
  无需重建 Web 产物）。
- **源码 checkout**：`deepseek-harness/packages/*`（`Rows.tsx`、
  `locales.ts`、`api-proxy.ts`）同步修改保持一致。

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
- 导出菜单项补丁与 harness 源码保持同步（见上）。

## 已知限制

- 删除为物理删除（日志文件 + 目录），无回收站；面板内两步确认防误删。
- 删除只拒绝**正在运行**的会话；闲置会话可直接删除。删除后若继续向
  该会话发送消息，会得到「session not found」错误，不会复活文件。
- 若 `sessionPersistence` 换为非 JSONL 后端，删除会得到
  「backend does not support session deletion」错误，恢复与导出仍可用。
- 导出经浏览器保存对话框下载：JS 无法感知下载完成，因此没有成功提示；
  仅失败时 Toast 报错。
