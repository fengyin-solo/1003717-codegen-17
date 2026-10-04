// 临时自测：用 esbuild 打包后在 node 中跑领域规则。
const mkStorage = () => {
  const map = new Map()
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    __dump: () => Object.fromEntries(map),
  }
}

let storage = mkStorage()
globalThis.window = { localStorage: storage, setTimeout, clearTimeout }
globalThis.localStorage = storage

const bundle = require('./bundle.cjs')
const seed = bundle.SEED_ROWS
storage.setItem('hydrology-monitor-station:entries', JSON.stringify(seed))

const calib = bundle

let pass = 0
let fail = 0
function check(name, cond, extra = '') {
  if (cond) {
    pass += 1
  } else {
    fail += 1
    console.error('FAIL:', name, extra)
  }
}

// 初始视图
const rules = calib.loadRules()
check('默认临期30天', rules.nearExpiryDays === 30)
check('默认周期12月', rules.defaultValidMonths === 12)

const list = calib.listCalibrationViews('all', rules).items
check('种子10条', list.length === 10, `got ${list.length}`)
const byNo = Object.fromEntries(list.map((r) => [r.instrumentNo, r]))

// id2: 12天后到期 -> 临期
check('12天到期为临期', byNo['YQ-SW-002'].nearExpiry === true)
check('12天到期需送检', byNo['YQ-SW-002'].needSubmit === true)
check('12天到期当前状态待送检', byNo['YQ-SW-002'].currentStatus === '待送检')
// id3: 过期20天
check('过期20天为过期', byNo['YQ-YL-014'].expired === true && byNo['YQ-YL-014'].daysLeft === -20)
check('过期合格也进送检清单', byNo['YQ-YL-014'].needSubmit === true)
// id1: 65天后 -> 不临期
check('65天不临期', byNo['YQ-SW-001'].nearExpiry === false && byNo['YQ-SW-001'].needSubmit === false)
// id6 停用：不提示
check('停用仪器不临期', byNo['YQ-YL-033'].nearExpiry === false)
check('停用仪器不送检', byNo['YQ-YL-033'].needSubmit === false)
// id5 送检中：不重复提示
check('送检中不进清单', byNo['YQ-SW-021'].needSubmit === false && byNo['YQ-SW-021'].inTransit === true)
// id8 新仪器无日期
check('新仪器无有效期待补', byNo['YQ-SW-052'].validUntil === null && byNo['YQ-SW-052'].needSubmit === true)

// 临期视图
const expiring = calib.listCalibrationViews('expiring', rules).items.map((r) => r.instrumentNo)
check('临期视图不含停用', !expiring.includes('YQ-YL-033'))
check('临期视图不含送检中', !expiring.includes('YQ-SW-021'))
check('临期视图含12天', expiring.includes('YQ-SW-002'))
check('临期视图含过期', expiring.includes('YQ-YL-014'))

// 不合格视图
const unq = calib.listCalibrationViews('unqualified', rules).items.map((r) => r.instrumentNo)
check('不合格视图含浊度仪', unq.includes('YQ-SL-007'))
check('不合格视图含流速仪', unq.includes('YQ-SW-063'))
check('不合格视图不含停用', !unq.includes('YQ-YL-033'))

// 送检清单排序：有效期升序第一
const checklist = calib.listCalibrationViews('checklist', rules).items
check('清单去重且仅含需送检', checklist.every((r) => r.needSubmit))
check('清单按有效期最急在前', checklist[0].validUntil !== null && checklist[0].daysLeft <= -10, `first=${checklist[0].instrumentNo} ${checklist[0].validUntil}`)

// 规则调整：临期阈值改为 90 天后重算；id1(65天)应变临期
const newRules = calib.saveRules({ nearExpiryDays: 90, defaultValidMonths: 12 })
const after = Object.fromEntries(calib.listCalibrationViews('all', newRules).items.map((r) => [r.instrumentNo, r]))
check('阈值90天后65天变临期', after['YQ-SW-001'].nearExpiry === true && after['YQ-SW-001'].needSubmit === true)
// 送检中流程不被打断
check('重算不打断送检中', after['YQ-SW-021'].inTransit === true)
// 停用仍不参与
check('重算不启用停用', after['YQ-YL-033'].retired === true && after['YQ-YL-033'].needSubmit === false)

// 并发提交同一仪器只生效一次
const targetId = after['YQ-SW-002'].id
const results = []
calib.saveRules({ nearExpiryDays: 30, defaultValidMonths: 12 })
const t1 = calib.submitInstrument(targetId)
const t2 = calib.submitInstrument(targetId)
const t3 = calib.submitInstrument(targetId)
check('并发调用共享同一流程(同一Promise)', t1 === t2 && t2 === t3)
const p1 = t1.then((r) => results.push(['p1', r]))
const p2 = t2.then((r) => results.push(['p2', r]))
const p3 = t3.then((r) => results.push(['p3', r]))

Promise.all([p1, p2, p3]).then(() => {
  const oks = results.filter(([, r]) => r.ok).length
  check('共享流程3个调用均返回同一成功结果', oks === 3, `ok=${oks}, results=${JSON.stringify(results.map(([, r]) => r.message))}`)
  const inTransitCount = calib.readCalibration().filter((r) => r.inTransit).length
  check('只落库一条送检中流程(共2条在检:YQ-SW-021+002)', inTransitCount === 2, `count=${inTransitCount}`)
  const row = calib.getCalibrationRow(targetId)
  check('提交后为送检中', row.inTransit === true)
  // 再点一次：拒绝重复送检
  calib.submitInstrument(targetId).then((r) => {
    check('重复送检被拒绝', r.ok === false)
    // 同仪器编号重复记录检查：伪造一条同编号待送检
    // 停用仪器不能送检
    const retiredId = calib.readCalibration().find((r) => r.instrumentNo === 'YQ-YL-033').id
    calib.submitInstrument(retiredId).then((r2) => {
      check('停用仪器送检被拒绝', r2.ok === false)

      // 登记合格：有效期=今天+12月，且不再提示
      const passRes = calib.recordResult(targetId, true)
      check('登记合格成功', passRes.ok)
      const passed = calib.getCalibrationRow(targetId)
      check('合格结论', passed.conclusion === '合格')
      check('合格后不临期', passed.nearExpiry === false && passed.needSubmit === false)

      // 停用：各口径消失
      const retireRes = calib.setRetired(passed.id, true)
      check('停用成功', retireRes.ok)
      const retired = calib.getCalibrationRow(targetId)
      check('停用后无提示', retired.needSubmit === false && retired.nearExpiry === false)
      const todos = calib.instrumentCheckTodos().map((r) => r.instrumentNo)
      check('巡检待办不含停用', !todos.includes('YQ-SW-002'))

      // 巡检待办联动 + 去重
      const beforeTodos = todos.length
      const add1 = calib.addInstrumentCheckTodo(calib.instrumentCheckTodos().find((r) => r.instrumentNo === 'YQ-SL-007'))
      const add2 = calib.addInstrumentCheckTodo(calib.instrumentCheckTodos().find((r) => r.instrumentNo === 'YQ-SL-007'))
      check('核查待办可新增', add1.ok === true)
      check('同仪器核查待办不重复', add2.ok === false)

      // 全部生成
      const sum = calib.addAllInstrumentCheckTodos()
      check('批量生成且跳过已存在', sum.added + sum.skipped === calib.instrumentCheckTodos().length)

      // 补录有效期
      const newInstr = calib.readCalibration().find((r) => r.instrumentNo === 'YQ-SW-052')
      const sup = calib.supplementValidity(newInstr.id, '2027-01-15')
      check('补录有效期成功', sup.ok)
      const supRow = calib.getCalibrationRow(newInstr.id)
      check('补录后不再估算', supRow.validUntil === '2027-01-15' && supRow.estimated === false)
      check('补录非法日期被拒', calib.supplementValidity(newInstr.id, 'not-a-date').ok === false)

      // 旧记录估算：构造缺有效期但有检定日期的记录
      const store = bundle
      const raw = store.listRows('calibration')
      const nextId = Math.max(...raw.map((r) => r.id)) + 1
      store.saveRows('calibration', [...raw, {
        id: nextId, status: '已合格', pending: false, abnormal: false,
        '记录编号': 'CALI-OLD', '仪器编号': 'YQ-OLD-1', '仪器名称': '旧水准仪',
        '使用站点': '旧站', '检定单位': '老计量站', '检定日期': '2025-01-10',
        '有效期至': '缺', '检定结论': '合格', '检定状态': '已归档',
      }])
      const oldRow = calib.getCalibrationRow(nextId)
      check('旧记录有效期估算=检定日+12月', oldRow.validUntil === '2026-01-10', `got ${oldRow.validUntil}`)
      check('估算标记', oldRow.estimated === true)
      check('估算已过期则需送检', oldRow.needSubmit === true && oldRow.expired === true)

      // 结论标准化
      check('非标准结论归待补', oldRow.conclusion === '合格') // 这条是合格
      const weird = store.listRows('calibration')
      const weirdId = nextId + 1
      store.saveRows('calibration', [...weird, {
        id: weirdId, status: '已合格', pending: false, abnormal: false,
        '记录编号': 'CALI-WEIRD', '仪器编号': 'YQ-WEIRD', '仪器名称': '未知结论仪',
        '使用站点': '未知站', '检定单位': 'x', '检定日期': '2026-05-01',
        '有效期至': '2027-05-01', '检定结论': '仪器检定样例X', '检定状态': '已归档',
      }])
      const weirdRow = calib.getCalibrationRow(weirdId)
      check('无法识别结论归待补', weirdRow.conclusion === '待补' && weirdRow.needSupplement === true)
      check('待补但未临期不强制送检', weirdRow.needSubmit === false)

      console.log(`\n${pass} passed, ${fail} failed`)
      process.exit(fail === 0 ? 0 : 1)
    })
  })
}).catch((e) => {
  console.error(e)
  process.exit(1)
})
