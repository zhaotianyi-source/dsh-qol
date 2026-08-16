/**
 * 工作区导出单元测试：ZIP 打包（buildWorkspaceZip）与路径段消毒。
 *
 * 用 fflate 的 Zip 解码（fflate.unzipSync）验证产物结构。
 *
 * @module dsh-qol/test/workspace-export
 */

import { describe, expect, it, vi } from 'vitest'
import { unzipSync, strFromU8 } from 'fflate'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { buildWorkspaceZip, safeSegment } from '../src/workspaceExport.ts'

const sid = (id: string): SessionId => id as SessionId

/** 假 workspace registry。 */
function registryOf(workspaces: Array<{ id: string; sessionIds: SessionId[] }>): { list: () => typeof workspaces } {
  return { list: () => workspaces }
}

/** 假 persistence：按 id 返回固定明文。 */
function persistenceOf(artifacts: Record<string, string>): { readRaw: ReturnType<typeof vi.fn> } {
  return {
    readRaw: vi.fn(async (id: SessionId) => {
      const content = artifacts[String(id)]
      return content === undefined ? undefined : { filename: 'session.jsonl', content }
    }),
  }
}

describe('buildWorkspaceZip', () => {
  it('packs one entry per session under <sessionId>/session.jsonl', async () => {
    const registry = registryOf([{ id: 'ws-1', sessionIds: [sid('session-a'), sid('session-b')] }])
    const persistence = persistenceOf({
      'session-a': '{"type":"session","id":"session-a"}\n{"type":"user/message"}\n',
      'session-b': '{"type":"session","id":"session-b"}\n',
    })

    const data = await buildWorkspaceZip(registry, persistence, 'ws-1')
    const unzipped = unzipSync(data)
    expect(Object.keys(unzipped).sort()).toEqual([
      'session-a/session.jsonl',
      'session-b/session.jsonl',
    ])
    expect(strFromU8(unzipped['session-a/session.jsonl']!)).toBe(
      '{"type":"session","id":"session-a"}\n{"type":"user/message"}\n',
    )
    expect(strFromU8(unzipped['session-b/session.jsonl']!)).toBe('{"type":"session","id":"session-b"}\n')
  })

  it('skips sessions whose log is missing', async () => {
    const registry = registryOf([{ id: 'ws-1', sessionIds: [sid('session-a'), sid('session-missing')] }])
    const persistence = persistenceOf({ 'session-a': '{"type":"session"}\n' })

    const data = await buildWorkspaceZip(registry, persistence, 'ws-1')
    expect(Object.keys(unzipSync(data))).toEqual(['session-a/session.jsonl'])
  })

  it('throws for an unknown workspace', async () => {
    const registry = registryOf([])
    const persistence = persistenceOf({})
    await expect(buildWorkspaceZip(registry, persistence, 'nope')).rejects.toThrow('workspace "nope" not found')
  })

  it('produces an empty (but valid) zip for a workspace with no sessions', async () => {
    const registry = registryOf([{ id: 'ws-1', sessionIds: [] }])
    const data = await buildWorkspaceZip(registry, persistenceOf({}), 'ws-1')
    expect(Object.keys(unzipSync(data))).toEqual([])
  })
})

describe('safeSegment', () => {
  it('keeps alphanumerics, dashes, and underscores', () => {
    expect(safeSegment('session-a_b-1')).toBe('session-a_b-1')
  })

  it('neutralizes separators and dots', () => {
    expect(safeSegment('../../etc/passwd')).toBe('______etc_passwd')
  })
})
