import { useEffect, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { TranslationScheduler, type ProviderHttpClient, type TranslatorProvider } from '@lingflow/core';

interface SystemInfo {
  readonly os: string;
  readonly arch: string;
  readonly family: string;
}

interface AppSettings {
  readonly provider: TranslatorProvider;
  readonly targetLanguage: string;
  readonly aiBaseUrl: string;
  readonly aiModel: string;
  readonly aiApiKey: string;
  readonly googleApiKey: string;
  readonly baiduAppId: string;
  readonly baiduSecretKey: string;
  readonly deeplApiKey: string;
  readonly deeplApiType: 'free' | 'pro';
  readonly microsoftApiKey: string;
  readonly microsoftRegion: string;
  readonly microsoftEndpoint: string;
  readonly youdaoAppKey: string;
  readonly youdaoAppSecret: string;
  readonly tencentSecretId: string;
  readonly tencentSecretKey: string;
  readonly tencentRegion: string;
}

interface HttpResponse {
  readonly status: number;
  readonly body: string;
}

type AppSecrets = Pick<
  AppSettings,
  | 'aiApiKey'
  | 'googleApiKey'
  | 'baiduSecretKey'
  | 'deeplApiKey'
  | 'microsoftApiKey'
  | 'youdaoAppSecret'
  | 'tencentSecretKey'
>;

const SETTINGS_STORAGE_KEY = 'lingflow.app.settings';
const DEFAULT_SETTINGS: AppSettings = {
  provider: 'mock',
  targetLanguage: 'zh-CN',
  aiBaseUrl: 'https://api.openai.com',
  aiModel: 'gpt-4.1-mini',
  aiApiKey: '',
  googleApiKey: '',
  baiduAppId: '',
  baiduSecretKey: '',
  deeplApiKey: '',
  deeplApiType: 'free',
  microsoftApiKey: '',
  microsoftRegion: '',
  microsoftEndpoint: 'https://api.cognitive.microsofttranslator.com',
  youdaoAppKey: '',
  youdaoAppSecret: '',
  tencentSecretId: '',
  tencentSecretKey: '',
  tencentRegion: 'ap-guangzhou',
};

function App() {
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [sourceText, setSourceText] = useState('LingFlow makes translation flow into reading.');
  const [translatedText, setTranslatedText] = useState('');
  const [status, setStatus] = useState('Ready');
  const [systemInfo, setSystemInfo] = useState<SystemInfo | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function loadSettings() {
      const storedSettings = readStoredSettings();
      let storedSecrets: Partial<AppSecrets> = {};

      try {
        storedSecrets = await invoke<Partial<AppSecrets>>('read_app_secrets');
      } catch (error) {
        setStatus(error instanceof Error ? error.message : String(error));
      }

      if (cancelled) {
        return;
      }

      setSettings({
        ...DEFAULT_SETTINGS,
        ...storedSettings,
        ...pickSecrets(storedSettings),
        ...storedSecrets,
      });
      setSettingsLoaded(true);
    }

    void loadSettings();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!settingsLoaded) {
      return;
    }

    window.localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(omitSecrets(settings)));
    invoke('save_app_secrets', { secrets: pickSecrets(settings) }).catch((error: unknown) => {
      setStatus(error instanceof Error ? error.message : String(error));
    });
    invoke('sync_local_proxy_settings', { settings }).catch((error: unknown) => {
      setStatus(error instanceof Error ? error.message : String(error));
    });
  }, [settings, settingsLoaded]);

  const scheduler = useMemo(
    () =>
      new TranslationScheduler({
        defaultProvider: settings.provider,
        httpClient: tauriHttpClient,
        google: settings.googleApiKey ? { apiKey: settings.googleApiKey } : undefined,
        baidu:
          settings.baiduAppId && settings.baiduSecretKey
            ? { appId: settings.baiduAppId, secretKey: settings.baiduSecretKey }
            : undefined,
        deepl: settings.deeplApiKey
          ? { apiKey: settings.deeplApiKey, apiType: settings.deeplApiType }
          : undefined,
        microsoft: settings.microsoftApiKey
          ? {
              apiKey: settings.microsoftApiKey,
              region: settings.microsoftRegion,
              endpoint: settings.microsoftEndpoint,
            }
          : undefined,
        youdao:
          settings.youdaoAppKey && settings.youdaoAppSecret
            ? { appKey: settings.youdaoAppKey, appSecret: settings.youdaoAppSecret }
            : undefined,
        tencent:
          settings.tencentSecretId && settings.tencentSecretKey
            ? {
                secretId: settings.tencentSecretId,
                secretKey: settings.tencentSecretKey,
                region: settings.tencentRegion,
              }
            : undefined,
        ai:
          settings.provider === 'ai' && settings.aiApiKey && settings.aiBaseUrl && settings.aiModel
            ? {
                apiKey: settings.aiApiKey,
                baseUrl: settings.aiBaseUrl,
                model: settings.aiModel,
              }
            : undefined,
      }),
    [settings],
  );

  async function translate() {
    setStatus('Translating');
    try {
      if (settings.provider === 'ai' && !settings.aiApiKey) {
        setStatus('AI provider requires an API key');
        return;
      }

      if (settings.provider === 'google-free' && !settings.googleApiKey) {
        setStatus('Google Cloud Translation requires an API key');
        return;
      }

      if (settings.provider === 'baidu-free' && (!settings.baiduAppId || !settings.baiduSecretKey)) {
        setStatus('Baidu Translate requires APP ID and secret key');
        return;
      }

      if (settings.provider === 'deepl' && !settings.deeplApiKey) {
        setStatus('DeepL requires an API key');
        return;
      }

      if (settings.provider === 'microsoft' && !settings.microsoftApiKey) {
        setStatus('Microsoft Translator requires an API key');
        return;
      }

      if (settings.provider === 'youdao' && (!settings.youdaoAppKey || !settings.youdaoAppSecret)) {
        setStatus('Youdao Translate requires app key and app secret');
        return;
      }

      if (settings.provider === 'tencent' && (!settings.tencentSecretId || !settings.tencentSecretKey)) {
        setStatus('Tencent Cloud TMT requires secret id and secret key');
        return;
      }

      const response = await scheduler.translate({
        text: sourceText,
        targetLanguage: settings.targetLanguage,
        provider: settings.provider,
      });
      setTranslatedText(response.text);
      setStatus(response.cached ? 'Loaded from cache' : 'Translated');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  }

  async function readClipboard() {
    try {
      const value = await invoke<string>('read_clipboard_text');
      setSourceText(value);
      setStatus('Clipboard loaded');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  }

  async function loadSystemInfo() {
    try {
      const value = await invoke<SystemInfo>('system_info');
      const focused = await invoke<boolean>('window_is_focused');
      setSystemInfo(value);
      setStatus(focused ? 'Window focused' : 'Window not focused');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  }

  async function clearSavedSecrets() {
    try {
      await invoke('delete_app_secrets');
      setSettings({
        ...settings,
        aiApiKey: '',
        googleApiKey: '',
        baiduSecretKey: '',
        deeplApiKey: '',
        microsoftApiKey: '',
        youdaoAppSecret: '',
        tencentSecretKey: '',
      });
      setStatus('Saved secrets cleared');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  }

  return (
    <main className="min-h-screen bg-background text-foreground">
      <div className="mx-auto grid min-h-screen w-full max-w-6xl gap-6 px-5 py-6 lg:grid-cols-[320px_1fr]">
        <aside className="rounded-lg border bg-card p-5 text-card-foreground">
          <p className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
            LingFlow
          </p>
          <h1 className="mt-3 text-2xl font-semibold">Translation Console</h1>
          <p className="mt-3 text-sm leading-6 text-muted-foreground">
            Desktop-first Tauri shell with shared translation core and responsive layout.
          </p>

          <label className="mt-6 block text-xs font-medium text-muted-foreground">
            Provider
            <select
              className="mt-1 w-full rounded-md border bg-background px-2 py-2 text-sm text-foreground"
              value={settings.provider}
              onChange={(event) =>
                setSettings({ ...settings, provider: event.currentTarget.value as TranslatorProvider })
              }
            >
              <option value="google-free">Google Cloud</option>
              <option value="baidu-free">Baidu Translate</option>
              <option value="deepl">DeepL</option>
              <option value="microsoft">Microsoft Translator</option>
              <option value="youdao">Youdao Translate</option>
              <option value="tencent">Tencent Cloud TMT</option>
              <option value="ai">AI</option>
              <option value="mock">Mock</option>
            </select>
          </label>

          <label className="mt-4 block text-xs font-medium text-muted-foreground">
            Target language
            <input
              className="mt-1 w-full rounded-md border bg-background px-2 py-2 text-sm text-foreground"
              value={settings.targetLanguage}
              onChange={(event) => setSettings({ ...settings, targetLanguage: event.currentTarget.value })}
            />
          </label>

          {settings.provider === 'google-free' && (
            <div className="mt-4 grid gap-2">
              <input
                className="rounded-md border bg-background px-2 py-2 text-sm text-foreground"
                placeholder="Google Cloud API key"
                type="password"
                value={settings.googleApiKey}
                onChange={(event) => setSettings({ ...settings, googleApiKey: event.currentTarget.value })}
              />
            </div>
          )}

          {settings.provider === 'baidu-free' && (
            <div className="mt-4 grid gap-2">
              <input
                className="rounded-md border bg-background px-2 py-2 text-sm text-foreground"
                placeholder="Baidu APP ID"
                value={settings.baiduAppId}
                onChange={(event) => setSettings({ ...settings, baiduAppId: event.currentTarget.value })}
              />
              <input
                className="rounded-md border bg-background px-2 py-2 text-sm text-foreground"
                placeholder="Baidu secret key"
                type="password"
                value={settings.baiduSecretKey}
                onChange={(event) => setSettings({ ...settings, baiduSecretKey: event.currentTarget.value })}
              />
            </div>
          )}

          {settings.provider === 'deepl' && (
            <div className="mt-4 grid gap-2">
              <select
                className="rounded-md border bg-background px-2 py-2 text-sm text-foreground"
                value={settings.deeplApiType}
                onChange={(event) =>
                  setSettings({ ...settings, deeplApiType: event.currentTarget.value as 'free' | 'pro' })
                }
              >
                <option value="free">DeepL API Free</option>
                <option value="pro">DeepL API Pro</option>
              </select>
              <input
                className="rounded-md border bg-background px-2 py-2 text-sm text-foreground"
                placeholder="DeepL API key"
                type="password"
                value={settings.deeplApiKey}
                onChange={(event) => setSettings({ ...settings, deeplApiKey: event.currentTarget.value })}
              />
            </div>
          )}

          {settings.provider === 'microsoft' && (
            <div className="mt-4 grid gap-2">
              <input
                className="rounded-md border bg-background px-2 py-2 text-sm text-foreground"
                placeholder="Microsoft Translator API key"
                type="password"
                value={settings.microsoftApiKey}
                onChange={(event) => setSettings({ ...settings, microsoftApiKey: event.currentTarget.value })}
              />
              <input
                className="rounded-md border bg-background px-2 py-2 text-sm text-foreground"
                placeholder="Region, for example eastasia"
                value={settings.microsoftRegion}
                onChange={(event) => setSettings({ ...settings, microsoftRegion: event.currentTarget.value })}
              />
              <input
                className="rounded-md border bg-background px-2 py-2 text-sm text-foreground"
                placeholder="Endpoint"
                value={settings.microsoftEndpoint}
                onChange={(event) => setSettings({ ...settings, microsoftEndpoint: event.currentTarget.value })}
              />
            </div>
          )}

          {settings.provider === 'youdao' && (
            <div className="mt-4 grid gap-2">
              <input
                className="rounded-md border bg-background px-2 py-2 text-sm text-foreground"
                placeholder="Youdao app key"
                value={settings.youdaoAppKey}
                onChange={(event) => setSettings({ ...settings, youdaoAppKey: event.currentTarget.value })}
              />
              <input
                className="rounded-md border bg-background px-2 py-2 text-sm text-foreground"
                placeholder="Youdao app secret"
                type="password"
                value={settings.youdaoAppSecret}
                onChange={(event) => setSettings({ ...settings, youdaoAppSecret: event.currentTarget.value })}
              />
            </div>
          )}

          {settings.provider === 'tencent' && (
            <div className="mt-4 grid gap-2">
              <input
                className="rounded-md border bg-background px-2 py-2 text-sm text-foreground"
                placeholder="Tencent SecretId"
                value={settings.tencentSecretId}
                onChange={(event) => setSettings({ ...settings, tencentSecretId: event.currentTarget.value })}
              />
              <input
                className="rounded-md border bg-background px-2 py-2 text-sm text-foreground"
                placeholder="Tencent SecretKey"
                type="password"
                value={settings.tencentSecretKey}
                onChange={(event) => setSettings({ ...settings, tencentSecretKey: event.currentTarget.value })}
              />
              <input
                className="rounded-md border bg-background px-2 py-2 text-sm text-foreground"
                placeholder="Region"
                value={settings.tencentRegion}
                onChange={(event) => setSettings({ ...settings, tencentRegion: event.currentTarget.value })}
              />
            </div>
          )}

          {settings.provider === 'ai' && (
            <div className="mt-4 grid gap-2">
              <input
                className="rounded-md border bg-background px-2 py-2 text-sm text-foreground"
                placeholder="AI base URL"
                value={settings.aiBaseUrl}
                onChange={(event) => setSettings({ ...settings, aiBaseUrl: event.currentTarget.value })}
              />
              <input
                className="rounded-md border bg-background px-2 py-2 text-sm text-foreground"
                placeholder="AI model"
                value={settings.aiModel}
                onChange={(event) => setSettings({ ...settings, aiModel: event.currentTarget.value })}
              />
              <input
                className="rounded-md border bg-background px-2 py-2 text-sm text-foreground"
                placeholder="API key"
                type="password"
                value={settings.aiApiKey}
                onChange={(event) => setSettings({ ...settings, aiApiKey: event.currentTarget.value })}
              />
            </div>
          )}

          {settings.provider !== 'mock' && (
            <p className="mt-4 text-xs leading-5 text-muted-foreground">
              Real providers send text to the selected translation service.
            </p>
          )}

          <div className="mt-5 grid gap-2">
            <button className="rounded-md border px-3 py-2 text-sm font-medium" type="button" onClick={translate}>
              Translate
            </button>
            <button
              className="rounded-md border px-3 py-2 text-sm font-medium"
              type="button"
              onClick={readClipboard}
            >
              Read clipboard
            </button>
            <button
              className="rounded-md border px-3 py-2 text-sm font-medium"
              type="button"
              onClick={loadSystemInfo}
            >
              System info
            </button>
            <button
              className="rounded-md border px-3 py-2 text-sm font-medium"
              type="button"
              onClick={clearSavedSecrets}
            >
              Clear saved secrets
            </button>
          </div>

          <p className="mt-4 text-xs leading-5 text-muted-foreground">{status}</p>
          {systemInfo && (
            <p className="mt-3 text-xs leading-5 text-muted-foreground">
              {systemInfo.os} / {systemInfo.arch} / {systemInfo.family}
            </p>
          )}
        </aside>

        <section className="grid gap-4 lg:grid-rows-2">
          <label className="grid rounded-lg border bg-card p-5 text-card-foreground">
            <span className="text-sm font-medium">Source text</span>
            <textarea
              className="mt-3 min-h-[220px] resize-none rounded-md border bg-background p-3 text-sm leading-6 text-foreground"
              value={sourceText}
              onChange={(event) => setSourceText(event.currentTarget.value)}
            />
          </label>

          <section className="rounded-lg border bg-card p-5 text-card-foreground">
            <h2 className="text-sm font-medium">Translation result</h2>
            <div className="mt-3 min-h-[220px] rounded-md border bg-background p-3 text-sm leading-6 text-foreground">
              {translatedText || <span className="text-muted-foreground">No translation yet.</span>}
            </div>
          </section>
        </section>
      </div>
    </main>
  );
}

export default App;

function readStoredSettings(): Partial<AppSettings> {
  const raw = window.localStorage.getItem(SETTINGS_STORAGE_KEY);
  if (!raw) {
    return {};
  }

  try {
    return JSON.parse(raw) as Partial<AppSettings>;
  } catch {
    window.localStorage.removeItem(SETTINGS_STORAGE_KEY);
    return {};
  }
}

function pickSecrets(settings: Partial<AppSettings>): Partial<AppSecrets> {
  return {
    aiApiKey: settings.aiApiKey,
    googleApiKey: settings.googleApiKey,
    baiduSecretKey: settings.baiduSecretKey,
    deeplApiKey: settings.deeplApiKey,
    microsoftApiKey: settings.microsoftApiKey,
    youdaoAppSecret: settings.youdaoAppSecret,
    tencentSecretKey: settings.tencentSecretKey,
  };
}

function omitSecrets(settings: AppSettings) {
  return {
    provider: settings.provider,
    targetLanguage: settings.targetLanguage,
    aiBaseUrl: settings.aiBaseUrl,
    aiModel: settings.aiModel,
    baiduAppId: settings.baiduAppId,
    deeplApiType: settings.deeplApiType,
    microsoftRegion: settings.microsoftRegion,
    microsoftEndpoint: settings.microsoftEndpoint,
    youdaoAppKey: settings.youdaoAppKey,
    tencentSecretId: settings.tencentSecretId,
    tencentRegion: settings.tencentRegion,
  };
}

const tauriHttpClient: ProviderHttpClient = async (input, init) => {
  const response = await invoke<HttpResponse>('http_request', {
    request: {
      url: input instanceof URL ? input.toString() : String(input),
      method: init?.method ?? 'GET',
      headers: normalizeHeaders(init?.headers),
      body: normalizeBody(init?.body),
    },
  });

  return new Response(response.body, {
    status: response.status,
  });
};

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

  throw new Error('Unsupported Tauri HTTP request body type');
}
