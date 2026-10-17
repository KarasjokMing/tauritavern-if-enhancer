/**
 * 世界书条目规范（clean-room 实现）。
 *
 * 本文件只包含"接口级事实"：条目分类、子类、位置与策略枚举、
 * 推导阈值、以及 SillyTavern 世界书字段映射。这些是公共数据格式与算法规则，
 * 依据公开规范独立重写，不复制任何上游提示词或文档文本。
 * 详见仓库根 NOTICE.md 的授权说明。
 */

/** 条目类型与子类（part）定义。 */
export const ENTRY_TYPES = {
    世界观: { parts: [], boundary: '世界规则、物理法则、社会结构、历史背景；不含具体区域与角色' },
    扮演准则: { parts: [], boundary: 'AI 的叙述风格与行为约束；写"怎么演"而不是"是什么"' },
    地理: { parts: ['region', 'scene', 'faction'], boundary: 'region 区域概览 / scene 场景详情 / faction 势力详情' },
    时间线: { parts: ['history', 'plot'], boundary: 'history 历史节点 / plot 当前剧情进度' },
    角色: { parts: ['basic', 'personality', 'tri_faceted'], boundary: '每个核心角色至少 basic + personality' },
    NPC: { parts: [], boundary: '功能性配角，只给简要信息，不写完整人设' },
    事件: { parts: [], boundary: '单次或条件触发的事件，不是事件序列' },
    阶段指导: { parts: [], boundary: '阶段化玩法的主持策略' },
};

export const ENTRY_TYPE_NAMES = Object.keys(ENTRY_TYPES);

/** 子类默认顺序（用于 position / order 推导）。 */
export const PART_ORDER = {
    角色: ['basic', 'personality', 'tri_faceted', 'other'],
    地理: ['region', 'scene', 'faction'],
    时间线: ['history', 'plot'],
};

/** 策略推导阈值：数字=同 part 条目数达到该值才用绿灯；Infinity=恒蓝灯；0=恒绿灯；null=禁用。 */
export const STRATEGY_THRESHOLDS = {
    角色: {
        basic: { required: true, threshold: 5 },
        personality: { required: true, threshold: 2 },
        tri_faceted: { required: false, threshold: 2 },
        other: { required: false, threshold: 2 },
    },
    地理: {
        region: { required: false, threshold: 4 },
        scene: { required: false, threshold: 4 },
        faction: { required: false, threshold: 4 },
    },
    时间线: { history: { required: false, threshold: Infinity }, plot: { required: false, threshold: Infinity } },
    世界观: Infinity,
    扮演准则: Infinity,
    NPC: 0,
    事件: 0,
    阶段指导: Infinity,
};

/** 类型 → 注入位置分组。 */
export const TYPE_LISTS = {
    before_char: ['世界观', '扮演准则', '时间线', '地理'],
    after_char: ['角色', 'NPC'],
    depth: ['事件', '阶段指导'],
};

export const DEPTH_DEFAULTS = { depth: 0, role: 'system' };

/** SillyTavern 扁平世界书的 position 数字枚举。 */
export const POSITION_NUM = {
    before_character_definition: 0,
    after_character_definition: 1,
    before_author_note: 2,
    after_author_note: 3,
    at_depth: 4,
    before_example_messages: 5,
    after_example_messages: 6,
};

export const SELECTIVE_LOGIC_NUM = {
    and_any: 0,
    not_all: 1,
    not_any: 2,
    and_all: 3,
};

export const ROLE_NUM = { system: 0, user: 1, assistant: 2 };

/** 关键词正则：单个 CJK 汉字（严禁）。 */
export const SINGLE_CJK = /^[\u3400-\u4dbf\u4e00-\u9fff]$/u;

/** 过于泛用的职务类关键词。 */
export const GENERIC_KEYWORDS = new Set([
    '老师', '会长', '老板', '大人', '公子', '小姐', '医生', '警察', '同学', '朋友',
    '母亲', '父亲', '哥哥', '姐姐', '弟弟', '妹妹', '师傅', '师兄', '师姐', '长老',
    '掌柜', '丫鬟', '仆人', '士兵', '护卫', '弟子', '客人', '路人',
]);

/** 常见成语：作为关键词会导致无关触发。 */
export const IDIOM_KEYWORDS = new Set([
    '倾国倾城', '闭月羞花', '沉鱼落雁', '国色天香', '冰清玉洁', '秀外慧中',
    '花容月貌', '天生丽质', '明眸皓齿', '风华绝代', '绝代佳人', '温文尔雅',
]);

/** 八股微表情 / 陈旧描写黑名单。 */
export const CLICHE_PHRASES = [
    '嘴角微微上扬', '嘴角勾起', '眼中闪过一丝', '眼底闪过', '眸色一暗',
    '微微一愣', '微微一怔', '深吸一口气', '缓缓开口', '淡淡地说', '轻轻地说',
    '心中五味杂陈', '像小兽', '投石入湖', '心湖泛起涟漪', '不禁', '眸光微动',
    '神色复杂', '若有所思地', '意味深长地',
];

/** 模糊限定词。 */
export const VAGUE_WORDS = ['似乎', '仿佛', '宛如', '如同', '几乎', '大概', '好像', '隐约'];

/** 元叙事 / 制作说明泄漏。 */
export const META_PHRASES = [
    'AI 写作要点', '本卡独家', '本卡专属', '戏剧用途', '核心冲突_', '本条目',
    '写作提示', '创作说明', '备注：', '说明：这是', '作为 AI',
];

/** 占位符：条目内容里出现即视为未完成。 */
export const PLACEHOLDER_PATTERNS = [
    /某(城市|学校|组织|公司|国家|村庄|门派|宗门|家族)/u,
    /待补充/u,
    /待定/u,
    /待确认/u,
    /TBD/i,
    /\bTODO\b/i,
    /XXX/i,
    /某某/u,
];

/** 繁体 / 日文汉字：条目正文应统一为简体中文。 */
export const TRADITIONAL_MAP = {
    桜: '樱', 宮: '宫', 靜: '静', 繪: '绘', 戀: '恋', 愛: '爱', 戰: '战', 鬥: '斗',
    學: '学', 國: '国', 會: '会', 說: '说', 這: '这', 個: '个', 們: '们', 時: '时',
    間: '间', 樣: '样', 麼: '么', 髮: '发', 為: '为', 與: '与', 來: '来', 過: '过',
    對: '对', 應: '应', 將: '将', 現: '现', 實: '实', 體: '体', 內: '内', 從: '从',
    無: '无', 開: '开', 關: '关', 覺: '觉', 隻: '只', 兒: '儿', 語: '语', 話: '话',
    讀: '读', 寫: '写', 書: '书', 車: '车', 東: '东', 門: '门', 長: '长', 風: '风',
    馬: '马', 鳥: '鸟', 魚: '鱼', 點: '点', 髮: '发', 讓: '让', 認: '认', 錯: '错',
    誰: '谁', 麼: '么', 幾: '几', 當: '当', 發: '发', 紅: '红', 結: '结', 給: '给',
};

/** 跨条目引用：世界书条目必须独立可读。 */
export const CROSS_REFERENCE_PATTERNS = [
    /详见/u, /参见/u, /见「/u, /见《/u, /对应「/u, /配套/u, /如前所述/u, /同上/u, /见上条/u,
];

/** 破折号（规范要求杜绝）。 */
export const DASH_PATTERNS = [/——/u, /—/u, /--/u];

/** 记忆条目统一前缀，保证往返可识别。 */
export const MEMORY_PREFIX = '[记忆]';

export const MEMORY_ENTRY_NAMES = {
    summary: `${MEMORY_PREFIX} 剧情摘要`,
    scene: `${MEMORY_PREFIX} 当前场景`,
    threads: `${MEMORY_PREFIX} 未完成线索`,
    characters: `${MEMORY_PREFIX} 人物状态`,
    corrections: `${MEMORY_PREFIX} 已纠正事实`,
};

/** 内部条目 → SillyTavern 扁平世界书字段。 */
export function toFlatEntry(entry, index = 0) {
    const position = POSITION_NUM[entry.position] ?? POSITION_NUM.before_character_definition;
    const constant = Boolean(entry.constant);
    const keys = Array.isArray(entry.keys) ? entry.keys.filter(Boolean) : [];
    return {
        uid: entry.uid ?? index,
        key: keys,
        keysecondary: Array.isArray(entry.secondaryKeys) ? entry.secondaryKeys.filter(Boolean) : [],
        comment: entry.name || `条目 ${index + 1}`,
        content: entry.content ?? '',
        constant,
        selective: !constant && keys.length > 0,
        selectiveLogic: SELECTIVE_LOGIC_NUM[entry.selectiveLogic] ?? SELECTIVE_LOGIC_NUM.and_any,
        addMemo: true,
        order: Number.isFinite(entry.order) ? entry.order : 100,
        position,
        disable: entry.enabled === false,
        excludeRecursion: Boolean(entry.excludeRecursion),
        preventRecursion: entry.preventRecursion !== false,
        delayUntilRecursion: Boolean(entry.delayUntilRecursion),
        probability: Number.isFinite(entry.probability) ? entry.probability : 100,
        useProbability: true,
        depth: entry.position === 'at_depth' ? Number(entry.depth ?? DEPTH_DEFAULTS.depth) : 4,
        group: entry.group ?? '',
        groupOverride: false,
        groupWeight: 100,
        scanDepth: entry.scanDepth ?? null,
        caseSensitive: null,
        matchWholeWords: null,
        useGroupScoring: null,
        automationId: '',
        role: entry.position === 'at_depth' ? (ROLE_NUM[entry.role] ?? ROLE_NUM.system) : 0,
        vectorized: false,
        sticky: entry.sticky ?? 0,
        cooldown: entry.cooldown ?? 0,
        delay: entry.delay ?? 0,
        displayIndex: entry.displayIndex ?? index,
    };
}

/** SillyTavern 扁平世界书字段 → 内部条目。 */
export function fromFlatEntry(flat, index = 0) {
    const positionName = Object.keys(POSITION_NUM).find(key => POSITION_NUM[key] === flat.position) ?? 'before_character_definition';
    const logicName = Object.keys(SELECTIVE_LOGIC_NUM).find(key => SELECTIVE_LOGIC_NUM[key] === flat.selectiveLogic) ?? 'and_any';
    return {
        uid: flat.uid ?? index,
        name: flat.comment ?? '',
        enabled: flat.disable !== true,
        content: flat.content ?? '',
        keys: Array.isArray(flat.key) ? flat.key : flat.key ? [flat.key] : [],
        secondaryKeys: Array.isArray(flat.keysecondary) ? flat.keysecondary : [],
        selectiveLogic: logicName,
        constant: Boolean(flat.constant),
        position: positionName,
        depth: flat.depth ?? DEPTH_DEFAULTS.depth,
        role: Object.keys(ROLE_NUM).find(key => ROLE_NUM[key] === flat.role) ?? DEPTH_DEFAULTS.role,
        order: flat.order ?? 100,
        probability: flat.probability ?? 100,
        scanDepth: flat.scanDepth ?? 'same_as_global',
        excludeRecursion: Boolean(flat.excludeRecursion),
        preventRecursion: flat.preventRecursion !== false,
        delayUntilRecursion: Boolean(flat.delayUntilRecursion),
        displayIndex: flat.displayIndex ?? index,
    };
}
