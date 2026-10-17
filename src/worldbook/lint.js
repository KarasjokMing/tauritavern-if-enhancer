/**
 * 世界书条目质量校验（纯函数）。
 *
 * 覆盖：关键词可触发性、条目完整性、格式规范（数据库式写法）、
 * 八股与模糊表达、元叙事泄漏、占位符、繁简统一、跨条目引用与重复。
 */
import {
    ENTRY_TYPES,
    SINGLE_CJK,
    GENERIC_KEYWORDS,
    IDIOM_KEYWORDS,
    CLICHE_PHRASES,
    VAGUE_WORDS,
    META_PHRASES,
    PLACEHOLDER_PATTERNS,
    TRADITIONAL_MAP,
    CROSS_REFERENCE_PATTERNS,
    DASH_PATTERNS,
} from './spec.js';

const issue = (level, code, where, message, hint = '') => ({ level, code, where, message, hint });

function scanPhrases(text, phrases, level, code, where, message) {
    const found = phrases.filter(phrase => text.includes(phrase));
    return found.length ? [issue(level, code, where, `${message}：${found.join('、')}`)] : [];
}

/** 关键词校验。常驻条目不需要关键词，因此不报"没有关键词"。 */
export function lintKeywords(keys = [], { type = '', name = '', constant = false } = {}) {
    const issues = [];
    const list = keys.filter(key => typeof key === 'string' && key.trim() !== '');
    if (!list.length && !constant) {
        issues.push(issue('error', 'KW_EMPTY', name, '条目没有任何关键词，将永远不会被触发', '补充能精确命中该条目的词组，或改为常驻条目'));
    }
    for (const key of list) {
        const trimmed = key.trim();
        if (SINGLE_CJK.test(trimmed)) {
            issues.push(issue('error', 'KW_SINGLE_CJK', name, `关键词"${trimmed}"是单个汉字，极易误触发`, `改成两字以上，如"小${trimmed}"`));
            continue;
        }
        if (GENERIC_KEYWORDS.has(trimmed)) {
            issues.push(issue('warning', 'KW_GENERIC', name, `关键词"${trimmed}"过于泛用`, '改用更精确的表述，如"语文老师""学生会长"'));
        }
        if (IDIOM_KEYWORDS.has(trimmed)) {
            issues.push(issue('warning', 'KW_IDIOM', name, `关键词"${trimmed}"是常见成语，会造成无关触发`, '改用该对象独有的名称'));
        }
        if (/^[A-Za-z0-9]+$/.test(trimmed) && trimmed.length < 3) {
            issues.push(issue('warning', 'KW_SHORT_LATIN', name, `关键词"${trimmed}"过短`, '使用更完整的名称'));
        }
    }
    if (type === '角色' || type === 'NPC') {
        const stem = name.split('_')[0];
        if (stem && !list.some(key => key.includes(stem) || stem.includes(key))) {
            issues.push(issue('warning', 'KW_NAME_MISSING', name, `关键词未包含人物名"${stem}"`, '把人物名本身加入关键词'));
        }
    }
    return issues;
}

/** 条目正文校验。 */
export function lintContent(entry, { strictDashes = true } = {}) {
    const issues = [];
    const where = entry.name || '(未命名)';
    const content = String(entry.content ?? '');
    if (!content.trim()) {
        issues.push(issue('error', 'CONTENT_EMPTY', where, '条目正文为空'));
        return issues;
    }
    if (content.trim().length < 12) {
        issues.push(issue('warning', 'CONTENT_TOO_SHORT', where, '条目正文过短，可能缺少关键信息'));
    }
    if (content.length > 2400) {
        issues.push(issue('warning', 'CONTENT_TOO_LONG', where, `条目正文 ${content.length} 字，建议拆分为独立条目`, '一个条目只承载一类信息'));
    }
    for (const pattern of DASH_PATTERNS) {
        if (pattern.test(content)) {
            issues.push(issue(strictDashes ? 'error' : 'warning', 'DASH', where, '条目正文包含破折号', '改用逗号、冒号或断句'));
            break;
        }
    }
    issues.push(...scanPhrases(content, META_PHRASES, 'error', 'META_LEAK', where, '条目中混入了制作说明/元叙事'));
    issues.push(...scanPhrases(content, CLICHE_PHRASES, 'warning', 'CLICHE', where, '条目包含八股化表达'));
    issues.push(...scanPhrases(content, VAGUE_WORDS, 'warning', 'VAGUE', where, '条目包含模糊限定词'));
    for (const pattern of CROSS_REFERENCE_PATTERNS) {
        if (pattern.test(content)) {
            issues.push(issue('warning', 'CROSS_REFERENCE', where, '条目引用了其他条目，无法独立阅读', '把被引用内容的关键句复制进来'));
            break;
        }
    }
    for (const pattern of PLACEHOLDER_PATTERNS) {
        const match = content.match(pattern);
        if (match) {
            issues.push(issue('warning', 'PLACEHOLDER', where, `条目包含占位符"${match[0]}"`, '补齐具体名称，或明确标注待作者确认'));
            break;
        }
    }
    const traditional = [...new Set(content.split('').filter(char => TRADITIONAL_MAP[char]))];
    if (traditional.length) {
        const mapping = traditional.map(char => `${char}→${TRADITIONAL_MAP[char]}`).join('、');
        issues.push(issue('warning', 'TRADITIONAL', where, `条目含繁体或日文汉字：${mapping}`, '统一为简体中文'));
    }
    const longLines = content.split('\n').filter(line => line.trim().length > 120);
    if (longLines.length >= 2) {
        issues.push(issue('warning', 'DB_FORMAT', where, '条目像散文段落而不是数据库条目', '改用键值对与列表'));
    }
    return issues;
}

/** 单条目完整校验。 */
export function lintEntry(entry, { allEntries = [], strictDashes = true } = {}) {
    const issues = [];
    const where = entry.name || '(未命名)';
    if (!entry.name || !entry.name.trim()) issues.push(issue('error', 'NAME_EMPTY', where, '条目没有名称'));
    if (entry.name && entry.name.length > 60) issues.push(issue('warning', 'NAME_TOO_LONG', where, '条目名称过长'));
    if (!ENTRY_TYPES[entry.type] && entry.type) {
        issues.push(issue('warning', 'TYPE_UNKNOWN', where, `条目类型"${entry.type}"不在规范分类中`));
    }
    const parts = ENTRY_TYPES[entry.type]?.parts ?? [];
    if (parts.length && !entry.part) {
        issues.push(issue('warning', 'PART_MISSING', where, `类型"${entry.type}"需要指定子类（${parts.join(' / ')}）`));
    }
    if (entry.part && parts.length && !parts.includes(entry.part)) {
        issues.push(issue('warning', 'PART_INVALID', where, `子类"${entry.part}"不属于类型"${entry.type}"`));
    }
    if (entry.constant && Array.isArray(entry.keys) && entry.keys.length) {
        issues.push(issue('info', 'CONSTANT_KEYS', where, '常驻条目同时配置了关键词，关键词不会生效'));
    }
    if (!entry.constant && !(entry.keys ?? []).length) {
        issues.push(issue('error', 'NO_TRIGGER', where, '既非常驻又没有关键词，该条目永远不会注入'));
    }
    if (entry.position === 'at_depth' && Number(entry.depth) >= 1) {
        issues.push(issue('warning', 'DEPTH_NONZERO', where, `深度条目 depth=${entry.depth}`, '按规范建议使用 depth=0 + system 角色'));
    }
    if (Number(entry.probability) < 0 || Number(entry.probability) > 100) {
        issues.push(issue('error', 'PROBABILITY_RANGE', where, 'probability 必须在 0-100 之间'));
    }
    issues.push(...lintKeywords(entry.keys ?? [], { type: entry.type, name: entry.name, constant: entry.constant }));
    issues.push(...lintContent(entry, { strictDashes }));

    const duplicates = (entry.keys ?? []).filter(key =>
        allEntries.some(other => other !== entry && (other.keys ?? []).includes(key)),
    );
    if (duplicates.length) {
        issues.push(issue('warning', 'KW_DUPLICATE', where, `关键词与其他条目重复：${duplicates.join('、')}`, '改用更精确的词组'));
    }
    return issues;
}

/** 整本世界书校验。 */
export function lintBook(entries, { strictDashes = true } = {}) {
    const issues = [];
    for (const entry of entries) {
        issues.push(...lintEntry(entry, { allEntries: entries, strictDashes }));
    }
    const names = new Map();
    for (const entry of entries) {
        const key = (entry.name ?? '').trim();
        if (!key) continue;
        if (names.has(key)) {
            issues.push(issue('error', 'NAME_DUPLICATE', key, '条目名称重复'));
        }
        names.set(key, true);
    }
    return summarize(issues);
}

export function summarize(issues) {
    const errors = issues.filter(item => item.level === 'error');
    const warnings = issues.filter(item => item.level === 'warning');
    const infos = issues.filter(item => item.level === 'info');
    return { issues, errors, warnings, infos, ok: errors.length === 0, count: issues.length };
}

/** 供 UI 展示的紧凑文本。 */
export function formatIssues(result, limit = 6) {
    const list = [...result.errors, ...result.warnings, ...result.infos].slice(0, limit);
    return list.map(item => `${item.level === 'error' ? '✗' : item.level === 'warning' ? '!' : 'i'} [${item.where}] ${item.message}${item.hint ? ` → ${item.hint}` : ''}`);
}
