# 安装与真机部署

## 0. 环境要求

| 项 | 要求 |
| --- | --- |
| 酒馆 | TauriTavern（推荐）或 SillyTavern ≥ 1.13.0 |
| 酒馆助手 | 编辑模式必需（生成与结构化输出）；对话模式与基础世界书写入不需要 |
| 网络 | 走 CDN 安装时需要能访问 `testingcf.jsdelivr.net` |

---

## 1. 手机（TauriTavern / 安卓）

### 1.1 方式 A：酒馆助手脚本（最省事）

1. 酒馆助手 →「脚本库」→「导入脚本」。
2. 选择仓库里的 `tavern-helper/if-enhancer-script.json`（或把它的内容整体粘贴进导入框）。
3. 导入后脚本处于**关闭**状态 —— **必须手动打开**（酒馆助手导入脚本时一律默认 `enabled: false`）。
4. 刷新页面（或重开酒馆）。
5. 输入框上方出现「💬 对话 ｜ ✏️ 编辑」即成功。

若没有出现：

- 打开开发者控制台，搜索 `[IF Enhancer]`。
- 出现 `扩展本体加载失败` → 网络问题，改用方式 B。
- 出现 `已加载过，跳过重复初始化` → 已有另一份副本在跑，属正常。

### 1.2 方式 B：扩展目录（离线可用）

把仓库文件夹整体拷进：

```
<酒馆数据目录>/data/default-user/extensions/tauritavern-if-enhancer/
```

需要包含 `manifest.json`、`index.js`、`style.css`、`src/`、`profiles/`、`skills/`。
之后在「扩展」面板中启用「互动小说增强系统」，刷新页面。

安卓上可用文件管理器（部分机型需配合 Shizuku / MT 管理器）访问应用数据目录；
也可以先用方式 A 跑起来，再决定是否落地本地副本。

### 1.3 方式 C：从 URL 安装

「扩展」→「安装扩展」→ 粘贴仓库地址。该操作在服务端执行 `git clone --depth 1`，
并把**仓库根目录**作为扩展目录，因此 `manifest.json` 必须在仓库根（本仓库满足）。

---

## 2. 桌面（SillyTavern）

与手机一致，扩展目录通常为：

```
<SillyTavern>/data/default-user/extensions/tauritavern-if-enhancer/
```

桌面端更适合用方式 C，便于自动更新。

---

## 3. 首次配置

1. 打开「扩展」设置区，找到「互动小说增强系统」。
2. 点「刷新诊断」，确认：
   - 酒馆助手 ✓
   - 文本生成 ✓（若显示 △ 说明走了 `/genraw` 回退）
   - 世界书后端 ✓
3. 选择世界书写入目标（默认「聊天级世界书」），必要时填写名称模板。
4. 点「检查世界书」确认可读可写。
5. 点「自检：执行一条示例编辑指令」，应返回一条「已整理剧情与长期记忆」或「暂不需要整理」的回执。

---

## 4. 手机端远程自检（adb 无线调试）

手机上没有开发者工具，因此本扩展把排障信息写进**可被 adb 读取的文件**。

### 4.1 连接

手机端：设置 → 开发者选项 → 无线调试（保持开启），记下 `IP:端口`。
电脑端（需 platform-tools）：

```bash
adb connect 192.168.x.x:<无线调试端口>
adb devices -l
```

脚本 `tools/remote-connect.ps1` 封装了「连接 → 拉取诊断 → 打印结果」的常用动作（见下文）。

### 4.2 TauriTavern 的数据目录

与 SillyTavern 同构，且位于**外部存储**，adb 可直接读写：

```
/sdcard/Android/data/com.tauritavern.client/data/
├── default-user/
│   ├── settings.json            ← 扩展设置与诊断快照都在这
│   ├── tauritavern-settings.json ← TT 自己的设置（含 dev.frontend_console_capture）
│   ├── extensions/              ← 第三方扩展（git clone 或直接放文件夹）
│   ├── worlds/                  ← 世界书 JSON
│   ├── chats/ characters/       ← 聊天与角色卡
└── /logs/tauritavern.log.<日期>  ← TT 后端日志 + 前端 console 错误
```

### 4.3 读开机自检（最省事的排障方式）

扩展每次启动都会把挂载结果写进自己的设置：

```bash
adb pull /sdcard/Android/data/com.tauritavern.client/data/default-user/settings.json
# 看 extension_settings.tt_if_enhancer.diagnostics
```

关键字段：

| 字段 | 含义 |
| --- | --- |
| `modeBar` / `modeButtons` / `modeBarText` | 模式条是否挂上、按钮数量与文案 |
| `dock` / `sendForm` / `textarea` | 落点容器与输入框是否存在 |
| `tavernHelper` / `generateRaw` / `jsonSchema` | 酒馆助手与生成通路能力 |
| `jsonSchemaDegraded` | 是否为 true：供应商不支持结构化输出，已降级为文本+修复 |
| `backend` | 世界书后端（`tavern-helper` 或 `st-endpoint`） |
| `boot` | `ok` 或 `failed`（failed 时附带 `error`） |

也可在酒馆「扩展 → 互动小说增强系统 → 诊断」里直接看到同一份快照。

### 4.4 看前端控制台

TT 默认只把前端 **错误** 写进日志；需要完整 console 时，把
`tauritavern-settings.json` 里的 `dev.frontend_console_capture` 改成 `true`（改完重启应用）：

```bash
adb pull .../default-user/tauritavern-settings.json
# 把 dev.frontend_console_capture 改为 true 后推回
adb push tauritavern-settings.json .../default-user/tauritavern-settings.json
adb shell am force-stop com.tauritavern.client
adb shell am start -n com.tauritavern.client/.MainActivity
```

前端日志会以 `INFO frontend: [main] …` 出现在 `logs/tauritavern.log.<日期>`；
未开启时错误仍会以 `ERROR frontend: [main] …` 记录。**排障完记得改回 `false`**。

### 4.5 端到端自检（无人值守）

两套工具，任选其一；都会把结果写进扩展设置，可用 adb 读取。

**A. 酒馆助手脚本版**（无需 adb 写文件，手机会自动跑）
把 `tools/remote-self-test.js` 的内容导入「酒馆助手 → 脚本库」并启用，重载页面。
它会：读取诊断 → 把写入目标临时切到「IF-Enhancer-自检」世界书 → 跑一次记忆整理与一次正文演绎
→ 删除测试产生的聊天回复 → 还原写入目标，结果写入 `extension_settings.tt_if_enhancer.selfTest`。

**B. 临时扩展版**（可在没有打开聊天时测试资料类任务）
把 `tools/remote-selftest-extension/` 整个文件夹推到
`.../default-user/extensions/tt-if-selftest/`，重启应用。
它会在主扩展就绪后依次执行世界书写入、创建人物、无聊天正文三条路径，
结果写入 `selfTest2/3/…`。**验证完请删除该文件夹。**

### 4.6 一个可复现的真实问题（供对照）

真机上曾出现「世界书写入失败」：模型返回 Markdown 而不是 JSON。
最终定位为供应商 API 拒绝 `response_format`：

```
[API 错误] This response_format type is unavailable now
```

且该错误以正常文本返回、不抛异常。修复后扩展会自动降级并把结论记进设置
（`extension_settings.tt_if_enhancer.jsonSchemaUnsupported = true`）。
遇到同类现象先看这个字段，再决定是否点「重新尝试结构化输出」。

---

## 5. Tailscale 与真机调试（可选）

Tailscale 只负责让电脑与手机在同一个 Tailnet 内互通，
**不等于**能直接操作安卓上酒馆的内部数据。三条链路要分别验证：

| 链路 | 验证方式 |
| --- | --- |
| 网络可达 | 电脑 `tailscale status` 能看到手机；手机浏览器能打开电脑上的服务 |
| 扩展安装 | 用方式 A 或 B 在手机上装好，刷新后界面出现模式条 |
| 数据写入 | 在编辑模式说「收录张婆」，回执显示写入条数；在桌面酒馆里同一份数据能看到该条目 |
| 远程调试 | 见下 |

### ADB 日志

```bash
adb devices
adb logcat -v time | grep -iE "tauri|tavern|chromium|console"
```

WebView 内的 `console.log` 通常会进入 logcat 的 chromium 通道，可用关键字过滤：

```bash
adb logcat -v time | grep -iE "IF Enhancer|chromium.*console"
```

更细的前端调试：Tauri 应用在调试构建下可开启 WebView 远程调试，
再用桌面 Chrome 的 `chrome://inspect` 连接（需要设备端允许）。

### 注意事项

- 正式使用时，安卓端应能**独立运行**，不依赖电脑开机；
  Tailscale 只用于开发期传输与排查，不要让它成为运行期依赖。
- 如果扩展从 CDN 加载，断网时会失效 —— 这是方式 A 的固有限制，需要离线可用就选方式 B。

---

## 6. 常见问题

| 现象 | 原因与处理 |
| --- | --- |
| 输入框上方没有模式条 | 脚本未启用（导入后默认关闭）；或宿主未就绪 —— 刷新页面 |
| 编辑模式点发送后没有反应 | 打开控制台看 `[IF Enhancer]` 报错；确认酒馆助手已启用 |
| 编辑模式的消息被当成主角台词发出 | 说明模式条未生效（脚本未启用）；此时消息已进入聊天，用酒馆自带的删除即可 |
| 回执显示「当前环境没有可用的世界书写入后端」 | 酒馆助手世界书 API 与 `/api/worldinfo/*` 都不可用；检查酒馆版本或扩展启用状态 |
| 回执显示校验未通过、未写入 | 条目关键词或正文违反规范；展开回执查看具体条目与原因，按提示修正后重试 |
| 写入了但生成时不生效 | 检查条目是蓝灯（常驻）还是绿灯（关键词触发）；绿灯需要聊天里出现对应关键词 |
| 长期摘要里还留着被推翻的旧事实 | 在编辑模式明确否定该事实（例如「坡子口不存在大量修仙高手」），系统会连带纠正记忆与世界书 |
