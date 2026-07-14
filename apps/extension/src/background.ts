import { TranslationScheduler, type ProviderHttpClient, type TranslationSchedulerOptions } from '@lingflow/core';
import {
  DEFAULT_SETTINGS,
  SETTINGS_STORAGE_KEY,
  mergeDesktopTranslationSettings,
  type BackgroundMessage,
  type DesktopStatusMessageResponse,
  type LingFlowSettings,
  type ProviderTestMessageResponse,
  type SelectionReportMessageResponse,
  type TranslationMessageResponse,
} from './shared/messages';

const DEFAULT_BACKGROUND_TIMEOUT_MS = 15_000;
const PROVIDER_TEST_TIMEOUT_MS = 60_000;
const TRANSLATION_TIMEOUT_MS = 120_000;

chrome.runtime.onMessage.addListener(
  (
    message: BackgroundMessage,
    _sender: chrome.runtime.MessageSender,
    sendResponse: (response: TranslationMessageResponse | ProviderTestMessageResponse | DesktopStatusMessageResponse | SelectionReportMessageResponse) => void,
  ) => {
    if (message.type === 'LF_TRANSLATE_TEXT') {
      respondAsync(
        sendResponse,
        async () => ({ ok: true, value: await translateText(message.text, message.settings) }),
        TRANSLATION_TIMEOUT_MS,
      );
      return true;
    }

    if (message.type === 'LF_TEST_PROVIDER') {
      respondAsync(sendResponse, () => testProvider(message.settings), PROVIDER_TEST_TIMEOUT_MS);
      return true;
    }

    if (message.type === 'LF_DESKTOP_STATUS') {
      respondAsync(sendResponse, checkDesktopStatus);
      return true;
    }

    if (message.type === 'LF_REPORT_SELECTION') {
      respondAsync(sendResponse, () => reportExternalSelection(message.text, message.x, message.y));
      return true;
    }

    return false;
  },
);

chrome.storage.local.get(SETTINGS_STORAGE_KEY).then((result) => {
  if (!result[SETTINGS_STORAGE_KEY]) {
    chrome.storage.local.set({ [SETTINGS_STORAGE_KEY]: DEFAULT_SETTINGS });
  }
});

async function translateText(text: string, settings: LingFlowSettings) {
  return translateTextWithResolvedSettings(text, settings, await resolveTranslationSettings(settings));
}

async function translateTextWithResolvedSettings(
  text: string,
  settings: LingFlowSettings,
  effectiveSettings: LingFlowSettings,
  reportUsage = true,
) {
  if (
    effectiveSettings.provider === 'ai' &&
    !hasConfiguredAiProvider(effectiveSettings)
  ) {
    throw new Error('AI provider requires at least one enabled source with base URL, model, and API key');
  }

  if (effectiveSettings.provider === 'google-free' && !effectiveSettings.googleApiKey) {
    throw new Error('Google Cloud Translation requires an API key');
  }

  if (effectiveSettings.provider === 'baidu-free' && (!effectiveSettings.baiduAppId || !effectiveSettings.baiduSecretKey)) {
    throw new Error('Baidu Translate requires APP ID and secret key');
  }

  if (effectiveSettings.provider === 'deepl' && !effectiveSettings.deeplApiKey) {
    throw new Error('DeepL requires an API key');
  }

  if (effectiveSettings.provider === 'microsoft' && !effectiveSettings.microsoftApiKey) {
    throw new Error('Microsoft Translator requires an API key');
  }

  if (effectiveSettings.provider === 'youdao' && (!effectiveSettings.youdaoAppKey || !effectiveSettings.youdaoAppSecret)) {
    throw new Error('Youdao Translate requires app key and app secret');
  }

  if (effectiveSettings.provider === 'tencent' && (!effectiveSettings.tencentSecretId || !effectiveSettings.tencentSecretKey)) {
    throw new Error('Tencent Cloud TMT requires secret id and secret key');
  }

  const options: TranslationSchedulerOptions =
    effectiveSettings.provider === 'ai' && hasConfiguredAiProvider(effectiveSettings)
      ? {
          defaultProvider: effectiveSettings.provider,
          ai: effectiveSettings.aiSources?.length
            ? {
                sources: effectiveSettings.aiSources,
                fallbackEnabled: effectiveSettings.aiFallbackEnabled,
              }
            : {
                apiKey: effectiveSettings.aiApiKey,
                baseUrl: effectiveSettings.aiBaseUrl,
                model: effectiveSettings.aiModel,
                fallbackEnabled: effectiveSettings.aiFallbackEnabled,
              },
        }
      : {
          defaultProvider: effectiveSettings.provider,
        };
  const scheduler = new TranslationScheduler({
    ...options,
    httpClient:
      settings.useLocalProxy === false
        ? undefined
        : createLocalProxyHttpClient(settings.localProxyUrl ?? DEFAULT_SETTINGS.localProxyUrl ?? ''),
    google: effectiveSettings.googleApiKey ? { apiKey: effectiveSettings.googleApiKey } : undefined,
    baidu:
      effectiveSettings.baiduAppId && effectiveSettings.baiduSecretKey
        ? { appId: effectiveSettings.baiduAppId, secretKey: effectiveSettings.baiduSecretKey }
        : undefined,
    deepl: effectiveSettings.deeplApiKey
      ? {
          apiKey: effectiveSettings.deeplApiKey,
          apiType: effectiveSettings.deeplApiType ?? 'free',
        }
      : undefined,
    microsoft: effectiveSettings.microsoftApiKey
      ? {
          apiKey: effectiveSettings.microsoftApiKey,
          region: effectiveSettings.microsoftRegion,
          endpoint: effectiveSettings.microsoftEndpoint,
        }
      : undefined,
    youdao:
      effectiveSettings.youdaoAppKey && effectiveSettings.youdaoAppSecret
        ? { appKey: effectiveSettings.youdaoAppKey, appSecret: effectiveSettings.youdaoAppSecret }
        : undefined,
    tencent:
      effectiveSettings.tencentSecretId && effectiveSettings.tencentSecretKey
        ? {
            secretId: effectiveSettings.tencentSecretId,
            secretKey: effectiveSettings.tencentSecretKey,
            region: effectiveSettings.tencentRegion,
          }
        : undefined,
  });

  const response = await scheduler.translate({
    text,
    sourceLanguage: effectiveSettings.sourceLanguage,
    targetLanguage: normalizeTargetLanguage(effectiveSettings.targetLanguage),
    provider: effectiveSettings.provider,
  });

  if (reportUsage) {
    await reportProviderUsage(settings, response.provider, response.sourceText.length);
  }
  return response;
}

async function testProvider(settings: LingFlowSettings): Promise<ProviderTestMessageResponse> {
  const startedAt = performance.now();
  const effectiveSettings = await resolveTranslationSettings({
    ...settings,
    sourceLanguage: 'en',
    targetLanguage: normalizeTargetLanguage(settings.targetLanguage),
  });
  const requestSettings = {
    ...settings,
    sourceLanguage: 'en',
    targetLanguage: normalizeTargetLanguage(effectiveSettings.targetLanguage),
  };
  const response = await translateTextWithResolvedSettings(
    'Hello, LingFlow.',
    requestSettings,
    {
      ...effectiveSettings,
      sourceLanguage: 'en',
      targetLanguage: normalizeTargetLanguage(effectiveSettings.targetLanguage),
    },
    false,
  );

  return {
    ok: true,
    provider: effectiveSettings.provider,
    elapsedMs: Math.round(performance.now() - startedAt),
    translatedText: response.text,
  };
}

function respondAsync(
  sendResponse: (response: TranslationMessageResponse | ProviderTestMessageResponse | DesktopStatusMessageResponse | SelectionReportMessageResponse) => void,
  task: () => Promise<TranslationMessageResponse | ProviderTestMessageResponse | DesktopStatusMessageResponse | SelectionReportMessageResponse>,
  timeoutMs = DEFAULT_BACKGROUND_TIMEOUT_MS,
) {
  let settled = false;
  const timeout = setTimeout(() => {
    if (settled) {
      return;
    }

    settled = true;
    sendResponse({
      ok: false,
      error: `LingFlow background worker timed out after ${Math.round(timeoutMs / 1000)} seconds. Check the desktop client and translation provider status.`,
    });
  }, timeoutMs);

  task()
    .then((response) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeout);
      sendResponse(response);
    })
    .catch((error: unknown) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeout);
      sendResponse({
        ok: false,
        error: normalizeError(error),
      });
    });
}

async function reportExternalSelection(text: string, x: number, y: number): Promise<SelectionReportMessageResponse> {
  const result = await chrome.storage.local.get(SETTINGS_STORAGE_KEY);
  const settings = { ...DEFAULT_SETTINGS, ...(result[SETTINGS_STORAGE_KEY] as Partial<LingFlowSettings> | undefined) };
  if (settings.useLocalProxy === false) {
    return { ok: false, error: 'Desktop proxy is disabled' };
  }

  const response = await fetch(`${normalizeLocalProxyUrl(settings.localProxyUrl)}/selection`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text, x, y }),
  });
  if (!response.ok) {
    return { ok: false, error: `LingFlow desktop selection proxy returned HTTP ${response.status}: ${await response.text()}` };
  }

  return { ok: true };
}

async function checkDesktopStatus(): Promise<DesktopStatusMessageResponse> {
  const result = await chrome.storage.local.get(SETTINGS_STORAGE_KEY);
  const settings = { ...DEFAULT_SETTINGS, ...(result[SETTINGS_STORAGE_KEY] as Partial<LingFlowSettings> | undefined) };
  if (settings.useLocalProxy === false) {
    return { ok: false, error: 'Desktop proxy is disabled' };
  }

  const response = await fetch(`${normalizeLocalProxyUrl(settings.localProxyUrl)}/settings`);
  if (!response.ok) {
    return { ok: false, error: `LingFlow desktop proxy returned HTTP ${response.status}` };
  }

  return { ok: true };
}

function normalizeError(error: unknown) {
  if (error instanceof TypeError && error.message === 'Failed to fetch') {
    return [
      'Failed to fetch. The provider endpoint could not be reached from the extension background.',
      'Check network access, provider domain allowlist, API service status, and whether the official API supports browser extension requests.',
    ].join(' ');
  }

  return error instanceof Error ? error.message : String(error);
}

function hasConfiguredAiProvider(settings: LingFlowSettings) {
  if (
    settings.aiSources?.some(
      (source) =>
        source.enabled !== false &&
        source.baseUrl.trim() &&
        source.apiKey.trim() &&
        source.models.some((model) => model.trim()),
    )
  ) {
    return true;
  }

  return Boolean(settings.aiApiKey?.trim() && settings.aiBaseUrl?.trim() && settings.aiModel?.trim());
}

async function resolveTranslationSettings(settings: LingFlowSettings): Promise<LingFlowSettings> {
  if (settings.useLocalProxy === false) {
    return settings;
  }

  const response = await fetch(`${normalizeLocalProxyUrl(settings.localProxyUrl)}/settings`);
  if (!response.ok) {
    throw new Error(`LingFlow desktop proxy settings failed with HTTP ${response.status}: ${await response.text()}`);
  }

  const desktopSettings = (await response.json()) as Partial<LingFlowSettings>;
  return mergeDesktopTranslationSettings(settings, desktopSettings);
}

function normalizeTargetLanguage(language?: string) {
  return language && language !== 'auto' ? language : DEFAULT_SETTINGS.targetLanguage;
}

function createLocalProxyHttpClient(proxyUrl: string): ProviderHttpClient {
  const normalizedProxyUrl = normalizeLocalProxyUrl(proxyUrl);

  return async (input, init) => {
    const response = await fetch(`${normalizedProxyUrl}/http-request`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        url: input instanceof URL ? input.toString() : String(input),
        method: init?.method ?? 'GET',
        headers: normalizeHeaders(init?.headers),
        body: normalizeBody(init?.body),
      }),
    });

    if (!response.ok) {
      throw new Error(`LingFlow desktop proxy request failed with HTTP ${response.status}: ${await response.text()}`);
    }

    const proxied = (await response.json()) as { readonly status: number; readonly body: string };
    return new Response(proxied.body, { status: proxied.status });
  };
}

async function reportProviderUsage(settings: LingFlowSettings, provider: string, characters: number) {
  if (settings.useLocalProxy === false || characters <= 0) {
    return;
  }

  try {
    await fetch(`${normalizeLocalProxyUrl(settings.localProxyUrl)}/usage`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({ provider, characters }),
    });
  } catch (error) {
    console.warn('LingFlow provider usage sync failed', error);
  }
}

function normalizeLocalProxyUrl(proxyUrl?: string) {
  return (proxyUrl || DEFAULT_SETTINGS.localProxyUrl || 'http://127.0.0.1:47631').replace(/\/+$/, '');
}

function normalizeHeaders(headers?: HeadersInit) {
  if (!headers) {
    return {};
  }

  if (headers instanceof Headers) {
    return Object.fromEntries(headers.entries());
  }

  if (Array.isArray(headers)) {
    return Object.fromEntries(headers);
  }

  return headers;
}

function normalizeBody(body?: BodyInit | null) {
  if (!body) {
    return undefined;
  }

  if (typeof body === 'string') {
    return body;
  }

  if (body instanceof URLSearchParams) {
    return body.toString();
  }

  throw new Error('Unsupported LingFlow local proxy request body type');
}
