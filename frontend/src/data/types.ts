/** 纯前端数据层的公共类型：与全栈版后端返回的结构保持一致，换回后端时页面不用改。 */

export type EntryRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  [field: string]: string | number | boolean
}

export type ModuleMeta = {
  key: string
  name: string
  entity: string
  desc: string
  fields: string[]
  statuses: string[]
  actions: string[]
  actionTargets: Record<string, string>
  metrics: string[]
}

export type PageResult = {
  items: EntryRow[]
  total: number
  page: number
  size: number
}

export type ActionResult = {
  ok: boolean
  message: string
}

// 仪器检定的提醒级别：同一套口径同时喂给列表、详情、送检清单与巡检待办，保证各处结论一致。
export type InstrumentLevel = '正常' | '临期' | '已过期' | '不合格' | '待补有效期' | '已停用'

export type InstrumentEval = {
  row: EntryRow
  level: InstrumentLevel
  /** 解析后的有效期：优先取记录值，缺失时按检定日期估算，估不出来则为空串（待补）。 */
  validUntil: string
  validSource: '记录' | '估算' | '待补'
  /** 距有效期天数，负数表示已过期；待补/无有效期时为 null。 */
  daysLeft: number | null
  instrumentNo: string
  station: string
  conclusion: string
}

export type InstrumentView = 'all' | 'expiring' | 'unqualified' | 'delivery'

export type OverviewResult = {
  cards: { label: string; value: number }[]
  modules: { name: string; created: number; pending: number; abnormal: number }[]
}
