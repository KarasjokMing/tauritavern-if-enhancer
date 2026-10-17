# NOTICE · 来源与授权说明

本仓库整体以 MIT 许可发布（见 [LICENSE](LICENSE)）。以下说明各部分内容的来源与授权状态。

## 1. 本仓库自有的全部代码与文档

`index.js`、`src/**`、`style.css`、`manifest.json`、`profiles/**`、`skills/**`、
`tavern-helper/**`、`tools/**`、`tests/**`、`docs/**`、`README.md`

Copyright (c) 2026 KarasjokMing，MIT 许可。

## 2. 世界书条目规范：独立实现（clean-room）

`src/worldbook/spec.js`、`derive.js`、`lint.js`、`builder.js` 中的条目分类、阈值表、
位置分组、顺序推导与质量校验规则，是**依据公开接口事实独立实现**的，包括：

- SillyTavern 世界书（World Info）的公开字段名与数字枚举
  （`key` / `keysecondary` / `comment` / `position` / `selectiveLogic` / `role` 等）；
- 通用写作质量常识（破折号滥用、八股微表情、模糊限定词、元叙事泄漏、繁简统一）；
- 检索与触发行为的通用工程判断（单个汉字关键词会误触发、泛用职务词会误触发）。

这些属于**接口事实与通用规则**，不构成对任何第三方文档文本的复制。

### 未采用的内容

编写本扩展时参考过下列公开项目，用于理解需求与规范结构，但**没有复制其正文文本、提示词或代码**：

| 项目 | 用途 | 授权状态与处理 |
| --- | --- | --- |
| [yukk4159-bit/charcard-workshop](https://github.com/yukk4159-bit/charcard-workshop) | 参考其世界书条目分类、配置项结构与生成流程的**组织方式** | 该仓库 MIT 仅覆盖其自身结构与文档；其 `skills/` 下的 skill 正文权利属于各自作者（`tavern-*` 上游注明「仅供个人使用，二次修改需注明出处」，其余 bundle 未附许可）。**因此本仓库不复制其任何 skill 正文，只做独立实现**，并在本节声明来源关系。 |
| [N0VI028/JS-Slash-Runner](https://github.com/N0VI028/JS-Slash-Runner)（酒馆助手） | 使用其公开 API 与 `@types` 声明 | 仅按公开 API 调用，未复制其源码。 |
| [SillyTavern](https://github.com/SillyTavern/SillyTavern) / [TauriTavern](https://github.com/Darkatse/TauriTavern) | 使用公开扩展清单格式、事件与宿主 API | 仅按公开接口调用，未复制其源码。 |

如果上游作者认为本仓库的独立实现与自身权利存在冲突，请开 issue 联系，我们会调整或移除相关内容。

## 3. 提示词内容

`src/prompts.js` 中的全部提示词文本、`skills/interactive-fiction/SKILL.md`、
`profiles/*.json` 中的系统提示词，均为本仓库原创，按 MIT 发布。

## 4. 依赖

运行时不依赖任何第三方 npm 包；浏览器端只使用酒馆与酒馆助手已注入的全局对象
（`SillyTavern`、`TavernHelper`、`toastr` 等）。
开发期的 `tools/` 与 `tests/` 脚本仅使用 Node.js 内置模块。

## 5. 免责声明

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED,
INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR
PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE
FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
DEALINGS IN THE SOFTWARE.

本扩展会**写入你的世界书**（新增或更新条目）。写入后端一律采用「读 → 合并 → 写 → 回读」，
但请自行做好世界书备份；作者不对数据丢失负责。
