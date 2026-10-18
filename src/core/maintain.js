/**
 * 自动维护：上下文涨到阈值就自己总结，并把记忆/人物经历写回**角色卡**。
 *
 * 触发方式（设置 maintain.trigger）：
 *   chars    —— 聊天正文总字数达到阈值（默认，且要再增长一定量才重复触发）
 *   interval —— 每 N 条 AI 回复
 *
 * 写入位置（设置 maintain.writeTarget）：
 *   card  —— 角色卡内嵌世界书（写前自动整卡备份）
 *   book  —— 角色卡绑定的世界书
 *
 * 只写带 `[记忆]` / `[互动小说]` 前缀的条目，**不碰卡里原有的条目**。
 */
import { settings, updateSettings } from '../config.js';
import { ctx } from '../env.js';
import { generateObject } from './llm.js';
import { getMessages, renderHistory } from './chat.js';
import { readCard, upsertCardEntries } from './card.js';
import { writeEntries, resolveTargetBook } from '../worldbook/adapter.js';
import { buildEntries } from '../worldbook/builder.js';
import { maintainPrompt, MAINTAIN_SCHEMA } from '../prompts.js';
import { MEMORY_ENTRY_NAMES, MEMORY_PREFIX } from '../worldbook/spec.js';

/** 聊天正文总字数（粗略的上下文体量指标，不依赖 tokenizer）。 */
export function contextChars() {
    return (ctx()?.chat ?? []).reduce((sum, message) => sum + String(message?.mes ?? '').length, 0);
}

function maintainStore() {
    const c = ctx();
    c.extensionSettings ??= {};
    c.extensionSettings.tt_if_enhancer ??= {};
    c.extensionSettings.tt_if_enhancer.maintain ??= {};
    return c.extensionSettings.tt_if_enhancer.maintain;
}

/** 是否该维护了。 */
export function shouldMaintain({ turn = 0 } = {}) {
    const config = settings().maintain ?? {};
    if (!config.enabled) return false;
    if (config.trigger === 'interval') {
        const every = Math.max(2, Number(config.intervalReplies) || 20);
        return turn > 0 && turn % every === 0;
    }
    const chars = contextChars();
    const threshold = Math.max(4000, Number(config.charThreshold) || 24000);
    const last = Number(maintainStore().lastChars ?? 0);
    // 达到阈值，且比上次维护后又显著增长，才再次触发，避免反复总结
    return chars >= threshold && chars - last >= Math.max(4000, threshold * 0.4);
}

async function readPreviousSummary() {
    try {
        const book = await resolveTargetBook(settings().worldbook);
        const { readWorldbook } = await import('../worldbook/adapter.js');
        const data = await readWorldbook(book);
        const hit = data.entries.find(entry => entry.name === MEMORY_ENTRY_NAMES.summary);
        return hit?.content ?? '';
    } catch {
        return '';
    }
}

/** 把内部条目写到卡（内嵌书或绑定书）。 */
async function writeEntriesToCard(entries) {
    const target = settings().maintain?.writeTarget ?? 'card';
    if (target === 'card') {
        try {
            const card = await readCard();
            if (card.book) {
                const result = await upsertCardEntries(entries);
                return { where: '角色卡内嵌世界书（已备份整卡）', ...result };
            }
        } catch (error) {
            console.warn('[IF Enhancer] 写卡内嵌书失败，改用绑定世界书：', error?.message ?? error);
        }
    }
    const book = await resolveTargetBook(settings().worldbook);
    const result = await writeEntries(book, entries, { mode: 'upsert' });
    return { where: `世界书《${book}》`, created: result.created, updated: result.updated };
}

/**
 * 执行一次维护。
 * @returns {{ok:boolean, reason?:string, where?:string, memory?:object, chars?:number}}
 */
export async function maintain({ stage, silent = true } = {}) {
    const config = settings().maintain ?? {};
    const messages = getMessages('all').filter(message => !message.is_hidden);
    if (messages.length < 4) return { ok: false, reason: '剧情内容还太少，暂不需要维护' };
    const keep = Math.max(4, Number(config.keepRecent) || 12);
    const history = renderHistory(messages.slice(-keep), { limitChars: 6000 });
    const previous = await readPreviousSummary();

    stage?.('正在整理最近剧情…');
    const plan = await generateObject({
        system: maintainPrompt({ history, previous, existing: '' }),
        prompt: '请整理。',
        schema: MAINTAIN_SCHEMA,
        silent: true,
    });

    const now = new Date().toISOString().slice(0, 10);
    const entries = [];
    if (plan?.summary) {
        entries.push({
            type: '时间线',
            part: 'plot',
            name: MEMORY_ENTRY_NAMES.summary,
            abstract: '长期剧情摘要（自动维护）',
            content: [`更新时间: ${now}`, '摘要:', ...String(plan.summary).split('\n').filter(Boolean).map(line => `  - ${line.trim()}`)].join('\n'),
            keys: [],
            constant: true,
            enabled: true,
            position: 'at_depth',
            depth: 0,
            role: 'system',
        });
    }
    if (plan?.scene) {
        entries.push({
            type: '时间线', part: 'plot', name: MEMORY_ENTRY_NAMES.scene, abstract: '当前场景',
            content: `当前场景: ${plan.scene}`, keys: [], constant: true, enabled: true, position: 'at_depth', depth: 0, role: 'system',
        });
    }
    if (plan?.threads?.length) {
        entries.push({
            type: '时间线', part: 'plot', name: MEMORY_ENTRY_NAMES.threads, abstract: '未完成线索',
            content: ['未完成线索:', ...plan.threads.map(line => `  - ${line}`)].join('\n'), keys: [], constant: true, enabled: true, position: 'at_depth', depth: 0, role: 'system',
        });
    }
    if (config.updateCharacters && plan?.characters?.length) {
        for (const line of plan.characters) {
            const match = String(line).match(/^([^：:]{2,12})[：:]\s*(.+)$/u);
            if (!match) continue;
            const [, who, detail] = match;
            entries.push({
                type: '角色',
                part: 'other',
                name: `[互动小说]人物经历·${who}`,
                abstract: `${who}的经历（自动维护）`,
                content: [`${who}的经历（自动维护，按时间累积）:`, `  - ${now} ${detail.trim()}`].join('\n'),
                keys: [who],
                constant: false,
                enabled: true,
            });
        }
    }
    if (!entries.length) return { ok: false, reason: '模型没有给出可写入的记忆内容' };

    stage?.('正在写入角色卡…');
    const built = buildEntries(entries, { strictDashes: settings().lint.strictDashes });
    const written = await writeEntriesToCard(built.entries);

    const store = maintainStore();
    store.lastChars = contextChars();
    store.at = new Date().toISOString();
    store.where = written.where;
    updateSettings({ maintain: { ...settings().maintain, lastRunAt: store.at } });

    return {
        ok: true,
        where: written.where,
        created: written.created,
        updated: written.updated,
        chars: store.lastChars,
        memory: plan,
        lint: built.lint,
        silent,
    };
}

/** 供对话模式每轮调用。 */
export async function maybeAutoMaintain({ turn = 0, onStage, onResult } = {}) {
    if (!shouldMaintain({ turn })) return false;
    onStage?.('自动维护：正在总结最近剧情…');
    try {
        const result = await maintain({ stage: onStage });
        if (!result.ok) {
            console.log('[IF Enhancer] 自动维护跳过：', result.reason);
            return false;
        }
        onResult?.({
            ok: true,
            label: '自动维护',
            title: '已自动更新记忆 / 人物经历',
            lines: [
                `${result.where}：新增 ${result.created ?? 0} 条，更新 ${result.updated ?? 0} 条`,
                `上下文 ${result.chars ?? 0} 字`,
            ],
            detail: String(result.memory?.summary ?? '').slice(0, 500),
        });
        return true;
    } catch (error) {
        const message = error?.message ?? String(error);
        console.warn('[IF Enhancer] 自动维护失败：', message);
        onResult?.({ ok: false, label: '自动维护', title: '自动维护失败', lines: [message] });
        return false;
    } finally {
        onStage?.('');
    }
}

export { MEMORY_PREFIX };
