/**
 * 宿主半核心操作单元测试：恢复 / 删除 / 导出的纯逻辑（ops.ts）。
 *
 * 通过假服务对象驱动，不启动 cordis 运行时；删除的帧顺序用调用记录断言。
 *
 * @module dsh-qol/test/ops
 */

import { describe, expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session'
import {
  deletePersisted, deleteSession, exportJsonl, unarchiveSession,
  type PersistenceLike, type SessionsLike, type WorkspaceLike, type WorkspaceRegistryLike,
} from '../src/ops.ts'

const sid = (id: string): SessionId => id as SessionId

/** 一个可写的假 workspace registry（模拟官方 enqueueOperation/setState 链）。 */
function registryOf(initial: readonly SessionId[]): WorkspaceRegistryLike & {
  archivedSessionIds: SessionId[]
  workspace: WorkspaceLike & { detachSession: ReturnType<typeof vi.fn> }
} {
  const archivedSessionIds = [...initial]
  const detachSession = vi.fn(async () => {})
  const workspace: WorkspaceLike & { detachSession: typeof detachSession } = {
    sessionIds: [] as SessionId[],
    detachSession,
  }
  const registry = {
    archivedSessionIds,
    list: () => [workspace] as readonly WorkspaceLike[],
    workspace,
    // writeArchiveSet 走私有链：测试里直接改内存数组。
    enqueueOperation: vi.fn(async (op: () => Promise<void>) => { await op() }),
    requireState: () => ({ archivedSessionIds }),
    setState: vi.fn(async (state: { archivedSessionIds: SessionId[] }) => {
      archivedSessionIds.splice(0, archivedSessionIds.length, ...state.archivedSessionIds)
    }),
  }
  return registry as unknown as ReturnType<typeof registryOf>
}

/** 假 persistence：list / locate / delete / readRaw。 */
function persistenceOf(): PersistenceLike & {
  headers: Array<{ id: SessionId; cwd?: string }>
  paths: Map<SessionId, string>
  delete: ReturnType<typeof vi.fn>
  readRaw: ReturnType<typeof vi.fn>
} {
  const headers: Array<{ id: SessionId; cwd?: string }> = []
  const paths = new Map<SessionId, string>()
  return {
    headers,
    paths,
    list: vi.fn(async () => [...headers]),
    locate: (meta) => {
      const path = paths.get(meta.id)
      return path === undefined ? undefined : { path }
    },
    delete: vi.fn(async () => true),
    readRaw: vi.fn(async () => undefined),
  }
}

/** 假 sessions store：live map + flush + detach 记录。 */
function sessionsOf(): SessionsLike & {
  live: Map<SessionId, unknown>
  detached: SessionId[]
  flush: ReturnType<typeof vi.fn>
} {
  const live = new Map<SessionId, unknown>()
  const detached: SessionId[] = []
  return {
    live,
    detached,
    get: (id) => live.get(id),
    flush: vi.fn(async () => {}),
    store: {
      get: (id) => {
        if (!live.has(id)) return undefined
        return { detach: () => { detached.push(id) } }
      },
    } as SessionsLike['store'],
  }
}

describe('unarchiveSession', () => {
  it('removes the session from the archive set when present', async () => {
    const registry = registryOf([sid('a'), sid('b')])
    const result = await unarchiveSession(registry, sid('a'))
    expect(result).toEqual({ ok: true, value: { archivedSessionIds: [sid('b')] } })
    expect(registry.archivedSessionIds).toEqual([sid('b')])
  })

  it('is a no-op when the session is not archived', async () => {
    const registry = registryOf([sid('a')])
    const result = await unarchiveSession(registry, sid('zzz'))
    expect(result).toEqual({ ok: true, value: { archivedSessionIds: [sid('a')] } })
    expect(registry.archivedSessionIds).toEqual([sid('a')])
  })
})

describe('deleteSession', () => {
  it('rejects a running session', async () => {
    const registry = registryOf([])
    const result = await deleteSession({
      registry,
      persistence: persistenceOf(),
      agents: { get: () => ({ status: 'running' }) },
    }, sid('a'))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('session-live')
  })

  it('rejects an unknown session', async () => {
    const registry = registryOf([])
    const result = await deleteSession({ registry, persistence: persistenceOf() }, sid('a'))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('session-not-found')
  })

  it('detaches the live entry and emits the removal frame BEFORE archive/accounting writes', async () => {
    const registry = registryOf([sid('a')])
    const persistence = persistenceOf()
    persistence.headers.push({ id: sid('a') })
    persistence.paths.set(sid('a'), '/tmp/a/session.jsonl.zstd')
    const sessions = sessionsOf()
    sessions.live.set(sid('a'), { marker: 'live' })
    const events: string[] = []
    const emit = { emit: (name: string) => { events.push(name) } }

    const result = await deleteSession({ registry, persistence, sessions, emit }, sid('a'))

    expect(result).toEqual({ ok: true, value: { archivedSessionIds: [] } })
    // 帧顺序：先移除帧（detach + emit），再动归档集 / 记账。
    expect(sessions.detached).toEqual([sid('a')])
    expect(events).toEqual(['workspace/session-deleted'])
    expect(persistence.delete).toHaveBeenCalledWith(sid('a'))
    expect(registry.archivedSessionIds).toEqual([])
  })

  it('detaches the live entry before accounting removal (frame-first ordering)', async () => {
    const registry = registryOf([sid('a')])
    const persistence = persistenceOf()
    persistence.headers.push({ id: sid('a') })
    persistence.paths.set(sid('a'), '/tmp/a/session.jsonl.zstd')
    const sessions = sessionsOf()
    sessions.live.set(sid('a'), { marker: 'live' })
    const order: string[] = []
    const detachOriginal = sessions.store!.get.bind(sessions.store)
    sessions.store!.get = (id) => {
      const entry = detachOriginal(id)
      if (entry === undefined) return undefined
      return {
        detach: () => {
          order.push('detach')
          sessions.detached.push(id)
        },
      }
    }
    const emit = { emit: (name: string) => { order.push(`emit:${name}`) } }

    await deleteSession({ registry, persistence, sessions, emit }, sid('a'))
    expect(order[0]).toBe('detach')
    expect(order[1]).toBe('emit:workspace/session-deleted')
  })
})

describe('exportJsonl', () => {
  it('returns the raw artifact when the backend supports it', async () => {
    const persistence = persistenceOf()
    persistence.readRaw = vi.fn(async () => ({ filename: 'session.jsonl', content: '{"type":"session"}\n' }))
    const result = await exportJsonl(persistence, sid('a'))
    expect(result).toEqual({
      ok: true,
      value: { filename: 'session.jsonl', content: '{"type":"session"}\n' },
    })
  })

  it('reports export-unsupported when readRaw is absent', async () => {
    const persistence = persistenceOf()
    delete (persistence as { readRaw?: unknown }).readRaw
    const result = await exportJsonl(persistence, sid('a'))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('export-unsupported')
  })

  it('reports session-not-found for a missing artifact', async () => {
    const persistence = persistenceOf()
    persistence.readRaw = vi.fn(async () => undefined)
    const result = await exportJsonl(persistence, sid('a'))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('session-not-found')
  })
})

describe('deletePersisted', () => {
  it('prefers the backend delete method', async () => {
    const persistence = persistenceOf()
    await deletePersisted(persistence, sid('a'))
    expect(persistence.delete).toHaveBeenCalledWith(sid('a'))
  })

  it('falls back to locate + rm when delete is absent', async () => {
    const persistence = persistenceOf()
    delete (persistence as { delete?: unknown }).delete
    persistence.headers.push({ id: sid('a'), cwd: '/tmp' })
    persistence.paths.set(sid('a'), 'C:\\tmp\\a\\session.jsonl.zstd')
    await expect(deletePersisted(persistence, sid('a'))).resolves.toBeUndefined()
  })

  it('throws when the backend has no delete and no location', async () => {
    const persistence = persistenceOf()
    delete (persistence as { delete?: unknown }).delete
    persistence.headers.push({ id: sid('a'), cwd: '/tmp' })
    await expect(deletePersisted(persistence, sid('a'))).rejects.toThrow('does not support session deletion')
  })
})
