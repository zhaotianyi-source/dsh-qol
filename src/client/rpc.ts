/**
 * dsh-qol 的 RPC 直调层。
 *
 * 归档管理的新 RPC（`workspace.unarchiveSession` / `workspace.deleteSession`）
 * 由 harness 宿主侧提供；浏览器端运行时（预构建 dist）没有对应的客户端
 * 方法，因此这里直调插件自己的 `/dsh-qol/<method>` 通道
 * （信封协议与官方 `/api` 相同）。
 * 状态同步不依赖返回值：宿主会经 domain/changed 通道广播
 * `host/archived-sessions-changed` / `host/workspace-changed`，删除还会
 * 广播 `host/session-removed`，运行时已内置这些帧的处理。
 */

/** 宿主 RPC 错误（result.ok === false 的 error 段）。 */
export interface RpcError {
  code: string
  message: string
  details: unknown
}

/** server-response 信封（只建模用到的分支）。 */
export interface RpcResponse<T> {
  type: 'server-response'
  rpcId: string
  result: { ok: true; value: T } | { ok: false; error: RpcError }
}

/**
 * 调用一个宿主 RPC 并返回其 value；业务错误抛 Error（message 用宿主的）。
 * @param method - RPC 方法名（即 /dsh-qol/ 后的路径段）。
 * @param payload - 请求载荷。
 * @param signal - 可选取消信号。
 * @returns 响应 value。
 */
export async function callRpc<T>(method: string, payload: unknown, signal?: AbortSignal): Promise<T> {
  let response: Response
  try {
    response = await fetch(`/dsh-qol/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request',
        rpcId: crypto.randomUUID(),
        method,
        payload,
      }),
      signal,
    })
  } catch (reason) {
    if (signal?.aborted === true) throw new Error('cancelled')
    throw new Error(`RPC ${method} transport failed: ${reason instanceof Error ? reason.message : String(reason)}`)
  }
  if (!response.ok) {
    throw new Error(humanHttpError(method, response.status))
  }
  let envelope: RpcResponse<T>
  try {
    envelope = await response.json() as RpcResponse<T>
  } catch {
    throw new Error(`RPC ${method} returned a malformed response`)
  }
  if (!envelope.result.ok) {
    throw new Error(`${envelope.result.error.message}`)
  }
  return envelope.result.value
}

/** 把载体层 HTTP 状态翻成面板能直接展示的短句。 */
function humanHttpError(method: string, status: number): string {
  if (status === 404) {
    if (method === 'workspace.deleteSession') return '当前宿主还不支持永久删除，请重启 DSH 后再试。'
    if (method === 'workspace.unarchiveSession') return '当前宿主还不支持恢复归档，请重启 DSH 后再试。'
    return '接口不存在，请重启 DSH 后再试。'
  }
  if (status === 403) return '没有权限执行这个操作。'
  return `请求失败（HTTP ${String(status)}）`
}
