// @vitest-environment jsdom
/**
 * 归档面板组件测试：props 直喂（官方 component-spec 模式），断言可见行为。
 *
 * @module dsh-qol/test/archived-panel
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ArchivedPanel, type ArchivedPanelProps } from '../src/client/ArchivedPanel.tsx'
import { zh } from '../src/client/locales.ts'

afterEach(cleanup)

/** 最小 locale seat（只覆盖用到的键）。 */
const t = ((key: string, params?: Record<string, unknown>): string => {
  const template = (zh as Record<string, string>)[key] ?? key
  return template.replace(/\{(\w+)\}/g, (_, name: string) => String(params?.[name] ?? `{${name}}`))
}) as ArchivedPanelProps['t']

/** 最小 SessionSummary 工厂。 */
function summary(id: string, title: string, updatedAt: number): NonNullable<ReturnType<ArchivedPanelProps['useSessions']>> extends never
  ? never : unknown {
  return {
    id,
    displayTitle: title,
    updatedAt,
    origin: 'user',
    blank: false,
  }
}

/** 按 selector 形式构造 useSessions stub（组件以 selector(state) 调用）。 */
function sessionsHook(state: { byId: Record<string, unknown>; ids: string[]; current: undefined }): ArchivedPanelProps['useSessions'] {
  return ((selector: (s: typeof state) => unknown) => selector(state)) as unknown as ArchivedPanelProps['useSessions']
}

/** 按 selector 形式构造 useWorkspaces stub。 */
function workspacesHook(state: { items: unknown[]; archivedSessionIds: string[] }): ArchivedPanelProps['useWorkspaces'] {
  return ((selector: (s: typeof state) => unknown) => selector(state)) as unknown as ArchivedPanelProps['useWorkspaces']
}

/** 空状态的默认 hooks。 */
const useSessions = sessionsHook({ byId: {}, ids: [], current: undefined })
const useWorkspaces = workspacesHook({ items: [], archivedSessionIds: [] })

function props(overrides: Partial<ArchivedPanelProps> = {}): ArchivedPanelProps {
  return {
    wide: true,
    t,
    useSessions,
    useWorkspaces,
    unarchiveSession: vi.fn(async () => {}),
    deleteSession: vi.fn(async () => {}),
    ...overrides,
  }
}

describe('ArchivedPanel', () => {
  it('renders the sidebar footer button with the archived label', () => {
    render(<ArchivedPanel {...props()} />)
    expect(screen.getByRole('button', { name: '打开归档会话面板' })).toBeTruthy()
  })

  it('opens the panel and shows the empty state', () => {
    render(<ArchivedPanel {...props()} />)
    fireEvent.click(screen.getByRole('button', { name: '打开归档会话面板' }))
    expect(screen.getByText('暂无归档的会话')).toBeTruthy()
  })

  it('lists archived sessions with title and relative time', () => {
    const sessions = {
      byId: {
        'session-1': summary('session-1', '第一段对话', Date.now() - 5 * 60_000),
      },
      ids: ['session-1'],
      current: undefined,
    }
    const workspaces = {
      items: [{ workspaceId: 'ws-1', title: '项目甲', sessionIds: ['session-1'] }],
      archivedSessionIds: ['session-1'],
    }
    render(<ArchivedPanel {...props({
      useSessions: sessionsHook(sessions),
      useWorkspaces: workspacesHook(workspaces),
    })} />)
    fireEvent.click(screen.getByRole('button', { name: '打开归档会话面板' }))
    expect(screen.getByText('第一段对话')).toBeTruthy()
    expect(screen.getByText('项目甲')).toBeTruthy()
    expect(screen.getByText('5 分钟前')).toBeTruthy()
  })

  it('restores a session on Restore click', async () => {
    const unarchiveSession = vi.fn(async () => {})
    const sessions = {
      byId: { 'session-1': summary('session-1', '待恢复', Date.now() - 60_000) },
      ids: ['session-1'],
      current: undefined,
    }
    const workspaces = {
      items: [],
      archivedSessionIds: ['session-1'],
    }
    render(<ArchivedPanel {...props({
      unarchiveSession,
      useSessions: sessionsHook(sessions),
      useWorkspaces: workspacesHook(workspaces),
    })} />)
    fireEvent.click(screen.getByRole('button', { name: '打开归档会话面板' }))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '恢复会话 待恢复' }))
    })
    expect(unarchiveSession).toHaveBeenCalledWith('session-1')
  })

  it('requires two clicks to delete (Delete → Confirm)', async () => {
    const deleteSession = vi.fn(async () => {})
    const sessions = {
      byId: { 'session-1': summary('session-1', '待删除', Date.now() - 60_000) },
      ids: ['session-1'],
      current: undefined,
    }
    const workspaces = {
      items: [],
      archivedSessionIds: ['session-1'],
    }
    render(<ArchivedPanel {...props({
      deleteSession,
      useSessions: sessionsHook(sessions),
      useWorkspaces: workspacesHook(workspaces),
    })} />)
    fireEvent.click(screen.getByRole('button', { name: '打开归档会话面板' }))

    // 第一次点击只进入确认态，不删除。
    fireEvent.click(screen.getByRole('button', { name: '删除会话 待删除' }))
    expect(deleteSession).not.toHaveBeenCalled()

    // 第二次点击「确定」才执行删除。
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '确认永久删除会话 待删除' }))
    })
    expect(deleteSession).toHaveBeenCalledWith('session-1')
  })

  it('surfaces export errors through the error banner', async () => {
    const deleteSession = vi.fn(async () => { throw new Error('boom') })
    const sessions = {
      byId: { 'session-1': summary('session-1', '失败项', Date.now() - 60_000) },
      ids: ['session-1'],
      current: undefined,
    }
    const workspaces = {
      items: [],
      archivedSessionIds: ['session-1'],
    }
    render(<ArchivedPanel {...props({
      deleteSession,
      useSessions: sessionsHook(sessions),
      useWorkspaces: workspacesHook(workspaces),
    })} />)
    fireEvent.click(screen.getByRole('button', { name: '打开归档会话面板' }))
    fireEvent.click(screen.getByRole('button', { name: '删除会话 失败项' }))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '确认永久删除会话 失败项' }))
    })
    expect(screen.getByText(/操作失败：boom/)).toBeTruthy()
  })
})
