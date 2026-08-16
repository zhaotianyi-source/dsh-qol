/**
 * dsh-qol 宿主半：在官方 rc.6 上补齐归档恢复 / 永久删除 / 日志导出。
 *
 * 官方 Web 的 `/api` 路由表没有 `workspace.unarchiveSession` /
 * `workspace.deleteSession`，而且 `/api` 拦截器只能挂一个。这里走独立通道
 * `/dsh-qol`，直接改 workspace registry + persistence。
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { buildWorkspaceZip, workspaceExportDeps } from './workspaceExport.ts'

/** Cordis 插件名（= 包名，loader 行的 name）。 */
export const name = 'dsh-qol'

/** 截获 RPC 前必须等 connection / workspace / persistence / webServer 就绪。 */
export const inject = ['connection', 'workspaceRegistry', 'sessionPersistence', 'webServer'] as const

/** 本插件接管的 workspace RPC 与日志导出。 */
const OWNED_METHODS = new Set([
  'workspace.unarchiveSession',
  'workspace.deleteSession',
  'session.exportJsonl',
  'export.saveSessionJsonl',
  'export.saveWorkspaceZip',
  'fs.revealDownload',
])

/** 插件元信息：展示名「DSH 体验优化合集」。 */
export const meta = {
  id: 'dsh-qol',
  displayName: 'DSH 体验优化合集',
} as const

/** RPC 业务错误形状（与官方 server-response 的 error 段一致）。 */
interface RpcError {
  code: string
  message: string
  details: Record<string, unknown>
}

/** cordis 事件总线（emit workspace/session-deleted 让官方帧链路广播 host/session-removed）。 */
interface EventBusLike {
  emit(event: string, ...args: unknown[]): unknown
}

/** RPC 成功/失败结果。 */
type RpcResult<T> = { ok: true; value: T } | { ok: false; error: RpcError }

/** 官方 workspaceRegistry 上我们会用到的面。 */
interface WorkspaceLike {
  sessionIds: readonly SessionId[]
  detachSession(sessionId: SessionId): Promise<void>
}

interface WorkspaceRegistryLike {
  archivedSessionIds: readonly SessionId[]
  list(): readonly WorkspaceLike[]
  archiveSession(sessionId: SessionId): Promise<void>
}

interface PersistenceLike {
  list(): Promise<readonly { id: SessionId; cwd?: string }[]>
  locate(meta: { id: SessionId; cwd?: string }): { path: string } | undefined
  delete?(sessionId: SessionId): Promise<boolean>
  /** 读会话原始产物（JSONL 后端返回 zstd 解码后的明文）。 */
  readRaw?(sessionId: SessionId, signal?: AbortSignal): Promise<{ filename: string; content: string } | undefined>
}

interface SessionsLike {
  get(sessionId: SessionId): unknown
  flush?(session: unknown): Promise<void>
  /** SessionStore 内部 store（entry.detach 触发 session/disposed → host/session-removed）。 */
  store?: Map<SessionId, { detach: () => void }>
}

interface AgentsLike {
  get(sessionId: SessionId): { status?: string } | undefined
}

interface ConnectionLike {
  rpc: {
    handle(
      channel: string,
      handler: (endpoint: string, payload: unknown, signal: AbortSignal) => Promise<RpcResult<unknown>>,
      options: { authority: 'loopback' },
    ): () => Promise<void>
  }
}

/** 从未知 payload 取出 sessionId。 */
function sessionIdOf(payload: unknown): SessionId | undefined {
  if (payload === null || typeof payload !== 'object') return undefined
  const value = (payload as { sessionId?: unknown }).sessionId
  return typeof value === 'string' && value.length > 0 ? value as SessionId : undefined
}

/** 当前归档集快照。 */
function archivedSet(registry: WorkspaceRegistryLike): { archivedSessionIds: SessionId[] } {
  return { archivedSessionIds: [...registry.archivedSessionIds] }
}

/** 恢复：从归档集拿掉该会话（官方 archiveSession 是幂等追加，这里直接改 state）。 */
async function unarchiveSession(ctx: Context, sessionId: SessionId): Promise<RpcResult<{ archivedSessionIds: SessionId[] }>> {
  const registry = ctx.get('workspaceRegistry') as WorkspaceRegistryLike
  if (!registry.archivedSessionIds.includes(sessionId)) {
    return { ok: true, value: archivedSet(registry) }
  }
  const keep = registry.archivedSessionIds.filter(id => id !== sessionId)
  await writeArchiveSet(registry, keep)
  return { ok: true, value: archivedSet(registry) }
}

/** 永久删除：拒运行中会话，摘记账，清归档，删日志。 */
async function deleteSession(ctx: Context, sessionId: SessionId): Promise<RpcResult<{ archivedSessionIds: SessionId[] }>> {
  const registry = ctx.get('workspaceRegistry') as WorkspaceRegistryLike
  const agents = ctx.get('agents') as AgentsLike | undefined
  const sessions = ctx.get('sessions') as SessionsLike | undefined
  const persistence = ctx.get('sessionPersistence') as PersistenceLike

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

  const known = await sessionKnown(ctx, sessionId)
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

  // 移除帧必须最先广播：浏览器收到 host/session-removed 后先删摘要，之后
  // 的归档 / 记账帧只改集合与记账槽，不会把已移除的会话渲染回侧栏。
  // 若反过来（先清归档集再摘记账），浏览器会短暂看到「归档已解除 + 记账
  // 仍在」的中间态——会话闪现回原工作区，下一帧才消失。
  try {
    const entry = sessions?.store?.get(sessionId)
    if (entry !== undefined) entry.detach()
  } catch {
    // 忽略摘除失败
  }
  try {
    ;(ctx as unknown as EventBusLike).emit('workspace/session-deleted', sessionId)
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
async function exportJsonl(ctx: Context, sessionId: SessionId): Promise<RpcResult<{ filename: string; content: string }>> {
  const persistence = ctx.get('sessionPersistence') as PersistenceLike
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

/** 系统 Downloads 目录（导出文件落盘位置）。 */
function downloadsDir(): string {
  return join(homedir(), 'Downloads')
}

/**
 * 在 Downloads 里取一个不冲突的路径：已存在同名文件时追加 `-1`、`-2`…
 * （与浏览器自动改名行为一致）。
 * @param filename - 期望的文件名。
 * @returns 实际落盘路径。
 */
async function uniqueDownloadPath(filename: string): Promise<string> {
  const dir = downloadsDir()
  await mkdir(dir, { recursive: true })
  const dot = filename.lastIndexOf('.')
  const stem = dot === -1 ? filename : filename.slice(0, dot)
  const ext = dot === -1 ? '' : filename.slice(dot)
  let candidate = join(dir, filename)
  for (let index = 1; existsSync(candidate); index++) {
    candidate = join(dir, `${stem}-${index}${ext}`)
  }
  return candidate
}

/** 单会话导出：宿主直接把明文 JSONL 写进 Downloads，写盘完成才算成功。 */
async function saveSessionJsonl(ctx: Context, sessionId: SessionId): Promise<RpcResult<{ filename: string }>> {
  const persistence = ctx.get('sessionPersistence') as PersistenceLike
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
  const shortId = sessionId.replace(/^session-/, '')
  const path = await uniqueDownloadPath(`dsh-session-${shortId}.jsonl`)
  await writeFile(path, artifact.content, 'utf8')
  return { ok: true, value: { filename: basename(path) } }
}

/** 工作区导出：宿主打包 ZIP 并写进 Downloads，写盘完成才算成功。 */
async function saveWorkspaceZip(ctx: Context, workspaceId: string): Promise<RpcResult<{ filename: string }>> {
  const deps = workspaceExportDeps(ctx)
  if (deps === undefined) {
    return {
      ok: false,
      error: {
        code: 'export-unsupported',
        message: 'workspace export is unavailable: missing persistence or raw-artifact support',
        details: { workspaceId },
      },
    }
  }
  try {
    const { filename, data } = await buildWorkspaceZip(deps, workspaceId)
    const path = await uniqueDownloadPath(filename)
    await writeFile(path, data)
    return { ok: true, value: { filename: basename(path) } }
  } catch (error) {
    return {
      ok: false,
      error: {
        code: 'export-failed',
        message: error instanceof Error ? error.message : String(error),
        details: { workspaceId },
      },
    }
  }
}

/**
 * 在文件管理器中显示下载目录里的导出文件（Windows 用 explorer /select，
 * 非 Windows 不支持，返回错误让弹窗提示）。
 */
function revealDownload(payload: unknown): RpcResult<{ filename: string }> {
  const raw = (payload as { filename?: unknown } | null)?.filename
  const filename = typeof raw === 'string' && raw.length > 0 ? raw : undefined
  if (filename === undefined) {
    return {
      ok: false,
      error: { code: 'bad-request', message: 'filename is required', details: {} },
    }
  }
  // 只接受本插件的导出命名（dsh-session-<id>.jsonl / dsh-workspace-<id>.zip），
  // 挡住路径穿越与任意文件选择。
  if (!/^dsh-(session|workspace)-[A-Za-z0-9_-]+\.(jsonl|zip)$/.test(filename)) {
    return {
      ok: false,
      error: { code: 'bad-request', message: `unsafe export filename "${filename}"`, details: {} },
    }
  }
  if (process.platform !== 'win32') {
    return {
      ok: false,
      error: {
        code: 'unsupported-platform',
        message: 'reveal-in-folder is only implemented on Windows',
        details: {},
      },
    }
  }
  const downloads = join(homedir(), 'Downloads')
  const target = join(downloads, filename)
  if (!existsSync(target)) {
    return {
      ok: false,
      error: {
        code: 'file-not-found',
        message: `exported file not found in Downloads: ${filename}`,
        details: { filename },
      },
    }
  }
  // explorer.exe /select 是异步的，spawn + unref 让宿主不等待资源管理器退出。
  const child = spawn('explorer.exe', [`/select,${target}`], { stdio: 'ignore', detached: true })
  child.unref()
  return { ok: true, value: { filename } }
}

/** 会话是否 live / 已持久化。 */
async function sessionKnown(ctx: Context, sessionId: SessionId): Promise<boolean> {
  const sessions = ctx.get('sessions') as SessionsLike | undefined
  if (sessions?.get(sessionId) !== undefined) return true
  const persistence = ctx.get('sessionPersistence') as PersistenceLike
  const headers = await persistence.list()
  return headers.some(header => header.id === sessionId)
}

/**
 * 官方 rc.6 的 archiveSession 只能追加。恢复 / 删除需要写入任意归档集，
 * 这里复用 registry 的私有 setState 链（enqueueOperation + global.set）。
 */
async function writeArchiveSet(registry: WorkspaceRegistryLike, archivedSessionIds: readonly SessionId[]): Promise<void> {
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
async function deletePersisted(persistence: PersistenceLike, sessionId: SessionId): Promise<void> {
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

/**
 * 注册两个 workspace RPC。
 * @param ctx - 宿主上下文。
 */
export function apply(ctx: Context): void {
  const connection = ctx.get('connection') as ConnectionLike | undefined
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
      if (endpoint === 'fs.revealDownload') return revealDownload(payload)
      if (endpoint === 'export.saveWorkspaceZip') {
        const workspaceId = workspaceIdOf(payload)
        if (workspaceId === undefined) {
          return {
            ok: false,
            error: { code: 'bad-request', message: 'workspaceId is required', details: {} },
          }
        }
        return saveWorkspaceZip(ctx, workspaceId)
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
      if (endpoint === 'workspace.unarchiveSession') return unarchiveSession(ctx, sessionId)
      if (endpoint === 'session.exportJsonl') return exportJsonl(ctx, sessionId)
      if (endpoint === 'export.saveSessionJsonl') return saveSessionJsonl(ctx, sessionId)
      return deleteSession(ctx, sessionId)
    },
    { authority: 'loopback' },
  ), 'dsh-qol: workspace session rpc')
}

/** 从未知 payload 取出 workspaceId。 */
function workspaceIdOf(payload: unknown): string | undefined {
  if (payload === null || typeof payload !== 'object') return undefined
  const value = (payload as { workspaceId?: unknown }).workspaceId
  return typeof value === 'string' && value.length > 0 ? value : undefined
}
