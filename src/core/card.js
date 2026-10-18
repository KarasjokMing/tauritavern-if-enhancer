/**
 * 当前角色卡读写层。
 *
 * 用户决策（2026-10-18）：设定、人物与记忆都写进**角色卡本体**，
 * 不再另建「聊天·互动小说」世界书。因此这里提供：
 *   - 读整张卡（含卡内嵌世界书 character_book）
 *   - 写卡前用酒馆自带 duplicate 做整卡备份
 *   - 用 merge-attributes 精确合并单个字段（不会动其它字段）
 *   - 卡内嵌世界书条目的 upsert（保持 SillyTavern 扁平条目字段）
 */
import { ctx, getRequestHeaders } from '../env.js';
import { toFlatEntry } from '../worldbook/spec.js';

async function post(route, body) {
    const response = await fetch(`/api/${route}`, {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify(body ?? {}),
    });
    if (!response.ok) {
        let detail = '';
        try {
            detail = (await response.text()).slice(0, 200);
        } catch {
            /* 忽略 */
        }
        throw new Error(`API ${route} 失败：HTTP ${response.status}${detail ? ` — ${detail}` : ''}`);
    }
    const text = await response.text();
    if (!text) return {};
    try {
        return JSON.parse(text);
    } catch {
        return { status: text };
    }
}

export function activeAvatar() {
    const c = ctx();
    return c?.characters?.[c.characterId]?.avatar ?? null;
}

export function activeCardName() {
    const c = ctx();
    return c?.name2 || c?.characters?.[c.characterId]?.name || '';
}

/** 读整张卡（含 data.character_book / data.extensions）。 */
export async function readCard(avatar = activeAvatar()) {
    if (!avatar) throw new Error('当前没有选中角色卡');
    const raw = await post('characters/get', { avatar_url: avatar });
    const data = raw?.data ?? raw;
    const book = data?.character_book ?? data?.data?.character_book ?? null;
    return {
        avatar,
        name: data?.name ?? avatar.replace(/\.png$/i, ''),
        data,
        book,
        entries: book?.entries ?? [],
        extensions: data?.extensions ?? data?.data?.extensions ?? {},
    };
}

/**
 * 整卡备份：调用酒馆自带的 duplicate，生成 `<名字>_N.png` 副本。
 * 失败不算致命（调用方决定是否继续），但会记录警告。
 */
export async function backupCard(avatar = activeAvatar()) {
    if (!avatar) throw new Error('当前没有选中角色卡');
    await post('characters/duplicate', { avatar_url: avatar });
    return { ok: true, avatar };
}

/** 精确合并单个字段到卡里（不覆盖其它字段）。 */
export async function mergeCard(patch, { avatar = activeAvatar(), backup = true } = {}) {
    if (!avatar) throw new Error('当前没有选中角色卡');
    if (backup) {
        try {
            await backupCard(avatar);
        } catch (error) {
            console.warn('[IF Enhancer] 角色卡备份失败，继续写入：', error?.message ?? error);
        }
    }
    await post('characters/merge-attributes', { avatar, data: patch });
    return { avatar, patch };
}

/**
 * 卡内嵌世界书条目 upsert。
 * @param {object} entry 内部条目（name/type/part/content/keys/constant…），字段映射见 worldbook/spec.js
 */
export async function upsertCardEntry(entry, options = {}) {
    const card = await readCard(options.avatar);
    if (!card.book) throw new Error('当前角色卡没有内嵌世界书（character_book），请改用卡绑定的世界书');
    const entries = [...card.entries];
    const index = entries.findIndex(item => (item.comment ?? '') === entry.name);
    const flat = toFlatEntry(entry, index >= 0 ? index : entries.length);
    if (index >= 0) {
        // 保留原有 uid 与显示序号，只覆盖内容相关字段
        entries[index] = { ...entries[index], ...flat, uid: entries[index].uid ?? flat.uid };
    } else {
        entries.push(flat);
    }
    await mergeCard({ character_book: { ...card.book, entries } }, options);
    return { created: index < 0, total: entries.length, name: entry.name };
}

/**
 * 批量 upsert 卡内嵌世界书条目（只重写一次 PNG，避免每条都整卡落盘）。
 * @param {object[]} list 内部条目数组
 * @returns {{created:number, updated:number, total:number}}
 */
export async function upsertCardEntries(list, options = {}) {
    const card = await readCard(options.avatar);
    if (!card.book) throw new Error('当前角色卡没有内嵌世界书（character_book）');
    const entries = [...card.entries];
    let created = 0;
    let updated = 0;
    for (const entry of list ?? []) {
        if (!entry?.name) continue;
        const index = entries.findIndex(item => (item.comment ?? '') === entry.name);
        const flat = toFlatEntry(entry, index >= 0 ? index : entries.length);
        if (index >= 0) {
            entries[index] = { ...entries[index], ...flat, uid: entries[index].uid ?? flat.uid };
            updated += 1;
        } else {
            entries.push(flat);
            created += 1;
        }
    }
    if (!created && !updated) return { created: 0, updated: 0, total: entries.length };
    await mergeCard({ character_book: { ...card.book, entries } }, options);
    return { created, updated, total: entries.length };
}

/** 删除卡内嵌世界书里的条目。 */
export async function deleteCardEntry(name, options = {}) {
    const card = await readCard(options.avatar);
    if (!card.book) return { deleted: 0 };
    const entries = card.entries.filter(item => (item.comment ?? '') !== name);
    const deleted = card.entries.length - entries.length;
    if (!deleted) return { deleted: 0 };
    await mergeCard({ character_book: { ...card.book, entries } }, options);
    return { deleted };
}

/** 按名字读卡内嵌世界书条目。 */
export async function findCardEntry(name, options = {}) {
    const card = await readCard(options.avatar);
    return card.entries.find(item => (item.comment ?? '') === name) ?? null;
}

/** 列出卡内嵌世界书里名字包含关键字的条目（用于找 [mvu_update] 规则、人物条目等）。 */
export async function findCardEntries(keyword, options = {}) {
    const card = await readCard(options.avatar);
    const needle = String(keyword ?? '');
    return card.entries.filter(item => (item.comment ?? '').includes(needle));
}

/** 合并写卡扩展字段（例如 data.extensions 下的自定义配置）。 */
export async function patchExtensions(partial, options = {}) {
    return mergeCard({ extensions: partial }, options);
}
