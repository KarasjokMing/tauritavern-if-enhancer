/**
 * 扩展设置面板（挂在「扩展」设置区 #extensions_settings2）。
 * 同时提供诊断信息与手动操作按钮。
 */
import { settings, setSetting } from '../config.js';
import { backendLabel, detectBackend, listWorldbooks, readWorldbook, resolveTargetBook } from '../worldbook/adapter.js';
import { capabilitiesText, capabilities, resetSchemaCapability } from '../core/llm.js';
import { summarize, readMemory } from '../core/memory.js';
import { maintain } from '../core/maintain.js';
import { refreshDialogueInjection } from '../core/dialogue.js';
import { runEditInstruction } from '../core/edit.js';
import { lastDiagnostics } from '../main.js';
import { pushReceipt, setStage } from './resultbar.js';
import { isTT, hasTH, toast } from '../env.js';

const PANEL_ID = 'tt-if-panel';

function el(tag, props = {}, children = []) {
    const node = document.createElement(tag);
    Object.assign(node, props);
    for (const child of [].concat(children)) {
        if (child == null) continue;
        node.append(child);
    }
    return node;
}

function checkbox(labelText, path, hint = '') {
    const input = el('input', { type: 'checkbox', checked: Boolean(path.split('.').reduce((a, k) => a?.[k], settings())) });
    input.addEventListener('change', () => {
        setSetting(path, input.checked);
        refreshDialogueInjection().catch(() => {});
    });
    return el('label', { className: 'tt-if-field' }, [
        el('span', { className: 'tt-if-label', textContent: labelText }),
        input,
        hint ? el('small', { textContent: hint }) : null,
    ]);
}

function select(labelText, path, options, hint = '') {
    const current = path.split('.').reduce((a, k) => a?.[k], settings());
    const node = el('select');
    for (const [value, text] of Object.entries(options)) {
        node.append(el('option', { value, textContent: text, selected: String(current) === String(value) }));
    }
    node.addEventListener('change', () => {
        setSetting(path, node.value);
        refreshDialogueInjection().catch(() => {});
    });
    return el('label', { className: 'tt-if-field' }, [
        el('span', { className: 'tt-if-label', textContent: labelText }),
        node,
        hint ? el('small', { textContent: hint }) : null,
    ]);
}

function number(labelText, path, { min = 0, max = 999, hint = '' } = {}) {
    const current = path.split('.').reduce((a, k) => a?.[k], settings());
    const node = el('input', { type: 'number', value: Number(current ?? 0), min, max });
    node.addEventListener('change', () => setSetting(path, Number(node.value)));
    return el('label', { className: 'tt-if-field' }, [
        el('span', { className: 'tt-if-label', textContent: labelText }),
        node,
        hint ? el('small', { textContent: hint }) : null,
    ]);
}

function text(labelText, path, hint = '') {
    const current = path.split('.').reduce((a, k) => a?.[k], settings());
    const node = el('input', { type: 'text', value: String(current ?? '') });
    node.addEventListener('change', () => setSetting(path, node.value.trim()));
    return el('label', { className: 'tt-if-field' }, [
        el('span', { className: 'tt-if-label', textContent: labelText }),
        node,
        hint ? el('small', { textContent: hint }) : null,
    ]);
}

function action(labelText, handler) {
    const node = el('div', { className: 'menu_button menu_button_icon tt-if-action', textContent: labelText });
    node.addEventListener('click', async () => {
        node.classList.add('tt-if-busy');
        try {
            await handler();
        } catch (error) {
            toast(error?.message ?? String(error), 'error');
        } finally {
            node.classList.remove('tt-if-busy');
        }
    });
    return node;
}

async function diagnostics() {
    const caps = capabilities();
    const backend = detectBackend();
    const books = await listWorldbooks().catch(() => []);
    let target = '';
    try {
        target = await resolveTargetBook(settings().worldbook);
    } catch (error) {
        target = `（无法确定：${error?.message ?? error}）`;
    }
    const lines = [
        `环境：${isTT() ? 'TauriTavern' : 'SillyTavern'} · 酒馆助手${hasTH() ? '已安装' : '未检测到'}`,
        `生成通路：${capabilitiesText()}`,
        `世界书后端：${backendLabel(backend)}`,
        `世界书数量：${books.length}`,
        `当前写入目标：${target}`,
        `结构化输出：${caps.jsonSchema ? '可用' : '不可用（将退回文本解析）'}`,
    ];
    const boot = lastDiagnostics();
    if (boot) {
        lines.push(
            '',
            `开机自检（${boot.at ?? '—'}）：`,
            `  模式条：${boot.modeBar ? `已挂载（${boot.modeButtons} 个按钮）` : '未挂载'}`,
            `  落点容器：${boot.dock ? '有' : '无'} · 输入框：${boot.textarea ? '有' : '无'} · 发送区：${boot.sendForm ? '有' : '无'}`,
            `  模式条文字：${boot.modeBarText || '（空）'}`,
            `  视口：${boot.viewport ?? '—'} · 当前模式：${boot.mode ?? '—'}`,
            boot.error ? `  启动错误：${boot.error}` : '',
        );
    }
    return lines.filter(line => line !== '').join('\n');
}

export function mountPanel() {
    if (document.getElementById(PANEL_ID)) return;
    const host = document.querySelector('#extensions_settings2') ?? document.querySelector('#extensions_settings');
    if (!host) return;

    const box = el('div', { id: PANEL_ID, className: 'tt-if-panel' });
    box.append(el('h4', { textContent: '互动小说增强系统' }));
    box.append(
        el('div', { className: 'tt-if-note', textContent: '对话模式＝你是主角；编辑模式＝你是作者。两种模式共用同一条聊天、人物资料、世界书与剧情记忆。' }),
    );

    box.append(checkbox('启用扩展', 'enabled'));
    box.append(checkbox('记住上次使用的模式', 'rememberMode'));

    box.append(el('h5', { textContent: '对话模式' }));
    box.append(checkbox('注入导演规则（多人物自然互动、不替主角决定）', 'dialogue.injectRules'));
    box.append(checkbox('注入当前场景与长期记忆', 'dialogue.injectSceneState'));
    box.append(number('注入深度', 'dialogue.depth', { min: 0, max: 20, hint: '0 表示紧跟最新消息' }));

    box.append(el('h5', { textContent: '编辑模式' }));
    box.append(
        select('「这条按什么处理」默认值', 'edit.taskType', {
            auto: '自动判断',
            'prose.generate': '✏️ 演绎剧情（写新正文）',
            'config.adjust': '⚙️ 更改配置（生成参数/偏好）',
            'prose.revise': '✏️ 修改正文（改已有回复）',
            'character.create': '👤 创建人物',
        }, '这只是默认值；输入框上方随时可以改。'),
    );
    box.append(
        select('作者指令是否记入聊天', 'edit.logInstruction', {
            bar: '只显示在回执里（推荐）',
            chat: '记为隐藏消息（可见，但不进入模型上下文）',
            both: '两者都要',
        }),
    );
    box.append(checkbox('在回执里显示作者指令', 'edit.showInstruction'));
    box.append(
        select('执行结果展示方式', 'edit.receipt', {
            bar: '只显示在输入框上方',
            message: '只弹出提示',
            both: '两者都显示',
            off: '不显示',
        }),
    );
    box.append(number('带入的历史条数', 'edit.historyMessages', { min: 4, max: 80 }));
    box.append(checkbox('校验不通过时阻止写入世界书', 'lint.blockOnError'));

    box.append(el('h5', { textContent: '世界书' }));
    box.append(
        select('写入目标', 'worldbook.target', {
            chat: '聊天级世界书（推荐）',
            char: '角色卡绑定世界书',
            global: '全局世界书',
        }),
    );
    box.append(text('新建世界书名称模板', 'worldbook.nameTemplate', '可用 {{char}} 与 {{chat}}'));
    box.append(text('手动指定世界书名称（留空则自动）', 'worldbook.primaryName'));

    box.append(el('h5', { textContent: '自动维护（记忆 / 人物经历）' }));
    box.append(checkbox('启用自动维护', 'maintain.enabled', '达到阈值就在后台总结，不需要你发指令'));
    box.append(
        select('触发方式', 'maintain.trigger', {
            chars: '按上下文总字数（推荐）',
            interval: '按回复条数间隔',
        }),
    );
    box.append(number('上下文字数阈值', 'maintain.charThreshold', { min: 4000, max: 200000, hint: '聊天正文总字数到这么多就总结一次；再次触发还需再涨约 40%' }));
    box.append(number('按条数触发时每 N 条', 'maintain.intervalReplies', { min: 2, max: 200 }));
    box.append(number('每次总结带入的最近消息数', 'maintain.keepRecent', { min: 4, max: 60 }));
    box.append(checkbox('同时累积人物经历', 'maintain.updateCharacters', '写成 [互动小说]人物经历·某某 条目，不改动卡里原有的人设条目'));
    box.append(
        select('写入位置', 'maintain.writeTarget', {
            card: '角色卡内嵌世界书（写前整卡备份）',
            book: '角色卡绑定的世界书',
        }),
    );
    box.append(checkbox('启用旧版按条数记忆', 'memory.enabled', '与上面的自动维护二选一，一般保持关闭'));

    box.append(el('h5', { textContent: '自动配图（提示词由扩展自己写）' }));
    box.append(checkbox('启用配图功能', 'image.enabled'));
    box.append(
        select('出图时机', 'image.auto', {
            off: '只在我说「配图」时出图',
            interval: '每隔若干条回复自动出一张',
        }),
    );
    box.append(number('自动出图间隔（回复条数）', 'image.intervalReplies', { min: 2, max: 60 }));
    box.append(
        select('谁来写提示词', 'image.promptChannel', {
            relay: '反重力中继（经酒馆后端出网，写画面更细）',
            chat: '当前聊天模型',
        }, '反重力不可用时会自动改用当前聊天模型。'),
    );
    box.append(text('反重力中继地址', 'image.relayUrl'));
    box.append(text('反重力模型', 'image.relayModel'));
    box.append(text('固定画风后缀（可留空）', 'image.styleSuffix', '例如 anime style, cinematic lighting'));
    box.append(text('固定负面词（可留空）', 'image.negative'));
    box.append(
        checkbox('只出图、不贴进聊天', 'image.quiet', '开启后图片只保存在 ComfyUI 的输出目录，酒馆里不会出现；一般保持关闭'),
    );
    box.append(checkbox('存到角色相册', 'image.gallery'));
    box.append(checkbox('参考世界书里的人物外貌锚点', 'image.includeCharacterSheets'));
    box.append(number('提示词最大长度', 'image.maxPromptChars', { min: 80, max: 900 }));

    box.append(el('h5', { textContent: 'TauriTavern Agent（实验性）' }));
    box.append(checkbox('允许使用 TT Agent 通路', 'agent.enabled'));
    box.append(text('作者 Profile ID', 'agent.profileAuthor'));
    box.append(text('记忆 Profile ID', 'agent.profileMemory'));

    box.append(el('h5', { textContent: '诊断与手动操作' }));
    const diag = el('pre', { className: 'tt-if-diag' });
    box.append(diag);
    box.append(
        el('div', { className: 'tt-if-actions' }, [
            action('刷新诊断', async () => {
                diag.textContent = await diagnostics();
            }),
            action('立即维护一次', async () => {
                setStage('正在总结最近剧情…');
                const result = await maintain({ stage: setStage });
                setStage('');
                pushReceipt({
                    ok: result.ok,
                    title: result.ok ? '已维护记忆 / 人物经历' : '暂不需要维护',
                    lines: result.ok
                        ? [`${result.where}：新增 ${result.created ?? 0} 条，更新 ${result.updated ?? 0} 条`, `上下文 ${result.chars ?? 0} 字`]
                        : [result.reason],
                    detail: String(result.memory?.summary ?? '').slice(0, 500),
                });
            }),
            action('试生成一张配图', async () => {
                setStage('正在按当前剧情写配图提示词…');
                const result = await runEditInstruction('配图', { taskType: 'image.generate', stage: setStage });
                setStage('');
                pushReceipt(result);
            }),
            action('查看作者偏好', async () => {
                const list = settings().authorPreferences ?? [];
                pushReceipt({
                    ok: true,
                    title: `作者偏好：${list.length} 条`,
                    lines: list.length ? ['这些偏好会注入对话模式，并写入世界书「作者偏好」条目'] : ['还没有记录任何偏好'],
                    detail: list.map((item, index) => `${index + 1}. ${item.text}`).join('\n'),
                });
            }),
            action('清空作者偏好', async () => {
                setSetting('authorPreferences', []);
                await refreshDialogueInjection();
                pushReceipt({ ok: true, title: '已清空作者偏好', lines: ['世界书里的「作者偏好」条目需要你手动删除或覆盖'] });
            }),
            action('重新尝试结构化输出', async () => {
                resetSchemaCapability();
                toast('已重置：下一次结构化任务会重新尝试原生结构化输出', 'success');
                diag.textContent = await diagnostics();
            }),
            action('检查世界书', async () => {                const name = await resolveTargetBook(settings().worldbook);
                const book = await readWorldbook(name);
                const memory = await readMemory();
                pushReceipt({
                    title: `世界书《${name}》`,
                    lines: [`条目 ${book.entries.length} 条（后端：${backendLabel(book.backend)}）`, `记忆条目 ${memory.entries.length} 条`],
                    detail: book.entries.map(entry => `${entry.enabled ? '●' : '○'} ${entry.name}`).join('\n'),
                });
            }),
            action('自检：执行一条示例编辑指令', async () => {
                setStage('正在自检…');
                const result = await runEditInstruction('总结一下目前已经发生的主要事件。');
                setStage('');
                pushReceipt(result);
            }),
        ]),
    );
    box.append(
        el('div', {
            className: 'tt-if-note',
            textContent: '提示：编辑模式下输入框会变色并显示「作者指令」占位符，避免把作者指令误当成主角台词。',
        }),
    );

    host.append(box);
    diag.textContent = '点击「刷新诊断」查看当前环境能力。';
    diagnostics().then(text => {
        diag.textContent = text;
    });
}

export function unmountPanel() {
    document.getElementById(PANEL_ID)?.remove();
}
