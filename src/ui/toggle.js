/**
 * 输入框旁的「💬 对话 ｜ ✏️ 编辑」模式切换。
 * 落点在 #send_form 之前的独立容器里，不破坏酒馆原有输入区布局。
 */
import { settings, updateSettings } from '../config.js';
import { toast } from '../env.js';

export const DOCK_ID = 'tt-if-dock';
export const BAR_ID = 'tt-if-mode-bar';
export const TASK_SELECT_ID = 'tt-if-task';

export const MODE = { DIALOGUE: 'dialogue', EDIT: 'edit' };

/** 编辑模式的显式任务类型：选中的类型直接决定处理方式，分类器完全不参与。 */
export const TASK_OPTIONS = [
    ['auto', '自动判断'],
    ['prose.generate', '✏️ 演绎剧情（写新正文）'],
    ['config.adjust', '⚙️ 更改配置（生成参数/偏好）'],
    ['prose.revise', '✏️ 修改正文（改已有回复）'],
    ['character.create', '👤 创建人物'],
    ['character.update', '👤 修改人物'],
    ['worldbook.write', '📚 写入世界书'],
    ['memory.summarize', '🗂 整理记忆'],
];

const PLACEHOLDERS = {
    auto: '作者指令：例如「突然下雨，张婆一反常态地走进雨中」',
    'prose.generate': '演绎剧情：描述要发生的事，例如「突然下雨，张婆走进雨中」',
    'config.adjust': '更改配置：例如「推进速度设为快」「回复短一点」「不要替主角做决定」',
    'prose.revise': '修改正文：例如「把最后一条回复改得更自然」',
    'character.create': '创建人物：例如「创建一个合欢宗长老，女性，年约四十」',
    'character.update': '修改人物：例如「柳如烟应该更善于伪装」',
    'worldbook.write': '写入世界书：例如「把坡子口和张婆的设定整理进去」',
    'memory.summarize': '整理记忆：例如「总结目前已经发生的主要事件」',
};

let currentMode = MODE.DIALOGUE;
let currentTask = 'auto';
let onModeChange = () => {};
let observer = null;

export function mode() {
    return currentMode;
}

export function taskType() {
    return currentTask;
}

export function setTaskType(value, { persist = true } = {}) {
    currentTask = TASK_OPTIONS.some(([key]) => key === value) ? value : 'auto';
    if (persist) updateSettings({ edit: { taskType: currentTask } });
    const select = document.getElementById(TASK_SELECT_ID);
    if (select) select.value = currentTask;
    paintMode();
    return currentTask;
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

    // 编辑模式专用：显式任务类型。选中什么就按什么处理，不再让分类器猜。
    const taskRow = document.createElement('div');
    taskRow.className = 'tt-if-task-row';
    taskRow.id = 'tt-if-task-row';
    const label = document.createElement('span');
    label.className = 'tt-if-task-label';
    label.textContent = '这条按什么处理：';
    const select = document.createElement('select');
    select.id = TASK_SELECT_ID;
    select.className = 'tt-if-task-select';
    for (const [value, text] of TASK_OPTIONS) {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = text;
        select.append(option);
    }
    select.value = currentTask;
    select.addEventListener('change', () => setTaskType(select.value));
    select.addEventListener('click', event => event.stopPropagation());
    taskRow.append(label, select);
    bar.append(taskRow);

    bar.addEventListener('click', event => {
        const target = event.target.closest('.tt-if-mode-btn');
        if (!target) return;
        event.preventDefault();
        event.stopPropagation();
        setMode(target.dataset.mode, { user: true });
    });
    return bar;
}

/** 更新按钮、任务选择器、占位符与输入区视觉状态。 */
export function paintMode() {
    const bar = document.getElementById(BAR_ID);
    if (bar) {
        bar.querySelectorAll('.tt-if-mode-btn').forEach(element => {
            element.classList.toggle('tt-if-active', element.dataset.mode === currentMode);
        });
        const hint = bar.querySelector('#tt-if-mode-hint');
        if (hint) hint.textContent = currentMode === MODE.EDIT ? '作者视角：输入将被当作编辑指令' : '主角视角：输入代表主角言行';
        const taskRow = bar.querySelector('#tt-if-task-row');
        if (taskRow) taskRow.classList.toggle('tt-if-hidden', currentMode !== MODE.EDIT);
        const select = bar.querySelector(`#${TASK_SELECT_ID}`);
        if (select && select.value !== currentTask) select.value = currentTask;
    }
    const textarea = document.querySelector('#send_textarea');
    if (textarea) {
        if (!textarea.dataset.ttIfOriginalPlaceholder) {
            textarea.dataset.ttIfOriginalPlaceholder = textarea.getAttribute('placeholder') ?? '';
        }
        textarea.setAttribute(
            'placeholder',
            currentMode === MODE.EDIT
                ? PLACEHOLDERS[currentTask] ?? PLACEHOLDERS.auto
                : textarea.dataset.ttIfOriginalPlaceholder,
        );
    }
    const form = document.querySelector('#send_form');
    form?.classList.toggle('tt-if-editing', currentMode === MODE.EDIT);
    form?.classList.toggle('tt-if-task-config', currentMode === MODE.EDIT && currentTask === 'config.adjust');
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

/** 初始化：从设置里恢复模式与任务类型。 */
export function initMode() {
    const config = settings();
    currentMode = config.rememberMode && config.lastMode ? config.lastMode : config.defaultMode;
    if (currentMode !== MODE.EDIT) currentMode = MODE.DIALOGUE;
    currentTask = TASK_OPTIONS.some(([key]) => key === config.edit?.taskType) ? config.edit.taskType : 'auto';
    return currentMode;
}
