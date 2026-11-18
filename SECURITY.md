# 安全政策

## 支持版本

`0.4.x` 接收安全修复；更早版本请先升级。

## 报告漏洞

请使用 GitHub 的 **Security Advisories**（仓库 → Security → Report a vulnerability）
私密报告，不要开公开 Issue。如果该入口不可用，请通过 GitHub 私信维护者
[@liguanguang45](https://github.com/liguanguang45)。

报告里请包含：受影响版本、复现步骤、影响范围，以及你认为的修复方向。
不要在报告或 Issue 中粘贴完整 reasoning、API key、私有路径或会话日志原文。

## 已知的设计边界

- 开启 `translate: true` 后，完整 reasoning 会发给 `translateProvider` / `translateModel`。
  这是翻译层的功能前提，不是漏洞；请先确认 provider 的数据保留政策。
- 默认 `translate: false`，只启用提示词引导与每轮重申，不发起额外模型调用。
- `verboseFile` / `statsFile` 默认空；一旦配置，内容会落盘，请使用私有路径。

## 响应

维护者会尽力在 7 天内确认报告；确认后尽快发布补丁版本，并在 Release Notes 中说明。
