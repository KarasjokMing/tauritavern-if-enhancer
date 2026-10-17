/**
 * 自动配图：扩展自己根据剧情写提示词，作者不需要写任何 prompt。
 *
 * 提示词来源可以是当前聊天模型，也可以是反重力中继（Gemini Flash 类模型写画面提示词更快更便宜）。
 * 出图走酒馆自带的图像扩展：斜杠命令 /imagine（别名 /sd、/img）。
 */
import { settings } from '../config.js';
import { ctx, getRequestHeaders } from '../env.js';
import { generateObject, isBusy } from './llm.js';
import { getMessages, renderHistory } from './chat.js';
import { readMemory, memoryContextText } from './memory.js';
import { readWorldbook, resolveTargetBook } from '../worldbook/adapter.js';
import { IMAGE_PROMPT_SYSTEM, IMAGE_PROMPT_SCHEMA } from '../prompts.js';

/** 清理会破坏 STscript 解析的字符（管道/花括号/反斜杠/双引号）。 */
export function sanitizeForSlash(text) {
    return String(text ?? '')
        .replace(/[|{}\\"]/g, ' ')
        .replace(/[\r\n]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

/** 按逗号拆分标签、去重（不区分大小写）后重组，避免模型 prompt 与固定后缀重复。 */
function dedupeTags(parts) {
    const seen = new Set();
    const out = [];
    for (const part of parts) {
        for (const tag of String(part ?? '').split(',')) {
            const value = tag.trim();
            if (!value) continue;
            const key = value.toLowerCase();
            if (seen.has(key)) continue;
            seen.add(key);
            out.push(value);
        }
    }
    return out.join(', ');
}

/** 组装最终提示词：模型给的 prompt + 模型给的画风 + 用户设置的固定画风后缀。 */
export function composePrompt(parsed, styleSuffix = '') {
    return dedupeTags([parsed?.prompt, parsed?.style, styleSuffix]);
}

export function composeNegative(parsed, userNegative = '') {
    return dedupeTags([parsed?.negative, userNegative]);
}

/**
 * 通过酒馆自己的 chat-completions 后端调用反重力中继。
 *
 * 真机实测：页面里直接 fetch 跨域中继会被 CORS 拦掉（`Failed to fetch`），
 * 而酒馆后端（TauriTavern 的 Rust 侧）出网没有同源限制 —— 所以必须走后端，
 * 这也是连接配置里 custom 源的工作方式。
 */
async function generateViaBackend({ system, prompt }) {
    const config = settings();
    const url = String(config.image.relayUrl ?? '').replace(/\/+$/, '');
    if (!url) throw new Error('没有配置反重力中继地址');
    const headers = getRequestHeaders();
    const response = await fetch('/api/backends/chat-completions/generate', {
        method: 'POST',
        headers,
        body: JSON.stringify({
            chat_completion_source: 'custom',
            custom_url: url,
            custom_include_headers: `Authorization: Bearer ${config.image.relayKey || 'local-gateway'}\n`,
            custom_include_body: '',
            custom_exclude_body: '',
            custom_prompt_post_processing: 'none',
            model: config.image.relayModel || 'gemini-3.8-flash',
            messages: [
                { role: 'system', content: system },
                { role: 'user', content: prompt },
            ],
            max_tokens: 2048,
            temperature: 0.8,
            stream: false,
        }),
    });
    if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw new Error(`酒馆后端调用反重力失败：HTTP ${response.status}${detail ? ` ${detail.slice(0, 160)}` : ''}`);
    }
    const data = await response.json();
    const text = data?.choices?.[0]?.message?.content ?? data?.content ?? '';
    const { parseJson } = await import('./llm.js');
    return parseJson(text, { fallback: null }) ?? { prompt: String(text).trim() };
}

/** 让模型根据剧情写提示词。 */
export async function deriveImagePrompt({ recent, memory, stage } = {}) {
    const config = settings();
    const sheets = await characterSheets(recent, memory);
    const userPrompt = [
        '【当前场景与最近剧情】',
        recent || '（无，请画一个符合世界观的日常场景）',
        '',
        '【长期记忆】',
        memoryContextText(memory) || '（无）',
        '',
        '【人物外貌锚点】',
        sheets || '（无，可自行补全外观，但不要与剧情冲突）',
    ].join('\n');

    if (config.image.promptChannel === 'relay') {
        stage?.('正在用反重力写配图提示词…');
        try {
            return await generateViaBackend({ system: IMAGE_PROMPT_SYSTEM, prompt: userPrompt });
        } catch (error) {
            console.warn('[IF Enhancer] 反重力写提示词失败，改用当前聊天模型：', error?.message ?? error);
            stage?.(`反重力不可用，改用当前聊天模型…`);
        }
    }
    stage?.('正在为当前场景写配图提示词…');
    return await generateObject({ system: IMAGE_PROMPT_SYSTEM, prompt: userPrompt, schema: IMAGE_PROMPT_SCHEMA, silent: true });
}

/** 从世界书里挑出与当前场景相关的人物外貌锚点。 */
async function characterSheets(recent, memory) {
    if (!settings().image.includeCharacterSheets) return '';
    const names = new Set();
    for (const line of memory?.characters ?? []) {
        const name = String(line).split(/[:：]/)[0].trim();
        if (name.length >= 2 && name.length <= 6) names.add(name);
    }
    for (const name of String(memory?.scene ?? '').match(/[\u4e00-\u9fff]{2,4}/gu) ?? []) names.add(name);
    if (!names.size) return '';
    try {
        const book = await resolveTargetBook(settings().worldbook);
        const data = await readWorldbook(book);
        const picked = [];
        for (const entry of data.entries) {
            if (!entry.content) continue;
            const hit = [...names].some(name => entry.name.includes(name) || entry.content.slice(0, 120).includes(name));
            if (!hit) continue;
            picked.push(`### ${entry.name}\n${entry.content.slice(0, 400)}`);
            if (picked.length >= 4) break;
        }
        return picked.join('\n\n');
    } catch {
        return '';
    }
}

/**
 * 对话模式里的自动配图：按回复条数间隔自动出一张。
 * 提示词完全由扩展根据剧情撰写，作者不需要输入任何内容。
 */
export async function maybeAutoImage(turn, { onStage, onResult } = {}) {
    const config = settings();
    if (!config.image.enabled || config.image.auto !== 'interval') return false;
    const interval = Math.max(2, Number(config.image.intervalReplies) || 6);
    if (!turn || turn % interval !== 0) return false;
    if (isBusy()) {
        console.warn('[IF Enhancer] 自动配图跳过：上一条任务仍在执行');
        return false;
    }
    onStage?.('自动配图：正在按剧情写提示词…');
    try {
        const result = await generateSceneImage({ stage: onStage });
        onResult?.({
            ok: result.ok,
            label: '生成配图',
            title: result.ok ? '已自动生成配图（提示词由扩展撰写）' : '自动配图未生成',
            lines: [result.summary ? `画面：${result.summary}` : '', `提示词：${result.prompt.slice(0, 100)}…`].filter(Boolean),
            detail: result.detail,
            warnings: result.warnings,
        });
        return result.ok;
    } catch (error) {
        const message = error?.message ?? String(error);
        console.warn('[IF Enhancer] 自动配图失败：', message);
        onResult?.({ ok: false, label: '生成配图', title: '自动配图失败', lines: [message] });
        return false;
    } finally {
        onStage?.('');
    }
}

export async function generateSceneImage({ stage } = {}) {
    const config = settings();
    const c = ctx();
    if (typeof c?.executeSlashCommandsWithOptions !== 'function') {
        throw new Error('当前环境无法执行酒馆斜杠命令，无法调用图像扩展');
    }
    const memory = await readMemory().catch(() => ({}));
    const recent = renderHistory(getMessages('all').slice(-10), { limitChars: 3000 });
    const parsed = await deriveImagePrompt({ recent, memory, stage });

    const prompt = composePrompt(parsed, config.image.styleSuffix);
    const negative = composeNegative(parsed, config.image.negative);
    if (!prompt) throw new Error('模型没有给出可用的图像提示词');
    const clipped = sanitizeForSlash(prompt).slice(0, Math.max(80, Number(config.image.maxPromptChars) || 600));

    const args = [`quiet=${config.image.quiet ? 'true' : 'false'}`, `gallery=${config.image.gallery !== false ? 'true' : 'false'}`];
    if (negative) args.push(`negative="${sanitizeForSlash(negative).slice(0, 240)}"`);

    stage?.('正在出图（ComfyUI）…');
    const result = await c.executeSlashCommandsWithOptions(`/imagine ${args.join(' ')} ${clipped}`, { showOutput: false });
    const url = typeof result?.pipe === 'string' ? result.pipe.trim() : typeof result === 'string' ? result.trim() : '';
    const summary = String(parsed?.scene_summary ?? '').trim();

    return {
        ok: Boolean(url),
        url,
        prompt: clipped,
        negative,
        summary,
        detail: [`画面：${summary || '（模型未给说明）'}`, `提示词：${prompt}`, negative ? `负面：${negative}` : '', url ? `图片：${url}` : '']
            .filter(Boolean)
            .join('\n'),
        warnings: url ? [] : ['图像扩展没有返回图片地址：请检查酒馆的图像生成设置（后端 / 工作流 / 模型）'],
    };
}
