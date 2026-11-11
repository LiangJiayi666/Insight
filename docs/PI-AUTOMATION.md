# 使用现有Pi制作日报

## 当前状态（2026-11-11）

- 已通过独立Pi真实调用的一条新闻测试：使用已有模型认证和Exa MCP搜索/原文读取工具，无需另配API密钥。
- 完整日报修复后已成功生成并发布12条。此前默认openai-codex模型连接多次报fetch failed/Bad Request；现固定aliyun-custom/gpt-6-astra，并增加tool_search应对工具启动发现时序。成功运行模型错误数0，10次搜索、6次网页读取。
- Windows任务 `Insight-Daily` 已安装，每天北京时间19:50执行；首次计划触发2026-11-11 19:50。
- 常规每日最多3次进程尝试（含手工运行）。排障期间临时允许第4、5次并保留记录，成功后恢复3次上限。今日已发布，19:50将跳过，不再调用模型；次日采用新的计数。
- 不推送飞书，不上传公网。完整12条联网链路首次通过，仍需观察多日稳定性。

## 命令

```powershell
npm run pi:check       # 仅检查CLI路径，不联网
npm run pi:smoke       # 1条真实新闻集成测试，不发布，消耗原账户额度
npm run daily:pi       # 目标12条，验证后生成public/index.html
npm start             # 本机预览；自动日报尚无时显示原试刊
```

无需复制Pi密钥到.env。Pi继承当前用户环境并自行加载全局模型、认证和工具配置；`config/pi.json` 已固定model为aliyun-custom/gpt-6-astra。留空会采用Pi全局默认模型，不保证与正在聊天的临时模型选择相同。CLI路径可自动定位当前Windows npm安装，也可通过cliPath或INSIGHT_PI_CLI指定。

## 执行方式与权限

以Node直接启动Pi CLI，工作目录为Insight，不经命令shell，使用 `--print --mode json --no-session --no-approve`，不复用当前聊天上下文、不创建持久聊天会话。

工具允许列表：read、write、tool_search、现有Exa搜索和网页读取；不开放shell/edit。全局扩展仍可能加载，read/write也不是目录沙箱，不能把工具允许列表当成OS隔离。提示词要求只写当期bundle.json、不读凭证、忽略网页指令。若需要强隔离，需用独立账户或容器，且会影响现有认证的复用。

默认忽略项目受信任资源以避免无人值守加载未知项目扩展；如未来搜索只在项目MCP中配置，需要审查后修改projectTrust为approve。当前一条新闻测试已确认全局工具可用。

## 数据与校验

- `data/pi-smoke/<时间>/`：测试提示词、结果和私有日志，不公开。
- `data/pi-runs/YYYY/MM/DD/`：固定时间窗口、尝试次数、提示词、bundle及私有输出日志。
- `data/issues/YYYY/MM/DD/issue.json`：正式结构化稿。
- `data/evidence/YYYY/MM/DD/pi-evidence.json`：相关正文证据。
- `public/issues/YYYY/MM/DD/`：正式HTML归档。

执行器和独立API程序共用任务锁与发布状态，不会同时生成；成功刊期不会重复执行。Pi失败、不生成文件、日期错误、超出12条、缺少正文、主来源重复、引文无法匹配时不发布。低于12条可发布但注明实际数量，不虚构补齐。

证据正文由Pi从工具结果整理，不是独立HTTP抓取快照；逐字匹配不能证明正文未被模型错误转录，也不能保证引用支持完整结论。只有Pi自检和程序结构/引文检查，没有独立二次模型审核。所有自动刊明确标注未经人工核验。

私有日志可能包含模型输出、路径和工具诊断，不能保证零敏感信息。不要发布或提交这些目录；.gitignore已排除。公开站点只能使用public目录。

每个正式Pi进程最长90分钟，测试最长10分钟。Windows超时通过taskkill结束进程树；同日失败可在剩余尝试次数内重跑，复用已产生且通过校验的bundle。无效草稿的校验错误传入下次提示词，要求读取并修复；JSON事件记录模型和工具阶段。即使最后模型回复失败，也会重新校验文件，仅完整通过时恢复发布。预算中的搜索/读取次数是提示词软约束，不是工具级硬计数；实际费用和额度按现有模型及MCP账户规则。

## 定时任务

当前任务是当前用户交互登录身份，普通权限，不存储Windows密码。需要电脑开机、用户已登录并联网。休眠/关机无法保证准点，StartWhenAvailable尝试延迟补跑。

查看：

```powershell
Get-ScheduledTaskInfo -TaskName Insight-Daily
```

重新安装或移除：

```powershell
powershell -NoProfile -File scripts/install-task.ps1
powershell -NoProfile -File scripts/install-task.ps1 -Remove
```

安装脚本不联网验证，只检查CLI路径。已通过首次完整运行，但未来网络或服务仍可能失败，任务安装成功不代表每天内容生成必然成功。Windows任务结果、data/pi-runs检查点和私有日志用于诊断；外部失败告警尚未实现。

后续：完整日跑验收 → HTTPS发布与访问控制 → 飞书签名推送及发送记录。
