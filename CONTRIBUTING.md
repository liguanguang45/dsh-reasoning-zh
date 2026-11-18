# 贡献指南

感谢你考虑改进 `dsh-reasoning-zh`。这是一个运行期零依赖的 DSH 插件，
改动面不大，但对提示词、流协议和 profile 安装的细节比较敏感。

## 环境

- Node.js **>= 22.19**（CI 覆盖 Node 22 / 24）。
- DSH **>= 0.2.2-rc.3**（本地验证版本）。
- 运行期零依赖；`dependencies` 保持 `{}`。`@deepseek-ai/dsh-llm` 与 `schemastery`
  是可选 peer，解析不到时插件会走内置等价实现。

## 开发与测试

```powershell
node --check lib/index.js
node test/run-all.mjs
```

改完代码后要同步到 profile，并**完全退出再重启 DSH**，桌面壳不会热加载新依赖：

```powershell
node scripts/install-into-profile.mjs
node scripts/install-into-profile.mjs --verify
```

只想联调、不安装时，可以用源码 overlay：

```powershell
dsh web --patch mount/dev.cordis.yml
```

## 提交要求

- 新行为要有测试；当前基线是 62 项全绿。
- 不要提交 `dist/`、`*.log`、`*.stats.json`、`.verify/`、`node_modules/`、
  `*.tgz` 或本机路径。
- 测试里只使用假路径（例如 `C:/Users/x`），不要放真实用户名、邮箱或目录。
- 如果改变默认配置、隐私行为或安装方式，同步更新 `README.md` 和 `CHANGELOG.md`。
- 保持零依赖；不要为了一个小功能引入运行时包。
- 注释和文档使用中文，代码标识符保持英文。

## Pull Request

请在 PR 描述里写清：动机、变更点、测试命令与结果、是否影响默认配置或数据外发。
提交 PR 即表示你同意以 [MIT](LICENSE) 许可贡献这些改动。

## 报告问题

用 GitHub Issue 模板。安全问题不要开公开 Issue，按 [SECURITY.md](SECURITY.md) 私密报告。
