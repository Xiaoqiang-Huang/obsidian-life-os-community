import { readAgentEngineConfig } from './AgentEngineConfig';
import type { AgentRuntimeProfile } from './AgentEngineConfig';

export interface AgentSdkSetupStep { id: string; title: string; ready: boolean; detail: string }
export interface AgentSdkSetup { steps: AgentSdkSetupStep[]; nextAction: string; readyToTest: boolean; readyToEnable: boolean }
/** A read-only checklist, not an authorization or a credential validation result.
 * Only configuration references are inspected. No SDK, Node, network or secrets. */
export function getAgentSdkSetup(value: unknown, runtime: AgentRuntimeProfile | null, profileId: string, enabled: boolean): AgentSdkSetup {
  const read = readAgentEngineConfig(value), config = read.config;
  const profile = config.profiles.find(p => p.id === profileId);
  const profileReady = read.writable && !!profile?.mainModel.trim();
  const v = runtime?.cliVersion?.match(/^(\d+)\.(\d+)\.(\d+)$/)?.slice(1).map(Number);
  const supported = !!v && (v[0] > 2 || v[0] === 2 && (v[1] > 1 || v[1] === 1 && v[2] >= 248));
  const runtimeReady = !!runtime?.id && !!runtime.executablePath && !!runtime.sdkVersion && supported;
  const credentialReady = read.writable && !!profile?.secretRef.startsWith('secret:lifeos-sdk-');
  const snapshot = profile?.capabilitySnapshot;
  const capabilityReady = profileReady && runtimeReady && credentialReady && !!snapshot
    && snapshot.profileRevision === profile!.revision && snapshot.baseUrl === profile!.baseUrl && snapshot.model === profile!.mainModel
    && snapshot.runtimeId === runtime!.id && config.runtimeId === runtime!.id
    && snapshot.sdkVersion === runtime!.sdkVersion && snapshot.cliVersion === runtime!.cliVersion
    && profile!.capabilities.text === 'supported' && profile!.capabilities.tools === 'supported';
  const active = capabilityReady && enabled && config.interactiveProfileId === profileId;
  const steps: AgentSdkSetupStep[] = [
    { id:'profile',title:'服务商与模型',ready:profileReady,detail:profileReady?'已保存所选服务商与模型。':'在上方新增 SDK 配置，填写主模型并保存；原 API 不会被替换。' },
    { id:'runtime',title:'本机运行时',ready:runtimeReady,detail:runtimeReady?'已核对本机 CLI 版本；路径仅保存在本机。':'选择本机 Claude 原生可执行文件或 CLI JS，点击版本检查；JS 入口还需 Node 绝对路径。' },
    { id:'credential',title:'专用凭据',ready:credentialReady,detail:credentialReady?'已保存凭据引用；不代表密钥有效或鉴权成功。':'为所选配置录入专用 Key / Token 并保存；不会读取旧登录或原 API Key。' },
    { id:'capability',title:'文字与工具能力',ready:capabilityReady,detail:capabilityReady?'当前服务商、模型和本机运行时的文字与工具测试通过；其他能力仍以各自记录为准。':'先完成前三步；输入“测试一次”后主动运行能力测试，可能产生费用。更换模型、地址或运行时后需重测。' },
    { id:'activation',title:'明确启用 SDK',ready:active,detail:active?'所选配置已启用。可明确切回原 AI API，不自动换服务商。':enabled?'当前启用配置可能与所选项不同或需要重新验证；先核对身份，再明确启用所选配置。':'能力测试成功不自动启用；检查通过后点击“启用已验证 SDK 配置”。' }
  ];
  const first = steps.find(s => !s.ready);
  return { steps, nextAction:!read.writable?'SDK 配置格式异常或来自新版本，原数据保留；请核对或恢复备份，不要覆盖为默认值。':first?.detail||'已完成设置。先使用非敏感小材料验证对话；项目全文分析还需有效权益与明确范围、预算。',
    readyToTest:profileReady&&runtimeReady&&credentialReady,readyToEnable:capabilityReady };
}

const errors: Record<string, [string,string]> = {
  'agent-config-not-ready':['所选配置还不能启用 SDK。','按配置进度完成当前服务商、模型和运行时的能力测试，再明确启用；不会退回其他配置。'],
  'agent-config-preservation-required':['原 SDK 配置需要保留。','配置格式异常或来自新版本，保存已停止；请核对或恢复备份，不覆盖原数据。'],
  'sdk-desktop-only':['当前设备不能运行本机 SDK。','请在桌面 Obsidian 配置；移动端继续使用原 AI API。'],
  'sdk-config-invalid':['SDK 配置格式异常。','原数据已保留，请核对配置版本或恢复备份；不要覆盖为默认值。'],
  'sdk-profile-required':['尚未选择有效 SDK 配置。','在上方新增或选择配置，填写主模型并保存，然后在下方选择同一配置。'],
  'sdk-config-not-ready':['SDK 配置尚未就绪。','按照配置进度完成模型、运行时、专用凭据和能力测试；不会自动调用原 API。'],
  'sdk-analysis-profile-not-ready':['全文分析的 SDK 配置尚未就绪。','检查提炼配置；没有独立提炼配置时使用已验证的主配置。'],
  'sdk-runtime-required':['尚未检查本机运行时。','优先点击“检查插件自带运行时”；只有自定义部署才需要展开高级区手动指定路径。'],
  'sdk-plugin-directory-unavailable':['无法定位当前插件安装目录。','请在桌面 Obsidian 启用完整插件安装；不会搜索全局运行时或读取旧登录。'],
  'sdk-bundled-platform-unavailable':['当前系统架构没有可用的内置运行时。','选择适合当前平台的完整安装包，或在高级区明确指定本机运行时；移动端继续使用原 API。'],
  'sdk-bundled-runtime-missing':['插件自带运行时文件缺失。','请重新安装包含本平台 runtime 目录的完整插件包；仅复制 main.js 不包含运行时。不会自动下载或使用全局安装。'],
  'sdk-bundled-manifest-invalid':['内置运行时清单不匹配。','重新安装与本插件固定 SDK 版本匹配的完整包；不要混用不同平台或版本的 runtime。'],
  'sdk-bundled-integrity-failed':['内置运行时完整性检查失败。','请重新安装完整插件包，不运行损坏或被修改的文件。'],
  'sdk-bundled-version-mismatch':['内置运行时的实际版本与清单不一致。','重新安装匹配版本的完整包，再主动检查；未启用 SDK、未调用模型。'],
  'sdk-runtime-not-ready':['本机运行时与已测试配置不匹配。','核对路径与版本，重新运行能力测试后再明确启用。'],
  'runtime-absolute-path-required':['运行时路径不是有效绝对路径。','选择本机 Claude 可执行文件或 CLI JS，不要填写相对路径或命令字符串。'],
  'runtime-file-missing':['找不到指定的 Claude 文件。','检查文件是否移动或删除，重新选择本机运行时；不会自动安装。'],
  'runtime-file-required':['运行时路径不是文件。','请选择可执行文件或 CLI JS，而不是文件夹。'],
  'runtime-select-native-or-js-entry':['不支持 shell 包装脚本。','请选择原生可执行文件或 CLI JS；不会执行 cmd、bat 或 PowerShell 包装。'],
  'runtime-node-path-required':['CLI JS 入口缺少 Node 绝对路径。','在 Node 路径栏填写本机 node 可执行文件，再检查版本。'],
  'runtime-node-file-missing':['找不到指定 Node 文件。','核对 Node 路径或改用已安装的 Claude 原生可执行文件。'],
  'runtime-node-file-required':['Node 路径不是文件。','请选择 node 可执行文件，而不是文件夹。'],
  'runtime-host-required':['缺少本机运行时身份。','在当前桌面设备重新保存路径并检查版本；不能复用其他设备的路径。'],
  'runtime-sdk-version-mismatch':['SDK 与运行时记录的版本不一致。','核对当前插件与指定运行时，重新检查版本和能力；不自动全局升级。'],
  'sdk-cli-version-too-old':['Claude CLI 版本过旧。','此接入至少需要 2.1.248；请选择符合要求的运行时，再检查版本并重新测试能力。'],
  'sdk-version-start-failed':['无法启动版本检查。','检查文件路径与执行权限；JS 入口还需正确 Node 路径。没有调用模型。'],
  'sdk-version-timeout':['CLI 版本检查超时。','检查所选文件是否为正确 CLI；修正后主动重试，不会自动调用模型。'],
  'sdk-version-invalid':['未取得有效 CLI 版本。','检查所选文件能否正确返回版本；不要用普通程序或 shell 包装替代 CLI。'],
  'sdk-host-secret-storage-unavailable':['当前宿主不支持所需的安全凭据存储。','请使用支持 SecretStorage 的 Obsidian；不会把密钥降级写入 data.json。'],
  'sdk-credential-storage-failed':['专用凭据未通过安全存储回读检查。','没有保存新的配置引用或启用 SDK；旧配置保留。请检查宿主安全存储后主动重试，不会降级到 data.json。'],
  'sdk-credential-config-save-failed':['专用凭据的配置保存结果未确认。','请核对原配置与磁盘保存结果；本次新凭据可能已存入安全存储。不会自动启用、重写配置或借用其他密钥；确认状态后再主动处理。'],
  'sdk-credential-invalid':['专用凭据为空或格式无效。','重新填写所选服务商的专用 Key / Token，不超过 8192 字符，避免空格或换行；不会读取原 API Key。'],
  'sdk-credential-missing':['所选配置的专用凭据不可用。','重新保存该配置的专用凭据并主动测试；不会借用其他配置的密钥。'],
  'sdk-explicit-profile-credential-required':['所选配置没有专用凭据引用。','先为该配置保存专用 Key / Token，再主动运行能力测试。'],
  'sdk-test-consent-required':['尚未确认这次能力测试。','在确认栏输入“测试一次”，然后主动点击测试；此操作可能消耗模型额度。'],
  'sdk-text-tool-capability-failed':['文字与工具回环未通过。','核对端点、模型及工具支持；凭据是否有效需实际服务商响应确认。不会自动启用或换服务商。'],
  'sdk-capability-retest-required':['已测试能力与当前配置身份不匹配。','更换运行时、模型或服务商后请重新测试，再明确启用。'],
  'sdk-profile-changed-during-test':['测试期间服务商或模型配置已变化。','本次结果未用于启用；保存当前配置后主动重测。'],
  'sdk-runtime-changed-during-test':['测试期间本机运行时已变化。','核对当前路径与版本后主动重测，不使用旧测试结果。'],
  'sdk-switch-native-before-credential-change':['SDK 正在启用，暂不能更改凭据。','先明确点击“切回原 AI API”，修改专用凭据后重新测试再启用。'],
  'sdk-concurrency-limit':['已有任务占用了模型执行槽。','等待当前任务结束或主动暂停，再重新发起；不会排队后偷偷付费。'],
  'sdk-deferred-cost-budget-unconfirmed':['主查询金额尚未核清，已停止工具接续。','先核对执行回执；不会把未知消费当作零，不会自动重跑或扩大金额上限。'],
  'sdk-workflow-identity-changed':['文字工作流的配置或授权已改变。','检查当前模型配置、后台授权和长期记忆开关；旧任务不会自动迁到另一服务商。'],
  'sdk-memory-schema-invalid':['记忆提取结果格式不符合约定，未写入候选。','核对本次记录；不会降级为旧 API 或把无效结果当作成功。'],
  'sdk-disposed':['当前 SDK 控制器已关闭。','重新打开插件设置或任务入口；重载不会自动恢复付费调用。'],
  'sdk-load-failed':['SDK 模块未能加载。','核对插件安装是否完整；原 API 配置保留，不自动换后端。'],
  'sdk-extraction-model-capability-unknown':['独立提炼模型尚未验证。','首版先将提炼模型留空沿用已验证主模型；不能把接口兼容当作能力已通过。'],
  'sdk-input-budget-exhausted':['输入超过本次预算。','缩小任务范围或明确调整安全窗口；已完成结果保留。'],
  'sdk-output-budget-exhausted':['模型输出被长度上限截断。','不能标记完成；保留已确认结果，缩小分块或明确调整输出额度。'],
  'sdk-token-budget-exhausted':['已达到 token 预算。','查看实际用量，明确调整额度后再继续，不重置既有账本。'],
  'sdk-turn-budget-exhausted':['已达到 SDK 回合预算。','查看已保存结果和用量，明确调整额度后再继续。'],
  'sdk-cost-budget-exhausted':['已达到金额预算。','核对已知用量与未知消费；明确增加额度后才能继续。']
};
/** Never interpolate provider bodies, paths, tokens or unknown error messages. */
export function formatAgentSdkSetupError(error: unknown): string {
  const code = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  const known = Object.prototype.hasOwnProperty.call(errors, code) ? errors[code] : undefined;
  return known ? known[0]+' '+known[1]+'（'+code+'）' : '操作失败，未自动切换服务商或调用原 API。请核对当前配置、路径和保存状态；服务商原始错误内容未展示。';
}
