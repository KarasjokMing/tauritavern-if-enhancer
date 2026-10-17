/**
 * 条目策略 / 位置 / 顺序推导（纯函数，无副作用，可单测）。
 *
 * 规则依据公开的条目配置规范独立实现：
 *   - 蓝灯 constant：恒触发；绿灯 selective：按关键词触发。
 *   - 同一 part 的条目数达到阈值时才改用绿灯。
 *   - 位置由条目类型决定；重述类条目强制进入 at_depth。
 *   - order 用十位分组：组内递增，跨类型跳整十，重述类逆序追加。
 */
import { STRATEGY_THRESHOLDS, TYPE_LISTS, DEPTH_DEFAULTS, PART_ORDER } from './spec.js';

/** 取该条目在阈值表中的配置。 */
export function thresholdOf(type, part) {
    const table = STRATEGY_THRESHOLDS[type];
    if (table === undefined) return 0;
    if (typeof table === 'number') return table;
    if (!part) return 0;
    return table[part]?.threshold ?? 0;
}

/** 条目是否参与"同类计数"（速览级与重述级不参与）。 */
export function countsForStrategy(entry) {
    if (entry.rephrase) return false;
    if (entry.scope === 'catalog') return false;
    return true;
}

/**
 * 推导策略：返回 'constant'（蓝灯）或 'selective'（绿灯）。
 * @param {object} entry 内部条目
 * @param {object[]} siblings 全部条目（含自身）
 */
export function deriveStrategy(entry, siblings = []) {
    if (entry.enabled === false) return 'selective';
    if (entry.constant === true) return 'constant';
    if (entry.scope === 'catalog') return 'constant';
    const threshold = thresholdOf(entry.type, entry.part);
    if (threshold === Infinity) return 'constant';
    if (threshold === null) return 'selective';
    if (threshold === 0) return 'selective';
    const samePart = siblings.filter(
        item => item.type === entry.type && (item.part ?? '') === (entry.part ?? '') && countsForStrategy(item),
    ).length;
    return samePart >= threshold ? 'selective' : 'constant';
}

/** 推导注入位置。 */
export function derivePosition(entry) {
    if (entry.rephrase) return 'at_depth';
    for (const [position, types] of Object.entries(TYPE_LISTS)) {
        if (types.includes(entry.type)) {
            if (position === 'before_char') return 'before_character_definition';
            if (position === 'after_char') return 'after_character_definition';
            if (position === 'depth') return 'at_depth';
        }
    }
    return 'before_character_definition';
}

/** 类型分组的排序权（before_char < after_char < depth）。 */
export function groupRank(entry) {
    const order = Object.keys(TYPE_LISTS);
    for (let i = 0; i < order.length; i += 1) {
        if (TYPE_LISTS[order[i]].includes(entry.type)) return i;
    }
    return order.length;
}

/**
 * 为整批条目推导 order：
 * 十位分组（每组起始 10，组内 +1），跨类型跳到下一个整十；
 * 重述类条目单独收集、逆序后追加到末尾。
 */
export function deriveOrder(entries) {
    const sorted = [...entries].sort((a, b) => {
        const rank = groupRank(a) - groupRank(b);
        if (rank !== 0) return rank;
        const partOrder = PART_ORDER[a.type] ?? [];
        const ai = partOrder.indexOf(a.part ?? '');
        const bi = partOrder.indexOf(b.part ?? '');
        return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
    });
    const rephrase = sorted.filter(entry => entry.rephrase);
    const normal = sorted.filter(entry => !entry.rephrase);

    let cursor = 10;
    let lastGroup = null;
    for (const entry of normal) {
        const group = `${entry.type}/${entry.part ?? ''}`;
        if (lastGroup !== null && group !== lastGroup) cursor = Math.ceil((cursor + 1) / 10) * 10;
        entry.order = cursor;
        cursor += 1;
        lastGroup = group;
    }
    let tail = cursor + 10;
    for (let i = rephrase.length - 1; i >= 0; i -= 1) {
        rephrase[i].order = tail;
        tail += 1;
    }
    return entries;
}

/** 一次性补齐策略、位置、深度与顺序。 */
export function deriveAll(entries) {
    for (const entry of entries) {
        const strategy = deriveStrategy(entry, entries);
        entry.constant = strategy === 'constant';
        entry.position = entry.position || derivePosition(entry);
        if (entry.position === 'at_depth') {
            entry.depth ??= DEPTH_DEFAULTS.depth;
            entry.role ??= DEPTH_DEFAULTS.role;
        }
        entry.enabled ??= true;
    }
    deriveOrder(entries);
    return entries;
}
