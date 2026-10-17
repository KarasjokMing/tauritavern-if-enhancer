/**
 * 临时自检扩展（第八轮）：验证反重力「经酒馆后端」写配图提示词。
 *
 * 第七轮已证明：页面直连中继被 CORS 拦（Failed to fetch），出图链路本身正常。
 * 这一轮验证后端通路，并对比两个通道的耗时与产出。
 *
 * 结果写入 extension_settings.tt_if_enhancer.selfTest9。
 */
const report = { round: 8, at: new Date().toISOString(), steps: [] };

const persist = () => {
    try {
        const ctx = globalThis.SillyTavern?.getContext?.();
        if (!ctx) return;
        ctx.extensionSettings ??= {};
        ctx.extensionSettings.tt_if_enhancer ??= {};
        ctx.extensionSettings.tt_if_enhancer.selfTest9 = report;
        ctx.saveSettingsDebounced?.();
    } catch (error) {
        console.error('[IF SelfTest8] 写入失败：', error);
    }
};
const step = (name, value) => {
    report.steps.push({ name, value });
    persist();
};

(async () => {
    try {
        const ctx = globalThis.SillyTavern?.getContext?.();
        // 先直接打后端接口，看清返回形状
        try {
            const started = Date.now();
            const response = await fetch('/api/backends/chat-completions/generate', {
                method: 'POST',
                headers: ctx.getRequestHeaders(),
                body: JSON.stringify({
                    chat_completion_source: 'custom',
                    custom_url: 'http://192.168.31.226:8046/v1',
                    custom_include_headers: 'Authorization: Bearer local-gateway\n',
                    custom_include_body: '',
                    custom_exclude_body: '',
                    custom_prompt_post_processing: 'none',
                    model: 'gemini-3.8-flash',
                    messages: [{ role: 'user', content: '只回复四个字：后端通路正常' }],
                    max_tokens: 64,
                    temperature: 0.5,
                    stream: false,
                }),
            });
            const text = await response.text();
            step('backend-raw', { status: response.status, ms: Date.now() - started, body: text.slice(0, 300) });
        } catch (error) {
            step('backend-raw', { error: String(error?.message ?? error) });
        }

        // 再走插件的完整提示词撰写（promptChannel=relay）
        const api = globalThis.ttIfEnhancer;
        if (api) api.updateSettings({ image: { promptChannel: 'relay' } });
        try {
            const mod = await import('/scripts/extensions/third-party/tauritavern-if-enhancer/src/core/image.js');
            const started = Date.now();
            const parsed = await mod.deriveImagePrompt({
                recent: '深夜的书房里，合欢宗长老裴守真把一叠契书拍在桌上，铜秤在指间转了半圈。窗外雨声很密，烛火晃了一下。',
                memory: { scene: '合欢宗 · 戒律堂书房', characters: ['裴守真：正在核账'] },
            });
            step('derive-relay', {
                ms: Date.now() - started,
                hasPrompt: Boolean(parsed?.prompt),
                prompt: String(parsed?.prompt ?? '').slice(0, 260),
                style: String(parsed?.style ?? '').slice(0, 120),
            });
        } catch (error) {
            step('derive-relay', { error: String(error?.message ?? error) });
        }

        // 还原为默认通道
        if (api) api.updateSettings({ image: { promptChannel: 'relay' } });
        step('done', 'ok');
    } catch (error) {
        step('error', String(error?.message ?? error));
    }
})();
