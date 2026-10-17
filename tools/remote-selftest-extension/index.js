/**
 * 临时自检扩展（第六轮）：验证「演绎剧情 / 更改配置」分离与元回复拦截。
 *
 * 结果写入 extension_settings.tt_if_enhancer.selfTest6，用 adb 拉 settings.json 读取。
 */
const report = { round: 6, at: new Date().toISOString(), steps: [] };

const persist = () => {
    try {
        const ctx = globalThis.SillyTavern?.getContext?.();
        if (!ctx) return;
        ctx.extensionSettings ??= {};
        ctx.extensionSettings.tt_if_enhancer ??= {};
        ctx.extensionSettings.tt_if_enhancer.selfTest6 = report;
        ctx.saveSettingsDebounced?.();
    } catch (error) {
        console.error('[IF SelfTest6] 写入失败：', error);
    }
};

const step = (name, value) => {
    report.steps.push({ name, value });
    persist();
};

const messageCount = () => {
    try {
        const th = globalThis.TavernHelper;
        if (typeof th?.getChatMessages === 'function') return th.getChatMessages('all').length;
    } catch {
        /* 忽略 */
    }
    return -1;
};

const waitFor = async (predicate, timeoutMs) => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        try {
            if (predicate()) return true;
        } catch {
            /* 忽略 */
        }
        await new Promise(resolve => setTimeout(resolve, 300));
    }
    return false;
};

(async () => {
    try {
        const ready = await waitFor(() => globalThis.ttIfEnhancer, 90000);
        const api = globalThis.ttIfEnhancer;
        if (!ready || !api) {
            step('error', '等待 ttIfEnhancer 超时');
            return;
        }
        const before = api.settings();
        const originalBook = before.worldbook?.primaryName ?? '';
        api.updateSettings({ worldbook: { primaryName: 'IF-Enhancer-自检' }, authorPreferences: [] });
        step('start', { book: 'IF-Enhancer-自检', prefs: 0, messages: messageCount() });

        const cases = [
            ['a-forced-config', '推进速度设为快', 'config.adjust'],
            ['b-forced-prose-on-config-text', '把世界卡进度推进设为快', 'prose.generate'],
            ['c-auto-config', '每次回复短一点', 'auto'],
        ];
        for (const [key, text, taskType] of cases) {
            const messagesBefore = messageCount();
            const started = Date.now();
            const result = await api.runEditInstruction(text, { taskType });
            step(key, {
                taskType,
                route: result.route?.task,
                method: result.route?.method,
                ok: result.ok,
                title: result.title,
                lines: result.lines,
                warnings: result.warnings,
                messagesBefore,
                messagesAfter: messageCount(),
                prefs: (api.settings().authorPreferences ?? []).length,
                detail: String(result.detail ?? '').slice(0, 300),
                ms: Date.now() - started,
            });
        }

        step('final-prefs', (api.settings().authorPreferences ?? []).map(item => item.text));
        api.updateSettings({ worldbook: { primaryName: originalBook } });
        step('done', 'ok');
    } catch (error) {
        step('error', String(error?.message ?? error));
    }
})();
