/**
 * dsh-qol 工作区导出（宿主半）。
 *
 * 注册一个 GET `/dsh-qol/workspace.export?workspaceId=…` 路由，把该工作区
 * 记账下所有会话的明文 JSONL 打包成一个 ZIP 流式下发，浏览器端
 * `<a download>` 触发保存对话框（用户自选保存位置）。打包走 fflate 的
 * Zip 流式 API：逐个会话 readRaw（zstd 解码后的存储原文），zip 条目路径
 * 为 `<sessionId>/session.jsonl`（与官方 session.export 的目录布局一致，
 * 每个会话一个目录，互不覆盖）。内存占用与官方导出一样有界：同一时刻只
 * 持有一个会话的 artifact 文本。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Zip, ZipDeflate } from 'fflate'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'

/** 工作区导出路由的挂载路径（GET）。 */
export const WORKSPACE_EXPORT_PATH = '/dsh-qol/workspace.export'

/** workspace registry 上我们会用到的面（registry 实体的 id 字段是 `id`）。 */
interface ExportWorkspaceLike {
  id: string
  title: string
  sessionIds: readonly SessionId[]
}

interface ExportRegistryLike {
  list(): readonly ExportWorkspaceLike[]
}

/** JSONL persistence 的 readRaw 面（zstd 解码后的明文）。 */
interface ExportPersistenceLike {
  readRaw(sessionId: SessionId): Promise<{ filename: string; content: string } | undefined>
}

/** webServer 服务的 register 面。 */
interface WebServerLike {
  register(route: {
    kind: 'exact' | 'prefix'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> | void
  }): () => void
}

/** 导出依赖服务（缺任一则不挂路由，导出入口点开即报错）。 */
function exportDeps(ctx: Context): {
  registry: ExportRegistryLike
  persistence: ExportPersistenceLike
} | undefined {
  const registry = ctx.get('workspaceRegistry') as ExportRegistryLike | undefined
  const persistence = ctx.get('sessionPersistence') as ExportPersistenceLike | undefined
  if (registry === undefined || persistence === undefined) return undefined
  if (typeof persistence.readRaw !== 'function') return undefined
  return { registry, persistence }
}

/** 会话 id 转 zip 路径段（与官方 safeSessionIdSegment 同规则）。 */
function safeSegment(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]/g, '_')
}

/** 一次写一个 zip 条目：readRaw → ZipDeflate 流式压入。 */
async function pushSessionEntry(
  zip: Zip,
  sessionId: SessionId,
  persistence: ExportPersistenceLike,
): Promise<void> {
  const artifact = await persistence.readRaw(sessionId)
  if (artifact === undefined) return // 记账存在但日志缺失（理论上不该发生），跳过而不是让整个包失败
  const deflate = new ZipDeflate(`${safeSegment(sessionId)}/session.jsonl`, { level: 6 })
  zip.add(deflate)
  // fflate 的 ZipDeflate.push 返回 Promise，await 保证字节顺序与背压。
  await deflate.push(new TextEncoder().encode(artifact.content), true)
}

/**
 * 注册工作区导出路由。
 * @param ctx - 宿主上下文。
 */
export function registerWorkspaceExport(ctx: Context): void {
  const webServer = ctx.get('webServer') as WebServerLike | undefined
  const deps = exportDeps(ctx)
  if (webServer === undefined || deps === undefined) {
    return
  }
  webServer.register({
    kind: 'exact',
    path: WORKSPACE_EXPORT_PATH,
    handler: async (req, res) => {
      // 与官方 session.export 一致：HEAD 返回响应头，GET 流式下发。
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405)
        res.end()
        return
      }
      const url = new URL(req.url ?? '/', 'http://dsh.internal')
      const workspaceId = url.searchParams.get('workspaceId') ?? ''
      const workspace = deps.registry.list().find(candidate => candidate.id === workspaceId)
      if (workspace === undefined) {
        res.writeHead(404)
        res.end('workspace not found')
        return
      }
      const filename = `dsh-workspace-${safeSegment(workspaceId)}.zip`
      res.writeHead(200, {
        'content-type': 'application/zip',
        'content-disposition': `attachment; filename="${filename}"`,
        'cache-control': 'no-store',
      })
      if (req.method === 'HEAD') {
        res.end()
        return
      }
      try {
        const zip = new Zip((error, data, final) => {
          // fflate 成功回调的 error 是 null（不是 undefined），只有非空才算错。
          if (error !== null && error !== undefined) return
          if (data.byteLength > 0) res.write(data)
          if (final) res.end()
        })
        for (const sessionId of workspace.sessionIds) {
          await pushSessionEntry(zip, sessionId, deps.persistence)
        }
        zip.end()
      } catch (error) {
        // 中途失败必须让浏览器侧拿到错误，而不是半截 zip。
        if (!res.headersSent) {
          res.writeHead(500)
          res.end(String(error))
          return
        }
        res.destroy(error instanceof Error ? error : new Error(String(error)))
      }
    },
  })
}
