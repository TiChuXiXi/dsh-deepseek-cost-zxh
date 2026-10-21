/**
 * dsh-deepseek-cost-zxh —— 宿主半区（空实现）。
 *
 * 能力全在浏览器半区 client.js：读出「Token 用量」弹窗里的数字，按 DeepSeek 官方
 * 价目表算出这次会话的实际花费，追加到弹窗最后一行下面。
 *
 * 宿主侧为什么还要有文件：`@deepseek-ai/dsh-client-modules` 只扫描 **loader 行**
 * 里声明了 `dsh.client` 的包，才把 `exports["./client"]` 那个 bundle 注入页面。
 * 所以 cordis.patch.yml 必须插一行（哪怕宿主逻辑是空的），这是我们出现在浏览器
 * 里的唯一门票。
 */

/** 与包名一致：patch 行、client bundle 的 id 都用它。 */
export const name = 'dsh-deepseek-cost-zxh'

/** 宿主侧不注册任何工具或服务，浏览器半区独立完成全部工作。 */
export function apply() {}
