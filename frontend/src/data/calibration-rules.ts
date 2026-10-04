import type { EntryRow, InstrumentEval, InstrumentLevel } from './types'

// 仪器检定口径集中在这里：有效期 12 个月、临期阈值 30 天。
// 规则要调整时只改这两个常量，再调用 recalibrateInstruments() 按新口径重算未停用仪器。
export const VALIDITY_MONTHS = 12
export const EXPIRING_DAYS = 30

const DAY_MS = 24 * 60 * 60 * 1000

export function todayStr(now: Date = new Date()): string {
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/** 只认 YYYY-MM-DD（允许单位数月日），旧数据里的占位文本一律视为缺失。 */
export function parseDateOnly(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }
  const match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(value.trim())
  if (!match) {
    return null
  }
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const date = new Date(year, month - 1, day)
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    return null
  }
  return `${match[1]}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

export function addMonths(dateStr: string, months: number): string {
  const [year, month, day] = dateStr.split('-').map(Number)
  const date = new Date(year, month - 1 + months, day)
  if (date.getDate() !== day) {
    // 月末溢出（如 1 月 31 日 + 1 个月）回退到目标月最后一天
    date.setDate(0)
  }
  return formatDate(date)
}

function formatDate(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

export function diffDays(from: string, to: string): number {
  return Math.round((Date.parse(to) - Date.parse(from)) / DAY_MS)
}

/**
 * 评估单台仪器：列表、详情、送检清单、巡检待办都走这一个函数，结论天然一致。
 * 旧记录缺有效期时按「检定日期 + 12 个月」估算并标记来源；检定日期也缺则记为待补。
 * 已停用仪器直接归为「已停用」，任何提醒入口都不再提示。
 */
export function evaluateInstrument(row: EntryRow, today: string = todayStr()): InstrumentEval {
  const status = String(row.status ?? '')
  const conclusion = String(row['检定结论'] ?? '').trim()
  const storedSource = String(row['有效期来源'] ?? '').trim()

  let validUntil = ''
  let validSource: InstrumentEval['validSource'] = '待补'
  const recorded = parseDateOnly(row['有效期至'])
  if (recorded) {
    validUntil = recorded
    validSource = storedSource === '估算' ? '估算' : '记录'
  } else {
    const calibratedAt = parseDateOnly(row['检定日期'])
    if (calibratedAt) {
      validUntil = addMonths(calibratedAt, VALIDITY_MONTHS)
      validSource = '估算'
    }
  }

  const daysLeft = validUntil ? diffDays(today, validUntil) : null
  let level: InstrumentLevel
  if (status === '已停用') {
    level = '已停用'
  } else if (conclusion.includes('不合格') || status === '不合格') {
    level = '不合格'
  } else if (!validUntil) {
    level = '待补有效期'
  } else if (daysLeft !== null && daysLeft < 0) {
    level = '已过期'
  } else if (daysLeft !== null && daysLeft <= EXPIRING_DAYS) {
    level = '临期'
  } else {
    level = '正常'
  }

  return {
    row,
    level,
    validUntil,
    validSource,
    daysLeft,
    instrumentNo: String(row['仪器编号'] ?? ''),
    station: String(row['使用站点'] ?? '').trim(),
    conclusion,
  }
}

/** 统一排序：先按有效期（待补排最后），再按检定结论（不合格优先），最后按使用站点与仪器编号。 */
export function compareInstruments(a: InstrumentEval, b: InstrumentEval): number {
  const aValid = a.validUntil || '9999-12-31'
  const bValid = b.validUntil || '9999-12-31'
  if (aValid !== bValid) {
    return aValid < bValid ? -1 : 1
  }
  const aRank = a.conclusion.includes('不合格') ? 0 : 1
  const bRank = b.conclusion.includes('不合格') ? 0 : 1
  if (aRank !== bRank) {
    return aRank - bRank
  }
  const byStation = a.station.localeCompare(b.station, 'zh')
  if (byStation !== 0) {
    return byStation
  }
  return a.instrumentNo.localeCompare(b.instrumentNo, 'zh')
}

/** 送检清单：不合格 / 已过期 / 临期的未停用仪器，同一仪器编号只保留最新一条记录（一条有效流程）。 */
export function buildDeliveryList(items: InstrumentEval[]): InstrumentEval[] {
  const byInstrument = new Map<string, InstrumentEval>()
  for (const item of items) {
    if (item.level !== '不合格' && item.level !== '已过期' && item.level !== '临期') {
      continue
    }
    const key = item.instrumentNo || String(item.row.id)
    const previous = byInstrument.get(key)
    if (!previous || Number(item.row.id) > Number(previous.row.id)) {
      byInstrument.set(key, item)
    }
  }
  return [...byInstrument.values()].sort(compareInstruments)
}

export const LEVEL_ADVICE: Record<InstrumentLevel, string> = {
  正常: '按周期跟踪',
  临期: '列入近期送检计划',
  已过期: '立即安排送检',
  不合格: '暂停使用，安排复检',
  待补有效期: '补录检定日期与有效期',
  已停用: '已停用，不再提示',
}
