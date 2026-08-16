/**
 * dsh-qol 浏览器半入口：把「归档会话」管理能力挂进 Web 侧栏。
 *
 * 注册位置：`sidebar.footer.action`（list 槽，侧栏底部动作区）。按钮打开
 * 归档会话面板（列出、恢复、删除）。数据走框架全局钩子
 * （useSessions / useWorkspaces）；操作走宿主 RPC 直调
 * （`workspace.unarchiveSession` / `workspace.deleteSession`）。
 * UI 状态同步由宿主帧机制自动完成（archived-sessions-changed /
 * session-removed / workspace-changed）。
 */
import type { ClientContext, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: 拉入 locale 与 sidebar 的 Context/SlotMap 合并，使 slots 注入
// 与 LocaleNamespaceMap 声明在编译期可见。
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { ArchivedPanel, type ArchivedPanelInjected } from './ArchivedPanel.tsx'
import { en, zh, type QolKey } from './locales.ts'
import { callRpc } from './rpc.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** dsh-qol 文案命名空间。 */
    qol: QolKey
  }
}

/** 本插件拥有的字典命名空间。 */
const NS = 'qol'

/** workspace.* RPC 的返回值（与本补丁的宿主实现一致：完整归档集）。 */
interface ArchivedSetValue {
  archivedSessionIds: SessionId[]
}

/**
 * 必需服务（cordis fiber inject）。目标槽由 ui-sidebar 声明，激活顺序不
 * 受 dsh.client.inject 边约束，因此 apply 通过 `slots.inject()` 等待槽声明。
 */
export const inject = ['slots', 'sessions', 'workspaces', 'locale']

/**
 * 注册归档入口：字典 + 侧栏底部动作。
 * @param ctx - 客户端根上下文。
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-qol: dictionaries')

  const injected = (): ArchivedPanelInjected => ({
    unarchiveSession: async (sessionId) => {
      await callRpc<ArchivedSetValue>('workspace.unarchiveSession', { sessionId })
    },
    deleteSession: async (sessionId) => {
      await callRpc<ArchivedSetValue>('workspace.deleteSession', { sessionId })
    },
  })

  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register(
    {
      name: 'sidebar.footer.action',
      id: 'dsh-qol.archived',
      order: 10,
      label: '归档',
      inject: injected,
      locale: NS,
      registrant: 'dsh-qol',
    },
    ArchivedPanel,
  ))
}
