/**
 * dsh-qol 对话导出（浏览器半）。
 *
 * 官方 ui-workspace 的会话行菜单被补丁插入「导出对话」项（分叉与归档
 * 之间），点击时派发 `dsh-qol:export-session` 自定义事件，detail 为
 * 会话 id。这里监听该事件，经宿主 RPC `session.exportJsonl` 拿到
 * zstd 解码后的明文 JSONL，再以 Blob 触发浏览器下载；失败用 Toast
 * 反馈（挂 body 的轻量 root，不依赖任何面板）。
 *
 * 工作区行菜单另有「导出工作区」项，派发 `dsh-qol:export-workspace`
 * （detail 为 workspaceId）：直接把浏览器导航到宿主的
 * `/dsh-qol/workspace.export?workspaceId=…`，由 content-disposition 触发
 * 下载，浏览器原生处理（与官方 session.export 同款），无需 fetch 整个
 * ZIP 进内存。
 */
import { createRoot, type Root } from 'react-dom/client'
import { Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
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

/** 触发一次浏览器下载。 */
function download(content: string, filename: string): void {
  const blob = new Blob([content], { type: 'application/x-ndjson;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  URL.revokeObjectURL(url)
}

/**
 * 监听官方补丁派发的导出事件并执行导出。
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
        download(content, `dsh-session-${shortId}.jsonl`)
        showToast(t('export.success'))
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
 * 监听官方补丁派发的工作区导出事件并导航到下载路由。
 * @param t - 本插件字典的翻译函数（qol 命名空间）。
 * @returns 取消监听的 disposer。
 */
export function bindExportWorkspace(t: TranslateNS<'qol'>): () => void {
  const listener = (event: Event): void => {
    const workspaceId = (event as CustomEvent).detail
    if (typeof workspaceId !== 'string' || workspaceId.length === 0) return
    const url = new URL(WORKSPACE_EXPORT_PATH, window.location.origin)
    url.searchParams.set('workspaceId', workspaceId)
    const anchor = document.createElement('a')
    anchor.href = url.toString()
    anchor.rel = 'noopener'
    anchor.click()
    showToast(t('export.workspace.start'))
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
