# Chat-Renderer

A minimal SillyTavern extension that renders CSS, JS, and HTML inside chat messages.

No server plugin required. No external dependencies. No outbound requests.

## Features

### CSS Rendering

- `<style>` tags in messages are automatically scoped — styles only affect that message
- ````css-render` code blocks are extracted and injected as scoped CSS

### JS Execution (two modes)

**````js-render`** — Direct DOM access within the message

- Can add event listeners, animations, page-flip effects, etc.
- Blocked APIs: `fetch`, `XMLHttpRequest`, `WebSocket`, `localStorage`, `eval`, `jQuery`, `SillyTavern`

**````js-sandbox`** — Fully isolated iframe

- Runs in `sandbox="allow-scripts"` iframe, cannot access the page at all

### HTML Rendering

- ````html-render` or ````html` code blocks are rendered in a sandboxed iframe
- Great for AI-generated HTML templates, cards, landing pages, etc.
- Tip: keep HTML compact (avoid excessive blank lines) to prevent SillyTavern’s markdown parser from splitting the code block

### Clickable Choices *(dev branch)*

- Automatically detects the last `<ol>` in the last AI message
- Click an option → text is pasted into the input box
- No prompt changes or regex needed

## Install

In SillyTavern: Extensions → Install Extension → paste:

```
https://github.com/lannyan/Chat-Renderer
```

## Settings

Found in the Extensions panel under **Chat Renderer**:

- Enable Chat Renderer
- CSS Rendering
- JS Execution
- HTML Rendering
- Clickable Choices *(dev branch only)*

## Safety

- CSS is auto-scoped per message, won’t leak to other messages or ST UI
- `js-sandbox` and `html-render` use browser-native `sandbox="allow-scripts"` iframe — fully isolated
- `js-render` blocks dangerous APIs via Proxy, scoped to message DOM only
- Does not access API keys, chat history, or ST core settings
- Does not send any external requests
- Zero residue on uninstall (just delete the extension folder)

## Credits
Built with Claude (Anthropic)

## License

MIT
