# 世界书条目规范（本扩展的实现口径）

本文件描述扩展**实际执行**的条目规范。代码是权威实现，见 `src/worldbook/spec.js`、
`derive.js`、`lint.js`。规范为独立实现，来源与授权见 [`../NOTICE.md`](../NOTICE.md)。

---

## 1. 条目类型与子类

| 类型 | 子类（part） | 承载信息 | 边界 |
| --- | --- | --- | --- |
| 世界观 | — | 世界规则、力量体系、社会结构、历史背景 | 不含具体区域与角色；只写会让 AI 出错的差异信息 |
| 扮演准则 | — | 叙述风格、禁止行为、语气要求 | 写「怎么演」，不写「是什么」 |
| 地理 | `region` / `scene` / `faction` | 区域概览 / 场景详情 / 势力详情 | 势力跨多个场景时独立成条 |
| 时间线 | `history` / `plot` | 历史节点 / 当前剧情进度 | 世界观写规则，时间线写事件序列 |
| 角色 | `basic` / `personality` / `tri_faceted` | 基础档案 / 性格 / 压力下的不同表现 | 每个核心角色至少 `basic` |
| NPC | — | 功能性配角的简要信息 | 不写完整人设；信息量到角色级时升级类型 |
| 事件 | — | 单次或条件触发的事件 | 不是事件序列 |
| 阶段指导 | — | 阶段化玩法的主持策略 | 需要条件渲染时由 EJS 承担 |

物品归属：世界规则级 → 世界观；区域/势力专属 → 地理 `faction`；
角色专属 → 角色 `basic`；其余按出现时机归入时间线 `plot`。

---

## 2. 蓝灯 / 绿灯自动推导

阈值表（`STRATEGY_THRESHOLDS`）：

| 类型 / 子类 | 阈值 | 含义 |
| --- | --- | --- |
| 世界观 / 扮演准则 / 阶段指导 | `Infinity` | 恒为蓝灯（常驻） |
| NPC / 事件 | `0` | 恒为绿灯（关键词触发） |
| 角色 `basic` | 5 | 同子类条目数 ≥ 5 时转绿灯 |
| 角色 `personality` / `tri_faceted` / `other` | 2 | 同上 |
| 地理 `region` / `scene` / `faction` | 4 | 同上 |
| 时间线 `history` / `plot` | `Infinity` | 恒为蓝灯 |

计数规则：

- `scope: catalog`（速览级）恒为蓝灯，且**不参与计数**；
- `rephrase: true`（重述级）**不参与计数**，且位置强制 `at_depth`；
- 显式给出 `constant` 时以显式值为准。

---

## 3. 注入位置与顺序

位置推导（按 `TYPE_LISTS` 分组，首个命中即停）：

| 分组 | 类型 | 推导结果 |
| --- | --- | --- |
| `before_char` | 世界观、扮演准则、时间线、地理 | `before_character_definition` |
| `after_char` | 角色、NPC | `after_character_definition` |
| `depth` | 事件、阶段指导 | `at_depth`（`depth=0`，`role=system`） |
| 重述级条目 | 任意 | 强制 `at_depth` |

顺序推导（`deriveOrder`）：

1. 先按注入分组的先后（`before_char` → `after_char` → `depth`）排序；
2. 同组内按子类顺序（如地理 `region` → `scene` → `faction`）排序；
3. 从 10 开始，组内逐条 +1；跨分组或跨类型时跳到下一个整十数；
4. 重述级条目单独收集，**逆序**追加到末尾。

数字越小越先注入。

---

## 4. 关键词规则

| 类型 | 关键词模板 |
| --- | --- |
| 角色 | 角色名 + 昵称 + 外号 |
| NPC | NPC 名 + 昵称 + 外号 + 具体职务 |
| 地理 | 名称 + 简称 + 所在地名 |

会被校验拦截或标记的情况：

| 级别 | 情况 | 处理建议 |
| --- | --- | --- |
| 错误 | 单个汉字关键词（`樱`） | 改为两字以上（`小樱`） |
| 错误 | 既非常驻又没有关键词 | 补关键词或改为常驻 |
| 警告 | 泛用职务（`老师`、`会长`） | 具体化（`语文老师`、`学生会长`） |
| 警告 | 常见成语（`倾国倾城`） | 改用该对象独有的名称 |
| 警告 | 人物条目关键词不含人物名 | 把人物名本身加入 |
| 警告 | 与其他条目关键词重复 | 改用更精确的词组 |

---

## 5. 正文写法

- **数据库格式，不是散文**：键值对与列表，避免长段落。
- 只写偏离默认认知的信息；真实世界里 AI 已知的内容不写。
- 外貌写特征不写美：「遮住名字还能认出是谁」。
- 背景写关键经历不写编年史：删掉它，角色行为会不会变？不会就删。
- 语料只保留纯对话，去掉动作、表情与心理描写。
- **不写占位符**（「某城市」「某组织」）；不确定时标注需要作者确认。
- 统一简体中文。
- **禁止跨条目引用**（「详见某条目」「与某条目配套」）：每条必须独立可读。
- 条目正文建议不超过 2400 字，超过时拆分。

---

## 6. 质量校验清单

`lintEntry` 会检查：

| 代码 | 级别 | 含义 |
| --- | --- | --- |
| `NAME_EMPTY` / `NAME_TOO_LONG` / `NAME_DUPLICATE` | 错误/警告 | 名称缺失、过长、重复 |
| `TYPE_UNKNOWN` / `PART_MISSING` / `PART_INVALID` | 警告 | 类型或子类不规范 |
| `CONTENT_EMPTY` / `CONTENT_TOO_SHORT` / `CONTENT_TOO_LONG` | 错误/警告 | 正文缺失或长度异常 |
| `NO_TRIGGER` | 错误 | 永远不会注入 |
| `KW_SINGLE_CJK` / `KW_GENERIC` / `KW_IDIOM` / `KW_NAME_MISSING` / `KW_DUPLICATE` | 错误/警告 | 关键词问题 |
| `CONSTANT_KEYS` | 提示 | 常驻条目配了关键词（不生效） |
| `DASH` | 错误 | 出现破折号（`——`） |
| `META_LEAK` | 错误 | 混入制作说明/元叙事 |
| `CLICHE` / `VAGUE` | 警告 | 八股表达、模糊限定词 |
| `PLACEHOLDER` | 警告 | 占位符 |
| `TRADITIONAL` | 警告 | 繁体/日文汉字（给出映射） |
| `CROSS_REFERENCE` | 警告 | 引用了其他条目 |
| `DB_FORMAT` | 警告 | 像散文而不是数据库条目 |
| `DEPTH_NONZERO` | 警告 | 深度条目 `depth ≥ 1` |
| `PROBABILITY_RANGE` | 错误 | 触发概率越界 |

「校验不通过时阻止写入世界书」可在设置中开启；默认只提示不阻塞。

---

## 7. 长期记忆

固定五段，写为世界书里的常驻条目：

```
[记忆] 剧情摘要      （仍然有效的事实，简短按序）
[记忆] 当前场景      （地点 + 在场人物）
[记忆] 人物状态      （位置、状态、关系变化，各一行）
[记忆] 未完成线索    （尚未回收的钩子）
[记忆] 已纠正事实    （被推翻或被作者否认的事实，留痕不删除）
```

维护原则：

- 只保留仍然有效的事实；被推翻的移入「已纠正事实」，保留更正日期。
- **作者修改优先**：作者否定某项设定后，正文、世界书与记忆必须一起改，
  不允许一处改而另一处继续保留旧事实，也不允许叠加相互矛盾的设定。
- 触发方式：按回复条数间隔（默认每 12 条）、场景变化（规划中）或编辑模式手动。

---

## 8. SillyTavern 字段映射

内部条目 ↔ 扁平世界书（`/api/worldinfo/*` 与独立世界书文件）：

| 含义 | 内部字段 | 扁平字段 |
| --- | --- | --- |
| 条目顺序 | `order` | `order` |
| 位置 | `position`（名称） | `position`（数字 0-6） |
| 启用 | `enabled` | `disable`（取反） |
| 关键字 | `keys` | `key` |
| 次要关键字 | `secondaryKeys` | `keysecondary` |
| 选择逻辑 | `selectiveLogic`（名称） | `selectiveLogic`（数字 0-3） |
| 常驻/触发 | `constant` | `constant` + `selective` |
| 深度与角色 | `depth` / `role` | `depth` / `role`（数字） |
| 概率 | `probability` | `probability` |

位置数字：`before_character_definition`=0、`after_character_definition`=1、
`before_author_note`=2、`after_author_note`=3、`at_depth`=4、
`before_example_messages`=5、`after_example_messages`=6。

选择逻辑数字：`and_any`=0、`not_all`=1、`not_any`=2、`and_all`=3。

角色数字：`system`=0、`user`=1、`assistant`=2。

使用酒馆助手世界书 API 时改用新结构（`strategy` / `position` / `recursion` / `effect`），
由 `src/worldbook/adapter.js` 双向转换。
