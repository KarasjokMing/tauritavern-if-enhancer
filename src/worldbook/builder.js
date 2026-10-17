/**
 * 把生成结果装配成可写入的世界书条目，并做质量把关。
 */
import { deriveAll } from './derive.js';
import { lintBook, formatIssues } from './lint.js';
import { MEMORY_ENTRY_NAMES, MEMORY_PREFIX } from './spec.js';

const VALID_TYPES = new Set(['世界观', '扮演准则', '地理', '时间线', '角色', 'NPC', '事件', '阶段指导']);

/** 清洗模型输出，容忍字段缺失。 */
export function normalizeGenerated(raw, fallback = {}) {
    const type = VALID_TYPES.has(raw?.type) ? raw.type : fallback.type ?? '世界观';
    const name = String(raw?.name ?? fallback.name ?? '').trim();
    return {
        type,
        part: String(raw?.part ?? fallback.part ?? '').trim(),
        name,
        abstract: String(raw?.abstract ?? '').trim(),
        content: String(raw?.content ?? '').trim(),
        keys: Array.isArray(raw?.keywords) ? raw.keywords.map(String).filter(Boolean) : [],
        secondaryKeys: Array.isArray(raw?.secondaryKeys) ? raw.secondaryKeys.map(String).filter(Boolean) : [],
        selectiveLogic: raw?.selectiveLogic ?? 'and_any',
        constant: typeof raw?.constant === 'boolean' ? raw.constant : undefined,
        enabled: raw?.enabled !== false,
        position: raw?.position,
        depth: raw?.depth,
        role: raw?.role,
        order: raw?.order,
        probability: raw?.probability ?? 100,
        rephrase: Boolean(raw?.rephrase),
        scope: raw?.scope,
        meta: { type, part: String(raw?.part ?? ''), abstract: String(raw?.abstract ?? ''), source: 'if-enhancer' },
    };
}

/**
 * 装配条目：补全推导 → 校验。
 * @returns {{entries: object[], lint: object, notes: string[]}}
 */
export function buildEntries(rawEntries, { strictDashes = true } = {}) {
    const entries = (rawEntries ?? []).map(item => normalizeGenerated(item)).filter(entry => entry.name);
    deriveAll(entries);
    const lint = lintBook(entries, { strictDashes });
    return { entries, lint, notes: formatIssues(lint) };
}

/** 记忆条目：把长期记忆写成固定名称的常驻条目。 */
export function memoryEntriesFrom(memory, { previous = null } = {}) {
    const now = new Date().toISOString().slice(0, 10);
    const entries = [];
    const push = (name, content, order) => {
        entries.push({
            type: '时间线',
            part: 'plot',
            name: `${name}`,
            abstract: name.replace(MEMORY_PREFIX, '').trim(),
            content,
            keys: [],
            secondaryKeys: [],
            constant: true,
            enabled: true,
            position: 'at_depth',
            depth: 0,
            role: 'system',
            order,
            probability: 100,
            meta: { type: '时间线', part: 'plot', source: 'if-memory' },
        });
    };

    const summary = [
        `更新时间: ${now}`,
        '摘要:',
        ...String(memory.summary ?? '').split('\n').map(line => `  - ${line.trim()}`).filter(line => line.trim() !== '-'),
    ].join('\n');
    push(MEMORY_ENTRY_NAMES.summary, summary, 500);

    if (memory.scene) push(MEMORY_ENTRY_NAMES.scene, `当前场景: ${memory.scene}`, 501);
    if (memory.characters?.length) {
        push(MEMORY_ENTRY_NAMES.characters, ['人物状态:', ...memory.characters.map(line => `  - ${line}`)].join('\n'), 502);
    }
    if (memory.threads?.length) {
        push(MEMORY_ENTRY_NAMES.threads, ['未完成线索:', ...memory.threads.map(line => `  - ${line}`)].join('\n'), 503);
    }
    if (memory.facts_removed?.length) {
        const old = previous ? `${previous}\n` : '';
        push(
            MEMORY_ENTRY_NAMES.corrections,
            `${old}已失效事实（${now}）:\n${memory.facts_removed.map(line => `  - ${line}`).join('\n')}`,
            504,
        );
    }
    return entries;
}

/** 变更摘要，用于编辑模式回执。 */
export function describeWrite(name, result, lint) {
    const parts = [];
    if (result.created) parts.push(`新增 ${result.created} 条`);
    if (result.updated) parts.push(`更新 ${result.updated} 条`);
    if (!parts.length) parts.push('无变化');
    const tail = lint?.errors?.length ? `（${lint.errors.length} 项需修正）` : lint?.warnings?.length ? `（${lint.warnings.length} 条提醒）` : '';
    return `${name}：${parts.join('，')}${tail}`;
}
