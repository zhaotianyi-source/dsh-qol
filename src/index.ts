/**
 * dsh-qol 包入口（宿主半）。
 *
 * 浏览器面负责归档面板；宿主面补齐官方 rc.6 没有的
 * `workspace.unarchiveSession` / `workspace.deleteSession`。
 * 必须是一个 bundle：只有 loader 行才会被 `ClientModuleRegistry`
 * 扫描 `dsh.client` 并注入 `__DSH_BOOT__`。
 */

export { apply, inject, meta, name } from './host.ts'

export type { QolKey } from './client/locales.ts'
export type { ArchivedPanelInjected, ArchivedPanelProps } from './client/ArchivedPanel.tsx'
