# G0 · 本机测试 Profile 与模型

本轮已确认使用 **Gemini 3.8 Flash**。试验限定为单一专用个人 Profile、一次能力发现和一次 20 秒有限后台复现。测试目录 `D:\HarnessMate\agy-np-test-profile` 关闭 Windows ACL 继承，仅当前 Windows 用户有权限。`gemini` 存放此测试登录状态，`runs` 存放隔离会话和临时日志。每次 Probe 会创建一个 D 盘独立工作目录。

## 当前状态

1. 目录已准备。空白专用 Profile 的 ACP 会话返回 `-32000`，等待个人账号完成官方交互登录。[空白 Profile 证据](../evidence/g0-test-profile-clean.ndjson)保持受测账号的标准权限设置，并在运行前确认实际模式。需要审批的场景以 manual/default 为准。
2. 使用授权发现路径创建专用会话，取得模型与命令声明。`--discover-confirmed` 不发送模型 Prompt。
3. 从 `session-new.config` 的 model 条目取实际 `current` 或 `publicValues` 中的 Gemini 3.8 Flash ID。开始 reactive 测试时显式传入该 ID。Probe 会核对当前值，或从对端广告项设置并等待确认。若该 Profile 没有广告指定型号，测试在发 Prompt 前结束，记录原因。
4. 在 PowerShell 终端按提示查看确认过的型号和完整测试任务，键入 `YES` 提交一次。逐项检视原生审批。采样只覆盖这次运行，未完成的服务端请求保留在证据中。

## 执行命令

在 PowerShell 交互终端进入 `D:\HarnessMate\agy-np-worktrees\np-01`。以下每个步骤根据上一阶段结果分别执行。登录走官方 CLI 终端流程，回填仅在官方交互中处理。

~~~powershell
$testRoot = 'D:\HarnessMate\agy-np-test-profile'
$profile = Join-Path $testRoot 'gemini'
$scratch = Join-Path $testRoot 'runs'
$env:TEMP = Join-Path $testRoot 'temp'
$env:TMP = $env:TEMP
$env:TMPDIR = $env:TEMP
$agy = (Get-Command agy.exe).Source
$probe = 'docs\phase-agy-native-parity\evidence\probe-acp.mjs'

node $probe --agy $agy --scratch $scratch --test-profile $profile --login-test-profile

node $probe --agy $agy --scratch $scratch --test-profile $profile --discover-confirmed

$modelId = '<本账号实际广告的 Gemini 3.8 Flash ID>'
node $probe --agy $agy --scratch $scratch --test-profile $profile --reactive-confirmed --model $modelId
~~~

Login、Discovery、Reactive 启动使用同一测试 `--gemini-dir`/`--app-data-dir` 和隔离环境。Login 使用官方原始交互。Discovery 与 Reactive 只将脱敏摘要写到 stdout。调试日志单独留在 `runs`，审批交互和登录提示不进入共享证据。Provenance 与结果填入 [协议证据](../06_Protocol_Evidence.md) 所述记录。

[当前决策](../15_Decision_Log.md#g0-启动确认) · [测试策略](../12_Test_Strategy.md) · [首批任务](../11_Parallel_Development_Plan.md)
