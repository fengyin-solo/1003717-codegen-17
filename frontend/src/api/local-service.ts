import {
  LEVEL_ADVICE,
  buildDeliveryList,
  compareInstruments,
  evaluateInstrument,
  todayStr,
} from '@/data/calibration-rules'
import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, listRows, resetRows, saveRows } from '@/data/local-store'
import type {
  ActionResult,
  EntryRow,
  InstrumentEval,
  InstrumentLevel,
  InstrumentView,
  ModuleMeta,
  OverviewResult,
  PageResult,
} from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

const CALIBRATION_KEY = 'calibration'

// 提交中去重：同一记录的同一动作在处理完成前只放行一次，并发/重复提交只生效一次。
const inflight = new Set<string>()

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(listRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

export function runAction(key: string, id: number, action: string): ActionResult {
  const token = `${key}:${id}:${action}`
  if (inflight.has(token)) {
    return { ok: false, message: '相同操作正在处理中，请勿重复提交' }
  }
  inflight.add(token)
  try {
    const meta = moduleMeta(key)
    const target = meta.actionTargets[action]
    if (!target) {
      return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
    }
    const rows = listRows(key)
    const index = rows.findIndex((row) => Number(row.id) === id)
    if (index < 0) {
      return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
    }
    const current = String(rows[index].status)
    if (current === target) {
      return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
    }
    const lastStatus = meta.statuses[meta.statuses.length - 1]
    const updated: EntryRow = {
      ...rows[index],
      status: target,
      pending: target !== lastStatus,
      abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
    }
    const next = [...rows]
    next[index] = updated
    saveRows(key, next)
    return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
  } finally {
    inflight.delete(token)
  }
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of listRows(key)) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `\uFEFF${lines.join('\n')}` }
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}

// ---------- 仪器检定：临期/不合格视图、送检清单、重算与巡检待办 ----------

function evaluateAll(filters: Record<string, string> = {}): InstrumentEval[] {
  return filterRows(listRows(CALIBRATION_KEY), filters).map((row) => evaluateInstrument(row))
}

const EXPIRING_LEVELS: InstrumentLevel[] = ['临期', '已过期', '待补有效期']

/** 仪器检定各视图：all 保持登记顺序，其余按有效期、检定结论、使用站点排列；已停用仪器不进提醒视图。 */
export function listInstruments(
  view: InstrumentView,
  filters: Record<string, string> = {},
): { items: InstrumentEval[]; total: number } {
  const evaluated = evaluateAll(filters)
  let items: InstrumentEval[]
  if (view === 'expiring') {
    items = evaluated.filter((item) => EXPIRING_LEVELS.includes(item.level)).sort(compareInstruments)
  } else if (view === 'unqualified') {
    items = evaluated.filter((item) => item.level === '不合格').sort(compareInstruments)
  } else if (view === 'delivery') {
    items = buildDeliveryList(evaluated)
  } else {
    items = evaluated
  }
  return { items, total: items.length }
}

export function instrumentTabCounts(): Record<InstrumentView, number> {
  const evaluated = evaluateAll()
  return {
    all: evaluated.length,
    expiring: evaluated.filter((item) => EXPIRING_LEVELS.includes(item.level)).length,
    unqualified: evaluated.filter((item) => item.level === '不合格').length,
    delivery: buildDeliveryList(evaluated).length,
  }
}

/** 详情与列表共用 evaluateInstrument，返回后两边结论保持一致。 */
export function getInstrumentDetail(id: number): InstrumentEval | null {
  const row = listRows(CALIBRATION_KEY).find((item) => Number(item.id) === id)
  return row ? evaluateInstrument(row) : null
}

/**
 * 送出检定：同一仪器编号只保留一条有效送检流程。
 * 已停用仪器不再发起；已送检中或并发重复提交都只生效一次。
 */
export function dispatchInstrument(id: number): ActionResult {
  const token = `${CALIBRATION_KEY}:${id}:送出检定`
  if (inflight.has(token)) {
    return { ok: false, message: '该仪器的送检提交正在处理中，请勿重复提交' }
  }
  inflight.add(token)
  try {
    const rows = listRows(CALIBRATION_KEY)
    const index = rows.findIndex((row) => Number(row.id) === id)
    if (index < 0) {
      return { ok: false, message: `没有找到编号为 ${id} 的仪器检定记录` }
    }
    const target = rows[index]
    const status = String(target.status)
    if (status === '已停用') {
      return { ok: false, message: '已停用仪器不再发起送检，也不再提示' }
    }
    if (status === '送检中') {
      return { ok: false, message: '该仪器已在送检流程中，重复送检只保留一条有效流程' }
    }
    const instrumentNo = String(target['仪器编号'] ?? '')
    const duplicated = rows.find(
      (row) =>
        Number(row.id) !== id &&
        String(row['仪器编号'] ?? '') === instrumentNo &&
        String(row.status) === '送检中',
    )
    if (duplicated) {
      return {
        ok: false,
        message: `仪器 ${instrumentNo} 已有送检中流程（${duplicated['记录编号']}），只保留一条有效流程`,
      }
    }
    const next = [...rows]
    next[index] = {
      ...target,
      status: '送检中',
      pending: true,
      abnormal: false,
      送检发起时间: todayStr(),
    }
    saveRows(CALIBRATION_KEY, next)
    return { ok: true, message: `仪器 ${instrumentNo} 已送出检定，当前状态「送检中」` }
  } finally {
    inflight.delete(token)
  }
}

/** 规则调整后按新口径重算：只处理未停用仪器，已停用仪器保持原样且不再提示。 */
export function recalibrateInstruments(): ActionResult {
  const rows = listRows(CALIBRATION_KEY)
  const today = todayStr()
  const counts = new Map<InstrumentLevel, number>()
  let skipped = 0
  const next = rows.map((row) => {
    if (String(row.status) === '已停用') {
      skipped += 1
      return row
    }
    const evaluated = evaluateInstrument(row, today)
    counts.set(evaluated.level, (counts.get(evaluated.level) ?? 0) + 1)
    return {
      ...row,
      有效期至: evaluated.validUntil,
      有效期来源: evaluated.validSource,
      检定状态: evaluated.level,
      重算时间: today,
    }
  })
  saveRows(CALIBRATION_KEY, next)
  const order: InstrumentLevel[] = ['正常', '临期', '已过期', '不合格', '待补有效期']
  const summary = order
    .filter((level) => counts.has(level))
    .map((level) => `${level} ${counts.get(level)} 台`)
    .join('，')
  return {
    ok: true,
    message: `已按新口径重算 ${rows.length - skipped} 台未停用仪器（${summary || '无'}），已停用 ${skipped} 台不再参与`,
  }
}

/** 巡检待办里的仪器核查：所有未停用且需要关注的仪器，已停用不提示。 */
export function listInstrumentChecks(): InstrumentEval[] {
  return evaluateAll()
    .filter((item) => item.level !== '正常' && item.level !== '已停用')
    .sort(compareInstruments)
}

export function exportDeliveryList(): { filename: string; content: string } {
  const items = buildDeliveryList(evaluateAll())
  const header = ['仪器编号', '仪器名称', '使用站点', '检定结论', '有效期至', '有效期来源', '剩余天数', '提醒级别', '当前状态', '核查建议']
  const lines = [header.join(',')]
  for (const item of items) {
    lines.push(
      [
        item.instrumentNo,
        item.row['仪器名称'] ?? '',
        item.station,
        item.conclusion,
        item.validUntil || '待补',
        item.validSource,
        item.daysLeft ?? '',
        item.level,
        item.row.status,
        LEVEL_ADVICE[item.level],
      ].join(','),
    )
  }
  return { filename: '仪器送检清单.csv', content: `\uFEFF${lines.join('\n')}` }
}

export function downloadDeliveryList(): void {
  const { filename, content } = exportDeliveryList()
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}
