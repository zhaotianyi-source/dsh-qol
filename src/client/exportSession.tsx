/**
 * dsh-qol 对话导出（浏览器半）。
 *
 * 官方 ui-workspace 的会话行菜单被补丁插入「导出对话」项（分叉与归档
 * 之间），点击时派发 `dsh-qol:export-session` 自定义事件，detail 为
 * 会话 id；工作区行菜单另有「导出工作区对话」项，派发
 * `dsh-qol:export-workspace`（detail 为 workspaceId）。
 *
 * 导出由**宿主直接写盘**完成（单会话 JSONL 经 `export.saveSessionJsonl`、
 * 工作区 ZIP 经 `export.saveWorkspaceZip`，都写进系统 Downloads 目录）——
 * 只有写盘成功（RPC 返回真实文件名）才弹成功 Modal，因此弹窗出现时文件
 * 一定已在磁盘上。弹窗提供「打开文件夹」按钮，经宿主 RPC
 * `fs.revealDownload` 在文件管理器中选中该文件（Windows）。
 */
import { createRoot, type Root } from 'react-dom/client'
import { Button, Modal, Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { callRpc } from './rpc.ts'

/** 会话行菜单补丁派发的事件名。 */
export const EXPORT_EVENT = 'dsh-qol:export-session'

/** 工作区行菜单补丁派发的事件名。 */
export const EXPORT_WORKSPACE_EVENT = 'dsh-qol:export-workspace'

/** 写盘类导出 RPC 的返回值。 */
interface ExportResult {
  filename: string
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

/**
 * 监听官方补丁派发的导出事件：宿主把明文 JSONL 写进 Downloads（写盘完成
 * 才算成功）后弹成功窗；失败走 Toast。
 * @param t - 本插件字典的翻译函数（qol 命名空间）。
 * @returns 取消监听的 disposer。
 */
export function bindExportSession(t: TranslateNS<'qol'>): () => void {
  const listener = (event: Event): void => {
    const sessionId = (event as CustomEvent).detail
    if (typeof sessionId !== 'string' || sessionId.length === 0) return
    showToast(t('export.workspace.start'))
    void callRpc<ExportResult>('export.saveSessionJsonl', { sessionId })
      .then(({ filename }) => { showExportDialog(filename, t) })
      .catch((reason: unknown) => {
        const message = reason instanceof Error ? reason.message : String(reason)
        showToast(t('export.error', { message }))
      })
  }
  window.addEventListener(EXPORT_EVENT, listener)
  return () => { window.removeEventListener(EXPORT_EVENT, listener) }
}

/**
 * 监听官方补丁派发的工作区导出事件：宿主打包 ZIP 并写进 Downloads（写盘
 * 完成才算成功）后弹成功窗；失败走 Toast。
 * @param t - 本插件字典的翻译函数（qol 命名空间）。
 * @returns 取消监听的 disposer。
 */
export function bindExportWorkspace(t: TranslateNS<'qol'>): () => void {
  const listener = (event: Event): void => {
    const workspaceId = (event as CustomEvent).detail
    if (typeof workspaceId !== 'string' || workspaceId.length === 0) return
    showToast(t('export.workspace.start'))
    void callRpc<ExportResult>('export.saveWorkspaceZip', { workspaceId })
      .then(({ filename }) => { showExportDialog(filename, t) })
      .catch((reason: unknown) => {
        const message = reason instanceof Error ? reason.message : String(reason)
        showToast(t('export.error', { message }))
      })
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
