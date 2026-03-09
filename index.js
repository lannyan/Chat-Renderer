/**
 * Chat Renderer — 在 ST 聊天訊息中安全渲染 CSS 與 JS
 *
 * CSS: 自動將 <style> 標籤作用域限定在該訊息內，防止樣式外洩
 * JS:  將 ```js-render 程式碼塊放入 sandbox iframe 中安全執行
 *
 * 不存取 API key、不修改 ST 核心設定、不發送任何外部請求
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

// ============================================================
//  CSS Scoping
//  把訊息中的 <style> 內容加上 selector 前綴，限制在該訊息內
// ============================================================
function scopeCSS(cssText, scopeSelector) {
    // 簡易 scope: 在每條規則前面加上 scopeSelector
    // 處理 @media / @keyframes 等 at-rules 時保留原樣內層
    const lines = cssText.split('\n');
    let result = '';
    let insideAtRule = 0;
    let insideKeyframes = false;

    for (const line of lines) {
        const trimmed = line.trim();

        // 偵測 @keyframes — 內部不 scope
        if (/^@keyframes\s/i.test(trimmed) || /^@-webkit-keyframes\s/i.test(trimmed)) {
            insideKeyframes = true;
            result += line + '\n';
            if (trimmed.includes('{')) insideAtRule++;
            continue;
        }

        // 偵測其他 at-rule (如 @media)
        if (/^@/.test(trimmed) && !insideKeyframes) {
            result += line + '\n';
            if (trimmed.includes('{')) insideAtRule++;
            continue;
        }

        // 追蹤大括號層級
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

        // 一般 selector 行 — 前面加 scope
        if (trimmed && !trimmed.startsWith('}') && !trimmed.startsWith('/*') &&
            trimmed.includes('{') && !trimmed.startsWith('@')) {
            const idx = line.indexOf('{');
            const selectorPart = line.substring(0, idx);
            const rest = line.substring(idx);
            // 處理多重 selector (逗號分隔)
            const scoped = selectorPart.split(',').map(sel => {
                sel = sel.trim();
                if (!sel) return sel;
                // :root 和 body 替換為 scope selector
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
        if (styleTag.dataset.crScoped) return; // 已處理
        const original = styleTag.textContent;
        const scoped = scopeCSS(original, scopeSelector);
        styleTag.textContent = scoped;
        styleTag.dataset.crScoped = 'true';
        log(`Scoped CSS in message #${mesId}`);
    });
}

// ============================================================
//  JS Sandbox
//  將 ```js-render 程式碼塊在 sandboxed iframe 中執行
// ============================================================
function createSandboxHTML(jsCode, width = '100%', height = 'auto') {
    // iframe 內部的完整 HTML
    // 提供 root 元素和基本樣式
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
  #root {
    width: 100%;
    min-height: 20px;
  }
</style>
</head>
<body>
<div id="root"></div>
<script>
(function() {
  const root = document.getElementById('root');

  // 自動回報高度給父頁面
  function reportHeight() {
    const h = document.body.scrollHeight || document.documentElement.scrollHeight;
    window.parent.postMessage({ type: 'cr-resize', height: h }, '*');
  }
  const resizeObserver = new ResizeObserver(reportHeight);
  resizeObserver.observe(document.body);

  // 錯誤處理
  window.onerror = function(msg, src, line, col, err) {
    const errDiv = document.createElement('div');
    errDiv.style.cssText = 'color:#ff6b6b;font-size:12px;padding:4px 8px;background:rgba(255,0,0,0.1);border-radius:4px;margin:4px 0;';
    errDiv.textContent = '⚠ ' + msg + (line ? ' (line ' + line + ')' : '');
    root.appendChild(errDiv);
    reportHeight();
  };

  try {
    ${jsCode}
  } catch(e) {
    const errDiv = document.createElement('div');
    errDiv.style.cssText = 'color:#ff6b6b;font-size:12px;padding:4px 8px;background:rgba(255,0,0,0.1);border-radius:4px;margin:4px 0;';
    errDiv.textContent = '⚠ ' + e.message;
    root.appendChild(errDiv);
  }

  // 初始回報
  setTimeout(reportHeight, 50);
  setTimeout(reportHeight, 300);
})();
<\/script>
</body>
</html>`;
}

function processMessageJS(mesElement) {
    const mesText = mesElement.querySelector('.mes_text');
    if (!mesText) return;

    // 尋找 language-js-render 的程式碼塊
    // 在 ST 中 ```js-render 會被渲染為 <pre><code class="language-js-render">
    const codeBlocks = mesText.querySelectorAll(
        'code.language-js-render, code.language-render-js, code.language-jsrender'
    );

    codeBlocks.forEach((codeBlock) => {
        const pre = codeBlock.closest('pre');
        if (!pre || pre.dataset.crProcessed) return;
        pre.dataset.crProcessed = 'true';

        const jsCode = codeBlock.textContent;
        const html = createSandboxHTML(jsCode);
        const blob = new Blob([html], { type: 'text/html' });
        const blobURL = URL.createObjectURL(blob);

        // 建立 iframe 容器
        const wrapper = document.createElement('div');
        wrapper.className = 'cr-sandbox-wrapper';

        const iframe = document.createElement('iframe');
        iframe.src = blobURL;
        iframe.sandbox = 'allow-scripts'; // 只允許腳本，不允許存取父頁面
        iframe.className = 'cr-sandbox-iframe';
        iframe.style.width = '100%';
        iframe.style.height = '60px'; // 初始高度
        iframe.style.border = 'none';
        iframe.style.display = 'block';
        iframe.setAttribute('loading', 'lazy');

        // 監聽 iframe 的高度回報
        const resizeHandler = (event) => {
            if (event.source === iframe.contentWindow && event.data?.type === 'cr-resize') {
                const newHeight = Math.min(event.data.height + 2, 800); // 最大 800px
                iframe.style.height = newHeight + 'px';
            }
        };
        window.addEventListener('message', resizeHandler);

        // 清理
        iframe.addEventListener('load', () => {
            URL.revokeObjectURL(blobURL);
        });

        wrapper.appendChild(iframe);
        pre.replaceWith(wrapper);

        const mesId = mesElement.getAttribute('mesid');
        log(`Sandboxed JS in message #${mesId}`);
    });
}

// ============================================================
//  也支援 css-render 程式碼塊
//  ```css-render 的內容會被提取並以 scoped style 注入
// ============================================================
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
//  Message Processing — 統一入口
// ============================================================
function processMessage(mesElement) {
    if (!enabled || processedMessages.has(mesElement)) return;
    processedMessages.add(mesElement);

    if (enableCSS) {
        processMessageCSS(mesElement);
        processMessageCSSBlocks(mesElement);
    }
    if (enableJS) {
        processMessageJS(mesElement);
    }
}

function processAllMessages() {
    const messages = document.querySelectorAll('#chat .mes');
    messages.forEach(processMessage);
}

// ============================================================
//  DOM 觀察 — 偵測新訊息
// ============================================================
let observer = null;

function startObserver() {
    const chat = document.getElementById('chat');
    if (!chat) {
        // chat 容器還沒出現，稍後重試
        setTimeout(startObserver, 1000);
        return;
    }

    if (observer) observer.disconnect();

    observer = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
            // 新增節點
            for (const node of mutation.addedNodes) {
                if (node.nodeType === Node.ELEMENT_NODE) {
                    if (node.classList?.contains('mes')) {
                        processMessage(node);
                    }
                    // 也檢查子節點中的 .mes
                    node.querySelectorAll?.('.mes')?.forEach(processMessage);
                }
            }
            // 內容變更 (如 swipe)
            if (mutation.type === 'childList' && mutation.target.classList?.contains('mes_text')) {
                const mes = mutation.target.closest('.mes');
                if (mes) {
                    processedMessages.delete(mes);
                    processMessage(mes);
                }
            }
        }
    });

    observer.observe(chat, {
        childList: true,
        subtree: true,
    });

    log('Observer started');
    // 處理已存在的訊息
    processAllMessages();
}

// ============================================================
//  Settings UI
// ============================================================
function loadSettings() {
    const stored = localStorage.getItem(`${MODULE_NAME}_settings`);
    if (stored) {
        try {
            const settings = JSON.parse(stored);
            enabled = settings.enabled ?? true;
            enableCSS = settings.enableCSS ?? true;
            enableJS = settings.enableJS ?? true;
        } catch (e) { /* ignore */ }
    }
}

function saveSettings() {
    localStorage.setItem(`${MODULE_NAME}_settings`, JSON.stringify({
        enabled, enableCSS, enableJS,
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
                        <span>CSS 渲染（style 標籤自動 scope）</span>
                    </label>
                    <label class="checkbox_label">
                        <input type="checkbox" id="cr_enable_js" ${enableJS ? 'checked' : ''}>
                        <span>JS 沙盒執行（js-render 程式碼塊）</span>
                    </label>
                    <hr>
                    <small class="cr-help-text">
                        <b>使用方式：</b><br>
                        CSS → 訊息中的 &lt;style&gt; 標籤會自動限定作用域<br>
                        CSS → 用 <code>\`\`\`css-render</code> 程式碼塊注入 scoped CSS<br>
                        JS → 用 <code>\`\`\`js-render</code> 程式碼塊在沙盒中執行<br>
                        JS 沙盒中可用 <code>root</code> 元素來顯示內容
                    </small>
                </div>
            </div>
        </div>
    </div>`;

    $('#extensions_settings2').append(html);

    $('#cr_enabled').on('change', function () {
        enabled = this.checked;
        saveSettings();
        if (enabled) {
            processAllMessages();
        }
    });
    $('#cr_enable_css').on('change', function () {
        enableCSS = this.checked;
        saveSettings();
    });
    $('#cr_enable_js').on('change', function () {
        enableJS = this.checked;
        saveSettings();
    });
}

// ============================================================
//  Init
// ============================================================
jQuery(async () => {
    loadSettings();
    createSettingsUI();
    startObserver();

    // 監聽 ST 的 chat 切換事件
    try {
        const context = SillyTavern.getContext();
        if (context?.eventSource && context?.event_types) {
            context.eventSource.on(context.event_types.CHAT_CHANGED, () => {
                log('Chat changed, reprocessing...');
                setTimeout(() => {
                    processAllMessages();
                }, 300);
            });
        }
    } catch (e) {
        log('Could not bind to ST events, relying on MutationObserver only');
    }

    log('Chat Renderer initialized');
});
