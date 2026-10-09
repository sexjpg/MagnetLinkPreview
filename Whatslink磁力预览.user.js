// ==UserScript==
// @name         Whatslink磁力预览
// @namespace    http://whatslink.info/
// @version      3.0.0
// @description  在磁力链接/ed2k链接后添加标识符号，通过点击或悬停显示完整链接信息；选中文本中包含磁力链接/磁力特征码/ed2k链接时在附近添加悬浮标志，悬停预览链接内容
// @author       sexjpg
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @connect      whatslink.info
// @require      https://cdn.jsdelivr.net/npm/qrcode@1.5.4/build/qrcode.min.js
// @match        *://*/*

// @noframes
// @run-at       document-end

// @license MIT

// @downloadURL https://update.greasyfork.org/scripts/544637/Whatslink%E7%A3%81%E5%8A%9B%E9%A2%84%E8%A7%88.user.js
// @updateURL https://update.greasyfork.org/scripts/544637/Whatslink%E7%A3%81%E5%8A%9B%E9%A2%84%E8%A7%88.meta.js
// ==/UserScript==

(function () {
    'use strict';

    const API_URL = 'https://whatslink.info/api/v1/link';

    const CONFIG = {
        delay: 500,                       // 悬浮延迟(ms)
        cacheTTL: 24 * 60 * 60 * 1000,    // 正缓存有效期(1 天)
        negCacheTTL: 10 * 60 * 1000,      // 负缓存有效期(10 min)
        maxCache: 500,                    // 缓存条目上限
        requestTimeout: 15000            // API 请求超时(ms)
    };

    const INDICATOR_HTML = '🧲';

    // ---------- 链接识别 ----------
    // magnet: btih 支持 40 位 hex 与 32 位 base32；btmh 支持 v2 多哈希
    const magnetRegex = /^magnet:\?xt=urn:(?:btih:([a-fA-F0-9]{40}|[A-Za-z2-7]{32})|btmh:([a-fA-F0-9]+))(?:&|$)/i;
    const ed2kRegex = /^ed2k:\/\/\|file\|([^|]+)\|(\d+)\|([0-9A-Fa-f]{32})\|/;
    const hex40Regex = /^[a-fA-F0-9]{40}$/; // 划选识别 btih 40hex

    function getLinkKey(link) {
        if (!link) return null;
        const m = magnetRegex.exec(link);
        if (m) return { type: 'magnet', id: (m[1] || m[2]).toLowerCase(), raw: link };
        const e = ed2kRegex.exec(link);
        if (e) return { type: 'ed2k', id: e[3].toLowerCase(), raw: link };
        return null;
    }

    // ---------- 缓存 ----------
    let magnetCache = GM_getValue('magnetCache', {});

    function persistCache() { GM_setValue('magnetCache', magnetCache); }

    function pruneCache() {
        const now = Date.now();
        let changed = false;
        for (const k in magnetCache) {
            const v = magnetCache[k];
            if (!v || (v.expiresAt && now > v.expiresAt)) { delete magnetCache[k]; changed = true; }
        }
        const keys = Object.keys(magnetCache);
        if (keys.length > CONFIG.maxCache) {
            keys.map(k => ({ k, exp: magnetCache[k].expiresAt || 0 }))
                .sort((a, b) => a.exp - b.exp)
                .slice(0, keys.length - CONFIG.maxCache)
                .forEach(it => { delete magnetCache[it.k]; changed = true; });
        }
        if (changed) persistCache();
    }
    pruneCache();

    function writeCache(cacheKey, entry) {
        magnetCache[cacheKey] = entry;
        if (Object.keys(magnetCache).length > CONFIG.maxCache) pruneCache();
        else persistCache();
    }

    function checkCache(link) {
        const k = getLinkKey(link);
        if (!k) return null;
        const cacheKey = k.type + ':' + k.id;
        const entry = magnetCache[cacheKey];
        if (!entry) return null;
        if (entry.expiresAt && Date.now() > entry.expiresAt) {
            delete magnetCache[cacheKey];
            persistCache();
            return null;
        }
        return entry;
    }

    // ---------- in-flight 去重 ----------
    const inflight = new Map();
    function fetchLinkInfo(link) {
        const k = getLinkKey(link);
        if (!k) return Promise.reject(new Error('不支持的链接'));
        const cacheKey = k.type + ':' + k.id;
        if (inflight.has(cacheKey)) return inflight.get(cacheKey);
        const p = new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'GET',
                url: `${API_URL}?url=${encodeURIComponent(link)}`,
                headers: { 'Referer': 'https://whatslink.info/' },
                timeout: CONFIG.requestTimeout,
                onload(res) {
                    if (res.status === 429) return reject(new Error('请求过于频繁，请稍后再试 (429)'));
                    if (res.status !== 200) return reject(new Error(`HTTP ${res.status}`));
                    let data;
                    try { data = JSON.parse(res.responseText); }
                    catch (e) { return reject(new Error('响应解析失败')); }
                    resolve(data);
                },
                onerror() { reject(new Error('网络请求失败')); },
                ontimeout() { reject(new Error('请求超时')); }
            });
        }).finally(() => inflight.delete(cacheKey));
        inflight.set(cacheKey, p);
        return p;
    }

    // ---------- 工具 ----------
    function esc(s) {
        const d = document.createElement('div');
        d.textContent = s == null ? '' : String(s);
        return d.innerHTML;
    }

    function formatFileSize(bytes) {
        if (bytes == null) return '未知大小';
        if (bytes === 0) return '0 Bytes';
        const k = 1024, sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    }

    // ---------- DOM: tooltip / modal ----------
    const tooltip = document.createElement('div');
    tooltip.style.cssText = `
    position: fixed; max-width: 400px; min-width: 300px; padding: 15px;
    background: rgba(0,0,0,0.95); color:#fff; border-radius:8px; font-size:14px;
    font-family: Arial, sans-serif; z-index: 9999; pointer-events: auto;
    word-break: break-all; opacity:0; transition: opacity .3s ease, transform .3s ease;
    transform: scale(.95); box-shadow: 0 4px 12px rgba(0,0,0,.4); display:none;`;

    const imageModal = document.createElement('div');
    imageModal.setAttribute('tabindex', '0');
    imageModal.style.cssText = `
    position: fixed; top:0; left:0; width:100%; height:100%;
    background: rgba(0,0,0,.9); display:none; justify-content:center; align-items:center;
    z-index:10000; cursor: zoom-out;`;

    const modalImage = document.createElement('img');
    modalImage.style.cssText = `max-width:90%; max-height:90%; object-fit:contain; cursor:auto;`;

    const prevButton = document.createElement('div');
    prevButton.style.cssText = `
    position:absolute; left:0; top:0; bottom:0; width:25vw;
    display:flex; align-items:center; justify-content:center;
    font-size:40px; color:#fff; cursor:pointer; user-select:none;
    z-index:10001; opacity:.3; transition: opacity .3s ease;`;
    const nextButton = prevButton.cloneNode();
    nextButton.style.right = '0';
    nextButton.style.left = '';

    [prevButton, nextButton].forEach(btn => {
        btn.addEventListener('mouseenter', () => btn.style.opacity = '0.7');
        btn.addEventListener('mouseleave', () => btn.style.opacity = '0.3');
    });

    imageModal.appendChild(prevButton);
    imageModal.appendChild(nextButton);
    imageModal.appendChild(modalImage);
    document.body.appendChild(imageModal);
    document.body.appendChild(tooltip);

    let currentScreenshots = [];
    let currentScreenshotIndex = 0;

    imageModal.addEventListener('click', (e) => {
        if (e.target === imageModal) imageModal.style.display = 'none';
    });
    prevButton.addEventListener('click', (e) => { e.stopPropagation(); showPrevImage(); });
    nextButton.addEventListener('click', (e) => { e.stopPropagation(); showNextImage(); });

    // 键盘左右切换 + Esc 关闭（document 级，modal 已 tabindex+focus）
    document.addEventListener('keydown', (e) => {
        if (imageModal.style.display === 'none' || imageModal.style.display === '') return;
        if (e.key === 'ArrowLeft') showPrevImage();
        else if (e.key === 'ArrowRight') showNextImage();
        else if (e.key === 'Escape') imageModal.style.display = 'none';
    });

    function updateNavigationButtons() {
        const show = currentScreenshots.length > 1;
        prevButton.style.display = show ? 'flex' : 'none';
        nextButton.style.display = show ? 'flex' : 'none';
    }
    function showPrevImage() {
        if (currentScreenshots.length === 0) return;
        currentScreenshotIndex = (currentScreenshotIndex - 1 + currentScreenshots.length) % currentScreenshots.length;
        modalImage.src = currentScreenshots[currentScreenshotIndex].screenshot;
    }
    function showNextImage() {
        if (currentScreenshots.length === 0) return;
        currentScreenshotIndex = (currentScreenshotIndex + 1) % currentScreenshots.length;
        modalImage.src = currentScreenshots[currentScreenshotIndex].screenshot;
    }

    function addScreenshotClickEvents(screenshots) {
        tooltip.querySelectorAll('.screenshot-item').forEach((item, index) => {
            item.addEventListener('click', (e) => {
                e.stopPropagation();
                currentScreenshots = screenshots;
                currentScreenshotIndex = index;
                modalImage.src = item.getAttribute('data-src');
                imageModal.style.display = 'flex';
                imageModal.focus();
                updateNavigationButtons();
            });
        });
    }

    // ---------- 渲染 ----------
    function renderMagnetInfo(data) {
        const shots = (data.screenshots || []).slice(0, 5);
        let html = `
            <div style="margin-bottom:10px;">
                <strong style="font-size:16px; word-break:break-word;">${esc(data.name) || '未知名称'}</strong>
            </div>
            <div id="magnet-qrcode" style="text-align:center; margin-top:10px;"></div>
            <div style="margin-bottom:8px;"><span>类型：</span><span style="color:#17a2b8;">${esc(data.type) || '未知类型'}</span></div>
            <div style="margin-bottom:8px;"><span>文件类型：</span><span style="color:#ffc107;">${esc(data.file_type) || '未知文件类型'}</span></div>
            <div style="margin-bottom:8px;"><span>大小：</span><span style="color:#28a745;">${esc(formatFileSize(data.size))}</span></div>
            <div style="margin-bottom:8px;"><span>文件数：</span><span style="color:#dc3545;">${esc(data.count) || 0}</span></div>`;
        if (shots.length) {
            html += `<div style="margin-top:15px; display:flex; flex-wrap:wrap; gap:5px;">`;
            shots.forEach(s => {
                const src = esc(s.screenshot);
                html += `<div class="screenshot-item" data-src="${src}" style="flex:1 1 45%; min-width:100px; cursor:zoom-in;">
                    <img src="${src}" loading="lazy" style="width:100%; border-radius:4px; box-shadow:0 2px 6px rgba(0,0,0,.3);">
                </div>`;
            });
            html += `</div>`;
        }
        return html;
    }

    function generateQrCode(link) {
        const el = tooltip.querySelector('#magnet-qrcode');
        if (!el || typeof QRCode === 'undefined') return;
        el.innerHTML = '';
        QRCode.toCanvas(link, { width: 128, margin: 1, errorCorrectionLevel: 'L' }, (err, canvas) => {
            if (err) { el.textContent = 'QR Code Error'; return; }
            canvas.style.width = '128px';
            canvas.style.height = '128px';
            el.appendChild(canvas);
        });
    }

    // ---------- tooltip 行为 ----------
    let tooltipHideTimer = null;
    let lastMouse = { x: 0, y: 0 };
    document.addEventListener('mousemove', (e) => { lastMouse.x = e.clientX; lastMouse.y = e.clientY; }, { passive: true });

    function hideTooltipSoon() {
        tooltipHideTimer = setTimeout(() => {
            tooltip.style.opacity = '0';
            tooltip.style.transform = 'scale(0.95)';
            setTimeout(() => { tooltip.style.display = 'none'; }, 300);
        }, CONFIG.delay);
    }

    // 监听器只注册一次（修复原版每链接/每次划选重复累积的泄漏）
    tooltip.addEventListener('mouseenter', () => { clearTimeout(tooltipHideTimer); });
    tooltip.addEventListener('mouseleave', hideTooltipSoon);

    let currentSeq = 0;

    function showTooltip(link, event) {
        const cached = checkCache(link);
        if (cached) {
            renderTooltip(cached.negative ? null : cached.data, link, event);
            return;
        }
        const seq = ++currentSeq;
        tooltip.innerHTML = '<div style="text-align:center; padding:10px;">加载中...</div>';
        tooltip.style.display = 'block';
        tooltip.style.opacity = '1';
        tooltip.style.transform = 'scale(1)';
        updateTooltipPosition(event);

        fetchLinkInfo(link).then(data => {
            const k = getLinkKey(link);
            const cacheKey = k.type + ':' + k.id;
            const isNegative = !data || data.error || (!data.file_type && data.type === 'UNKNOWN');
            writeCache(cacheKey, {
                data: isNegative ? null : data,
                negative: isNegative,
                expiresAt: Date.now() + (isNegative ? CONFIG.negCacheTTL : CONFIG.cacheTTL)
            });
            if (seq !== currentSeq) return; // 过期响应丢弃，避免覆盖新 tooltip
            renderTooltip(isNegative ? null : data, link, event);
        }).catch(err => {
            if (seq !== currentSeq) return;
            renderError(err.message, event);
        });
    }

    function renderTooltip(data, link, event) {
        if (!data) { renderError('暂无该链接的预览信息', event); return; }
        tooltip.innerHTML = renderMagnetInfo(data);
        addScreenshotClickEvents(data.screenshots || []);
        generateQrCode(link);
        tooltip.style.display = 'block';
        tooltip.style.opacity = '1';
        tooltip.style.transform = 'scale(1)';
        updateTooltipPosition(event || { clientX: lastMouse.x, clientY: lastMouse.y });
    }

    function renderError(msg, event) {
        tooltip.innerHTML = `<div style="color:#dc3545; text-align:center; padding:10px;">${esc(msg)}</div>`;
        tooltip.style.display = 'block';
        tooltip.style.opacity = '1';
        tooltip.style.transform = 'scale(1)';
        updateTooltipPosition(event || { clientX: lastMouse.x, clientY: lastMouse.y });
    }

    function updateTooltipPosition(e) {
        const rect = tooltip.getBoundingClientRect();
        const vw = window.innerWidth;
        let x = e.clientX + 15;
        let y = e.clientY - 15;
        if (x + rect.width > vw - 20) x = e.clientX - rect.width - 15;
        if (y < 0) y = e.clientY + 15; // 防止超出顶部
        tooltip.style.left = x + 'px';
        tooltip.style.top = y + 'px';
    }

    // ---------- 链接处理 ----------
    const indicatorStyle = `
        display:inline-block; width:16px; height:16px; background:#007bff;
        border-radius:50%; color:#fff; text-align:center; font-size:12px;
        margin-left:4px; cursor:progress; user-select:none; vertical-align:middle;
        transition: all .2s ease;`;

    function processLink(link) {
        if (link.dataset.magnetProcessed) return;
        const key = getLinkKey(link.href);
        if (!key) return;
        link.dataset.magnetProcessed = 'true';

        let timer = null;
        const indicator = document.createElement('span');
        indicator.innerHTML = INDICATOR_HTML;
        indicator.style.cssText = indicatorStyle;
        link.appendChild(indicator);

        indicator.addEventListener('mouseenter', (e) => {
            clearTimeout(tooltipHideTimer);
            timer = setTimeout(() => showTooltip(link.href, e), CONFIG.delay);
        });
        indicator.addEventListener('mouseleave', () => {
            clearTimeout(timer);
            hideTooltipSoon();
        });
        indicator.addEventListener('click', (e) => {
            e.preventDefault(); e.stopPropagation();
            clearTimeout(timer);
            showTooltip(link.href, e);
        });
    }

    // ---------- 选中文本 ----------
    function processSelectedText() {
        const selection = window.getSelection();
        if (!selection || selection.rangeCount === 0) return;
        const range = selection.getRangeAt(0);
        const text = range.toString().replace(/\s/g, '');
        if (!text) return;

        let processed = null;
        if (magnetRegex.test(text)) processed = text;
        else if (ed2kRegex.test(text)) processed = text;
        else if (hex40Regex.test(text)) processed = `magnet:?xt=urn:btih:${text}`;
        if (!processed) return;

        const old = document.getElementById('magnet-selection-indicator');
        if (old) old.remove();

        const indicator = document.createElement('span');
        indicator.id = 'magnet-selection-indicator';
        indicator.innerHTML = INDICATOR_HTML;
        const rect = range.getBoundingClientRect();
        indicator.style.cssText = indicatorStyle +
            `position:fixed; left:${rect.right + 5}px; top:${rect.top}px; z-index:99999;`;
        document.body.appendChild(indicator);

        let timer = null;
        let shownByThis = false;

        indicator.addEventListener('mouseenter', (e) => {
            clearTimeout(tooltipHideTimer);
            timer = setTimeout(() => { showTooltip(processed, e); shownByThis = true; }, CONFIG.delay);
        });
        indicator.addEventListener('mouseleave', () => {
            clearTimeout(timer);
            if (shownByThis) hideTooltipSoon();
        });
        indicator.addEventListener('click', (e) => {
            e.preventDefault(); e.stopPropagation();
            clearTimeout(timer);
            showTooltip(processed, e);
            shownByThis = true;
        });

        document.addEventListener('selectionchange', function remove() {
            const el = document.getElementById('magnet-selection-indicator');
            if (el) el.remove();
            document.removeEventListener('selectionchange', remove);
        }, { once: true });
    }

    // ---------- DOM 监听 + 启动 ----------
    function observeDOMChanges() {
        const observer = new MutationObserver(mutations => {
            for (const mutation of mutations) {
                for (const node of mutation.addedNodes) {
                    if (node.nodeType !== 1) continue;
                    if (node.tagName === 'A') processLink(node);
                    if (node.querySelectorAll) node.querySelectorAll('a').forEach(processLink);
                }
            }
        });
        observer.observe(document.body, { childList: true, subtree: true });
    }

    document.querySelectorAll('a').forEach(processLink);
    observeDOMChanges();
    document.addEventListener('mouseup', processSelectedText);
})();
