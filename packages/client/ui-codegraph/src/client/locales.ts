/** `codegraph` namespace dictionaries for the dedicated tool row. */

/** Dictionary namespace owned by this plugin. */
export const NS = 'codegraph'

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'row.title': '代码图',
  'row.running': '正在查询代码图',
  'row.preparing': '准备查询代码图',
  'row.failed': '代码图查询失败',
  'row.stopped': '代码图查询已中止',
  'row.view': '查看图',
  'row.viewBusy': '正在打开图…',
  'row.viewFailed': '打开图失败',
  'row.inspect': '查看',
} satisfies Record<string, string>

/** The codegraph namespace key union. */
export type CodeGraphKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'row.title': 'Code graph',
  'row.running': 'Querying the code graph',
  'row.preparing': 'Preparing to query the code graph',
  'row.failed': 'Code graph query failed',
  'row.stopped': 'Code graph query stopped',
  'row.view': 'View graph',
  'row.viewBusy': 'Opening the graph…',
  'row.viewFailed': 'Failed to open the graph',
  'row.inspect': 'Inspect',
} satisfies Record<CodeGraphKey, string>
