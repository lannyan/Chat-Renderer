/**
 * Chat Renderer — 在 ST 聊天訊息中安全渲染 CSS 與 JS
 *
 * CSS: 自動將 <style> 標籤作用域限定在該訊息內，防止樣式外洩
 * JS:  ```js-render  → 直接操作訊息 DOM（有安全防護）
 *      ```js-sandbox → 在 iframe 沙盒中執行（完全隔離）
 *
 * 安全措施：
 *   - JS 執行時遮蔽危險 API（fetch, XMLHttpRequest, WebSocket, eval 等）
 *   - JS 作用域限定在該訊息的 .mes_text 內
 *   - 不可存取 ST 核心物件、API key、localStorage
 *   - CSS 自動 scope 到訊息內
 */

const MODULE_NAME = 'chat-renderer';
const DEBUG = false;

function log(...args) {
    if (DEBUG) console.log(`[${MODULE_NAME}]`, ...args);
}

// ============================================================
//  State
// ============================================================
const processedMessages = new WeakSet();
let enabled = true;
let enableCSS = true;
let enableJS = true;
let autoRenderHTML = true;
let enableChoices = true; // 劇情選項點擊貼上

// ============================================================
//  CSS Scoping
// ============================================================
function scopeCSS(cssText, scopeSelector) {
    const lines = cssText.split('\n');
    let result = '';
    let insideAtRule = 0;
    let insideKeyframes = false;

    for (const line of lines) {
        const trimmed = line.trim();

        if (/^@keyframes\s/i.test(trimmed) || /^@-webkit-keyframes\s/i.test(trimmed)) {
            insideKeyframes = true;
            result += line + '\n';
            if (trimmed.includes('{')) insideAtRule++;
            continue;
        }

        if (/^@/.test(trimmed) && !insideKeyframes) {
            result += line + '\n';
            if (trimmed.includes('{')) insideAtRule++;
            continue;
        }

        const opens = (line.match(/{/g) || []).length;
        const closes = (line.match(/}/g) || []).length;

        if (insideKeyframes) {
            result += line + '\n';
            insideAtRule += opens - closes;
            if (insideAtRule <= 0) {
                insideKeyframes = false;
                insideAtRule = 0;
            }
            continue;
        }

        if (trimmed && !trimmed.startsWith('}') && !trimmed.startsWith('/*') &&
            trimmed.includes('{') && !trimmed.startsWith('@')) {
            const idx = line.indexOf('{');
            const selectorPart = line.substring(0, idx);
            const rest = line.substring(idx);
            const scoped = selectorPart.split(',').map(sel => {
                sel = sel.trim();
                if (!sel) return sel;
                if (sel === ':root' || sel === 'body' || sel === 'html') {
                    return scopeSelector;
                }
                return `${scopeSelector} ${sel}`;
            }).join(', ');
            result += scoped + ' ' + rest + '\n';
        } else {
            result += line + '\n';
        }

        insideAtRule += opens - closes;
    }

    return result;
}

function processMessageCSS(mesElement) {
    const mesText = mesElement.querySelector('.mes_text');
    if (!mesText) return;

    const styleTags = mesText.querySelectorAll('style');
    if (styleTags.length === 0) return;

    const mesId = mesElement.getAttribute('mesid');
    const scopeSelector = `.mes[mesid="${mesId}"] .mes_text`;

    styleTags.forEach((styleTag) => {
        if (styleTag.dataset.crScoped) return;
        const original = styleTag.textContent;
        const scoped = scopeCSS(original, scopeSelector);
        styleTag.textContent = scoped;
        styleTag.dataset.crScoped = 'true';
        log(`Scoped CSS in message #${mesId}`);
    });
}

function processMessageCSSBlocks(mesElement) {
    const mesText = mesElement.querySelector('.mes_text');
    if (!mesText) return;

    const codeBlocks = mesText.querySelectorAll(
        'code.language-css-render, code.language-render-css, code.language-cssrender'
    );

    const mesId = mesElement.getAttribute('mesid');
    const scopeSelector = `.mes[mesid="${mesId}"] .mes_text`;

    codeBlocks.forEach((codeBlock) => {
        const pre = codeBlock.closest('pre');
        if (!pre || pre.dataset.crProcessed) return;
        pre.dataset.crProcessed = 'true';

        const cssText = codeBlock.textContent;
        const scoped = scopeCSS(cssText, scopeSelector);

        const styleEl = document.createElement('style');
        styleEl.dataset.crScoped = 'true';
        styleEl.textContent = scoped;

        pre.replaceWith(styleEl);
        log(`Injected scoped CSS block in message #${mesId}`);
    });
}

// ============================================================
//  JS Direct DOM Execution（直接操作訊息 DOM，有安全防護）
//  用於 ```js-render
// ============================================================

/**
 * 建立被封鎖的危險 API 清單
 */
function createBlockedGlobals() {
    const blocked = () => {
        throw new Error('[Chat Renderer] 此 API 在訊息腳本中被禁止使用');
    };
    const blockedObj = new Proxy({}, {
        get: () => blocked,
        set: () => false,
    });

    return {
        // 網路請求
        fetch: blocked,
        XMLHttpRequest: blocked,
        WebSocket: blocked,
        EventSource: blocked,
        Request: blocked,
        Response: blocked,
        Headers: blocked,

        // 危險的動態執行
        eval: blocked,
        Function: blocked,
        importScripts: blocked,

        // 儲存（防止偷 API key 等）
        localStorage: blockedObj,
        sessionStorage: blockedObj,
        indexedDB: blockedObj,
        caches: blockedObj,

        // 防止存取 ST 核心
        SillyTavern: blockedObj,
        jQuery: blocked,
        $: blocked,

        // 防止導航 / 存取其他視窗
        open: blocked,
        close: blocked,
        parent: undefined,
        top: undefined,
        frames: undefined,
        opener: undefined,
    };
}

/**
 * 建立限定在 root 內的安全 document 代理
 */
function createSafeDocument(root) {
    return {
        createElement: (tag) => document.createElement(tag),
        createTextNode: (text) => document.createTextNode(text),
        createDocumentFragment: () => document.createDocumentFragment(),
        createComment: (text) => document.createComment(text),
        createElementNS: (ns, tag) => document.createElementNS(ns, tag),

        // 查詢限定在 root 內
        querySelector: (sel) => root.querySelector(sel),
        querySelectorAll: (sel) => root.querySelectorAll(sel),
        getElementById: (id) => root.querySelector(`#${CSS.escape(id)}`),
        getElementsByClassName: (cls) => root.getElementsByClassName(cls),
        getElementsByTagName: (tag) => root.getElementsByTagName(tag),

        get body() { return root; },
        get documentElement() { return root; },
    };
}

/**
 * 在訊息 DOM 中直接執行 JS
 */
function executeDirectJS(jsCode, mesElement) {
    const mesText = mesElement.querySelector('.mes_text');
    if (!mesText) return null;

    const mesId = mesElement.getAttribute('mesid');

    // 建立 root 容器
    const root = document.createElement('div');
    root.className = 'cr-direct-root';
    root.dataset.crMesid = mesId;

    // 安全環境
    const blockedGlobals = createBlockedGlobals();
    const safeDoc = createSafeDocument(root);

    // 允許的全域 API（白名單）
    const allowedGlobals = {
        console: {
            log: (...a) => console.log(`[CR #${mesId}]`, ...a),
            warn: (...a) => console.warn(`[CR #${mesId}]`, ...a),
            error: (...a) => console.error(`[CR #${mesId}]`, ...a),
            info: (...a) => console.info(`[CR #${mesId}]`, ...a),
        },

        // 計時器
        setTimeout,
        setInterval,
        clearTimeout,
        clearInterval,
        requestAnimationFrame,
        cancelAnimationFrame,

        // 基本型別與工具
        Math, Date, JSON, Number, String, Boolean, Array, Object,
        Map, Set, WeakMap, WeakSet, Symbol, Promise, RegExp, Proxy,
        Error, TypeError, RangeError, SyntaxError, ReferenceError, URIError,
        parseInt, parseFloat, isNaN, isFinite, NaN, Infinity, undefined,
        encodeURIComponent, decodeURIComponent, encodeURI, decodeURI,
        btoa, atob, structuredClone,

        // Canvas / 繪圖
        CanvasRenderingContext2D: window.CanvasRenderingContext2D,
        CanvasGradient: window.CanvasGradient,
        CanvasPattern: window.CanvasPattern,
        Path2D: window.Path2D,
        ImageData: window.ImageData,
        DOMMatrix: window.DOMMatrix,
        DOMPoint: window.DOMPoint,
        DOMRect: window.DOMRect,

        // DOM 相關（安全子集）
        Element, HTMLElement, Node, NodeList, HTMLCollection: window.HTMLCollection,
        Event, CustomEvent, MouseEvent, KeyboardEvent,
        TouchEvent: window.TouchEvent,
        PointerEvent: window.PointerEvent,
        AnimationEvent: window.AnimationEvent,
        TransitionEvent: window.TransitionEvent,
        MutationObserver, ResizeObserver, IntersectionObserver,
        CSSStyleDeclaration: window.CSSStyleDeclaration,
        DOMTokenList: window.DOMTokenList,
        CSS: window.CSS,
        getComputedStyle: (el) => window.getComputedStyle(el),

        // 媒體
        Image, Audio,
        AudioContext: window.AudioContext,

        // 關鍵：使用者的操作對象
        root,
        document: safeDoc,
    };

    // 合併：blocked 先，allowed 覆蓋
    const scope = { ...blockedGlobals, ...allowedGlobals };

    // Proxy 攔截所有變數存取
    const scopeProxy = new Proxy(scope, {
        has: () => true,
        get: (target, prop) => {
            if (prop === Symbol.unscopables) return undefined;
            if (prop in target) return target[prop];
            return undefined;
        },
        set: (target, prop, value) => {
            target[prop] = value;
            return true;
        },
    });

    try {
        const wrappedCode = `
            "use strict";
            return (async function(scope) {
                with(scope) {
                    ${jsCode}
                }
            })
        `;

        const factory = new Function(wrappedCode)();
        factory(scopeProxy).catch(err => {
            showError(root, err.message);
            console.error(`[CR #${mesId}] Async error:`, err);
        });
    } catch (err) {
        showError(root, err.message);
        console.error(`[CR #${mesId}] Error:`, err);
    }

    return root;
}

function showError(container, message) {
    const errDiv = document.createElement('div');
    errDiv.style.cssText = 'color:#ff6b6b;font-size:12px;padding:4px 8px;background:rgba(255,0,0,0.1);border-radius:4px;margin:4px 0;font-family:monospace;';
    errDiv.textContent = '\u26a0 ' + message;
    container.appendChild(errDiv);
}

// ============================================================
//  JS Iframe Sandbox（完全隔離模式）
//  用於 ```js-sandbox
// ============================================================
function createSandboxHTML(jsCode) {
    return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  *, *::before, *::after { box-sizing: border-box; }
  html, body {
    margin: 0; padding: 0;
    background: transparent;
    color: inherit;
    font-family: inherit;
    overflow: hidden;
  }
  #root { width: 100%; min-height: 20px; }
</style>
</head>
<body>
<div id="root"></div>
<script>
(function() {
  const root = document.getElementById('root');

  function reportHeight() {
    const h = document.body.scrollHeight || document.documentElement.scrollHeight;
    window.parent.postMessage({ type: 'cr-resize', height: h }, '*');
  }
  const ro = new ResizeObserver(reportHeight);
  ro.observe(document.body);

  window.onerror = function(msg, src, line) {
    const d = document.createElement('div');
    d.style.cssText = 'color:#ff6b6b;font-size:12px;padding:4px 8px;background:rgba(255,0,0,0.1);border-radius:4px;margin:4px 0;';
    d.textContent = '\\u26a0 ' + msg + (line ? ' (line ' + line + ')' : '');
    root.appendChild(d);
    reportHeight();
  };

  try {
    ${jsCode}
  } catch(e) {
    const d = document.createElement('div');
    d.style.cssText = 'color:#ff6b6b;font-size:12px;padding:4px 8px;background:rgba(255,0,0,0.1);border-radius:4px;margin:4px 0;';
    d.textContent = '\\u26a0 ' + e.message;
    root.appendChild(d);
  }

  setTimeout(reportHeight, 50);
  setTimeout(reportHeight, 300);
})();
<\/script>
</body>
</html>`;
}

function processIframeSandbox(pre, mesElement) {
    const codeBlock = pre.querySelector('code');
    const jsCode = codeBlock.textContent;
    const html = createSandboxHTML(jsCode);
    const blob = new Blob([html], { type: 'text/html' });
    const blobURL = URL.createObjectURL(blob);

    const wrapper = document.createElement('div');
    wrapper.className = 'cr-sandbox-wrapper';

    const iframe = document.createElement('iframe');
    iframe.src = blobURL;
    iframe.sandbox = 'allow-scripts';
    iframe.className = 'cr-sandbox-iframe';
    iframe.style.width = '100%';
    iframe.style.height = '60px';
    iframe.style.border = 'none';
    iframe.style.display = 'block';
    iframe.setAttribute('loading', 'lazy');

    const resizeHandler = (event) => {
        if (event.source === iframe.contentWindow && event.data?.type === 'cr-resize') {
            iframe.style.height = Math.min(event.data.height + 2, 800) + 'px';
        }
    };
    window.addEventListener('message', resizeHandler);

    iframe.addEventListener('load', () => URL.revokeObjectURL(blobURL));

    wrapper.appendChild(iframe);
    pre.replaceWith(wrapper);
    log(`Iframe sandboxed JS in message #${mesElement.getAttribute('mesid')}`);
}

// ============================================================
//  HTML Render（完整 HTML 頁面渲染到 iframe）
//  用於 ```html-render
// ============================================================
function injectResizeReporter(htmlCode) {
    // 修正 CSS：避免 vh/vw 在 iframe 中造成無限循環
    // 覆寫 html/body 的 viewport-relative 高度為自適應
    const fixCSS = `
<style data-cr-fix>
  html, body {
    min-height: auto !important;
    height: auto !important;
    overflow: visible !important;
  }
</style>`;

    const script = `
<script>
(function() {
  function getContentHeight() {
    // 精確計算實際內容高度（不含 vh 導致的膨脹）
    var children = document.body.children;
    var maxBottom = 0;
    for (var i = 0; i < children.length; i++) {
      var el = children[i];
      if (el.tagName === 'SCRIPT' || el.tagName === 'STYLE') continue;
      var rect = el.getBoundingClientRect();
      var style = getComputedStyle(el);
      var mb = parseFloat(style.marginBottom) || 0;
      var bottom = rect.top + rect.height + mb;
      if (bottom > maxBottom) maxBottom = bottom;
    }
    // 加上 body padding
    var bodyStyle = getComputedStyle(document.body);
    var pt = parseFloat(bodyStyle.paddingTop) || 0;
    return Math.ceil(maxBottom + pt + 10);
  }

  function reportHeight() {
    var h = Math.max(getContentHeight(), 60);
    window.parent.postMessage({ type: 'cr-resize', height: h }, '*');
  }

  if (window.ResizeObserver) {
    new ResizeObserver(reportHeight).observe(document.body);
  }
  window.addEventListener('load', function() {
    reportHeight();
    setTimeout(reportHeight, 100);
    setTimeout(reportHeight, 500);
    setTimeout(reportHeight, 1500);
  });
  reportHeight();
  setTimeout(reportHeight, 50);
  setTimeout(reportHeight, 300);
})();
<\/script>`;

    // 注入修正 CSS 到 <head> 裡
    let result = htmlCode;
    if (result.includes('</head>')) {
        result = result.replace('</head>', fixCSS + '\n</head>');
    } else if (result.includes('<body')) {
        result = result.replace('<body', fixCSS + '\n<body');
    } else {
        result = fixCSS + '\n' + result;
    }

    // 注入 resize reporter 腳本
    if (result.includes('</body>')) {
        return result.replace('</body>', script + '\n</body>');
    }
    if (result.includes('</html>')) {
        return result.replace('</html>', script + '\n</html>');
    }
    return result + script;
}

function processHTMLRender(pre, mesElement) {
    const codeBlock = pre.querySelector('code');
    const htmlCode = injectResizeReporter(codeBlock.textContent);
    const blob = new Blob([htmlCode], { type: 'text/html' });
    const blobURL = URL.createObjectURL(blob);

    const wrapper = document.createElement('div');
    wrapper.className = 'cr-html-wrapper';

    const iframe = document.createElement('iframe');
    iframe.src = blobURL;
    iframe.sandbox = 'allow-scripts';
    iframe.className = 'cr-html-iframe';
    iframe.style.width = '100%';
    iframe.style.height = '200px'; // 初始高度較大，因為是完整頁面
    iframe.style.border = 'none';
    iframe.style.display = 'block';
    iframe.style.borderRadius = '8px';
    iframe.setAttribute('loading', 'lazy');

    const resizeHandler = (event) => {
        if (event.source === iframe.contentWindow && event.data?.type === 'cr-resize') {
            const newHeight = Math.min(Math.max(event.data.height + 2, 60), 2000);
            iframe.style.height = newHeight + 'px';
        }
    };
    window.addEventListener('message', resizeHandler);

    iframe.addEventListener('load', () => URL.revokeObjectURL(blobURL));

    wrapper.appendChild(iframe);
    pre.replaceWith(wrapper);
    log(`HTML rendered in message #${mesElement.getAttribute('mesid')}`);
}

// ============================================================
//  JS Processing
// ============================================================
function processMessageJS(mesElement) {
    const mesText = mesElement.querySelector('.mes_text');
    if (!mesText) return;

    // ```js-render → 直接操作 DOM（封鎖危險 API）
    const directBlocks = mesText.querySelectorAll(
        'code.language-js-render, code.language-render-js, code.language-jsrender'
    );
    directBlocks.forEach((codeBlock) => {
        const pre = codeBlock.closest('pre');
        if (!pre || pre.dataset.crProcessed) return;
        pre.dataset.crProcessed = 'true';

        const jsCode = codeBlock.textContent;
        const root = executeDirectJS(jsCode, mesElement);
        if (root) pre.replaceWith(root);
    });

    // ```js-sandbox → iframe 完全隔離
    const sandboxBlocks = mesText.querySelectorAll(
        'code.language-js-sandbox, code.language-sandbox-js, code.language-jssandbox'
    );
    sandboxBlocks.forEach((codeBlock) => {
        const pre = codeBlock.closest('pre');
        if (!pre || pre.dataset.crProcessed) return;
        pre.dataset.crProcessed = 'true';
        processIframeSandbox(pre, mesElement);
    });
}

// ============================================================
//  HTML Processing（獨立於 JS）
// ============================================================
function isHTMLContent(text) {
    const trimmed = text.trim().toLowerCase();
    return trimmed.startsWith('<!doctype html') ||
           trimmed.startsWith('<html') ||
           (trimmed.includes('<head') && trimmed.includes('<body'));
}

function isHTMLCodeBlock(codeElement) {
    const cls = codeElement.className || '';
    // 明確的 html-render 標記
    if (/language-(html-render|render-html|htmlrender)/i.test(cls)) return true;
    // autoRenderHTML 開啟時，匹配各種 html class 變體
    if (autoRenderHTML) {
        // 匹配 language-html, language-markup, hljs + html 等
        if (/language-html|language-markup/i.test(cls)) return true;
        if (/\bhtml\b/i.test(cls)) return true;
        // 沒有特定 language class 但內容是完整 HTML 頁面
        if (isHTMLContent(codeElement.textContent)) return true;
    }
    return false;
}

function processMessageHTML(mesElement) {
    const mesText = mesElement.querySelector('.mes_text');
    if (!mesText) return;

    // 掃描所有 pre > code 程式碼塊
    const allCodeBlocks = mesText.querySelectorAll('pre > code');
    allCodeBlocks.forEach((codeBlock) => {
        const pre = codeBlock.closest('pre');
        if (!pre || pre.dataset.crProcessed) return;

        if (isHTMLCodeBlock(codeBlock)) {
            pre.dataset.crProcessed = 'true';
            processHTMLRender(pre, mesElement);
        }
    });
}

// ============================================================
//  Clickable Choices（劇情選項點擊貼上）
//  只在最後一則 AI 訊息的最後一個 <ol> 生效
//  點擊後自動貼到 ST 的輸入框
// ============================================================
let choicesAbortController = null;

function processAllChoices() {
    // 清除舊的 — 用 AbortController 取消事件，不動 DOM
    if (choicesAbortController) {
        choicesAbortController.abort();
    }
    document.querySelectorAll('li.cr-choice').forEach((li) => {
        li.classList.remove('cr-choice', 'cr-choice-selected');
        li.title = '';
    });
    document.querySelectorAll('.cr-choices-list').forEach((ol) => {
        ol.classList.remove('cr-choices-list');
    });

    if (!enabled || !enableChoices) return;

    choicesAbortController = new AbortController();
    const signal = choicesAbortController.signal;

    // 找最後一則 AI 訊息（不是 user 的 .mes）
    const allMessages = document.querySelectorAll('#chat .mes:not([is_user="true"])');
    if (allMessages.length === 0) return;
    const lastAiMsg = allMessages[allMessages.length - 1];

    const mesText = lastAiMsg.querySelector('.mes_text');
    if (!mesText) return;

    // 找該訊息裡最後一個 <ol>
    const allOl = mesText.querySelectorAll('ol');
    if (allOl.length === 0) return;
    const lastOl = allOl[allOl.length - 1];

    // 只處理這個 <ol> 裡的 <li>
    const listItems = lastOl.querySelectorAll('li');
    if (listItems.length === 0) return;

    lastOl.classList.add('cr-choices-list');

    listItems.forEach((li) => {
        li.classList.add('cr-choice');
        li.title = '點擊貼上此選項';

        li.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();

            const choiceText = li.textContent.trim();

            const textarea = document.querySelector('#send_textarea');
            if (!textarea) {
                log('Cannot find #send_textarea');
                return;
            }

            textarea.value = choiceText;
            textarea.dispatchEvent(new Event('input', { bubbles: true }));
            textarea.focus();

            li.classList.add('cr-choice-selected');
            setTimeout(() => li.classList.remove('cr-choice-selected'), 600);

            log(`Choice pasted: ${choiceText.substring(0, 30)}...`);
        }, { signal });
    });
}

// ============================================================
//  Message Processing
// ============================================================
function processMessage(mesElement) {
    if (!enabled) return;

    const isNew = !processedMessages.has(mesElement);
    if (isNew) {
        processedMessages.add(mesElement);
        if (enableCSS) {
            processMessageCSS(mesElement);
            processMessageCSSBlocks(mesElement);
        }
        if (enableJS) {
            processMessageJS(mesElement);
        }
    }

    // HTML 每次都重新掃描
    processMessageHTML(mesElement);
}
}

function processAllMessages() {
    const messages = document.querySelectorAll('#chat .mes');
    messages.forEach(processMessage);
    processAllChoices();
}

// 延遲重掃 — 等 highlight.js 等工具加完 class 後再試一次
function scheduleRescan() {
    setTimeout(() => {
        const messages = document.querySelectorAll('#chat .mes');
        messages.forEach(mes => processMessageHTML(mes));
    }, 500);
    setTimeout(() => {
        const messages = document.querySelectorAll('#chat .mes');
        messages.forEach(mes => processMessageHTML(mes));
    }, 1500);
}

// ============================================================
//  DOM Observer
// ============================================================
let observer = null;

function startObserver() {
    const chat = document.getElementById('chat');
    if (!chat) {
        setTimeout(startObserver, 1000);
        return;
    }

    if (observer) observer.disconnect();

    observer = new MutationObserver((mutations) => {
        let hasNewMessages = false;
        for (const mutation of mutations) {
            for (const node of mutation.addedNodes) {
                if (node.nodeType === Node.ELEMENT_NODE) {
                    if (node.classList?.contains('mes')) {
                        processMessage(node);
                        hasNewMessages = true;
                    }
                    const subMes = node.querySelectorAll?.('.mes');
                    if (subMes?.length) {
                        subMes.forEach(processMessage);
                        hasNewMessages = true;
                    }
                }
            }
            if (mutation.type === 'childList' && mutation.target.classList?.contains('mes_text')) {
                const mes = mutation.target.closest('.mes');
                if (mes) {
                    processedMessages.delete(mes);
                    processMessage(mes);
                    hasNewMessages = true;
                }
            }
        }
        // 有新訊息時延遲重掃（等 highlight.js 加完 class）
        if (hasNewMessages) {
            scheduleRescan();
            processAllChoices();
        }
    });

    observer.observe(chat, { childList: true, subtree: true });
    log('Observer started');
    processAllMessages();
    scheduleRescan();
}

// ============================================================
//  Settings UI
// ============================================================
function loadSettings() {
    const stored = localStorage.getItem(`${MODULE_NAME}_settings`);
    if (stored) {
        try {
            const s = JSON.parse(stored);
            enabled = s.enabled ?? true;
            enableCSS = s.enableCSS ?? true;
            enableJS = s.enableJS ?? true;
            autoRenderHTML = s.autoRenderHTML ?? true;
            enableChoices = s.enableChoices ?? true;
        } catch (e) { /* ignore */ }
    }
}

function saveSettings() {
    localStorage.setItem(`${MODULE_NAME}_settings`, JSON.stringify({
        enabled, enableCSS, enableJS, autoRenderHTML, enableChoices,
    }));
}

function createSettingsUI() {
    const html = `
    <div class="cr-settings" id="cr-settings">
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>Chat Renderer</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <div class="flex-container flexFlowColumn">
                    <label class="checkbox_label">
                        <input type="checkbox" id="cr_enabled" ${enabled ? 'checked' : ''}>
                        <span>啟用 Chat Renderer</span>
                    </label>
                    <label class="checkbox_label">
                        <input type="checkbox" id="cr_enable_css" ${enableCSS ? 'checked' : ''}>
                        <span>CSS 渲染</span>
                    </label>
                    <label class="checkbox_label">
                        <input type="checkbox" id="cr_enable_js" ${enableJS ? 'checked' : ''}>
                        <span>JS 執行</span>
                    </label>
                    <label class="checkbox_label">
                        <input type="checkbox" id="cr_auto_html" ${autoRenderHTML ? 'checked' : ''}>
                        <span>HTML 渲染</span>
                    </label>
                    <label class="checkbox_label">
                        <input type="checkbox" id="cr_choices" ${enableChoices ? 'checked' : ''}>
                        <span>劇情選項點擊貼上</span>
                    </label>
                </div>
            </div>
        </div>
    </div>`;

    $('#extensions_settings2').append(html);

    $('#cr_enabled').on('change', function () {
        enabled = this.checked;
        saveSettings();
        if (enabled) processAllMessages();
    });
    $('#cr_enable_css').on('change', function () {
        enableCSS = this.checked;
        saveSettings();
    });
    $('#cr_enable_js').on('change', function () {
        enableJS = this.checked;
        saveSettings();
    });
    $('#cr_auto_html').on('change', function () {
        autoRenderHTML = this.checked;
        saveSettings();
    });
    $('#cr_choices').on('change', function () {
        enableChoices = this.checked;
        saveSettings();
        processAllChoices();
    });
}

// ============================================================
//  Init
// ============================================================
jQuery(async () => {
    loadSettings();
    createSettingsUI();
    startObserver();

    try {
        const context = SillyTavern.getContext();
        if (context?.eventSource && context?.event_types) {
            context.eventSource.on(context.event_types.CHAT_CHANGED, () => {
                log('Chat changed, reprocessing...');
                setTimeout(() => {
                    processAllMessages();
                    scheduleRescan();
                }, 300);
            });
        }
    } catch (e) {
        log('Could not bind to ST events, relying on MutationObserver only');
    }

    log('Chat Renderer initialized');
});
