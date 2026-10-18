/**
 * 输入框旁的模式切换：💬 对话 ｜ ✍️ 演绎 ｜ ⚙️ 编辑
 *
 * 三种模式职责互不重叠：
 *   对话 —— 玩家扮演主角，走酒馆原生生成
 *   演绎 —— 作者给节拍，走酒馆原生管线（受预设/卡/世界书约束）
 *   编辑 —— 设置层全部交给 AI（配置、世界书、人物、记忆、变量），不产生正文
 *
 * 不再提供「任务类型」下拉：演绎与编辑已经分开，编辑内部的判断由 AI 完成。
 */
import { settings, updateSettings } from '../config.js';
import { toast } from '../env.js';

export const DOCK_ID = 'tt-if-dock';
export const BAR_ID = 'tt-if-mode-bar';

export const MODE = { DIALOGUE: 'dialogue', PROSE: 'prose', EDIT: 'edit' };

export const MODE_LABEL = {
    dialogue: '💬 对话',
    prose: '✍️ 演绎',
    edit: '⚙️ 编辑',
};

const PLACEHOLDERS = {
    dialogue: '',
    prose: '演绎节拍：谁、在哪、发生什么。例如「主角来到坡子口催租，张婆要把柳如烟赶走，主角替她交了租」',
    edit: '编辑指令：例如「收录张婆」「推进节奏调快」「周皇后好感涨得快一点」「把好感调到 60」',
};

const HINTS = {
    dialogue: '主角视角：你的输入代表主角言行',
    prose: '作者视角：给节拍，按预设演成正文',
    edit: '设置模式：不写正文，只改设定/记忆/变量',
};

let currentMode = MODE.DIALOGUE;
let onModeChange = () => {};
let observer = null;

export function mode() {
    return currentMode;
}

export function dock() {
    return document.getElementById(DOCK_ID);
}

function ensureDock() {
    let node = document.getElementById(DOCK_ID);
    if (node) return node;
    node = document.createElement('div');
    node.id = DOCK_ID;
    const form = document.querySelector('#send_form');
    if (!form || !form.parentNode) return null;
    form.parentNode.insertBefore(node, form);
    return node;
}

function button(label, value) {
    const element = document.createElement('button');
    element.type = 'button';
    element.className = 'tt-if-mode-btn';
    element.dataset.mode = value;
    element.textContent = label;
    return element;
}

function buildBar() {
    const bar = document.createElement('div');
    bar.id = BAR_ID;
    bar.className = 'tt-if-mode-bar';
    bar.append(button(MODE_LABEL.dialogue, MODE.DIALOGUE), button(MODE_LABEL.prose, MODE.PROSE), button(MODE_LABEL.edit, MODE.EDIT));
    const hint = document.createElement('span');
    hint.className = 'tt-if-mode-hint';
    hint.id = 'tt-if-mode-hint';
    bar.append(hint);
    bar.addEventListener('click', event => {
        const target = event.target.closest('.tt-if-mode-btn');
        if (!target) return;
        event.preventDefault();
        event.stopPropagation();
        setMode(target.dataset.mode, { user: true });
    });
    return bar;
}

/** 更新按钮、占位符与输入区视觉状态。 */
export function paintMode() {
    const bar = document.getElementById(BAR_ID);
    if (bar) {
        bar.querySelectorAll('.tt-if-mode-btn').forEach(element => {
            element.classList.toggle('tt-if-active', element.dataset.mode === currentMode);
        });
        const hint = bar.querySelector('#tt-if-mode-hint');
        if (hint) hint.textContent = HINTS[currentMode] ?? '';
    }
    const textarea = document.querySelector('#send_textarea');
    if (textarea) {
        if (!textarea.dataset.ttIfOriginalPlaceholder) {
            textarea.dataset.ttIfOriginalPlaceholder = textarea.getAttribute('placeholder') ?? '';
        }
        const placeholder = currentMode === MODE.DIALOGUE ? textarea.dataset.ttIfOriginalPlaceholder : PLACEHOLDERS[currentMode];
        textarea.setAttribute('placeholder', placeholder || '');
    }
    const form = document.querySelector('#send_form');
    form?.classList.toggle('tt-if-editing', currentMode !== MODE.DIALOGUE);
    form?.classList.toggle('tt-if-prose', currentMode === MODE.PROSE);
    form?.classList.toggle('tt-if-task-config', currentMode === MODE.EDIT);
    document.body.classList.toggle('tt-if-edit-mode', currentMode === MODE.EDIT);
    document.body.classList.toggle('tt-if-prose-mode', currentMode === MODE.PROSE);
}

/** 切换模式。 */
export function setMode(next, { user = false, silent = false } = {}) {
    if (!Object.values(MODE).includes(next)) return currentMode;
    const changed = next !== currentMode;
    currentMode = next;
    if (user) updateSettings({ lastMode: next });
    paintMode();
    if (changed || user) onModeChange(currentMode);
    if (user && !silent) {
        const text = {
            dialogue: '已回到对话模式：你说的话代表主角',
            prose: '已进入演绎模式：你给节拍，按当前预设演成正文',
            edit: '已进入编辑模式：AI 负责设置层，不会写进正文',
        };
        toast(text[currentMode], 'info');
    }
    return currentMode;
}

/** 挂载模式条；返回解除函数。 */
export function mountToggle(handler) {
    onModeChange = typeof handler === 'function' ? handler : () => {};
    const install = () => {
        const host = ensureDock();
        if (!host || document.getElementById(BAR_ID)) return;
        host.append(buildBar());
        paintMode();
    };
    install();
    observer = new MutationObserver(() => {
        if (document.getElementById(BAR_ID)) return;
        install();
    });
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer?.disconnect();
}

/** 初始化：从设置里恢复模式。 */
export function initMode() {
    const config = settings();
    const wanted = (config.rememberMode && config.lastMode) || config.defaultMode;
    currentMode = Object.values(MODE).includes(wanted) ? wanted : MODE.DIALOGUE;
    return currentMode;
}
