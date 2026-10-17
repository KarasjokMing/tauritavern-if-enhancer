/**
 * 模型调用层：统一三种通路，任何一条不可用时明确降级并说明。
 *
 *   A. 酒馆助手 generateRaw / generate（主通路，支持 json_schema）
 *   B. TauriTavern Agent API（实验性，走 Profile + 工作区）
 *   C. 都没有 → 抛出可读错误，绝不静默假装成功
 */
import { TT, TH, ctx, rawSettings, saveSettings, sleep } from '../env.js';

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
        jsonSchemaDegraded: schemaUnsupportedKnown(),
        agent: Boolean(tt?.api?.agent?.startRunFromLegacyGenerate),
        nativeSlash: typeof ctx()?.executeSlashCommandsWithOptions === 'function',
    };
}

export function capabilitiesText() {
    const caps = capabilities();
    return [
        caps.tavernHelper ? '酒馆助手 ✓' : '酒馆助手 ✗',
        caps.generateRaw ? '文本生成 ✓' : caps.nativeSlash ? '文本生成 △（/genraw 回退）' : '文本生成 ✗',
        caps.jsonSchemaDegraded
            ? '结构化输出 △（供应商不支持，已降级为文本+修复）'
            : caps.jsonSchema
              ? '结构化输出 ✓'
              : '结构化输出 ✗',
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
    const preview = String(text ?? '').replace(/\s+/g, ' ').slice(0, 300);
    throw new Error(`模型没有按要求返回结构化结果（收到的内容：${preview}${String(text ?? '').length > 300 ? '…' : ''}）`);
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
            user_input: system ? `${system}\n\n${body}` : body,
            should_stream: false,
            should_silence: silent,
        });
        return typeof result === 'string' ? result : String(result?.content ?? '');
    });
}

const JSON_RULES = [
    '输出格式要求（必须严格遵守）：',
    '1. 只输出一个 JSON 对象：不要输出解释、说明、标题、问候或 Markdown 代码块；',
    '2. 第一个字符必须是 {，最后一个字符必须是 }；',
    '3. 字段名与取值类型必须符合给定的 JSON Schema，不要新增或遗漏字段；',
    '4. 内容不确定时用空字符串或空数组表示，不要写"待确认"之类的占位文字。',
].join('\n');

/**
 * 供应商可能不支持结构化输出。
 * 真机实测：DeepSeek 返回 `[API 错误] This response_format type is unavailable now`，
 * 而且这条错误是**当作正常文本**返回的，不抛异常 —— 必须主动识别，
 * 否则会被误当成模型输出（真机上表现为"模型返回了 Markdown/乱码"）。
 */
const API_ERROR_HINT = /\[API 错误\]|response_format type is unavailable|invalid[_ ]request[_ ]error|API error/i;

/**
 * 供应商是否已被确认不支持结构化输出。跨会话记住这个事实：
 * 命中一次之后就不再发注定失败的请求，直接走「纯文本 + 强 JSON 约束 + 转换修复」。
 * null = 尚未从设置里读过。
 */
let jsonSchemaUnsupported = null;

export function schemaUnsupportedKnown() {
    if (jsonSchemaUnsupported === null) {
        try {
            jsonSchemaUnsupported = Boolean(rawSettings()?.jsonSchemaUnsupported);
        } catch {
            jsonSchemaUnsupported = false;
        }
    }
    return jsonSchemaUnsupported;
}

/** 更换模型后可以重新尝试结构化输出。 */
export function resetSchemaCapability() {
    jsonSchemaUnsupported = false;
    const box = rawSettings();
    if (box) box.jsonSchemaUnsupported = false;
    saveSettings();
}

export function isProviderApiError(text) {
    return looksLikeApiError(text);
}

function looksLikeApiError(text) {
    return API_ERROR_HINT.test(String(text ?? '').slice(0, 500));
}

/** 一次性结构化请求：能走原生结构化就走，供应商不支持时自动退回纯文本 + 强 JSON 约束。 */
async function attemptJson({ system, prompt, schema, silent }) {
    const th = TH();
    const sys = `${JSON_RULES}\n\n${system ?? ''}`.trim();
    const user = `${prompt}\n\n（再次强调：直接输出 JSON 对象，不要写说明文字、标题或 Markdown 代码块。）`;
    const canStructured = Boolean(schema) && !schemaUnsupportedKnown();

    if (canStructured && typeof th?.generateRaw === 'function') {
        try {
            const result = await th.generateRaw({
                ordered_prompts: [
                    { role: 'system', content: sys },
                    { role: 'user', content: user },
                ],
                should_stream: false,
                should_silence: silent,
                json_schema: schema,
            });
            const text = typeof result === 'string' ? result : String(result?.content ?? '');
            if (text.trim() && !looksLikeApiError(text)) return text;
            if (looksLikeApiError(text)) markSchemaUnsupported(text);
        } catch (error) {
            console.warn('[IF Enhancer] generateRaw + json_schema 调用失败：', error?.message ?? error);
        }
    }
    if (canStructured && typeof th?.generate === 'function') {
        try {
            const result = await th.generate({
                user_input: `${sys}\n\n${user}`,
                should_stream: false,
                should_silence: silent,
                json_schema: schema,
            });
            const text = typeof result === 'string' ? result : String(result?.content ?? '');
            if (text.trim() && !looksLikeApiError(text)) return text;
            if (looksLikeApiError(text)) markSchemaUnsupported(text);
        } catch (error) {
            console.warn('[IF Enhancer] generate + json_schema 调用失败：', error?.message ?? error);
        }
    }
    return await generateText({ system: sys, prompt: user, silent });
}

function markSchemaUnsupported(text) {
    if (jsonSchemaUnsupported) return;
    jsonSchemaUnsupported = true;
    const box = rawSettings();
    if (box) {
        box.jsonSchemaUnsupported = true;
        saveSettings();
    }
    console.warn(
        '[IF Enhancer] 当前供应商不支持结构化输出（response_format），已改为「纯文本 + 强 JSON 约束 + 转换修复」模式，并记住这个结论。更换模型后可在设置面板点「重新尝试结构化输出」。',
        String(text).slice(0, 160),
    );
}

export function jsonSchemaAvailable() {
    return !schemaUnsupportedKnown();
}

/**
 * 生成结构化对象：先请求一次；解析失败则把上一次的回答交给模型做一次"转换成 JSON"的修复。
 * 修复这一步在真机上显著提高了成功率（转换比"边写文档边保证 JSON 格式"简单得多）。
 */
export async function generateObject({ system = '', prompt, schema, silent = true }) {
    const th = TH();
    const native = typeof ctx()?.executeSlashCommandsWithOptions === 'function';
    if (!th?.generate && !th?.generateRaw && !native) {
        throw new Error('当前环境没有可用的生成通路：请确认已安装并启用「酒馆助手」扩展');
    }
    return withSlot(async () => {
        const first = await attemptJson({ system, prompt, schema, silent });
        try {
            return parseJson(first);
        } catch (firstError) {
            console.warn('[IF Enhancer] 首次结构化输出不可解析，尝试一次转换修复：', firstError?.message ?? firstError);
            const repair = [
                '你上一次的回答不是要求的 JSON。请把它转换成符合 JSON Schema 的 JSON。',
                '只输出 JSON 本身，不要解释、不要 Markdown 代码块。',
                '',
                '【JSON Schema】',
                JSON.stringify(schema?.value ?? schema ?? {}),
                '',
                '【上一次的回答】',
                String(first).slice(0, 6000),
            ].join('\n');
            const second = await attemptJson({ system: '你是一个只输出 JSON 的格式转换器。', prompt: repair, schema, silent });
            return parseJson(second);
        }
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
