/**
 * dsh-qol 宿主半核心操作：恢复 / 删除 / 导出的纯逻辑。
 *
 * 所有函数只依赖显式传入的服务对象（workspace registry / session
 * persistence / sessions store / agents / 事件总线），不接触 cordis
 * Context——因此可以直接用假对象做单元测试。`host.ts` 的 `apply` 只负责
 * 从 ctx 解析这些服务并转发 RPC。
 */
import { rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { SessionId } from '@deepseek-ai/dsh-session'

/** RPC 业务错误形状（与官方 server-response 的 error 段一致）。 */
export interface RpcError {
  code: string
  message: string
  details: Record<string, unknown>
}

/** RPC 成功/失败结果。 */
export type RpcResult<T> = { ok: true; value: T } | { ok: false; error: RpcError }

/** 官方 workspaceRegistry 上我们会用到的面。 */
export interface WorkspaceLike {
  sessionIds: readonly SessionId[]
  detachSession(sessionId: SessionId): Promise<void>
}

export interface WorkspaceRegistryLike {
  archivedSessionIds: readonly SessionId[]
  list(): readonly WorkspaceLike[]
}

/** JSONL persistence 的读 / 删 / 定位面。 */
export interface PersistenceLike {
  list(): Promise<readonly { id: SessionId; cwd?: string }[]>
  locate(meta: { id: SessionId; cwd?: string }): { path: string } | undefined
  delete?(sessionId: SessionId): Promise<boolean>
  /** 读会话原始产物（JSONL 后端返回 zstd 解码后的明文）。 */
  readRaw?(sessionId: SessionId, signal?: AbortSignal): Promise<{ filename: string; content: string } | undefined>
}

/** SessionStore 上我们会用到的面。 */
export interface SessionsLike {
  get(sessionId: SessionId): unknown
  flush?(session: unknown): Promise<void>
  /** SessionStore 内部 store（entry.detach 触发 session/disposed → host/session-removed）。 */
  store?: Map<SessionId, { detach: () => void }>
}

/** agents 服务上我们会用到的面（只读 running 状态）。 */
export interface AgentsLike {
  get(sessionId: SessionId): { status?: string } | undefined
}

/** cordis 事件总线（emit workspace/session-deleted 让官方帧链路广播 host/session-removed）。 */
export interface EventBusLike {
  emit(event: string, ...args: unknown[]): unknown
}

/** connection 服务的 RPC 注册面（rpc.handle 是官方公开 API）。 */
export interface ConnectionRpcLike {
  rpc: {
    handle(
      channel: string,
      handler: (endpoint: string, payload: unknown, signal: AbortSignal) => Promise<RpcResult<unknown>>,
      options: { authority: 'loopback' },
    ): () => Promise<void>
  }
}

/** deleteSession 需要的全部服务。 */
export interface DeleteDeps {
  registry: WorkspaceRegistryLike
  persistence: PersistenceLike
  agents?: AgentsLike | undefined
  sessions?: SessionsLike | undefined
  emit?: EventBusLike | undefined
}

/** 当前归档集快照。 */
export function archivedSet(registry: WorkspaceRegistryLike): { archivedSessionIds: SessionId[] } {
  return { archivedSessionIds: [...registry.archivedSessionIds] }
}

/** 恢复：从归档集拿掉该会话（官方 archiveSession 是幂等追加，这里直接改 state）。 */
export async function unarchiveSession(
  registry: WorkspaceRegistryLike,
  sessionId: SessionId,
): Promise<RpcResult<{ archivedSessionIds: SessionId[] }>> {
  if (!registry.archivedSessionIds.includes(sessionId)) {
    return { ok: true, value: archivedSet(registry) }
  }
  const keep = registry.archivedSessionIds.filter(id => id !== sessionId)
  await writeArchiveSet(registry, keep)
  return { ok: true, value: archivedSet(registry) }
}

/**
 * 永久删除：拒运行中会话，摘记账，清归档，删日志。
 *
 * 移除帧必须最先广播：浏览器收到 host/session-removed 后先删摘要，之后的
 * 归档 / 记账帧只改集合与记账槽，不会把已移除的会话渲染回侧栏。若反过来
 * （先清归档集再摘记账），浏览器会短暂看到「归档已解除 + 记账仍在」的
 * 中间态——会话闪现回原工作区，下一帧才消失。
 */
export async function deleteSession(
  deps: DeleteDeps,
  sessionId: SessionId,
): Promise<RpcResult<{ archivedSessionIds: SessionId[] }>> {
  const { registry, persistence, agents, sessions, emit } = deps

  if (agents?.get(sessionId)?.status === 'running') {
    return {
      ok: false,
      error: {
        code: 'session-live',
        message: `cannot delete session '${sessionId}': the session is running`,
        details: { sessionId },
      },
    }
  }

  const known = await sessionKnown({ sessions, persistence }, sessionId)
  if (!known) {
    return {
      ok: false,
      error: {
        code: 'session-not-found',
        message: `cannot delete session '${sessionId}': live sessions and session persistence hold no such session`,
        details: { sessionId },
      },
    }
  }

  const live = sessions?.get(sessionId)
  if (live !== undefined && sessions?.flush !== undefined) await sessions.flush(live)

  try {
    const entry = sessions?.store?.get(sessionId)
    if (entry !== undefined) entry.detach()
  } catch {
    // 忽略摘除失败
  }
  try {
    emit?.emit('workspace/session-deleted', sessionId)
  } catch {
    // 忽略广播失败
  }

  const keep = registry.archivedSessionIds.filter(id => id !== sessionId)
  if (keep.length !== registry.archivedSessionIds.length) await writeArchiveSet(registry, keep)

  for (const workspace of registry.list()) {
    if (workspace.sessionIds.includes(sessionId)) await workspace.detachSession(sessionId)
  }

  await deletePersisted(persistence, sessionId)
  return { ok: true, value: archivedSet(registry) }
}

/** 导出会话原始日志（JSONL 明文）。 */
export async function exportJsonl(
  persistence: PersistenceLike,
  sessionId: SessionId,
): Promise<RpcResult<{ filename: string; content: string }>> {
  if (typeof persistence.readRaw !== 'function') {
    return {
      ok: false,
      error: {
        code: 'export-unsupported',
        message: 'this session persistence backend does not expose raw artifacts',
        details: { sessionId },
      },
    }
  }
  const artifact = await persistence.readRaw(sessionId)
  if (artifact === undefined) {
    return {
      ok: false,
      error: {
        code: 'session-not-found',
        message: `cannot export session '${sessionId}': no stored session log`,
        details: { sessionId },
      },
    }
  }
  return { ok: true, value: { filename: artifact.filename, content: artifact.content } }
}

/** 会话是否 live / 已持久化。 */
export async function sessionKnown(
  deps: { sessions?: SessionsLike | undefined; persistence: PersistenceLike },
  sessionId: SessionId,
): Promise<boolean> {
  if (deps.sessions?.get(sessionId) !== undefined) return true
  const headers = await deps.persistence.list()
  return headers.some(header => header.id === sessionId)
}

/**
 * 官方 rc.6 的 archiveSession 只能追加。恢复 / 删除需要写入任意归档集，
 * 这里复用 registry 的私有 setState 链（enqueueOperation + global.set）。
 */
export async function writeArchiveSet(
  registry: WorkspaceRegistryLike,
  archivedSessionIds: readonly SessionId[],
): Promise<void> {
  const writable = registry as unknown as {
    enqueueOperation?: (op: () => Promise<void>) => Promise<void>
    requireState?: () => { archivedSessionIds: readonly SessionId[] }
    setState?: (state: { archivedSessionIds: readonly SessionId[] } & Record<string, unknown>) => Promise<void>
  }
  if (writable.enqueueOperation === undefined || writable.requireState === undefined || writable.setState === undefined) {
    throw new Error('workspace registry does not expose archive-set mutation')
  }
  await writable.enqueueOperation(async () => {
    const state = writable.requireState!()
    await writable.setState!({ ...state, archivedSessionIds: [...archivedSessionIds] })
  })
}

/** 删持久化日志：优先走后端 delete；rc.6 JSONL 没有该方法时，按 locate + rm 兜底。 */
export async function deletePersisted(persistence: PersistenceLike, sessionId: SessionId): Promise<void> {
  if (typeof persistence.delete === 'function') {
    await persistence.delete(sessionId)
    return
  }
  const headers = await persistence.list()
  const header = headers.find(item => item.id === sessionId)
  if (header === undefined) return
  const location = persistence.locate(header)
  if (location?.path === undefined) {
    throw new Error('this session persistence backend does not support session deletion')
  }
  await rm(location.path, { force: true })
  await rm(dirname(location.path), { recursive: true, force: true })
}
