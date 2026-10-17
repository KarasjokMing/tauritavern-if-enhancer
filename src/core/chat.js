/**
 * 聊天消息读写适配。
 * 优先使用酒馆助手 API（结构统一、能拿到 message_id），否则退回 ST 上下文里的 chat 数组。
 */
import { ctx, TH, evt, onEvent } from '../env.js';

const ROLE_OF = message => {
    if (message?.is_system) return 'system';
    if (message?.is_user) return 'user';
    return 'assistant';
};

function fromStMessage(message, id) {
    return {
        message_id: id,
        name: message?.name ?? '',
        role: ROLE_OF(message),
        is_hidden: Boolean(message?.is_hidden),
        message: String(message?.mes ?? ''),
        data: message?.extra ?? {},
    };
}

/** 读取消息。range 语义与酒馆助手一致（数字为深度索引，负数从末尾数）。 */
export function getMessages(range = 'all', { includeHidden = true } = {}) {
    const th = TH();
    if (th?.getChatMessages) {
        try {
            const raw = th.getChatMessages(range, includeHidden ? undefined : { hide_state: 'unhidden' });
            return Array.isArray(raw) ? raw : [];
        } catch {
            /* 落到 ST 路径 */
        }
    }
    const chat = ctx()?.chat ?? [];
    const list = chat.map((message, index) => fromStMessage(message, index));
    if (range === 'all' || range === undefined) return list;
    const depth = Number(range);
    if (Number.isFinite(depth)) {
        return depth >= 0 ? list.slice(depth, depth + 1) : list.slice(depth);
    }
    return list;
}

export function lastMessageId() {
    const th = TH();
    if (typeof th?.getLastMessageId === 'function') {
        try {
            return th.getLastMessageId();
        } catch {
            /* 忽略 */
        }
    }
    return (ctx()?.chat?.length ?? 1) - 1;
}

/** 找出最后一条指定角色的消息。 */
export function findLastMessage(role = 'assistant', { skipHidden = true } = {}) {
    const list = getMessages('all');
    for (let i = list.length - 1; i >= 0; i -= 1) {
        const item = list[i];
        if (role !== 'any' && item.role !== role) continue;
        if (skipHidden && item.is_hidden) continue;
        return item;
    }
    return null;
}

/** 当前聊天的消息条数（用于写入后回读校验）。 */
export function messageCount() {
    const th = TH();
    if (typeof th?.getLastMessageId === 'function') {
        try {
            return Number(th.getLastMessageId()) + 1;
        } catch {
            /* 落到下面的数组长度 */
        }
    }
    return Array.isArray(ctx()?.chat) ? ctx().chat.length : 0;
}

/**
 * 是否已经打开了一个聊天。
 * 注意：SillyTavern 的 ctx().chatId 在"重启后未打开聊天"时可能仍是旧值，
 * 因此这里只做宽松判断，真正的保证是写入后的回读校验（见 appendMessages）。
 */
export function hasOpenChat() {
    const c = ctx();
    if (!c) return false;
    if (messageCount() > 0) return true;
    return Boolean(c.chatId) && Array.isArray(c.chat);
}

function assertChatOpen() {
    if (hasOpenChat()) return;
    throw new Error('当前没有打开任何聊天：请先在酒馆里打开一个角色聊天，再使用编辑模式。');
}

/** 追加消息。写入后回读校验，避免"看起来成功但消息没进聊天"的静默丢失。 */
export async function appendMessages(messages) {
    assertChatOpen();
    const payload = Array.isArray(messages) ? messages : [messages];
    const before = messageCount();
    const th = TH();
    if (th?.createChatMessages) {
        await th.createChatMessages(payload, { insert_before: 'end', refresh: 'all' });
    } else {
        const c = ctx();
        for (const item of payload) {
            c.chat.push({
                name: item.name ?? (item.role === 'user' ? c.name1 : c.name2),
                is_user: item.role === 'user',
                is_system: item.role === 'system',
                is_hidden: Boolean(item.is_hidden),
                mes: item.message,
                extra: item.data ?? {},
            });
        }
        await c.saveChat?.();
        await c.reloadCurrentChat?.();
    }
    if (messageCount() <= before) {
        throw new Error('消息没有写入当前聊天：请先在酒馆里打开一个聊天，再使用编辑模式。');
    }
}

/** 覆盖已有消息。 */
export async function replaceMessage(messageId, text, { refresh = 'all' } = {}) {
    assertChatOpen();
    const th = TH();
    if (th?.setChatMessages) {
        await th.setChatMessages([{ message_id: messageId, message: text }], { refresh });
    } else {
        const c = ctx();
        const target = c.chat?.[messageId];
        if (!target) return false;
        target.mes = text;
        await c.saveChat?.();
        await c.reloadCurrentChat?.();
    }
    // 软校验：酒馆的正则替换可能改写显示文本，因此只告警不失败。
    const stored = ctx()?.chat?.[messageId]?.mes;
    if (typeof stored === 'string' && stored !== String(text)) {
        console.warn('[IF Enhancer] 覆盖后回读内容不一致，可能被酒馆正则或显示层改写。');
    }
    return true;
}

export async function deleteMessages(ids) {
    const th = TH();
    if (th?.deleteChatMessages) {
        await th.deleteChatMessages(ids, { refresh: 'all' });
        return true;
    }
    const c = ctx();
    c.chat = c.chat.filter((_, index) => !ids.includes(index));
    await c.saveChat?.();
    await c.reloadCurrentChat?.();
    return true;
}

/** 把消息列表渲染成给模型的纯文本。 */
export function renderHistory(messages, { withNames = true, limitChars = 6000 } = {}) {
    const lines = [];
    for (const item of messages) {
        if (item.is_hidden) continue;
        const who = item.role === 'user' ? `【主角·${item.name || '我'}】` : item.role === 'system' ? '【系统】' : `【${item.name || '旁白'}】`;
        lines.push(`${withNames ? who : ''}${item.message}`);
    }
    let text = lines.join('\n\n');
    if (text.length > limitChars) text = `……（前文略）\n${text.slice(-limitChars)}`;
    return text;
}

export function currentCharName() {
    const c = ctx();
    return c?.name2 ?? c?.characters?.[c.characterId]?.name ?? '';
}

export function onChatChanged(handler) {
    return onEvent(evt('CHAT_CHANGED'), handler);
}

export function onMessageEvent(handler) {
    const offs = ['MESSAGE_RECEIVED', 'MESSAGE_EDITED', 'MESSAGE_DELETED', 'MESSAGE_SWIPED', 'USER_MESSAGE_RENDERED']
        .map(name => onEvent(evt(name), handler))
        .filter(Boolean);
    return () => offs.forEach(off => off());
}
