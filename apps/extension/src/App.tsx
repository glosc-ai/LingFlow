import { useEffect, useState } from 'react';
import type { TranslatorProvider } from '@lingflow/core';
import {
  DEFAULT_SETTINGS,
  SETTINGS_STORAGE_KEY,
  type BackgroundMessage,
  type ContentMessageResponse,
  type ContentMessage,
  type LingFlowSettings,
  type ProviderTestMessageResponse,
} from './shared/messages';

function App() {
  const [settings, setSettings] = useState<LingFlowSettings>(DEFAULT_SETTINGS);
  const [status, setStatus] = useState('Ready');

  useEffect(() => {
    chrome.storage.local.get(SETTINGS_STORAGE_KEY).then((result) => {
      const stored = result[SETTINGS_STORAGE_KEY] as Partial<LingFlowSettings> | undefined;
      const next = sanitizeSettingsForStorage({ ...DEFAULT_SETTINGS, ...stored });
      setSettings(next);
      chrome.storage.local.set({ [SETTINGS_STORAGE_KEY]: next });
    });
  }, []);

  async function updateSettings(next: LingFlowSettings) {
    const sanitized = sanitizeSettingsForStorage(next);
    setSettings(sanitized);
    await chrome.storage.local.set({ [SETTINGS_STORAGE_KEY]: sanitized });
    setStatus('Saved');
  }

  async function testProviderConnection() {
    setStatus('Testing provider');
    const message: BackgroundMessage = {
      type: 'LF_TEST_PROVIDER',
      settings,
    };

    try {
      const response = await sendRuntimeMessage<ProviderTestMessageResponse>(message);
      if (!response) {
        setStatus('No response from LingFlow background worker. Reload the extension and try again.');
        return;
      }

      if (response.ok) {
        setStatus(`${response.provider} OK in ${response.elapsedMs}ms: ${response.translatedText}`);
        return;
      }

      setStatus(response.error);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  }

  async function sendToActiveTab(message: ContentMessage, successStatus: string) {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) {
      setStatus('No active tab');
      return;
    }

    setStatus('Sending command');

    const response = await sendMessageWithContentScriptFallback(tab.id, message);
    if (!response) {
      setStatus('No response from page content script. Reload the page and try again.');
      return;
    }

    if (response.ok) {
      setStatus(response.message || successStatus);
      return;
    }

    setStatus(response.error);
  }

  async function sendMessageWithContentScriptFallback(tabId: number, message: ContentMessage) {
    const first = await sendContentMessage(tabId, message);
    if (!first) {
      return { ok: false, error: 'No response from page content script. Reload the page and try again.' } as const;
    }

    if (first.ok || !first.error.includes('Receiving end does not exist')) {
      return first;
    }

    const injected = await injectContentScript(tabId);
    if (!injected.ok) {
      return injected;
    }

    return sendContentMessage(tabId, message);
  }

  async function sendContentMessage(tabId: number, message: ContentMessage): Promise<ContentMessageResponse> {
    try {
      return (
        (await sendTabMessage<ContentMessageResponse>(tabId, message)) ?? {
          ok: false,
          error: 'No response from page content script. Reload the page and try again.',
        }
      );
    } catch (error) {
      return {
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : 'Cannot talk to this page. Reload the page or try a normal http/https website.',
      };
    }
  }

  async function injectContentScript(tabId: number): Promise<ContentMessageResponse> {
    const manifest = chrome.runtime.getManifest();
    const contentScript = manifest.content_scripts?.[0]?.js?.[0];
    if (!contentScript) {
      return { ok: false, error: 'Content script entry is missing from the manifest' };
    }

    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: [contentScript],
      });
      return { ok: true, message: 'Content script injected' };
    } catch (error) {
      return {
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : 'Cannot inject LingFlow into this page. Try reloading a normal http/https page.',
      };
    }
  }

  return (
    <main className="w-[360px] bg-background p-5 text-foreground">
      <section>
        <p className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
          LingFlow
        </p>
        <h1 className="mt-3 text-2xl font-semibold leading-tight">Reading translator</h1>
        <p className="mt-3 text-sm leading-6 text-muted-foreground">
          Translate the selected paragraph or a page preview without touching layout.
        </p>
        <div className="mt-5 rounded-lg border bg-card p-4 text-card-foreground">
          <label className="flex items-center justify-between gap-3 text-sm font-medium">
            Enabled
            <input
              type="checkbox"
              checked={settings.enabled}
              onChange={(event) =>
                updateSettings({ ...settings, enabled: event.currentTarget.checked })
              }
            />
          </label>

          <label className="mt-4 flex items-center justify-between gap-3 text-sm font-medium">
            Desktop proxy
            <input
              type="checkbox"
              checked={settings.useLocalProxy ?? true}
              onChange={(event) =>
                updateSettings({ ...settings, useLocalProxy: event.currentTarget.checked })
              }
            />
          </label>

          {settings.useLocalProxy !== false && (
            <input
              className="mt-3 w-full rounded-md border bg-background px-2 py-2 text-sm text-foreground"
              placeholder="Local proxy URL"
              value={settings.localProxyUrl ?? DEFAULT_SETTINGS.localProxyUrl}
              onChange={(event) =>
                updateSettings({ ...settings, localProxyUrl: event.currentTarget.value })
              }
            />
          )}

          {settings.useLocalProxy !== false && (
            <p className="mt-3 text-xs leading-5 text-muted-foreground">
              Provider settings are read from the running LingFlow desktop client.
            </p>
          )}

          <label className="mt-4 block text-xs font-medium text-muted-foreground">
            Provider
            <select
              className="mt-1 w-full rounded-md border bg-background px-2 py-2 text-sm text-foreground"
              value={settings.provider}
              disabled={settings.useLocalProxy !== false}
              onChange={(event) =>
                updateSettings({
                  ...settings,
                  provider: event.currentTarget.value as TranslatorProvider,
                })
              }
            >
              <option value="mock">Mock</option>
              <option value="google-free">Google Cloud</option>
              <option value="baidu-free">Baidu Translate</option>
              <option value="deepl">DeepL</option>
              <option value="microsoft">Microsoft Translator</option>
              <option value="youdao">Youdao Translate</option>
              <option value="tencent">Tencent Cloud TMT</option>
              <option value="ai">AI</option>
            </select>
          </label>

          <label className="mt-3 block text-xs font-medium text-muted-foreground">
            Target language
            <input
              className="mt-1 w-full rounded-md border bg-background px-2 py-2 text-sm text-foreground"
              value={settings.targetLanguage}
              onChange={(event) =>
                updateSettings({ ...settings, targetLanguage: event.currentTarget.value })
              }
            />
          </label>

          {settings.provider === 'google-free' && (
            <div className={settings.useLocalProxy !== false ? 'hidden' : 'mt-3 space-y-2'}>
              <input
                className="w-full rounded-md border bg-background px-2 py-2 text-sm text-foreground"
                placeholder="Google Cloud API key"
                type="password"
                value={settings.googleApiKey ?? ''}
                onChange={(event) =>
                  updateSettings({ ...settings, googleApiKey: event.currentTarget.value })
                }
              />
            </div>
          )}

          {settings.provider === 'baidu-free' && (
            <div className={settings.useLocalProxy !== false ? 'hidden' : 'mt-3 space-y-2'}>
              <input
                className="w-full rounded-md border bg-background px-2 py-2 text-sm text-foreground"
                placeholder="Baidu APP ID"
                value={settings.baiduAppId ?? ''}
                onChange={(event) =>
                  updateSettings({ ...settings, baiduAppId: event.currentTarget.value })
                }
              />
              <input
                className="w-full rounded-md border bg-background px-2 py-2 text-sm text-foreground"
                placeholder="Baidu secret key"
                type="password"
                value={settings.baiduSecretKey ?? ''}
                onChange={(event) =>
                  updateSettings({ ...settings, baiduSecretKey: event.currentTarget.value })
                }
              />
            </div>
          )}

          {settings.provider === 'deepl' && (
            <div className={settings.useLocalProxy !== false ? 'hidden' : 'mt-3 space-y-2'}>
              <select
                className="w-full rounded-md border bg-background px-2 py-2 text-sm text-foreground"
                value={settings.deeplApiType ?? 'free'}
                onChange={(event) =>
                  updateSettings({ ...settings, deeplApiType: event.currentTarget.value as 'free' | 'pro' })
                }
              >
                <option value="free">DeepL API Free</option>
                <option value="pro">DeepL API Pro</option>
              </select>
              <input
                className="w-full rounded-md border bg-background px-2 py-2 text-sm text-foreground"
                placeholder="DeepL API key"
                type="password"
                value={settings.deeplApiKey ?? ''}
                onChange={(event) =>
                  updateSettings({ ...settings, deeplApiKey: event.currentTarget.value })
                }
              />
            </div>
          )}

          {settings.provider === 'microsoft' && (
            <div className={settings.useLocalProxy !== false ? 'hidden' : 'mt-3 space-y-2'}>
              <input
                className="w-full rounded-md border bg-background px-2 py-2 text-sm text-foreground"
                placeholder="Microsoft Translator API key"
                type="password"
                value={settings.microsoftApiKey ?? ''}
                onChange={(event) =>
                  updateSettings({ ...settings, microsoftApiKey: event.currentTarget.value })
                }
              />
              <input
                className="w-full rounded-md border bg-background px-2 py-2 text-sm text-foreground"
                placeholder="Region, for example eastasia"
                value={settings.microsoftRegion ?? ''}
                onChange={(event) =>
                  updateSettings({ ...settings, microsoftRegion: event.currentTarget.value })
                }
              />
              <input
                className="w-full rounded-md border bg-background px-2 py-2 text-sm text-foreground"
                placeholder="Endpoint"
                value={settings.microsoftEndpoint ?? ''}
                onChange={(event) =>
                  updateSettings({ ...settings, microsoftEndpoint: event.currentTarget.value })
                }
              />
            </div>
          )}

          {settings.provider === 'youdao' && (
            <div className={settings.useLocalProxy !== false ? 'hidden' : 'mt-3 space-y-2'}>
              <input
                className="w-full rounded-md border bg-background px-2 py-2 text-sm text-foreground"
                placeholder="Youdao app key"
                value={settings.youdaoAppKey ?? ''}
                onChange={(event) =>
                  updateSettings({ ...settings, youdaoAppKey: event.currentTarget.value })
                }
              />
              <input
                className="w-full rounded-md border bg-background px-2 py-2 text-sm text-foreground"
                placeholder="Youdao app secret"
                type="password"
                value={settings.youdaoAppSecret ?? ''}
                onChange={(event) =>
                  updateSettings({ ...settings, youdaoAppSecret: event.currentTarget.value })
                }
              />
            </div>
          )}

          {settings.provider === 'tencent' && (
            <div className={settings.useLocalProxy !== false ? 'hidden' : 'mt-3 space-y-2'}>
              <input
                className="w-full rounded-md border bg-background px-2 py-2 text-sm text-foreground"
                placeholder="Tencent SecretId"
                value={settings.tencentSecretId ?? ''}
                onChange={(event) =>
                  updateSettings({ ...settings, tencentSecretId: event.currentTarget.value })
                }
              />
              <input
                className="w-full rounded-md border bg-background px-2 py-2 text-sm text-foreground"
                placeholder="Tencent SecretKey"
                type="password"
                value={settings.tencentSecretKey ?? ''}
                onChange={(event) =>
                  updateSettings({ ...settings, tencentSecretKey: event.currentTarget.value })
                }
              />
              <input
                className="w-full rounded-md border bg-background px-2 py-2 text-sm text-foreground"
                placeholder="Region"
                value={settings.tencentRegion ?? ''}
                onChange={(event) =>
                  updateSettings({ ...settings, tencentRegion: event.currentTarget.value })
                }
              />
            </div>
          )}

          {settings.provider === 'ai' && (
            <div className={settings.useLocalProxy !== false ? 'hidden' : 'mt-3 space-y-2'}>
              <input
                className="w-full rounded-md border bg-background px-2 py-2 text-sm text-foreground"
                placeholder="AI base URL"
                value={settings.aiBaseUrl ?? ''}
                onChange={(event) =>
                  updateSettings({ ...settings, aiBaseUrl: event.currentTarget.value })
                }
              />
              <input
                className="w-full rounded-md border bg-background px-2 py-2 text-sm text-foreground"
                placeholder="AI model"
                value={settings.aiModel ?? ''}
                onChange={(event) =>
                  updateSettings({ ...settings, aiModel: event.currentTarget.value })
                }
              />
              <input
                className="w-full rounded-md border bg-background px-2 py-2 text-sm text-foreground"
                placeholder="API key"
                type="password"
                value={settings.aiApiKey ?? ''}
                onChange={(event) =>
                  updateSettings({ ...settings, aiApiKey: event.currentTarget.value })
                }
              />
            </div>
          )}

          {settings.provider !== 'mock' && (
            <p className="mt-3 text-xs leading-5 text-muted-foreground">
              Real providers send text to the selected translation service.
            </p>
          )}

          <div className="mt-4 grid grid-cols-2 gap-2">
            <button
              className="col-span-2 rounded-md border px-3 py-2 text-sm font-medium"
              type="button"
              onClick={testProviderConnection}
            >
              Test provider connection
            </button>
            <button
              className="rounded-md border px-3 py-2 text-sm font-medium"
              type="button"
              onClick={() => sendToActiveTab({ type: 'LF_TRANSLATE_SELECTION' }, 'Selection sent')}
            >
              Selection
            </button>
            <button
              className="rounded-md border px-3 py-2 text-sm font-medium"
              type="button"
              onClick={() => sendToActiveTab({ type: 'LF_TRANSLATE_PAGE' }, 'Page preview sent')}
            >
              Page
            </button>
            <button
              className="col-span-2 rounded-md border px-3 py-2 text-sm font-medium"
              type="button"
              onClick={() => sendToActiveTab({ type: 'LF_CLEANUP' }, 'Cleaned')}
            >
              Clear page translations
            </button>
          </div>

          <p className="mt-3 text-xs leading-5 text-muted-foreground">{status}</p>
        </div>
      </section>
    </main>
  );
}

export default App;

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

function sendTabMessage<TResponse>(tabId: number, message: ContentMessage): Promise<TResponse | undefined> {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (response: TResponse | undefined) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }

      resolve(response);
    });
  });
}

function sanitizeSettingsForStorage(settings: LingFlowSettings): LingFlowSettings {
  if (settings.useLocalProxy === false) {
    return settings;
  }

  return {
    enabled: settings.enabled,
    useLocalProxy: true,
    localProxyUrl: settings.localProxyUrl,
    provider: DEFAULT_SETTINGS.provider,
    targetLanguage: settings.targetLanguage,
    sourceLanguage: settings.sourceLanguage,
  };
}
