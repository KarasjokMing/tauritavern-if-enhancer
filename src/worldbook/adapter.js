/**
 * 世界书读写适配层。
 *
 * 三条后端按优先级降级：
 *   1. 酒馆助手新世界书 API（WorldbookEntry 结构，能力最全）
 *   2. SillyTavern 服务端端点 /api/worldinfo/*（扁平结构，TauriTavern 的 Rust 后端同样实现）
 *   3. 无可用后端 → 明确报错，不静默失败
 */
import { ctx, TH, getRequestHeaders } from '../env.js';
import { fromFlatEntry, toFlatEntry, SELECTIVE_LOGIC_NUM, POSITION_NUM, ROLE_NUM } from './spec.js';

export function detectBackend() {
    const th = TH();
    if (th?.getWorldbook && th?.createWorldbookEntries) return 'tavern-helper';
    if (ctx()?.getRequestHeaders) return 'st-endpoint';
    return 'none';
}

export function backendLabel(backend = detectBackend()) {
    return { 'tavern-helper': '酒馆助手 API', 'st-endpoint': '酒馆服务端端点', none: '无（不可写入）' }[backend];
}

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
    try {
        return JSON.parse(text);
    } catch {
        return { status: text };
    }
}

/* ------------------------------------------------------------------ 结构转换 */

export function fromTavernHelper(entry, index = 0) {
    const strategy = entry?.strategy ?? {};
    const position = entry?.position ?? {};
    const logic = strategy.keys_secondary?.logic ?? 'and_any';
    return {
        uid: entry?.uid ?? index,
        name: entry?.name ?? '',
        enabled: entry?.enabled !== false,
        content: entry?.content ?? '',
        keys: (strategy.keys ?? []).filter(key => typeof key === 'string'),
        secondaryKeys: (strategy.keys_secondary?.keys ?? []).filter(key => typeof key === 'string'),
        selectiveLogic: logic,
        constant: strategy.type === 'constant',
        position: position.type ?? 'before_character_definition',
        depth: position.depth ?? 0,
        role: position.role ?? 'system',
        order: position.order ?? 100,
        probability: entry?.probability ?? 100,
        scanDepth: strategy.scan_depth ?? 'same_as_global',
        recursion: entry?.recursion ?? {},
        effect: entry?.effect ?? {},
        meta: entry?.extra?.if ?? undefined,
        _source: entry,
    };
}

export function toTavernHelper(entry) {
    return {
        name: entry.name,
        enabled: entry.enabled !== false,
        content: entry.content ?? '',
        strategy: {
            type: entry.constant ? 'constant' : 'selective',
            keys: entry.keys ?? [],
            keys_secondary: {
                logic: entry.selectiveLogic ?? 'and_any',
                keys: entry.secondaryKeys ?? [],
            },
            scan_depth: entry.scanDepth ?? 'same_as_global',
        },
        position: {
            type: entry.position ?? 'before_character_definition',
            role: entry.role ?? 'system',
            depth: Number(entry.depth ?? 0),
            order: Number(entry.order ?? 100),
        },
        probability: Number(entry.probability ?? 100),
        recursion: {
            prevent_incoming: entry.recursion?.prevent_incoming ?? true,
            prevent_outgoing: entry.recursion?.prevent_outgoing ?? true,
            delay_until: entry.recursion?.delay_until ?? null,
        },
        effect: {
            sticky: entry.effect?.sticky ?? null,
            cooldown: entry.effect?.cooldown ?? null,
            delay: entry.effect?.delay ?? null,
        },
        extra: entry.meta ? { if: entry.meta } : undefined,
    };
}

/* ------------------------------------------------------------------ 名称与目标 */

export function renderBookName(template, extra = {}) {
    const c = ctx();
    const chatId = String(c?.chatId ?? '');
    const chatName = chatId.replace(/\.jsonl$/i, '').split(/[\\/]/).pop() || '';
    return String(template ?? '')
        .replaceAll('{{char}}', c?.name2 ?? extra.charName ?? '')
        .replaceAll('{{chat}}', chatName || extra.chatName || '未命名聊天')
        .replaceAll('{{user}}', c?.name1 ?? '')
        .trim();
}

/**
 * 解析应当写入的世界书名称。
 *
 * 只解析、**不创建**：读记忆这类只读操作不应产生副作用。
 *
 * 优先级（真机反馈后调整）：
 *   1. 手动指定
 *   2. target=char / 默认情况：**角色卡绑定的世界书**（`extensions.world`）
 *      —— 卡里的世界观、人物、规则本来就该写这里，而不是另建一本「聊天·互动小说」
 *   3. target=global：全局世界书第一本
 *   4. 已绑定聊天级世界书时用它
 *   5. 兜底：按模板生成候选名（写入时才由 ensureWorldbook 创建）
 */
export async function resolveTargetBook({ target, nameTemplate, autoCreate, primaryName } = {}) {
    const th = TH();
    const c = ctx();
    if (primaryName) return primaryName;

    const boundBook = c?.characters?.[c.characterId]?.data?.extensions?.world;
    if (target !== 'global' && boundBook) return boundBook;

    if (target === 'global') {
        const names = th?.getGlobalWorldbookNames?.() ?? [];
        if (names.length) return names[0];
    }
    if (th?.getChatWorldbookName) {
        const current = th.getChatWorldbookName('current');
        if (current) return current;
    }
    const wanted = renderBookName(nameTemplate);
    if (wanted && autoCreate !== false) return wanted;
    if (boundBook) return boundBook;
    if (wanted) return wanted;
    throw new Error('无法确定目标世界书：请在设置中指定，或给当前角色卡绑定一本世界书');
}

/* ------------------------------------------------------------------ 读 */

export async function listWorldbooks() {
    const backend = detectBackend();
    if (backend === 'tavern-helper') {
        const names = TH().getWorldbookNames?.() ?? [];
        return names.map(name => ({ id: name, name }));
    }
    if (backend === 'st-endpoint') {
        const data = await post('worldinfo/list', {});
        const list = Array.isArray(data) ? data : [];
        return list.map(item => ({ id: item.file_id, name: item.name || item.file_id, extensions: item.extensions }));
    }
    return [];
}

export async function readWorldbook(name) {
    if (!name) throw new Error('未指定世界书名称');
    const backend = detectBackend();
    if (backend === 'tavern-helper') {
        const raw = await TH().getWorldbook(name);
        const entries = (raw ?? []).map((entry, index) => fromTavernHelper(entry, index));
        return { name, entries, backend };
    }
    if (backend === 'st-endpoint') {
        const file = await post('worldinfo/get', { name });
        const box = file?.entries ?? {};
        const entries = Object.entries(box)
            .sort((a, b) => Number(a[0]) - Number(b[0]))
            .map(([uid, flat], index) => fromFlatEntry({ ...flat, uid: Number(uid) }, index));
        return { name, entries, backend, raw: file };
    }
    throw new Error('当前环境没有可用的世界书读取后端');
}

export async function worldbookExists(name) {
    const books = await listWorldbooks();
    return books.some(book => book.id === name || book.name === name);
}

export async function ensureWorldbook(name) {
    if (!name) throw new Error('未指定世界书名称');
    if (await worldbookExists(name)) return false;
    const backend = detectBackend();
    if (backend === 'tavern-helper') {
        // 注意：createWorldbook 对已存在的书是覆盖语义，必须先确认不存在。
        await TH().createWorldbook(name, []);
        return true;
    }
    if (backend === 'st-endpoint') {
        await post('worldinfo/edit', { name, data: { entries: {} } });
        return true;
    }
    throw new Error('当前环境没有可用的世界书创建后端');
}

/* ------------------------------------------------------------------ 写 */

/**
 * 按条目名合并写入。
 * @param {string} name 世界书名称
 * @param {object[]} entries 内部条目
 * @param {{mode?: 'upsert'|'replace', ensure?: boolean}} options
 */
export async function writeEntries(name, entries, { mode = 'upsert', ensure = true } = {}) {
    if (!name) throw new Error('未指定世界书名称');
    if (ensure) await ensureWorldbook(name);
    const backend = detectBackend();

    if (backend === 'tavern-helper') {
        const th = TH();
        let created = 0;
        let updated = 0;
        if (mode === 'replace') {
            await th.createOrReplaceWorldbook(name, entries.map(toTavernHelper));
            return { created: entries.length, updated: 0, backend, mode };
        }
        await th.updateWorldbookWith(name, worldbook => {
            const list = [...(worldbook ?? [])];
            for (const entry of entries) {
                const index = list.findIndex(item => item.name === entry.name);
                if (index >= 0) {
                    list[index] = { ...list[index], ...toTavernHelper(entry) };
                    updated += 1;
                } else {
                    list.push(toTavernHelper(entry));
                    created += 1;
                }
            }
            return list;
        }, { render: 'immediate' });
        return { created, updated, backend, mode, total: entries.length };
    }

    if (backend === 'st-endpoint') {
        const current = await readWorldbook(name);
        const flat = {};
        let nextUid = 0;
        for (const entry of current.entries) {
            flat[entry.uid] = toFlatEntry(entry, entry.uid);
            nextUid = Math.max(nextUid, Number(entry.uid) + 1 || 0);
        }
        let created = 0;
        let updated = 0;
        for (const entry of entries) {
            const existing = current.entries.find(item => item.name === entry.name);
            const uid = existing ? Number(existing.uid) : nextUid;
            if (!existing) nextUid += 1;
            flat[uid] = toFlatEntry({ ...entry, uid }, uid);
            if (existing) updated += 1;
            else created += 1;
        }
        await post('worldinfo/edit', { name, data: { entries: flat } });
        return { created, updated, backend, mode, total: entries.length };
    }

    throw new Error('当前环境没有可用的世界书写入后端');
}

export async function deleteEntries(name, predicate) {
    const backend = detectBackend();
    if (backend === 'tavern-helper') {
        const result = await TH().deleteWorldbookEntries(name, predicate);
        return { deleted: result?.deleted_entries?.length ?? 0 };
    }
    if (backend === 'st-endpoint') {
        const current = await readWorldbook(name);
        const flat = {};
        let deleted = 0;
        for (const entry of current.entries) {
            if (predicate(entry)) {
                deleted += 1;
                continue;
            }
            flat[entry.uid] = toFlatEntry(entry, entry.uid);
        }
        await post('worldinfo/edit', { name, data: { entries: flat } });
        return { deleted };
    }
    throw new Error('当前环境没有可用的世界书删除后端');
}

/** 便捷：按条目名精确读取。 */
export async function findEntry(name, entryName) {
    const book = await readWorldbook(name);
    return book.entries.find(entry => entry.name === entryName) ?? null;
}

export { SELECTIVE_LOGIC_NUM, POSITION_NUM, ROLE_NUM };
