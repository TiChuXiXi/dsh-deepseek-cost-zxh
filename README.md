# dsh-deepseek-cost-zxh

在 DSH Web 会话底部点开「Token 用量」时，在弹窗最后一行（输出）下面追加一行 **实际花费**，按 DeepSeek 官方价目估算：

```
Token 用量                    9,603,485 tok
───────────────────────────────────────────
缓存命中                             98%
未缓存输入                     184,505 tok
缓存读取                    9,361,664 tok
输出                           57,316 tok
实际花费                   ¥1.20 · 高峰价
```

只对 DeepSeek 模型显示（模型名从输入框的模型选择器读），别的模型整行不出现。
鼠标悬停在金额上会显示当前生效的单价与计费时段说明。

> 包名带 `-zxh` 后缀：npm 上的 `dsh-deepseek-cost` 已被其他人占用，本包是独立实现。

## 安装

```bash
dsh plugin --profile web add dsh-deepseek-cost-zxh
```

装完重启 `dsh web`，刷新页面。弹窗里就会出现「实际花费」那一行（需要是 DeepSeek 模型的会话）。

本地开发调试（不发布、改完刷新即生效）：

```bash
dsh plugin --profile web add link:<本目录绝对路径>
```

## 价目来源

<https://api-docs.deepseek.com/zh-cn/quick_start/pricing>（2026-10 抓取，单位：元 / 百万 tokens）

| 模型 | 缓存命中输入（空闲 / 高峰） | 缓存未命中输入（空闲 / 高峰） | 输出（空闲 / 高峰） |
| --- | --- | --- | --- |
| `deepseek-flash`（DeepSeek-V4.1-Flash-1017） | 0.02 / 0.04 | 1 / 2 | 4 / 8 |
| `deepseek-v4-pro`（DeepSeek-V4-Pro-0813） | 0.15 / 0.30 | 4.5 / 9 | 13.5 / 27 |

时段规则（官方原文）：**北京时间周一至周五（不含中国法定节假日）9:00–12:00、14:00–18:00 为高峰时段**；
其余时间，包括周末与法定节假日全天，均为空闲时段，空闲单价是高峰的一半。

节假日表内置 2026 年（国务院办公厅《关于2026年部分节假日安排的通知》），每年更新一次即可。

## 计算口径

```
花费 = 未缓存输入 × 未命中单价 + 缓存读取 × 命中单价 + 输出 × 输出单价
```

数字直接读弹窗里显示的精确计数（`1,763,840 tok` 这种），所以和界面上看到的一致。

**限制**：时段按「打开弹窗那一刻」判定。一个会话如果横跨高峰与空闲，算的是全量 token 按当前时段单价的结果，
不是逐请求计费的精确值——官方是按每个请求完成时刻计价的，客户端拿不到逐请求时间。

## 实现说明

- **宿主半区 `index.js` 是空的**。它的唯一作用是让包成为一条 loader 行——`@deepseek-ai/dsh-client-modules`
  只扫描 loader 行里声明了 `dsh.client` 的包，才会把 `client.js` 注入页面。
- **浏览器半区 `client.js`** 做全部工作：
  - 认 `dl[data-session-stats-usage]`（官方弹窗的稳定 data 契约），把 `dt/dd` 追加在末尾，打 `data-dsh-cost-*` 标记；
  - `MutationObserver` 盯着页面：弹窗打开、数字变化（流式输出时一直在变）、模型切换，都会重算；行被 React 清掉会补回来；
  - 样式只作用于自己插的两格，颜色走主题 token（`--dsw-alias-label-*`），明暗主题自动跟随。

## 想改价目

改 `client.js` 里的 `PRICE_BOOK`（元 / 百万 tokens）与 `HOLIDAYS`，刷新页面即可，不用重装。

## License

MIT © TiChuXiXi
