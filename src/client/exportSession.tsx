/**
 * dsh-qol 对话导出（浏览器半）。
 *
 * 官方 ui-workspace 的会话行菜单被补丁插入「导出对话」项（分叉与归档
 * 之间），点击时派发 `dsh-qol:export-session` 自定义事件，detail 为
 * 会话 id。这里监听该事件，经宿主 RPC `session.exportJsonl` 拿到
 * zstd 解码后的明文 JSONL，再以 Blob 触发浏览器下载；失败用 Toast
 * 反馈（挂 body 的轻量 root，不依赖任何面板）。
 *
 * 工作区行菜单另有「导出工作区对话」项，派发 `dsh-qol:export-workspace`
 * （detail 为 workspaceId）：直接把浏览器导航到宿主的
 * `/dsh-qol/workspace.export?workspaceId=…`，由 content-disposition 触发
 * 下载，浏览器原生处理（与官方 session.export 同款），无需 fetch 整个
 * ZIP 进内存。
 *
 * 导出成功后弹一个成功 Modal：显示文件名，提供「打开文件夹」按钮——
 * 经宿主 RPC `fs.revealDownload` 在文件管理器中选中该文件（Windows）。
 */
import { createRoot, type Root } from 'react-dom/client'
import { Button, Modal, Toast } from '@deepseek-ai/dsh-client-ui-primitives'
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

let dialogRoot: Root | undefined
let dialogHost: HTMLDivElement | undefined
/** 成功弹窗的当前文件名（null = 关闭）。 */
let dialogFilename: string | null = null

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

/** 渲染（或关闭）导出成功弹窗。 */
function renderDialog(t: TranslateNS<'qol'>): void {
  if (dialogHost === undefined) {
    dialogHost = document.createElement('div')
    document.body.appendChild(dialogHost)
  }
  if (dialogRoot === undefined) dialogRoot = createRoot(dialogHost)
  dialogRoot.render(
    <Modal
      open={dialogFilename !== null}
      onClose={() => { dialogFilename = null; renderDialog(t) }}
      title={t('export.dialog.title')}
      description={t('export.dialog.description')}
      closeLabel={t('export.dialog.close')}
      footer={(
        <Button
          variant="primary"
          disabled={dialogFilename === null}
          onClick={() => {
            const filename = dialogFilename
            if (filename === null) return
            void callRpc<{ filename: string }>('fs.revealDownload', { filename })
              .then(() => { dialogFilename = null; renderDialog(t) })
              .catch((reason: unknown) => {
                const message = reason instanceof Error ? reason.message : String(reason)
                dialogFilename = null
                renderDialog(t)
                showToast(t('export.dialog.revealError', { message }))
              })
          }}
        >
          {t('export.dialog.openFolder')}
        </Button>
      )}
    >
      <span>{dialogFilename}</span>
    </Modal>,
  )
}

/** 导出成功后弹窗（并保留失败 Toast 语义）。 */
function showExportDialog(filename: string, t: TranslateNS<'qol'>): void {
  dialogFilename = filename
  renderDialog(t)
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
        const filename = `dsh-session-${shortId}.jsonl`
        download(content, filename)
        showExportDialog(filename, t)
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
    // 浏览器原生下载没有完成回调，ZIP 命名规则与宿主一致，弹窗展示文件名。
    showExportDialog(`dsh-workspace-${workspaceId}.zip`, t)
  }
  window.addEventListener(EXPORT_WORKSPACE_EVENT, listener)
  return () => { window.removeEventListener(EXPORT_WORKSPACE_EVENT, listener) }
}

/** 卸载 Toast / 弹窗 root（插件卸载时由宿主调用）。 */
export function disposeExportToast(): void {
  toastRoot?.unmount()
  toastRoot = undefined
  toastHost?.remove()
  toastHost = undefined
  dialogRoot?.unmount()
  dialogRoot = undefined
  dialogHost?.remove()
  dialogHost = undefined
  dialogFilename = null
}
