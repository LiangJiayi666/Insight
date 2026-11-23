# 发送、用量与维护

新闻制作之外的任务都有独立用途，不获取或重新生成新闻。

| 入口 | 调用方 | 用途 |
| --- | --- | --- |
| `scripts/operations.mjs --notify` | Windows任务 `Insight-Daily-Operations`，22:00 | 汇总用量、发送台账和日报、备份清理、Git同步 |
| `src/operations.mjs` 的 `deliverDailyReport` | 飞书桥接收到绑定用户的“日报” | 发送同样的台账与附件 |
| `scripts/bridge-evening-check.ps1` | Windows任务 `Insight-Bridge-Evening` | 检查晚间投递记录，必要时启动飞书桥接；自身不调用模型、不发消息 |
| `scripts/git-sync.mjs` | 手工维护 | 单独重试Git同步 |

## 投递

定时与手动共享 `deliverDailyReport`，统一选择刊期：当天已出刊则发当天，否则仅回退到昨天；两天都没有则发送明确提示。附件打包器只处理选定的确切刊期，不另行查找更早的旧刊。

台账和日报分别去重，一项失败仍尝试另一项。每次投递共用一次飞书认证；已成功投递的两项都不再调用网络。定时按日期去重，手动按消息ID去重，用户发送新的一条“日报”可重新获取。

`data/delivery-ledger/`保存发送状态、uuid、file_key与message_id。网络中断记为uncertain并复用uuid；供应商去重有时间边界，接口成功也不代表已读。`status=sent`可能只是缺刊提示或昨日附件，需同时检查 `kind` 与 `editionDate`。

维护结束后保存 `data/runtime/health.json`，对已到制作截止时间仍缺刊、窗口遗漏、发布文件不一致等情况返回非零退出码。不会再仅因台账和缺刊提示发送成功就将整次维护标为正常。手动只读诊断使用 `npm run doctor`；联网依赖另用 `npm run pi:probe` 和 `npm run pi:smoke` 验证。

飞书凭证和绑定信息由现有 `~/.pi/feishu-bridge/` 提供，不放入本项目。外部桥接只依赖 `src/operations.mjs` 的 `deliverDailyReport` 接口。

错过22:00的维护任务若在次日上午补跑，会更新台账和备份但不发送当天晚报。需要电脑开机、用户登录、联网。

## 用量与存储

- `data/costs/YYYY/MM/DD.json`按运行文件键保存Pi已返回的用量，按事件实际北京时间归属，跨日补刊计入实际执行日；无时间戳的旧日志才回退刊期。快照副本不重复计入，缓存命中和本地拦截不算联网请求，真实失败调用计入。SDK错误中的全零usage视为计量不完整，不等于免费。不包含普通飞书聊天，没有金额或token硬熔断。
- `data/source-results/`保存原样工具结束事件，与模型整理的证据区分。工具文本可能截断，不等于原始网页快照。
- 正式私有日志保留30天，测试文件及打包附件保留7天；稿件、证据和台账长期保留。
- 每次清理前在 `backups/YYYY-MM-DD/`备份配置、稿件、证据、工具返回、台账、投递记录与发布状态，并逐文件核对SHA256；备份保留7天。
- 同盘备份不能防磁盘损坏；未配置异盘备份或公网托管。

手动执行 `node scripts/operations.mjs` 会统计、备份、清理及同步Git；追加 `--notify`才启用晚间投递。测试使用临时目录与模拟请求，不发送真实消息。

## Git与历史文件

制作完成和日常维护会同步允许公开的代码、稿件与页面。私有运行目录、凭证、日志、备份和投递记录始终排除。仅允许main分支和配置中的固定远端，不强推、不自动合并。

历史刊期各自保存HTML、CSS和JavaScript，目的是让每期可以独立打开和打包；它们是发布产物，不是另一套前端实现。唯一维护的前端源码是根目录 `styles.css`、`app.js`和 `src/render.mjs`。
