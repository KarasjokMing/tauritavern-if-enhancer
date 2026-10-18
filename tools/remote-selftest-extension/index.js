/**
 * 临时自检扩展（第十轮）：真机验证 v2 的三件事。
 *   1. 打开「多子多福-明末」聊天，读 MVU 变量（stat_data）
 *   2. 改一个数值再还原（验证 patchStatData）
 *   3. 跑一条演绎节拍（验证原生管线），随后删除测试消息
 *
 * 结果写入 extension_settings.tt_if_enhancer.selfTest10。
 */
const report = { round: 10, at: new Date().toISOString(), steps: [] };

const persist = () => {
    try {
        const ctx = globalThis.SillyTavern?.getContext?.();
        if (!ctx) return;
        ctx.extensionSettings ??= {};
        ctx.extensionSettings.tt_if_enhancer ??= {};
        ctx.extensionSettings.tt_if_enhancer.selfTest10 = report;
        ctx.saveSettingsDebounced?.();
    } catch (error) {
        console.error('[IF SelfTest10] 写入失败：', error);
    }
};
const step = (name, value) => {
    report.steps.push({ name, value });
    persist();
};
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

(async () => {
    try {
        const ctx = globalThis.SillyTavern.getContext();
        const startedWait = Date.now();
        while (!globalThis.ttIfEnhancer && Date.now() - startedWait < 90000) {
            await sleep(500);
        }
        const api = globalThis.ttIfEnhancer;
        if (!api) {
            step('error', 'ttIfEnhancer 未就绪（等了 90 秒）');
            return;
        }

        // ---- 1) 打开目标聊天 ----
        const CARD_NAME = '多子多福-明末';
        const CHAT = '多子多福-明末 - 2026-10-18@00h18m25s';
        const index = ctx.characters.findIndex(c => (c?.name || '').includes(CARD_NAME) || (c?.avatar || '').includes(CARD_NAME));
        step('card-index', index);
        try {
            if (index >= 0 && typeof ctx.selectCharacterById === 'function') {
                await ctx.selectCharacterById(index);
                await sleep(2000);
            }
            if (typeof ctx.openCharacterChat === 'function') {
                await ctx.openCharacterChat(CHAT);
                await sleep(3000);
            }
        } catch (error) {
            step('open-chat-error', String(error?.message ?? error));
        }
        step('opened', { chatId: ctx.chatId, messages: (ctx.chat || []).length, char: ctx.characters?.[ctx.characterId]?.name });

        // ---- 2) 读 MVU ----
        const mvu = await import('/scripts/extensions/third-party/tauritavern-if-enhancer/src/core/mvu.js');
        const stat = mvu.readStatData();
        if (!stat) {
            step('mvu-read', '没有 stat_data');
        } else {
            step('mvu-read', {
                topKeys: Object.keys(stat),
                variables: mvu.describeVariables(stat, { limit: 24 }),
                sampleNumbers: mvu.numericPaths(stat).slice(0, 12),
                valueOf: {
                    '主角.姓名': mvu.getByPath(stat, '主角.姓名'),
                    '主角.魅力': mvu.getByPath(stat, '主角.魅力'),
                    '大明.国库': mvu.getByPath(stat, '大明.国库'),
                    '后宫[0].姓名': mvu.getByPath(stat, '后宫[0].姓名'),
                    '后宫[0].好感': mvu.getByPath(stat, '后宫[0].好感'),
                },
            });

            // ---- 3) 改值再还原 ----
            const before = mvu.getByPath(stat, '后宫[0].好感');
            if (typeof before === 'number') {
                try {
                    await mvu.patchStatData({ '后宫[0].好感': { delta: 1 } });
                    const after = mvu.getByPath(mvu.readStatData(), '后宫[0].好感');
                    await mvu.patchStatData({ '后宫[0].好感': before });
                    step('mvu-patch', { before, after, restored: mvu.getByPath(mvu.readStatData(), '后宫[0].好感') });
                } catch (error) {
                    step('mvu-patch', '失败：' + String(error?.message ?? error));
                }
            } else {
                step('mvu-patch', '没有可测的数值（后宫为空）');
            }
        }

        // ---- 4) 演绎节拍 ----
        const beforeCount = (ctx.chat || []).length;
        const started = Date.now();
        const result = await api.runEditInstruction('主角在早朝上宣布减免陕西三年赋税，首辅黄立极出列劝阻，殿中一时安静。', {
            taskType: 'prose.generate',
            stage: text => step('prose-stage', text),
        });
        step('prose-task', {
            ms: Date.now() - started,
            ok: result.ok,
            title: result.title,
            lines: result.lines,
            warnings: result.warnings,
            detail: String(result.detail ?? '').slice(0, 700),
            messagesBefore: beforeCount,
            messagesAfter: (ctx.chat || []).length,
        });

        // ---- 5) 删除测试消息 ----
        const afterCount = (ctx.chat || []).length;
        if (afterCount > beforeCount) {
            try {
                await globalThis.TavernHelper?.deleteChatMessages?.([afterCount - 1], { refresh: 'all' });
                step('cleanup', '已删除测试生成的回复');
            } catch (error) {
                step('cleanup', '删除失败，请手动删掉最后一条：' + String(error?.message ?? error));
            }
        } else {
            step('cleanup', '未产生新消息');
        }
        step('done', 'ok');
    } catch (error) {
        step('error', String(error?.message ?? error));
    }
})();
