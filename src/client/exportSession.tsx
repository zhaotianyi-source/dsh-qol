/**
 * dsh-qol 对话导出（浏览器半）。
 *
 * 官方 ui-workspace 的会话行菜单被补丁插入「导出对话」项（分叉与归档
 * 之间），点击时派发 `dsh-qol:export-session` 自定义事件，detail 为
 * 会话 id；工作区行菜单另有「导出工作区对话」项，派发
 * `dsh-qol:export-workspace`（detail 为 workspaceId）。
 *
 * 导出走浏览器下载（用户自选保存位置）：单会话经宿主 RPC
 * `session.exportJsonl` 拿到明文 JSONL 后以 Blob 触发保存；工作区导航到
 * 宿主 GET `/dsh-qol/workspace.export?workspaceId=…`（流式 ZIP，
 * content-disposition 触发保存）。下载一经触发浏览器即接管，不再弹任何
 * 提示；失败以 Toast 反馈。
 *
 * 反馈渲染遵循官方模式：`Toast` 是框架 primitives 组件，由注册进
 * `shell.overlay` 槽的组件内部 `useState` 驱动（先例：ui-model-selection
 * 的 ModelSelect）——不手写 `createRoot` / 手动挂 DOM。
 */
import { useEffect, useState, type ReactNode } from 'react'
import { Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { callRpc } from './rpc.ts'

/** 会话行菜单补丁派发的事件名。 */
export const EXPORT_EVENT = 'dsh-qol:export-session'

/** 工作区行菜单补丁派发的事件名。 */
export const EXPORT_WORKSPACE_EVENT = 'dsh-qol:export-workspace'

/** 工作区导出路由（宿主侧注册，GET 流式 ZIP）。 */
export const WORKSPACE_EXPORT_PATH = '/dsh-qol/workspace.export'

/** 导出 RPC 的返回值。 */
interface ExportJsonlValue {
  filename: string
  content: string
}

/** 触发一次浏览器下载（保存一个已就绪的 Blob）。 */
function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  URL.revokeObjectURL(url)
}

/** 导出一个会话（RPC → Blob 保存）；返回失败消息（成功返回 null）。 */
async function exportSession(sessionId: string): Promise<string | null> {
  try {
    const { content } = await callRpc<ExportJsonlValue>('session.exportJsonl', { sessionId })
    // sessionId 自带 `session-` 前缀，文件名去掉它，避免 dsh-session-session-… 的重复。
    const shortId = sessionId.replace(/^session-/, '')
    downloadBlob(new Blob([content], { type: 'application/x-ndjson;charset=utf-8' }), `dsh-session-${shortId}.jsonl`)
    return null
  } catch (reason: unknown) {
    return reason instanceof Error ? reason.message : String(reason)
  }
}

/** 导出整个工作区（导航到流式 ZIP 路由）；导航本身不失败，返回 null。 */
function exportWorkspace(workspaceId: string): string | null {
  const url = new URL(WORKSPACE_EXPORT_PATH, window.location.origin)
  url.searchParams.set('workspaceId', workspaceId)
  const anchor = document.createElement('a')
  anchor.href = url.toString()
  anchor.rel = 'noopener'
  anchor.click()
  return null
}

/**
 * 注册进 `shell.overlay` 的导出反馈宿主：监听官方补丁派发的导出事件，
 * 执行导出；失败时组件内部 state 渲染 Toast（框架 primitives，官方模式）。
 * @param props - locale seat（qol 命名空间）。
 * @returns 反馈宿主组件。
 */
export function ExportFeedbackHost({ t }: { t: TranslateNS<'qol'> }): ReactNode {
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const onSessionExport = (event: Event): void => {
      const sessionId = (event as CustomEvent).detail
      if (typeof sessionId !== 'string' || sessionId.length === 0) return
      void exportSession(sessionId).then(message => {
        if (message !== null) setError(t('export.error', { message }))
      })
    }
    const onWorkspaceExport = (event: Event): void => {
      const workspaceId = (event as CustomEvent).detail
      if (typeof workspaceId !== 'string' || workspaceId.length === 0) return
      const message = exportWorkspace(workspaceId)
      if (message !== null) setError(t('export.error', { message }))
    }
    window.addEventListener(EXPORT_EVENT, onSessionExport)
    window.addEventListener(EXPORT_WORKSPACE_EVENT, onWorkspaceExport)
    return () => {
      window.removeEventListener(EXPORT_EVENT, onSessionExport)
      window.removeEventListener(EXPORT_WORKSPACE_EVENT, onWorkspaceExport)
    }
  }, [t])

  if (error === null) return null
  return (
    <Toast
      text={error}
      onDone={() => { setError(null) }}
    />
  )
}
