import {
  cleanupLingFlow,
  extractReadableSegments,
  findReadableSegmentFromSelection,
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

let lastSelectedText = '';
let lastSelectedSegment: ReadableSegment | undefined;

document.addEventListener(
  'selectionchange',
  () => {
    const selection = document.getSelection();
    const text = selection?.toString().replace(/\s+/g, ' ').trim() ?? '';
    if (text) {
      lastSelectedText = text;
      const segment = findReadableSegmentFromSelection(selection);
      if (segment) {
        lastSelectedSegment = segment;
      }
    }
  },
  { passive: true },
);

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
    cleanupLingFlow(document.body);
    return { ok: true, message: 'Translations cleared' };
  }

  if (message.type === 'LF_TRANSLATE_SELECTION') {
    return translateSelection();
  }

  if (message.type === 'LF_TRANSLATE_PAGE') {
    return translatePagePreview();
  }

  return { ok: false, error: 'Unsupported LingFlow command' };
}

async function translateSelection() {
  const segment =
    findReadableSegmentFromSelection(document.getSelection(), lastSelectedText) ??
    getCachedSelectedSegment();

  if (!segment) {
    return { ok: false, error: 'No selected paragraph found on this page' } as const;
  }

  const response = await translateAndInject(segment);
  return response.ok
    ? ({ ok: true, message: 'Selection translated' } as const)
    : ({ ok: false, error: response.error } as const);
}

function getCachedSelectedSegment() {
  if (lastSelectedSegment?.element.isConnected) {
    return lastSelectedSegment;
  }

  lastSelectedSegment = undefined;
  return undefined;
}

async function translatePagePreview() {
  const segments = extractReadableSegments(document.body, { maxSegments: 8 });
  if (segments.length === 0) {
    return { ok: false, error: 'No readable paragraphs found on this page' } as const;
  }

  let translatedCount = 0;
  for (const segment of segments) {
    const response = await translateAndInject(segment);
    if (response.ok) {
      translatedCount += 1;
    }
  }

  return translatedCount > 0
    ? ({ ok: true, message: `Translated ${translatedCount} paragraph(s)` } as const)
    : ({ ok: false, error: 'No paragraphs were translated' } as const);
}

async function translateAndInject(segment: ReadableSegment) {
  const settings = await loadSettings();
  if (!settings.enabled) {
    return { ok: false, error: 'LingFlow is disabled' } as const;
  }

  const response = await sendTranslateMessage(segment.text, settings);
  if (!response) {
    return { ok: false, error: 'No response from LingFlow background worker. Reload the extension and try again.' } as const;
  }

  if (response.ok) {
    injectBilingualText(segment, response.value);
    return { ok: true, message: 'Translated' } as const;
  }

  return { ok: false, error: response.error } as const;
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
