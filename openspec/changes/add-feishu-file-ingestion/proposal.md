## Why

飞书不能在普通文件消息中同时携带明确的入库指令，插件因此无法区分知识文件和普通文件。OpenClaw 已下载文件并暴露本地媒体信息，但当前插件既不读取这些字段，也没有将二进制文件交给 Knowledge Bridge 的能力。

## What Changes

- 增加“先声明入库、后发送文件”的短时意图交互，并按账号、会话和发送人隔离。
- 从 OpenClaw 完整入站上下文读取单个文档文件，以流式 multipart 方式上传到 Knowledge Bridge。
- 使用稳定 requestId 防止重复事件创建多个任务，并复用现有任务轮询与终态通知。
- 媒体占位文本不再进入自动候选入库；无有效意图的文件保持原有 OpenClaw 行为。
- 将 OpenClaw 兼容下限提升到支持 `reply_dispatch` 的版本。

## Capabilities

### New Capabilities

- `feishu-file-ingestion-intent`: 定义文件入库意图、文件匹配、上传、消息 claim 和状态通知行为。

### Modified Capabilities

无。

## Impact

- 影响插件消息提取、hook 注册、Knowledge Bridge 客户端、配置和类型定义。
- 新增与 Knowledge Bridge 文件入库接口的 multipart 契约。
- 依赖 OpenClaw `reply_dispatch` 提供完整媒体上下文；目标群若过滤无 @ 文件消息，需要相应渠道配置。
