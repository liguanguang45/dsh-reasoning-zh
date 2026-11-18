# Changelog

本项目的变更记录，格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [0.4.0] - 2026-11-18

### Added

- `/reasoning-zh` 增加取消、无变化、重试、有效翻译统计；`translate()` 返回
  `ok` / `cancelled` / `failed`，用户取消不计失败、不喂熔断。
- `maxConcurrency`（默认 4）与 `retry`（默认 0，指数退避）；长块分片并发受上限约束，
  用户取消可以打断退避等待。
- `locale/en.json`、`locale/zh.json`、`icon.svg`、`LICENSE`（MIT）和 62 项测试。
- 混合语言判定：汉字占比 + 假名否决 + 自然语言英文词兜底；`no-op` 检测避免“中文翻中文”。

### Changed

- **默认 `translate: false`**：只开提示词引导与每轮重申，不发起额外模型调用，
  也不把 reasoning 发给翻译服务。
- 命令注册收敛为“同步尝试 + `ctx.inject`”，仅在无 `ctx.inject` 时挂 `agent/created` 兜底。
- 每个 agent 的提示词中间件改用 `ctx.effect` 注册，插件卸载时释放。
- `statsFile` 读-改-写加 `<file>.lock` 串行化，避免多会话统计互相覆盖。
- 翻译同时累加 `text-delta` 与 `reasoning-delta`，优先使用 text。

### Fixed

- 用户取消被误计为失败并触发熔断。
- 并发 flush 导致 stats 丢失增量；无锁时跳过并保留增量。
- 混合语言块被误判为“已是中文”而跳过翻译。
- 只统计 `text-delta` 导致部分 provider 的翻译输出为空。
- 译文与原文相同仍计为有效翻译、浪费统计。

### Security

- 默认不外发 reasoning；开启翻译层前需显式确认数据外发范围。
- `verboseFile` / `statsFile` 默认空，避免敏感日志意外落盘。

## [0.3.1] - 2026-10-07

- 首个可用版本：三层结构、分片并发翻译、失败熔断、`/reasoning-zh` 状态与配置校验。

[0.4.0]: https://github.com/liguanguang45/dsh-reasoning-zh/releases/tag/v0.4.0
[0.3.1]: https://github.com/liguanguang45/dsh-reasoning-zh/releases/tag/v0.3.1
