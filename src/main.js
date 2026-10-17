/**
 * 入口：装配模式切换、输入路由、注入与事件。
 *
 * 生命周期：等待宿主 → 恢复模式 → 挂载 UI → 接管编辑模式输入 → 注入导演规则。
 */
import { settings, updateSettings } from './config.js';
import { evt, onEvent, toast, waitForHost, saveSettings, rawSettings, isTT, hasTH } from './env.js';
import { MODE, initMode, mode, mountToggle, paintMode } from './ui/toggle.js';
import { mountPanel } from './ui/panel.js';
import { clearReceipts, pushReceipt, setStage } from './ui/resultbar.js';
import { clearDialogueInjection, refreshDialogueInjection } from './core/dialogue.js';
import { maybeAutoMemory, runEditInstruction } from './core/edit.js';
import { isBusy, capabilities, capabilitiesText } from './core/llm.js';
import { detectBackend, backendLabel, readWorldbook, resolveTargetBook } from './worldbook/adapter.js';
import { readMemory } from './core/memory.js';

const GUARD = '__TT_IF_ENHANCER__';
let lastReceiveAt = 0;

function inputElement() {
    return document.querySelector('#send_textarea');
}

function readInput() {
    return String(inputElement()?.value ?? '').trim();
}

function clearInput() {
    const element = inputElement();
    if (!element) return;
    element.value = '';
    element.dispatchEvent(new Event('input', { bubbles: true }));
}

function swallow(event) {
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
}

async function handleEditInput() {
    if (isBusy()) {
        toast('上一条编辑指令还在执行中', 'warning');
        return;
    }
    const text = readInput();
    if (!text) {
        toast('请输入作者指令，例如「突然下雨，张婆一反常态地走进雨中」', 'warning');
        return;
    }
    clearInput();
    setStage('正在理解指令…');
    try {
        const result = await runEditInstruction(text, { stage: setStage });
        setStage('');
        pushReceipt(result);
    } catch (error) {
        setStage('');
        pushReceipt({ ok: false, title: '编辑指令执行失败', lines: [error?.message ?? String(error)] });
    }
    await refreshDialogueInjection(mode() === MODE.DIALOGUE);
}

/** 编辑模式下截获发送动作（发送按钮与回车），阻止其作为主角台词发出。 */
function installInterceptor() {
    document.addEventListener(
        'click',
        event => {
            if (!settings().enabled || mode() !== MODE.EDIT) return;
            const button = event.target?.closest?.('#send_but, #send_button');
            if (!button) return;
            swallow(event);
            handleEditInput();
        },
        true,
    );
    document.addEventListener(
        'keydown',
        event => {
            if (!settings().enabled || mode() !== MODE.EDIT) return;
            if (event.key !== 'Enter' || event.shiftKey || event.ctrlKey || event.altKey) return;
            if (event.target?.id !== 'send_textarea') return;
            swallow(event);
            handleEditInput();
        },
        true,
    );
}

function turnCounter() {
    const store = rawSettings();
    if (!store) return 0;
    store.memory ??= {};
    store.memory.turn = Number(store.memory.turn ?? 0) + 1;
    saveSettings();
    return store.memory.turn;
}

function wireEvents() {
    onEvent(evt('CHAT_CHANGED'), async () => {
        clearReceipts();
        await refreshDialogueInjection(mode() === MODE.DIALOGUE);
    });

    const onReply = async () => {
        const now = Date.now();
        if (now - lastReceiveAt < 1500) return;
        lastReceiveAt = now;
        if (mode() !== MODE.DIALOGUE) return;
        const turn = turnCounter();
        await maybeAutoMemory(turn);
    };
    onEvent(evt('CHARACTER_MESSAGE_RECEIVED'), onReply);
    onEvent(evt('MESSAGE_RECEIVED'), onReply);
}

async function onModeChanged(next) {
    if (next === MODE.EDIT) {
        clearDialogueInjection();
        toast('编辑模式：输入将被当作作者指令，不再扮演主角', 'info');
    } else {
        await refreshDialogueInjection(true);
    }
    paintMode();
}

/** 诊断接口：供高级用户与控制台排查。 */
export async function diagnostics() {
    const lines = [
        `环境：${isTT() ? 'TauriTavern' : 'SillyTavern'} · 酒馆助手${hasTH() ? '已安装' : '未检测到'}`,
        `生成通路：${capabilitiesText()}`,
        `世界书后端：${backendLabel(detectBackend())}`,
        `当前模式：${mode()}`,
    ];
    try {
        const book = await resolveTargetBook(settings().worldbook);
        const data = await readWorldbook(book);
        lines.push(`世界书《${book}》：${data.entries.length} 条`);
    } catch (error) {
        lines.push(`世界书不可读：${error?.message ?? error}`);
    }
    try {
        const memory = await readMemory();
        lines.push(`长期记忆：${memory.summary ? '已建立' : '尚未建立'}`);
    } catch (error) {
        lines.push(`长期记忆不可读：${error?.message ?? error}`);
    }
    return { text: lines.join('\n'), lines };
}

/**
 * 开机自检快照：把本次启动的挂载结果写进扩展设置。
 * 手机上无法打开开发者工具时，这一条快照就是「界面到底挂上没有」的证据
 * （可在设置面板的「诊断」里查看，也可让用户直接贴出来）。
 */
export function recordDiagnostics(extra = {}) {
    const store = rawSettings();
    if (!store) return null;
    const bar = document.getElementById('tt-if-mode-bar');
    const buttons = bar ? bar.querySelectorAll('.tt-if-mode-btn') : [];
    store.diagnostics = {
        at: new Date().toISOString(),
        url: location.href,
        mode: mode(),
        dock: Boolean(document.getElementById('tt-if-dock')),
        modeBar: Boolean(bar),
        modeButtons: buttons.length,
        modeBarText: bar ? bar.innerText.replace(/\s+/g, ' ').trim() : '',
        sendForm: Boolean(document.querySelector('#send_form')),
        textarea: Boolean(document.querySelector('#send_textarea')),
        viewport: `${window.innerWidth}x${window.innerHeight}`,
        ...capabilities(),
        backend: detectBackend(),
        ...extra,
    };
    saveSettings();
    return store.diagnostics;
}

export function lastDiagnostics() {
    return rawSettings()?.diagnostics ?? null;
}

export async function boot() {
    if (globalThis[GUARD]) {
        console.log('[IF Enhancer] 已加载过，跳过重复初始化。');
        return;
    }
    globalThis[GUARD] = true;
    try {
        await waitForHost();
        initMode();
        mountToggle(onModeChanged);
        mountPanel();
        installInterceptor();
        wireEvents();
        await refreshDialogueInjection(mode() === MODE.DIALOGUE);
        recordDiagnostics({ boot: 'ok' });
        globalThis.ttIfEnhancer = {
            setMode: next => import('./ui/toggle.js').then(module => module.setMode(next, { user: true })),
            runEditInstruction,
            diagnostics,
            recordDiagnostics,
            settings,
            updateSettings,
        };
        console.log('[IF Enhancer] 互动小说增强系统已就绪');
    } catch (error) {
        globalThis[GUARD] = false;
        console.error('[IF Enhancer] 初始化失败：', error);
        recordDiagnostics({ boot: 'failed', error: error?.message ?? String(error) });
        toast(`互动小说增强系统初始化失败：${error?.message ?? error}`, 'error');
    }
}
