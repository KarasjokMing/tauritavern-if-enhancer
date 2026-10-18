/**
 * 设置项：默认值、深合并、读写。
 * 所有可调参数集中在此，UI 面板按同一结构渲染。
 */
import { rawSettings, saveSettings } from './env.js';

export const DEFAULTS = {
    version: 2,
    enabled: true,
    defaultMode: 'dialogue',
    lastMode: 'dialogue',
    rememberMode: true,
    /** 作者用编辑模式下达的运行偏好，按时间顺序累积（同时写进世界书「作者偏好」条目）。 */
    authorPreferences: [],
    dialogue: {
        injectRules: true,
        injectSceneState: true,
        position: 'in_chat',
        depth: 1,
    },
    edit: {
        taskType: 'auto', // auto | prose.generate | prose.revise | config.adjust | character.* | worldbook.write | memory.summarize
        receipt: 'bar', // bar | message | both | off
        showInstruction: true,
        logInstruction: 'bar', // bar | chat | both —— 作者指令是否也写进聊天（隐藏消息）
        historyMessages: 24,
        autoApplyWorldbook: true,
        confirmBeforeRevise: true,
    },
    worldbook: {
        target: 'char', // char | chat | global —— 默认写进角色卡绑定的世界书
        nameTemplate: '{{char}}·互动小说',
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
    /** 自动配图：插件自己按剧情写提示词，作者不需要写 prompt。 */
    image: {
        enabled: false,
        auto: 'off', // off | interval
        intervalReplies: 6,
        promptChannel: 'relay', // relay | chat
        relayUrl: 'http://192.168.31.226:8046/v1',
        relayModel: 'gemini-3.8-flash',
        relayKey: 'local-gateway',
        styleSuffix: '',
        negative: '',
        gallery: true,
        quiet: false,
        includeCharacterSheets: true,
        maxPromptChars: 600,
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

/** 深合并：只用 defaults 里存在的键，避免历史脏字段回流。数组整体替换。 */
export function mergeDefaults(defaults, incoming) {
    if (Array.isArray(defaults)) {
        return Array.isArray(incoming) ? [...incoming] : [...defaults];
    }
    const out = { ...defaults };
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

/**
 * 设置迁移：老版本存在用户设置里的旧默认值会覆盖新默认值，必须显式迁移。
 * v1 → v2：写入目标从「独立的聊天·互动小说书」改为「角色卡绑定的世界书」。
 */
export function migrateSettings(raw) {
    if (!raw || typeof raw !== 'object') return false;
    const from = Number(raw.version ?? 1);
    if (from >= DEFAULTS.version) return false;
    if (from < 2) {
        raw.worldbook ??= {};
        if (!raw.worldbook.primaryName) {
            raw.worldbook.target = 'char';
            if (!raw.worldbook.nameTemplate || raw.worldbook.nameTemplate === '{{chat}}·互动小说') {
                raw.worldbook.nameTemplate = '{{char}}·互动小说';
            }
        }
    }
    raw.version = DEFAULTS.version;
    return true;
}

export function settings() {
    if (!cache) {
        const box = rawSettings();
        if (migrateSettings(box)) saveSettings();
        cache = mergeDefaults(DEFAULTS, box);
    }
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
