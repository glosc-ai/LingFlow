import {
  cleanupLingFlow,
  extractReadableSegments,
  injectBilingualText,
  type ReadableSegment,
} from '@lingflow/dom';
import {
  DEFAULT_SETTINGS,
  SETTINGS_STORAGE_KEY,
  type BackgroundMessage,
  type ContentMessage,
  type ContentMessageResponse,
  type LingFlowSettings,
  type TranslationMessageResponse,
} from './shared/messages';

const SIDEBAR_BUTTON_ID = 'lingflow-page-toggle';
const MAX_PAGE_SEGMENTS = 800;
const TRANSLATION_CONCURRENCY = 4;
let pageTranslated = false;
let pageTranslationRunning = false;
let lazyObserver: IntersectionObserver | undefined;
let lazySettings: LingFlowSettings | undefined;
let lazyTotal = 0;
let lazyTranslated = 0;
let activeTranslations = 0;
let lazyRunId = 0;
const queuedSegments: ReadableSegment[] = [];
const queuedSegmentIds = new Set<string>();
const translatedSegmentIds = new Set<string>();
let lastSelectionReportAt = 0;

void refreshSidebarButtonVisibility();
window.setInterval(() => void refreshSidebarButtonVisibility(), 10000);
document.addEventListener('mouseup', (event) => {
  void reportBrowserSelection(event);
}, true);

chrome.runtime.onMessage.addListener(
  (
    message: ContentMessage,
    _sender: chrome.runtime.MessageSender,
    sendResponse: (response: ContentMessageResponse) => void,
  ) => {
    if (message.type === 'LF_PING') {
      sendResponse({ ok: true, message: 'Content script ready' });
      return false;
    }

    handleContentMessage(message)
      .then((response) => sendResponse(response))
      .catch((error: unknown) =>
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        }),
      );

    return true;
  },
);

async function handleContentMessage(message: ContentMessage): Promise<ContentMessageResponse> {
  if (message.type === 'LF_CLEANUP') {
    stopPageTranslation();
    return { ok: true, message: 'Translations cleared' };
  }

  if (message.type === 'LF_TRANSLATE_PAGE') {
    return translatePagePreview();
  }

  return { ok: false, error: 'Unsupported LingFlow command' };
}

async function reportBrowserSelection(event: MouseEvent) {
  if (event.button !== 0 || isLingFlowUiEvent(event)) {
    return;
  }

  const now = Date.now();
  if (now - lastSelectionReportAt < 350) {
    return;
  }

  const selection = window.getSelection();
  const text = selection?.toString().replace(/\s+/g, ' ').trim() ?? '';
  if (!selection || selection.isCollapsed || text.length < 2) {
    return;
  }

  if (!(await isDesktopConnected())) {
    return;
  }

  lastSelectionReportAt = now;
  const position = browserMouseEventToScreenPosition(event);
  await sendRuntimeMessage<{ readonly ok: boolean; readonly error?: string }>({
    type: 'LF_REPORT_SELECTION',
    text,
    x: position.x,
    y: position.y,
  }).catch((error) => {
    console.debug('LingFlow browser selection report failed', error);
  });
}

function isLingFlowUiEvent(event: MouseEvent) {
  const target = event.target;
  return target instanceof Element && Boolean(target.closest('[data-lingflow-ui="true"], [data-lingflow-injected="true"]'));
}

function browserMouseEventToScreenPosition(event: MouseEvent) {
  const sideInset = Math.max(0, (window.outerWidth - window.innerWidth) / 2);
  const topInset = Math.max(0, window.outerHeight - window.innerHeight - sideInset);
  return {
    x: window.screenX + sideInset + event.clientX,
    y: window.screenY + topInset + event.clientY,
  };
}

async function translatePagePreview() {
  if (pageTranslationRunning) {
    return { ok: true, message: 'LingFlow lazy translation is already enabled' } as const;
  }

  pageTranslationRunning = true;
  updateSidebarButton('running');

  const settings = await loadSettings();
  if (!settings.enabled) {
    stopPageTranslation();
    return { ok: false, error: 'LingFlow is disabled' } as const;
  }

  lazySettings = settings;
  lazyRunId += 1;
  const segments = extractReadableSegments(document.body, {
    includePageChrome: true,
    maxSegments: MAX_PAGE_SEGMENTS,
    minTextLength: 4,
    scope: 'document',
  });
  if (segments.length === 0) {
    stopPageTranslation();
    return { ok: false, error: 'No readable paragraphs found on this page' } as const;
  }

  lazyTotal = segments.length;
  lazyTranslated = 0;
  pageTranslated = true;
  updateSidebarButton('running', `0/${lazyTotal}`);
  lazyObserver?.disconnect();
  lazyObserver = new IntersectionObserver(handleVisibleSegments, {
    root: null,
    rootMargin: '900px 0px',
    threshold: 0,
  });
  for (const segment of segments) {
    lazyObserver.observe(segment.element);
  }

  return { ok: true, message: `LingFlow lazy translation enabled for ${segments.length} segment(s)` } as const;
}

async function translateAndInject(segment: ReadableSegment, settings: LingFlowSettings) {
  const response = await sendTranslateMessage(segment.text, settings);
  if (!response) {
    return { ok: false, error: 'No response from LingFlow background worker. Reload the extension and try again.' } as const;
  }

  if (response.ok) {
    injectBilingualText(segment, response.value, { mode: getInjectionMode(segment) });
    return { ok: true, message: 'Translated' } as const;
  }

  return { ok: false, error: response.error } as const;
}

function handleVisibleSegments(entries: IntersectionObserverEntry[]) {
  for (const entry of entries) {
    if (!entry.isIntersecting) {
      continue;
    }

    const segment = getObservedSegment(entry.target);
    if (!segment || queuedSegmentIds.has(segment.id) || translatedSegmentIds.has(segment.id)) {
      continue;
    }

    queuedSegments.push(segment);
    queuedSegmentIds.add(segment.id);
    lazyObserver?.unobserve(segment.element);
  }

  pumpTranslationQueue();
}

function getObservedSegment(target: Element) {
  const id = target.getAttribute('data-lingflow-segment-id');
  if (!id || !(target instanceof HTMLElement)) {
    return undefined;
  }

  const text = (target.innerText || target.textContent || '').replace(/\s+/g, ' ').trim();
  if (!text) {
    return undefined;
  }

  return { id, element: target, text };
}

function pumpTranslationQueue() {
  while (activeTranslations < TRANSLATION_CONCURRENCY && queuedSegments.length > 0) {
    const segment = queuedSegments.shift();
    if (!segment || !lazySettings) {
      continue;
    }

    activeTranslations += 1;
    const runId = lazyRunId;
    void translateAndInject(segment, lazySettings)
      .then((response) => {
        if (runId !== lazyRunId) {
          return;
        }
        if (response.ok) {
          lazyTranslated += 1;
          translatedSegmentIds.add(segment.id);
          updateSidebarButton('running', `${lazyTranslated}/${lazyTotal}`);
        }
      })
      .finally(() => {
        if (runId !== lazyRunId) {
          return;
        }
        activeTranslations -= 1;
        queuedSegmentIds.delete(segment.id);
        if (pageTranslationRunning) {
          pumpTranslationQueue();
        }
      });
  }
}

function getInjectionMode(segment: ReadableSegment) {
  if (
    segment.element.matches('a, span, li') ||
    segment.element.closest('nav, header, footer, aside, [role="navigation"]') ||
    segment.text.length <= 42
  ) {
    return 'inline' as const;
  }

  return 'below' as const;
}

function stopPageTranslation() {
  lazyObserver?.disconnect();
  lazyObserver = undefined;
  queuedSegments.length = 0;
  queuedSegmentIds.clear();
  translatedSegmentIds.clear();
  activeTranslations = 0;
  lazyRunId += 1;
  lazySettings = undefined;
  lazyTotal = 0;
  lazyTranslated = 0;
  pageTranslationRunning = false;
  pageTranslated = false;
  cleanupLingFlow(document.body);
  updateSidebarButton('ready');
}

async function refreshSidebarButtonVisibility() {
  const online = await isDesktopConnected();
  if (online) {
    mountSidebarButton();
    return;
  }

  document.getElementById(SIDEBAR_BUTTON_ID)?.remove();
}

async function isDesktopConnected() {
  try {
    const response = await sendRuntimeMessage<{ readonly ok: boolean; readonly error?: string }>({ type: 'LF_DESKTOP_STATUS' });
    return Boolean(response?.ok);
  } catch {
    return false;
  }
}

function mountSidebarButton() {
  if (document.getElementById(SIDEBAR_BUTTON_ID)) {
    return;
  }

  const host = document.createElement('div');
  host.id = SIDEBAR_BUTTON_ID;
  host.setAttribute('data-lingflow-ui', 'true');
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = `
    <style>
      :host {
        all: initial;
        position: fixed;
        top: 48%;
        right: 0;
        z-index: 2147483647;
        transform: translateY(-50%);
        font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }

      button {
        display: grid;
        width: 44px;
        height: 58px;
        place-items: center;
        border: 0;
        border-radius: 14px 0 0 14px;
        background: color-mix(in srgb, #f8a8c8 88%, white);
        box-shadow: 0 10px 28px rgba(15, 23, 42, 0.18);
        color: white;
        cursor: pointer;
        outline: 0;
        transition: width 150ms ease, background 150ms ease, opacity 150ms ease;
      }

      button:hover {
        width: 50px;
        background: #ec6fa5;
      }

      button[data-state="running"] {
        cursor: wait;
        opacity: 0.82;
      }

      button[data-state="translated"] {
        background: #14b8a6;
      }

      svg {
        width: 24px;
        height: 24px;
      }

      span {
        max-width: 38px;
        overflow: hidden;
        color: white;
        font-size: 10px;
        font-weight: 700;
        line-height: 1;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
    </style>
    <button aria-label="LingFlow 翻译当前页面" data-state="ready" title="LingFlow 翻译 / 撤销">
      <svg aria-hidden="true" fill="none" viewBox="0 0 24 24">
        <path d="M5 5h8M9 3v2m2 0c-.7 2.8-2.2 5.1-4.8 7.2M7.8 8.4c1 1.5 2.2 2.7 3.7 3.6M14 12h5l-2.5-5L14 12Zm-1 7 1.2-2.4M20 19l-1.2-2.4M14.2 16.6h4.6" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"/>
      </svg>
    </button>
  `;

  const button = shadow.querySelector('button');
  button?.addEventListener('click', () => {
    void togglePageTranslation();
  });

  document.documentElement.append(host);
}

async function togglePageTranslation() {
  if (!(await isDesktopConnected())) {
    document.getElementById(SIDEBAR_BUTTON_ID)?.remove();
    return;
  }

  if (pageTranslated) {
    stopPageTranslation();
    return;
  }

  if (pageTranslationRunning) {
    return;
  }

  await translatePagePreview();
}

function updateSidebarButton(state: 'ready' | 'running' | 'translated', progress?: string) {
  const host = document.getElementById(SIDEBAR_BUTTON_ID);
  const button = host?.shadowRoot?.querySelector('button');
  if (!button) {
    return;
  }

  button.setAttribute('data-state', state);
  button.setAttribute(
    'aria-label',
    state === 'translated' ? 'LingFlow 撤销页面翻译' : state === 'running' ? 'LingFlow 正在翻译' : 'LingFlow 翻译当前页面',
  );
  button.setAttribute('title', state === 'translated' ? '撤销 LingFlow 翻译' : 'LingFlow 翻译当前页面');
  button.innerHTML = progress
    ? `<span>${progress}</span>`
    : `<svg aria-hidden="true" fill="none" viewBox="0 0 24 24">
        <path d="M5 5h8M9 3v2m2 0c-.7 2.8-2.2 5.1-4.8 7.2M7.8 8.4c1 1.5 2.2 2.7 3.7 3.6M14 12h5l-2.5-5L14 12Zm-1 7 1.2-2.4M20 19l-1.2-2.4M14.2 16.6h4.6" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"/>
      </svg>`;
}

async function loadSettings(): Promise<LingFlowSettings> {
  const result = await chrome.storage.local.get(SETTINGS_STORAGE_KEY);
  const stored = result[SETTINGS_STORAGE_KEY] as Partial<LingFlowSettings> | undefined;
  return { ...DEFAULT_SETTINGS, ...stored };
}

function sendTranslateMessage(text: string, settings: LingFlowSettings) {
  const message: BackgroundMessage = {
    type: 'LF_TRANSLATE_TEXT',
    text,
    settings,
  };
  return sendRuntimeMessage<TranslationMessageResponse>(message);
}

function sendRuntimeMessage<TResponse>(message: BackgroundMessage): Promise<TResponse | undefined> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response: TResponse | undefined) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }

      resolve(response);
    });
  });
}
