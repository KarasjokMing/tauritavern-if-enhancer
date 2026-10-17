/**
 * 模型调用层：统一三种通路，任何一条不可用时明确降级并说明。
 *
 *   A. 酒馆助手 generateRaw / generate（主通路，支持 json_schema）
 *   B. TauriTavern Agent API（实验性，走 Profile + 工作区）
 *   C. 都没有 → 抛出可读错误，绝不静默假装成功
 */
import { TT, TH, ctx, sleep } from '../env.js';

let running = 0;

export function isBusy() {
    return running > 0;
}

async function withSlot(task) {
    running += 1;
    try {
        return await task();
    } finally {
        running -= 1;
    }
}

export function capabilities() {
    const th = TH();
    const tt = TT();
    return {
        tavernHelper: Boolean(th),
        generateRaw: typeof th?.generateRaw === 'function',
        generate: typeof th?.generate === 'function',
        jsonSchema: typeof th?.generate === 'function',
        agent: Boolean(tt?.api?.agent?.startRunFromLegacyGenerate),
        nativeSlash: typeof ctx()?.executeSlashCommandsWithOptions === 'function',
    };
}

export function capabilitiesText() {
    const caps = capabilities();
    return [
        caps.tavernHelper ? '酒馆助手 ✓' : '酒馆助手 ✗',
        caps.generateRaw ? '文本生成 ✓' : caps.nativeSlash ? '文本生成 △（/genraw 回退）' : '文本生成 ✗',
        caps.jsonSchema ? '结构化输出 ✓' : '结构化输出 ✗',
        caps.agent ? 'TT Agent ✓' : 'TT Agent ✗',
    ].join(' · ');
}

/** 剥掉模型可能加上的代码围栏。 */
export function stripFence(text) {
    const value = String(text ?? '').trim();
    const match = value.match(/^```(?:json|yaml|yml|markdown|md)?\s*\n([\s\S]*?)\n```$/);
    return match ? match[1].trim() : value;
}

function firstJsonBlock(text) {
    const value = stripFence(text);
    const start = value.search(/[[{]/);
    if (start < 0) return value;
    const opener = value[start];
    const closer = opener === '{' ? '}' : ']';
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < value.length; i += 1) {
        const char = value[i];
        if (inString) {
            if (escaped) escaped = false;
            else if (char === '\\') escaped = true;
            else if (char === '"') inString = false;
            continue;
        }
        if (char === '"') inString = true;
        else if (char === opener) depth += 1;
        else if (char === closer) {
            depth -= 1;
            if (depth === 0) return value.slice(start, i + 1);
        }
    }
    return value.slice(start);
}

export function parseJson(text, { fallback = null } = {}) {
    const candidates = [stripFence(text), firstJsonBlock(text)];
    for (const candidate of candidates) {
        try {
            return JSON.parse(candidate);
        } catch {
            /* 尝试下一个 */
        }
    }
    if (fallback !== null) return fallback;
    throw new Error(`无法解析模型返回的结构化结果：${String(text).slice(0, 120)}…`);
}

/**
 * 无酒馆助手时的原生回退：走 STscript /genraw（只用给定提示词，不叠加聊天上下文）。
 * 仅作保险，能力弱于酒馆助手通路。
 */
async function nativeGenerate({ system, historyText, prompt }) {
    const c = ctx();
    if (typeof c?.executeSlashCommandsWithOptions !== 'function') return null;
    const text = [system, historyText, prompt].filter(Boolean).join('\n\n').replace(/\|/g, '｜');
    console.warn('[IF Enhancer] 未检测到酒馆助手，改用 /genraw 原生通路。');
    const result = await c.executeSlashCommandsWithOptions(`/genraw ${text}`, { showOutput: false });
    const value = result?.pipe ?? result?.output ?? result;
    return typeof value === 'string' ? value : String(value ?? '');
}

/**
 * 生成纯文本。
 * @param {{system?: string, prompt: string, historyText?: string, useNativeContext?: boolean,
 *          maxTokens?: number, silent?: boolean, stop?: string[]}} params
 */
export async function generateText(params) {
    const { system = '', prompt, historyText = '', useNativeContext = false, silent = true } = params;
    const th = TH();
    if (!th?.generateRaw && !th?.generate) {
        const native = await nativeGenerate({ system, historyText, prompt });
        if (native !== null) return native;
        throw new Error('当前环境没有可用的生成通路：请确认已安装并启用「酒馆助手」扩展');
    }
    if (historyText) {
        // 由调用方拼好的上下文直接并入提示词，保证可复现。
    }
    const body = [historyText, prompt].filter(Boolean).join('\n\n');
    return withSlot(async () => {
        if (typeof th.generateRaw === 'function') {
            const ordered = [];
            if (system) ordered.push({ role: 'system', content: system });
            if (useNativeContext) ordered.push('chat_history');
            ordered.push({ role: 'user', content: body });
            const result = await th.generateRaw({
                ordered_prompts: ordered,
                should_stream: false,
                should_silence: silent,
            });
            return typeof result === 'string' ? result : String(result?.content ?? '');
        }
        const result = await th.generate({
            user_input: body,
            should_stream: false,
            should_silence: silent,
            overrides: system ? { char_description: system } : undefined,
        });
        return typeof result === 'string' ? result : String(result?.content ?? '');
    });
}

/**
 * 生成结构化对象（json_schema）。
 * 不支持结构化输出时退回纯文本 + 容错解析。
 */
export async function generateObject({ system = '', prompt, schema, silent = true }) {
    const th = TH();
    if (!th?.generate && !th?.generateRaw && typeof ctx()?.executeSlashCommandsWithOptions !== 'function') {
        throw new Error('当前环境没有可用的生成通路：请确认已安装并启用「酒馆助手」扩展');
    }
    return withSlot(async () => {
        if (typeof th.generate === 'function' && schema) {
            try {
                const result = await th.generate({
                    user_input: prompt,
                    should_stream: false,
                    should_silence: silent,
                    json_schema: schema,
                    overrides: system ? { char_description: system } : undefined,
                });
                const text = typeof result === 'string' ? result : String(result?.content ?? '');
                return parseJson(text);
            } catch (error) {
                console.warn('[IF Enhancer] 结构化输出失败，退回文本解析：', error?.message ?? error);
            }
        }
        const text = await generateText({ system, prompt, silent });
        return parseJson(text);
    });
}

/**
 * TauriTavern Agent 通路（实验性）。
 * 复用当前聊天的上下文组织，由 Profile 描述任务。
 */
export async function runAgent({ profileId, presentation = 'foreground', options = {}, timeoutMs = 180000 } = {}) {
    const tt = TT();
    try {
        const ready = tt?.ready ?? globalThis.__TAURITAVERN_MAIN_READY__;
        if (ready && typeof ready.then === 'function') await ready;
    } catch {
        /* 忽略 */
    }
    const agent = tt?.api?.agent;
    if (!agent?.startRunFromLegacyGenerate) {
        throw new Error('TT Agent 通路不可用：当前不是 TauriTavern，或宿主未暴露 api.agent');
    }
    const run = await agent.startRunFromLegacyGenerate({
        generationType: 'normal',
        profileId,
        presentation,
        options: { presentation, stream: false, ...options },
    });
    const events = [];
    let stop = () => {};
    const terminal = new Set(['run_completed', 'run_failed', 'run_cancelled']);
    const finished = new Promise(resolve => {
        const timer = setTimeout(() => {
            stop();
            resolve({ ok: false, error: 'Agent 运行超时' });
        }, timeoutMs);
        stop = agent.subscribe(run.runId, event => {
            events.push({ type: event.type, payload: event.payload });
            if (!terminal.has(event.type)) return;
            clearTimeout(timer);
            stop();
            resolve({
                ok: event.type === 'run_completed',
                error: event.type === 'run_failed' ? event.payload?.message ?? event.payload?.error ?? 'Agent 运行失败' : undefined,
                cancelled: event.type === 'run_cancelled',
            });
        });
    });
    const outcome = await finished;
    return { runId: run.runId, events, ...outcome };
}

/** 读取 Agent 工作区文件（persist/ 等）。 */
export async function readAgentWorkspaceFile(runId, path) {
    const agent = TT()?.api?.agent;
    if (!agent?.readWorkspaceFile) return null;
    try {
        const file = await agent.readWorkspaceFile({ runId, path });
        return file?.text ?? null;
    } catch {
        return null;
    }
}

export async function cancelAgentRun(runId) {
    const agent = TT()?.api?.agent;
    if (!agent?.cancel) return false;
    try {
        await agent.cancel(runId);
        return true;
    } catch {
        return false;
    }
}

export { sleep };
