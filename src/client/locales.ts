/**
 * dsh-qol 文案：归档管理面板（zh / en 双语）。
 * 字典键即 LocaleNamespaceMap 中 `qol` 命名空间的键。
 */

export type QolKey =
  | 'archived.button'
  | 'archived.button.aria'
  | 'archived.panel.title'
  | 'archived.panel.description'
  | 'archived.empty'
  | 'archived.row.restore'
  | 'archived.row.restore.aria'
  | 'archived.row.delete'
  | 'archived.row.delete.aria'
  | 'archived.row.confirmDelete'
  | 'archived.row.confirmDelete.aria'
  | 'archived.row.cancelDelete'
  | 'archived.row.cancelDelete.aria'
  | 'archived.row.workspace'
  | 'archived.error'
  | 'archived.time.justNow'
  | 'archived.time.minutes'
  | 'archived.time.hours'
  | 'archived.time.days'
  | 'archived.time.months'
  | 'archived.time.years'
  | 'archived.close'
  | 'export.success'
  | 'export.error'

export const zh: Record<QolKey, string> = {
  'archived.button': '归档',
  'archived.button.aria': '打开归档会话面板',
  'archived.panel.title': '归档会话',
  'archived.panel.description': '已归档的对话不会出现在会话列表里，但日志仍然保留。',
  'archived.empty': '暂无归档的会话',
  'archived.row.restore': '恢复',
  'archived.row.restore.aria': '恢复会话 {name}',
  'archived.row.delete': '删除',
  'archived.row.delete.aria': '删除会话 {name}',
  'archived.row.confirmDelete': '确定',
  'archived.row.confirmDelete.aria': '确认永久删除会话 {name}',
  'archived.row.cancelDelete': '取消',
  'archived.row.cancelDelete.aria': '取消删除',
  'archived.row.workspace': '{name}',
  'archived.error': '操作失败：{message}',
  'archived.time.justNow': '刚刚',
  'archived.time.minutes': '{n} 分钟前',
  'archived.time.hours': '{n} 小时前',
  'archived.time.days': '{n} 天前',
  'archived.time.months': '{n} 个月前',
  'archived.time.years': '{n} 年前',
  'archived.close': '关闭',
  'export.success': '已导出对话 JSONL',
  'export.error': '导出失败：{message}',
}

export const en: Record<QolKey, string> = {
  'archived.button': 'Archived',
  'archived.button.aria': 'Open the archived sessions panel',
  'archived.panel.title': 'Archived sessions',
  'archived.panel.description': 'Archived conversations are hidden from the session list; their logs are kept.',
  'archived.empty': 'No archived sessions',
  'archived.row.restore': 'Restore',
  'archived.row.restore.aria': 'Restore session {name}',
  'archived.row.delete': 'Delete',
  'archived.row.delete.aria': 'Delete session {name}',
  'archived.row.confirmDelete': 'Confirm',
  'archived.row.confirmDelete.aria': 'Confirm permanently deleting session {name}',
  'archived.row.cancelDelete': 'Cancel',
  'archived.row.cancelDelete.aria': 'Cancel delete',
  'archived.row.workspace': '{name}',
  'archived.error': 'Operation failed: {message}',
  'archived.time.justNow': 'just now',
  'archived.time.minutes': '{n} minutes ago',
  'archived.time.hours': '{n} hours ago',
  'archived.time.days': '{n} days ago',
  'archived.time.months': '{n} months ago',
  'archived.time.years': '{n} years ago',
  'archived.close': 'Close',
  'export.success': 'Conversation exported as JSONL',
  'export.error': 'Export failed: {message}',
}
