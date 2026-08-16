/**
 * dsh-qol 宿主半：在官方 rc.6 上补齐归档恢复 / 永久删除 / 日志导出。
 *
 * 官方 Web 的 `/api` 路由表没有 `workspace.unarchiveSession` /
 * `workspace.deleteSession`，而且 `/api` 拦截器只能挂一个。这里走独立通道
 * `/dsh-qol`，把请求转发给 `ops.ts` 里的纯逻辑（可单测）；webServer 路由
 * （工作区 ZIP 导出）由 `workspaceExport.ts` 注册。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import {
  deleteSession, exportJsonl, unarchiveSession,
  type AgentsLike, type ConnectionRpcLike, type PersistenceLike, type RpcResult,
  type SessionsLike, type WorkspaceRegistryLike,
} from './ops.ts'
import { registerWorkspaceExport } from './workspaceExport.ts'

/** Cordis 插件名（= 包名，loader 行的 name）。 */
export const name = 'dsh-qol'

/** 截获 RPC 前必须等 connection / workspace / persistence / webServer 就绪。 */
export const inject = ['connection', 'workspaceRegistry', 'sessionPersistence', 'webServer'] as const

/** 本插件接管的 workspace RPC 与日志导出。 */
const OWNED_METHODS = new Set([
  'workspace.unarchiveSession',
  'workspace.deleteSession',
  'session.exportJsonl',
])

/** 插件元信息：展示名「DSH 体验优化合集」。 */
export const meta = {
  id: 'dsh-qol',
  displayName: 'DSH 体验优化合集',
} as const

/** 从未知 payload 取出 sessionId。 */
function sessionIdOf(payload: unknown): SessionId | undefined {
  if (payload === null || typeof payload !== 'object') return undefined
  const value = (payload as { sessionId?: unknown }).sessionId
  return typeof value === 'string' && value.length > 0 ? value as SessionId : undefined
}

/**
 * 注册两个 workspace RPC。
 * @param ctx - 宿主上下文。
 */
export function apply(ctx: Context): void {
  const connection = ctx.get('connection') as ConnectionRpcLike | undefined
  if (connection === undefined) return

  ctx.effect(() => connection.rpc.handle(
    '/dsh-qol',
    async (endpoint, payload) => {
      if (!OWNED_METHODS.has(endpoint)) {
        return {
          ok: false,
          error: { code: 'not-found', message: `unknown method ${endpoint}`, details: {} },
        }
      }
      const sessionId = sessionIdOf(payload)
      if (sessionId === undefined) {
        return {
          ok: false,
          error: {
            code: 'bad-request',
            message: 'sessionId is required',
            details: {},
          },
        }
      }
      const registry = ctx.get('workspaceRegistry') as WorkspaceRegistryLike
      const persistence = ctx.get('sessionPersistence') as PersistenceLike
      if (endpoint === 'workspace.unarchiveSession') return unarchiveSession(registry, sessionId)
      if (endpoint === 'session.exportJsonl') return exportJsonl(persistence, sessionId)
      return deleteSession({
        registry,
        persistence,
        agents: ctx.get('agents') as AgentsLike | undefined,
        sessions: ctx.get('sessions') as SessionsLike | undefined,
        emit: ctx as { emit(event: string, ...args: unknown[]): unknown },
      }, sessionId)
    },
    { authority: 'loopback' },
  ), 'dsh-qol: workspace session rpc')

  // 工作区级导出：GET /dsh-qol/workspace.export?workspaceId=… → ZIP 流。
  registerWorkspaceExport(ctx)
}

// Re-export the RPC result type so consumers of the RPC channel share one shape.
export type { RpcResult } from './ops.ts'
