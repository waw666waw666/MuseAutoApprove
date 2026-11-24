import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const USER_JS = fs.readFileSync(new URL('../muse-auto-approve.user.js', import.meta.url), 'utf8');
const CONTENT_JS = fs.readFileSync(new URL('../content.js', import.meta.url), 'utf8');
const MANIFEST = JSON.parse(fs.readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));

// 0. 检查双模代码完全一致 + manifest 配置正确
{
    const strippedUser = USER_JS.replace(/^\/\/ ==UserScript==[\s\S]*?\/\/ ==\/UserScript==\s*/, '')
        .replace('免责声明：本脚本', '免责声明：本扩展');
    assert.equal(strippedUser.trim(), CONTENT_JS.trim(), 'muse-auto-approve.user.js 与 content.js 主体必须一致');
    assert.equal(MANIFEST.version, '7.0.6');
    assert.equal(MANIFEST.content_scripts[0].world, 'MAIN');
    assert.match(USER_JS, /@version\s+7\.0\.6/);
    assert.match(USER_JS, /@grant\s+none/);
    assert.match(USER_JS, /@run-at\s+document-start/);
    console.log('[PASS] 0. 元数据、双模同步与 manifest.json 校验通过');
}

// 轻量 DOM + Shadow DOM + Timer 沙箱构造器
function createEnv({ hostname = 'muse.ai', isTop = true, initialStorage = {} } = {}) {
    const store = new Map(Object.entries(initialStorage));
    const localStorage = {
        getItem: (k) => (store.has(k) ? store.get(k) : null),
        setItem: (k, v) => store.set(k, String(v)),
        removeItem: (k) => store.delete(k),
    };

    const listeners = new Map();
    let fakeNow = 1_700_000_000_000;
    const timers = [];
    let nextTimerId = 1;

    const addTimer = (fn, delay, interval) => {
        const id = nextTimerId++;
        timers.push({ id, fn, at: fakeNow + Math.max(0, delay || 0), interval: interval ? Math.max(1, delay || 1) : 0, active: true });
        return id;
    };
    const clearTimer = (id) => {
        const t = timers.find((x) => x.id === id);
        if (t) t.active = false;
    };

    async function advance(ms) {
        const target = fakeNow + ms;
        while (true) {
            timers.sort((a, b) => a.at - b.at);
            const next = timers.find((t) => t.active && t.at <= target);
            if (!next) break;
            fakeNow = next.at;
            if (next.interval) {
                next.at = fakeNow + next.interval;
            } else {
                next.active = false;
            }
            next.fn();
            await new Promise((r) => setImmediate(r));
        }
        fakeNow = target;
        await new Promise((r) => setImmediate(r));
    }

    class FakeNode {
        constructor(tag, text = '') {
            this.nodeType = tag === '#text' ? 3 : 1;
            this.tagName = tag.toUpperCase();
            this.nodeValue = tag === '#text' ? text : null;
            this.id = '';
            this.className = '';
            this.attrs = new Map();
            this.style = { display: '', visibility: '', opacity: '1', pointerEvents: 'auto', cursor: '' };
            this.children = [];
            this.childNodes = [];
            this.parentElement = null;
            this.shadowRoot = null;
            this.host = null;
            this.isConnected = false;
            this.disabled = false;
            this._rect = { left: 10, top: 10, width: 90, height: 32 };
            this._listeners = new Map();
            this.clickCount = 0;
            this.reactClickCount = 0;
            this._onNativeClick = null;
            if (tag !== '#text' && text) {
                this.appendChild(new FakeNode('#text', text));
            }
        }
        get childElementCount() { return this.children.length; }
        get textContent() {
            if (this.nodeType === 3) return this.nodeValue || '';
            return this.childNodes.map((c) => c.textContent).join('');
        }
        set textContent(v) {
            this.children = [];
            this.childNodes = [];
            if (v !== '' && v != null) this.appendChild(new FakeNode('#text', String(v)));
        }
        getAttribute(k) { return this.attrs.has(k) ? this.attrs.get(k) : null; }
        setAttribute(k, v) {
            this.attrs.set(k, String(v));
            if (k === 'id') this.id = String(v);
            if (k === 'class') this.className = String(v);
        }
        hasAttribute(k) { return this.attrs.has(k); }
        appendChild(child) {
            child.parentElement = this.nodeType === 11 ? null : this;
            if (this.nodeType === 11) child._shadowParent = this;
            this.childNodes.push(child);
            if (child.nodeType === 1) this.children.push(child);
            const markConnected = (n, flag) => {
                n.isConnected = flag;
                if (n.shadowRoot) markConnected(n.shadowRoot, flag);
                for (const c of n.childNodes) markConnected(c, flag);
            };
            if (this.isConnected || (this.nodeType === 11 && this.host && this.host.isConnected)) {
                markConnected(child, true);
            }
            return child;
        }
        remove() {
            const p = this.parentElement || this._shadowParent;
            if (p) {
                p.children = p.children.filter((x) => x !== this);
                p.childNodes = p.childNodes.filter((x) => x !== this);
            }
            const markOff = (n) => {
                n.isConnected = false;
                if (n.shadowRoot) markOff(n.shadowRoot);
                for (const c of n.childNodes) markOff(c);
            };
            markOff(this);
        }
        getRootNode() {
            let cur = this;
            while (cur.parentElement) cur = cur.parentElement;
            if (cur._shadowParent) return cur._shadowParent;
            return document;
        }
        getBoundingClientRect() { return this._rect; }
        addEventListener(ev, fn) {
            if (!this._listeners.has(ev)) this._listeners.set(ev, []);
            this._listeners.get(ev).push(fn);
        }
        dispatchEvent(ev) {
            const list = this._listeners.get(ev.type) || [];
            for (const fn of list) fn(ev);
            return true;
        }
        focus() {}
        click() {
            this.clickCount++;
            if (this._onNativeClick) this._onNativeClick(this);
        }
        matches(sel) {
            return sel.split(',').map((s) => s.trim()).some((part) => matchSingle(this, part));
        }
        closest(sel) {
            let cur = this;
            while (cur && cur.nodeType === 1) {
                if (cur.matches(sel)) return cur;
                cur = cur.parentElement;
            }
            return null;
        }
        querySelectorAll(sel) {
            const res = [];
            const walk = (n) => {
                for (const c of n.children) {
                    if (c.matches(sel)) res.push(c);
                    walk(c);
                }
            };
            walk(this);
            return res;
        }
        querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
    }

    function matchSingle(el, part) {
        if (!el || el.nodeType !== 1) return false;
        if (part === '*') return true;
        if (part.startsWith('#')) return el.id === part.slice(1);
        const attrRe = /^([a-z0-9]*)?\[([a-z0-9\-_]+)(?:(\*?=)"([^"]+)"(?:\s*i)?)?\]$/i;
        const m = part.match(attrRe);
        if (m) {
            const [, tag, attr, op, val] = m;
            if (tag && el.tagName !== tag.toUpperCase()) return false;
            const actual = attr === 'class' ? el.className : el.getAttribute(attr);
            if (!op) return actual !== null;
            if (actual === null) return false;
            if (op === '*=') return actual.toLowerCase().includes(val.toLowerCase());
            return actual.toLowerCase() === val.toLowerCase();
        }
        return el.tagName === part.toUpperCase();
    }

    class FakeShadowRoot extends FakeNode {
        constructor(host, mode) {
            super('#shadow');
            this.nodeType = 11;
            this.host = host;
            this.mode = mode;
            this.isConnected = host.isConnected;
        }
    }

    function Element() {}
    Element.prototype = FakeNode.prototype;
    Element.prototype.attachShadow = function (init) {
        const sr = new FakeShadowRoot(this, (init && init.mode) || 'open');
        if (sr.mode === 'open') this.shadowRoot = sr;
        this._internalShadow = sr;
        return sr;
    };

    const documentElement = new FakeNode('html');
    documentElement.isConnected = true;
    const body = new FakeNode('body');
    documentElement.appendChild(body);

    const document = {
        readyState: 'complete',
        documentElement,
        body,
        createElement: (t) => new FakeNode(t),
        getElementById: (id) => documentElement.querySelector('#' + id),
        querySelector: (sel) => documentElement.querySelector(sel),
        querySelectorAll: (sel) => documentElement.querySelectorAll(sel),
        addEventListener: () => {},
    };

    const postedMessages = [];
    const topObj = isTop ? null : { postMessage: (d, t) => postedMessages.push({ d, t }) };

    const logs = { log: [], warn: [], error: [] };
    const win = {
        location: { hostname, origin: `https://${hostname}` },
        document,
        Element,
        localStorage,
        innerWidth: 1440,
        innerHeight: 900,
        getComputedStyle: (el) => el.style,
        addEventListener: (ev, fn) => {
            if (!listeners.has(ev)) listeners.set(ev, []);
            listeners.get(ev).push(fn);
        },
        removeEventListener: (ev, fn) => {
            const arr = listeners.get(ev) || [];
            listeners.set(ev, arr.filter((x) => x !== fn));
        },
        dispatchMessage: (origin, data) => {
            for (const fn of (listeners.get('message') || [])) fn({ origin, data });
        },
        PointerEvent: class PointerEvent { constructor(type, opts) { this.type = type; Object.assign(this, opts); } },
        Event: class Event { constructor(type, opts) { this.type = type; Object.assign(this, opts || {}); } },
        MouseEvent: class MouseEvent { constructor(type, opts) { this.type = type; Object.assign(this, opts); } },
        MutationObserver: class MutationObserver {
            constructor(cb) { this.cb = cb; this.disconnected = false; }
            observe() {}
            disconnect() { this.disconnected = true; }
        },
        URL,
        WeakRef,
        Date: class FakeDate extends Date {
            static now() { return fakeNow; }
        },
        setTimeout: (fn, d) => addTimer(fn, d, false),
        clearTimeout: clearTimer,
        setInterval: (fn, d) => addTimer(fn, d, true),
        clearInterval: clearTimer,
        console: {
            log: (...a) => logs.log.push(a.join(' ')),
            warn: (...a) => logs.warn.push(a.join(' ')),
            error: (...a) => logs.error.push(a.join(' ')),
            table() {},
        },
    };
    win.window = win;
    win.self = win;
    win.top = isTop ? win : topObj;
    win.unsafeWindow = win;

    const ctx = vm.createContext(win);
    const runScript = () => vm.runInContext(USER_JS, ctx);

    return { win, document, body, FakeNode, Element, store, postedMessages, timers, logs, advance, runScript };
}

// 1. 严格域名拦截测试
{
    for (const badHost of ['evil-muse.ai.com', 'muse.ai.evil.org', 'github.com', 'fake-muse.ai']) {
        const env = createEnv({ hostname: badHost });
        env.runScript();
        assert.equal(env.win.__museAutoApproveGlobal, undefined, `非法域名 ${badHost} 必须被拦截`);
        assert.equal(env.Element.prototype.attachShadow.__museAAHooked, undefined);
    }
    for (const okHost of ['muse.ai', 'app.muse.ai', 'sub.app.muse.ai']) {
        const env = createEnv({ hostname: okHost });
        env.runScript();
        assert.ok(env.win.__museAutoApproveGlobal, `合法域名 ${okHost} 必须放行`);
    }
    console.log('[PASS] 1. 严格域名拦截测试通过');
}

// 2. 旧版 v63 配置平滑迁移测试
{
    const env = createEnv({
        initialStorage: {
            muse_tm_enabled_v63: 'true',
            muse_tm_count_v63: '42',
            muse_tm_pos_v63: JSON.stringify({ left: 120, top: 88 }),
        },
    });
    env.runScript();
    const saved = JSON.parse(env.store.get('muse_auto_approve_v7'));
    assert.equal(saved.enabled, true);
    assert.equal(saved.count, 42);
    assert.deepEqual(saved.pos, { left: 120, top: 88 });
    console.log('[PASS] 2. 旧版 v63 配置迁移测试通过');
}

// 3. 五级档位优先级（含 v7.0.1 补词与排序）+ 角标数字剥离 + 分享信息卡线索 + 防误点校验
{
    const env = createEnv();
    // 陷阱按钮 1：页面普通正文里的孤立“允许”按钮（无配对拒绝，无审批提示） -> 绝不能误点！
    const toolbar = env.document.createElement('div');
    const strayAllow = env.document.createElement('button');
    strayAllow.textContent = 'Allow';
    toolbar.appendChild(strayAllow);
    env.body.appendChild(toolbar);

    // 陷阱按钮 2：导航栏里的“全部允许” -> 绝不能误点！
    const nav = env.document.createElement('nav');
    const navBtn = env.document.createElement('button');
    navBtn.textContent = '全部允许';
    nav.appendChild(navBtn);
    env.body.appendChild(nav);

    // 陷阱按钮 3：设置里的开关 role="switch" 叫“始终允许” -> 绝不能误点！
    const sw = env.document.createElement('button');
    sw.setAttribute('role', 'switch');
    sw.textContent = '始终允许';
    env.body.appendChild(sw);

    // 完整五级按钮同框排序测试：Tier1 > Tier2(永久/始终含此网站/此连接器) > Tier3(全部允许一次) > Tier4(此网站内/此任务内) > Tier5(单个允许)
    const card = env.document.createElement('div');
    const makeBtn = (label) => {
        const b = env.document.createElement('button');
        b.textContent = label;
        b._onNativeClick = (x) => x.remove();
        card.appendChild(b);
        return b;
    };
    const denyBtn = makeBtn('拒绝');
    const noAllowBtn = makeBtn('不允许');
    const singleBtn = makeBtn('允许');                        // Tier 5
    const scopeSiteBtn = makeBtn('此网站内允许');              // Tier 4
    const scopeTaskEnBtn = makeBtn('Allow for this task');    // Tier 4
    const batchOnceBtn = makeBtn('全部允许一次');              // Tier 3
    const alwaysSiteBtn = makeBtn('始终允许此网站');           // Tier 2（必须排在「全部允许一次」之前！）
    const alwaysConnBtn = makeBtn('始终允许此连接器');         // Tier 2
    const alwaysSiteEnBtn = makeBtn('Always allow this site'); // Tier 2
    const allBtn = makeBtn('全部允许 (3)');                   // Tier 1
    env.body.appendChild(card);

    env.runScript();
    await env.advance(300);

    // 陷阱全部为 0
    assert.equal(strayAllow.clickCount, 0, '孤立 Allow 绝不能误点');
    assert.equal(navBtn.clickCount, 0, '导航栏按钮绝不能误点');
    assert.equal(sw.clickCount, 0, 'switch 开关绝不能误点');
    assert.equal(denyBtn.clickCount, 0, '拒绝绝不能点');
    assert.equal(noAllowBtn.clickCount, 0, '不允许绝不能点');

    // 第 1 轮：Tier 1「全部允许 (3)」
    assert.equal(allBtn.clickCount, 1, '第 1 轮必须选 Tier 1：全部允许 (3)');
    assert.equal(alwaysSiteBtn.clickCount, 0);
    assert.equal(batchOnceBtn.clickCount, 0);

    // 第 2~4 轮：Tier 2 永久/始终类（始终允许此网站 / 始终允许此连接器 / Always allow this site）全部排在「全部允许一次」之前！
    await env.advance(1300);
    assert.equal(alwaysSiteBtn.clickCount, 1, '第 2 轮必须先选 Tier 2：始终允许此网站（先于全部允许一次）');
    assert.equal(batchOnceBtn.clickCount, 0);

    await env.advance(1300);
    assert.equal(alwaysConnBtn.clickCount, 1, '第 3 轮必须选 Tier 2：始终允许此连接器');
    assert.equal(batchOnceBtn.clickCount, 0);

    await env.advance(1300);
    assert.equal(alwaysSiteEnBtn.clickCount, 1, '第 4 轮必须选 Tier 2：Always allow this site');
    assert.equal(batchOnceBtn.clickCount, 0);

    // 第 5 轮：Tier 3「全部允许一次」
    await env.advance(1300);
    assert.equal(batchOnceBtn.clickCount, 1, '第 5 轮才轮到 Tier 3：全部允许一次');
    assert.equal(scopeSiteBtn.clickCount, 0);
    assert.equal(singleBtn.clickCount, 0);

    // 第 6~7 轮：Tier 4 范围/任务内允许（此网站内允许 / Allow for this task）必须排在单个「允许」之前！
    await env.advance(1300);
    assert.equal(scopeSiteBtn.clickCount, 1, '第 6 轮必须选 Tier 4：此网站内允许（先于单个允许）');
    assert.equal(singleBtn.clickCount, 0);

    await env.advance(1300);
    assert.equal(scopeTaskEnBtn.clickCount, 1, '第 7 轮必须选 Tier 4：Allow for this task');
    assert.equal(singleBtn.clickCount, 0);

    // 第 8 轮：最后才回落到 Tier 5 单个「允许」
    await env.advance(1300);
    assert.equal(singleBtn.clickCount, 1, '第 8 轮最后回落到 Tier 5：允许');
    assert.equal(env.win.__musePerm.diag().domCount, 8);

    // 追加校验：分享信息卡中文 & 英文标题线索（无配对拒绝按钮，仅凭标题线索命中 Tier 5）
    const shareCardZh = env.document.createElement('div');
    const shareTitleZh = env.document.createElement('div');
    shareTitleZh.textContent = '把信息分享给 docs.example.com';
    const shareBtnZh = env.document.createElement('button');
    shareBtnZh.textContent = '允许';
    shareBtnZh._onNativeClick = (x) => x.remove();
    shareCardZh.appendChild(shareTitleZh);
    shareCardZh.appendChild(shareBtnZh);
    env.body.appendChild(shareCardZh);

    await env.advance(1300);
    assert.equal(shareBtnZh.clickCount, 1, '中文「把信息分享给」卡片必须识别并点中允许');

    const shareCardEn = env.document.createElement('div');
    const shareTitleEn = env.document.createElement('div');
    shareTitleEn.textContent = 'Muse wants to Share Information With billing.example.com';
    const shareBtnEn = env.document.createElement('button');
    shareBtnEn.textContent = 'Allow';
    shareBtnEn._onNativeClick = (x) => x.remove();
    shareCardEn.appendChild(shareTitleEn);
    shareCardEn.appendChild(shareBtnEn);
    env.body.appendChild(shareCardEn);

    await env.advance(1300);
    assert.equal(shareBtnEn.clickCount, 1, '英文「share information with」卡片必须识别并点中 Allow');

    // 验证另外两个范围新词「此任务内允许」「Allow for this site」也无需配对拒绝即可直接放行（Tier 4 专有短语）
    const standaloneScope1 = env.document.createElement('button');
    standaloneScope1.textContent = '此任务内允许';
    standaloneScope1._onNativeClick = (x) => x.remove();
    const standaloneScope2 = env.document.createElement('button');
    standaloneScope2.textContent = 'Allow for this site';
    standaloneScope2._onNativeClick = (x) => x.remove();
    env.body.appendChild(standaloneScope1);
    env.body.appendChild(standaloneScope2);

    await env.advance(2600);
    assert.equal(standaloneScope1.clickCount, 1, 'Tier 4「此任务内允许」必须被识别点击');
    assert.equal(standaloneScope2.clickCount, 1, 'Tier 4「Allow for this site」必须被识别点击');
    assert.equal(strayAllow.clickCount, 0, '全程孤立 Allow 依然零误点');
    console.log('[PASS] 3. 五级档位排序（含 v7.0.1 补词与分享卡线索）、角标剥离与防误点校验通过');
}

// 4. Closed Shadow DOM 穿透 + 验成败真实计数（假死不虚增 + 失败升级 React 破冰）
{
    const env = createEnv();
    env.runScript();

    const host = env.document.createElement('div');
    env.body.appendChild(host);
    const sr = host.attachShadow({ mode: 'closed' });
    assert.equal(sr.mode, 'open', 'closed shadow 必须被降级为 open');

    const modal = env.document.createElement('div');
    const title = env.document.createElement('div');
    title.textContent = '需要批准：允许 Muse 上传这个文件';
    const allowBtn = env.document.createElement('button');
    allowBtn.textContent = '允许';
    allowBtn.__reactProps$test = {
        onClick() {
            allowBtn.reactClickCount++;
            allowBtn.remove();
        },
    };
    modal.appendChild(title);
    modal.appendChild(allowBtn);
    sr.appendChild(modal);

    await env.advance(1300);
    assert.equal(allowBtn.clickCount, 1, '第一次先发标准事件链，不双触发 React onClick');
    assert.equal(allowBtn.reactClickCount, 0, '首次不得双触发 React onClick');

    await env.advance(1000);
    assert.equal(env.win.__musePerm.diag().domCount, 0, '点击未生效时绝不虚增计数');

    await env.advance(1800);
    assert.equal(allowBtn.reactClickCount, 1, '重试必须升级触发 React onClick 破冰');
    await env.advance(300);
    assert.equal(env.win.__musePerm.diag().domCount, 1, '破冰生效后真实计数 +1');

    host.remove();
    assert.equal(env.win.__musePerm.diag().activeShadows, 0, '已卸载的 ShadowRoot 必须被清理');
    console.log('[PASS] 4. Closed Shadow DOM 穿透、验成败真实计数与破冰重试通过');
}

// 5. RPC 引擎全测试：假 context 防护 + allow_always 降级 allow_once + 并发占坑防重 + 断连自愈 + 指数退避不拉黑
{
    const env = createEnv();
    const calls = [];
    let pendingList = [
        { approval_id: 'ap_perm', title: 'gmail.read' },
        { approval_id: 'ap_once_only', title: 'stripe.spend' },
        { approval_id: 'ap_slow', title: 'slow.action' },
    ];
    let dropOnce = true;

    const fakeCtx = {
        gatewayUrl: 'wss://gw.muse.ai',
        isReady: false,
        connectionState: 'connecting',
        connectionAuthority: { targetKey: 'tk-1' },
        ensureLiveConnection: async () => {},
        sendRequest: async (method, payload) => {
            calls.push({ method, payload });
            if (method === 'egress.approvals') {
                return { pending_approvals: pendingList };
            }
            if (method === 'egress.approval.decide') {
                if (payload.approval_id === 'ap_perm' && dropOnce) {
                    dropOnce = false;
                    throw new Error('HatchRpc not connected');
                }
                if (payload.approval_id === 'ap_once_only' && payload.decision === 'allow_always') {
                    throw new Error('400 invalid decision: allow_always not allowed for this action');
                }
                if (payload.approval_id === 'ap_slow') {
                    await new Promise((r) => setTimeout(r, 30));
                }
                pendingList = pendingList.filter((x) => x.approval_id !== payload.approval_id);
                return { ok: true };
            }
            if (method === 'egress.permissions') {
                return {
                    permissions: {
                        hitl_mode: 'full',
                        connectors: [
                            {
                                connector: 'gmail',
                                methods: { read: 'ask', send: 'ask' },
                                display: { actions: { read: { mode_options: ['allow', 'ask'] }, send: { mode_options: ['allow', 'ask'] } } },
                            },
                        ],
                    },
                };
            }
            return { ok: true };
        },
    };

    const appRoot = env.document.createElement('div');
    appRoot.setAttribute('id', '__next');
    appRoot.__reactFiber$mock = {
        return: null,
        dependencies: {
            firstContext: { memoizedValue: fakeCtx, next: null },
        },
        child: null,
        sibling: null,
    };
    env.body.appendChild(appRoot);

    env.runScript();
    await env.advance(1000);
    assert.equal(env.win.__musePerm.diag().rpcReady, false, '未就绪假 context 不得误判为 ready');
    assert.equal(calls.length, 0, '未就绪时不得盲发审批请求');

    fakeCtx.isReady = true;
    fakeCtx.connectionState = 'connected';
    await env.advance(2500);

    const permDecisions = calls.filter((c) => c.method === 'egress.approval.decide' && c.payload.approval_id === 'ap_perm');
    assert.deepEqual(permDecisions.map((c) => c.payload.decision), ['allow_always', 'allow_always']);

    const onceDecisions = calls.filter((c) => c.method === 'egress.approval.decide' && c.payload.approval_id === 'ap_once_only');
    assert.deepEqual(onceDecisions.map((c) => c.payload.decision), ['allow_always', 'allow_once']);

    const slowDecisions = calls.filter((c) => c.method === 'egress.approval.decide' && c.payload.approval_id === 'ap_slow');
    assert.equal(slowDecisions.length, 1);

    await new Promise((r) => setTimeout(r, 60));
    assert.equal(env.win.__musePerm.diag().rpcCount, 3, '3 项全部通过 RPC 真实批准');

    let flakyLeft = 9;
    pendingList = [{ approval_id: 'ap_flaky', title: 'flaky.op' }];
    const origSend = fakeCtx.sendRequest;
    fakeCtx.sendRequest = async (method, payload) => {
        if (method === 'egress.approval.decide' && payload.approval_id === 'ap_flaky' && flakyLeft > 0) {
            flakyLeft--;
            throw new Error('temporary gateway error 503');
        }
        return origSend(method, payload);
    };
    await env.advance(350_000);
    assert.equal(flakyLeft, 0, '失败 9 次后必须仍能重试到成功，绝不永久拉黑');
    assert.equal(env.win.__musePerm.diag().rpcCount, 4, '退避恢复后真实计数应为 4');

    const previewSafe = await env.win.__musePerm.allowEverything({ confirm: false });
    assert.equal(previewSafe.methods, 1, '默认应跳过高危 gmail.send，仅包含 gmail.read');
    const previewAll = await env.win.__musePerm.allowEverything({ confirm: false, includeRisky: true });
    assert.equal(previewAll.methods, 2, '传 includeRisky:true 时包含全部 2 项');
    console.log('[PASS] 5. RPC 假就绪防护、断连自愈、永久->单次自动降级与 RISKY 过滤通过');
}

// 6. 双引擎礼让协同测试（RPC 就绪时，DOM 礼让 450ms 防撞；非 RPC 卡片 450ms 后 DOM 果断接管）
{
    const env = createEnv();
    const fakeCtx = {
        gatewayUrl: 'wss://gw.muse.ai',
        isReady: true,
        connectionState: 'connected',
        ensureLiveConnection: async () => {},
        sendRequest: async (method) => (method === 'egress.approvals' ? { pending_approvals: [] } : { ok: true }),
    };
    const appRoot = env.document.createElement('div');
    appRoot.setAttribute('id', '__next');
    appRoot.__reactFiber$mock = {
        return: null,
        type: { _context: {} },
        memoizedProps: { value: fakeCtx },
    };
    env.body.appendChild(appRoot);

    env.runScript();
    await env.advance(1000);
    assert.equal(env.win.__musePerm.diag().rpcReady, true, 'Provider 路径 2 应成功识别 RPC');

    const card = env.document.createElement('div');
    const desc = env.document.createElement('div');
    desc.textContent = '允许 Muse 创建公开链接';
    const okBtn = env.document.createElement('button');
    okBtn.textContent = '允许';
    okBtn._onNativeClick = (b) => b.remove();
    card.appendChild(desc);
    card.appendChild(okBtn);
    env.body.appendChild(card);

    env.win.__musePerm.scanDom();
    await env.advance(200);
    assert.equal(okBtn.clickCount, 0, 'RPC 就绪时 DOM 应先礼让 450ms');

    await env.advance(700);
    assert.equal(okBtn.clickCount, 1, '450ms 后非 RPC 卡片必须由 DOM 接管点击');
    assert.equal(env.win.__musePerm.diag().domCount, 1);
    console.log('[PASS] 6. 双引擎礼让协同（Provider 识别 + 防撞 + 非 RPC 卡片接管）通过');
}

// 7. 多实例重复注入代际接管 + 不误杀新实例定时器 + 子 iframe postMessage 安全校验
{
    const env = createEnv();
    env.runScript();
    const gen1 = env.win.__musePerm.gen;
    env.runScript();
    const gen2 = env.win.__musePerm.gen;
    assert.equal(gen2, gen1 + 1);
    assert.equal(env.win.__musePerm.diag().isOwner, true);

    env.win.dispatchMessage('https://evil.com', { type: 'MUSE_AA_APPROVED', source: 'dom', detail: 'fake' });
    assert.equal(env.win.__musePerm.diag().count, 0, '非法 origin 消息不得增加计数');

    env.win.dispatchMessage('https://app.muse.ai', { type: 'MUSE_AA_APPROVED', source: 'dom', detail: '允许' });
    assert.equal(env.win.__musePerm.diag().count, 1, '合法 muse.ai 子域消息应正常计入');
    console.log('[PASS] 7. 多实例代际接管与跨帧 origin 安全校验通过');
}

// 8. 协议优先（v7.0.2 新增）：无任何 DOM 审批卡片时，协议线独立捞单并按 allow_always -> allow_once -> allow 批单，胶囊直显状态与批单时间
{
    const env = createEnv();
    const decisionsById = new Map();
    let pendingList = [
        { approval_id: 'upload_1', title: 'file.upload (always)' },
        { approval_id: 'upload_2', title: 'file.upload (once)' },
        { approval_id: 'upload_3', title: 'file.upload (allow)' },
    ];

    // 模拟 React 18 双缓冲陷阱：DOM 上挂的旧 Fiber 里 isReady=false，真正最新的树在 HostRoot.stateNode.current 上！
    const staleCtx = {
        gatewayUrl: 'wss://gw.muse.ai',
        isReady: false,
        connectionState: 'connecting',
        ensureLiveConnection: async () => {},
        sendRequest: async () => { throw new Error('stale ctx should not be used'); },
    };
    const liveCtx = {
        gatewayUrl: 'wss://gw.muse.ai',
        isReady: true,
        connectionState: 'connected',
        connectionAuthority: { targetKey: 'vm-live' },
        ensureLiveConnection: async () => {},
        sendRequest: async (method, payload) => {
            if (method === 'egress.approvals') {
                return { pending_approvals: pendingList };
            }
            if (method === 'egress.approval.decide') {
                const list = decisionsById.get(payload.approval_id) || [];
                list.push(payload.decision);
                decisionsById.set(payload.approval_id, list);

                if (payload.approval_id === 'upload_2' && payload.decision === 'allow_always') {
                    throw new Error('400 unsupported decision allow_always');
                }
                if (payload.approval_id === 'upload_3' && (payload.decision === 'allow_always' || payload.decision === 'allow_once')) {
                    throw new Error(`400 unsupported decision ${payload.decision}`);
                }
                pendingList = pendingList.filter((x) => x.approval_id !== payload.approval_id);
                return { ok: true };
            }
            return { ok: true };
        },
    };

    const currentHostRoot = {
        return: null,
        dependencies: { firstContext: { memoizedValue: liveCtx, next: null } },
        child: null,
        sibling: null,
    };
    const staleHostRoot = {
        return: null,
        stateNode: { current: currentHostRoot },
        dependencies: { firstContext: { memoizedValue: staleCtx, next: null } },
        child: null,
        sibling: null,
    };

    const appRoot = env.document.createElement('div');
    appRoot.setAttribute('id', '__next');
    appRoot.__reactFiber$mock = staleHostRoot;
    env.body.appendChild(appRoot);

    // 确认页面里没有任何按钮或审批卡片
    assert.equal(env.document.querySelectorAll('button').length, 0, '前置条件：页面无任何审批按钮');

    env.runScript();
    // 启动后主动查单，仅推进 200ms 协议线就应独立捞起并批完全部 3 单
    await env.advance(200);

    assert.deepEqual(decisionsById.get('upload_1'), ['allow_always'], '无卡单 1 应直接 allow_always');
    assert.deepEqual(decisionsById.get('upload_2'), ['allow_always', 'allow_once'], '无卡单 2 应降级 allow_once');
    assert.deepEqual(decisionsById.get('upload_3'), ['allow_always', 'allow_once', 'allow'], '无卡单 3 应降级 allow');

    const d = env.win.__musePerm.diag();
    assert.equal(d.rpcReady, true);
    assert.equal(d.rpcStatus, 'connected');
    assert.equal(d.rpcCount, 3, '无 DOM 卡时协议线必须独立完成 3 单');
    assert.equal(d.domCount, 0, '无 DOM 卡时 DOM 计数必须为 0');
    assert.ok(d.lastRpcApprovedAt > 0, '必须记录最近协议批单时间戳');
    assert.match(d.lastRpcApprovedTime, /^\d{2}:\d{2}:\d{2}$/, '必须格式化最近批单时钟时间');

    // 检查悬浮胶囊：收起态 100% 原版迷你样式（小圆点 + 自动 + 数字），绝不撑大，平时安静不弹错，悬停展开详情含协议状态与批单时间
    const badge = env.document.getElementById('muse-aa-badge-v7');
    assert.ok(badge, '必须存在悬浮胶囊');
    assert.match(badge.style.cssText, /padding:3px 9px/, '胶囊内边距必须与 v6.4.1 原版一致');
    assert.match(badge.style.cssText, /font-size:11px/, '胶囊字号必须与 v6.4.1 原版一致');
    assert.match(badge.style.cssText, /white-space:nowrap/, '胶囊必须不折行');
    assert.equal(badge.children.length, 3, '原版收起态仅 3 个子元素（圆点、自动/暂停、数字）');
    assert.equal(badge.children[0].style.background, '#a7f3d0', '协议已连时小圆点为原版薄荷绿');
    assert.equal(badge.textContent, '自动3', '收起态仅显示原版「自动 + 数字」，不得塞长文字撑大胶囊');
    assert.equal(env.document.getElementById('muse-aa-toast-v7'), null, '正常批单时必须安静，绝不弹提示');
    assert.match(badge.title, /协议已连接/, '悬停提示必须包含协议状态');
    assert.ok(badge.title.includes(d.lastRpcApprovedTime), '悬停提示必须包含最近协议批单时间');

    // 模拟悬停展开详情面板，检查完整 7.0.2 状态内容
    badge.dispatchEvent(new env.win.PointerEvent('pointerenter', {}));
    const detail = env.document.getElementById('muse-aa-detail-v7');
    assert.ok(detail && detail.style.display === 'block', '悬停胶囊必须展开详情面板');
    assert.match(detail.textContent, /协议状态：已连接/, '详情面板必须显示协议已连接');
    assert.ok(detail.textContent.includes(d.lastRpcApprovedTime), '详情面板必须显示最近协议批单时间');
    assert.match(detail.textContent, /累计批掉：3 次（协议 3 \/ 兜底 0）/, '详情面板必须显示协议与兜底明细');
    console.log('[PASS] 8. 协议优先：无 DOM 卡独立捞单批单、原版迷你胶囊与悬停详情通过');
}

// 9. 协议失败显式归因 + 退避不刷屏 + DOM 第二引擎按五档词表兜底 + 协议自动恢复
{
    const env = createEnv();
    let rpcMode = 'auth_fail'; // 先模拟 403 没权限失败，再模拟恢复
    let pollTimestamps = [];
    let pendingAfterRecover = [{ approval_id: 'after_recover_1', title: 'upload.after.recover' }];
    const decidedAfterRecover = [];

    const ctx = {
        gatewayUrl: 'wss://gw.muse.ai',
        isReady: true,
        connectionState: 'connected',
        ensureLiveConnection: async () => {},
        sendRequest: async (method, payload) => {
            if (method === 'egress.approvals') {
                pollTimestamps.push(env.win.Date.now());
                if (rpcMode === 'auth_fail') {
                    throw new Error('403 permission denied: egress token expired');
                }
                return { pending_approvals: pendingAfterRecover };
            }
            if (method === 'egress.approval.decide') {
                decidedAfterRecover.push(payload);
                pendingAfterRecover = pendingAfterRecover.filter((x) => x.approval_id !== payload.approval_id);
                return { ok: true };
            }
            return { ok: true };
        },
    };

    const appRoot = env.document.createElement('div');
    appRoot.setAttribute('id', '__next');
    appRoot.__reactFiber$mock = {
        return: null,
        dependencies: { firstContext: { memoizedValue: ctx, next: null } },
    };
    env.body.appendChild(appRoot);

    env.runScript();
    // 推进 200ms：首次协议 403 报错应立刻弹出错误提示，写明「协议线」与报错原文
    await env.advance(200);
    const toastOnErr = env.document.getElementById('muse-aa-toast-v7');
    assert.ok(toastOnErr, '协议线报错时必须弹出错误提示');
    assert.match(toastOnErr.textContent, /\[协议线\].*没权限.*403 permission denied: egress token expired/, '错误提示必须写明哪条线与原因');

    // 推进 4.6 秒后自动消失
    await env.advance(4600);
    assert.equal(env.document.getElementById('muse-aa-toast-v7'), null, '错误提示必须在几秒后自动消失');

    // 继续推进到总计 25 秒：验证退避拉长 + 显式报错原因 + 不刷屏
    await env.advance(20_200);

    const dFail = env.win.__musePerm.diag();
    // v7.0.6 新语义：权限类（403）响应不是传输断线，协议引擎保持在线，不因单类报错被打离线
    assert.equal(dFail.rpcReady, true, 'v7.0.6：权限类报错后协议引擎应保持在线');
    assert.equal(dFail.domFallbackActive, false, 'v7.0.6：协议保持在线时 DOM 兜底不处于激活态（出卡时仍会礼让 450ms 后接管）');
    assert.equal(dFail.rpcLastError.category, '没权限', '403 必须准确归类为「没权限」');
    assert.match(dFail.rpcLastError.raw, /403 permission denied: egress token expired/, '必须保留接口报错原文');

    // 验证退避拉长：25 秒内尝试次数应显著少于 1s 高频轮询（1.5+3+6+12=22.5s -> 约 5 次）
    assert.ok(pollTimestamps.length >= 3 && pollTimestamps.length <= 7, `退避重试次数应受控，实际=${pollTimestamps.length}`);
    assert.ok(pollTimestamps[2] - pollTimestamps[1] > pollTimestamps[1] - pollTimestamps[0], '重试间隔必须逐步拉长');

    // 验证显式日志但绝不刷屏
    const rpcWarns = env.logs.warn.filter((l) => l.includes('协议线异常'));
    assert.ok(rpcWarns.length >= 1 && rpcWarns.length <= 3, `日志应明确汇报且不刷屏，实际=${rpcWarns.length}`);
    assert.match(rpcWarns[0], /没权限.*403 permission denied: egress token expired/, '告警必须写明原因与报错原文');

    // 验证原版胶囊：收起态依然小巧（只含「自动 + 数字」），小圆点变柔琥珀色指示未连，悬停写明失败原因
    const badge = env.document.getElementById('muse-aa-badge-v7');
    assert.equal(badge.textContent, '自动0', '协议未连时收起态仍保持原版迷你大小不撑大');
    assert.equal(badge.children[0].style.background, '#a7f3d0', 'v7.0.6：权限类报错保持在线，小圆点仍为薄荷绿');
    assert.match(badge.title, /协议已连接/, 'v7.0.6：保持在线时胶囊悬停显示已连接（具体报错看 diag.rpcLastError 与日志）');

    // 悬停详情面板同样展示未连接状态与具体失败原因
    badge.dispatchEvent(new env.win.PointerEvent('pointerenter', {}));
    const detailFail = env.document.getElementById('muse-aa-detail-v7');
    assert.match(detailFail.textContent, /协议状态：已连接/, 'v7.0.6：详情面板显示保持在线');
    assert.equal(dFail.rpcLastError.raw, '403 permission denied: egress token expired', '报错原文保留在 diag 中可查');

    // 此时页面出现审批卡片（同时带 Tier2「始终允许此网站」与 Tier5「允许」），DOM 第二引擎必须立刻 0 礼让兜底并按 7.0.1 五档优先点 Tier2！
    const card = env.document.createElement('div');
    const denyBtn = env.document.createElement('button');
    denyBtn.textContent = '拒绝';
    const singleBtn = env.document.createElement('button');
    singleBtn.textContent = '允许';
    const siteAlwaysBtn = env.document.createElement('button');
    siteAlwaysBtn.textContent = '始终允许此网站';
    siteAlwaysBtn._onNativeClick = (b) => b.remove();
    card.appendChild(denyBtn);
    card.appendChild(singleBtn);
    card.appendChild(siteAlwaysBtn);
    env.body.appendChild(card);

    env.win.__musePerm.scanDom();
    await env.advance(900);
    assert.equal(siteAlwaysBtn.clickCount, 1, 'v7.0.6：协议保持在线时 DOM 第二引擎礼让 450ms 后接管，并按五档优先点「始终允许此网站」');
    assert.equal(singleBtn.clickCount, 0);
    assert.equal(env.win.__musePerm.diag().domCount, 1);

    // 模拟协议恢复：自动重连恢复小圆点为薄荷绿，并无卡独立批掉新单！
    rpcMode = 'ok';
    await env.advance(32_000);
    const dRecovered = env.win.__musePerm.diag();
    assert.equal(dRecovered.rpcReady, true, '协议恢复后必须自动切回已连接');
    assert.equal(dRecovered.rpcLastError, null, '恢复后错误应清空');
    assert.equal(decidedAfterRecover.length, 1, '恢复后必须独立捞起并批掉无卡新单');
    assert.equal(decidedAfterRecover[0].decision, 'allow_always');
    assert.equal(badge.children[0].style.background, '#a7f3d0', '恢复后小圆点切回原版薄荷绿');
    assert.equal(badge.textContent, '自动2', '恢复后胶囊保持原版迷你样式并准确显示累计 2 次');
    console.log('[PASS] 9. 协议失败显式报错/弹窗自动消失 + DOM 五档兜底 + 自动恢复通过');
}

console.log('\nALL 9 TEST SUITES PASSED!');
