/**
 * 宿主环境探测与通用适配。
 *
 * 本扩展同时面向三种运行环境，按能力降级：
 *   1. TauriTavern（安卓/桌面原生酒馆，含 Agent API）
 *   2. SillyTavern + 酒馆助手（Tavern Helper / JS-Slash-Runner）
 *   3. 纯 SillyTavern（仅用 ST 自身能力 + 服务端端点）
 *
 * 约定：所有外部能力都必须经过本模块，业务代码不做裸全局访问。
 */

/** SillyTavern 上下文（ctx()），未就绪时返回 null。 */
export function ctx() {
    try {
        return globalThis.SillyTavern?.getContext?.() ?? null;
    } catch {
        return null;
    }
}

/** 酒馆助手全局对象。 */
export function TH() {
    return globalThis.TavernHelper ?? null;
}

/** TauriTavern 宿主对象（未就绪前也存在，但 api 可能为空）。 */
export function TT() {
    return globalThis.__TAURITAVERN__ ?? null;
}

/** 是否运行在 TauriTavern 上。 */
export function isTT() {
    return Boolean(TT());
}

/** 是否安装了酒馆助手。 */
export function hasTH() {
    return Boolean(TH());
}

export function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/** 轮询等待条件成立；超时返回 false。 */
export async function waitFor(predicate, { timeout = 10000, interval = 100 } = {}) {
    const deadline = Date.now() + timeout;
    for (;;) {
        try {
            if (predicate()) return true;
        } catch {
            /* 探测期间忽略异常 */
        }
        if (Date.now() >= deadline) return false;
        await sleep(interval);
    }
}

/** 等待宿主与酒馆助手就绪（不阻塞启动流程，超时后按现有能力运行）。 */
export async function waitForHost() {
    await waitFor(() => document.querySelector('#send_form'), { timeout: 30000, interval: 150 });
    // TauriTavern：等宿主 ABI 就绪，失败不致命。
    try {
        const tt = TT();
        const ready = tt?.ready ?? globalThis.__TAURITAVERN_MAIN_READY__;
        if (ready && typeof ready.then === 'function') {
            await Promise.race([ready, sleep(5000)]);
        }
    } catch {
        /* 忽略 */
    }
    await waitFor(() => hasTH(), { timeout: 8000, interval: 200 });
    return { st: Boolean(ctx()), th: hasTH(), tt: isTT() };
}

/** ST 事件类型常量表；缺失时给出安全回退。 */
export function eventTypes() {
    return ctx()?.eventTypes ?? {};
}

/**
 * 订阅 ST 事件。
 * 插件（非 iframe）拿不到酒馆助手的 eventOn，只能用 ST 原生 eventSource。
 * @returns {() => void} 取消订阅
 */
export function onEvent(type, handler) {
    const source = ctx()?.eventSource;
    if (!source || !type) return () => {};
    source.on(type, handler);
    return () => {
        try {
            source.off?.(type, handler);
            source.removeListener?.(type, handler);
        } catch {
            /* 忽略 */
        }
    };
}

/** 事件名解析：优先取 eventTypes 常量，未定义时原样使用。 */
export function evt(name) {
    return eventTypes()[name] ?? name;
}

/** 气泡提示。优先 toastr，其次内置浮层。 */
export function toast(message, type = 'info', title = '') {
    const t = globalThis.toastr;
    if (t && typeof t[type] === 'function') {
        t[type](message, title || '互动小说增强', { timeOut: type === 'error' ? 8000 : 4000 });
        return;
    }
    console.log(`[IF Enhancer][${type}] ${title} ${message}`);
}

/** 扩展设置容器（写入 extension_settings，随 ST 设置一起持久化）。 */
export const SETTINGS_KEY = 'tt_if_enhancer';

export function rawSettings() {
    const c = ctx();
    if (!c) return null;
    c.extensionSettings ??= {};
    c.extensionSettings[SETTINGS_KEY] ??= {};
    return c.extensionSettings[SETTINGS_KEY];
}

export function saveSettings() {
    try {
        ctx()?.saveSettingsDebounced?.();
    } catch {
        /* 忽略 */
    }
}

/** 当前已绑定的世界书名称（聊天级 → 角色卡主书）。 */
export function activeWorldbookNames() {
    const c = ctx();
    const names = [];
    try {
        const chatBook = globalThis.TavernHelper?.getChatWorldbookName?.('current');
        if (chatBook) names.push(chatBook);
    } catch {
        /* 忽略 */
    }
    try {
        const book = c?.characters?.[c.characterId]?.data?.extensions?.world;
        if (book) names.push(book);
    } catch {
        /* 忽略 */
    }
    return names;
}

export function getRequestHeaders() {
    try {
        return ctx()?.getRequestHeaders?.() ?? { 'Content-Type': 'application/json' };
    } catch {
        return { 'Content-Type': 'application/json' };
    }
}
