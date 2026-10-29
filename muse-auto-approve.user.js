// ==UserScript==
// @name         Muse 自动审批 (经典穿透 + 迷你拖拽融合版)
// @namespace    https://github.com/waw666waw666/MuseAutoApprove
// @version      6.3
// @description  智能穿透 Closed Shadow DOM 与 iframe 沙盒，全自动审批 Muse.ai 助手权限；升级为迷你可拖拽、状态记忆的悬浮胶囊
// @author       waw666waw666
// @match        *://muse.ai/*
// @match        *://*.muse.ai/*
// @match        *://*/*
// @run-at       document-start
// @grant        unsafeWindow
// @license      MIT
// @updateURL    https://raw.githubusercontent.com/waw666waw666/MuseAutoApprove/main/muse-auto-approve.user.js
// @downloadURL  https://raw.githubusercontent.com/waw666waw666/MuseAutoApprove/main/muse-auto-approve.user.js
// ==/UserScript==

(function () {
    'use strict';

    // 免责声明：本脚本仅用于个人工作流自动化提效研究，因自动化操作引发的账号封禁、限制或数据变动等风险均由使用者自行承担。
    const win = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
    const isTop = (win.self === win.top);

    // 顶层窗口若非 muse.ai 站点则不激活，避免在其他无关网页显示悬浮窗及多余轮询
    if (isTop && !win.location.hostname.includes('muse.ai')) {
        return;
    }

    // 1. 强行破解 Closed Shadow DOM（保持不变，确保能穿透封闭组件）
    const shadowRoots = new Set();
    const origAttachShadow = Element.prototype.attachShadow;
    Element.prototype.attachShadow = function (init) {
        const root = origAttachShadow.call(this, { ...init, mode: 'open' });
        shadowRoots.add(root);
        return root;
    };

    const STORAGE_KEY_ENABLED = 'muse_tm_enabled_v63';
    const STORAGE_KEY_COUNT = 'muse_tm_count_v63';
    const STORAGE_KEY_POS = 'muse_tm_pos_v63';

    let isEnabled = true;
    let approveCount = 0;
    let savedPos = null;

    try {
        if (localStorage.getItem(STORAGE_KEY_ENABLED) === 'false') isEnabled = false;
        approveCount = parseInt(localStorage.getItem(STORAGE_KEY_COUNT) || '0', 10) || 0;
        const posStr = localStorage.getItem(STORAGE_KEY_POS);
        if (posStr) savedPos = JSON.parse(posStr);
    } catch (e) {}

    // 子窗口通知顶层窗口更新计数
    win.addEventListener('message', (e) => {
        if (e.data === 'MUSE_TM_CLICKED' && isTop) {
            approveCount++;
            try { localStorage.setItem(STORAGE_KEY_COUNT, String(approveCount)); } catch (err) {}
            updateBadge();
        }
    });

    // 2. 右上角迷你可拖拽悬浮窗（只在主页面显示）
    const updateBadge = () => {
        if (!isTop || !document.body) return;

        // 清理旧悬浮窗
        document.querySelectorAll('div').forEach(el => {
            if (el.id !== 'muse-tm-badge-v63' && el.children.length <= 4) {
                const t = (el.textContent || '').trim();
                if (t.startsWith('自动审批:') || el.id.startsWith('muse-tm-badge')) el.remove();
            }
        });

        let badge = document.getElementById('muse-tm-badge-v63');
        if (!badge) {
            badge = document.createElement('div');
            badge.id = 'muse-tm-badge-v63';
            badge.title = '按住拖动位置 | 左键：开启/暂停 | 右键：清零计数';
            badge.style.cssText = `
                position: fixed; z-index: 2147483647;
                display: inline-flex; align-items: center; gap: 5px;
                padding: 3px 9px; border-radius: 999px;
                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
                font-size: 11px; font-weight: 600; line-height: 1.2;
                color: #fff; cursor: grab; user-select: none;
                box-shadow: 0 2px 8px rgba(0,0,0,0.35); backdrop-filter: blur(6px);
                transition: background 0.2s ease, opacity 0.2s ease; opacity: 0.9;
            `;

            // 恢复上次拖动的位置
            if (savedPos && typeof savedPos.left === 'number' && typeof savedPos.top === 'number') {
                const maxLeft = Math.max(10, window.innerWidth - 90);
                const maxTop = Math.max(10, window.innerHeight - 35);
                badge.style.left = Math.min(Math.max(4, savedPos.left), maxLeft) + 'px';
                badge.style.top = Math.min(Math.max(4, savedPos.top), maxTop) + 'px';
            } else {
                badge.style.top = '16px';
                badge.style.right = '16px';
            }

            // 拖拽与点击逻辑
            let isDragging = false;
            let hasMoved = false;
            let startX = 0, startY = 0, initialLeft = 0, initialTop = 0;

            badge.addEventListener('pointerdown', (e) => {
                if (e.button !== 0) return;
                isDragging = true;
                hasMoved = false;
                startX = e.clientX;
                startY = e.clientY;
                const rect = badge.getBoundingClientRect();
                initialLeft = rect.left;
                initialTop = rect.top;
                badge.style.cursor = 'grabbing';
                badge.setPointerCapture(e.pointerId);
            });

            badge.addEventListener('pointermove', (e) => {
                if (!isDragging) return;
                const dx = e.clientX - startX;
                const dy = e.clientY - startY;
                if (Math.abs(dx) > 3 || Math.abs(dy) > 3) hasMoved = true;
                if (hasMoved) {
                    const newLeft = Math.min(Math.max(4, initialLeft + dx), window.innerWidth - badge.offsetWidth - 4);
                    const newTop = Math.min(Math.max(4, initialTop + dy), window.innerHeight - badge.offsetHeight - 4);
                    badge.style.right = 'auto';
                    badge.style.bottom = 'auto';
                    badge.style.left = newLeft + 'px';
                    badge.style.top = newTop + 'px';
                }
            });

            badge.addEventListener('pointerup', (e) => {
                if (!isDragging) return;
                isDragging = false;
                badge.style.cursor = 'grab';
                badge.releasePointerCapture(e.pointerId);

                if (hasMoved) {
                    const rect = badge.getBoundingClientRect();
                    savedPos = { left: rect.left, top: rect.top };
                    try { localStorage.setItem(STORAGE_KEY_POS, JSON.stringify(savedPos)); } catch (err) {}
                } else {
                    isEnabled = !isEnabled;
                    try { localStorage.setItem(STORAGE_KEY_ENABLED, String(isEnabled)); } catch (err) {}
                    updateBadge();
                }
            });

            badge.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                approveCount = 0;
                try { localStorage.setItem(STORAGE_KEY_COUNT, '0'); } catch (err) {}
                updateBadge();
            });

            document.body.appendChild(badge);
        }

        badge.style.background = isEnabled
            ? 'linear-gradient(135deg, rgba(16,185,129,0.92), rgba(5,150,105,0.92))'
            : 'linear-gradient(135deg, rgba(75,85,99,0.9), rgba(55,65,81,0.9))';
        badge.style.border = isEnabled ? '1px solid rgba(167, 243, 208, 0.35)' : '1px solid rgba(156, 163, 175, 0.25)';
        badge.innerHTML = `
            <span style="width:6px;height:6px;border-radius:50%;background:${isEnabled ? '#a7f3d0' : '#9ca3af'};${isEnabled ? 'box-shadow:0 0 4px #a7f3d0;' : ''}"></span>
            <span>${isEnabled ? '自动' : '暂停'}</span>
            <span style="background:rgba(0,0,0,0.22);padding:1px 5px;border-radius:999px;font-size:10px;">${approveCount}</span>
        `;
    };

    // 3. 深度搜寻页面 + 所有 ShadowDOM + 所有同源 iframe 里的全部元素
    const getAllElementsDeep = (root = document) => {
        const list = [];
        const walk = (nodeRoot) => {
            if (!nodeRoot) return;
            const all = nodeRoot.querySelectorAll ? nodeRoot.querySelectorAll('*') : [];
            for (const el of all) {
                list.push(el);
                if (el.shadowRoot) walk(el.shadowRoot);
                if (el.tagName === 'IFRAME') {
                    try { if (el.contentDocument) walk(el.contentDocument); } catch (e) {}
                }
            }
        };
        walk(root);
        shadowRoots.forEach(sr => walk(sr));
        return list;
    };

    // 4. 全方位触发点击（保持你原有的高成功率点击链）
    const realClick = (el) => {
        const fire = (node) => {
            if (!node) return;
            try {
                const rect = node.getBoundingClientRect();
                const x = rect.left + rect.width / 2;
                const y = rect.top + rect.height / 2;
                const opts = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, button: 0, buttons: 1 };
                node.dispatchEvent(new PointerEvent('pointerdown', opts));
                node.dispatchEvent(new MouseEvent('mousedown', opts));
                node.dispatchEvent(new PointerEvent('pointerup', opts));
                node.dispatchEvent(new MouseEvent('mouseup', opts));
                node.click();

                for (const k of Object.keys(node)) {
                    if (k.startsWith('__reactProps$') || k.startsWith('__reactEventHandlers$')) {
                        if (node[k] && typeof node[k].onClick === 'function') {
                            node[k].onClick({ target: node, currentTarget: node, preventDefault() {}, stopPropagation() {} });
                        }
                    }
                }
            } catch (e) {}
        };

        const btn = (el.closest && el.closest('button, [role="button"]')) || el;
        fire(btn);
        if (btn !== el) fire(el);
    };

    const BATCH_TEXTS = ['全部允许一次', '全部允许', '始终允许', 'Allow all once', 'Allow all'];
    const SINGLE_TEXTS = ['允许', '允许一次', '批准', 'Allow', 'Approve'];

    const cooldownMap = new WeakMap();
    let lastGlobalClick = 0;

    const scan = () => {
        if (isTop) updateBadge();
        if (!isEnabled) return;

        const now = Date.now();
        if (now - lastGlobalClick < 500) return;

        const elements = getAllElementsDeep();
        let batchBtn = null;
        let singleBtn = null;

        for (const el of elements) {
            if (el.id === 'muse-tm-badge-v63' || (el.closest && el.closest('#muse-tm-badge-v63'))) continue;

            const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
            if (!text || text.length > 15) continue;
            if (text.includes('拒绝') || text.includes('取消') || text.includes('Deny')) continue;

            const target = (el.closest && el.closest('button, [role="button"]')) || el;
            const rect = target.getBoundingClientRect();
            if (rect.width < 15 || rect.height < 12 || rect.width > 300 || rect.height > 100) continue;

            const style = win.getComputedStyle(target);
            if (style.display === 'none' || style.visibility === 'hidden' || parseFloat(style.opacity) < 0.1) continue;

            const lastClick = cooldownMap.get(target) || 0;
            if (now - lastClick < 1500) continue;

            if (BATCH_TEXTS.includes(text)) {
                batchBtn = { target, text };
                break;
            }

            if (!singleBtn && SINGLE_TEXTS.includes(text)) {
                singleBtn = { target, text };
            }
        }

        const chosen = batchBtn || singleBtn;
        if (chosen) {
            lastGlobalClick = now;
            cooldownMap.set(chosen.target, now);
            realClick(chosen.target);

            if (isTop) {
                approveCount++;
                try { localStorage.setItem(STORAGE_KEY_COUNT, String(approveCount)); } catch (e) {}
                updateBadge();
            } else {
                try { win.top.postMessage('MUSE_TM_CLICKED', '*'); } catch (e) {}
            }
        }
    };

    setInterval(scan, 350);
})();
