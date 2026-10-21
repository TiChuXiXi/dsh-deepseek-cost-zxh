/**
 * dsh-deepseek-cost-zxh —— 浏览器半区：给「Token 用量」弹窗追加一行「实际花费」。
 */
window.__ModuleLoader__.load({
  id: 'dsh-deepseek-cost-zxh',
  factory: (require) => {
    /*
     * 三条约束（改之前先读）：
     *   1. 不碰 React 的树：弹窗由 @deepseek-ai/dsh-client-ui-chat 的 UsagePill 渲染，
     *      槽位层面没有「弹窗行」这个座位，只能在 `dl[data-session-stats-usage]` 上做 DOM 增强；
     *      插入的 dt/dd 都带 `data-dsh-cost*` 标记，被重渲染清掉后下一次 mutation 会补回来。
     *   2. 数字直接从弹窗里读：弹窗显示的就是全额精确计数（带千分位），读它才能保证
     *      「看到的」和「算出来的」一致，不另开数据通道。
     *   3. 只认 DeepSeek：模型名取自 `[data-slot="conversation.input.model"]` 里按钮的
     *      aria-label，不含 DeepSeek 就整行不出现——别的模型这套价目表没有意义。
     *
     * 价目与时段规则见 PRICE_BOOK / PEAK_WINDOWS / HOLIDAYS 上方注释。
     */
    var module = { exports: {} }
    var exports = module.exports

    /* ----------------------------------------------------------- 页面契约 */

    /** 弹窗里的用量表；官方组件写死的 data 属性，是我们唯一认的入口。 */
    const USAGE_SELECTOR = '[data-session-stats-usage]'
    /** 输入框里的模型槽位；它按钮上的 aria-label / title 带当前模型名。 */
    const MODEL_SLOT_SELECTOR = '[data-slot="conversation.input.model"]'
    /** 我们插进 dl 的那一格 dt 的标记。 */
    const LABEL_ATTR = 'data-dsh-cost-label'
    /** 我们插进 dl 的那一格 dd 的标记。 */
    const VALUE_ATTR = 'data-dsh-cost-value'
    /** 注入样式的归属标记（卸载时连它一起摘掉）。 */
    const STYLE_MARK = 'dsh-deepseek-cost-zxh'
    /** DOM 变更到重扫之间的去抖；流式输出时 mutation 很密。 */
    const SCAN_DEBOUNCE_MS = 60

    /* --------------------------------------------------------------- 价目 */

    /**
     * 官方价目表，单位：元 / 百万 tokens。
     * 只列 DeepSeek 在售的两个模型；`idle` 是空闲时段，`peak` 是高峰时段。
     */
    const PRICE_BOOK = {
      flash: {
        display: 'DeepSeek-V4.1-Flash',
        hit: { idle: 0.02, peak: 0.04 },
        miss: { idle: 1, peak: 2 },
        out: { idle: 4, peak: 8 },
      },
      pro: {
        display: 'DeepSeek-V4-Pro',
        hit: { idle: 0.15, peak: 0.3 },
        miss: { idle: 4.5, peak: 9 },
        out: { idle: 13.5, peak: 27 },
      },
    }

    /**
     * 中国法定节假日（全天算空闲时段），只收 2026 年。
     * 官方源：国务院办公厅《关于2026年部分节假日安排的通知》。每年更新一次即可，
     * 缺一年只会让那年的工作日节日按高峰价多算一倍。
     */
    const HOLIDAYS = new Set([
      '2026-01-01', '2026-01-02', '2026-01-03',
      '2026-02-15', '2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19',
      '2026-02-20', '2026-02-21', '2026-02-22', '2026-02-23',
      '2026-04-04', '2026-04-05', '2026-04-06',
      '2026-05-01', '2026-05-02', '2026-05-03', '2026-05-04', '2026-05-05',
      '2026-06-19', '2026-06-20', '2026-06-21',
      '2026-09-25', '2026-09-26', '2026-09-27',
      '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05',
      '2026-10-06', '2026-10-07',
    ])

    /** 高峰时段（北京时间，分钟数区间，左闭右开）。 */
    const PEAK_WINDOWS = [
      [9 * 60, 12 * 60],
      [14 * 60, 18 * 60],
    ]

    /* --------------------------------------------------------------- 文案 */

    const COPY = {
      zh: {
        label: '实际花费',
        peak: '高峰价',
        idle: '空闲价',
        title: (book, tier) =>
          `按 DeepSeek 官方价目（${book.display}，${tier}）估算：` +
          `输入（缓存命中）¥${book.hit.price}/M · 输入（缓存未命中）¥${book.miss.price}/M · 输出 ¥${book.out.price}/M。` +
          (tier === '高峰价'
            ? '高峰时段为北京时间工作日 9:00–12:00、14:00–18:00（不含法定节假日）。'
            : '空闲时段为高峰时段之外的全部时间，单价为高峰的一半。'),
      },
      en: {
        label: 'Actual cost',
        peak: 'peak',
        idle: 'off-peak',
        title: (book, tier) =>
          `Estimated from DeepSeek's official pricing (${book.display}, ${tier}): ` +
          `cache-hit input ¥${book.hit.price}/M · cache-miss input ¥${book.miss.price}/M · output ¥${book.out.price}/M.`,
      },
    }

    /**
     * 当前界面语言只决定我们这两格的文案。
     * @returns 'zh' 或 'en'。
     */
    function language() {
      const tag = document.documentElement.getAttribute('lang')
        || (typeof navigator === 'object' && navigator.language)
        || 'zh'
      return String(tag).toLowerCase().startsWith('zh') ? 'zh' : 'en'
    }

    /* ----------------------------------------------------------- 时间分档 */

    /**
     * 把「此刻」换算成北京时间的日历字段。中国无夏令时，固定 +08:00 即可。
     * @param now - 毫秒时间戳。
     * @returns UTC getter 上就是北京时间的一组数字。
     */
    function beijingClock(now) {
      return new Date(now + 8 * 60 * 60 * 1000)
    }

    /**
     * 这一毫秒属于高峰时段还是空闲时段。
     * @param now - 毫秒时间戳。
     * @returns 高峰返回峰值价目键 `peak`，否则 `idle`。
     */
    function priceTier(now) {
      const clock = beijingClock(now)
      const day = clock.getUTCDay()
      if (day === 0 || day === 6) return 'idle'
      const stamp = `${clock.getUTCFullYear()}-${pad2(clock.getUTCMonth() + 1)}-${pad2(clock.getUTCDate())}`
      if (HOLIDAYS.has(stamp)) return 'idle'
      const minutes = clock.getUTCHours() * 60 + clock.getUTCMinutes()
      const inPeak = PEAK_WINDOWS.some(([from, to]) => minutes >= from && minutes < to)
      return inPeak ? 'peak' : 'idle'
    }

    /** 两位补零。 */
    function pad2(value) {
      return value < 10 ? `0${value}` : String(value)
    }

    /* --------------------------------------------------------------- 解析 */

    /**
     * 从一段带千分位的文本里取出计数；遇到 `%` 视为百分比行，返回 null。
     * @param raw - dd 的文本，例如 `1,763,840 tok` / `94%`。
     * @returns 整数计数，或 null。
     */
    function parseCount(raw) {
      const text = String(raw == null ? '' : raw).trim()
      if (text === '' || text.includes('%')) return null
      const match = /(\d[\d,.\s\u00a0]*)\s*([kKmMgG]?)/.exec(text)
      if (match === null) return null
      const digits = match[1].replace(/[\s,\u00a0]/g, '')
      const value = Number(digits)
      if (!Number.isFinite(value)) return null
      const unit = match[2].toUpperCase()
      const scale = unit === 'K' ? 1e3 : unit === 'M' ? 1e6 : unit === 'G' ? 1e9 : 1
      return Math.round(value * scale)
    }

    /**
     * 把 dt 的文案归到四个计费桶之一；认不出返回 null，交给位置兜底。
     * @param label - dt 文本（跟随界面语言）。
     * @returns 桶名或 null。
     */
    function classify(label) {
      const text = String(label == null ? '' : label)
      if (/缓存读取|缓存读|cache\s*read|cached\s*input/i.test(text)) return 'cacheRead'
      if (/缓存写入|缓存写|cache\s*write|cache\s*creation/i.test(text)) return 'cacheWrite'
      if (/未缓存|未命中|uncached|cache\s*miss/i.test(text)) return 'uncached'
      if (/输出|output/i.test(text)) return 'output'
      return null
    }

    /**
     * 读弹窗里的用量表。
     * @param dl - `dl[data-session-stats-usage]`。
     * @returns 四个桶的计数；一行数字都没有时返回 null。
     */
    function readUsage(dl) {
      const buckets = { uncached: null, cacheRead: null, cacheWrite: null, output: null }
      const numbers = []
      let label = null
      for (const node of dl.children) {
        if (node.tagName === 'DT') {
          label = node.textContent
          continue
        }
        if (node.tagName !== 'DD') continue
        const value = parseCount(node.textContent)
        if (value !== null) {
          numbers.push(value)
          const bucket = classify(label)
          if (bucket !== null && buckets[bucket] === null) buckets[bucket] = value
        }
        label = null
      }
      // 文案被换过（或以后加了新行）时按行位置兜底：最后一行恒为输出。
      if (numbers.length >= 2) {
        if (buckets.output === null) buckets.output = numbers[numbers.length - 1]
        if (buckets.cacheRead === null && numbers.length >= 3) buckets.cacheRead = numbers[numbers.length - 2]
        if (buckets.uncached === null) buckets.uncached = numbers[0]
      }
      if (buckets.uncached === null && buckets.cacheRead === null && buckets.output === null) return null
      return {
        uncached: buckets.uncached || 0,
        cacheRead: buckets.cacheRead || 0,
        cacheWrite: buckets.cacheWrite || 0,
        output: buckets.output || 0,
      }
    }

    /* --------------------------------------------------------------- 模型 */

    /**
     * 认当前会话的模型。
     * @returns `flash` / `pro`；不是 DeepSeek 会话（或读不到模型槽位）返回 null。
     */
    function readModel() {
      const slot = document.querySelector(MODEL_SLOT_SELECTOR)
      if (slot === null) return null
      const button = slot.querySelector('button')
      const text = [
        button === null ? '' : button.getAttribute('aria-label') || '',
        button === null ? '' : button.getAttribute('title') || '',
        slot.textContent || '',
      ].join(' ')
      if (!/deepseek/i.test(text)) return null
      // 先认 Pro，再落到 Flash：模型名里 Pro / Flash 互斥，但 Flash 的名字里可能带别的词。
      return /v4[\s._-]*pro|deepseek[\s._-]*pro|\bpro\b/i.test(text) ? 'pro' : 'flash'
    }

    /* --------------------------------------------------------------- 计算 */

    /**
     * 按当前时段单价算这次会话的花费。
     * @param usage - readUsage 的结果。
     * @param book - PRICE_BOOK 里的一项。
     * @param tier - `peak` 或 `idle`。
     * @returns 元。
     */
    function computeCost(usage, book, tier) {
      // DeepSeek 没有单独的「缓存写入」计费：真出现就并入缓存未命中输入。
      const missed = usage.uncached + usage.cacheWrite
      const total = missed * book.miss[tier] + usage.cacheRead * book.hit[tier] + usage.output * book.out[tier]
      return total / 1e6
    }

    /**
     * 金额文本：小额给足有效位，大额收到两位。
     * @param value - 元。
     * @returns 带 ¥ 的文本。
     */
    function formatCost(value) {
      if (!(value > 0)) return '¥0'
      if (value < 0.01) return `¥${value.toFixed(4)}`
      if (value < 1) return `¥${value.toFixed(3)}`
      if (value < 100) return `¥${value.toFixed(2)}`
      return `¥${value.toFixed(1)}`
    }

    /* ----------------------------------------------------------- 注入 / 更新 */

    /**
     * 把我们的两格挪到 dl 末尾（React 之后追加的行会挤到我们前面）。
     * @param dl - 用量表。
     * @param label - 我们的 dt。
     * @param value - 我们的 dd。
     */
    function moveToEnd(dl, label, value) {
      if (dl.lastElementChild === value && value.previousElementSibling === label) return
      dl.appendChild(label)
      dl.appendChild(value)
    }

    /**
     * 建立或刷新弹窗底部的那一行。数字、模型、时段任一变化都在这里收敛。
     * @param dl - 用量表。
     */
    function syncRow(dl) {
      const existingLabel = dl.querySelector(`[${LABEL_ATTR}]`)
      const existingValue = dl.querySelector(`[${VALUE_ATTR}]`)
      const model = readModel()
      if (model === null) {
        if (existingLabel !== null) existingLabel.remove()
        if (existingValue !== null) existingValue.remove()
        return
      }
      const usage = readUsage(dl)
      if (usage === null) return

      const copy = COPY[language()]
      const book = PRICE_BOOK[model]
      const tier = priceTier(Date.now())
      const tierCopy = tier === 'peak' ? copy.peak : copy.idle
      const cost = computeCost(usage, book, tier)
      const amount = formatCost(cost)
      const detail = copy.title({
        display: book.display,
        hit: { price: book.hit[tier] },
        miss: { price: book.miss[tier] },
        out: { price: book.out[tier] },
      }, tierCopy)

      let label = existingLabel
      let value = existingValue
      if (label === null) {
        label = document.createElement('dt')
        label.setAttribute(LABEL_ATTR, '')
      }
      if (value === null) {
        value = document.createElement('dd')
        value.setAttribute(VALUE_ATTR, '')
      }
      if (label.textContent !== copy.label) label.textContent = copy.label
      paintValue(value, amount, tierCopy)
      if (value.getAttribute('title') !== detail) value.setAttribute('title', detail)
      moveToEnd(dl, label, value)
    }

    /**
     * 画金额：数字用主色，时段后缀用弱色；值没变就不动 DOM（避免自触发观察者）。
     * @param value - 我们的 dd。
     * @param amount - 形如 `¥0.915`。
     * @param tierText - 形如 `高峰价`。
     */
    function paintValue(value, amount, tierText) {
      if (value.getAttribute('data-amount') === amount && value.getAttribute('data-tier') === tierText) return
      value.setAttribute('data-amount', amount)
      value.setAttribute('data-tier', tierText)
      const suffix = document.createElement('span')
      suffix.setAttribute('data-dsh-cost-tier', '')
      suffix.textContent = ` · ${tierText}`
      value.textContent = amount
      value.appendChild(suffix)
    }

    /** 扫一遍页面：有弹窗就同步，没有就什么都不做。 */
    function scan() {
      const dialogs = document.querySelectorAll(USAGE_SELECTOR)
      for (const dl of dialogs) syncRow(dl)
    }

    /* --------------------------------------------------------------- 样式 */

    /**
     * 两格的样式。颜色走主题 token，明暗两套自动跟随；数字对齐用 tabular-nums。
     */
    const CSS = `
[${LABEL_ATTR}],
[${VALUE_ATTR}] {
  margin-top: 2px;
  padding-top: 4px;
}
[${LABEL_ATTR}] {
  color: var(--dsw-alias-label-tertiary, #81858c);
}
[${VALUE_ATTR}] {
  color: var(--dsw-alias-label-primary, #3b3f45);
  font-variant-numeric: tabular-nums;
  font-weight: 500;
  text-align: right;
}
[data-dsh-cost-tier] {
  color: var(--dsw-alias-label-tertiary, #81858c);
  font-weight: 400;
}
`

    /* --------------------------------------------------------------- 挂载 */

    /**
     * 注册本插件。
     * @param ctx - 浏览器插件上下文；副作用全部登记在 effect 里，卸载即清理。
     */
    function apply(ctx) {
      ctx.effect(() => {
        const style = document.createElement('style')
        style.setAttribute('data-plugin', STYLE_MARK)
        style.textContent = CSS
        document.head.appendChild(style)

        let timer = 0
        const schedule = () => {
          if (timer !== 0) return
          timer = setTimeout(() => {
            timer = 0
            try {
              scan()
            } catch (error) {
              // 读不到就这一帧不显示，绝不把异常抛给产品页面。
              console.warn('[dsh-deepseek-cost-zxh] 计费行刷新失败', error)
            }
          }, SCAN_DEBOUNCE_MS)
        }

        const observer = new MutationObserver(schedule)
        observer.observe(document.body, { childList: true, subtree: true, characterData: true })
        scan()

        return () => {
          observer.disconnect()
          if (timer !== 0) clearTimeout(timer)
          style.remove()
          for (const node of document.querySelectorAll(`[${LABEL_ATTR}], [${VALUE_ATTR}]`)) node.remove()
        }
      }, 'dsh-deepseek-cost-zxh: usage cost row')
    }

    exports.apply = apply
    /** 不依赖任何其他客户端服务。 */
    exports.inject = []
    return module.exports
  },
})
