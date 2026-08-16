/**
 * dsh-qol 对话导出（浏览器半）。
 *
 * 官方 ui-workspace 的会话行菜单被补丁插入「导出对话」项（分叉与归档
 * 之间），点击时派发 `dsh-qol:export-session` 自定义事件，detail 为
 * 会话 id；工作区行菜单另有「导出工作区对话」项，派发
 * `dsh-qol:export-workspace`（detail 为 workspaceId）。
 *
 * 导出走浏览器下载（用户自选保存位置）：单会话经宿主 RPC
 * `session.exportJsonl` 拿到明文 JSONL 后以 Blob 触发保存（期间 Toast
 * 「正在导出…」）；工作区导航到宿主 GET
 * `/dsh-qol/workspace.export?workspaceId=…`（流式 ZIP，content-disposition
 * 触发保存）。下载一经触发浏览器即接管，不再弹任何提示。
 */
import { createRoot, type Root } from 'react-dom/client'
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

let toastRoot: Root | undefined
let toastHost: HTMLDivElement | undefined
let toastSeq = 0

/** 挂一个 body 级 Toast（无宿主组件上下文，纯反馈）。 */
function showToast(text: string): void {
  if (toastHost === undefined) {
    toastHost = document.createElement('div')
    document.body.appendChild(toastHost)
  }
  if (toastRoot === undefined) toastRoot = createRoot(toastHost)
  const seq = ++toastSeq
  toastRoot.render(
    <Toast
      key={seq}
      text={text}
      onDone={() => { /* 下一个 seq 重建即可，这里不卸载 root。 */ }}
    />,
  )
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

/**
 * 监听官方补丁派发的导出事件：RPC 取明文 JSONL → Blob 触发浏览器保存。
 * 失败走 Toast。
 * @param t - 本插件字典的翻译函数（qol 命名空间）。
 * @returns 取消监听的 disposer。
 */
export function bindExportSession(t: TranslateNS<'qol'>): () => void {
  const listener = (event: Event): void => {
    const sessionId = (event as CustomEvent).detail
    if (typeof sessionId !== 'string' || sessionId.length === 0) return
    void callRpc<ExportJsonlValue>('session.exportJsonl', { sessionId })
      .then(({ content }) => {
        // sessionId 自带 `session-` 前缀，文件名去掉它，避免 dsh-session-session-… 的重复。
        const shortId = sessionId.replace(/^session-/, '')
        const filename = `dsh-session-${shortId}.jsonl`
        downloadBlob(new Blob([content], { type: 'application/x-ndjson;charset=utf-8' }), filename)
      })
      .catch((reason: unknown) => {
        const message = reason instanceof Error ? reason.message : String(reason)
        showToast(t('export.error', { message }))
      })
  }
  window.addEventListener(EXPORT_EVENT, listener)
  return () => { window.removeEventListener(EXPORT_EVENT, listener) }
}

/**
 * 监听官方补丁派发的工作区导出事件：导航到宿主流式 ZIP 路由，浏览器原生
 * 保存对话框接管。
 * @returns 取消监听的 disposer。
 */
export function bindExportWorkspace(): () => void {
  const listener = (event: Event): void => {
    const workspaceId = (event as CustomEvent).detail
    if (typeof workspaceId !== 'string' || workspaceId.length === 0) return
    const url = new URL(WORKSPACE_EXPORT_PATH, window.location.origin)
    url.searchParams.set('workspaceId', workspaceId)
    const anchor = document.createElement('a')
    anchor.href = url.toString()
    anchor.rel = 'noopener'
    anchor.click()
  }
  window.addEventListener(EXPORT_WORKSPACE_EVENT, listener)
  return () => { window.removeEventListener(EXPORT_WORKSPACE_EVENT, listener) }
}

/** 卸载 Toast root（插件卸载时由宿主调用）。 */
export function disposeExportToast(): void {
  toastRoot?.unmount()
  toastRoot = undefined
  toastHost?.remove()
  toastHost = undefined
}
