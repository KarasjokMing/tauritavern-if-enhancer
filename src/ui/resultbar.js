/**
 * 编辑任务回执条：把"已更新某某档案"这类执行结果显示为界面提示，
 * 而不是混进小说正文或当作角色台词。
 */
import { settings } from '../config.js';
import { toast } from '../env.js';
import { dock } from './toggle.js';

const STRIP_ID = 'tt-if-receipts';
const MAX_ITEMS = 12;

function strip() {
    let node = document.getElementById(STRIP_ID);
    if (node) return node;
    const host = dock();
    if (!host) return null;
    node = document.createElement('div');
    node.id = STRIP_ID;
    node.className = 'tt-if-receipts';
    host.append(node);
    return node;
}

/** 运行中的状态行（例如"正在整理世界书条目…"）。 */
export function setStage(text) {
    const host = strip();
    if (!host) return;
    let line = host.querySelector('.tt-if-stage');
    if (!text) {
        line?.remove();
        return;
    }
    if (!line) {
        line = document.createElement('div');
        line.className = 'tt-if-stage';
        host.prepend(line);
    }
    line.textContent = `⏳ ${text}`;
}

/** 追加一条执行结果。 */
export function pushReceipt(result) {
    setStage('');
    const host = strip();
    if (!host) return;
    const ok = result?.ok !== false;
    const item = document.createElement('details');
    item.className = `tt-if-receipt ${ok ? 'tt-if-ok' : 'tt-if-err'}`;
    item.open = false;

    const summary = document.createElement('summary');
    const mark = document.createElement('span');
    mark.className = 'tt-if-mark';
    mark.textContent = ok ? '✓' : '✗';
    const title = document.createElement('span');
    title.className = 'tt-if-title';
    title.textContent = result?.title || '执行完成';
    summary.append(mark, title);
    if (result?.label) {
        const tag = document.createElement('span');
        tag.className = 'tt-if-tag';
        tag.textContent = result.label;
        summary.append(tag);
    }
    item.append(summary);

    const body = document.createElement('div');
    body.className = 'tt-if-body';
    for (const line of result?.lines ?? []) {
        const row = document.createElement('div');
        row.textContent = line;
        body.append(row);
    }
    for (const warning of result?.warnings ?? []) {
        const row = document.createElement('div');
        row.className = 'tt-if-warn';
        row.textContent = `! ${warning}`;
        body.append(row);
    }
    if (result?.detail) {
        const pre = document.createElement('pre');
        pre.className = 'tt-if-detail';
        pre.textContent = result.detail;
        body.append(pre);
    }
    if (typeof result?.undo === 'function') {
        const undo = document.createElement('button');
        undo.type = 'button';
        undo.className = 'menu_button tt-if-undo';
        undo.textContent = '↩ 撤销这次修改';
        undo.addEventListener('click', async () => {
            undo.disabled = true;
            try {
                await result.undo();
                item.classList.add('tt-if-undone');
                undo.textContent = '已撤销';
            } catch (error) {
                toast(`撤销失败：${error?.message ?? error}`, 'error');
                undo.disabled = false;
            }
        });
        body.append(undo);
    }
    item.append(body);
    host.prepend(item);

    while (host.querySelectorAll('.tt-if-receipt').length > MAX_ITEMS) {
        host.querySelector('.tt-if-receipt:last-of-type')?.remove();
    }

    if (settings().edit.receipt === 'message' || settings().edit.receipt === 'both') {
        toast(`${title.textContent}${result?.lines?.[0] ? ` — ${result.lines[0]}` : ''}`, ok ? 'success' : 'error');
    }
    if (settings().edit.receipt !== 'off' && ok) {
        const first = result?.lines?.[0];
        if (first) console.log('[IF Enhancer]', title.textContent, '—', first);
    }
}

export function clearReceipts() {
    const host = document.getElementById(STRIP_ID);
    if (host) host.innerHTML = '';
}
