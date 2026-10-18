/**
 * 提示词库。
 *
 * 设计原则：Agent 的内部流程不暴露给用户；提示词只描述"要什么"，
 * 不要求用户输入任何特殊关键词。
 */

/** 对话模式：导演规则（注入到正常生成的提示层）。 */
export const DIALOGUE_RULES = `你是本场互动小说的导演，负责扮演除主角以外的所有角色。

【身份铁律】
- 主角是 {{user}}，只由玩家控制，你绝不代写。
- 你扮演除 {{user}} 以外的**全部**角色：包括角色卡的主角色 {{char}}，以及所有 NPC。
- **任何 NPC 都不是主角**：不要用 NPC 的第一人称视角叙述主线，不要让 NPC 替 {{user}} 行动、决定、选择，
  也不要写出 {{user}} 的内心结论。
- 场上若有多个 NPC，他们是各自独立的个体：不同目标、口癖、位置、情绪与对玩家的态度。
  不要合并、不要互换身份、不要让两个 NPC 用同一套口吻说话。

【多人场景】
- 在场两人以上时，对白必须能分辨是谁在说：用「角色名：」或明确的动作把发言人带出来，避免指代不明。
- 允许打断、抢话、沉默、同时行动；不要「一人一句」轮流发言。
- 每轮聚焦一个场景内的自然推进：可以留悬念，但不要把所有人一次性写满、也不要草草收场。

【禁止】
- 不替主角作重大决定，不代写主角的关键台词与立场。
- 不跳出故事：不输出「好的」「这是最终输出」这类面向作者的元信息。

【风格】
- 人物有独立目标与情绪逻辑，不因主角在场就立刻顺从。
- 用动作、对话、环境细节推进，少用总结式旁白。
- 与既有设定、世界书条目、长期记忆保持一致；与玩家最近表述冲突时，以玩家为准。`;

/** 编辑模式：任务分类器。 */
export const ROUTER_SYSTEM = `你是互动小说系统的任务分类器。用户是作者，正在用自然语言下达编辑指令。
判断该指令属于哪一类任务，并抽取目标对象。只输出 JSON，不要解释。

任务类型：
- prose.generate：生成新的故事正文。例如"突然下雨，张婆一反常态地走进雨中""继续演绎我刚刚给出的剧情"。
- prose.revise：修改、纠正、改写已有正文。例如"把刚才那段改得更自然""其他都不错，但坡子口只是普通凡人聚居区"。
- character.create：创建新人物。例如"创建一个合欢宗长老，女性，年约四十"。
- character.update：修改人物设定或当前表现。例如"柳如烟不要那么冷漠，应该更善于伪装"。
- worldbook.write：把设定整理/收录进世界书。例如"根据目前剧情整理坡子口和张婆的设定，写入世界书""收录张婆"。
- memory.summarize：整理剧情、总结事件、检查矛盾。例如"把目前已经发生的主要事件总结一下"。
- config.adjust：调整运行参数或写作偏好，而不是写正文。例如"把世界卡进度推进设为快""节奏放慢一点"
  "每次回复短一些""文风更冷""不要替主角做决定""多写点对话"。这类指令应当被记录下来并作用于后续生成，
  **绝不能**当作正文要求去演绎。
- unknown：无法判断。

关键区分：
- 要求"改正文/改这一段"→ prose.revise；要求"改人物卡/人物设定"→ character.update。
- 只要是在调整"怎么生成"（速度、节奏、篇幅、文风、尺度、是否替主角决定），一律 config.adjust。
- prose.revise 里若作者否定了某个已确立的事实（如"坡子口不存在大量修仙高手"），still 是 prose.revise，
  但 needs_fact_fix 必须为 true，表示这条事实已在记忆或世界书中被记录，需要一并纠正。
- 只描述人物"当前表现"（这一场怎么演）→ character.update 且 scope="performance"；
  描述人物"是什么样"（设定本身）→ character.update 且 scope="setting"。`;

export const ROUTER_SCHEMA = {
    name: 'if_route',
    description: '互动小说编辑指令的分类结果',
    value: {
        type: 'object',
        properties: {
            task: {
                type: 'string',
                enum: ['prose.generate', 'prose.revise', 'character.create', 'character.update', 'worldbook.write', 'memory.summarize', 'config.adjust', 'unknown'],
            },
            scope: { type: 'string', enum: ['performance', 'setting', 'none'] },
            entities: { type: 'array', items: { type: 'string' }, description: '指令涉及的人物/地点/势力名' },
            target_hint: { type: 'string', description: '要修改的正文范围提示，如"最后一条回复""上一条""不需要"' },
            needs_fact_fix: { type: 'boolean', description: '是否否定了已记录的事实，需要同步纠正记忆与世界书' },
            instruction: { type: 'string', description: '归一化后的作者要求，供后续步骤直接使用' },
            confidence: { type: 'number', description: '0-1' },
        },
        required: ['task', 'scope', 'entities', 'target_hint', 'needs_fact_fix', 'instruction', 'confidence'],
        additionalProperties: false,
    },
};

/** 自动配图：由扩展自己写提示词，作者不需要写任何 prompt。 */
export const IMAGE_PROMPT_SYSTEM = `你是互动小说的插画提示词作者。根据剧情写一条可直接送进 Stable Diffusion / ComfyUI 的提示词。

规则：
- prompt 用英文逗号分隔的短语描述画面：人物（外观特征、发型、服装、表情、动作）、环境、光线、构图、镜头。
- 人物外观优先采用「人物外貌锚点」里已确立的特征，保持前后一致；锚点没写的才由你补，且要克制。
- 只画当前这一瞬的场景，不要画多格分镜，不要出现文字、字幕、水印、对话框、UI。
- 不要在 prompt 里写人物名字（模型不认识），把名字换成外观描述。
- negative 用英文写要避免的内容（低质量、多余手指、文字水印等）。
- style 用英文写一句整体画风建议（如 anime style, soft lighting）。
- 先把画面想清楚再写；不要输出解释，只输出 JSON。`;

export const IMAGE_PROMPT_SCHEMA = {
    name: 'if_image_prompt',
    description: '插画提示词',
    value: {
        type: 'object',
        properties: {
            prompt: { type: 'string', description: '英文 SD 提示词（逗号分隔短语）' },
            negative: { type: 'string', description: '英文负面提示词' },
            style: { type: 'string', description: '英文画风建议' },
            scene_summary: { type: 'string', description: '一句话中文说明这张画的内容' },
        },
        required: ['prompt', 'negative', 'style', 'scene_summary'],
        additionalProperties: false,
    },
};

/**
 * 修改正文（prose.revise）用的叙事执行者提示。
 * 注意：演绎（写新正文）已改走酒馆原生管线，不再用这段提示。
 */
export const PROSE_GENERATE = `你是互动小说的叙事执行者，正在改写一段已有的正文。

要求：
- 只改作者指出的部分，其余文字、语气与结构尽量保留。
- 保持与原正文一致的人称、文风与格式（含预设要求的状态栏、变量块等）。
- 不要替主角作出重大决定；主角的行动只按作者明确给出的内容执行。
- 直接输出修改后的完整正文，不要输出解释、对照、注释或元信息。`;

/** 主角锁定：对话与演绎都要注入的最小约束（防止 NPC 抢主角、多人物串位）。 */
export const PROTAGONIST_LOCK = `【主角锁定】
- 本场主角是 {{user}}，只由玩家控制；你绝不代写主角的行动、决定与内心。
- 你扮演除 {{user}} 以外的所有角色，包括角色卡主角色 {{char}} 与全部 NPC。
- 任何 NPC 都不是主角：不得用 NPC 视角叙述主线，不得让 NPC 替代 {{user}}。
- 场上多个 NPC 时，各自独立（目标、口癖、位置、情绪不同），对白要能分辨是谁在说。`;

/**
 * 演绎模式：走酒馆原生生成管线（预设 + 角色卡 + 世界书全部生效），
 * 作者只给"节拍"，由模型按预设的文风与格式演出。
 * 这段文本作为 system 注入，不替代预设。
 */
export const BEAT_DIRECTIVE = `【作者节拍（必须照此演出）】
本轮的作者指令在最后一条用户消息里。要求：
- 严格按这条节拍演出，不要改写节拍、不要另起炉灶、不要总结节拍；
- 但也不要机械复述节拍原文：把它展开成符合预设文风与格式的正文；
- 主角仍由玩家控制，只演出节拍中明确指派给主角之外的内容；
- 其余一切（文风、人称、字数、格式、状态栏、变量更新）继续遵循当前预设与角色卡，不要违背。`;

/**
 * 判断模型返回的是"故事正文"还是"对作者的元回复"。
 * 真机实测：把"把世界卡进度推进设为快"误判为正文任务时，模型回了一段
 * "你给的指令是…我手里没有可推进的起点…"，这段元回复被当成正文写进了聊天。
 */
const META_REPLY_PATTERNS = [
    /你(给|提供)的?(指令|要求|信息|资料)/u,
    /(请|麻烦)(补充|提供|贴|发)(一下)?/u,
    /我(手里|这边|手上)(没有|缺少)/u,
    /我(需要|缺少|没有)(更多|足够|任何)?(的)?(信息|上下文|剧情|资料|设定|起点)/u,
    /无法(凭空|继续|开始)(演绎|创作|推进)?/u,
    /作为(一个)?(AI|助手|语言模型)/u,
    /^(好的|明白|收到)[，,。!！]?\s*(我(会|将|来)|下面)/u,
];

export function looksLikeMetaReply(text) {
    const value = String(text ?? '').trim();
    if (!value) return false;
    if (value.length > 600) return false;
    return META_REPLY_PATTERNS.some(pattern => pattern.test(value));
}

/** 编辑模式：正文修订。 */
export function proseRevisePrompt({ original, instruction }) {
    return `以下是已生成的故事正文，请按作者要求修改。

【作者要求】
${instruction}

【原正文】
${original}

规则：
- 只改作者要求的部分，其余内容与文字风格尽量保留原样。
- 若作者指出的事实性错误与已记录设定冲突，以作者表述为准。
- 直接输出修改后的完整正文，不要输出解释、对照、注释或元信息。`;
}

/** 编辑模式：人物档案生成（角色 / NPC）。 */
export function characterPrompt({ instruction, memoryContext, existing }) {
    return `你是互动小说的人物设定编撰者。按作者要求产出可直接写入世界书的人物条目。

【作者要求】
${instruction}

【已有资料】
${memoryContext || '（无）'}
${existing ? `\n【该人物现有档案，需在此基础上修订】\n${existing}\n` : ''}
要求：
- 只写偏离默认认知的特征：遮住名字仍能认出是谁。
- 不写万能美人描写（精致、白皙、好看）等空话。
- 使用数据库式写法（键值对与列表），不用散文段落。
- 语言特征给出 5-10 句可直接使用的台词语料，语料只保留纯对话。
- 若作者只描述"当前表现"，则不要改动档案，而是给出可以立刻生效的表现指引。
- 输出简体中文。`;
}

/** 编辑模式：人物档案生成（结构化，避免丢失模型自创的人物名）。 */
export function characterStructuredPrompt({ instruction, memoryContext, existing }) {
    return `你是互动小说的人物设定编撰者。按作者要求产出可直接写入世界书的人物条目。

【作者要求】
${instruction}

【已有资料】
${memoryContext || '（无）'}
${existing ? `\n【该人物现有档案，需在此基础上修订】\n${existing}\n` : ''}
要求：
- 先决定人物名：作者给了名字就用作者的名字；作者没给（例如只写了身份）就自己起一个符合世界观的名字，
  并在 name 字段里给出这个名字。绝不要用"新人物""某长老"之类的占位名。
- 同时给出 entry_name（世界书条目名），格式为「人物名_基础信息」。
- content：人物档案正文，只用键值对与列表，不用散文段落。
  只写偏离默认认知的特征：遮住名字仍能认出是谁；不写"精致、白皙、好看"这类空话。
- keywords：能精确触发该条目的词组，必须包含人物名本身；不要用单个汉字、泛用职务或成语。
- kind：核心角色填「角色」，功能性配角/路人填「NPC」。
- 语言特征给出 5-10 句可直接使用的台词语料，语料只保留纯对话。
- 输出简体中文。`;
}

export const CHARACTER_SCHEMA = {
    name: 'if_character',
    description: '人物档案条目',
    value: {
        type: 'object',
        properties: {
            name: { type: 'string', description: '人物名' },
            entry_name: { type: 'string', description: '世界书条目名，如「苏云_基础信息」' },
            kind: { type: 'string', enum: ['角色', 'NPC'] },
            abstract: { type: 'string', description: '一句话摘要' },
            content: { type: 'string', description: '档案正文（键值对与列表）' },
            keywords: { type: 'array', items: { type: 'string' }, description: '绿灯关键词，必须含人物名' },
            notes: { type: 'array', items: { type: 'string' }, description: '需要作者确认的事项' },
        },
        required: ['name', 'entry_name', 'kind', 'abstract', 'content', 'keywords', 'notes'],
        additionalProperties: false,
    },
};

/** 编辑模式：世界书条目生成。 */
export function worldbookPrompt({ instruction, context, existing }) {
    return `你是互动小说世界书的编撰者，遵循既有的条目规范。把作者要求整理为世界书条目。

【作者要求】
${instruction}

【剧情与既有资料】
${context || '（无）'}

规范：
- 一个条目只承载一类信息：世界观 / 扮演准则 / 地理 / 时间线 / 角色 / NPC / 事件。
- 条目内容用键值对与列表，不用散文；不写"详见某条目"之类的交叉引用，每条必须独立可读。
- keywords 必须是能精确触发的词组：严禁单个汉字；职务类要具体（"老师"→"语文老师"）；不要用成语。
- 不确定或作者未指定的关键名称不要捏造，写清楚"待确认"。
- 输出简体中文；不要输出本次思考过程。`;
}

export const WORLDBOOK_ENTRY_SCHEMA = {
    name: 'if_worldbook_entries',
    description: '世界书条目集合',
    value: {
        type: 'object',
        properties: {
            entries: {
                type: 'array',
                items: {
                    type: 'object',
                    properties: {
                        type: { type: 'string', enum: ['世界观', '扮演准则', '地理', '时间线', '角色', 'NPC', '事件'] },
                        part: { type: 'string', description: '地理: region|scene|faction；角色: basic|personality|tri_faceted；时间线: history|plot；其余留空' },
                        name: { type: 'string', description: '条目名称，能直接看出内容与用途' },
                        abstract: { type: 'string', description: '一句话摘要' },
                        content: { type: 'string', description: '条目正文（YAML 风格键值对/列表）' },
                        keywords: { type: 'array', items: { type: 'string' }, description: '绿灯关键词' },
                        constant: { type: 'boolean', description: '是否常驻（蓝灯）' },
                        enabled: { type: 'boolean' },
                    },
                    required: ['type', 'part', 'name', 'abstract', 'content', 'keywords', 'constant', 'enabled'],
                    additionalProperties: false,
                },
            },
            notes: { type: 'array', items: { type: 'string' }, description: '需要作者确认的事项' },
        },
        required: ['entries', 'notes'],
        additionalProperties: false,
    },
};

/** 编辑模式：MVU 数值与增长规则调整。 */
export function mvuAdjustPrompt({ instruction, variables }) {
    return `你是互动小说 MVU 变量系统的编辑器。作者要求调整数值，或调整数值的增长速度。

【作者要求】
${instruction}

【当前可用变量（路径 = 当前值，括号内是归属人）】
${variables || '（当前没有可用数值变量）'}

任务：
- 若作者要"改成某个值 / 加多少 / 减多少"：输出 patches，键是**上面原样出现的路径**（含 [0] 这类下标），
  值是数字（直接设为该值）或 {"delta": 数字}（在当前值上加减）。
- 若作者要"涨得快些 / 慢些 / 更容易提升 / 更难"：输出 rule，用一两句中文写清该数值今后如何变化
  （触发条件、每次幅度、上限）；patches 留空。
- 两者可以同时给出。**绝对不要编造上面列表里没有的路径**；找不到对应变量就把 patches 留空并在 summary 里说明。
- 只输出 JSON，不要解释。`;
}

export const MVU_ADJUST_SCHEMA = {
    name: 'if_mvu_adjust',
    description: 'MVU 数值与增长规则调整',
    value: {
        type: 'object',
        properties: {
            patches: { type: 'object', description: '路径 → 新值 或 {"delta": 数值}' },
            rule: { type: 'string', description: '增长规则文本，没有则空字符串' },
            summary: { type: 'string', description: '一句话说明改了什么（中文）' },
        },
        required: ['patches', 'rule', 'summary'],
        additionalProperties: false,
    },
};

/** 自动维护：把最近剧情压成记忆与人物更新。 */
export function maintainPrompt({ history, previous, existing }) {
    return `你是互动小说的后台维护者。在不改变既定设定的前提下，整理最近剧情。

【既有长期记忆】
${previous || '（无）'}

【最近剧情】
${history}

输出 JSON：
- summary：当前故事的简短进展（按时间顺序，只保留仍然有效的事实，不超过 300 字）。
- characters：在场或重要人物**这一段的经历与变化**（一句话一条，写"做了什么/关系变了什么"，不要重复人设）。
- threads：尚未回收的线索（一句话一条）。
- scene：当前场景（地点 + 在场人物）。
- facts_removed：因与最近剧情冲突而应失效的旧事实（没有就空数组）。
不要输出解释。`;
}

export const MAINTAIN_SCHEMA = {
    name: 'if_maintain',
    description: '记忆维护结果',
    value: {
        type: 'object',
        properties: {
            summary: { type: 'string' },
            characters: { type: 'array', items: { type: 'string' } },
            threads: { type: 'array', items: { type: 'string' } },
            scene: { type: 'string' },
            facts_removed: { type: 'array', items: { type: 'string' } },
        },
        required: ['summary', 'characters', 'threads', 'scene', 'facts_removed'],
        additionalProperties: false,
    },
};

/** 编辑模式：人物"当前表现调整"（不是设定修改）。 */
export function performancePrompt({ instruction, entities }) {
    return `作者要求调整人物在当前场景中的表现方式，这不是设定修改。

【人物】${entities?.length ? entities.join('、') : '（未点名，按指令中的对象）'}
【要求】${instruction}

请输出一段简短、可直接注入生成提示的表现指引（不超过 120 字），使用祈使句，只描述"怎么演"。
不要重写人物档案，不要输出解释。`;
}

/** 记忆：长期摘要。 */
export function memoryPrompt({ history, previous }) {
    return `你是互动小说的长期记忆维护者。阅读最近的剧情，更新长期记忆。

【已有长期记忆】
${previous || '（无）'}

【最近剧情】
${history}

输出 JSON，字段含义：
- summary：当前故事进展的简短摘要（按时间顺序，只保留仍然有效的事实，不超过 400 字）。
- characters：在场或重要人物的当前状态（位置、状态、关系变化），每项一句话。
- threads：尚未完成的剧情线索，每条一句话。
- scene：当前场景（地点 + 在场人物）。
- facts_removed：因与最近剧情冲突而应失效的旧事实（各一条，若无则为空数组）。
不要输出解释文字。`;
}

export const MEMORY_SCHEMA = {
    name: 'if_memory',
    description: '长期记忆结构',
    value: {
        type: 'object',
        properties: {
            summary: { type: 'string' },
            characters: { type: 'array', items: { type: 'string' } },
            threads: { type: 'array', items: { type: 'string' } },
            scene: { type: 'string' },
            facts_removed: { type: 'array', items: { type: 'string' } },
        },
        required: ['summary', 'characters', 'threads', 'scene', 'facts_removed'],
        additionalProperties: false,
    },
};

/** 纠错：找出与作者新表述冲突的旧记录。 */
export function correctionPrompt({ instruction, candidates }) {
    const list = candidates
        .map((item, index) => `${index + 1}. [${item.source}] ${item.name}：${item.text}`)
        .join('\n');
    return `作者否定或更正了一项设定。请在既有记录中找出与之冲突的内容。

【作者表述】
${instruction}

【既有记录（含来源与条目名）】
${list || '（无）'}

输出 JSON：
- conflicts：冲突记录的编号数组（没有冲突则为空数组）。
- replacements：对每条冲突记录应当改成的新表述，键为编号字符串，值为新文本。
- note：给作者的一行说明（不超过 60 字）。
只输出 JSON。`;
}

export const CORRECTION_SCHEMA = {
    name: 'if_correction',
    description: '纠错冲突检测',
    value: {
        type: 'object',
        properties: {
            conflicts: { type: 'array', items: { type: 'number' } },
            replacements: { type: 'object', additionalProperties: { type: 'string' } },
            note: { type: 'string' },
        },
        required: ['conflicts', 'replacements', 'note'],
        additionalProperties: false,
    },
};

/** 编辑模式：续写/演绎时的上下文拼装。 */
export function proseContextBlock({ memory, recent }) {
    const parts = [];
    if (memory?.summary) parts.push(`【长期记忆·剧情摘要】\n${memory.summary}`);
    if (memory?.scene) parts.push(`【当前场景】\n${memory.scene}`);
    if (memory?.threads?.length) parts.push(`【未完成线索】\n- ${memory.threads.join('\n- ')}`);
    if (recent) parts.push(`【最近对话】\n${recent}`);
    return parts.join('\n\n');
}
