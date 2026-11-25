// ==UserScript==
// @name         Muse 自动审批 (经典穿透 + 迷你拖拽融合版)
// @namespace    https://github.com/waw666waw666/MuseAutoApprove
// @version      7.2.0
// @description  协议优先自动审批：RPC优先、保守降级、无鼠标模拟，带请求超时与暂停调度
// @author       waw666waw666
// @match        *://muse.ai/*
// @match        *://*.muse.ai/*
// @run-at       document-start
// @grant        none
// @license      MIT
// @updateURL    https://raw.githubusercontent.com/waw666waw666/MuseAutoApprove/main/muse-auto-approve.user.js
// @downloadURL  https://raw.githubusercontent.com/waw666waw666/MuseAutoApprove/main/muse-auto-approve.user.js
// ==/UserScript==

(function () {
    'use strict';

    // 免责声明：本脚本仅用于个人工作流自动化提效研究，因自动化操作引发的账号封禁、限制或数据变动等风险均由使用者自行承担。
    const VERSION = '7.2.0';
    const TAG = '[Muse自动审批]';
    const win = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
    const doc = win.document || document;

    // 1. 严格域名拦截：仅允许 muse.ai 及其子域名，绝不误伤任何第三方站点
    const hostname = (win.location && win.location.hostname ? win.location.hostname : '').toLowerCase();
    if (hostname !== 'muse.ai' && !hostname.endsWith('.muse.ai')) {
        return;
    }

    const isTop = (() => {
        try { return win.self === win.top; } catch (e) { return false; }
    })();

    // 2. 全局跨实例共享状态与代际号（防止重复注入或热重载导致并发重批）
    const G = (win.__museAutoApproveGlobal = win.__museAutoApproveGlobal || {
        gen: 0,
        activeTeardown: null,
        shadowRefs: new Set(),
        onShadowAttached: null,
        // RPC 共享状态（第一引擎）
        ctx: null,
        scanAt: 0,
        scanRes: null,
        rpcReady: false,
        rpcStatusReason: '正在连接审批协议通道...',
        rpcLastError: null,        // { category, reason, raw, at, count, nextRetryMs }
        inFlight: new Map(),       // 正在请求审批的 approval_id -> 开始时间（发请求前占坑防重；v7.2.0 起带时间戳供清道夫回收）
        seen: new Map(),           // 已批准的 approval_id -> timestamp
        failState: new Map(),      // approval_id -> { count, nextTryAt }
        pendingVerify: new Map(),  // v7.2.0 对账中：approval_id -> { at, title, decision, uncertain }
        domSkipLog: [],            // v7.2.0 漏批原因：{ text, reason, at }（最近 30 条）
        lastRpcApproveAt: 0,
        rpcLog: [],
        domLog: [],
        bannerShown: false,
    });

    // 与旧版共享全局对象时也补齐连接中状态字段。
    if (typeof G.rpcConnecting !== 'boolean') G.rpcConnecting = false;
    if (typeof G.rpcConnectingSince !== 'number') G.rpcConnectingSince = 0;
    if (typeof G.rpcReconnectAttempts !== 'number') G.rpcReconnectAttempts = 0;
    if (typeof G.rpcMissingSince !== 'number') G.rpcMissingSince = 0;
    if (typeof G.rpcUncertainUntil !== 'number') G.rpcUncertainUntil = 0;
    if (!(G.pendingVerify instanceof Map)) G.pendingVerify = new Map();
    if (!Array.isArray(G.domSkipLog)) G.domSkipLog = [];
    // v7.2.0：inFlight 升级为带时间戳的 Map；老实例遗留的 Set 在此迁移
    if (G.inFlight && !(G.inFlight instanceof Map) && typeof G.inFlight.forEach === 'function') {
        const migrated = new Map();
        G.inFlight.forEach((id) => migrated.set(id, Date.now()));
        G.inFlight = migrated;
    }

    // 若旧实例仍在运行，优雅清理旧实例自己的句柄（不破坏新实例）
    if (typeof G.activeTeardown === 'function') {
        try { G.activeTeardown(); } catch (e) {}
    }
    const myGen = ++G.gen;
    let shadowHookOriginal = null;
    let shadowHookPatched = null;
    let shadowAttachedHook = null;
    const previousShadowAttachedHook = G.onShadowAttached;

    // 3. 捕获后续 ShadowRoot 引用，但保留页面声明的 open/closed 模式。
    const elemProto = win.Element && win.Element.prototype;
    if (elemProto && typeof elemProto.attachShadow === 'function' && !elemProto.attachShadow.__museAAHooked) {
        const origAttachShadow = elemProto.attachShadow;
        const patchedAttachShadow = function (init) {
            const root = origAttachShadow.call(this, init);
            try {
                G.shadowRefs.add(typeof WeakRef !== 'undefined' ? new WeakRef(root) : root);
                if (typeof G.onShadowAttached === 'function') G.onShadowAttached(root);
            } catch (e) {}
            return root;
        };
        patchedAttachShadow.__museAAHooked = true;
        patchedAttachShadow.__museAAOwnerGen = myGen;
        shadowHookOriginal = origAttachShadow;
        shadowHookPatched = patchedAttachShadow;
        elemProto.attachShadow = patchedAttachShadow;
    }

    // 4. 配置持久化与 v6.3/v6.4 旧版平滑迁移
    const STORAGE_KEY = 'muse_auto_approve_v7';
    const LEGACY_KEYS = {
        enabled: 'muse_tm_enabled_v63',
        count: 'muse_tm_count_v63',
        pos: 'muse_tm_pos_v63',
        rpcCfg: 'musePermCfg',
    };

    const loadState = () => {
        const defaults = {
            enabled: true,
            count: 0,
            rpcCount: 0,
            domCount: 0,
            lastRpcApprovedAt: 0,
            lastRpcApprovedLabel: '',
            pos: null,
            decision: 'allow_always',
            rpcIntervalMs: 1200,
            domIntervalMs: 1200,
        };
        try {
            const raw = win.localStorage.getItem(STORAGE_KEY);
            if (raw) {
                const parsed = JSON.parse(raw);
                if (parsed && typeof parsed === 'object') {
                    return { ...defaults, ...parsed };
                }
            }
            // 平滑迁移旧版状态、计数与胶囊位置
            const oldEnabled = win.localStorage.getItem(LEGACY_KEYS.enabled);
            if (oldEnabled === 'false') defaults.enabled = false;
            const oldCount = parseInt(win.localStorage.getItem(LEGACY_KEYS.count) || '0', 10);
            if (Number.isFinite(oldCount) && oldCount > 0) defaults.count = oldCount;
            const oldPos = win.localStorage.getItem(LEGACY_KEYS.pos);
            if (oldPos) {
                const p = JSON.parse(oldPos);
                if (p && typeof p.left === 'number' && typeof p.top === 'number') defaults.pos = p;
            }
            const oldRpc = win.localStorage.getItem(LEGACY_KEYS.rpcCfg);
            if (oldRpc) {
                const rc = JSON.parse(oldRpc);
                if (rc && typeof rc.autoStartDecision === 'string') defaults.decision = rc.autoStartDecision;
            }
            win.localStorage.setItem(STORAGE_KEY, JSON.stringify(defaults));
        } catch (e) {}
        return defaults;
    };

    const state = loadState();
    const clampInterval = (value, fallback, min, max) => {
        const n = Number(value);
        return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
    };
    state.rpcIntervalMs = clampInterval(state.rpcIntervalMs, 1200, 900, 30000);
    state.domIntervalMs = clampInterval(state.domIntervalMs, 1200, 800, 10000);
    let lastActionSummary = '待命中，自动监控审批';

    const saveState = () => {
        try {
            win.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
        } catch (e) {}
    };

    const isAllowedOrigin = (origin) => {
        if (!origin || origin === 'null') return false;
        if (origin === win.location.origin) return true;
        try {
            const h = new URL(origin).hostname.toLowerCase();
            return h === 'muse.ai' || h.endsWith('.muse.ai');
        } catch (e) {
            return false;
        }
    };

    // 本实例持有的全部句柄（退出时只清理自己，绝不误杀新实例）
    const owned = {
        rpcTimer: null,
        rpcWakeTimer: null,
        domTimer: null,
        domThrottleTimer: null,
        domDeferTimer: null,
        domVerifyTimers: new Set(),
        toastTimer: null,
        detailHideTimer: null,
        observers: new Set(),
        observedRoots: new Set(),
        destroyed: false,
    };

    const isActiveGen = () => !owned.destroyed && myGen === G.gen;

    // 5. 悬浮胶囊 UI（100% 恢复 v6.4.1 原版迷你胶囊样式 + 悬停详情面板 + 仅出错弹出提示）
    const BADGE_ID = 'muse-aa-badge-v7';
    const DETAIL_ID = 'muse-aa-detail-v7';
    const TOAST_ID = 'muse-aa-toast-v7';
    let badgeRefs = null;
    let detailPanel = null;
    let toastEl = null;
    let legacyCleaned = false;

    const cleanupLegacyBadgesOnce = () => {
        if (legacyCleaned || !isTop || !doc.body) return;
        legacyCleaned = true;
        const legacyIds = ['muse-tm-badge-v63', 'muse-tm-badge-v6', '__muse_auto_approve_ball__'];
        for (const id of legacyIds) {
            const old = doc.getElementById(id);
            if (old) old.remove();
        }
    };

    const clampBadgePosition = (badge, left, top) => {
        const w = badge.offsetWidth || 90;
        const h = badge.offsetHeight || 24;
        const maxLeft = Math.max(4, (win.innerWidth || 1024) - w - 4);
        const maxTop = Math.max(4, (win.innerHeight || 768) - h - 4);
        return {
            left: Math.min(Math.max(4, left), maxLeft),
            top: Math.min(Math.max(4, top), maxTop),
        };
    };

    const formatClockTime = (ts) => {
        if (!ts || !Number.isFinite(ts)) return '';
        const d = new Date(ts);
        const pad = (n) => String(n).padStart(2, '0');
        return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    };

    const positionFloatingBelowBadge = (el, widthHint = 230, heightHint = 110) => {
        if (!el || !badgeRefs || !badgeRefs.el || !badgeRefs.el.isConnected) return;
        const rect = badgeRefs.el.getBoundingClientRect();
        const vw = win.innerWidth || 1024;
        const vh = win.innerHeight || 768;
        const w = el.offsetWidth || widthHint;
        const h = el.offsetHeight || heightHint;

        let left = rect.right - w;
        if (left < 6) left = Math.max(6, rect.left);
        if (left + w > vw - 6) left = Math.max(6, vw - w - 6);

        let top = rect.bottom + 6;
        if (top + h > vh - 6) {
            top = Math.max(6, rect.top - h - 6);
        }
        el.style.left = Math.round(left) + 'px';
        el.style.top = Math.round(top) + 'px';
        el.style.right = 'auto';
        el.style.bottom = 'auto';
    };

    const hideDetailPanel = () => {
        if (owned.detailHideTimer) {
            clearTimeout(owned.detailHideTimer);
            owned.detailHideTimer = null;
        }
        if (detailPanel && detailPanel.isConnected) {
            detailPanel.style.display = 'none';
        }
    };

    const scheduleHideDetailPanel = () => {
        if (owned.detailHideTimer) clearTimeout(owned.detailHideTimer);
        owned.detailHideTimer = setTimeout(() => {
            owned.detailHideTimer = null;
            hideDetailPanel();
        }, 180);
    };

    const updateDetailPanelContent = () => {
        if (!detailPanel || !isTop) return;
        const on = state.enabled;
        const rpcOnline = !!G.rpcReady;
        const lastRpcClock = formatClockTime(state.lastRpcApprovedAt);
        const lastRpcLine = lastRpcClock
            ? `${lastRpcClock}${state.lastRpcApprovedLabel ? ' · ' + state.lastRpcApprovedLabel : ''}`
            : '暂无';

        const rows = [
            `Muse 自动审批 v${VERSION}（${on ? '运行中' : '已暂停'}）`,
            `协议状态：${G.rpcConnecting ? '连接中（等待协议恢复，暂不点击页面）' : (rpcOnline ? '已连接（第一引擎主动查单）' : '未连接（页面兜底中）')}`,
            `最近协议批单：${lastRpcLine}`,
            `累计批掉：${state.count} 次（协议 ${state.rpcCount} / 兜底 ${state.domCount}）`,
            `最近动作：${lastActionSummary}`,
        ];
        if (!rpcOnline && G.rpcStatusReason) {
            rows.push(`失败原因：${G.rpcStatusReason}`);
        }
        rows.push('按住拖动 · 左键开关 · 右键清零');

        detailPanel.textContent = '';
        for (let i = 0; i < rows.length; i++) {
            const line = doc.createElement('div');
            line.textContent = rows[i];
            if (i === 0) {
                line.style.cssText = 'font-weight:600;color:#ecfdf5;margin-bottom:4px;padding-bottom:4px;border-bottom:1px solid rgba(255,255,255,0.12);';
            } else if (rows[i].startsWith('失败原因：')) {
                line.style.cssText = 'color:#fde68a;margin-top:2px;word-break:break-word;';
            } else if (i === rows.length - 1) {
                line.style.cssText = 'color:rgba(209,213,219,0.75);font-size:10px;margin-top:5px;padding-top:4px;border-top:1px solid rgba(255,255,255,0.1);';
            } else {
                line.style.cssText = 'color:rgba(243,244,246,0.92);margin-top:2px;word-break:break-word;';
            }
            detailPanel.appendChild(line);
        }
    };

    const showDetailPanel = () => {
        if (!isTop || !doc.body || !isActiveGen()) return;
        if (owned.detailHideTimer) {
            clearTimeout(owned.detailHideTimer);
            owned.detailHideTimer = null;
        }
        if (!detailPanel || !detailPanel.isConnected) {
            const old = doc.getElementById(DETAIL_ID);
            if (old) old.remove();
            detailPanel = doc.createElement('div');
            detailPanel.id = DETAIL_ID;
            detailPanel.setAttribute('data-muse-aa-ui', '1');
            detailPanel.style.cssText = [
                'position:fixed',
                'z-index:2147483647',
                'min-width:210px',
                'max-width:280px',
                'padding:8px 10px',
                'border-radius:10px',
                'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif',
                'font-size:11px',
                'line-height:1.45',
                'color:#fff',
                'background:rgba(17,24,39,0.92)',
                'border:1px solid rgba(167,243,208,0.28)',
                'box-shadow:0 4px 14px rgba(0,0,0,0.38)',
                'backdrop-filter:blur(8px)',
                'user-select:none',
                'display:none',
            ].join(';');
            detailPanel.addEventListener('pointerenter', () => {
                if (owned.detailHideTimer) {
                    clearTimeout(owned.detailHideTimer);
                    owned.detailHideTimer = null;
                }
            });
            detailPanel.addEventListener('pointerleave', scheduleHideDetailPanel);
            doc.body.appendChild(detailPanel);
        }
        updateDetailPanelContent();
        detailPanel.style.display = 'block';
        positionFloatingBelowBadge(detailPanel, 240, 128);
    };

    let toastLastKey = '';
    let toastLastAt = 0;

    const clearErrorToast = (resetDedupe = false) => {
        if (owned.toastTimer) {
            clearTimeout(owned.toastTimer);
            owned.toastTimer = null;
        }
        if (toastEl && toastEl.isConnected) {
            toastEl.remove();
        }
        toastEl = null;
        if (resetDedupe) {
            toastLastKey = '';
            toastLastAt = 0;
        }
    };

    // 平时完全安静，只有协议线或兜底线出错时才弹出简短提示，几秒后自动消失（同错 30s 内不重复打扰）
    const showErrorToast = (lineName, reason, durationMs = 4500) => {
        if (!isTop || !doc.body || !isActiveGen() || !state.enabled) return;
        const text = `[${lineName}] ${String(reason || '执行出错')}`;
        const now = Date.now();
        if (text === toastLastKey && now - toastLastAt < 30000) return;
        toastLastKey = text;
        toastLastAt = now;

        clearErrorToast(false);
        const old = doc.getElementById(TOAST_ID);
        if (old) old.remove();

        const el = doc.createElement('div');
        el.id = TOAST_ID;
        el.setAttribute('data-muse-aa-ui', '1');
        el.style.cssText = [
            'position:fixed',
            'z-index:2147483647',
            'max-width:290px',
            'padding:5px 10px',
            'border-radius:10px',
            'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif',
            'font-size:11px',
            'font-weight:500',
            'line-height:1.35',
            'color:#fef2f2',
            'background:rgba(127,29,29,0.92)',
            'border:1px solid rgba(252,165,165,0.38)',
            'box-shadow:0 2px 10px rgba(0,0,0,0.35)',
            'backdrop-filter:blur(6px)',
            'pointer-events:none',
            'word-break:break-word',
        ].join(';');
        el.textContent = text.length > 140 ? text.slice(0, 137) + '...' : text;
        doc.body.appendChild(el);
        toastEl = el;

        if (badgeRefs && badgeRefs.el && badgeRefs.el.isConnected) {
            positionFloatingBelowBadge(el, 240, 42);
        } else {
            el.style.top = '48px';
            el.style.right = '16px';
        }

        owned.toastTimer = setTimeout(() => {
            owned.toastTimer = null;
            if (toastEl === el && el.isConnected) {
                el.remove();
                toastEl = null;
            }
        }, durationMs);
    };

    const ensureBadge = () => {
        if (!isTop || !doc.body || !isActiveGen()) return null;
        cleanupLegacyBadgesOnce();

        if (badgeRefs && badgeRefs.el && badgeRefs.el.isConnected) {
            return badgeRefs;
        }

        let badge = doc.getElementById(BADGE_ID);
        if (badge) badge.remove();

        // 严格复刻 v6.4.1 (ef67355) 原版迷你胶囊样式：尺寸、圆角、内边距、字号、不折行
        badge = doc.createElement('div');
        badge.id = BADGE_ID;
        badge.setAttribute('data-muse-aa-ui', '1');
        badge.style.cssText = [
            'position:fixed',
            'z-index:2147483647',
            'display:inline-flex',
            'align-items:center',
            'gap:5px',
            'padding:3px 9px',
            'border-radius:999px',
            'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif',
            'font-size:11px',
            'font-weight:600',
            'line-height:1.2',
            'white-space:nowrap',
            'color:#fff',
            'cursor:grab',
            'user-select:none',
            'box-shadow:0 2px 8px rgba(0,0,0,0.35)',
            'backdrop-filter:blur(6px)',
            'transition:background 0.2s ease,opacity 0.2s ease',
            'opacity:0.9',
        ].join(';');

        if (state.pos && typeof state.pos.left === 'number' && typeof state.pos.top === 'number') {
            const p = clampBadgePosition(badge, state.pos.left, state.pos.top);
            badge.style.left = p.left + 'px';
            badge.style.top = p.top + 'px';
        } else {
            badge.style.top = '16px';
            badge.style.right = '16px';
        }

        const dotEl = doc.createElement('span');
        dotEl.style.cssText = 'width:6px;height:6px;border-radius:50%;flex-shrink:0;';

        const labelEl = doc.createElement('span');

        const countEl = doc.createElement('span');
        countEl.style.cssText = 'background:rgba(0,0,0,0.22);padding:1px 5px;border-radius:999px;font-size:10px;';

        badge.appendChild(dotEl);
        badge.appendChild(labelEl);
        badge.appendChild(countEl);

        // 拖拽与左键开关 / 右键清零 / 悬停展开详情
        let isDragging = false;
        let hasMoved = false;
        let startX = 0, startY = 0, initLeft = 0, initTop = 0;

        badge.addEventListener('pointerenter', () => {
            if (!isDragging) showDetailPanel();
        });
        badge.addEventListener('pointerleave', scheduleHideDetailPanel);

        badge.addEventListener('pointerdown', (e) => {
            if (e.button !== 0) return;
            hideDetailPanel();
            isDragging = true;
            hasMoved = false;
            startX = e.clientX;
            startY = e.clientY;
            const rect = badge.getBoundingClientRect();
            initLeft = rect.left;
            initTop = rect.top;
            badge.style.cursor = 'grabbing';
            try { badge.setPointerCapture(e.pointerId); } catch (err) {}
        });

        badge.addEventListener('pointermove', (e) => {
            if (!isDragging) return;
            const dx = e.clientX - startX;
            const dy = e.clientY - startY;
            if (Math.abs(dx) > 3 || Math.abs(dy) > 3) hasMoved = true;
            if (hasMoved) {
                const p = clampBadgePosition(badge, initLeft + dx, initTop + dy);
                badge.style.right = 'auto';
                badge.style.bottom = 'auto';
                badge.style.left = p.left + 'px';
                badge.style.top = p.top + 'px';
            }
        });

        const endDrag = (e) => {
            if (!isDragging) return;
            isDragging = false;
            badge.style.cursor = 'grab';
            try { badge.releasePointerCapture(e.pointerId); } catch (err) {}
            if (hasMoved) {
                const rect = badge.getBoundingClientRect();
                state.pos = { left: Math.round(rect.left), top: Math.round(rect.top) };
                saveState();
            } else {
                setEnabled(!state.enabled);
            }
        };

        badge.addEventListener('pointerup', endDrag);
        badge.addEventListener('pointercancel', () => {
            isDragging = false;
            badge.style.cursor = 'grab';
        });

        badge.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            state.count = 0;
            state.rpcCount = 0;
            state.domCount = 0;
            state.lastRpcApprovedAt = 0;
            state.lastRpcApprovedLabel = '';
            lastActionSummary = '计数已清零';
            saveState();
            renderBadge();
        });

        doc.body.appendChild(badge);
        badgeRefs = { el: badge, dotEl, labelEl, countEl };
        return badgeRefs;
    };

    const renderBadge = () => {
        if (!isTop || !doc.body || !isActiveGen()) return;
        const refs = ensureBadge();
        if (!refs) return;

        const on = state.enabled;
        const rpcOnline = !!G.rpcReady;
        const lastRpcClock = formatClockTime(state.lastRpcApprovedAt);

        // 原版配色（绿 / 灰），小圆点在原版尺寸内指示协议状态（薄荷绿=协议已连，柔琥珀=协议未连兜底中，灰=暂停）
        refs.el.style.background = on
            ? 'linear-gradient(135deg, rgba(16,185,129,0.92), rgba(5,150,105,0.92))'
            : 'linear-gradient(135deg, rgba(75,85,99,0.9), rgba(55,65,81,0.9))';
        refs.el.style.border = on
            ? '1px solid rgba(167, 243, 208, 0.35)'
            : '1px solid rgba(156, 163, 175, 0.25)';

        refs.dotEl.style.background = on ? (rpcOnline ? '#a7f3d0' : (G.rpcConnecting ? '#93c5fd' : '#fde68a')) : '#9ca3af';
        refs.dotEl.style.boxShadow = on
            ? (rpcOnline ? '0 0 4px #a7f3d0' : (G.rpcConnecting ? '0 0 4px #93c5fd' : '0 0 4px #fde68a'))
            : 'none';
        refs.labelEl.textContent = on ? '自动' : '暂停';
        refs.countEl.textContent = String(state.count);

        const rpcStateLine = G.rpcConnecting
            ? '协议连接中（等待恢复，暂不使用页面兜底）'
            : (rpcOnline
                ? '协议已连接（第一引擎主动查单中）'
                : `协议未连接（${G.rpcStatusReason || '等待重连'}；DOM 第二引擎兜底中）`);
        const lastRpcLine = lastRpcClock
            ? `${lastRpcClock}${state.lastRpcApprovedLabel ? ' · ' + state.lastRpcApprovedLabel : ''}`
            : '暂无';

        refs.el.title = [
            `Muse 自动审批 v${VERSION}（协议优先版）`,
            `状态：${on ? '运行中' : '已暂停'} | ${rpcStateLine}`,
            `最近协议批单：${lastRpcLine}`,
            `累计批掉：${state.count} 次（协议 ${state.rpcCount} / 页面兜底 ${state.domCount}）`,
            `最近动作：${lastActionSummary}`,
            '操作：按住拖动 | 左键开关 | 右键清零',
        ].join('\n');

        if (detailPanel && detailPanel.isConnected && detailPanel.style.display !== 'none') {
            updateDetailPanelContent();
        }
    };

    const recordApproved = (source, detailText) => {
        if (!isActiveGen()) return;
        const summary = `${source === 'rpc' ? '协议' : '点控'} · ${detailText || '已放行'}`;
        if (isTop) {
            state.count++;
            if (source === 'rpc') {
                state.rpcCount++;
                state.lastRpcApprovedAt = Date.now();
                state.lastRpcApprovedLabel = detailText || '已放行';
            } else {
                state.domCount++;
            }
            lastActionSummary = summary;
            saveState();
            renderBadge();
        } else {
            try {
                win.top.postMessage({
                    type: 'MUSE_AA_APPROVED',
                    source,
                    detail: detailText || '',
                }, '*');
            } catch (e) {}
        }
    };

    const broadcastEnabledToFrames = (enabled) => {
        if (!isTop) return;
        try {
            const iframes = doc.querySelectorAll('iframe');
            for (const frame of iframes) {
                try {
                    if (frame.contentWindow) {
                        frame.contentWindow.postMessage({ type: 'MUSE_AA_SYNC', enabled }, '*');
                    }
                } catch (e) {}
            }
        } catch (e) {}
    };

    const onWindowMessage = (e) => {
        if (!isActiveGen() || !e || !e.data || typeof e.data !== 'object') return;
        if (!isAllowedOrigin(e.origin)) return;
        if (e.data.type === 'MUSE_AA_APPROVED' && isTop) {
            recordApproved(e.data.source === 'rpc' ? 'rpc' : 'dom', e.data.detail);
        } else if (e.data.type === 'MUSE_AA_SYNC' && !isTop && typeof e.data.enabled === 'boolean') {
            state.enabled = e.data.enabled;
            syncRuntimeEnabled();
        }
    };

    const onStorageSync = (e) => {
        if (!isActiveGen() || !e || e.key !== STORAGE_KEY || !e.newValue) return;
        try {
            const next = JSON.parse(e.newValue);
            if (next && typeof next.enabled === 'boolean') {
                state.enabled = next.enabled;
                syncRuntimeEnabled();
                if (isTop) {
                    if (typeof next.count === 'number') state.count = next.count;
                    if (typeof next.rpcCount === 'number') state.rpcCount = next.rpcCount;
                    if (typeof next.domCount === 'number') state.domCount = next.domCount;
                    if (typeof next.lastRpcApprovedAt === 'number') state.lastRpcApprovedAt = next.lastRpcApprovedAt;
                    if (typeof next.lastRpcApprovedLabel === 'string') state.lastRpcApprovedLabel = next.lastRpcApprovedLabel;
                    renderBadge();
                }
            }
        } catch (err) {}
    };

    const onResize = () => {
        if (!badgeRefs || !badgeRefs.el || !badgeRefs.el.isConnected) return;
        if (badgeRefs.el.style.left) {
            const rect = badgeRefs.el.getBoundingClientRect();
            const p = clampBadgePosition(badgeRefs.el, rect.left, rect.top);
            badgeRefs.el.style.left = p.left + 'px';
            badgeRefs.el.style.top = p.top + 'px';
        }
    };

    // =========================================================================
    // 引擎 A（第一引擎）：协议优先主动轮询引擎（React 18/19 双缓冲提取 + 失败显式归因退避）
    // =========================================================================

    function fiberOf(el) {
        if (!el) return null;
        try {
            for (const k of Object.keys(el)) {
                if (k.startsWith('__reactContainer') || k.startsWith('__reactFiber')) {
                    return el[k];
                }
            }
        } catch (e) {}
        return null;
    }

    function findRootFibers() {
        const roots = [];
        const seen = new Set();
        const pushFromFiber = (f) => {
            if (!f || typeof f !== 'object') return;
            let r = f;
            let steps = 0;
            while (r && r.return && steps++ < 500) r = r.return;
            // React 18 HostRoot.stateNode.current 始终指向最新已提交树，优先扫描防拿到过期双缓冲快照
            if (r && r.stateNode && r.stateNode.current && typeof r.stateNode.current === 'object') {
                const cur = r.stateNode.current;
                if (!seen.has(cur)) {
                    seen.add(cur);
                    roots.push(cur);
                }
            }
            if (r && !seen.has(r)) {
                seen.add(r);
                roots.push(r);
            }
            if (r && r.alternate && typeof r.alternate === 'object' && !seen.has(r.alternate)) {
                seen.add(r.alternate);
                roots.push(r.alternate);
            }
        };

        const sels = ['#__next', '#root', '#app', '[data-reactroot]', 'main', 'body', 'html'];
        for (const sel of sels) {
            const el = doc.querySelector(sel);
            const f = fiberOf(el);
            if (f) pushFromFiber(f);
        }
        if (roots.length) return roots;

        const all = doc.querySelectorAll('*');
        const limit = Math.min(all.length, 2500);
        for (let i = 0; i < limit; i++) {
            const f = fiberOf(all[i]);
            if (f) {
                pushFromFiber(f);
                if (roots.length) return roots;
            }
        }
        return roots;
    }

    function collectFiberContexts() {
        const roots = findRootFibers();
        if (!roots.length) return [];
        const out = [];
        const seen = new Set();
        const stack = [...roots].reverse();
        let guard = 0;
        while (stack.length && guard++ < 200000) {
            const f = stack.pop();
            if (!f || typeof f !== 'object' || seen.has(f)) continue;
            seen.add(f);

            // 路径 1：Consumer dependencies.firstContext 链（避开已重置的 context._currentValue）
            const deps = f.dependencies;
            if (deps && deps.firstContext) {
                let c = deps.firstContext;
                let n = 0;
                while (c && n++ < 200) {
                    if (c.memoizedValue !== undefined) {
                        out.push({ value: c.memoizedValue, source: 'consumer' });
                    }
                    c = c.next;
                }
            }

            // 路径 2：Provider memoizedProps.value（兼容 React 18 Provider 与 React 19 Context 组件）
            const fType = f.type;
            if (fType && typeof fType === 'object' && ('_context' in fType || '_currentValue' in fType)) {
                if (f.memoizedProps && 'value' in f.memoizedProps && f.memoizedProps.value !== undefined) {
                    out.push({ value: f.memoizedProps.value, source: 'provider' });
                }
            }

            if (f.child) stack.push(f.child);
            if (f.sibling) stack.push(f.sibling);
        }
        return out;
    }

    function isRpcCtx(v) {
        if (!v || typeof v !== 'object' || typeof v.sendRequest !== 'function') return false;
        let score = 0;
        if ('gatewayUrl' in v) score++;
        if ('ensureLiveConnection' in v) score++;
        if ('connectionState' in v) score++;
        if ('connectionAuthority' in v) score++;
        if ('isReady' in v) score++;
        return score >= 2;
    }

    function isUsableRpcCtx(v) {
        if (!isRpcCtx(v)) return false;
        if (v.connectionState === 'disconnected' || v.connectionState === 'closed' || v.connectionState === 'error') {
            return false;
        }
        if ('isReady' in v) return v.isReady === true;
        return v.connectionState === 'connected';
    }

    function invalidateRpcCtx({ preserveReady = false } = {}) {
        G.ctx = null;
        G.scanRes = null;
        G.scanAt = 0;
        if (!preserveReady && G.rpcReady) {
            G.rpcReady = false;
            renderBadge();
        }
    }

    // 严格区分“已就绪 context”与“尚未就绪的候选 context”，根治假就绪 Bug
    function findRpcCtx({ allowPending = false } = {}) {
        if (G.ctx) {
            if (isUsableRpcCtx(G.ctx)) return G.ctx;
            G.ctx = null;
        }

        const now = Date.now();
        if (now - G.scanAt < 800) {
            if (isUsableRpcCtx(G.scanRes)) {
                G.ctx = G.scanRes;
                return G.scanRes;
            }
            return allowPending && isRpcCtx(G.scanRes) ? G.scanRes : null;
        }

        const candidates = collectFiberContexts().filter((c) => isRpcCtx(c.value));
        G.scanAt = now;
        if (!candidates.length) {
            G.scanRes = null;
            return null;
        }

        const readyHit = candidates.find((c) => isUsableRpcCtx(c.value));
        if (readyHit) {
            G.ctx = readyHit.value;
            G.scanRes = readyHit.value;
            return readyHit.value;
        }

        const pendingHit =
            candidates.find((c) => c.value.connectionState === 'connected') ||
            candidates.find((c) => c.value.gatewayUrl) ||
            candidates[0];
        G.scanRes = pendingHit.value;
        return allowPending ? pendingHit.value : null;
    }

    function getTargetOpts(ctx) {
        const key = ctx && ctx.connectionAuthority && ctx.connectionAuthority.targetKey;
        return key ? { expectedTargetKey: key } : {};
    }

    function withTimeout(promise, timeoutMs, label) {
        let timer = null;
        const timeout = new Promise((_, reject) => {
            timer = setTimeout(() => {
                const err = new Error(`${label} 超时（${timeoutMs}ms）`);
                err.code = 'RPC_TIMEOUT';
                reject(err);
            }, timeoutMs);
        });
        return Promise.race([Promise.resolve(promise), timeout]).finally(() => {
            if (timer) clearTimeout(timer);
        });
    }

    async function rpcCall(method, payload, opts) {
        let ctx = findRpcCtx({ allowPending: true });
        if (!ctx) {
            throw new Error('未找到 HatchRpc context（页面可能尚未连接 VM）');
        }
        if (!isUsableRpcCtx(ctx)) {
            if (typeof ctx.ensureLiveConnection === 'function') {
                await withTimeout(Promise.resolve().then(() => ctx.ensureLiveConnection()), 6000, 'ensureLiveConnection');
            }
            const refreshed = findRpcCtx({ allowPending: true });
            if (refreshed) ctx = refreshed;
        }
        if (!isUsableRpcCtx(ctx)) {
            throw new Error('HatchRpc is not ready');
        }
        const finalOpts = { ...getTargetOpts(ctx), ...(opts || {}) };
        const timeoutMs = method === 'egress.approval.decide' ? 12000 : 8000;
        return withTimeout(
            Promise.resolve().then(() => ctx.sendRequest(method, payload ?? {}, finalOpts)),
            timeoutMs,
            method
        );
    }

    function isConnectionError(err) {
        const msg = (err && err.message) ? err.message : String(err || '');
        return /not ready|not connected|disconnected|socket|closed|timeout|target|network|reconnect|未找到/i.test(msg);
    }

    function isAuthError(err) {
        const msg = (err && err.message) ? err.message : String(err || '');
        return /\b(401|403)\b|unauthorized|unauthenticated|forbidden|permission denied|not authorized|no permission|access denied|auth/i.test(msg);
    }

    function isDecisionRejectedError(err) {
        const msg = (err && err.message) ? err.message : String(err || '');
        if (isConnectionError(err)) return false;
        return /decision|allow_always|not allowed|unsupported|invalid|forbidden|cannot|only|400|bad request|disallowed|policy/i.test(msg);
    }

    function isDecisionUnsupportedError(err) {
        if (!err || isConnectionError(err) || isAuthError(err)) return false;
        const msg = (err.message || String(err)).toLowerCase();
        return /unsupported decision|decision (is )?not supported|invalid decision|allow_always (is )?not supported|allow_always not allowed|永久允许.*不支持|不支持.*永久允许|不支持.*decision|不支持.*档位/i.test(msg);
    }

    function isRpcResultRejected(res) {
        if (!res || typeof res !== 'object') return false;
        if (res.ok === false || res.success === false || res.accepted === false) return true;
        if (typeof res.error === 'string' && res.error) return true;
        if (res.error && typeof res.error === 'object' && res.error.message) return true;
        return false;
    }

    function pendingOf(r) {
        if (Array.isArray(r)) return r;
        if (!r || typeof r !== 'object') return [];
        const inner = (r.data && typeof r.data === 'object')
            ? r.data
            : ((r.result && typeof r.result === 'object') ? r.result : r);
        if (Array.isArray(inner)) return inner;
        const c = inner.pending_approvals
            ?? inner.pendingApprovals
            ?? (inner.approvals && inner.approvals.pending)
            ?? (Array.isArray(inner.approvals) ? inner.approvals : null)
            ?? inner.pending
            ?? inner.items
            ?? [];
        return Array.isArray(c) ? c : [];
    }

    const idOf = (a) => (a && (a.approval_id ?? a.approvalId ?? a.id)) || null;
    const titleOf = (a) => (a && (a.title ?? a.request_name ?? a.summary ?? a.method ?? a.connector)) || '';

    // 档位选择链：严格优先永久/全部允许，服务端不允许时自动降级到单次允许
    function buildDecisionChain(approval, preferred = 'allow_always') {
        const priority = ['allow_always', 'allow_once', 'allow'];
        const pref = priority.includes(preferred) ? preferred : 'allow_always';
        const fallbackOrder = priority.slice(priority.indexOf(pref));

        const rawOpts = approval && (
            approval.allowed_decisions ||
            approval.allowedDecisions ||
            approval.decision_options ||
            approval.decisions ||
            approval.mode_options
        );

        if (Array.isArray(rawOpts) && rawOpts.length) {
            const norm = rawOpts
                .map((x) => (typeof x === 'string' ? x : (x && (x.value || x.decision || x.id))))
                .filter((x) => typeof x === 'string');
            if (norm.length) {
                const aliases = { always_allow: 'allow_always', allow_all: 'allow_always', approve: 'allow' };
                const supported = new Set(norm.map((x) => aliases[x] || x));
                const maxIndex = priority.indexOf(pref);
                const matched = priority.slice(Math.max(0, maxIndex)).filter((p) => supported.has(p));
                return matched;
            }
        }
        return [...new Set(fallbackOrder)];
    }

    async function decideRaw(approvalId, decision = 'allow_always', opts = {}) {
        if (!approvalId) throw new Error('缺少 approvalId');
        const payload = { approval_id: approvalId, decision };
        if (opts.alwaysScope) {
            payload.always_scope = opts.alwaysScope;
            if (decision === 'allow_always') payload.allow_always_scope = opts.alwaysScope;
        }
        if (opts.reason) payload.reason = opts.reason;
        const res = await rpcCall('egress.approval.decide', payload);
        if (isRpcResultRejected(res)) {
            const errMsg = (res.error && res.error.message) || res.error || res.message || `decision ${decision} rejected`;
            throw new Error(String(errMsg));
        }
        return res;
    }

    async function decideSmart(approval, preferred = state.decision, opts = {}) {
        const approvalId = typeof approval === 'string' ? approval : idOf(approval);
        const chain = buildDecisionChain(typeof approval === 'string' ? null : approval, preferred);
        if (!approvalId) throw new Error('缺少 approvalId');
        if (!chain.length) throw new Error('服务端未提供可用的审批档位，未发送审批请求');

        let lastErr = null;
        for (let i = 0; i < chain.length; i++) {
            const decision = chain[i];
            try {
                const res = await decideRaw(approvalId, decision, opts);
                return { ok: true, decision, res };
            } catch (e) {
                lastErr = e;
                // 传输失败/超时可能是“服务端已处理但响应丢失”：不盲目重放，交给下一轮查询协调。
                if (isConnectionError(e)) {
                    invalidateRpcCtx();
                    throw e;
                }
                // 只在服务端明确表示当前档位不支持时，才尝试更窄权限档位。
                const hasNext = i + 1 < chain.length;
                if (hasNext && isDecisionUnsupportedError(e)) {
                    continue;
                }
                throw e;
            }
        }
        throw lastErr || new Error('审批应答失败');
    }

    // v7.2.0 漏批原因记录（同文本同原因 5 秒内只记一次，防刷屏）
    function noteDomSkip(text, reason) {
        if (!Array.isArray(G.domSkipLog)) G.domSkipLog = [];
        const now = Date.now();
        const last = G.domSkipLog[G.domSkipLog.length - 1];
        if (last && last.text === text && last.reason === reason && now - last.at < 5000) return;
        G.domSkipLog.push({ text: String(text || '').slice(0, 40), reason, at: now });
        if (G.domSkipLog.length > 30) G.domSkipLog.shift();
    }

    // v7.2.0 对账确认：某条已从待批名单消失 = 服务端确实处理了，这时才计数
    function confirmVerified(id, entry) {
        G.pendingVerify.delete(id);
        G.failState.delete(id);
        G.seen.set(id, Date.now());
        G.lastRpcApproveAt = Date.now();
        const tierLabel = entry.decision === 'allow_always'
            ? '永久允许'
            : (entry.decision === 'allow_once' ? '允许一次' : entry.decision);
        G.rpcLog.push({ id, title: entry.title, decision: entry.decision, ok: true, verified: true, at: Date.now() });
        if (G.rpcLog.length > 200) G.rpcLog.shift();
        recordApproved('rpc', `${tierLabel}${entry.title ? ' · ' + entry.title : ''}`);
        console.log(TAG, `✓ [对账确认 ${tierLabel}]`, id, entry.title);
    }

    // v7.2.0 对账：名单里消失=已批成；超时仍在名单上=没批成，解除占位交退避重试
    function reconcileVerify(activeIds) {
        if (!G.pendingVerify || G.pendingVerify.size === 0) return;
        const now = Date.now();
        for (const [id, entry] of [...G.pendingVerify]) {
            if (!activeIds.has(id)) { confirmVerified(id, entry); continue; }
            const deadline = entry.uncertain ? 10000 : 20000;
            if (now - entry.at > deadline) {
                G.pendingVerify.delete(id);
                G.seen.delete(id);
                const prev = G.failState.get(id) || { count: 0, nextTryAt: 0 };
                G.failState.set(id, { count: prev.count, nextTryAt: Math.max(prev.nextTryAt, now + 2000) });
                G.rpcLog.push({ id, title: entry.title, ok: false, error: '对账未通过：批单后仍在待批名单', at: now });
                if (G.rpcLog.length > 200) G.rpcLog.shift();
                console.warn(TAG, '⚠ [对账未通过，稍后重试]', id, entry.title);
            }
        }
    }

    let rpcTickRunning = false;
    let rpcConsecutiveFails = 0;
    let rpcLastLogKey = '';
    let rpcLastLogAt = 0;
    let rpcSameErrCount = 0;
    let lastEnsureConnAt = 0;

    function nextRpcBackoffMs(failCount) {
        // 协议失败退避：1.5s -> 3s -> 6s -> 12s -> 24s -> 上限 30s，自动重试不刷屏
        const exp = Math.min(Math.max(0, failCount - 1), 5);
        return Math.min(1500 * Math.pow(2, exp), 30000);
    }

    function reportRpcFailure(category, rawError, nextRetryMs) {
        const raw = (rawError && rawError.message) ? rawError.message : String(rawError || category);
        const now = Date.now();
        const logKey = `${category}|${raw}`;
        if (logKey === rpcLastLogKey) {
            rpcSameErrCount++;
        } else {
            rpcLastLogKey = logKey;
            rpcSameErrCount = 1;
        }

        const reason = raw && raw !== category ? `${category}：${raw}` : category;
        G.rpcStatusReason = reason;
        G.rpcLastError = {
            category,
            reason,
            raw,
            at: now,
            count: rpcSameErrCount,
            nextRetryMs,
        };

        G.rpcLog.push({ type: 'rpc-error', category, error: raw, count: rpcSameErrCount, nextRetryMs, at: now });
        if (G.rpcLog.length > 200) G.rpcLog.shift();

        // 首次出现、原因变化、或间隔足够长时打印，绝不静默装死，也不刷屏
        const shouldLog = rpcSameErrCount === 1 || rpcSameErrCount === 3 || (now - rpcLastLogAt >= 30000);
        if (shouldLog) {
            rpcLastLogAt = now;
            const retrySec = Math.max(1, Math.round(nextRetryMs / 1000));
            console.warn(
                TAG,
                `⚠ [协议线异常 #${rpcSameErrCount}] ${reason}（${retrySec}s 后自动重试，期间 DOM 第二引擎兜底）`
            );
            showErrorToast('协议线', reason);
        }
        renderBadge();
    }

    function markRpcHealthy() {
        const wasOffline = !G.rpcReady || rpcConsecutiveFails > 0;
        rpcConsecutiveFails = 0;
        G.rpcConnecting = false;
        G.rpcConnectingSince = 0;
        G.rpcReconnectAttempts = 0;
        G.rpcMissingSince = 0;
        rpcLastLogKey = '';
        rpcSameErrCount = 0;
        G.rpcLastError = null;
        G.rpcStatusReason = '已连接';
        clearErrorToast(true);
        if (!G.rpcReady) {
            G.rpcReady = true;
            renderBadge();
        }
        if (wasOffline) {
            console.log(TAG, '✓ [协议线已连接] 第一引擎主动轮询 egress.approvals 中');
        }
    }

    function pruneRpcMaps(activeIds) {
        const now = Date.now();
        for (const [id, ts] of G.seen.entries()) {
            if (!activeIds.has(id) && now - ts > 600000) G.seen.delete(id);
        }
        for (const id of G.failState.keys()) {
            if (!activeIds.has(id)) G.failState.delete(id);
        }
    }

    async function rpcTick() {
        if (!isTop || !isActiveGen() || rpcTickRunning) return;
        rpcTickRunning = true;
        let nextDelay = state.rpcIntervalMs || 1200;

        try {
            if (!state.enabled) {
                nextDelay = 1500;
                return;
            }

            // 第一步：获取真正就绪的协议通道（无 DOM 卡也独立持续查询）
            let readyCtx = findRpcCtx({ allowPending: false });
            if (readyCtx) {
                G.rpcConnecting = false;
                G.rpcConnectingSince = 0;
                G.rpcReconnectAttempts = 0;
                G.rpcMissingSince = 0;
            }
            if (!readyCtx) {
                const pendingCtx = findRpcCtx({ allowPending: true });
                const now = Date.now();
                if (!pendingCtx) {
                    if (!G.rpcMissingSince) G.rpcMissingSince = now;
                    const missingFor = now - G.rpcMissingSince;
                    if (missingFor < 5000) {
                        // React/工作区短暂卸载或尚未挂载时，先重扫，不立即误切到页面点击。
                        G.rpcConnecting = true;
                        G.rpcStatusReason = `等待 HatchRpc 上下文挂载（${Math.ceil((5000 - missingFor) / 1000)} 秒宽限）`;
                        nextDelay = 1000;
                        renderBadge();
                        return;
                    }
                } else {
                    G.rpcMissingSince = 0;
                }
                const connectionState = String((pendingCtx && pendingCtx.connectionState) || '').toLowerCase();
                const isConnecting = connectionState === 'connecting' || connectionState === 'reconnecting';

                // isReady=false 且 connectionState=connecting 是握手过程，不是断线；先等 15 秒，再有限次数主动拉活。
                if (isConnecting) {
                    if (!G.rpcConnectingSince) {
                        G.rpcConnectingSince = now;
                        G.rpcReconnectAttempts = 0;
                    }
                    const waited = now - G.rpcConnectingSince;
                    if (waited < 15000) {
                        G.rpcConnecting = true;
                        G.rpcStatusReason = '协议通道连接中，等待握手完成';
                        nextDelay = 1000;
                        renderBadge();
                        return;
                    }

                    if (pendingCtx && typeof pendingCtx.ensureLiveConnection === 'function' &&
                        G.rpcReconnectAttempts < 2 && now - lastEnsureConnAt >= 5000) {
                        G.rpcReconnectAttempts++;
                        lastEnsureConnAt = now;
                        G.rpcConnecting = true;
                        G.rpcStatusReason = `协议握手超时，尝试恢复 ${G.rpcReconnectAttempts}/2`;
                        nextDelay = 1000;
                        renderBadge();
                        let wakeTimer = null;
                        try {
                            await Promise.race([
                                Promise.resolve().then(() => pendingCtx.ensureLiveConnection()),
                                new Promise((_, reject) => {
                                    wakeTimer = setTimeout(() => {
                                        const err = new Error('ensureLiveConnection 等待超时');
                                        err.code = 'RPC_TIMEOUT';
                                        reject(err);
                                    }, 4000);
                                }),
                            ]);
                        } catch (wakeErr) {
                            console.warn(TAG, `协议恢复尝试 ${G.rpcReconnectAttempts}/2 未完成：`, wakeErr);
                            if (wakeErr && wakeErr.code === 'RPC_TIMEOUT') nextDelay = Math.max(nextDelay, 15000);
                        } finally {
                            if (wakeTimer) clearTimeout(wakeTimer);
                        }
                        if (!isActiveGen() || !state.enabled) return;
                        invalidateRpcCtx({ preserveReady: true });
                        G.rpcConnectingSince = Date.now();
                        return;
                    }

                    G.rpcConnecting = false;
                    G.rpcReady = false;
                    rpcConsecutiveFails = Math.max(rpcConsecutiveFails, 2);
                    G.rpcStatusReason = '协议通道连接超时';
                    renderBadge();
                } else {
                    G.rpcConnecting = false;
                    G.rpcConnectingSince = 0;
                    G.rpcReconnectAttempts = 0;
                }

                // 若通道处于断开/休眠状态，按退避节奏主动调用 ensureLiveConnection() 拉活，但绝不对 connecting 状态盲发请求
                if (pendingCtx && typeof pendingCtx.ensureLiveConnection === 'function') {
                    const st = pendingCtx.connectionState;
                    const shouldWake = (st === 'disconnected' || st === 'closed' || st === 'error') && (now - lastEnsureConnAt >= 5000);
                    if (shouldWake) {
                        lastEnsureConnAt = now;
                        try {
                            await withTimeout(
                                Promise.resolve().then(() => pendingCtx.ensureLiveConnection()),
                                6000,
                                'ensureLiveConnection'
                            );
                            if (!isActiveGen() || !state.enabled) return;
                            invalidateRpcCtx();
                            readyCtx = findRpcCtx({ allowPending: false });
                        } catch (wakeErr) {
                            if (!isActiveGen() || !state.enabled) return;
                            rpcConsecutiveFails++;
                            if (rpcConsecutiveFails >= 2) G.rpcReady = false;
                            nextDelay = nextRpcBackoffMs(rpcConsecutiveFails);
                            if (wakeErr && wakeErr.code === 'RPC_TIMEOUT') nextDelay = Math.max(nextDelay, 15000);
                            reportRpcFailure('连不上', wakeErr, nextDelay);
                            return;
                        }
                    }
                }

                if (!readyCtx) {
                    rpcConsecutiveFails++;
                    if (rpcConsecutiveFails >= 2) G.rpcReady = false;
                    nextDelay = nextRpcBackoffMs(rpcConsecutiveFails);
                    if (!pendingCtx) {
                        reportRpcFailure('连不上', '未找到 HatchRpc 通道（页面未进入工作区或 React 尚未挂载）', nextDelay);
                    } else {
                        const detail = `通道未就绪（isReady=${String(pendingCtx.isReady)}, connectionState=${String(pendingCtx.connectionState || 'unknown')}）`;
                        reportRpcFailure('连不上', detail, nextDelay);
                    }
                    return;
                }
            }

            // 第二步：主动向审批系统查询待批单子（完全不依赖页面出卡或 DOM 扫描）
            const resp = await rpcCall('egress.approvals', {});
            if (!isActiveGen()) return;
            if (!state.enabled) return;
            if (isRpcResultRejected(resp)) {
                const errMsg = (resp.error && resp.error.message) || resp.error || resp.message || 'egress.approvals 返回失败';
                throw new Error(String(errMsg));
            }

            markRpcHealthy();

            const list = pendingOf(resp);
            const activeIds = new Set();
            const now = Date.now();
            let loopCompleted = true;

            // v7.2.0 在飞清道夫：占坑超过 30 秒没释放视为卡死，强制回收，避免一条堵死整条线
            for (const [fid, fat] of [...G.inFlight]) {
                if (now - fat > 30000) {
                    G.inFlight.delete(fid);
                    console.warn(TAG, '⚠ [在飞超时自清]', fid);
                }
            }

            for (const item of list) {
                if (!isActiveGen() || !state.enabled) break;
                const id = idOf(item);
                if (!id) continue;
                activeIds.add(id);

                if (G.seen.has(id) || G.inFlight.has(id)) continue;

                const fs = G.failState.get(id);
                if (fs && now < fs.nextTryAt) continue;

                // 请求发出前立刻占坑，彻底杜绝并发重复批
                G.inFlight.set(id, Date.now());
                const title = titleOf(item);
                try {
                    const out = await decideSmart(item, state.decision);
                    G.seen.set(id, Date.now());
                    G.failState.delete(id);
                    if (!isActiveGen() || !state.enabled) continue;
                    // v7.2.0：批完不立刻计数，先入对账队列；下一轮名单里消失才算真批成（confirmVerified）
                    G.pendingVerify.set(id, { at: Date.now(), title, decision: out.decision, uncertain: false });
                    console.log(TAG, '✓ [协议已批，待对账]', id, title, out.decision);
                } catch (err) {
                    const prev = G.failState.get(id) || { count: 0, nextTryAt: 0 };
                    const count = prev.count + 1;
                    // 单项失败指数退避（2s -> 4s -> 8s -> 16s -> 30s -> 45s），永不永久拉黑
                    const exponentialBackoff = Math.min(2000 * Math.pow(2, Math.min(count - 1, 4)), 45000);
                    const backoff = err && err.code === 'RPC_TIMEOUT' ? Math.max(15000, exponentialBackoff) : exponentialBackoff;
                    G.failState.set(id, { count, nextTryAt: Date.now() + backoff });
                    if (err && err.code === 'RPC_TIMEOUT') {
                        G.rpcUncertainUntil = Math.max(G.rpcUncertainUntil || 0, Date.now() + 20000);
                    }
                    // v7.2.0：连接失败/超时属于「结果不确定」——也许服务端已批；入对账队列，下一轮看名单定性
                    if (isConnectionError(err) || (err && err.code === 'RPC_TIMEOUT')) {
                        if (!G.pendingVerify.has(id)) {
                            G.pendingVerify.set(id, { at: Date.now(), title, decision: state.decision, uncertain: true });
                        }
                    }
                    if (!isActiveGen() || !state.enabled) continue;
                    const msg = (err && err.message) ? err.message : String(err);
                    G.rpcLog.push({ id, title, ok: false, error: msg, count, at: Date.now() });
                    if (G.rpcLog.length > 200) G.rpcLog.shift();
                    if (count <= 2 || count % 5 === 0) {
                        const cat = isAuthError(err) ? '没权限' : (isConnectionError(err) ? '连不上' : '接口报错');
                        console.warn(TAG, `✗ [协议批单失败:${cat} #${count}，${Math.round(backoff / 1000)}s后再试]`, id, msg);
                    }
                    if (isConnectionError(err)) {
                        rpcConsecutiveFails++;
                        invalidateRpcCtx({ preserveReady: rpcConsecutiveFails < 2 });
                        nextDelay = nextRpcBackoffMs(rpcConsecutiveFails);
                        if (err && err.code === 'RPC_TIMEOUT') nextDelay = Math.max(nextDelay, 15000);
                        reportRpcFailure('连不上', err, nextDelay);
                        loopCompleted = false;
                        break;
                    }
                } finally {
                    G.inFlight.delete(id);
                }
            }

            if (loopCompleted) reconcileVerify(activeIds);

            pruneRpcMaps(activeIds);
        } catch (e) {
            if (!isActiveGen() || !state.enabled) return;
            rpcConsecutiveFails++;
            nextDelay = nextRpcBackoffMs(rpcConsecutiveFails);
            if (e && e.code === 'RPC_TIMEOUT') nextDelay = Math.max(nextDelay, 15000);
            const category = isAuthError(e) ? '没权限' : (isConnectionError(e) ? '连不上' : '接口报错');
            if (isConnectionError(e)) {
                invalidateRpcCtx({ preserveReady: rpcConsecutiveFails < 2 });
            } else if (findRpcCtx({ allowPending: false })) {
                // 服务端/权限类响应不是传输断线；保持协议引擎在线，避免误触发页面点击兜底。
                // 注意：这里不能调 markRpcHealthy()，它会清掉失败计数与报错去重，
                // 导致退避永远停在第一档、同一报错的提示和日志每 1.5s 反复刷屏（v7.0.4 已修，勿回退）。
                G.rpcReady = true;
            }
            reportRpcFailure(category, e, nextDelay);
        } finally {
            rpcTickRunning = false;
            if (isActiveGen() && state.enabled) {
                owned.rpcTimer = setTimeout(rpcTick, nextDelay);
            } else {
                owned.rpcTimer = null;
            }
        }
    }

    let lastRpcWakeAt = 0;
    function wakeRpcSoon() {
        if (!isTop || !isActiveGen() || !state.enabled || !G.rpcReady) return;
        const now = Date.now();
        if (rpcTickRunning || now - lastRpcWakeAt < 350) return;
        lastRpcWakeAt = now;
        if (owned.rpcWakeTimer) clearTimeout(owned.rpcWakeTimer);
        owned.rpcWakeTimer = setTimeout(() => {
            owned.rpcWakeTimer = null;
            if (!isActiveGen() || !state.enabled || rpcTickRunning) return;
            if (owned.rpcTimer) {
                clearTimeout(owned.rpcTimer);
                owned.rpcTimer = null;
            }
            rpcTick();
        }, 90);
    }

    // =========================================================================
    // 引擎 B：DOM 穿透精准点击引擎（五级档位 + 上下文防误点 + 验成败计数）
    // =========================================================================

    const NEGATIVE_RE = /拒绝|不允许|不同意|取消|暂不|停止|删除|移除|撤回|关闭|退出|\b(deny|reject|disallow|cancel|decline|block|revoke|delete|remove|dismiss|close)\b/i;

    const REJECT_PAIR_RE = /拒绝|不允许|不同意|全部拒绝|暂不|取消|\b(deny|reject|decline|cancel|disallow|deny all|reject all|do not allow|don't allow)\b/i;

    const APPROVAL_CLUES = [
        '需要批准', '需要审批', '需要审核', '需要确认', '需要你的确认',
        '请求权限', '权限请求', '待审批', '审批请求', '操作确认',
        '允许 muse', '允许muse', '允许此操作', '允许该操作',
        '上传这个文件', '上传文件', '创建公开链接', '公开链接', '授予权限',
        '把信息分享给', 'share information with',
        'approval required', 'permission required', 'pending approval',
        'needs approval', 'requires approval', 'requesting permission',
        'allow muse', 'approve action', 'approve this', 'grant permission',
        'wants to', 'upload this file', 'public link', 'confirm action',
    ];

    // 五级档位词典（严格优先：全部/永久 > 永久/始终 > 批量单次 > 范围/任务内 > 单个允许）
    const TIER1_EXACT = new Set([
        '全部永久允许', '全部始终允许', '始终全部允许', '永久全部允许',
        '全部允许', '允许全部', '全部批准', '批准全部', '一律允许', '全部同意',
        'always allow all', 'allow all always', 'allow all', 'approve all', 'permit all',
    ]);
    const TIER2_EXACT = new Set([
        '永久允许', '始终允许', '总是允许', '一直允许', '永久批准', '始终批准', '一律放行',
        '总是允许此站点', '始终允许此站点', '总是允许此网站', '始终允许此网站',
        '总是允许此连接器', '始终允许此连接器', '总是允许此域名', '始终允许此域名',
        'allow always', 'always allow', 'always allow this site', 'always allow this website',
        'always allow this domain', 'always allow this connector',
        'approve always', 'always approve', 'permit always', 'trust always',
    ]);
    const TIER3_EXACT = new Set([
        '全部允许一次', '全部批准一次', '本次全部允许', '允许全部一次',
        'allow all once', 'approve all once',
    ]);
    const TIER4_EXACT = new Set([
        '此网站内允许', '此任务内允许',
        'allow for this site', 'allow for this task',
    ]);
    const TIER5_EXACT = new Set([
        '允许', '允许一次', '本次允许', '仅允许本次', '仅此一次', '批准', '批准一次', '确认允许', '同意',
        'allow', 'allow once', 'approve', 'approve once', 'permit',
    ]);

    const INTERACTIVE_SELECTOR = 'button, [role="button"], a[role="button"], input[type="button"], input[type="submit"]';
    const FORBIDDEN_ANCESTOR_SELECTOR = 'pre, code, nav, [role="navigation"], [role="menubar"], [inert], [data-muse-aa-ui="1"]';

    const domCooldownMap = new WeakMap();
    const domPendingVerify = new Set();
    const domFirstSeenMap = new WeakMap();
    const domFailCountMap = new WeakMap();
    const domFailureSuppressed = new WeakSet();
    const domSuppressedUntil = new WeakMap();
    let lastDomClickAt = 0;

    function getParentAcrossShadow(node) {
        if (!node) return null;
        if (node.parentElement) return node.parentElement;
        try {
            const root = node.getRootNode && node.getRootNode();
            if (root && root.host) return root.host;
        } catch (e) {}
        return null;
    }

    function hasForbiddenAncestor(el) {
        let cur = el;
        let steps = 0;
        while (cur && steps++ < 15) {
            if (cur.id === BADGE_ID) return true;
            try {
                if (cur.matches && cur.matches(FORBIDDEN_ANCESTOR_SELECTOR)) return true;
            } catch (e) {}
            cur = getParentAcrossShadow(cur);
        }
        return false;
    }

    function extractVisibleText(el) {
        if (!el) return '';
        if (el.tagName === 'INPUT') {
            return String(el.value || el.getAttribute('aria-label') || '');
        }
        let buf = '';
        const walk = (node) => {
            if (!node) return;
            if (node.nodeType === 3) {
                buf += node.nodeValue || '';
                return;
            }
            if (node.nodeType !== 1) return;
            const tag = node.tagName;
            if (tag === 'SVG' || tag === 'STYLE' || tag === 'SCRIPT' || tag === 'NOSCRIPT') return;
            if (node.getAttribute && node.getAttribute('aria-hidden') === 'true') return;
            const children = node.childNodes;
            if (children) {
                for (let i = 0; i < children.length; i++) walk(children[i]);
            }
        };
        walk(el);
        const trimmed = buf.replace(/\s+/g, ' ').trim();
        if (trimmed) return trimmed;
        return String(el.getAttribute && el.getAttribute('aria-label') || el.textContent || '').replace(/\s+/g, ' ').trim();
    }

    function normalizeButtonText(raw) {
        if (!raw) return '';
        let t = String(raw).replace(/\s+/g, ' ').trim();
        // 去掉末尾常见角标、数字计数与快捷键提示：如 "全部允许 (3)"、"Allow always ↵"、"全部允许 · 2"
        t = t
            .replace(/\s*[\(（\[]\s*\d+\s*[\)）\]]\s*$/u, '')
            .replace(/\s*[·•\-|]\s*\d+\s*$/u, '')
            .replace(/\s*(↵|⏎|⌘↵|ctrl\+enter|enter)\s*$/iu, '')
            .replace(/\s+\d+\s*$/u, '')
            .replace(/^[\s✓✔✅⚡•·]+|[\s✓✔✅⚡•·]+$/gu, '')
            .trim();
        return t.toLowerCase();
    }

    function classifyButtonTier(rawText) {
        if (!rawText || rawText.length > 44) return 0;
        if (NEGATIVE_RE.test(rawText)) return 0;
        const norm = normalizeButtonText(rawText);
        if (!norm || norm.length > 34) return 0;
        if (NEGATIVE_RE.test(norm)) return 0;
        if (TIER1_EXACT.has(norm)) return 1;
        if (TIER2_EXACT.has(norm)) return 2;
        if (TIER3_EXACT.has(norm)) return 3;
        if (TIER4_EXACT.has(norm)) return 4;
        if (TIER5_EXACT.has(norm)) return 5;
        return 0;
    }

    function isDisabledButton(el) {
        if (!el) return true;
        if (el.disabled === true) return true;
        if (el.getAttribute && (el.getAttribute('aria-disabled') === 'true' || el.hasAttribute('disabled'))) return true;
        return false;
    }

    function isVisibleButton(el) {
        if (!el || !el.isConnected) return false;
        try {
            const rect = el.getBoundingClientRect();
            if (rect.width < 15 || rect.height < 12 || rect.width > 360 || rect.height > 110) return false;
            const style = win.getComputedStyle(el);
            if (!style) return true;
            if (style.display === 'none' || style.visibility === 'hidden' || style.pointerEvents === 'none') return false;
            if (parseFloat(style.opacity) < 0.1) return false;
            return true;
        } catch (e) {
            return false;
        }
    }

    function hasReactOnClick(el) {
        if (!el) return false;
        try {
            for (const k of Object.keys(el)) {
                if ((k.startsWith('__reactProps$') || k.startsWith('__reactEventHandlers$')) &&
                    el[k] && typeof el[k].onClick === 'function') {
                    return true;
                }
            }
        } catch (e) {}
        return false;
    }

    // 审批上下文校验：普通“允许/Allow/Approve”文案单独出现时不构成审批证据。
    function verifyApprovalContext(btn) {
        if (hasForbiddenAncestor(btn)) return { ok: false };

        const role = ((btn.getAttribute && btn.getAttribute('role')) || '').toLowerCase();
        if (role === 'switch' || role === 'checkbox' || role === 'radio' || role === 'tab' ||
            role === 'menuitemcheckbox' || role === 'menuitemradio') {
            return { ok: false };
        }

        let cur = getParentAcrossShadow(btn);
        for (let depth = 0; depth < 7 && cur; depth++) {
            const tag = (cur.tagName || '').toUpperCase();
            if (tag === 'BODY' || tag === 'HTML') break;

            // 判据 1：同一卡片/弹窗内存在配对的“拒绝/取消”类按钮（最铁审批特征）
            if (cur.querySelectorAll) {
                const peerTextSize = (cur.textContent || '').trim().length;
                const peers = peerTextSize <= 900 ? cur.querySelectorAll(INTERACTIVE_SELECTOR) : [];
                for (let i = 0; i < peers.length && i < 12; i++) {
                    const peer = peers[i];
                    if (peer === btn || !peer.isConnected) continue;
                    const pText = extractVisibleText(peer);
                    if (pText && pText.length <= 28 && REJECT_PAIR_RE.test(pText)) {
                        return { ok: true, clue: `配对按钮:${pText}` };
                    }
                }
            }

            // 判据 2：祖先容器包含明确的审批/权限提示语（且容器文字量合理，非整页正文）
            const cText = (cur.textContent || '').replace(/\s+/g, ' ').trim();
            if (cText.length > 0 && cText.length <= 1200) {
                const lower = cText.toLowerCase();
                for (let i = 0; i < APPROVAL_CLUES.length; i++) {
                    if (lower.includes(APPROVAL_CLUES[i])) {
                        return { ok: true, clue: `卡片文案:${APPROVAL_CLUES[i]}` };
                    }
                }
            }

            // 如果已经爬到一个明确的弹窗/对话框外层还没命中，也继续检查上一层直到上限
            cur = getParentAcrossShadow(cur);
        }

        return { ok: false };
    }

    function getActiveShadowRoots() {
        const roots = [];
        for (const ref of G.shadowRefs) {
            const sr = (ref && typeof ref.deref === 'function') ? ref.deref() : ref;
            if (!sr || (sr.host && !sr.host.isConnected)) {
                G.shadowRefs.delete(ref);
                continue;
            }
            roots.push(sr);
        }
        return roots;
    }

    function collectCandidateRoots() {
        const roots = [];
        const visited = new Set();

        const addRoot = (r) => {
            if (!r || visited.has(r)) return;
            visited.add(r);
            roots.push(r);
        };

        // iframe 由其自身匹配到的 userscript 实例处理，避免顶层与子 frame 双重点击。
        addRoot(doc);
        const shadows = getActiveShadowRoots();
        for (let i = 0; i < shadows.length; i++) {
            addRoot(shadows[i]);
        }
        return roots;
    }

    function findBestApprovalButton(now) {
        const roots = collectCandidateRoots();
        const checkedNodes = new Set();
        let best = null; // { target, rawText, tier, clue }

        const considerNode = (el, isStandardInteractive) => {
            if (!el || checkedNodes.has(el)) return;
            checkedNodes.add(el);

            const target = (el.closest && el.closest(INTERACTIVE_SELECTOR)) || el;
            if (target !== el && checkedNodes.has(target)) return;
            checkedNodes.add(target);

            const priorFails = domFailCountMap.get(target) || 0;
            if (isTop && G.rpcReady && priorFails >= 2) {
                let until = domSuppressedUntil.get(target);
                if (!until) {
                    until = now + 60000;
                    domSuppressedUntil.set(target, until);
                }
                if (now < until) {
                    noteDomSkip(extractVisibleText(target), '协议在线且页面点击连续无效，抑制中');
                    if (!domFailureSuppressed.has(target)) {
                    domFailureSuppressed.add(target);
                    console.warn(TAG, `⚠ 协议在线时页面按钮「${extractVisibleText(target)}」已连续无效 ${priorFails} 次，暂停重复点击；协议离线时会恢复兜底`);
                    }
                    return;
                }
                domFailureSuppressed.delete(target);
                domSuppressedUntil.delete(target);
                domFailCountMap.set(target, 0);
            }

            if (isDisabledButton(target) || domPendingVerify.has(target)) return;
            const lastClick = domCooldownMap.get(target) || 0;
            const retryDelay = priorFails > 0 ? Math.min(2000 * Math.pow(2, Math.min(priorFails - 1, 4)), 30000) : 1500;
            if (now - lastClick < retryDelay) { noteDomSkip(extractVisibleText(target), '重试冷却中'); return; }

            const rawText = extractVisibleText(target);
            const tier = classifyButtonTier(rawText);
            if (!tier) return;

            // 已有同级或更高档位候选时跳过，省去几何与上下文检查开销
            if (best && tier >= best.tier) return;

            if (!isVisibleButton(target)) return;

            // 非标准按钮（如自定义 div/span）要求具备明确点击特征
            if (!isStandardInteractive) {
                let clickable = hasReactOnClick(target);
                if (!clickable) {
                    try {
                        const style = win.getComputedStyle(target);
                        clickable = !!(style && style.cursor === 'pointer');
                    } catch (e) {}
                }
                if (!clickable) return;
            }

            const ctx = verifyApprovalContext(target);
            if (!ctx.ok) { noteDomSkip(rawText, '无审批上下文'); return; }

            best = { target, rawText, tier, clue: ctx.clue };
        };

        // 第一梯队：标准交互按钮（极快）
        for (let r = 0; r < roots.length; r++) {
            const root = roots[r];
            if (!root.querySelectorAll) continue;
            const btns = root.querySelectorAll(INTERACTIVE_SELECTOR);
            for (let i = 0; i < btns.length; i++) {
                considerNode(btns[i], true);
            }
        }

        // 第二梯队：若未找到标准按钮，补充检查对话框/审批卡片中的自定义可点击元素（兼容非 button 实现）
        if (!best) {
            const containerSel = '[role="dialog"], [role="alertdialog"], [data-state="open"], [data-radix-popper-content-wrapper], [class*="approval" i], [class*="permission" i], [class*="modal" i], [class*="confirm" i]';
            for (let r = 0; r < roots.length; r++) {
                const root = roots[r];
                if (!root.querySelectorAll) continue;
                const dialogs = root.querySelectorAll(containerSel);
                for (let d = 0; d < dialogs.length; d++) {
                    const nodes = dialogs[d].querySelectorAll('div, span, a');
                    const limit = Math.min(nodes.length, 300);
                    for (let i = 0; i < limit; i++) {
                        const n = nodes[i];
                        if (n.childElementCount > 3) continue;
                        considerNode(n, false);
                    }
                }
            }
        }

        return best;
    }

    function dispatchClickChain(el) {
        if (!el) return;
        try {
            // 直接触发元素 click，不模拟鼠标移动、按下或抬起事件。
            if (typeof el.click === 'function') {
                el.click();
            } else {
                el.dispatchEvent(new Event('click', { bubbles: true, cancelable: true }));
            }
        } catch (e) {}
    }

    // 延迟验证点击是否真正生效：只有按钮消失/禁用/文案变化才计入真实通过
    function verifyDomClickOutcome(btn, rawText, tier, clue) {
        domPendingVerify.add(btn);
        const checkpoints = [220, 520, 950];
        let idx = 0;
        const scheduleCheck = (fn, delay) => {
            const timer = setTimeout(() => {
                owned.domVerifyTimers.delete(timer);
                fn();
            }, delay);
            owned.domVerifyTimers.add(timer);
        };

        const check = () => {
            if (!isActiveGen() || !state.enabled) {
                domPendingVerify.delete(btn);
                return;
            }
            const gone = !btn.isConnected;
            const disabled = !gone && isDisabledButton(btn);
            const hidden = !gone && !isVisibleButton(btn);
            const textChanged = !gone && !disabled && !hidden && (classifyButtonTier(extractVisibleText(btn)) === 0);

            if (gone || disabled || hidden || textChanged) {
                domPendingVerify.delete(btn);
                domFailCountMap.delete(btn);
                domFailureSuppressed.delete(btn);
                domSuppressedUntil.delete(btn);
                G.domLog.push({ text: rawText, tier, clue, ok: true, at: Date.now() });
                if (G.domLog.length > 200) G.domLog.shift();
                recordApproved('dom', rawText);
                console.log(TAG, `✓ [页面精点 T${tier}] 已生效「${rawText}」(${clue})`);
                return;
            }

            idx++;
            if (idx < checkpoints.length) {
                const delta = checkpoints[idx] - checkpoints[idx - 1];
                scheduleCheck(check, delta);
            } else {
                // 超过 950ms 仍纹丝不动：不虚增计数，记录一次失败以便下轮升级破冰模式
                domPendingVerify.delete(btn);
                const fails = (domFailCountMap.get(btn) || 0) + 1;
                domFailCountMap.set(btn, fails);
                G.domLog.push({ text: rawText, tier, clue, ok: false, fails, at: Date.now() });
                if (G.domLog.length > 200) G.domLog.shift();
                console.warn(TAG, `⚠ [页面精点未生效#${fails}]「${rawText}」，不计入通过数，按冷却策略重试`);
                showErrorToast('兜底线', `点击「${rawText}」未生效，稍后自动重试`);
            }
        };

        scheduleCheck(check, checkpoints[0]);
    }

    function domScan() {
        if (!isActiveGen()) return;
        if (isTop && doc.body && (!badgeRefs || !badgeRefs.el || !badgeRefs.el.isConnected)) {
            renderBadge();
        }
        if (!state.enabled) return;

        // 协议正在握手时暂停页面点击，避免把正常连接过程误判为故障并触发兜底。
        if (isTop && G.rpcConnecting) {
            if (!owned.domDeferTimer) {
                owned.domDeferTimer = setTimeout(() => {
                    owned.domDeferTimer = null;
                    domScan();
                }, 1000);
            }
            return;
        }

        const now = Date.now();
        if (isTop && (G.inFlight.size > 0 || now < G.rpcUncertainUntil)) {
            noteDomSkip('', '等协议结果，页面点击让行');
            if (!owned.domDeferTimer) {
                const waitMs = G.inFlight.size > 0 ? 700 : Math.min(1500, Math.max(250, G.rpcUncertainUntil - now));
                owned.domDeferTimer = setTimeout(() => {
                    owned.domDeferTimer = null;
                    domScan();
                }, waitMs);
            }
            return;
        }
        if (now - lastDomClickAt < 420) return;

        const chosen = findBestApprovalButton(now);
        if (!chosen) return;

        // 双引擎协同礼让：顶层且 RPC 已就绪时，先唤醒 RPC 并礼让 450ms（让 RPC 用 allow_always 无声批掉）
        if (isTop && G.rpcReady) {
            wakeRpcSoon();
            let firstSeen = domFirstSeenMap.get(chosen.target);
            if (!firstSeen) {
                firstSeen = now;
                domFirstSeenMap.set(chosen.target, firstSeen);
            }
            const waitLimit = (G.inFlight.size > 0 || now - G.lastRpcApproveAt < 600) ? 1100 : 450;
            if (now - firstSeen < waitLimit) {
                if (!owned.domDeferTimer) {
                    owned.domDeferTimer = setTimeout(() => {
                        owned.domDeferTimer = null;
                        domScan();
                    }, Math.max(120, waitLimit - (now - firstSeen) + 30));
                }
                return;
            }
        }

        lastDomClickAt = now;
        domCooldownMap.set(chosen.target, now);
        dispatchClickChain(chosen.target);
        verifyDomClickOutcome(chosen.target, chosen.rawText, chosen.tier, chosen.clue);
    }

    function scheduleDomScanSoon(delayMs = 160) {
        if (!isActiveGen() || !state.enabled) return;
        if (owned.domThrottleTimer) return;
        owned.domThrottleTimer = setTimeout(() => {
            owned.domThrottleTimer = null;
            domScan();
        }, delayMs);
    }

    function attachObserver(root) {
        if (!root || !isActiveGen() || !state.enabled || owned.observedRoots.has(root)) return;
        if (typeof MutationObserver === 'undefined') return;
        try {
            const obs = new MutationObserver(() => {
                if (!isActiveGen()) {
                    obs.disconnect();
                    return;
                }
                if (state.enabled) scheduleDomScanSoon(160);
            });
            obs.observe(root, { childList: true, subtree: true });
            owned.observers.add(obs);
            owned.observedRoots.add(root);
        } catch (e) {}
    }

    function stopRuntimeLoops() {
        if (owned.rpcTimer) { clearTimeout(owned.rpcTimer); owned.rpcTimer = null; }
        if (owned.rpcWakeTimer) { clearTimeout(owned.rpcWakeTimer); owned.rpcWakeTimer = null; }
        if (owned.domTimer) { clearInterval(owned.domTimer); owned.domTimer = null; }
        if (owned.domThrottleTimer) { clearTimeout(owned.domThrottleTimer); owned.domThrottleTimer = null; }
        if (owned.domDeferTimer) { clearTimeout(owned.domDeferTimer); owned.domDeferTimer = null; }
        for (const timer of owned.domVerifyTimers) clearTimeout(timer);
        owned.domVerifyTimers.clear();
        domPendingVerify.clear();
        for (const obs of owned.observers) {
            try { obs.disconnect(); } catch (e) {}
        }
        owned.observers.clear();
        owned.observedRoots.clear();
    }

    function startRuntimeLoops() {
        if (!isActiveGen() || !state.enabled) return;
        attachObserver(doc.body || doc.documentElement);
        for (const sr of getActiveShadowRoots()) attachObserver(sr);
        if (isTop && !owned.rpcTimer && !rpcTickRunning) owned.rpcTimer = setTimeout(rpcTick, 50);
        if (!owned.domTimer) owned.domTimer = setInterval(domScan, state.domIntervalMs);
        scheduleDomScanSoon(50);
    }

    function syncRuntimeEnabled() {
        if (state.enabled) startRuntimeLoops();
        else stopRuntimeLoops();
    }

    // 新捕获的 Closed Shadow DOM 自动挂监听
    shadowAttachedHook = (sr) => {
        if (isActiveGen() && state.enabled) attachObserver(sr);
    };
    G.onShadowAttached = shadowAttachedHook;

    // =========================================================================
    // 主开关与控制台高级工具（兼容 v2.3.0 __musePerm 全部接口并修复 RISKY）
    // =========================================================================

    function setEnabled(on) {
        state.enabled = !!on;
        saveState();
        renderBadge();
        broadcastEnabledToFrames(state.enabled);
        syncRuntimeEnabled();
        if (state.enabled) wakeRpcSoon();
        return state.enabled;
    }

    function permsUnwrap(r) {
        let v = r;
        for (let i = 0; i < 4 && v && typeof v === 'object'; i++) {
            if ('hitl_mode' in v) return v;
            if (v.permissions && typeof v.permissions === 'object') { v = v.permissions; continue; }
            break;
        }
        return (v && typeof v === 'object') ? v : {};
    }

    const RISKY = /(send|publish|post|delete|trash|remove|transfer|spend|purchase|checkout|payment|book|place|claim|revoke|delegated|execute|deploy|import|create|edit|update|manage|write|down|up_login)/i;

    function exclude(list, patterns) {
        const res = patterns.map((p) => (p instanceof RegExp ? p : new RegExp(p, 'i')));
        return list.filter((r) => !res.some((re) => re.test(`${r.connector}.${r.method}`)));
    }

    async function getPermissions() {
        return permsUnwrap(await rpcCall('egress.permissions', {}));
    }

    async function listApprovals() {
        const list = pendingOf(await rpcCall('egress.approvals', {}));
        console.log(TAG, `待审批 ${list.length} 项`);
        if (list.length) console.table(list);
        return list;
    }

    async function listConnectors() {
        const p = await getPermissions();
        const rows = [];
        for (const c of (p.connectors || [])) {
            const actions = (c.display && c.display.actions) || {};
            for (const [m, mode] of Object.entries(c.methods || {})) {
                rows.push({
                    connector: c.connector,
                    method: m,
                    mode,
                    canSet: (actions[m] && actions[m].mode_options ? actions[m].mode_options.join('/') : null),
                    source: (c.method_sources && c.method_sources[m]) || null,
                });
            }
        }
        return rows;
    }

    async function listAsking() {
        const rows = (await listConnectors()).filter((r) => r.mode === 'ask');
        console.log(TAG, `当前为 ask 的权限项：${rows.length} 个`);
        if (rows.length) console.table(rows);
        return rows;
    }

    async function setConnector(name, methods) {
        if (!name || !methods || typeof methods !== 'object') {
            throw new Error('用法: connector(连接器名, { 方法名: "allow"|"ask"|"deny" })');
        }
        for (const [k, v] of Object.entries(methods)) {
            if (!['allow', 'ask', 'deny'].includes(v)) throw new Error(`方法 ${k} 档位非法：${v}`);
        }
        return rpcCall('egress.permissions.connector', { connector: name, methods });
    }

    async function applyList(list, { confirm = false, delayMs = 250 } = {}) {
        if (!list.length) return { changed: [], failed: [] };
        const byConn = new Map();
        for (const { connector: c, method } of list) {
            if (!byConn.has(c)) byConn.set(c, {});
            byConn.get(c)[method] = 'allow';
        }
        if (!confirm) {
            console.log(TAG, `[预览] ${list.length} 个方法 / ${byConn.size} 个连接器 将改为 allow`);
            console.table([...byConn].map(([c, m]) => ({ connector: c, 方法数: Object.keys(m).length })));
            return { preview: true, connectors: byConn.size, methods: list.length };
        }
        const changed = [];
        const failed = [];
        let i = 0;
        for (const [c, methods] of byConn) {
            i++;
            try {
                await rpcCall('egress.permissions.connector', { connector: c, methods });
                changed.push(...Object.keys(methods).map((m) => `${c}.${m}`));
            } catch (e) {
                failed.push({ connector: c, error: (e && e.message) || String(e) });
            }
            if (i < byConn.size) await new Promise((r) => setTimeout(r, delayMs));
        }
        invalidateRpcCtx();
        console.log(TAG, `✓ 已修改 ${changed.length} 个，失败 ${failed.length} 个`);
        return { changed, failed };
    }

    // 修复 v2.3.0 遗留：默认启用 RISKY 过滤保护高危项，传 includeRisky: true 才全改
    async function allowEverything({ confirm = false, includeRisky = false } = {}) {
        const rows = (await listConnectors()).filter((r) => r.mode === 'ask');
        const can = [];
        const cannot = [];
        for (const r of rows) {
            const opts = r.canSet ? r.canSet.split('/') : null;
            if (opts && !opts.includes('allow')) cannot.push(r);
            else can.push(r);
        }
        const target = includeRisky ? can : exclude(can, [RISKY]);
        const skippedRisky = can.length - target.length;
        console.log(
            TAG,
            `共 ${rows.length} 个 ask 项：本次处理 ${target.length}` +
            (skippedRisky ? `，已跳过高危 ${skippedRisky}（传 includeRisky:true 可包含）` : '') +
            `，服务端限制不可改 ${cannot.length}`
        );
        return applyList(target.map((r) => ({ connector: r.connector, method: r.method })), { confirm });
    }

    async function approveNow({ decision = state.decision, alwaysScope, dryRun = false } = {}) {
        domScan();
        const list = pendingOf(await rpcCall('egress.approvals', {}));
        const out = [];
        for (const item of list) {
            const id = idOf(item);
            if (!id) continue;
            if (dryRun) {
                out.push({ id, title: titleOf(item), chain: buildDecisionChain(item, decision), dryRun: true });
                continue;
            }
            try {
                const res = await decideSmart(item, decision, { alwaysScope });
                recordApproved('rpc', `${res.decision} · ${titleOf(item)}`);
                out.push({ id, ok: true, decision: res.decision });
            } catch (e) {
                out.push({ id, ok: false, error: (e && e.message) || String(e) });
            }
        }
        return out;
    }

    function diag() {
        const readyCtx = findRpcCtx({ allowPending: false });
        const pendingCtx = readyCtx || findRpcCtx({ allowPending: true });
        const info = {
            version: VERSION,
            gen: myGen,
            isOwner: isActiveGen(),
            isTop,
            enabled: state.enabled,
            count: state.count,
            rpcCount: state.rpcCount,
            domCount: state.domCount,
            rpcReady: G.rpcReady,
            rpcStatus: G.rpcReady ? 'connected' : 'disconnected',
            rpcStatusReason: G.rpcStatusReason,
            rpcLastError: G.rpcLastError,
            rpcContextMissingMs: G.rpcMissingSince ? Math.max(0, Date.now() - G.rpcMissingSince) : 0,
            rpcUncertainRemainingMs: Math.max(0, (G.rpcUncertainUntil || 0) - Date.now()),
            lastRpcApprovedAt: state.lastRpcApprovedAt,
            lastRpcApprovedTime: formatClockTime(state.lastRpcApprovedAt) || null,
            domFallbackActive: state.enabled && !G.rpcReady,
            hasReadyCtx: !!readyCtx,
            hasPendingCtx: !!pendingCtx,
            connectionState: pendingCtx ? pendingCtx.connectionState : null,
            activeShadows: getActiveShadowRoots().length,
            inFlight: G.inFlight.size,
            pendingVerify: G.pendingVerify ? G.pendingVerify.size : 0,
            domSkipLog: (G.domSkipLog || []).slice(-10),
        };
        console.log(TAG, '诊断信息:', info);
        return info;
    }

    // 清理本实例所有句柄（绝不触碰其他新实例）
    function teardown() {
        owned.destroyed = true;
        stopRuntimeLoops();
        if (owned.toastTimer) { clearTimeout(owned.toastTimer); owned.toastTimer = null; }
        if (owned.detailHideTimer) { clearTimeout(owned.detailHideTimer); owned.detailHideTimer = null; }
        clearErrorToast();
        hideDetailPanel();
        if (detailPanel && detailPanel.isConnected) detailPanel.remove();
        detailPanel = null;
        win.removeEventListener('message', onWindowMessage);
        win.removeEventListener('storage', onStorageSync);
        win.removeEventListener('resize', onResize);
        if (G.onShadowAttached === shadowAttachedHook) G.onShadowAttached = previousShadowAttachedHook || null;
        if (elemProto && shadowHookPatched && elemProto.attachShadow === shadowHookPatched) {
            elemProto.attachShadow = shadowHookOriginal;
        }
    }

    G.activeTeardown = teardown;

    // 导出控制台 API（与 v2.3.0 兼容）
    if (isTop) {
        win.__musePerm = {
            version: VERSION,
            setEnabled,
            enable: () => setEnabled(true),
            disable: () => setEnabled(false),
            stopAuto: () => setEnabled(false),
            autoApprove: () => setEnabled(true),
            autoStart: (on) => setEnabled(on),
            approveNow,
            scanDom: domScan,
            get: getPermissions,
            approvals: listApprovals,
            connectors: listConnectors,
            asking: listAsking,
            decide: decideRaw,
            decideSmart,
            connector: setConnector,
            applyList,
            allowEverything,
            exclude,
            RISKY,
            on: () => rpcCall('egress.permissions.hitl', { mode: 'full' }),
            clearSnooze: () => rpcCall('egress.permissions.hitl.snooze.delete', {}),
            raw: (m, p) => rpcCall(m, p),
            findRpcCtx,
            diag,
            get rpcLog() { return G.rpcLog; },
            get domLog() { return G.domLog; },
            get running() { return state.enabled; },
            get gen() { return myGen; },
        };
    }

    // =========================================================================
    // 启动入口
    // =========================================================================

    function boot() {
        if (!isActiveGen()) return;
        win.addEventListener('message', onWindowMessage);
        win.addEventListener('storage', onStorageSync);
        if (isTop) win.addEventListener('resize', onResize);

        if (isTop) {
            renderBadge();
            if (!G.bannerShown) {
                G.bannerShown = true;
                console.log(TAG, `v${VERSION} 已加载（协议优先：RPC第一引擎主动查单 + DOM第二引擎兜底）`);
            }
        }

        // 协议轮询与 DOM 兜底只在开关开启时启动。
        startRuntimeLoops();
    }

    if (doc.readyState === 'loading') {
        doc.addEventListener('DOMContentLoaded', boot, { once: true });
    } else {
        boot();
    }
})();
