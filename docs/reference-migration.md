# 参考迁移映射

研究基线固定为 [ai_dsh_company / 395d8200bb225ec6d9590b6c100e697ed68a93ce](https://github.com/ethan-jiang-1/ai_dsh_company/tree/395d8200bb225ec6d9590b6c100e697ed68a93ce)。借鉴组织方法和证据纪律，代码在本仓库重新实现，没有复制 DSH 运行时，也没有声称兼容其内部会话格式。

| 参考做法                 | Codex 迁移                                       |
| ------------------------ | ------------------------------------------------ |
| 看板和任务依赖投影       | 同一份 Task 记录生成 React 看板与 React Flow DAG |
| DSH 原生任务/团队编排    | Harness 调度器 + 官方 Codex App Server 持久会话  |
| 运行路径和交接           | Run、原生会话 ID、阶段事件、检查与审查关系       |
| 一处事实一个家           | `.harness` 记录权威与现有文档 sourcePath 引用    |
| 当前规则、提案与历史分层 | record.kind/status、明确替代关系、版本历史与归档 |
| 缺陷闭环、修复证据       | 缺陷状态、真实检查、独立审查、产品验收           |
| 开发记忆和教训           | 范围检索、护栏引用、requiredCases、限定上下文    |

原参考：[文档规范](https://github.com/ethan-jiang-1/ai_dsh_company/blob/395d8200bb225ec6d9590b6c100e697ed68a93ce/docs/AGENTS.md)、[开发记忆](https://github.com/ethan-jiang-1/ai_dsh_company/blob/395d8200bb225ec6d9590b6c100e697ed68a93ce/notes/README.md)。

Codex 官方接口：[App Server](https://learn.chatgpt.com/docs/app-server)、[会话链接](https://learn.chatgpt.com/docs/app/commands)、[MCP](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)、[角色配置](https://learn.chatgpt.com/docs/agent-configuration/subagents)。实现同时核对了本机 App Server 生成的 JSON schema，并进行了真实协议调用。

使用 `thread/start` 创建持久会话，保存实际返回的 threadId，`turn/start` 真正启动执行；`codex://threads/<id>` 只负责打开会话。没有把预填提示词的新会话链接当作自动执行接口。

本机 PATH 中 Codex 0.140.0 与现有模型不兼容，真实执行曾明确报“需要更新 CLI”；桌面包内 0.159.2 成功。由此采用优先桌面可执行文件、保留原配置、协议错误阻止盲目派发的方案。握手成功本身不能证明配置的模型可执行。
