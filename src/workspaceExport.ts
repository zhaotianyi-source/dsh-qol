/**
 * dsh-qol 工作区导出（宿主半）：把工作区记账下所有会话的明文 JSONL
 * 打包成一个 ZIP 的 Buffer。
 *
 * 打包走 fflate 的 Zip 流式 API：逐个会话 readRaw（zstd 解码后的存储
 * 原文），zip 条目路径为 `<sessionId>/session.jsonl`（与官方
 * session.export 的目录布局一致，每个会话一个目录，互不覆盖）。内存占用
 * 与官方导出一样有界：同一时刻只持有一个会话的 artifact 文本；Zip 字节
 * 累积到最终 Buffer 才整体返回（宿主侧写盘用）。
 */
import { Zip, ZipDeflate } from 'fflate'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'

/** workspace registry 上我们会用到的面（registry 实体的 id 字段是 `id`）。 */
export interface ExportWorkspaceLike {
  id: string
  title: string
  sessionIds: readonly SessionId[]
}

export interface ExportRegistryLike {
  list(): readonly ExportWorkspaceLike[]
}

/** JSONL persistence 的 readRaw 面（zstd 解码后的明文）。 */
export interface ExportPersistenceLike {
  readRaw(sessionId: SessionId): Promise<{ filename: string; content: string } | undefined>
}

/** 工作区导出需要的宿主服务。 */
export interface WorkspaceExportDeps {
  registry: ExportRegistryLike
  persistence: ExportPersistenceLike
}

/**
 * 解析工作区导出依赖；缺任一服务（或 persistence 不支持 raw artifact）
 * 返回 undefined，调用方跳过导出能力。
 */
export function workspaceExportDeps(ctx: Context): WorkspaceExportDeps | undefined {
  const registry = ctx.get('workspaceRegistry') as ExportRegistryLike | undefined
  const persistence = ctx.get('sessionPersistence') as ExportPersistenceLike | undefined
  if (registry === undefined || persistence === undefined) return undefined
  if (typeof persistence.readRaw !== 'function') return undefined
  return { registry, persistence }
}

/** 会话 id 转 zip 路径段（与官方 safeSessionIdSegment 同规则）。 */
export function safeSegment(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]/g, '_')
}

/** 一次写一个 zip 条目：readRaw → ZipDeflate 压入。 */
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
 * 打包一个工作区的所有会话日志。
 * @param deps - 导出依赖。
 * @param workspaceId - 目标工作区 id（registry 实体的 id）。
 * @returns ZIP 字节与建议文件名。
 * @throws 工作区不存在 / 打包失败。
 */
export async function buildWorkspaceZip(
  deps: WorkspaceExportDeps,
  workspaceId: string,
): Promise<{ filename: string; data: Uint8Array }> {
  const workspace = deps.registry.list().find(candidate => candidate.id === workspaceId)
  if (workspace === undefined) throw new Error(`workspace "${workspaceId}" not found`)
  const chunks: Uint8Array[] = []
  const zip = new Zip((error, data) => {
    // fflate 成功回调的 error 是 null（不是 undefined），只有非空才算错。
    if (error !== null && error !== undefined) return
    if (data.byteLength > 0) chunks.push(data)
  })
  for (const sessionId of workspace.sessionIds) {
    await pushSessionEntry(zip, sessionId, deps.persistence)
  }
  zip.end()
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)
  const data = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    data.set(chunk, offset)
    offset += chunk.byteLength
  }
  return { filename: `dsh-workspace-${safeSegment(workspaceId)}.zip`, data }
}
