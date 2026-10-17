/**
 * 输入框旁的「💬 对话 ｜ ✏️ 编辑」模式切换。
 * 落点在 #send_form 之前的独立容器里，不破坏酒馆原有输入区布局。
 */
import { settings, updateSettings } from '../config.js';
import { toast } from '../env.js';

export const DOCK_ID = 'tt-if-dock';
export const BAR_ID = 'tt-if-mode-bar';

export const MODE = { DIALOGUE: 'dialogue', EDIT: 'edit' };

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
    bar.append(button('💬 对话', MODE.DIALOGUE), button('✏️ 编辑', MODE.EDIT));
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
        if (hint) hint.textContent = currentMode === MODE.EDIT ? '作者视角：输入将被当作编辑指令' : '主角视角：输入代表主角言行';
    }
    const textarea = document.querySelector('#send_textarea');
    if (textarea) {
        if (!textarea.dataset.ttIfOriginalPlaceholder) {
            textarea.dataset.ttIfOriginalPlaceholder = textarea.getAttribute('placeholder') ?? '';
        }
        textarea.setAttribute(
            'placeholder',
            currentMode === MODE.EDIT
                ? '作者指令：例如「突然下雨，张婆一反常态地走进雨中」'
                : textarea.dataset.ttIfOriginalPlaceholder,
        );
    }
    const form = document.querySelector('#send_form');
    form?.classList.toggle('tt-if-editing', currentMode === MODE.EDIT);
    document.body.classList.toggle('tt-if-edit-mode', currentMode === MODE.EDIT);
}

/** 切换模式。 */
export function setMode(next, { user = false, silent = false } = {}) {
    if (next !== MODE.DIALOGUE && next !== MODE.EDIT) return currentMode;
    const changed = next !== currentMode;
    currentMode = next;
    if (user) updateSettings({ lastMode: next });
    paintMode();
    if (changed || user) onModeChange(currentMode);
    if (user && !silent) {
        toast(
            currentMode === MODE.EDIT
                ? '已进入编辑模式：你说的话代表作者，不再扮演主角'
                : '已回到对话模式：你说的话代表主角',
            'info',
        );
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
    currentMode = config.rememberMode && config.lastMode ? config.lastMode : config.defaultMode;
    if (currentMode !== MODE.EDIT) currentMode = MODE.DIALOGUE;
    return currentMode;
}
