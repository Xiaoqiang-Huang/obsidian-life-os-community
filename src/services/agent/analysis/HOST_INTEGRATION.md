# 实际宿主接口与验证边界

## 公共接口（不经过 AgentLoop）

```ts
new ProjectAnalysisService(app, () => settings, sdkController);
new ProjectAnalysisModal(app, service, projectId?, request?);
```

Controller 实现 `analysisIdentity()` 和 `analysisCall(ModelCall): Promise<ModelResponse>`。
Service 不持有凭据，不初始化真实 SDK；只转交专用调用，核对当前 profile、revision、model、destination。
`identity/projects/reader/prepare/observe/reload/report` 不调用模型。`observe` 仅 store.read；
`reload` 是用户明确恢复检查，可将失效运行记录转为暂停，不用于 timer。
`approve` 接收 `{identityHash, authorizationRevision, accepted:true}`；审批不启动模型。
仅 `continue(jobId,true)` 驱动获准任务。`pause/cancel/cancelPreparation` 停止后续操作，
取消/关闭初始化期间排队 start 的本地 stopRevision 门禁不会重置预算。
`reprepare` 冻结新来源/预算、保留总 ledger/兼容缓存并撤销变化后的审批。
`saveReport(jobId,true)` 是另一个显式授权派生写入；不覆盖已有不同内容。
`dispose` 停止自有工作，不 dispose 主线程拥有的 SDK。

## 数据与状态

- 原件只读：Vault read/readBinary；原件字节 SHA256 与有效正文/来源 hash 独立。
- 只在授权项目 Documents/Attachments 全量枚举，明确 source_file 才归并。
  外部识别缓存先按 metadata source_file 过滤；不读取无关 cache 正文。
- 复用 DocumentRecognitionCacheService 的来源/分页函数，不调用会写缓存的
  readPdfPage/readDocx。native PDF 逐页读取；无文字页标 unsupported，不启动 OCR。
- DOCX 复用 uncapped native reader；它没有全部非正文结构计数，因此 totalUnits=null/partial。
- 旧识别缓存无 authenticated immutable body hash，全部缓存/wrapper 正文保守标
  manually-edited、originalVerified=false；保存原正文，不覆盖、不称原件逐字证据。
  原件 hash 不匹配的 recognition cache 不复用。native 失败但有效已有 cache 可保留，未知覆盖不伪装全量。
- Markdown 明确 author metadata 可保留，但没有评论段角色绑定则 role=unknown，不推断全部出自该作者。
- work checkpoint 在 FileSystemService 的 Chat/Agent/Working State/ProjectAnalysis。
  桌面 adapter basePath + Node fs 同目录临时文件/fsync/rename，以及 OS exclusive wx lock
  提供本机多窗口/多实例 CAS 与 analysis job SDK 串行锁。崩溃遗留 lock 不自动偷锁，报 busy/interrupted。
  不宣称跨设备同步/网络磁盘分布式安全；其他 hostIdentity 记录只读。
  主机 opaque id 由 Obsidian unsynced local storage 保存，不是凭据。
  同进程同目录的短 read/atomicReplace 使用共享 FIFO，防 Windows 热读句柄使 rename 饥饿；
  不把 withHostLock 的整个 callback 入队，避免 callback 内 read/replace 自锁。
  跨进程仍以 OS lock/CAS 为准；外部进程长期占用时有界重试失败，不偷锁、不删除目标。

## UI/预算

Modal 明示 source paths/hash、profile/destination、预算、unknown coverage/金额、状态。
未知 contextTokens 不从小夹具推断能力；需要用户确认 input/output/syscontext 安全操作窗口。
profile.contextTokens 为三项之和，contentCategories 明示 user-confirmed-safe-window-not-model-capability；
它只是保守本地门禁，不是模型能力验证结果。完整 prompt 使用保守 UTF-8 字节估算，过大暂停。
默认 sdk queries=20，CLI 工具往返 maxTurns=1（controller 禁用工具），每 query reported allowance=4，
job reported-turn budget=80。query/tool rounds/terminal num_turns/HTTP 不混为一谈。
实际 terminal reported turns 与 query 总 token 原样结算，超预留/未知暂停；不按 maxTurns 伪造 1。
报价与金额未知，不接受金额硬上限承诺；currency 仅标签。缺失 token 收据仍 fail closed。
定时器仅 observe 并更新独立 statusEl/按钮 disabled，不重建内容；input 事件即时保存草稿。
显式重绘保留 focused control、selection 和 scroll。新身份轮询清除旧 consent，要求刷新审批范围。
关闭取消 active/pending preparation 并暂停当前 job；晚返回保留实际用量，不启动下一请求。
`close()` 仍遵循宿主同步 hook；`whenClosed(): Promise<void>` 可等待本次关闭暂停落盘，
IO 失败会拒绝并显示 Notice。fixture/宿主销毁同步不以热 observe 或固定 sleep 代替此完成信号。

## 运行检查

`node scripts/test-agent-analysis.cjs`：含 537 文档、100×20 固定观点/末尾反例、真实文件 checkpoint + 子进程 reload、budget/lease。
`node scripts/test-project-analysis.cjs`：编译实际 service/modal，合成 Vault/DOM、native parser 与 SDK ModelResponse，
覆盖真实文件 OS CAS、审批/恢复/取消、poll 无 mutation、焦点/草稿/scroll、关闭门禁、source/cache hash、串行桥。
fixtures 不是实际 Obsidian UI、实际 PDF/DOCX 语料或真实模型语义验收。
本执行者没有网络/付费模型/用户文档/凭据/安装/发布，也不尝试启动宿主或绕过 launcher。
主线程负责 main/ChatView/Project入口、KnowledgeView 精确 type/path 排除、完整构建和手动临时 Vault 验收。
