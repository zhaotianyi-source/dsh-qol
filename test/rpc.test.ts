/**
 * RPC 信封层测试：协议形状、错误映射、传输失败分支。
 *
 * @module dsh-qol/test/rpc
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { callRpc } from '../src/client/rpc.ts'

const okEnvelope = (value: unknown) => JSON.stringify({
  type: 'server-response',
  rpcId: 'x',
  result: { ok: true, value },
})

const errEnvelope = (code: string, message: string) => JSON.stringify({
  type: 'server-response',
  rpcId: 'x',
  result: { ok: false, error: { code, message, details: {} } },
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('callRpc', () => {
  it('sends the client-request envelope and returns the value', async () => {
    const fetchMock = vi.fn(async () => new Response(okEnvelope({ n: 1 }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const value = await callRpc<{ n: number }>('workspace.unarchiveSession', { sessionId: 's' })
    expect(value).toEqual({ n: 1 })

    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('/dsh-qol/workspace.unarchiveSession')
    expect(init!.method).toBe('POST')
    const body = JSON.parse(String(init!.body))
    expect(body.type).toBe('client-request')
    expect(body.method).toBe('workspace.unarchiveSession')
    expect(body.payload).toEqual({ sessionId: 's' })
    expect(typeof body.rpcId).toBe('string')
  })

  it('throws the host error message on a business error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      errEnvelope('session-not-found', 'no such session'), { status: 200 },
    )))

    await expect(callRpc('workspace.unarchiveSession', { sessionId: 's' }))
      .rejects.toThrow('no such session')
  })

  it('throws a translated message on HTTP 404', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not found', { status: 404 })))

    await expect(callRpc('workspace.unarchiveSession', { sessionId: 's' }))
      .rejects.toThrow('当前宿主还不支持恢复归档，请重启 DSH 后再试。')
  })

  it('throws a transport error when fetch rejects', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('boom') }))

    await expect(callRpc('session.exportJsonl', { sessionId: 's' }))
      .rejects.toThrow(/RPC session.exportJsonl transport failed/)
  })

  it('rethrows cancellation as "cancelled"', async () => {
    const controller = new AbortController()
    vi.stubGlobal('fetch', vi.fn(async () => { throw new DOMException('aborted', 'AbortError') }))

    const promise = callRpc('session.exportJsonl', { sessionId: 's' }, controller.signal)
    controller.abort()
    await expect(promise).rejects.toThrow('cancelled')
  })
})
