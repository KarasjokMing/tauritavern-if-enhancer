/**
 * 对话模式：把"导演规则 + 当前场景状态"注入正常生成的提示层。
 * 对话模式不改动聊天记录，用户输入照旧代表主角。
 */
import { settings } from '../config.js';
import { ctx, toast } from '../env.js';
import { DIALOGUE_RULES, PROTAGONIST_LOCK } from '../prompts.js';
import { readMemory, memoryContextText } from './memory.js';

const KEY = 'TT_IF_DIALOGUE';

let cachedText = '';
let active = false;

/** 把 {{user}} / {{char}} 换成真实名字——注入文本不保证会被酒馆替换宏。 */
export function substituteNames(text) {
    const c = ctx();
    const userName = c?.name1 || '玩家';
    const charName = c?.name2 || c?.characters?.[c.characterId]?.name || '角色';
    return String(text ?? '').replaceAll('{{user}}', userName).replaceAll('{{char}}', charName);
}

function injectionPoint() {
    const c = ctx();
    const types = c?.extensionPromptTypes ?? {};
    const inChat = types.IN_CHAT ?? 1;
    const inPrompt = types.IN_PROMPT ?? 0;
    return settings().dialogue.position === 'in_prompt' ? inPrompt : inChat;
}

function performanceBlock() {
    const c = ctx();
    const store = c?.extensionSettings?.tt_if_enhancer;
    const perf = store?.performance;
    if (!perf?.text) return '';
    if (perf.expiresAt && Date.now() > perf.expiresAt) return '';
    return `【本场表现调整（临时，不改档案）】\n${perf.text}`;
}

/** 作者用编辑模式下达的运行偏好（推进速度、节奏、篇幅、文风、尺度等）。 */
function preferenceBlock() {
    const list = settings().authorPreferences ?? [];
    if (!list.length) return '';
    return `【作者偏好与运行约束】\n${list.map(item => `- ${item.text}`).join('\n')}`;
}

/**
 * 组装注入文本。对话模式注入完整导演规则；演绎模式只注入主角锁定（不干扰预设的文风）。
 * @param {'dialogue'|'prose'|'edit'} activeMode
 */
export async function buildDialogueText(activeMode = 'dialogue') {
    const config = settings();
    const parts = [];
    if (activeMode === 'dialogue' && config.dialogue.injectRules) {
        parts.push(substituteNames(DIALOGUE_RULES));
        if (config.dialogue.injectSceneState) {
            try {
                const memory = await readMemory();
                const text = memoryContextText(memory);
                if (text) parts.push(`【故事当前状态】\n${text}`);
            } catch {
                /* 记忆不可读时忽略 */
            }
        }
    } else if (activeMode === 'prose') {
        parts.push(substituteNames(PROTAGONIST_LOCK));
    }
    const prefs = preferenceBlock();
    if (prefs) parts.push(prefs);
    const perf = performanceBlock();
    if (perf) parts.push(perf);
    return parts.join('\n\n');
}

function normalizeMode(activeMode) {
    if (activeMode === true) return 'dialogue';
    if (activeMode === false || activeMode == null) return 'none';
    return activeMode;
}

/** 写入或清除注入。 */
export function applyDialogueInjection(activeMode = active) {
    const mode = normalizeMode(activeMode);
    active = mode;
    const c = ctx();
    if (!c?.setExtensionPrompt) return false;
    const box = c.extensionSettings?.tt_if_enhancer;
    const wanted = mode === 'dialogue' || mode === 'prose';
    if (!settings().enabled || !wanted) {
        c.setExtensionPrompt(KEY, '', injectionPoint(), 0, false, 0);
        return true;
    }
    if (box) box.dialogueInjected = true;
    c.setExtensionPrompt(KEY, cachedText, injectionPoint(), Number(settings().dialogue.depth ?? 1), false, 0);
    return true;
}

/** 重新计算并应用（切换模式、切聊天、编辑完成后调用）。 */
export async function refreshDialogueInjection(activeMode = active) {
    const mode = normalizeMode(activeMode);
    cachedText = await buildDialogueText(mode === 'none' ? 'dialogue' : mode);
    return applyDialogueInjection(mode);
}

export function clearDialogueInjection() {
    const c = ctx();
    active = 'none';
    c?.setExtensionPrompt?.(KEY, '', injectionPoint(), 0, false, 0);
}

/** 记录一次临时表现调整（供后续若干轮沿用）。 */
export function setPerformanceGuidance(text, entities = [], turns = 8) {
    const c = ctx();
    c.extensionSettings ??= {};
    c.extensionSettings.tt_if_enhancer ??= {};
    c.extensionSettings.tt_if_enhancer.performance = {
        text: String(text ?? '').trim(),
        entities,
        expiresAt: Date.now() + Math.max(1, turns) * 30 * 60 * 1000,
    };
    c.saveSettingsDebounced?.();
    toast('已应用当前表现调整（不修改人物档案）', 'success');
}

export function performanceGuidance() {
    const c = ctx();
    return c?.extensionSettings?.tt_if_enhancer?.performance ?? null;
}
