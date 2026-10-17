/* 互动小说增强系统 —— 手机端远程自检脚本
 *
 * 用途：在没有开发者工具的手机上验证扩展是否真的工作。
 * 用法：把本文件内容整体粘贴进「酒馆助手 → 脚本库 → 导入脚本」，
 *       启用后重载页面，脚本会把自检结果写进酒馆设置
 *       （extension_settings.tt_if_enhancer.selfTest），
 *       从设置里读取即可；也可在设置面板的「诊断」里看到。
 *
 * 安全性：只做只读诊断 + 写入一个名为「IF-Enhancer-自检」的临时世界书；
 *         测试产生的聊天消息会在结束时删除。测试完成后请关闭或删除本脚本。
 */
(async () => {
    const TOP = window.parent ?? window;
    const store = () => {
        const ctx = TOP.SillyTavern?.getContext?.();
        ctx.extensionSettings ??= {};
        ctx.extensionSettings.tt_if_enhancer ??= {};
        return { ctx, box: ctx.extensionSettings.tt_if_enhancer };
    };
    const save = () => {
        try {
            TOP.SillyTavern?.getContext?.()?.saveSettingsDebounced?.();
        } catch {
            /* 忽略 */
        }
    };
    const report = { at: new Date().toISOString(), steps: [] };
    const step = (name, value) => {
        report.steps.push({ name, value });
        const { box } = store();
        box.selfTest = report;
        save();
    };

    const api = TOP.ttIfEnhancer;
    if (!api) {
        step('error', '未找到 window.ttIfEnhancer：扩展未加载或在 iframe 隔离环境中');
        return;
    }

    try {
        step('diagnostics', (await api.diagnostics().catch(error => ({ text: String(error?.message ?? error) }))).text);

        const before = api.settings();
        step('mode-before', TOP.document.body.className);

        // 把写入目标固定到临时世界书，避免污染作者的正式世界书。
        api.updateSettings({ worldbook: { primaryName: 'IF-Enhancer-自检' } });
        step('target-book', 'IF-Enhancer-自检');

        // 1) 资料类任务：整理记忆 → 走 LLM 结构化输出 + 世界书写入
        const memory = await api.runEditInstruction('把目前已经发生的主要事件总结一下。');
        step('memory-task', {
            ok: memory.ok,
            title: memory.title,
            lines: memory.lines,
            warnings: memory.warnings,
            detail: String(memory.detail ?? '').slice(0, 400),
        });

        // 2) 正文类任务：演绎剧情 → 走 LLM 文本生成 + 追加消息（结束后删除）
        const TH = TOP.TavernHelper;
        const lastBefore = typeof TH?.getLastMessageId === 'function' ? TH.getLastMessageId() : null;
        const prose = await api.runEditInstruction('突然下雨，张婆一反常态地走进雨中。');
        step('prose-task', {
            ok: prose.ok,
            title: prose.title,
            lines: prose.lines,
            warnings: prose.warnings,
            detail: String(prose.detail ?? '').slice(0, 600),
        });
        if (lastBefore !== null && typeof TH?.getLastMessageId === 'function' && TH.getLastMessageId() > lastBefore) {
            try {
                await TH.deleteChatMessages([TH.getLastMessageId()], { refresh: 'all' });
                step('prose-cleanup', '已删除测试生成的回复');
            } catch (error) {
                step('prose-cleanup', `删除失败，请手动检查最后一条回复：${error?.message ?? error}`);
            }
        } else {
            step('prose-cleanup', '未产生新消息，无需清理');
        }

        // 3) 世界书读取验证
        const diag = await api.diagnostics();
        step('after', diag.text);

        // 还原世界书写入目标
        api.updateSettings({ worldbook: { primaryName: before.worldbook?.primaryName ?? '' } });
        await api.setMode('dialogue');
        step('done', 'ok');
    } catch (error) {
        step('error', String(error?.message ?? error));
    }
})();
