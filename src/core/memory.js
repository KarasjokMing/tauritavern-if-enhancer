/**
 * 长期记忆：摘要、人物状态、未完成线索、当前场景，以及"用户修改优先"的纠错同步。
 *
 * 记忆物理存放为世界书中的固定名称常驻条目（[记忆] …），
 * 因此无需额外存储，也不与小说正文混淆，且随世界书一起被生成上下文读取。
 */
import { settings } from '../config.js';
import { ctx, toast } from '../env.js';
import { MEMORY_ENTRY_NAMES, MEMORY_PREFIX } from '../worldbook/spec.js';
import { readWorldbook, writeEntries, resolveTargetBook } from '../worldbook/adapter.js';
import { memoryEntriesFrom } from '../worldbook/builder.js';
import { memoryPrompt, MEMORY_SCHEMA, correctionPrompt, CORRECTION_SCHEMA } from '../prompts.js';
import { generateObject } from './llm.js';
import { getMessages, renderHistory, currentCharName } from './chat.js';

export async function resolveMemoryBook() {
    const config = settings();
    if (config.memory.book) return config.memory.book;
    if (config.worldbook.primaryName) return config.worldbook.primaryName;
    return await resolveTargetBook(config.worldbook);
}

/** 读取当前长期记忆。 */
export async function readMemory() {
    const book = await resolveMemoryBook();
    try {
        const data = await readWorldbook(book);
        const pick = name => data.entries.find(entry => entry.name === name)?.content ?? '';
        return {
            book,
            summary: unlabel(pick(MEMORY_ENTRY_NAMES.summary), '摘要'),
            scene: unlabel(pick(MEMORY_ENTRY_NAMES.scene), '当前场景'),
            characters: bullets(pick(MEMORY_ENTRY_NAMES.characters)),
            threads: bullets(pick(MEMORY_ENTRY_NAMES.threads)),
            corrections: pick(MEMORY_ENTRY_NAMES.corrections),
            entries: data.entries.filter(entry => entry.name.startsWith(MEMORY_PREFIX)),
        };
    } catch (error) {
        return { book, summary: '', scene: '', characters: [], threads: [], corrections: '', entries: [], error: error?.message };
    }
}

function unlabel(text, label) {
    if (!text) return '';
    return text
        .split('\n')
        .filter(line => !/^更新时间:|^摘要:$/u.test(line.trim()))
        .map(line => line.replace(new RegExp(`^\\s*${label}\\s*[:：]\\s*`, 'u'), '').replace(/^\s*-\s*/u, ''))
        .join('\n')
        .trim();
}

function bullets(text) {
    if (!text) return [];
    return text
        .split('\n')
        .map(line => line.replace(/^\s*-\s*/u, '').trim())
        .filter(line => line && !/^(人物状态|未完成线索|已失效事实.*|更新时间)\s*[:：]?$/u.test(line));
}

/** 写入长期记忆。 */
export async function writeMemory(memory, { previous = null } = {}) {
    const book = await resolveMemoryBook();
    const entries = memoryEntriesFrom(memory, { previous });
    const result = await writeEntries(book, entries, { mode: 'upsert' });
    return { book, ...result, entries: entries.map(entry => entry.name) };
}

/** 依据最近剧情更新长期记忆。 */
export async function summarize({ limitChars = 6000, silent = false } = {}) {
    const config = settings();
    const book = await resolveMemoryBook();
    const previous = await readMemory();
    const history = renderHistory(getMessages('all'), { limitChars });
    if (history.trim().length < 40) {
        return { ok: false, reason: '剧情内容太少，暂不需要整理记忆', book };
    }
    const raw = await generateObject({
        system: `你是互动小说《${currentCharName() || '当前故事'}》的长期记忆维护者，只维护"仍然有效"的事实。`,
        prompt: memoryPrompt({ history, previous: previous.summary }),
        schema: MEMORY_SCHEMA,
        silent: true,
    });
    const memory = {
        summary: String(raw?.summary ?? '').trim(),
        characters: Array.isArray(raw?.characters) ? raw.characters.map(String) : [],
        threads: Array.isArray(raw?.threads) ? raw.threads.map(String) : [],
        scene: String(raw?.scene ?? '').trim(),
        facts_removed: Array.isArray(raw?.facts_removed) ? raw.facts_removed.map(String) : [],
    };
    const result = await writeMemory(memory, { previous: previous.corrections });
    if (!silent) {
        toast(`已更新长期记忆：${result.created} 新增 / ${result.updated} 更新`, 'success');
    }
    return { ok: true, book, memory, result };
}

/** 从世界书里收集可能的事实来源，供纠错比对。 */
export async function collectFactCandidates({ maxEntries = 60 } = {}) {
    const book = await resolveMemoryBook();
    const data = await readWorldbook(book);
    return data.entries
        .filter(entry => entry.content?.trim())
        .slice(0, maxEntries)
        .map(entry => ({
            source: entry.name.startsWith(MEMORY_PREFIX) ? '记忆' : '世界书',
            name: entry.name,
            uid: entry.uid,
            text: entry.content.slice(0, 600),
            entry,
        }));
}

/**
 * 用户否定某项设定时，找出并替换与之冲突的记录。
 * 只做替换/失效处理，不叠加新的矛盾设定。
 */
export async function applyCorrection(instruction, { silent = false } = {}) {
    const candidates = await collectFactCandidates();
    if (!candidates.length) return { ok: true, changed: 0, note: '当前没有已记录的事实需要同步' };

    let plan = { conflicts: [], replacements: {}, note: '' };
    try {
        plan = await generateObject({
            system: '你负责保持互动小说长期记忆与世界书的一致性，只输出 JSON。',
            prompt: correctionPrompt({ instruction, candidates }),
            schema: CORRECTION_SCHEMA,
        });
    } catch (error) {
        console.warn('[IF Enhancer] 纠错比对失败：', error?.message ?? error);
        return { ok: false, changed: 0, note: `纠错比对失败：${error?.message ?? error}` };
    }

    const book = await resolveMemoryBook();
    const touched = [];
    for (const index of plan.conflicts ?? []) {
        const item = candidates[Number(index) - 1];
        if (!item) continue;
        const replacement = plan.replacements?.[String(index)];
        if (!replacement) continue;
        if (item.source === '记忆') {
            const merged = `${item.entry.content}\n（${new Date().toISOString().slice(0, 10)} 依据作者更正）${replacement}`;
            await writeEntries(book, [{ ...item.entry, content: merged }], { mode: 'upsert' });
        } else {
            await writeEntries(book, [{ ...item.entry, content: replacement }], { mode: 'upsert' });
        }
        touched.push(item.name);
    }
    if (!silent) {
        toast(touched.length ? `已同步更正：${touched.join('、')}` : plan.note || '未发现冲突记录', 'success');
    }
    return { ok: true, changed: touched.length, touched, note: plan.note };
}

/** 回合计数（存在 extension_settings 里，跨会话保留）。 */
export function bumpTurnCounter(store) {
    store.memory ??= {};
    store.memory.turn = (store.memory.turn ?? 0) + 1;
    return store.memory.turn;
}

export function shouldAutoSummarize(turn) {
    const config = settings();
    if (!config.memory.enabled) return false;
    if (config.memory.autoTrigger !== 'interval') return false;
    const interval = Math.max(2, Number(config.memory.intervalTurns) || 12);
    return turn > 0 && turn % interval === 0;
}

export function memoryContextText(memory) {
    const parts = [];
    if (memory?.summary) parts.push(`剧情摘要：\n${memory.summary}`);
    if (memory?.scene) parts.push(`当前场景：${memory.scene}`);
    if (memory?.threads?.length) parts.push(`未完成线索：\n- ${memory.threads.join('\n- ')}`);
    if (memory?.characters?.length) parts.push(`人物状态：\n- ${memory.characters.join('\n- ')}`);
    return parts.join('\n\n');
}

export function memoryStore() {
    const c = ctx();
    c.extensionSettings ??= {};
    c.extensionSettings.tt_if_enhancer ??= {};
    return c.extensionSettings.tt_if_enhancer;
}
