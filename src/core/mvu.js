/**
 * MVU（MagVarUpdate）变量读写。
 *
 * 真机实测（多子多福-明末）：变量值不在 chat_metadata，而在
 *   message.variables[swipe_id].stat_data
 * 形如 { 世界:{当前时间,…}, 大明:{国库,…}, 系统:{积分,…}, 主角:{魅力,…}, 后宫:[{姓名,好感,…}] }。
 *
 * 规则条目（增长规则、变量列表、输出格式）在角色卡的内嵌世界书里，
 * 名字带 `[mvu_update]` / `[initvar]` 前缀，用 card.js 读写。
 */
import { ctx, TH } from '../env.js';

/** 取指定楼层的变量对象（默认最后一楼）。 */
export function readMessageVariables({ messageId = null } = {}) {
    const chat = ctx()?.chat ?? [];
    const id = messageId == null ? chat.length - 1 : messageId;
    const message = chat[id];
    if (!message) return null;
    const swipe = Number.isInteger(message.swipe_id) ? message.swipe_id : 0;
    const holder = Array.isArray(message.variables) ? message.variables[swipe] : message.variables;
    return holder && typeof holder === 'object' ? holder : null;
}

/** 读 stat_data（MVU 的变量本体）。 */
export function readStatData(options = {}) {
    return readMessageVariables(options)?.stat_data ?? null;
}

/** stat_data 是否已存在（卡是否在跑 MVU）。 */
export function hasStatData(options = {}) {
    const stat = readStatData(options);
    return Boolean(stat && typeof stat === 'object' && Object.keys(stat).length);
}

/**
 * 写回 stat_data 并刷新该楼层（状态栏会立即更新）。
 * @param {object} statData 完整的 stat_data
 */
export async function writeStatData(statData, { messageId = null } = {}) {
    const c = ctx();
    const chat = c?.chat ?? [];
    const id = messageId == null ? chat.length - 1 : messageId;
    const message = chat[id];
    if (!message) throw new Error('没有可写入的消息楼层');
    const swipe = Number.isInteger(message.swipe_id) ? message.swipe_id : 0;
    if (!Array.isArray(message.variables)) {
        message.variables = [];
    }
    if (!message.variables[swipe] || typeof message.variables[swipe] !== 'object') {
        message.variables[swipe] = {};
    }
    message.variables[swipe].stat_data = statData;
    await c.saveChat?.();
    try {
        TH()?.refreshOneMessage?.(id);
    } catch (error) {
        console.warn('[IF Enhancer] 刷新楼层失败（状态栏可能需手动刷新）：', error?.message ?? error);
    }
    return true;
}

/** 把 'a.b[0].c' 这样的路径解析成数组。 */
export function parsePath(path) {
    return String(path ?? '')
        .replace(/\[(\d+)\]/g, '.$1')
        .split('.')
        .map(part => part.trim())
        .filter(Boolean);
}

function getAt(node, parts) {
    let cursor = node;
    for (const part of parts) {
        if (cursor == null) return undefined;
        cursor = cursor[part];
    }
    return cursor;
}

function setAt(node, parts, value) {
    let cursor = node;
    for (let i = 0; i < parts.length - 1; i += 1) {
        const part = parts[i];
        const nextIsIndex = /^\d+$/.test(parts[i + 1]);
        if (cursor[part] == null) cursor[part] = nextIsIndex ? [] : {};
        cursor = cursor[part];
    }
    cursor[parts.at(-1)] = value;
    return node;
}

/**
 * 按路径改值：支持增减与直接赋值。
 * patch: { '主角.魅力': 90, '后宫[0].好感': { delta: +10 } }
 */
export function applyStatPatch(statData, patch) {
    const next = JSON.parse(JSON.stringify(statData ?? {}));
    for (const [path, value] of Object.entries(patch ?? {})) {
        const parts = parsePath(path);
        if (!parts.length) continue;
        if (value && typeof value === 'object' && 'delta' in value) {
            const current = Number(getAt(next, parts));
            const base = Number.isFinite(current) ? current : 0;
            setAt(next, parts, base + Number(value.delta));
        } else {
            setAt(next, parts, value);
        }
    }
    return next;
}

/** 拍平变量（只展开对象与数组元素，便于展示/校验路径）。 */
export function flattenStatData(statData, prefix = '') {
    const out = [];
    const walk = (node, path) => {
        if (node === null || typeof node !== 'object') {
            out.push({ path, value: node });
            return;
        }
        if (Array.isArray(node)) {
            node.forEach((item, index) => walk(item, `${path}[${index}]`));
            return;
        }
        for (const [key, value] of Object.entries(node)) walk(value, path ? `${path}.${key}` : key);
    };
    walk(statData ?? {}, prefix);
    return out;
}

/** 从变量结构里挑出数值型路径，供"让好感涨快点"这类指令参考。 */
export function numericPaths(statData) {
    return flattenStatData(statData)
        .filter(item => typeof item.value === 'number')
        .map(item => item.path);
}

/** 一次读改写的便捷封装。 */
export async function patchStatData(patch, options = {}) {
    const stat = readStatData(options);
    if (!stat) throw new Error('当前聊天没有 MVU 变量（stat_data 不存在）：这张卡可能没启用 MVU');
    const next = applyStatPatch(stat, patch);
    await writeStatData(next, options);
    return next;
}
