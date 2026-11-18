# 安装：让 DSH 的思考过程用简体中文

这是一个 DSH（DeepSeek Harness）插件：让 Agent 的**内部推理**用简体中文，
由三层组成——提示词引导 → 每轮重申 → 可选的分片并发翻译兜底。

## 你需要什么

- 已经装好并能正常运行的 DSH；
- Node.js（DSH 用户通常已有；没有的话见下面「没有 node 怎么办」）。

## 三步装好

1. 把收到的压缩包解压到一个**固定目录**。装好后 DSH 会引用这个目录，**别删、别移动**。
   建议路径不含中文与空格，例如 `D:\dsh-reasoning-zh`。

2. 安装（按你的系统任选一种）：

   | 你的情况 | 怎么做 |
   |---|---|
   | **Windows** | 双击解压目录里的 **`install.bat`**。若弹出「Windows 已保护你的电脑」，点「更多信息」→「仍要运行」 |
   | **macOS / Linux** | 在该目录执行 `./install.sh` |
   | 习惯命令行，或想先只看不改 | 先 `node install.mjs --check`，再 `node install.mjs` |

   脚本会自动找到 DSH 的数据目录和 profile（优先 `desktop`），装完打印每一步结果与 SHA256 校验。

3. **完全退出并重新打开 DSH**（桌面版要退出进程，不是只关窗口）。

装好后在对话框里输入 `/reasoning-zh` 回车，看到三层状态就成功了：

```
**dsh-reasoning-zh** v0.4.0 · 本进程已运行 0 分钟
| 层 | 状态 |
| ① 引导层（系统提示词段） | ✅ 已注册 |
| ② 重申层（每 turn pre-step） | ✅ 已挂载 |
| ③ 翻译层（llm/stream） | ✅ 已挂载 |
| 命令 | ✅ 已注册 |
```

## 安装脚本会改什么

| 位置 | 改动 |
|---|---|
| `<DSH_HOME>/profiles/<profile>/node_modules/dsh-reasoning-zh/` | 复制插件本体（**平铺真实目录**）|
| `<DSH_HOME>/profiles/<profile>/package.json` | 加 `dependencies` 与 `dsh.profile.bundles` 登记 |
| `<DSH_HOME>/profiles/<profile>/cordis.patch.yml` | 追加一段挂载行（已有同 id 的行则原样不动）|

`<DSH_HOME>` 默认是 `~/.dsh`（Windows 上是 `C:\Users\<你>\.dsh`）；
profile 默认优先 `desktop`（官方桌面壳）。

**它不会动你的其他配置**，也不会联网。

## 常用操作

```bash
node install.mjs --check              # 只校验：装了没、和当前目录是否一致
node install.mjs --profile headless   # 装到别的 profile
node install.mjs --home D:/my-dsh     # 手动指定 DSH 数据目录
```

**卸载**：删掉 `<DSH_HOME>/profiles/<profile>/node_modules/dsh-reasoning-zh`，
再从 `package.json` 与 `cordis.patch.yml` 里移除 `dsh-reasoning-zh` 相关内容即可。

## 常见问题

**装完没生效？**
1. 确认是「完全退出进程」再启动，不是只关窗口（插件只在启动时加载）；
2. 输入 `/reasoning-zh` 看它返回什么——命令本身就是诊断入口；
3. 重新跑 `node install.mjs --check` 看逐文件校验结果。

**没有 node 怎么办？**
DSH 自带 Node，通常在这个位置附近：`<DSH_HOME>/dsh-runtimes/dsh-primary-runtime/`；
也可以从 <https://nodejs.org> 装一个 LTS 版。

**思考还是英文？**
- 先看 `/reasoning-zh` 的「本进程统计」：如果**跳过**很多、翻译很少，说明模型本来就大多在用中文思考（正常）；
- 如果一直不翻，检查配置里的 `translate` 是否为 `true`。**0.4.0 起包自带挂载行和代码默认值都是 `false`**；需要翻译层时必须显式打开；
- 不需要翻译层时保持默认 `false`，只保留提示词引导，不产生任何额外调用。

**改了配置怎么生效？**
改的是 profile 里那段 `config:`，**改完要重启 DSH**（插件只在启动时读配置）。

## 隐私与成本

- 插件本体**零运行期依赖**；默认配置不发起任何网络请求；
- **唯一的联网行为**是可选的翻译兜底：当某段思考是英文时，调用一次模型（默认 `deepseek-chat`）翻成中文。
  中文思考会被自动跳过（不花钱）；默认 `translate: false`，不会发起任何额外调用；
- **翻译层会把完整的思考内容**（可能含源码、文件路径、工具返回内容）发给 `translateModel`。
  如果这对你是问题，保持默认 `translate: false`。

## 更多

完整配置项、验证方法与设计说明见同目录的 [README.md](./README.md)。
