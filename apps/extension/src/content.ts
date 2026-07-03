import {
  LINGFLOW_INJECTED_ATTRIBUTE,
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
const TRANSLATION_CONCURRENCY = 10;
let pageTranslated = false;
let pageTranslationRunning = false;
let lazyObserver: IntersectionObserver | undefined;
let mutationObserver: MutationObserver | undefined;
let lazySettings: LingFlowSettings | undefined;
let lazyTotal = 0;
let lazyTranslated = 0;
let activeTranslations = 0;
let lazyRunId = 0;
let mutationScanTimer: number | undefined;
let sidebarRefreshTimer: number | undefined;
let extensionContextInvalidated = false;
const queuedSegments: ReadableSegment[] = [];
const queuedSegmentIds = new Set<string>();
const translatedSegmentIds = new Set<string>();
const observedSegmentIds = new Set<string>();
const translationCache = new Map<string, TranslationMessageResponse>();
let lastSelectionReportAt = 0;

void refreshSidebarButtonVisibility().catch(handleContentScriptError);
sidebarRefreshTimer = window.setInterval(() => {
  void refreshSidebarButtonVisibility().catch(handleContentScriptError);
}, 10000);
document.addEventListener('mouseup', handleMouseUp, true);

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

function handleMouseUp(event: MouseEvent) {
  void reportBrowserSelection(event).catch(handleContentScriptError);
}

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
  if (extensionContextInvalidated) {
    return;
  }

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

  cleanupLingFlow(document.body);
  queuedSegments.length = 0;
  queuedSegmentIds.clear();
  translatedSegmentIds.clear();
  observedSegmentIds.clear();
  activeTranslations = 0;

  pageTranslationRunning = true;
  updateSidebarButton('running');

  const settings = await loadSettings();
  if (!settings.enabled) {
    stopPageTranslation();
    return { ok: false, error: 'LingFlow is disabled' } as const;
  }

  lazySettings = { ...settings, targetLanguage: await resolveEffectiveTargetLanguage(settings) };
  lazyRunId += 1;
  const segments = scanPageSegments();
  if (segments.length === 0) {
    stopPageTranslation();
    return { ok: false, error: 'No readable paragraphs found on this page' } as const;
  }

  lazyTotal = 0;
  lazyTranslated = 0;
  pageTranslated = true;
  updateSidebarButton('running', `0/${lazyTotal}`);
  lazyObserver?.disconnect();
  observedSegmentIds.clear();
  lazyObserver = new IntersectionObserver(handleVisibleSegments, {
    root: null,
    rootMargin: '900px 0px',
    threshold: 0,
  });
  observeSegments(segments);
  startMutationObserver();

  return { ok: true, message: `LingFlow lazy translation enabled for ${lazyTotal} segment(s)` } as const;
}

async function translateAndInject(segment: ReadableSegment, settings: LingFlowSettings) {
  if (extensionContextInvalidated) {
    return { ok: false, error: 'LingFlow extension context is no longer available.' } as const;
  }

  if (shouldSkipTranslationForLanguage(segment.text, settings.targetLanguage)) {
    return { ok: true, skipped: true, message: 'Skipped same-language segment' } as const;
  }

  const cacheKey = createTranslationCacheKey(segment.text, settings);
  const cachedResponse = translationCache.get(cacheKey);
  const response = cachedResponse ?? await sendTranslateMessage(segment.text, settings);
  if (!response) {
    return { ok: false, error: 'No response from LingFlow background worker. Reload the extension and try again.' } as const;
  }

  if (response.ok) {
    if (!cachedResponse) {
      translationCache.set(cacheKey, response);
    }
    injectBilingualText(segment, response.value, { mode: getInjectionMode(segment) });
    return { ok: true, skipped: false, message: 'Translated' } as const;
  }

  return { ok: false, error: response.error } as const;
}

function scanPageSegments() {
  return extractReadableSegments(document.body, {
    includePageChrome: true,
    maxSegments: MAX_PAGE_SEGMENTS,
    minTextLength: 4,
    scope: 'document',
  });
}

function observeSegments(segments: readonly ReadableSegment[]) {
  if (!lazyObserver) {
    return;
  }

  for (const segment of segments) {
    if (observedSegmentIds.has(segment.id) || translatedSegmentIds.has(segment.id) || queuedSegmentIds.has(segment.id)) {
      continue;
    }

    if (shouldSkipTranslationForLanguage(segment.text, lazySettings?.targetLanguage)) {
      translatedSegmentIds.add(segment.id);
      continue;
    }

    lazyObserver.observe(segment.element);
    observedSegmentIds.add(segment.id);
    lazyTotal += 1;
  }

  updateSidebarButton('running', `${lazyTranslated}/${lazyTotal}`);
}

function startMutationObserver() {
  mutationObserver?.disconnect();
  mutationObserver = new MutationObserver((mutations) => {
    if (!pageTranslationRunning || !mutations.some(hasAddedTranslatableNode)) {
      return;
    }

    if (mutationScanTimer) {
      window.clearTimeout(mutationScanTimer);
    }
    mutationScanTimer = window.setTimeout(() => {
      mutationScanTimer = undefined;
      observeSegments(scanPageSegments());
    }, 250);
  });
  mutationObserver.observe(document.body, { childList: true, subtree: true });
}

function hasAddedTranslatableNode(mutation: MutationRecord) {
  return Array.from(mutation.addedNodes).some((node) => {
    if (
      !(node instanceof HTMLElement) ||
      node.closest(`[${LINGFLOW_INJECTED_ATTRIBUTE}="true"], [data-lingflow-ui="true"]`)
    ) {
      return false;
    }
    return getReadableText(node).length >= 4;
  });
}

function handleVisibleSegments(entries: IntersectionObserverEntry[]) {
  const visibleSegments: ReadableSegment[] = [];
  for (const entry of entries) {
    if (!entry.isIntersecting) {
      continue;
    }

    const segment = getObservedSegment(entry.target);
    if (!segment || queuedSegmentIds.has(segment.id) || translatedSegmentIds.has(segment.id)) {
      continue;
    }

    visibleSegments.push(segment);
    queuedSegmentIds.add(segment.id);
    lazyObserver?.unobserve(segment.element);
  }

  if (visibleSegments.length) {
    enqueueVisibleSegments(dedupeNestedVisibleSegments(visibleSegments));
  }
  pumpTranslationQueue();
}

function enqueueVisibleSegments(segments: readonly ReadableSegment[]) {
  const prioritized = [...segments].sort((left, right) => getSegmentPriority(left) - getSegmentPriority(right));
  queuedSegments.unshift(...prioritized);
}

function getSegmentPriority(segment: ReadableSegment) {
  const rect = segment.element.getBoundingClientRect();
  const viewportHeight = Math.max(1, window.innerHeight);
  const viewportWidth = Math.max(1, window.innerWidth);
  const topDistance = Math.max(0, rect.top);
  const centerX = rect.left + rect.width / 2;
  const horizontalDistance = Math.abs(centerX - viewportWidth / 2);
  return getContentAreaPriority(segment.element) + topDistance + horizontalDistance * 0.08 + viewportHeight * getOffscreenPenalty(rect) - getElementDepth(segment.element) * 0.5;
}

function dedupeNestedVisibleSegments(segments: readonly ReadableSegment[]) {
  const selected: ReadableSegment[] = [];
  const deepestFirst = [...segments].sort((left, right) => getElementDepth(right.element) - getElementDepth(left.element));

  for (const segment of deepestFirst) {
    if (selected.some((existing) => isNestedDuplicateSegment(segment, existing))) {
      translatedSegmentIds.add(segment.id);
      queuedSegmentIds.delete(segment.id);
      continue;
    }

    selected.push(segment);
  }

  return selected;
}

function isNestedDuplicateSegment(candidate: ReadableSegment, existing: ReadableSegment) {
  const hasContainment = candidate.element.contains(existing.element) || existing.element.contains(candidate.element);
  if (!hasContainment) {
    return false;
  }

  return areEquivalentTexts(candidate.text, existing.text);
}

function areEquivalentTexts(left: string, right: string) {
  const leftKey = left.replace(/\s+/g, ' ').trim();
  const rightKey = right.replace(/\s+/g, ' ').trim();
  if (leftKey === rightKey) {
    return true;
  }

  const shorter = leftKey.length <= rightKey.length ? leftKey : rightKey;
  const longer = leftKey.length > rightKey.length ? leftKey : rightKey;
  return shorter.length >= 12 && longer.includes(shorter) && shorter.length / longer.length >= 0.82;
}

function getElementDepth(element: HTMLElement) {
  let depth = 0;
  let current: Element | null = element;
  while (current?.parentElement) {
    depth += 1;
    current = current.parentElement;
  }
  return depth;
}

function getContentAreaPriority(element: HTMLElement) {
  if (element.closest('[data-testid="primaryColumn"], article, main, [role="main"], .markdown-body, .entry-content, .post-content, .article-content')) {
    return 0;
  }

  if (element.closest('aside, [role="complementary"], [data-testid="sidebarColumn"], nav, header, footer, [role="navigation"]')) {
    return 5000;
  }

  return 1000;
}

function getOffscreenPenalty(rect: DOMRect) {
  if (rect.bottom < 0) {
    return 4;
  }
  if (rect.top > window.innerHeight) {
    return 2;
  }
  return 0;
}

function getObservedSegment(target: Element) {
  const id = target.getAttribute('data-lingflow-segment-id');
  if (!id || !(target instanceof HTMLElement)) {
    return undefined;
  }

  const text = getReadableText(target);
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
          if (!response.skipped) {
            lazyTranslated += 1;
          } else {
            lazyTotal = Math.max(0, lazyTotal - 1);
          }
          translatedSegmentIds.add(segment.id);
          updateSidebarButton('running', `${lazyTranslated}/${lazyTotal}`);
        }
      })
      .catch(handleContentScriptError)
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
  mutationObserver?.disconnect();
  mutationObserver = undefined;
  if (mutationScanTimer) {
    window.clearTimeout(mutationScanTimer);
    mutationScanTimer = undefined;
  }
  queuedSegments.length = 0;
  queuedSegmentIds.clear();
  translatedSegmentIds.clear();
  observedSegmentIds.clear();
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

function disposeContentScriptRuntime() {
  if (extensionContextInvalidated) {
    return;
  }

  extensionContextInvalidated = true;
  if (sidebarRefreshTimer) {
    window.clearInterval(sidebarRefreshTimer);
    sidebarRefreshTimer = undefined;
  }
  if (mutationScanTimer) {
    window.clearTimeout(mutationScanTimer);
    mutationScanTimer = undefined;
  }

  document.removeEventListener('mouseup', handleMouseUp, true);
  lazyObserver?.disconnect();
  lazyObserver = undefined;
  mutationObserver?.disconnect();
  mutationObserver = undefined;
  queuedSegments.length = 0;
  queuedSegmentIds.clear();
  observedSegmentIds.clear();
  activeTranslations = 0;
  pageTranslationRunning = false;
  document.getElementById(SIDEBAR_BUTTON_ID)?.remove();
}

function handleContentScriptError(error: unknown) {
  if (isExtensionContextInvalidatedError(error)) {
    disposeContentScriptRuntime();
    return;
  }

  console.debug('LingFlow content script error', error);
}

function isExtensionContextInvalidatedError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return /extension context invalidated|context invalidated|invalid extension context/i.test(message);
}

function createTranslationCacheKey(text: string, settings: LingFlowSettings) {
  return [
    settings.provider,
    normalizeLanguageCode(settings.sourceLanguage) ?? 'auto',
    normalizeLanguageCode(settings.targetLanguage) ?? DEFAULT_SETTINGS.targetLanguage,
    text,
  ].join('\u001f');
}

function shouldSkipTranslationForLanguage(text: string, targetLanguage?: string) {
  const normalizedTarget = normalizeLanguageCode(targetLanguage);
  if (!normalizedTarget || normalizedTarget === 'auto') {
    return false;
  }

  const detected = detectDominantLanguage(text);
  return Boolean(detected && detected === normalizedTarget);
}

function normalizeLanguageCode(language?: string) {
  if (!language) {
    return undefined;
  }
  const normalized = language.toLowerCase();
  if (normalized.startsWith('zh')) {
    return 'zh';
  }
  return normalized.split('-')[0];
}

function detectDominantLanguage(text: string) {
  const compact = text.replace(/\s+/g, '');
  if (compact.length < 2) {
    return undefined;
  }

  const counts = {
    zh: countMatches(compact, /[\u3400-\u9fff]/g),
    ja: countMatches(compact, /[\u3040-\u30ff]/g),
    ko: countMatches(compact, /[\uac00-\ud7af]/g),
    asciiLatin: countMatches(compact, /[A-Za-z]/g),
    accentedLatin: countMatches(compact, /[À-ÿ]/g),
  };
  const total = compact.length;
  if (counts.zh / total > 0.28) {
    return 'zh';
  }
  if (counts.ja / total > 0.2) {
    return 'ja';
  }
  if (counts.ko / total > 0.2) {
    return 'ko';
  }
  if (counts.asciiLatin / total > 0.55 && counts.accentedLatin / total < 0.08) {
    return 'en';
  }
  return undefined;
}

function countMatches(text: string, pattern: RegExp) {
  return text.match(pattern)?.length ?? 0;
}

function getReadableText(element: HTMLElement) {
  const clone = element.cloneNode(true);
  if (!(clone instanceof HTMLElement)) {
    return '';
  }

  clone.querySelectorAll(`[${LINGFLOW_INJECTED_ATTRIBUTE}]`).forEach((node) => node.remove());
  return clone.textContent?.replace(/\s+/g, ' ').trim() ?? '';
}

async function refreshSidebarButtonVisibility() {
  if (extensionContextInvalidated) {
    return;
  }

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
    void togglePageTranslation().catch(handleContentScriptError);
  });

  document.documentElement.append(host);
}

async function togglePageTranslation() {
  if (extensionContextInvalidated) {
    return;
  }

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
  if (extensionContextInvalidated) {
    return DEFAULT_SETTINGS;
  }

  const result = await chrome.storage.local.get(SETTINGS_STORAGE_KEY);
  const stored = result[SETTINGS_STORAGE_KEY] as Partial<LingFlowSettings> | undefined;
  return { ...DEFAULT_SETTINGS, ...stored };
}

async function resolveEffectiveTargetLanguage(settings: LingFlowSettings) {
  if (settings.targetLanguage !== 'auto') {
    return settings.targetLanguage;
  }

  if (settings.useLocalProxy === false) {
    return DEFAULT_SETTINGS.targetLanguage;
  }

  try {
    const response = await fetch(`${normalizeLocalProxyUrl(settings.localProxyUrl)}/settings`);
    if (!response.ok) {
      return DEFAULT_SETTINGS.targetLanguage;
    }
    const desktopSettings = (await response.json()) as Partial<LingFlowSettings>;
    return desktopSettings.targetLanguage || DEFAULT_SETTINGS.targetLanguage;
  } catch {
    return DEFAULT_SETTINGS.targetLanguage;
  }
}

function normalizeLocalProxyUrl(url?: string) {
  return (url || DEFAULT_SETTINGS.localProxyUrl || 'http://127.0.0.1:47631').replace(/\/+$/, '');
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
    try {
      if (extensionContextInvalidated || !chrome.runtime?.id) {
        disposeContentScriptRuntime();
        resolve(undefined);
        return;
      }

      chrome.runtime.sendMessage(message, (response: TResponse | undefined) => {
        const error = chrome.runtime.lastError;
        if (error) {
          const runtimeError = new Error(error.message);
          if (isExtensionContextInvalidatedError(runtimeError)) {
            disposeContentScriptRuntime();
            resolve(undefined);
            return;
          }

          reject(runtimeError);
          return;
        }

        resolve(response);
      });
    } catch (error) {
      if (isExtensionContextInvalidatedError(error)) {
        disposeContentScriptRuntime();
        resolve(undefined);
        return;
      }

      reject(error);
    }
  });
}
