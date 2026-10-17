/**
 * 编辑模式：把作者的自然语言指令分派到具体任务。
 *
 * 两条执行结果：
 *   A. 对故事正文操作 → 生成或修改正文（复用聊天的消息读写）
 *   B. 对故事资料操作 → 写世界书 / 更新记忆，只在界面显示执行结果
 *
 * 用户不需要知道内部流程，也不需要任何特殊关键词。
 */
import { settings } from '../config.js';
import { toast } from '../env.js';
import { routeInstruction, TASK, TASK_LABEL } from './router.js';
import { generateText, generateObject, stripFence } from './llm.js';
import { getMessages, renderHistory, appendMessages, replaceMessage, findLastMessage, currentCharName } from './chat.js';
import { readMemory, summarize, applyCorrection, memoryContextText, resolveMemoryBook } from './memory.js';
import { refreshDialogueInjection, setPerformanceGuidance } from './dialogue.js';
import {
    PROSE_GENERATE,
    proseRevisePrompt,
    proseContextBlock,
    characterPrompt,
    worldbookPrompt,
    WORLDBOOK_ENTRY_SCHEMA,
    performancePrompt,
} from '../prompts.js';
import { buildEntries, describeWrite } from '../worldbook/builder.js';
import { writeEntries, readWorldbook, resolveTargetBook } from '../worldbook/adapter.js';

const receipt = (extra = {}) => ({
    ok: true,
    task: TASK.UNKNOWN,
    label: '',
    title: '',
    lines: [],
    detail: '',
    warnings: [],
    undo: null,
    ...extra,
});

function recentHistory(limit) {
    const list = getMessages('all').filter(item => !item.is_hidden);
    const count = Math.max(4, Number(limit) || 24);
    return renderHistory(list.slice(-count), { limitChars: 5000 });
}

function resolveTargetMessage(route) {
    const list = getMessages('all').filter(item => !item.is_hidden);
    const assistants = list.filter(item => item.role === 'assistant');
    const hint = route.target_hint ?? '';
    if (/上一条|前一段|前面那段/u.test(hint)) return assistants.at(-2) ?? assistants.at(-1) ?? null;
    const numbered = hint.match(/第\s*(\d+)\s*条/u);
    if (numbered) {
        const index = Number(numbered[1]);
        return list[index] ?? assistants.at(-1) ?? null;
    }
    return findLastMessage('assistant') ?? assistants.at(-1) ?? list.at(-1) ?? null;
}

async function currentBook() {
    const config = settings();
    return await resolveTargetBook(config.worldbook);
}

/* ------------------------------------------------------------ 正文类任务 */

async function handleProseGenerate(route, stage) {
    stage?.('正在演绎剧情…');
    const memory = await readMemory();
    const context = proseContextBlock({ memory, recent: recentHistory(settings().edit.historyMessages) });
    const raw = await generateText({
        system: PROSE_GENERATE,
        prompt: `${context}\n\n【作者要求】\n${route.instruction}`,
    });
    const text = stripFence(raw).trim();
    if (!text) throw new Error('模型没有返回正文内容');
    await appendMessages({ role: 'assistant', name: currentCharName() || '旁白', message: text });
    return receipt({
        task: route.task,
        label: TASK_LABEL[route.task],
        title: '已按作者要求演绎新剧情',
        lines: [`新增正文 ${text.length} 字`],
        detail: text.slice(0, 600),
    });
}

async function handleProseRevise(route, stage) {
    const target = resolveTargetMessage(route);
    if (!target) throw new Error('没有找到可以修改的回复');
    stage?.(`正在修订第 ${target.message_id + 1} 条…`);
    const original = target.message;
    const raw = await generateText({
        system: PROSE_GENERATE,
        prompt: proseRevisePrompt({ original, instruction: route.instruction }),
    });
    const text = stripFence(raw).trim();
    if (!text) throw new Error('模型没有返回修订后的正文');
    await replaceMessage(target.message_id, text);
    const lines = [`已修订第 ${target.message_id + 1} 条回复（${original.length} → ${text.length} 字）`];
    const warnings = [];

    if (route.needs_fact_fix) {
        stage?.('正在同步纠正记忆与世界书…');
        const correction = await applyCorrection(route.instruction, { silent: true });
        if (correction.touched?.length) lines.push(`已同步更正：${correction.touched.join('、')}`);
        else if (correction.note) lines.push(`纠错检查：${correction.note}`);
        if (correction.ok === false) warnings.push(correction.note);
    }

    return receipt({
        task: route.task,
        label: TASK_LABEL[route.task],
        title: '已完成正文修订',
        lines,
        warnings,
        detail: text.slice(0, 600),
        undo: async () => {
            await replaceMessage(target.message_id, original);
            toast('已撤销上一次修改', 'success');
        },
    });
}

/* ------------------------------------------------------------ 资料类任务 */

function keywordsFor(name, extra = []) {
    const keys = new Set();
    if (name) keys.add(name);
    for (const item of extra) if (item && item !== name) keys.add(item);
    return [...keys];
}

async function handleCharacterCreate(route, stage) {
    stage?.('正在创建人物档案…');
    const name = route.entities[0] || '';
    const memory = await readMemory();
    const raw = await generateText({
        prompt: characterPrompt({ instruction: route.instruction, memoryContext: memoryContextText(memory) }),
    });
    const content = stripFence(raw).trim();
    if (!content) throw new Error('模型没有返回人物档案内容');
    const isNpc = /NPC|路人|配角|掌柜|小二|掌柜|士兵|护卫|侍女|仆役/u.test(route.instruction) && !/主角|核心角色/u.test(route.instruction);
    const type = isNpc ? 'NPC' : '角色';
    const entries = buildEntries([
        {
            type,
            part: isNpc ? '' : 'basic',
            name: name ? `${name}_基础信息` : '新人物_基础信息',
            abstract: name ? `${name}的基础档案` : '新人物基础档案',
            content,
            keywords: keywordsFor(name, route.entities.slice(1)),
            constant: false,
            enabled: true,
        },
    ], { strictDashes: settings().lint.strictDashes });

    const book = await currentBook();
    if (lintBlocked(entries.lint)) {
        return receipt({
            ok: false,
            task: route.task,
            label: TASK_LABEL[route.task],
            title: '人物档案未写入：校验未通过',
            lines: entries.notes,
            warnings: entries.lint.errors.map(item => item.message),
        });
    }
    const result = await writeEntries(book, entries.entries, { mode: 'upsert' });
    return receipt({
        task: route.task,
        label: TASK_LABEL[route.task],
        title: `已创建人物：${name || entries.entries[0].name}`,
        lines: [describeWrite(book, result, entries.lint), ...entries.notes.slice(0, 3)],
        detail: content.slice(0, 600),
        warnings: entries.lint.warnings.map(item => item.message),
    });
}

async function handleCharacterUpdate(route, stage) {
    const name = route.entities[0] || '';
    if (route.scope === 'performance') {
        stage?.('正在生成当前表现指引…');
        const raw = await generateText({
            prompt: performancePrompt({ instruction: route.instruction, entities: route.entities }),
        });
        const text = stripFence(raw).trim();
        setPerformanceGuidance(text, route.entities);
        await refreshDialogueInjection(true);
        return receipt({
            task: route.task,
            label: TASK_LABEL[route.task],
            title: `已调整当前表现：${route.entities.join('、') || '相关人物'}`,
            lines: ['本次调整只作用于当前场景，人物档案不变', text.slice(0, 120)],
            detail: text,
        });
    }

    stage?.('正在更新人物档案…');
    const book = await currentBook();
    const data = await readWorldbook(book).catch(() => ({ entries: [] }));
    const existing = data.entries.find(entry => name && entry.name.includes(name)) ?? null;
    const memory = await readMemory();
    const raw = await generateText({
        prompt: characterPrompt({
            instruction: route.instruction,
            memoryContext: memoryContextText(memory),
            existing: existing?.content ?? '',
        }),
    });
    const content = stripFence(raw).trim();
    if (!content) throw new Error('模型没有返回更新后的人物档案');

    const entryName = existing?.name ?? (name ? `${name}_基础信息` : '人物_基础信息');
    const entries = buildEntries([
        {
            type: existing?.type ?? '角色',
            part: existing?.part || 'basic',
            name: entryName,
            abstract: `${name || entryName}的档案`,
            content,
            keywords: existing?.keys?.length ? existing.keys : keywordsFor(name, route.entities.slice(1)),
            constant: false,
            enabled: true,
        },
    ], { strictDashes: settings().lint.strictDashes });

    const result = await writeEntries(book, entries.entries, { mode: 'upsert' });
    const lines = [describeWrite(book, result, entries.lint)];

    if (route.needs_fact_fix) {
        stage?.('正在同步纠正记忆…');
        const correction = await applyCorrection(route.instruction, { silent: true });
        if (correction.touched?.length) lines.push(`已同步更正：${correction.touched.join('、')}`);
    }

    return receipt({
        task: route.task,
        label: TASK_LABEL[route.task],
        title: `已更新人物档案：${name || entryName}`,
        lines,
        detail: content.slice(0, 600),
        warnings: entries.lint.warnings.map(item => item.message),
    });
}

function lintBlocked(lint) {
    const config = settings();
    return config.lint.enabled && config.lint.blockOnError && lint.errors.length > 0;
}

async function handleWorldbookWrite(route, stage) {
    stage?.('正在整理世界书条目…');
    const memory = await readMemory();
    const context = [memoryContextText(memory), '【最近剧情】', recentHistory(settings().edit.historyMessages)].join('\n');
    const raw = await generateObject({
        system: worldbookPrompt({ instruction: route.instruction, context }),
        prompt: `作者要求：\n${route.instruction}`,
        schema: WORLDBOOK_ENTRY_SCHEMA,
    });
    const entries = buildEntries(raw?.entries ?? [], { strictDashes: settings().lint.strictDashes });
    if (!entries.entries.length) throw new Error('模型没有产出任何条目');
    if (lintBlocked(entries.lint)) {
        return receipt({
            ok: false,
            task: route.task,
            label: TASK_LABEL[route.task],
            title: '条目未写入：校验未通过',
            lines: entries.notes,
            warnings: entries.lint.errors.map(item => item.message),
        });
    }
    const book = await currentBook();
    const result = await writeEntries(book, entries.entries, { mode: 'upsert' });
    const names = entries.entries.map(entry => entry.name);
    return receipt({
        task: route.task,
        label: TASK_LABEL[route.task],
        title: '已写入世界书',
        lines: [
            describeWrite(book, result, entries.lint),
            names.length <= 4 ? `条目：${names.join('、')}` : `条目：${names.slice(0, 4).join('、')} 等 ${names.length} 条`,
            ...(raw?.notes ?? []).slice(0, 3).map(note => `待确认：${note}`),
        ],
        detail: entries.entries.map(entry => `### ${entry.name}\n${entry.content}`).join('\n\n').slice(0, 800),
        warnings: entries.lint.warnings.map(item => `${item.where}：${item.message}`),
    });
}

async function handleMemorySummarize(route, stage) {
    stage?.('正在整理长期记忆…');
    const result = await summarize({ silent: true });
    if (!result.ok) {
        return receipt({
            ok: false,
            task: route.task,
            label: TASK_LABEL[route.task],
            title: '暂不需要整理',
            lines: [result.reason ?? '剧情内容不足'],
        });
    }
    const lines = [`已更新长期记忆：新增 ${result.result.created} 条，更新 ${result.result.updated} 条`];
    if (result.memory.facts_removed?.length) lines.push(`已失效事实 ${result.memory.facts_removed.length} 条`);
    return receipt({
        task: route.task,
        label: TASK_LABEL[route.task],
        title: '已整理剧情与长期记忆',
        lines,
        detail: result.memory.summary.slice(0, 800),
    });
}

/* ------------------------------------------------------------ 入口 */

const HANDLERS = {
    [TASK.PROSE_GENERATE]: handleProseGenerate,
    [TASK.PROSE_REVISE]: handleProseRevise,
    [TASK.CHARACTER_CREATE]: handleCharacterCreate,
    [TASK.CHARACTER_UPDATE]: handleCharacterUpdate,
    [TASK.WORLDBOOK_WRITE]: handleWorldbookWrite,
    [TASK.MEMORY_SUMMARIZE]: handleMemorySummarize,
};

/**
 * 执行一条编辑指令。
 * @param {string} text 作者输入
 * @param {{stage?: (text: string) => void, route?: object}} options
 */
export async function runEditInstruction(text, { stage, route: presetRoute } = {}) {
    const value = String(text ?? '').trim();
    if (!value) return receipt({ ok: false, title: '指令为空', lines: ['请输入要对故事、人物、世界或系统做的修改。'] });
    try {
        const route = presetRoute ?? (await routeInstruction(value));
        stage?.(`识别为「${TASK_LABEL[route.task] ?? route.task}」…`);
        const handler = HANDLERS[route.task] ?? handleProseGenerate;
        const result = await handler(route, stage);
        return { ...result, route };
    } catch (error) {
        const message = error?.message ?? String(error);
        return receipt({
            ok: false,
            title: '编辑指令执行失败',
            lines: [message],
            warnings: [message],
        });
    }
}

/** 供对话模式调用：普通对话回复结束后按间隔整理记忆。 */
export async function maybeAutoMemory(turn) {
    const config = settings();
    if (!config.memory.enabled || config.memory.autoTrigger !== 'interval') return;
    const interval = Math.max(2, Number(config.memory.intervalTurns) || 12);
    if (!turn || turn % interval !== 0) return;
    try {
        const result = await summarize({ silent: true });
        if (result.ok) toast('已在后台更新长期记忆', 'success');
    } catch (error) {
        console.warn('[IF Enhancer] 自动记忆失败：', error?.message ?? error);
    }
    await refreshDialogueInjection(true);
}

export { resolveMemoryBook };
