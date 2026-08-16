/**
 * 归档会话面板（dsh-qol 浏览器半）。
 *
 * 注册在侧栏 `sidebar.footer.action`（list 槽）：底部一个「归档」按钮，
 * 点击打开模态面板，列出全部已归档会话（标题 / 工作区 / 时间），每行提供
 * 恢复、删除（两次点击确认）操作。
 *
 * 数据读取走框架全局钩子（useSessions / useWorkspaces）；操作走本插件
 * 注册时的 inject 面。
 */
import { useEffect, useState } from 'react'
import type { SnapshotSelectorHook, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import {
  IconArchiveOutline20,
  Modal,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  SessionId, SessionListState, SessionSummary, WorkspaceListState, WorkspaceView,
} from '@deepseek-ai/dsh-client-runtime/client'
import css from './ArchivedPanel.module.css'

/** dsh-qol 归档面板的注入面（注册时由 apply 提供）。 */
export interface ArchivedPanelInjected {
  /** 恢复一个归档会话。 */
  unarchiveSession: (sessionId: SessionId) => Promise<void>
  /** 永久删除一个会话（宿主拒绝仍在运行的会话）。 */
  deleteSession: (sessionId: SessionId) => Promise<void>
}

/** 组件完整 props：sidebar.footer.action 的 owner 面 + 注入面 + 全局钩子 + 文案。 */
export type ArchivedPanelProps =
  { wide: boolean }
  & ArchivedPanelInjected
  & {
    t: TranslateNS<'qol'>
    useSessions: SnapshotSelectorHook<SessionListState>
    useWorkspaces: SnapshotSelectorHook<WorkspaceListState>
  }

/** 一行归档会话：摘要 + 所属工作区标题。 */
interface ArchivedRow {
  id: SessionId
  title: string
  updatedAt: number
  workspace: string | undefined
}

/** 找到拥有该会话的工作区（归档不移除 sessionIds 记账槽，因此可反查）。 */
function owningWorkspace(workspaces: readonly WorkspaceView[], sessionId: SessionId): string | undefined {
  const workspace = workspaces.find(candidate => candidate.sessionIds.includes(sessionId))
  return workspace?.title
}

/** 相对时间文案（分钟 / 小时 / 天 / 月 / 年）。 */
function timeLabel(updatedAt: number, now: number, t: TranslateNS<'qol'>): string {
  const minutes = Math.max(0, Math.floor((now - updatedAt) / 60_000))
  if (minutes < 1) return t('archived.time.justNow')
  if (minutes < 60) return t('archived.time.minutes', { n: minutes })
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return t('archived.time.hours', { n: hours })
  const days = Math.floor(hours / 24)
  if (days < 30) return t('archived.time.days', { n: days })
  const months = Math.floor(days / 30)
  if (months < 12) return t('archived.time.months', { n: months })
  return t('archived.time.years', { n: Math.floor(months / 12) })
}

/**
 * 侧栏「归档」按钮 + 归档会话面板。
 * @param props - 组合 props（见 ArchivedPanelProps）。
 * @returns 按钮与模态面板。
 */
export function ArchivedPanel({
  wide, t, useSessions, useWorkspaces, unarchiveSession, deleteSession,
}: ArchivedPanelProps) {
  const [panelOpen, setPanelOpen] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const [confirming, setConfirming] = useState<SessionId | null>(null)
  const [busy, setBusy] = useState<SessionId | null>(null)
  const [error, setError] = useState<string | null>(null)
  /** 已成功删除的会话：本地立即隐藏该行（宿主帧到达前不等），删除是
   *  物理的，行不可能复活，因此该集合不需要过期。 */
  const [dismissed, setDismissed] = useState<ReadonlySet<SessionId>>(() => new Set())

  const archivedSessionIds = useWorkspaces(state => state.archivedSessionIds)
  const byId = useSessions(state => state.byId)
  const workspaces = useWorkspaces(state => state.items)

  // 面板打开期间每分钟刷新一次相对时间。
  useEffect(() => {
    if (!panelOpen) return
    const timer = setInterval(() => { setNow(Date.now()) }, 60_000)
    return () => { clearInterval(timer) }
  }, [panelOpen])

  const rows: ArchivedRow[] = archivedSessionIds
    .filter(id => !dismissed.has(id))
    .map(id => byId[id])
    .filter((summary): summary is SessionSummary => summary !== undefined)
    .map(summary => ({
      id: summary.id,
      title: summary.displayTitle,
      updatedAt: summary.updatedAt,
      workspace: owningWorkspace(workspaces, summary.id),
    }))
    .sort((left, right) => right.updatedAt - left.updatedAt)

  const run = async (sessionId: SessionId, operation: () => Promise<void>): Promise<void> => {
    setError(null)
    setBusy(sessionId)
    try {
      await operation()
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason)
      setError(t('archived.error', { message }))
    } finally {
      setBusy(null)
    }
  }

  return (
    <>
      <button
        type="button"
        className={css.footButton}
        data-wide={wide ? 'true' : 'false'}
        aria-label={t('archived.button.aria')}
        title={t('archived.button')}
        onClick={() => { setPanelOpen(true) }}
      >
        <IconArchiveOutline20 size={wide ? 16 : 18} className={css.footIcon} />
        {wide && <span className={css.footLabel}>{t('archived.button')}</span>}
      </button>
      <Modal
        open={panelOpen}
        onClose={() => { setPanelOpen(false) }}
        title={t('archived.panel.title')}
        description={t('archived.panel.description')}
        closeLabel={t('archived.close')}
        contentClassName={css.panelContent}
      >
        {error !== null && <div className={css.error} role="alert">{error}</div>}
        {rows.length === 0
          ? <div className={css.empty}>{t('archived.empty')}</div>
          : (
            <ul className={css.list} role="list">
              {rows.map(row => (
                <li key={row.id} className={css.row}>
                  <div className={css.rowMain}>
                    <span className={css.rowTitle}>{row.title}</span>
                    <span className={css.rowMeta}>
                      {row.workspace !== undefined && (
                        <span className={css.rowWorkspace}>{t('archived.row.workspace', { name: row.workspace })}</span>
                      )}
                      <span>{timeLabel(row.updatedAt, now, t)}</span>
                    </span>
                  </div>
                  <div className={css.rowActions}>
                    {confirming === row.id
                      ? (
                        <>
                          <button
                            type="button"
                            className={`${css.textButton} ${css.dangerButton}`}
                            aria-label={t('archived.row.confirmDelete.aria', { name: row.title })}
                            disabled={busy === row.id}
                            onClick={() => {
                              setConfirming(null)
                              void run(row.id, async () => {
                                await deleteSession(row.id)
                                setDismissed(prev => new Set(prev).add(row.id))
                              })
                            }}
                          >
                            {busy === row.id
                              ? <span className={css.busy} aria-hidden="true" />
                              : t('archived.row.confirmDelete')}
                          </button>
                          <button
                            type="button"
                            className={css.textButton}
                            aria-label={t('archived.row.cancelDelete.aria')}
                            disabled={busy === row.id}
                            onClick={() => { setConfirming(null) }}
                          >
                            {t('archived.row.cancelDelete')}
                          </button>
                        </>
                      )
                      : (
                        <>
                          <button
                            type="button"
                            className={css.textButton}
                            aria-label={t('archived.row.restore.aria', { name: row.title })}
                            disabled={busy === row.id}
                            onClick={() => {
                              void run(row.id, () => unarchiveSession(row.id))
                            }}
                          >
                            {t('archived.row.restore')}
                          </button>
                          <button
                            type="button"
                            className={css.textButton}
                            aria-label={t('archived.row.delete.aria', { name: row.title })}
                            disabled={busy === row.id}
                            onClick={() => { setConfirming(row.id) }}
                          >
                            {t('archived.row.delete')}
                          </button>
                        </>
                      )}
                  </div>
                </li>
              ))}
            </ul>
          )}
      </Modal>
    </>
  )
}
