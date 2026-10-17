/**
 * 设置项：默认值、深合并、读写。
 * 所有可调参数集中在此，UI 面板按同一结构渲染。
 */
import { rawSettings, saveSettings } from './env.js';

export const DEFAULTS = {
    version: 1,
    enabled: true,
    defaultMode: 'dialogue',
    lastMode: 'dialogue',
    rememberMode: true,
    dialogue: {
        injectRules: true,
        injectSceneState: true,
        position: 'in_chat',
        depth: 1,
    },
    edit: {
        receipt: 'bar', // bar | message | both | off
        historyMessages: 24,
        autoApplyWorldbook: true,
        confirmBeforeRevise: true,
    },
    worldbook: {
        target: 'chat', // chat | char | global
        nameTemplate: '{{chat}}·互动小说',
        autoCreate: true,
        primaryName: '',
    },
    memory: {
        enabled: true,
        autoTrigger: 'interval', // interval | scene | manual
        intervalTurns: 12,
        book: '',
        keepSummaryEntries: 40,
    },
    lint: {
        enabled: true,
        blockOnError: false,
        strictDashes: true,
    },
    agent: {
        enabled: true,
        profileAuthor: 'if-author',
        profileMemory: 'if-memory',
        preferAgentForProse: true,
        fallbackToGenerate: true,
    },
};

function isPlainObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** 深合并：只用 defaults 里存在的键，避免历史脏字段回流。 */
export function mergeDefaults(defaults, incoming) {
    const out = Array.isArray(defaults) ? [...defaults] : { ...defaults };
    if (!isPlainObject(incoming)) return out;
    for (const [key, value] of Object.entries(defaults)) {
        const got = incoming[key];
        if (isPlainObject(value)) {
            out[key] = mergeDefaults(value, got);
        } else if (got !== undefined && typeof got === typeof value) {
            out[key] = got;
        } else if (got !== undefined && typeof value === 'number' && typeof got === 'string' && got.trim() !== '' && Number.isFinite(Number(got))) {
            out[key] = Number(got);
        } else if (got !== undefined && typeof value === 'string' && typeof got !== 'string') {
            out[key] = String(got);
        }
    }
    return out;
}

let cache = null;

export function settings() {
    if (!cache) cache = mergeDefaults(DEFAULTS, rawSettings());
    return cache;
}

/** 修改设置并落盘。 */
export function updateSettings(patch) {
    const next = mergeDefaults(settings(), patch);
    cache = next;
    const box = rawSettings();
    if (box) Object.assign(box, next);
    saveSettings();
    return cache;
}

export function setSetting(path, value) {
    const parts = String(path).split('.');
    const patch = {};
    let cursor = patch;
    parts.forEach((part, index) => {
        if (index === parts.length - 1) cursor[part] = value;
        else cursor = cursor[part] = {};
    });
    return updateSettings(patch);
}

export function getSetting(path) {
    return String(path)
        .split('.')
        .reduce((acc, key) => (acc == null ? acc : acc[key]), settings());
}

/** 供测试重置缓存。 */
export function resetSettingsCache() {
    cache = null;
}
