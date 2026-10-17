/**
 * 临时自检扩展（第二轮）：验证资料类任务 —— 世界书写入与人物创建。
 *
 * 这一轮刻意在「没有打开聊天」的状态下运行，用来确认：
 *   1. 资料类任务不依赖聊天历史，能独立完成 LLM 生成与世界书落盘；
 *   2. 正文类任务在无聊天时被明确拦截，而不是静默丢失。
 *
 * 结果写入 extension_settings.tt_if_enhancer.selfTest5，用 adb 拉 settings.json 读取。
 */
const WAIT_MS = 300;

const waitFor = async (predicate, timeoutMs) => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        try {
            if (predicate()) return true;
        } catch {
            /* 忽略 */
        }
        await new Promise(resolve => setTimeout(resolve, WAIT_MS));
    }
    return false;
};

const report = { round: 2, at: new Date().toISOString(), steps: [] };

const persist = () => {
    try {
        const ctx = globalThis.SillyTavern?.getContext?.();
        if (!ctx) return;
        ctx.extensionSettings ??= {};
        ctx.extensionSettings.tt_if_enhancer ??= {};
        ctx.extensionSettings.tt_if_enhancer.selfTest5 = report;
        ctx.saveSettingsDebounced?.();
    } catch (error) {
        console.error('[IF SelfTest2] 写入结果失败：', error);
    }
};

const step = (name, value) => {
    report.steps.push({ name, value });
    persist();
};

const brief = result => ({
    ok: result.ok,
    title: result.title,
    lines: result.lines,
    warnings: (result.warnings ?? []).slice(0, 4),
    route: result.route?.task,
    detail: String(result.detail ?? '').slice(0, 300),
});

(async () => {
    try {
        const ready = await waitFor(() => globalThis.ttIfEnhancer, 90000);
        const api = globalThis.ttIfEnhancer;
        if (!ready || !api) {
            step('error', '等待 ttIfEnhancer 超时');
            return;
        }
        step('diagnostics-before', (await api.diagnostics()).text);

        const before = api.settings();
        const originalBook = before.worldbook?.primaryName ?? '';
        api.updateSettings({ worldbook: { primaryName: 'IF-Enhancer-自检' } });
        step('target', 'IF-Enhancer-自检');

        const tasks = [
            ['worldbook-write', '根据目前剧情整理坡子口和张婆的设定，写入世界书。'],
            ['character-create', '创建一个合欢宗长老，女性，年约四十，修为金丹后期，性格比较严肃，其余自行发挥。'],
            ['prose-without-chat', '继续演绎接下来的剧情。'],
        ];
        for (const [key, text] of tasks) {
            const started = Date.now();
            const result = await api.runEditInstruction(text);
            step(key, { ...brief(result), ms: Date.now() - started });
        }

        step('diagnostics-after', (await api.diagnostics()).text);
        api.updateSettings({ worldbook: { primaryName: originalBook } });
        step('done', 'ok');
    } catch (error) {
        step('error', String(error?.message ?? error));
    }
})();
