# AGY Native Parity — NP-16 Reproducible T18 Benchmark Suite

本目录包含可复跑、可单提交撤销的 T18（10,000 events / 100 agents / 20 pending requests）性能与资源基线脚本。

## 安全与隔离约束

- 不连接真实 Google 账号，不读取生产 `~/.gemini`，不启动真实模型配额任务。
- 临时 SQLite、WAL、bundle 与报告文件默认写入 D 盘临时目录（优先 `HM_BENCH_TMP` 或 `D:\AppDataCache\np16-bench`），并在结束时清理临时目录。
- 所有阈值以**实测样本与环境元数据**输出，不预设或虚构阈值，也不从合成规模推断真实模型质量。

## 运行方式

先完成工作区构建：

```powershell
pnpm build
```

然后执行全量基线（Daemon + Web）：

```powershell
$env:TEMP = "D:\AppDataCache\np16-tmp"
$env:TMP = "D:\AppDataCache\np16-tmp"
node scripts/agy-np/bench/run-bench.mjs --samples 3 --out scripts/agy-np/bench/baseline-latest.json
```

仅运行 Daemon 侧或仅运行 Web 侧：

```powershell
node scripts/agy-np/bench/run-daemon-bench.mjs --samples 3
node scripts/agy-np/bench/run-bench.mjs --web-only --samples 3
```
