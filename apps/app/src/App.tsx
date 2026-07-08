import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeftRight,
  Copy,
  Database,
  ExternalLink,
  Eraser,
  GripVertical,
  History,
  Languages,
  Maximize2,
  Minus,
  Moon,
  Play,
  Plus,
  Radar,
  RefreshCcw,
  Search,
  Settings,
  ShieldCheck,
  SlidersHorizontal,
  Sun,
  Trash2,
  X,
} from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { PhysicalPosition, PhysicalSize } from '@tauri-apps/api/dpi';
import { listen } from '@tauri-apps/api/event';
import { WebviewWindow, getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { TranslationScheduler, type AiServiceSourceConfig, type ProviderHttpClient, type TranslatorProvider } from '@lingflow/core';
import { LingFlowLogo } from '@/components/lingflow-logo';
import { Button, Card, Field, SelectInput, TextInput, Toggle } from '@/components/ui';
import { cn } from '@/lib/utils';

interface AppSettings {
  readonly provider: TranslatorProvider;
  readonly targetLanguage: string;
  readonly darkMode: boolean;
  readonly onboardingCompleted: boolean;
  readonly localProxyHost: string;
  readonly localProxyPort: number;
  readonly globalSelectionEnabled: boolean;
  readonly globalSelectionExcludedApps: readonly string[];
  readonly aiFallbackEnabled: boolean;
  readonly aiSources: readonly AiServiceSourceConfig[];
  readonly aiBaseUrl?: string;
  readonly aiModel?: string;
  readonly aiApiKey?: string;
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

interface HistoryItem {
  readonly id: string;
  readonly source: string;
  readonly target: string;
  readonly provider: TranslatorProvider;
  readonly targetLanguage: string;
  readonly timestamp: Date;
  readonly cached: boolean;
}

type AppSecrets = Pick<
  AppSettings,
  | 'googleApiKey'
  | 'baiduSecretKey'
  | 'deeplApiKey'
  | 'microsoftApiKey'
  | 'youdaoAppSecret'
  | 'tencentSecretKey'
> & {
  readonly aiApiKey?: string;
  readonly aiSourceApiKeys?: Record<string, string>;
};

type ServiceHealth = 'unknown' | 'checking' | 'ok' | 'partial' | 'error';
type ProviderUsage = Partial<Record<TranslatorProvider, number>>;
type MonthlyProviderUsage = Record<string, ProviderUsage>;
type ProviderHealth = Partial<Record<TranslatorProvider, ServiceHealth>>;
type ViewId = 'translate' | 'settings' | 'app-settings' | 'history';

interface ExternalSelectionPayload {
  readonly text: string;
  readonly x: number;
  readonly y: number;
}

interface SelectionDiagnostics {
  readonly stage: string;
  readonly cursorPosition?: { readonly x: number; readonly y: number } | null;
  readonly processName?: string | null;
  readonly excluded: boolean;
  readonly attempts: readonly { readonly strategy: string; readonly ok: boolean; readonly detail: string }[];
  readonly resultLength?: number | null;
  readonly error?: string | null;
}

interface UpdateAsset {
  readonly name: string;
  readonly browserDownloadUrl: string;
  readonly size: number;
}

interface UpdateInfo {
  readonly currentVersion: string;
  readonly latestVersion: string;
  readonly hasUpdate: boolean;
  readonly releaseUrl: string;
  readonly releaseName?: string | null;
  readonly publishedAt?: string | null;
  readonly body?: string | null;
  readonly assets: readonly UpdateAsset[];
}

interface AiModelCatalog {
  readonly error?: string;
  readonly loading: boolean;
  readonly models: readonly string[];
}

const SETTINGS_STORAGE_KEY = 'lingflow.app.settings';
const USAGE_STORAGE_KEY = 'lingflow.providerUsage.monthly';
const HISTORY_STORAGE_KEY = 'lingflow.translation.history';
const SELECTION_TEXT_STORAGE_KEY = 'lingflow.selection.text';
const SELECTION_OVERLAY_LABEL = 'selection-overlay';
const GLOBAL_MOUSE_UP_EVENT = 'lingflow://global-mouse-up';
const DEFAULT_AI_SOURCE_ID = 'openai-default';
const PROVIDER_USAGE_EVENT = 'lingflow://provider-usage';
const EXTERNAL_SELECTION_EVENT = 'lingflow://external-selection';
const DEFAULT_GLOBAL_SELECTION_EXCLUDED_APPS = [
  'app.exe',
  'ApplicationFrameHost.exe',
  'cmd.exe',
  'Code.exe',
  'compmgmt.msc',
  'conhost.exe',
  'devenv.exe',
  'explorer.exe',
  'mmc.exe',
  'OpenConsole.exe',
  'powershell.exe',
  'pwsh.exe',
  'SearchHost.exe',
  'ShellExperienceHost.exe',
  'StartMenuExperienceHost.exe',
  'SystemSettings.exe',
  'taskmgr.exe',
  'TextInputHost.exe',
  'WindowsTerminal.exe',
  'wt.exe',
] as const;

const DEFAULT_SETTINGS: AppSettings = {
  provider: 'ai',
  targetLanguage: 'zh-CN',
  darkMode: false,
  onboardingCompleted: false,
  localProxyHost: '127.0.0.1',
  localProxyPort: 47631,
  globalSelectionEnabled: false,
  globalSelectionExcludedApps: DEFAULT_GLOBAL_SELECTION_EXCLUDED_APPS,
  aiFallbackEnabled: true,
  aiSources: [
    {
      id: DEFAULT_AI_SOURCE_ID,
      name: 'OpenAI Compatible',
      baseUrl: 'https://one.gloscai.com',
      apiKey: '',
      models: ['gpt-4.1-mini'],
      enabled: true,
    },
  ],
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

const PROVIDERS: ReadonlyArray<{ id: TranslatorProvider; name: string; group: 'AI' | 'Cloud' }> = [
  { id: 'ai', name: 'AI 翻译', group: 'AI' },
  { id: 'google-free', name: 'Google Cloud', group: 'Cloud' },
  { id: 'baidu-free', name: '百度翻译', group: 'Cloud' },
  { id: 'deepl', name: 'DeepL', group: 'Cloud' },
  { id: 'microsoft', name: 'Microsoft Translator', group: 'Cloud' },
  { id: 'youdao', name: '有道翻译', group: 'Cloud' },
  { id: 'tencent', name: '腾讯云 TMT', group: 'Cloud' },
];

declare global {
  interface Window {
    __lingflowSelectionDiagnostics?: () => Promise<SelectionDiagnostics>;
  }
}

const LANGUAGE_OPTIONS = [
  { value: 'zh-CN', label: '中文（简体）' },
  { value: 'en', label: 'English' },
  { value: 'ja', label: '日本語' },
  { value: 'ko', label: '한국어' },
  { value: 'fr', label: 'Français' },
  { value: 'de', label: 'Deutsch' },
];

function App() {
  if (new URLSearchParams(window.location.search).get('overlay') === 'selection') {
    return <SelectionOverlayApp />;
  }

  return <LingFlowApp />;
}

function LingFlowApp() {
  const [activeView, setActiveView] = useState<ViewId>('translate');
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [sourceLanguage, setSourceLanguage] = useState('auto');
  const [sourceText, setSourceText] = useState('LingFlow makes translation flow into reading, notes, and bilingual web pages.');
  const [translatedText, setTranslatedText] = useState('');
  const [status, setStatus] = useState('服务待命');
  const [isTranslating, setIsTranslating] = useState(false);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [historySearch, setHistorySearch] = useState('');
  const [providerUsage, setProviderUsage] = useState<ProviderUsage>({});
  const [usageMonth, setUsageMonth] = useState(currentUsageMonthKey());
  const [providerHealth, setProviderHealth] = useState<ProviderHealth>({});
  const [isTestingProviders, setIsTestingProviders] = useState(false);
  const globalSelectionBusyRef = useRef(false);
  const lastGlobalSelectionEventAtRef = useRef(0);
  const usageMonthRef = useRef(currentUsageMonthKey());
  const isMobileClient = isMobileRuntime();
  const globalSelectionAvailable = !isMobileClient;

  const recordProviderUsage = useCallback((provider: string, characters: number) => {
    if (!isTranslatorProvider(provider) || !Number.isFinite(characters) || characters <= 0) {
      return;
    }

    const normalizedCharacters = Math.floor(characters);
    const monthKey = currentUsageMonthKey();
    const isNewMonth = usageMonthRef.current !== monthKey;
    if (isNewMonth) {
      usageMonthRef.current = monthKey;
      setUsageMonth(monthKey);
    }

    setProviderUsage((usage) => {
      const baseUsage = isNewMonth ? {} : usage;
      const nextUsage = {
        ...baseUsage,
        [provider]: (baseUsage[provider] ?? 0) + normalizedCharacters,
      };
      void writeMonthlyProviderUsage(monthKey, nextUsage);
      return nextUsage;
    });
  }, []);

  useEffect(() => {
    document.documentElement.classList.toggle('dark', settings.darkMode);
  }, [settings.darkMode]);

  useEffect(() => {
    let cancelled = false;
    void readCurrentMonthlyProviderUsage().then((usage) => {
      if (!cancelled) {
        const monthKey = currentUsageMonthKey();
        usageMonthRef.current = monthKey;
        setUsageMonth(monthKey);
        setProviderUsage(usage);
      }
    });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!canUseTauri()) {
      return;
    }

    let disposed = false;
    const unlistenPromise = listen<{ readonly provider: string; readonly characters: number }>(PROVIDER_USAGE_EVENT, (event) => {
      if (disposed) {
        return;
      }
      recordProviderUsage(event.payload.provider, event.payload.characters);
    });

    return () => {
      disposed = true;
      void unlistenPromise.then((unlisten) => unlisten());
    };
  }, [recordProviderUsage]);

  useEffect(() => {
    if (!canUseTauri() || !globalSelectionAvailable) {
      return;
    }

    let disposed = false;
    const unlistenPromise = listen<ExternalSelectionPayload>(EXTERNAL_SELECTION_EVENT, (event) => {
      if (disposed || !settings.globalSelectionEnabled) {
        return;
      }

      const text = event.payload.text.trim();
      if (!text) {
        return;
      }

      console.debug('[LingFlow selection] external browser selection received', {
        characters: text.length,
        x: event.payload.x,
        y: event.payload.y,
      });
      void showSelectionOverlay(text, event.payload.x + 14, event.payload.y + 16);
    });

    return () => {
      disposed = true;
      void unlistenPromise.then((unlisten) => unlisten());
    };
  }, [globalSelectionAvailable, settings.globalSelectionEnabled]);

  useEffect(() => {
    if (!canUseTauri() || !globalSelectionAvailable) {
      return;
    }

    window.__lingflowSelectionDiagnostics = async () => {
      const diagnostics = await invoke<SelectionDiagnostics>('selection_diagnostics');
      console.table(diagnostics.attempts);
      console.info('[LingFlow selection diagnostics]', diagnostics);
      return diagnostics;
    };

    return () => {
      delete window.__lingflowSelectionDiagnostics;
    };
  }, [globalSelectionAvailable]);

  useEffect(() => {
    if (!settingsLoaded || !settings.globalSelectionEnabled || !canUseTauri() || !globalSelectionAvailable) {
      return;
    }

    let disposed = false;
    const mainWindow = getCurrentWebviewWindow();
    const unlistenPromise = listen<{ readonly x: number; readonly y: number }>(GLOBAL_MOUSE_UP_EVENT, (event) => {
      if (disposed) {
        console.debug('[LingFlow selection] ignored because listener is disposed', event.payload);
        return;
      }
      if (globalSelectionBusyRef.current) {
        console.debug('[LingFlow selection] ignored because capture is busy', event.payload);
        return;
      }

      const now = Date.now();
      if (now - lastGlobalSelectionEventAtRef.current < 400) {
        console.debug('[LingFlow selection] ignored by frontend debounce', event.payload);
        return;
      }
      lastGlobalSelectionEventAtRef.current = now;
      globalSelectionBusyRef.current = true;
      console.debug('[LingFlow selection] mouse-up event received', event.payload);

      void mainWindow
        .isFocused()
        .then((isFocused) => {
          if (isFocused) {
            console.debug('[LingFlow selection] ignored because LingFlow main window is focused');
            return undefined;
          }
          return detectGlobalSelection(settings, event.payload);
        })
        .finally(() => {
          globalSelectionBusyRef.current = false;
        });
    });

    return () => {
      disposed = true;
      void unlistenPromise.then((unlisten) => unlisten());
    };
  }, [globalSelectionAvailable, settings, settingsLoaded]);

  useEffect(() => {
    let cancelled = false;

    async function loadSettings() {
      const storedSettings = await readStoredSettings();
      const storedHistory = await readStoredHistory();
      let storedSecrets: Partial<AppSecrets> = {};

      if (canUseTauri()) {
        try {
          storedSecrets = await invoke<Partial<AppSecrets>>('read_app_secrets');
        } catch (error) {
          setStatus(error instanceof Error ? error.message : String(error));
        }
      }

      if (!cancelled) {
        setSettings(normalizeSettingsForRuntime(mergeStoredSettings(storedSettings, storedSecrets)));
        setHistory(storedHistory);
        setSettingsLoaded(true);
      }
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

    const runtimeSettings = normalizeSettingsForRuntime(settings);
    void writeStoredSettings(omitSecrets(runtimeSettings));
    if (!canUseTauri()) {
      return;
    }

    invoke('save_app_secrets', { secrets: pickSecrets(runtimeSettings) }).catch((error: unknown) => {
      setStatus(error instanceof Error ? error.message : String(error));
    });

    if (!isMobileClient) {
      invoke('sync_local_proxy_settings', { settings: runtimeSettings }).catch((error: unknown) => {
        setStatus(error instanceof Error ? error.message : String(error));
      });
    }
  }, [isMobileClient, settings, settingsLoaded]);

  const scheduler = useMemo(() => createScheduler(settings), [settings]);
  const activeProvider = getProvider(settings.provider);
  const filteredHistory = history.filter((item) => {
    const keyword = historySearch.trim().toLowerCase();
    if (!keyword) {
      return true;
    }
    return (
      item.source.toLowerCase().includes(keyword) ||
      item.target.toLowerCase().includes(keyword) ||
      getProvider(item.provider).name.toLowerCase().includes(keyword)
    );
  });

  async function translate() {
    await translateText(sourceText);
  }

  async function translateText(text: string) {
    const trimmedText = text.trim();
    if (!trimmedText) {
      setStatus('请输入要翻译的文本');
      return;
    }

    const providerError = validateProvider(settings);
    if (providerError) {
      setStatus(providerError);
      setActiveView('settings');
      return;
    }

    setStatus('正在翻译');
    setIsTranslating(true);
    try {
      const response = await scheduler.translate({
        text: trimmedText,
        sourceLanguage: sourceLanguage === 'auto' ? undefined : sourceLanguage,
        targetLanguage: settings.targetLanguage,
        provider: settings.provider,
      });
      setTranslatedText(response.text);
      setStatus(response.cached ? '命中本地缓存' : '翻译完成');
      recordProviderUsage(response.provider, response.sourceText.length);
      const historyItem: HistoryItem = {
        id: `${Date.now()}`,
        source: response.sourceText,
        target: response.text,
        provider: response.provider,
        targetLanguage: response.targetLanguage,
        timestamp: new Date(),
        cached: Boolean(response.cached),
      };
      setHistory((items) => {
        const nextItems = [historyItem, ...items].slice(0, 500);
        void writeStoredHistory(nextItems);
        return nextItems;
      });
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setIsTranslating(false);
    }
  }

  async function copyTranslation() {
    if (!translatedText) {
      setStatus('暂无可复制译文');
      return;
    }

    try {
      await navigator.clipboard.writeText(translatedText);
      setStatus('译文已复制');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  }

  async function clearSavedSecrets() {
    try {
      if (canUseTauri()) {
        await invoke('delete_app_secrets');
      }
      setSettings({
        ...settings,
        aiSources: settings.aiSources.map((source) => ({ ...source, apiKey: '' })),
        googleApiKey: '',
        baiduSecretKey: '',
        deeplApiKey: '',
        microsoftApiKey: '',
        youdaoAppSecret: '',
        tencentSecretKey: '',
      });
      setStatus('已清除保存的密钥');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  }

  async function testConfiguredProviders() {
    const configuredProviders = getConfiguredProviders(settings);
    if (configuredProviders.length === 0) {
      setStatus('暂无已配置服务');
      return;
    }

    setIsTestingProviders(true);
    setProviderHealth((health) => ({
      ...health,
      ...Object.fromEntries(configuredProviders.map((provider) => [provider.id, 'checking' as const])),
    }));
    setStatus('正在测试已配置服务');

    for (const provider of configuredProviders) {
      const health = await testProvider(provider.id);
      setProviderHealth((current) => ({ ...current, [provider.id]: health }));
    }

    setStatus('服务可用性测试完成');
    setIsTestingProviders(false);
  }

  async function testProvider(provider: TranslatorProvider): Promise<ServiceHealth> {
    try {
      if (provider !== 'ai') {
        await scheduler.translate({
          text: 'Hello',
          sourceLanguage: 'en',
          targetLanguage: settings.targetLanguage,
          provider,
        });
        return 'ok';
      }

      const results = await Promise.all(
        getConfiguredAiSources(settings.aiSources).map(async (source) => {
          try {
            const sourceScheduler = new TranslationScheduler({
              defaultProvider: 'ai',
              httpClient: tauriHttpClient,
              ai: { sources: [source], fallbackEnabled: true },
            });
            await sourceScheduler.translate({
              text: 'Hello',
              sourceLanguage: 'en',
              targetLanguage: settings.targetLanguage,
              provider: 'ai',
            });
            return true;
          } catch {
            return false;
          }
        }),
      );

      if (results.every(Boolean)) {
        return 'ok';
      }
      return results.some(Boolean) ? 'partial' : 'error';
    } catch {
      return 'error';
    }
  }

  function completeOnboarding(nextView: ViewId = 'translate') {
    setSettings({ ...settings, onboardingCompleted: true });
    setActiveView(nextView);
  }

  if (settingsLoaded && !settings.onboardingCompleted) {
    return (
      <OnboardingScreen
        darkMode={settings.darkMode}
        onConfigureProvider={() => completeOnboarding('settings')}
        onOpenKeyPage={() => void openExternalUrl('https://one.gloscai.com/keys')}
        onStart={() => completeOnboarding('translate')}
        onToggleDarkMode={() => setSettings({ ...settings, darkMode: !settings.darkMode })}
        showGlobalSelectionStep={globalSelectionAvailable}
      />
    );
  }

  if (isMobileClient) {
    return (
      <MobileAppShell
        activeProvider={activeProvider}
        activeView={activeView}
        clearSavedSecrets={clearSavedSecrets}
        copyTranslation={copyTranslation}
        filteredHistory={filteredHistory}
        history={history}
        historySearch={historySearch}
        isTranslating={isTranslating}
        onSourceLanguageChange={setSourceLanguage}
        onTargetLanguageChange={(value) => setSettings({ ...settings, targetLanguage: value })}
        onTranslate={translate}
        providerUsage={providerUsage}
        setActiveView={setActiveView}
        setHistorySearch={setHistorySearch}
        setSettings={setSettings}
        setSourceText={setSourceText}
        setTranslatedText={setTranslatedText}
        settings={settings}
        sourceLanguage={sourceLanguage}
        sourceText={sourceText}
        status={status}
        translatedText={translatedText}
        usageMonth={usageMonth}
      />
    );
  }

  return (
    <main className="app-shell bg-[var(--bg)] text-[var(--fg)]">
      <header className="topbar">
        <LingFlowLogo showWordmark />
        <div className="topbar-actions">
          <Button
            aria-label="切换主题"
            onClick={() => setSettings({ ...settings, darkMode: !settings.darkMode })}
            size="icon"
            variant="ghost"
          >
            {settings.darkMode ? <Sun size={17} /> : <Moon size={17} />}
          </Button>
          {isMobileClient ? null : <WindowControls />}
        </div>
      </header>

      <aside className="sidebar">
        <NavButton active={activeView === 'translate'} icon={<Languages size={18} />} onClick={() => setActiveView('translate')}>
          翻译工作台
        </NavButton>
        <NavButton active={activeView === 'settings'} icon={<Settings size={18} />} onClick={() => setActiveView('settings')}>
          服务源配置
        </NavButton>
        <NavButton active={activeView === 'app-settings'} icon={<SlidersHorizontal size={18} />} onClick={() => setActiveView('app-settings')}>
          软件设置
        </NavButton>
        <NavButton active={activeView === 'history'} icon={<History size={18} />} onClick={() => setActiveView('history')}>
          翻译历史
        </NavButton>
        <div className="mt-4 border-t border-[var(--border)] pt-4">
          <p className="px-3 text-[10px] font-semibold uppercase text-[var(--muted)]">当前服务</p>
          {PROVIDERS.slice(0, 5).map((provider) => (
            <button
              className={cn('provider-mini mt-1 w-full', settings.provider === provider.id && 'active')}
              key={provider.id}
              onClick={() => setSettings({ ...settings, provider: provider.id })}
              type="button"
            >
              <span className={cn('provider-dot', provider.group === 'AI' ? 'ai' : 'cloud')} />
              <span className="min-w-0 flex-1 truncate text-left">{provider.name}</span>
            </button>
          ))}
        </div>
      </aside>

      <section className="main-content">
        <StatusStrip detail={`${activeProvider.name} / ${labelForLanguage(settings.targetLanguage)} / ${sourceText.length} 字符`} status={status} />
        {activeView === 'translate' ? (
          <TranslateView
            isTranslating={isTranslating}
            onCopy={copyTranslation}
            onSourceChange={setSourceText}
            onSourceLanguageChange={setSourceLanguage}
            onTargetLanguageChange={(value) => setSettings({ ...settings, targetLanguage: value })}
            onTranslate={translate}
            sourceLanguage={sourceLanguage}
            sourceText={sourceText}
            targetLanguage={settings.targetLanguage}
            translatedText={translatedText}
          />
        ) : null}
        {activeView === 'settings' ? (
          <SettingsView onClearSecrets={clearSavedSecrets} onSettingsChange={setSettings} secretStoreLabel="Tauri Secret Store" settings={settings} />
        ) : null}
        {activeView === 'app-settings' ? (
          <AppSettingsView globalSelectionAvailable={globalSelectionAvailable} localProxyAvailable onSettingsChange={setSettings} settings={settings} />
        ) : null}
        {activeView === 'history' ? (
          <HistoryView
            history={filteredHistory}
            onSearchChange={setHistorySearch}
            onUseItem={(item) => {
              setSourceText(item.source);
              setTranslatedText(item.target);
              setSettings({ ...settings, provider: item.provider, targetLanguage: item.targetLanguage });
              setActiveView('translate');
            }}
            search={historySearch}
          />
        ) : null}
      </section>

      <aside className="right-rail">
        {globalSelectionAvailable ? (
          <Card className="bg-[var(--surface-raised)]" title="全局划词">
            <div className="grid gap-4 p-4">
              <Toggle
                checked={settings.globalSelectionEnabled}
                label="启用全局划词"
                onChange={(checked) => setSettings({ ...settings, globalSelectionEnabled: checked })}
              />
            </div>
          </Card>
        ) : null}
        <ServiceStatusCard
          health={providerHealth}
          isTesting={isTestingProviders}
          onProviderSelect={(provider) => setSettings({ ...settings, provider })}
          onTest={testConfiguredProviders}
          selectedProvider={settings.provider}
          settings={settings}
          usage={providerUsage}
          usageMonth={usageMonth}
        />
        <RecentTranslations history={history} onUse={(item) => {
          setSourceText(item.source);
          setTranslatedText(item.target);
          setActiveView('translate');
        }} />
      </aside>
    </main>
  );
}

export default App;

function MobileAppShell({
  activeProvider,
  activeView,
  clearSavedSecrets,
  copyTranslation,
  filteredHistory,
  history,
  historySearch,
  isTranslating,
  onSourceLanguageChange,
  onTargetLanguageChange,
  onTranslate,
  providerUsage,
  setActiveView,
  setHistorySearch,
  setSettings,
  setSourceText,
  setTranslatedText,
  settings,
  sourceLanguage,
  sourceText,
  status,
  translatedText,
  usageMonth,
}: {
  readonly activeProvider: { readonly id: TranslatorProvider; readonly name: string; readonly group: 'AI' | 'Cloud' };
  readonly activeView: ViewId;
  readonly clearSavedSecrets: () => void;
  readonly copyTranslation: () => void;
  readonly filteredHistory: readonly HistoryItem[];
  readonly history: readonly HistoryItem[];
  readonly historySearch: string;
  readonly isTranslating: boolean;
  readonly onSourceLanguageChange: (value: string) => void;
  readonly onTargetLanguageChange: (value: string) => void;
  readonly onTranslate: () => void;
  readonly providerUsage: ProviderUsage;
  readonly setActiveView: (view: ViewId) => void;
  readonly setHistorySearch: (value: string) => void;
  readonly setSettings: (settings: AppSettings) => void;
  readonly setSourceText: (value: string) => void;
  readonly setTranslatedText: (value: string) => void;
  readonly settings: AppSettings;
  readonly sourceLanguage: string;
  readonly sourceText: string;
  readonly status: string;
  readonly translatedText: string;
  readonly usageMonth: string;
}) {
  const totalUsage = Object.values(providerUsage).reduce((sum, value) => sum + (value ?? 0), 0);
  const configuredProviders = getConfiguredProviders(settings);

  function handleHistoryItem(item: HistoryItem) {
    setSourceText(item.source);
    setTranslatedText(item.target);
    setSettings({ ...settings, provider: item.provider, targetLanguage: item.targetLanguage });
    setActiveView('translate');
  }

  function swapLanguages() {
    if (sourceLanguage === 'auto') {
      return;
    }
    onSourceLanguageChange(settings.targetLanguage);
    onTargetLanguageChange(sourceLanguage);
  }

  return (
    <main className="mobile-shell bg-[var(--bg)] text-[var(--fg)]">
      <header className="mobile-header">
        <LingFlowLogo className="mobile-brand" showWordmark />
        <Button
          aria-label="切换主题"
          onClick={() => setSettings({ ...settings, darkMode: !settings.darkMode })}
          size="icon"
          variant="secondary"
        >
          {settings.darkMode ? <Sun size={18} /> : <Moon size={18} />}
        </Button>
      </header>

      <section className="mobile-content">
        {activeView === 'translate' ? (
          <>
            <section className="mobile-orb-section">
              <div className="mobile-orb-container">
                <span className="mobile-orb-ring" />
                <span className="mobile-orb-ring" />
                <span className="mobile-orb" />
              </div>
              <p className="mobile-orb-label">灵流服务运行中</p>
              <p className="mobile-orb-sub">
                <span className="mobile-live-dot" />
                {activeProvider.name} · {status}
              </p>
            </section>

            <div className="mobile-stats-row">
              <div className="mobile-stat-card">
                <span className="mobile-stat-label">本月翻译</span>
                <span className="mobile-stat-value">{formatCharacterNumber(totalUsage)}</span>
                <span className="mobile-stat-sub">{usageMonth} · 字符 · {history.length} 条历史</span>
              </div>
              <div className="mobile-stat-card">
                <span className="mobile-stat-label">目标语言</span>
                <span className="mobile-stat-value mobile-stat-value-text">{labelForLanguage(settings.targetLanguage)}</span>
                <span className="mobile-stat-sub">{configuredProviders.length} 个可用服务源</span>
              </div>
            </div>

            <div className="mobile-quick-switch">
              <span className="mobile-quick-switch-label">翻译引擎</span>
              <SelectInput value={settings.provider} onChange={(event) => setSettings({ ...settings, provider: event.currentTarget.value as TranslatorProvider })}>
                {PROVIDERS.map((provider) => (
                  <option key={provider.id} value={provider.id}>
                    {provider.name}
                  </option>
                ))}
              </SelectInput>
            </div>

            <section className="mobile-translate-card" aria-labelledby="mobileTranslateTitle">
              <div className="mobile-translate-head">
                <div>
                  <h1 id="mobileTranslateTitle">即时翻译</h1>
                  <p>{sourceText.length} 字符</p>
                </div>
                <Button aria-label="清空原文" onClick={() => setSourceText('')} size="icon" variant="ghost">
                  <Eraser size={17} />
                </Button>
              </div>
              <textarea
                className="mobile-translate-input"
                onChange={(event) => setSourceText(event.currentTarget.value)}
                placeholder="输入或粘贴要翻译的文本…"
                value={sourceText}
              />
              <div className="mobile-translate-controls">
                <SelectInput value={sourceLanguage} onChange={(event) => onSourceLanguageChange(event.currentTarget.value)}>
                  <option value="auto">自动检测</option>
                  {LANGUAGE_OPTIONS.map((language) => (
                    <option key={language.value} value={language.value}>
                      {language.label}
                    </option>
                  ))}
                </SelectInput>
                <Button aria-label="交换语言" disabled={sourceLanguage === 'auto'} onClick={swapLanguages} size="icon" variant="secondary">
                  <ArrowLeftRight size={16} />
                </Button>
                <SelectInput value={settings.targetLanguage} onChange={(event) => onTargetLanguageChange(event.currentTarget.value)}>
                  {LANGUAGE_OPTIONS.map((language) => (
                    <option key={language.value} value={language.value}>
                      {language.label}
                    </option>
                  ))}
                </SelectInput>
              </div>
              <div className="mobile-translate-actions">
                <Button disabled={isTranslating} onClick={onTranslate} variant="primary">
                  {isTranslating ? <RefreshCcw className="animate-spin" size={16} /> : <Play size={16} />}
                  {isTranslating ? '翻译中' : '翻译'}
                </Button>
                <Button onClick={copyTranslation} variant="secondary">
                  <Copy size={16} />
                  复制译文
                </Button>
              </div>
              <div className={cn('mobile-translate-result', translatedText && 'ready', isTranslating && 'loading')}>
                {isTranslating ? null : translatedText || '译文会显示在这里，便于直接复制或继续编辑。'}
              </div>
            </section>
          </>
        ) : null}

        {activeView === 'settings' ? (
          <section className="mobile-page-stack">
            <MobilePageTitle title="服务源配置" subtitle="与桌面端保持同一套 Provider 设置" />
            <SettingsView onClearSecrets={clearSavedSecrets} onSettingsChange={setSettings} secretStoreLabel="Android App Data" settings={settings} />
          </section>
        ) : null}

        {activeView === 'history' ? (
          <section className="mobile-page-stack">
            <MobilePageTitle title="翻译历史" subtitle={`${filteredHistory.length} 条记录`} />
            <div className="mobile-history-search">
              <Search size={16} />
              <input onChange={(event) => setHistorySearch(event.currentTarget.value)} placeholder="搜索原文、译文或服务源" value={historySearch} />
            </div>
            <div className="mobile-history-list">
              {filteredHistory.length ? (
                filteredHistory.map((item) => (
                  <button className="mobile-history-item" key={item.id} onClick={() => handleHistoryItem(item)} type="button">
                    <span className="mobile-history-lang">AUTO→{item.targetLanguage.toUpperCase()}</span>
                    <span className="mobile-history-body">
                      <span className="mobile-history-src">{item.source}</span>
                      <span className="mobile-history-tgt">{item.target}</span>
                      <span className="mobile-history-time">{formatDateTime(item.timestamp)} · {getProvider(item.provider).name}</span>
                    </span>
                  </button>
                ))
              ) : (
                <p className="mobile-empty-state">暂无历史记录，完成翻译后会自动出现在这里。</p>
              )}
            </div>
          </section>
        ) : null}

        {activeView === 'app-settings' ? (
          <section className="mobile-page-stack">
            <MobilePageTitle title="设置" subtitle="移动端不包含全局划词与本地代理" />
            <AppSettingsView globalSelectionAvailable={false} localProxyAvailable={false} onSettingsChange={setSettings} settings={settings} />
          </section>
        ) : null}
      </section>

      <nav className="mobile-bottom-nav" aria-label="移动端主导航">
        <MobileNavButton active={activeView === 'translate'} icon={<Languages size={22} />} label="控制台" onClick={() => setActiveView('translate')} />
        <MobileNavButton active={activeView === 'settings'} icon={<Settings size={22} />} label="服务源" onClick={() => setActiveView('settings')} />
        <MobileNavButton active={activeView === 'history'} icon={<History size={22} />} label="历史" onClick={() => setActiveView('history')} />
        <MobileNavButton active={activeView === 'app-settings'} icon={<SlidersHorizontal size={22} />} label="设置" onClick={() => setActiveView('app-settings')} />
      </nav>
    </main>
  );
}

function MobilePageTitle({ subtitle, title }: { readonly subtitle: string; readonly title: string }) {
  return (
    <div className="mobile-page-title">
      <h1>{title}</h1>
      <p>{subtitle}</p>
    </div>
  );
}

function MobileNavButton({
  active,
  icon,
  label,
  onClick,
}: {
  readonly active: boolean;
  readonly icon: React.ReactNode;
  readonly label: string;
  readonly onClick: () => void;
}) {
  return (
    <button className={cn('mobile-nav-tab', active && 'active')} onClick={onClick} type="button">
      {icon}
      <span>{label}</span>
    </button>
  );
}

function WindowControls() {
  const currentWindow = getCurrentWebviewWindow();

  return (
    <div className="window-controls" aria-label="窗口控制">
      <button aria-label="最小化" className="window-control-button" onClick={() => void currentWindow.minimize()} type="button">
        <Minus size={15} />
      </button>
      <button aria-label="最大化或还原" className="window-control-button" onClick={() => void currentWindow.toggleMaximize()} type="button">
        <Maximize2 size={14} />
      </button>
      <button aria-label="关闭" className="window-control-button close" onClick={() => void currentWindow.close()} type="button">
        <X size={15} />
      </button>
    </div>
  );
}

function OnboardingScreen({
  darkMode,
  onConfigureProvider,
  onOpenKeyPage,
  onStart,
  onToggleDarkMode,
  showGlobalSelectionStep,
}: {
  readonly darkMode: boolean;
  readonly onConfigureProvider: () => void;
  readonly onOpenKeyPage: () => void;
  readonly onStart: () => void;
  readonly onToggleDarkMode: () => void;
  readonly showGlobalSelectionStep: boolean;
}) {
  const showTopbar = showGlobalSelectionStep;

  return (
    <main className={cn('onboarding-shell bg-[var(--bg)] text-[var(--fg)]', !showTopbar && 'onboarding-shell-no-topbar')}>
      {showTopbar ? (
        <header className="topbar">
          <LingFlowLogo showWordmark />
          <div className="topbar-actions">
            <Button aria-label="切换主题" onClick={onToggleDarkMode} size="icon" variant="ghost">
              {darkMode ? <Sun size={17} /> : <Moon size={17} />}
            </Button>
            <WindowControls />
          </div>
        </header>
      ) : null}
      <section className="onboarding-content">
        <div className="onboarding-hero">
          <LingFlowLogo className="onboarding-logo" />
          <p className="text-sm font-semibold text-[var(--primary)]">欢迎使用灵流</p>
          <h1>让翻译像水流一样融入阅读</h1>
          <p className="onboarding-copy">
            {showGlobalSelectionStep
              ? '灵流会把桌面端、浏览器扩展和翻译服务源连接在一起。完成首次设置后，你可以直接使用文本翻译、网页双语翻译和全局划词悬浮窗。'
              : '灵流会把移动端、翻译服务源和历史记录连接在一起。完成首次设置后，你可以直接使用文本翻译、服务源配置和本地历史记录。'}
          </p>
          <div className="onboarding-actions">
            <Button onClick={onStart} variant="primary">
              <Play size={16} />
              开始使用
            </Button>
            <Button onClick={onConfigureProvider} variant="secondary">
              <Settings size={16} />
              配置服务源
            </Button>
          </div>
        </div>
        <div className="onboarding-steps">
          <article className="onboarding-step">
            <span>1</span>
            <div>
              <h2>配置翻译服务</h2>
              <p>推荐先配置 AI 服务源，默认 Base URL 已使用 https://one.gloscai.com。</p>
              <button className="onboarding-link" onClick={onOpenKeyPage} type="button">
                没有 Key？现在获取
              </button>
            </div>
          </article>
          {showGlobalSelectionStep ? (
            <>
              <article className="onboarding-step">
                <span>2</span>
                <div>
                  <h2>启动浏览器扩展</h2>
                  <p>扩展会通过本地代理读取桌面端配置，不需要在浏览器里重复保存密钥。</p>
                </div>
              </article>
              <article className="onboarding-step">
                <span>3</span>
                <div>
                  <h2>开启全局划词</h2>
                  <p>在软件设置中开启全局划词后，选中文本即可唤起灵流悬浮翻译窗。</p>
                </div>
              </article>
            </>
          ) : (
            <>
              <article className="onboarding-step">
                <span>2</span>
                <div>
                  <h2>选择目标语言</h2>
                  <p>移动端复用桌面端的服务源配置模型，可按阅读场景切换目标语言。</p>
                </div>
              </article>
              <article className="onboarding-step">
                <span>3</span>
                <div>
                  <h2>保留翻译历史</h2>
                  <p>常用文本会保存在本机历史记录中，便于回看和再次使用。</p>
                </div>
              </article>
            </>
          )}
        </div>
      </section>
    </main>
  );
}

async function detectGlobalSelection(settings: AppSettings, position: { readonly x: number; readonly y: number }) {
  try {
    const roundedPosition = { x: Math.round(position.x), y: Math.round(position.y) };
    const selectedText = await invoke<string>('capture_foreground_selection', {
      excludedApps: settings.globalSelectionExcludedApps,
      cursorPosition: roundedPosition,
    });
    const normalized = selectedText.trim();
    if (!normalized) {
      console.debug('[LingFlow selection] capture returned empty text', roundedPosition);
      return;
    }

    console.debug('[LingFlow selection] capture succeeded', { characters: normalized.length, position: roundedPosition });
    await showSelectionOverlay(normalized, position.x + 14, position.y + 16);
  } catch (error) {
    console.warn('[LingFlow selection] capture failed', error);
    try {
      const diagnostics = await invoke<SelectionDiagnostics>('selection_diagnostics');
      console.table(diagnostics.attempts);
      console.info('[LingFlow selection diagnostics]', diagnostics);
    } catch (diagnosticsError) {
      console.warn('[LingFlow selection] failed to read diagnostics', diagnosticsError);
    }
  }
}

async function showSelectionOverlay(text: string, x: number, y: number) {
  window.localStorage.setItem(SELECTION_TEXT_STORAGE_KEY, text);

  const existing = await WebviewWindow.getByLabel(SELECTION_OVERLAY_LABEL);
  if (existing) {
    await existing.setResizable(false);
    await existing.setShadow(false);
    await existing.setSize(new PhysicalSize(36, 36));
    await existing.setPosition(new PhysicalPosition(x, y));
    await setOverlayNoActivate();
    await existing.show();
    await existing.emit('selection-text-updated', text);
    return;
  }

  const overlay = new WebviewWindow(SELECTION_OVERLAY_LABEL, {
    url: '/?overlay=selection',
    title: 'LingFlow Selection',
    x,
    y,
    width: 36,
    height: 36,
    decorations: false,
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: true,
    visible: true,
    focus: false,
    transparent: true,
    shadow: false,
  });

  overlay.once('tauri://created', () => {
    void setOverlayNoActivate();
    void overlay.emit('selection-text-updated', text);
  });
}

async function setOverlayNoActivate() {
  try {
    await invoke('set_overlay_no_activate', { label: SELECTION_OVERLAY_LABEL });
  } catch {
    // Best effort: the overlay still works if the platform style update is unavailable.
  }
}

function SelectionOverlayApp() {
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [sourceText, setSourceText] = useState(() => window.localStorage.getItem(SELECTION_TEXT_STORAGE_KEY) ?? '');
  const [sourceLanguage, setSourceLanguage] = useState('auto');
  const [translatedText, setTranslatedText] = useState('');
  const [status, setStatus] = useState('点击图标翻译');
  const [isTranslating, setIsTranslating] = useState(false);

  useEffect(() => {
    document.documentElement.classList.add('selection-overlay-root');
    document.body.classList.add('selection-overlay-body');
    return () => {
      document.documentElement.classList.remove('selection-overlay-root');
      document.body.classList.remove('selection-overlay-body');
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function loadSettings() {
      const storedSettings = await readStoredSettings();
      let storedSecrets: Partial<AppSecrets> = {};
      try {
        storedSecrets = await invoke<Partial<AppSecrets>>('read_app_secrets');
      } catch {
        // The overlay can still render; translation will surface provider configuration errors.
      }

      if (!cancelled) {
        setSettings(mergeStoredSettings(storedSettings, storedSecrets));
        setSettingsLoaded(true);
      }
    }

    void loadSettings();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const overlay = getCurrentWebviewWindow();
    const unlistenPromise = overlay.listen<string>('selection-text-updated', (event) => {
      setSourceText(event.payload);
      setTranslatedText('');
      setStatus('点击图标翻译');
      setExpanded(false);
      void overlay.setResizable(false);
      void overlay.setShadow(false);
      void overlay.setSize(new PhysicalSize(36, 36));
    });

    return () => {
      void unlistenPromise.then((unlisten) => unlisten());
    };
  }, []);

  const scheduler = useMemo(() => createScheduler(settings), [settings]);
  const configuredProviders = useMemo(() => getConfiguredProviders(settings), [settings]);

  useEffect(() => {
    if (configuredProviders.length > 0 && !configuredProviders.some((provider) => provider.id === settings.provider)) {
      setSettings((current) => ({ ...current, provider: configuredProviders[0].id }));
    }
  }, [configuredProviders, settings.provider]);

  async function expand() {
    setExpanded(true);
    const window = getCurrentWebviewWindow();
    await window.setSize(new PhysicalSize(460, 430));
    await window.setShadow(true);
    try {
      await window.setResizable(true);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  }

  async function closeOverlay() {
    await getCurrentWebviewWindow().close();
  }

  useEffect(() => {
    if (expanded) {
      return;
    }

    const timer = window.setTimeout(() => {
      void getCurrentWebviewWindow().close();
    }, 5000);

    return () => window.clearTimeout(timer);
  }, [expanded, sourceText]);

  async function translateSelection() {
    const providerError = validateProvider(settings);
    if (providerError) {
      setStatus(providerError);
      return;
    }

    if (!sourceText.trim()) {
      setStatus('没有可翻译的选中文本');
      return;
    }

    setIsTranslating(true);
    setStatus('正在翻译');
    try {
      const response = await scheduler.translate({
        text: sourceText,
        sourceLanguage: sourceLanguage === 'auto' ? undefined : sourceLanguage,
        targetLanguage: settings.targetLanguage,
        provider: settings.provider,
      });
      setTranslatedText(response.text);
      setStatus(response.cached ? '命中缓存' : '翻译完成');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setIsTranslating(false);
    }
  }

  if (!expanded) {
    return (
      <main className="selection-icon-shell">
        <button aria-label="LingFlow 划词翻译" className="selection-icon-button" onClick={() => void expand()} type="button">
          <LingFlowLogo className="selection-icon-logo" />
        </button>
      </main>
    );
  }

  return (
    <main className="selection-panel-shell">
      <header className="selection-panel-header">
        <LingFlowLogo />
        <span className="min-w-0 flex-1 truncate text-xs text-[var(--muted)]">
          {settingsLoaded ? `${getProvider(settings.provider).name} / ${labelForLanguage(settings.targetLanguage)}` : '加载配置'}
        </span>
        <Button aria-label="关闭" onClick={closeOverlay} size="icon" variant="ghost">
          <X size={15} />
        </Button>
      </header>
      <div className="selection-panel-controls">
        <SelectInput value={sourceLanguage} onChange={(event) => setSourceLanguage(event.currentTarget.value)}>
          <option value="auto">自动检测</option>
          {LANGUAGE_OPTIONS.map((language) => (
            <option key={language.value} value={language.value}>
              {language.label}
            </option>
          ))}
        </SelectInput>
        <SelectInput value={settings.targetLanguage} onChange={(event) => setSettings({ ...settings, targetLanguage: event.currentTarget.value })}>
          {LANGUAGE_OPTIONS.map((language) => (
            <option key={language.value} value={language.value}>
              {language.label}
            </option>
          ))}
        </SelectInput>
        <SelectInput
          disabled={configuredProviders.length === 0}
          value={settings.provider}
          onChange={(event) => setSettings({ ...settings, provider: event.currentTarget.value as TranslatorProvider })}
        >
          {configuredProviders.length ? (
            configuredProviders.map((provider) => (
              <option key={provider.id} value={provider.id}>
                {provider.name}
              </option>
            ))
          ) : (
            <option value={settings.provider}>暂无已配置服务</option>
          )}
        </SelectInput>
      </div>
      <section className="selection-panel-body">
        <textarea className="selection-panel-source" onChange={(event) => setSourceText(event.currentTarget.value)} value={sourceText} />
        <div className={cn('selection-panel-result', isTranslating && 'loading')}>
          {isTranslating ? null : translatedText || <span className="text-[var(--muted)]">点击翻译后显示结果</span>}
        </div>
      </section>
      <footer className="selection-panel-footer">
        <span className="min-w-0 flex-1 truncate text-xs text-[var(--muted)]">{status}</span>
        <Button disabled={isTranslating} onClick={translateSelection} size="sm" variant="primary">
          {isTranslating ? <RefreshCcw className="animate-spin" size={14} /> : <Play size={14} />}
          翻译
        </Button>
      </footer>
    </main>
  );
}

function NavButton({ active, children, icon, onClick }: { readonly active: boolean; readonly children: string; readonly icon: React.ReactNode; readonly onClick: () => void }) {
  return (
    <button className={cn('nav-item', active && 'active')} onClick={onClick} type="button">
      {icon}
      <span>{children}</span>
    </button>
  );
}

function StatusStrip({ detail, status }: { readonly detail: string; readonly status: string }) {
  return (
    <div className="status-strip">
      <span className="status-orb" />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold">灵流翻译服务</p>
        <p className="truncate text-xs text-[var(--muted)]">{detail}</p>
      </div>
      <div className="flex items-center gap-2 text-xs text-[var(--muted)]">
        <span className="h-2 w-2 rounded-full bg-[var(--success)]" />
        <span>{status}</span>
      </div>
    </div>
  );
}

function ServiceStatusCard({
  health,
  isTesting,
  onProviderSelect,
  onTest,
  selectedProvider,
  settings,
  usage,
  usageMonth,
}: {
  readonly health: ProviderHealth;
  readonly isTesting: boolean;
  readonly onProviderSelect: (provider: TranslatorProvider) => void;
  readonly onTest: () => void;
  readonly selectedProvider: TranslatorProvider;
  readonly settings: AppSettings;
  readonly usage: ProviderUsage;
  readonly usageMonth: string;
}) {
  const configuredProviders = getConfiguredProviders(settings);

  return (
    <Card
      action={
        <Button disabled={isTesting || configuredProviders.length === 0} onClick={onTest} size="sm" variant="secondary">
          <Radar className={cn(isTesting && 'animate-spin')} size={15} />
          测试
        </Button>
      }
      className="bg-[var(--surface-raised)]"
      title={`服务状态（${usageMonth}）`}
    >
      <div className="grid gap-2 p-3">
        {configuredProviders.length ? (
          configuredProviders.map((provider) => {
            const providerHealth = health[provider.id] ?? 'unknown';
            return (
              <button
                className={cn('provider-mini service-status-row', selectedProvider === provider.id && 'active')}
                key={provider.id}
                onClick={() => onProviderSelect(provider.id)}
                type="button"
              >
                <span className={cn('health-dot', providerHealth)} />
                <span className="min-w-0 flex-1 truncate text-left">{provider.name}</span>
                <span className="service-usage">{formatCharacterCount(usage[provider.id] ?? 0)}</span>
              </button>
            );
          })
        ) : (
          <p className="px-2 py-3 text-sm leading-6 text-[var(--muted)]">暂无已配置服务</p>
        )}
      </div>
    </Card>
  );
}

function TranslateView({
  isTranslating,
  onCopy,
  onSourceChange,
  onSourceLanguageChange,
  onTargetLanguageChange,
  onTranslate,
  sourceLanguage,
  sourceText,
  targetLanguage,
  translatedText,
}: {
  readonly isTranslating: boolean;
  readonly onCopy: () => void;
  readonly onSourceChange: (value: string) => void;
  readonly onSourceLanguageChange: (value: string) => void;
  readonly onTargetLanguageChange: (value: string) => void;
  readonly onTranslate: () => void;
  readonly sourceLanguage: string;
  readonly sourceText: string;
  readonly targetLanguage: string;
  readonly translatedText: string;
}) {
  return (
    <div className="translate-workspace">
      <TranslationPanel
        footer={`${sourceText.length} 字符`}
        language={
          <SelectInput value={sourceLanguage} onChange={(event) => onSourceLanguageChange(event.currentTarget.value)}>
            <option value="auto">自动检测</option>
            {LANGUAGE_OPTIONS.map((language) => (
              <option key={language.value} value={language.value}>
                {language.label}
              </option>
            ))}
          </SelectInput>
        }
        title="原文"
      >
        <textarea
          className="translate-textarea"
          onChange={(event) => onSourceChange(event.currentTarget.value)}
          placeholder="输入或粘贴要翻译的内容"
          value={sourceText}
        />
      </TranslationPanel>

      <button aria-label="交换语言" className="swap-button" type="button">
        <ArrowLeftRight size={16} />
      </button>

      <TranslationPanel
        footer={translatedText ? '译文可复制' : '等待翻译'}
        language={
          <SelectInput value={targetLanguage} onChange={(event) => onTargetLanguageChange(event.currentTarget.value)}>
            {LANGUAGE_OPTIONS.map((language) => (
              <option key={language.value} value={language.value}>
                {language.label}
              </option>
            ))}
          </SelectInput>
        }
        title="译文"
      >
        <div className={cn('translate-output', isTranslating && 'loading')}>
          {isTranslating ? null : translatedText || <span className="text-[var(--muted)]">点击“翻译”开始生成译文。</span>}
        </div>
      </TranslationPanel>

      <div className="col-span-full flex flex-wrap items-center gap-3">
        <Button disabled={isTranslating} onClick={onTranslate} variant="primary">
          {isTranslating ? <RefreshCcw className="animate-spin" size={16} /> : <Play size={16} />}
          {isTranslating ? '翻译中' : '翻译'}
        </Button>
        <Button onClick={onCopy}>
          <Copy size={16} />
          复制译文
        </Button>
        <Button onClick={() => onSourceChange('')} variant="ghost">
          <Eraser size={16} />
          清空原文
        </Button>
      </div>
    </div>
  );
}

function TranslationPanel({ children, footer, language, title }: { readonly children: React.ReactNode; readonly footer: string; readonly language: React.ReactNode; readonly title: string }) {
  return (
    <section className="translate-panel">
      <div className="flex items-center justify-between gap-4 border-b border-[var(--border)] p-4">
        <span className="text-xs font-semibold uppercase text-[var(--muted)]">{title}</span>
        <div className="w-40">{language}</div>
      </div>
      {children}
      <div className="border-t border-[var(--border)] px-4 py-3 font-mono text-xs text-[var(--muted)]">{footer}</div>
    </section>
  );
}

function SettingsView({
  onClearSecrets,
  onSettingsChange,
  secretStoreLabel,
  settings,
}: {
  readonly onClearSecrets: () => void;
  readonly onSettingsChange: (settings: AppSettings) => void;
  readonly secretStoreLabel: string;
  readonly settings: AppSettings;
}) {
  return (
    <div className="settings-grid">
      <Card className="settings-default-card" title="默认翻译">
        <div className="grid gap-4 p-5">
          <Field label="默认服务源">
            <SelectInput value={settings.provider} onChange={(event) => onSettingsChange({ ...settings, provider: event.currentTarget.value as TranslatorProvider })}>
              {PROVIDERS.map((provider) => (
                <option key={provider.id} value={provider.id}>
                  {provider.name}
                </option>
              ))}
            </SelectInput>
          </Field>
          <Field label="默认目标语言">
            <SelectInput value={settings.targetLanguage} onChange={(event) => onSettingsChange({ ...settings, targetLanguage: event.currentTarget.value })}>
              {LANGUAGE_OPTIONS.map((language) => (
                <option key={language.value} value={language.value}>
                  {language.label}
                </option>
              ))}
            </SelectInput>
          </Field>
        </div>
      </Card>

      <Card className="settings-local-status-card" title="本机状态">
        <div className="grid gap-3 p-5 text-sm text-[var(--muted)]">
          <InfoRow icon={<ShieldCheck size={16} />} label="密钥存储" value={secretStoreLabel} />
          <InfoRow icon={<Database size={16} />} label="本地缓存" value="TranslationScheduler" />
          <Button onClick={onClearSecrets} variant="danger">
            <Trash2 size={16} />
            清除保存的密钥
          </Button>
        </div>
      </Card>

      <Card className="settings-wide settings-provider-card" title="服务源配置">
        <div className="provider-config-grid p-5">
          <ProviderConfig settings={settings} onSettingsChange={onSettingsChange} />
        </div>
      </Card>
    </div>
  );
}

function AppSettingsView({
  globalSelectionAvailable,
  localProxyAvailable,
  onSettingsChange,
  settings,
}: {
  readonly globalSelectionAvailable: boolean;
  readonly localProxyAvailable: boolean;
  readonly onSettingsChange: (settings: AppSettings) => void;
  readonly settings: AppSettings;
}) {
  const [runningProcesses, setRunningProcesses] = useState<readonly string[]>([]);
  const [isLoadingProcesses, setIsLoadingProcesses] = useState(false);
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
  const [isCheckingUpdate, setIsCheckingUpdate] = useState(false);
  const [updateError, setUpdateError] = useState('');

  async function loadRunningProcesses() {
    if (!canUseTauri()) {
      return;
    }

    setIsLoadingProcesses(true);
    try {
      setRunningProcesses(await invoke<string[]>('list_running_process_names'));
    } finally {
      setIsLoadingProcesses(false);
    }
  }

  function updateProcessList(current: readonly string[], processName: string, checked: boolean) {
    const normalized = processName.trim();
    if (!normalized) {
      return current;
    }

    const exists = current.some((item) => item.toLowerCase() === normalized.toLowerCase());
    if (checked) {
      return exists ? current : [...current, normalized];
    }
    return current.filter((item) => item.toLowerCase() !== normalized.toLowerCase());
  }

  function toggleExcludedProcess(processName: string, checked: boolean) {
    const next = updateProcessList(settings.globalSelectionExcludedApps.filter(Boolean), processName, checked);
    onSettingsChange({ ...settings, globalSelectionExcludedApps: next });
  }

  async function checkUpdates() {
    if (!canUseTauri()) {
      return;
    }

    setIsCheckingUpdate(true);
    setUpdateError('');
    try {
      setUpdateInfo(await invoke<UpdateInfo>('check_for_updates'));
    } catch (error) {
      setUpdateError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsCheckingUpdate(false);
    }
  }

  useEffect(() => {
    void checkUpdates();
  }, []);

  return (
    <div className="settings-grid">
      <Card title="基础设置">
        <div className="grid gap-4 p-5">
          <Toggle checked={settings.darkMode} label="深色模式" onChange={(checked) => onSettingsChange({ ...settings, darkMode: checked })} />
        </div>
      </Card>

      {localProxyAvailable ? (
        <Card title="本地代理">
          <div className="grid gap-4 p-5">
            <Field hint="浏览器扩展会通过这个地址读取桌面端配置并代理翻译请求。局域网共享可使用 0.0.0.0 或本机局域网 IP。" label="监听地址">
              <TextInput
                onChange={(event) => onSettingsChange({ ...settings, localProxyHost: event.currentTarget.value })}
                placeholder="127.0.0.1"
                value={settings.localProxyHost}
              />
            </Field>
            <Field hint="如果端口被占用，请改为其他未占用端口，并在浏览器扩展中填写相同代理地址。" label="监听端口">
              <TextInput
                min={1}
                max={65535}
                onChange={(event) =>
                  onSettingsChange({
                    ...settings,
                    localProxyPort: Number.parseInt(event.currentTarget.value, 10) || DEFAULT_SETTINGS.localProxyPort,
                  })
                }
                type="number"
                value={String(settings.localProxyPort)}
              />
            </Field>
            <div className="rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-xs text-[var(--muted)]">
              扩展端代理地址：http://{settings.localProxyHost === '0.0.0.0' ? '127.0.0.1' : settings.localProxyHost}:{settings.localProxyPort}
            </div>
          </div>
        </Card>
      ) : null}

      {globalSelectionAvailable ? (
        <Card className="settings-wide" title="全局划词">
          <div className="grid gap-4 p-5">
            <Toggle checked={settings.globalSelectionEnabled} label="启用全局划词" onChange={(checked) => onSettingsChange({ ...settings, globalSelectionEnabled: checked })} />
            <Field hint="一行一个进程名，例如 explorer.exe、Code.exe、chrome.exe。命中后不会读取该软件中的选中文本。" label="进程黑名单">
              <textarea
                className="settings-textarea"
                onChange={(event) =>
                  onSettingsChange({
                    ...settings,
                    globalSelectionExcludedApps: event.currentTarget.value
                      .split('\n')
                      .map((item) => item.trim())
                      .filter(Boolean),
                  })
                }
                value={settings.globalSelectionExcludedApps.join('\n')}
              />
            </Field>
            <div className="flex flex-wrap items-center gap-3">
              <Button disabled={isLoadingProcesses} onClick={loadRunningProcesses} size="sm" variant="secondary">
                {isLoadingProcesses ? <RefreshCcw className="animate-spin" size={14} /> : <RefreshCcw size={14} />}
                加载当前进程
              </Button>
              <span className="text-xs text-[var(--muted)]">勾选后会加入进程黑名单。</span>
            </div>
            {runningProcesses.length ? (
              <div className="process-picker">
                {runningProcesses.map((processName) => {
                  const checked = settings.globalSelectionExcludedApps.some((item) => item.toLowerCase() === processName.toLowerCase());
                  return (
                    <label className="process-option" key={processName}>
                      <input checked={checked} onChange={(event) => toggleExcludedProcess(processName, event.currentTarget.checked)} type="checkbox" />
                      <span>{processName}</span>
                    </label>
                  );
                })}
              </div>
            ) : null}
          </div>
        </Card>
      ) : null}

      <Card className="settings-wide" title="在线更新">
        <div className="grid gap-4 p-5 text-sm">
          <Button disabled={isCheckingUpdate} onClick={() => void checkUpdates()} variant="secondary">
            {isCheckingUpdate ? <RefreshCcw className="animate-spin" size={16} /> : <RefreshCcw size={16} />}
            检查更新
          </Button>
          {updateInfo ? (
            <div className="grid gap-2 text-xs leading-5 text-[var(--muted)]">
              <p>当前版本：{updateInfo.currentVersion}</p>
              <p>最新版本：{updateInfo.latestVersion}</p>
              <p className={updateInfo.hasUpdate ? 'text-[var(--primary)]' : 'text-[var(--muted)]'}>
                {updateInfo.hasUpdate ? '发现新版本，可以前往 GitHub Releases 下载。' : '当前已经是最新版本。'}
              </p>
              <a className="inline-flex items-center gap-2 text-[var(--primary)]" href={updateInfo.releaseUrl} rel="noreferrer" target="_blank">
                <ExternalLink size={14} />
                打开发布页面
              </a>
              {updateInfo.assets.length ? (
                <div className="grid gap-1">
                  {updateInfo.assets.slice(0, 4).map((asset) => (
                    <a className="truncate text-[var(--primary)]" href={asset.browserDownloadUrl} key={asset.browserDownloadUrl} rel="noreferrer" target="_blank">
                      {asset.name}
                    </a>
                  ))}
                </div>
              ) : null}
            </div>
          ) : (
            <p className="text-xs leading-5 text-[var(--muted)]">从 GitHub Releases 自动获取 LingFlow 最新版本信息。</p>
          )}
          {updateError ? <p className="text-xs leading-5 text-[var(--danger)]">{updateError}</p> : null}
        </div>
      </Card>
    </div>
  );
}

function ProviderConfig({ onSettingsChange, settings }: { readonly onSettingsChange: (settings: AppSettings) => void; readonly settings: AppSettings }) {
  if (settings.provider === 'google-free') {
    return (
      <Field label="Google Cloud API Key">
        <TextInput onChange={(event) => onSettingsChange({ ...settings, googleApiKey: event.currentTarget.value })} type="password" value={settings.googleApiKey} />
      </Field>
    );
  }

  if (settings.provider === 'baidu-free') {
    return (
      <>
        <Field label="Baidu APP ID">
          <TextInput onChange={(event) => onSettingsChange({ ...settings, baiduAppId: event.currentTarget.value })} value={settings.baiduAppId} />
        </Field>
        <Field label="Baidu Secret Key">
          <TextInput onChange={(event) => onSettingsChange({ ...settings, baiduSecretKey: event.currentTarget.value })} type="password" value={settings.baiduSecretKey} />
        </Field>
      </>
    );
  }

  if (settings.provider === 'deepl') {
    return (
      <>
        <Field label="DeepL API 类型">
          <SelectInput value={settings.deeplApiType} onChange={(event) => onSettingsChange({ ...settings, deeplApiType: event.currentTarget.value as 'free' | 'pro' })}>
            <option value="free">DeepL API Free</option>
            <option value="pro">DeepL API Pro</option>
          </SelectInput>
        </Field>
        <Field label="DeepL API Key">
          <TextInput onChange={(event) => onSettingsChange({ ...settings, deeplApiKey: event.currentTarget.value })} type="password" value={settings.deeplApiKey} />
        </Field>
      </>
    );
  }

  if (settings.provider === 'microsoft') {
    return (
      <>
        <Field label="Microsoft API Key">
          <TextInput onChange={(event) => onSettingsChange({ ...settings, microsoftApiKey: event.currentTarget.value })} type="password" value={settings.microsoftApiKey} />
        </Field>
        <Field label="Region">
          <TextInput onChange={(event) => onSettingsChange({ ...settings, microsoftRegion: event.currentTarget.value })} placeholder="eastasia" value={settings.microsoftRegion} />
        </Field>
        <Field label="Endpoint">
          <TextInput onChange={(event) => onSettingsChange({ ...settings, microsoftEndpoint: event.currentTarget.value })} value={settings.microsoftEndpoint} />
        </Field>
      </>
    );
  }

  if (settings.provider === 'youdao') {
    return (
      <>
        <Field label="有道 App Key">
          <TextInput onChange={(event) => onSettingsChange({ ...settings, youdaoAppKey: event.currentTarget.value })} value={settings.youdaoAppKey} />
        </Field>
        <Field label="有道 App Secret">
          <TextInput onChange={(event) => onSettingsChange({ ...settings, youdaoAppSecret: event.currentTarget.value })} type="password" value={settings.youdaoAppSecret} />
        </Field>
      </>
    );
  }

  if (settings.provider === 'tencent') {
    return (
      <>
        <Field label="Tencent SecretId">
          <TextInput onChange={(event) => onSettingsChange({ ...settings, tencentSecretId: event.currentTarget.value })} value={settings.tencentSecretId} />
        </Field>
        <Field label="Tencent SecretKey">
          <TextInput onChange={(event) => onSettingsChange({ ...settings, tencentSecretKey: event.currentTarget.value })} type="password" value={settings.tencentSecretKey} />
        </Field>
        <Field label="Region">
          <TextInput onChange={(event) => onSettingsChange({ ...settings, tencentRegion: event.currentTarget.value })} value={settings.tencentRegion} />
        </Field>
      </>
    );
  }

  return <AiProviderConfigEditor settings={settings} onSettingsChange={onSettingsChange} />;
}

function AiProviderConfigEditor({ onSettingsChange, settings }: { readonly onSettingsChange: (settings: AppSettings) => void; readonly settings: AppSettings }) {
  const [modelCatalogs, setModelCatalogs] = useState<Record<string, AiModelCatalog>>({});

  function updateSource(sourceId: string, patch: Partial<AiServiceSourceConfig>) {
    onSettingsChange({
      ...settings,
      aiSources: settings.aiSources.map((source) => (source.id === sourceId ? { ...source, ...patch } : source)),
    });
  }

  function addSource() {
    onSettingsChange({
      ...settings,
      aiSources: [
        ...settings.aiSources,
        {
          id: `ai-source-${Date.now()}`,
          name: 'AI Service',
          baseUrl: 'https://one.gloscai.com',
          apiKey: '',
          models: [],
          enabled: true,
        },
      ],
    });
  }

  function removeSource(sourceId: string) {
    const nextSources = settings.aiSources.filter((source) => source.id !== sourceId);
    onSettingsChange({ ...settings, aiSources: nextSources.length ? nextSources : DEFAULT_SETTINGS.aiSources });
  }

  function moveSource(fromId: string, toId: string) {
    if (fromId === toId) {
      return;
    }
    const fromIndex = settings.aiSources.findIndex((source) => source.id === fromId);
    const toIndex = settings.aiSources.findIndex((source) => source.id === toId);
    if (fromIndex < 0 || toIndex < 0) {
      return;
    }
    const nextSources = [...settings.aiSources];
    const [moved] = nextSources.splice(fromIndex, 1);
    nextSources.splice(toIndex, 0, moved);
    onSettingsChange({ ...settings, aiSources: nextSources });
  }

  async function fetchModels(source: AiServiceSourceConfig) {
    if (!source.baseUrl.trim() || !source.apiKey.trim()) {
      setModelCatalogs((catalogs) => ({
        ...catalogs,
        [source.id]: { loading: false, models: catalogs[source.id]?.models ?? [], error: '请先填写 Base URL 和 API Key' },
      }));
      return;
    }

    setModelCatalogs((catalogs) => ({
      ...catalogs,
      [source.id]: { loading: true, models: catalogs[source.id]?.models ?? [], error: undefined },
    }));

    try {
      const models = await fetchAiModels(source);
      setModelCatalogs((catalogs) => ({
        ...catalogs,
        [source.id]: { loading: false, models, error: models.length ? undefined : '接口未返回可用模型' },
      }));
      if (models.length > 0 && source.models.length === 0) {
        updateSource(source.id, { models: [models[0]] });
      }
    } catch (error) {
      setModelCatalogs((catalogs) => ({
        ...catalogs,
        [source.id]: {
          loading: false,
          models: catalogs[source.id]?.models ?? [],
          error: error instanceof Error ? error.message : String(error),
        },
      }));
    }
  }

  function addModel(source: AiServiceSourceConfig, model: string) {
    if (!model || source.models.includes(model)) {
      return;
    }
    updateSource(source.id, { models: [...source.models, model] });
  }

  return (
    <div className="ai-source-editor">
      <div className="ai-source-toolbar">
        <Toggle checked={settings.aiFallbackEnabled} label="AI 服务源与模型自动回退" onChange={(checked) => onSettingsChange({ ...settings, aiFallbackEnabled: checked })} />
        <Button onClick={addSource} size="sm" variant="primary">
          <Plus size={15} />
          添加服务源
        </Button>
      </div>
      <div className="ai-source-list">
        {settings.aiSources.map((source) => (
          <article
            className="ai-source-card"
            draggable
            key={source.id}
            onDragOver={(event) => event.preventDefault()}
            onDragStart={(event) => event.dataTransfer.setData('text/plain', source.id)}
            onDrop={(event) => {
              event.preventDefault();
              moveSource(event.dataTransfer.getData('text/plain'), source.id);
            }}
          >
            <div className="ai-source-card-header">
              <span className="ai-source-drag-handle">
                <GripVertical aria-hidden size={18} />
              </span>
              <TextInput aria-label="AI 服务源名称" onChange={(event) => updateSource(source.id, { name: event.currentTarget.value })} value={source.name} />
              <div className="ai-source-card-actions">
                <Toggle checked={source.enabled !== false} label="启用" onChange={(checked) => updateSource(source.id, { enabled: checked })} />
                <Button aria-label="删除服务源" onClick={() => removeSource(source.id)} size="icon" variant="ghost">
                  <X size={16} />
                </Button>
              </div>
            </div>
            <div className="ai-source-fields">
              <Field label="Base URL">
                <TextInput onChange={(event) => updateSource(source.id, { baseUrl: event.currentTarget.value })} placeholder="https://one.gloscai.com" value={source.baseUrl} />
              </Field>
              <Field label="API Key">
                <TextInput onChange={(event) => updateSource(source.id, { apiKey: event.currentTarget.value })} type="password" value={source.apiKey} />
                <a
                  className="text-[11px] leading-5 text-[var(--primary)]"
                  href="https://one.gloscai.com/keys"
                  onClick={(event) => {
                    event.preventDefault();
                    void openExternalUrl('https://one.gloscai.com/keys');
                  }}
                  rel="noreferrer"
                  target="_blank"
                >
                  没有 Key？现在获取
                </a>
              </Field>
              <div className="ai-model-area">
                <Field hint="填写 Base URL 和 API Key 后获取模型，再从下拉栏添加。" label="模型">
                  <div className="ai-model-select-row">
                    <SelectInput
                      disabled={!modelCatalogs[source.id]?.models.length}
                      onChange={(event) => {
                        addModel(source, event.currentTarget.value);
                        event.currentTarget.value = '';
                      }}
                      value=""
                    >
                      <option value="">选择模型</option>
                      {(modelCatalogs[source.id]?.models ?? []).map((model) => (
                        <option disabled={source.models.includes(model)} key={model} value={model}>
                          {model}
                        </option>
                      ))}
                    </SelectInput>
                    <Button disabled={!source.baseUrl.trim() || !source.apiKey.trim() || modelCatalogs[source.id]?.loading} onClick={() => void fetchModels(source)} size="sm" variant="secondary">
                      {modelCatalogs[source.id]?.loading ? <RefreshCcw className="animate-spin" size={14} /> : <RefreshCcw size={14} />}
                      获取模型
                    </Button>
                  </div>
                  {modelCatalogs[source.id]?.error ? <span className="text-[11px] leading-5 text-[var(--danger)]">{modelCatalogs[source.id]?.error}</span> : null}
                </Field>
                <div className="ai-model-selected-panel">
                  <div className="ai-model-selected-header">
                    <span>已选模型</span>
                    <span>{source.models.length} 个</span>
                  </div>
                  {source.models.length ? (
                    <div className="ai-model-chip-row">
                      {source.models.map((model, index) => (
                        <button className="ai-model-chip" key={model} onClick={() => updateSource(source.id, { models: source.models.filter((item) => item !== model) })} type="button">
                          <span className="ai-model-chip-index">{index + 1}</span>
                          <span className="min-w-0 truncate">{model}</span>
                          <X size={12} />
                        </button>
                      ))}
                    </div>
                  ) : (
                    <p className="ai-model-empty">尚未选择模型，获取模型后从左侧下拉栏添加。</p>
                  )}
                </div>
              </div>
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}

function HistoryView({
  history,
  onSearchChange,
  onUseItem,
  search,
}: {
  readonly history: readonly HistoryItem[];
  readonly onSearchChange: (value: string) => void;
  readonly onUseItem: (item: HistoryItem) => void;
  readonly search: string;
}) {
  return (
    <div className="grid min-h-0 flex-1 grid-rows-[auto_1fr] gap-4">
      <div className="history-toolbar">
        <Search size={16} />
        <input onChange={(event) => onSearchChange(event.currentTarget.value)} placeholder="搜索原文、译文或服务源" value={search} />
      </div>
      <div className="history-list">
        {history.length ? (
          history.map((item) => (
            <button className="history-row" key={item.id} onClick={() => onUseItem(item)} type="button">
              <div>
                <span className="history-lang">{`AUTO -> ${item.targetLanguage}`}</span>
                <p className="mt-1 text-xs text-[var(--muted)]">{getProvider(item.provider).name}</p>
              </div>
              <p className="truncate text-sm">{item.source}</p>
              <p className="truncate text-sm">{item.target}</p>
              <div className="text-right text-xs text-[var(--muted)]">
                <p>{formatDateTime(item.timestamp)}</p>
                <p>{item.cached ? '缓存' : '新译文'}</p>
              </div>
            </button>
          ))
        ) : (
          <div className="grid h-full place-items-center p-8 text-center text-sm text-[var(--muted)]">
            暂无历史记录，完成翻译后会自动出现在这里。
          </div>
        )}
      </div>
    </div>
  );
}

function RecentTranslations({ history, onUse }: { readonly history: readonly HistoryItem[]; readonly onUse: (item: HistoryItem) => void }) {
  return (
    <Card className="bg-[var(--surface-raised)]" title="最近翻译">
      <div className="grid gap-3 p-4">
        {history.slice(0, 3).length ? (
          history.slice(0, 3).map((item) => (
            <button className="grid gap-1 rounded-xl p-2 text-left text-xs hover:bg-[var(--primary-ghost)]" key={item.id} onClick={() => onUse(item)} type="button">
              <span className="font-mono text-[var(--primary)]">{`AUTO -> ${item.targetLanguage}`}</span>
              <span className="line-clamp-2 text-[var(--fg)]">{item.source}</span>
              <span className="text-[var(--muted)]">{formatDateTime(item.timestamp)}</span>
            </button>
          ))
        ) : (
          <p className="text-sm leading-6 text-[var(--muted)]">完成一次翻译后，这里会显示最近记录。</p>
        )}
      </div>
    </Card>
  );
}

function InfoRow({ icon, label, value }: { readonly icon: React.ReactNode; readonly label: string; readonly value: string }) {
  return (
    <div className="flex items-center gap-3">
      <span className="text-[var(--primary)]">{icon}</span>
      <span className="min-w-24 text-[var(--muted)]">{label}</span>
      <span className="truncate text-[var(--fg)]">{value}</span>
    </div>
  );
}

function createScheduler(settings: AppSettings) {
  return new TranslationScheduler({
    defaultProvider: settings.provider,
    httpClient: tauriHttpClient,
    google: settings.googleApiKey ? { apiKey: settings.googleApiKey } : undefined,
    baidu: settings.baiduAppId && settings.baiduSecretKey ? { appId: settings.baiduAppId, secretKey: settings.baiduSecretKey } : undefined,
    deepl: settings.deeplApiKey ? { apiKey: settings.deeplApiKey, apiType: settings.deeplApiType } : undefined,
    microsoft: settings.microsoftApiKey
      ? {
          apiKey: settings.microsoftApiKey,
          region: settings.microsoftRegion,
          endpoint: settings.microsoftEndpoint,
        }
      : undefined,
    youdao: settings.youdaoAppKey && settings.youdaoAppSecret ? { appKey: settings.youdaoAppKey, appSecret: settings.youdaoAppSecret } : undefined,
    tencent:
      settings.tencentSecretId && settings.tencentSecretKey
        ? {
            secretId: settings.tencentSecretId,
            secretKey: settings.tencentSecretKey,
            region: settings.tencentRegion,
          }
        : undefined,
    ai:
      settings.provider === 'ai' && hasConfiguredAiSource(settings.aiSources)
        ? {
            sources: settings.aiSources,
            fallbackEnabled: settings.aiFallbackEnabled,
          }
        : undefined,
  });
}

function getProvider(provider: TranslatorProvider) {
  return PROVIDERS.find((item) => item.id === provider) ?? PROVIDERS[0];
}

function getConfiguredProviders(settings: AppSettings) {
  return PROVIDERS.filter((provider) => isProviderConfigured(provider.id, settings));
}

function isProviderConfigured(provider: TranslatorProvider, settings: AppSettings) {
  if (provider === 'ai') {
    return hasConfiguredAiSource(settings.aiSources);
  }
  if (provider === 'google-free') {
    return Boolean(settings.googleApiKey);
  }
  if (provider === 'baidu-free') {
    return Boolean(settings.baiduAppId && settings.baiduSecretKey);
  }
  if (provider === 'deepl') {
    return Boolean(settings.deeplApiKey);
  }
  if (provider === 'microsoft') {
    return Boolean(settings.microsoftApiKey);
  }
  if (provider === 'youdao') {
    return Boolean(settings.youdaoAppKey && settings.youdaoAppSecret);
  }
  return Boolean(settings.tencentSecretId && settings.tencentSecretKey);
}

function validateProvider(settings: AppSettings) {
  return isProviderConfigured(settings.provider, settings) ? '' : `${getProvider(settings.provider).name} 需要先补全服务源配置`;
}

function labelForLanguage(value: string) {
  return LANGUAGE_OPTIONS.find((language) => language.value === value)?.label ?? value;
}

function formatDateTime(value: Date) {
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(value);
}

function formatCharacterCount(value: number) {
  return `${formatCharacterNumber(value)} 字符`;
}

function formatCharacterNumber(value: number) {
  return new Intl.NumberFormat('zh-CN').format(value);
}

function currentUsageMonthKey(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

async function readCurrentMonthlyProviderUsage(): Promise<ProviderUsage> {
  const usage = await readMonthlyProviderUsage();
  return usage[currentUsageMonthKey()] ?? {};
}

async function readMonthlyProviderUsage(): Promise<MonthlyProviderUsage> {
  return (await readJsonAppData<MonthlyProviderUsage>(USAGE_STORAGE_KEY)) ?? {};
}

async function writeMonthlyProviderUsage(monthKey: string, usage: ProviderUsage) {
  const monthlyUsage = await readMonthlyProviderUsage();
  const nextUsage = Object.fromEntries(
    Object.entries({ ...monthlyUsage, [monthKey]: usage }).filter(([key]) => key === monthKey),
  ) as MonthlyProviderUsage;
  await writeJsonAppData(USAGE_STORAGE_KEY, nextUsage);
}

function isTranslatorProvider(value: string): value is TranslatorProvider {
  return PROVIDERS.some((provider) => provider.id === value);
}

function canUseTauri() {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

function isMobileRuntime() {
  if (typeof navigator === 'undefined') {
    return false;
  }
  return /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
}

async function openExternalUrl(url: string) {
  if (canUseTauri()) {
    try {
      await invoke('open_external_url', { url });
      return;
    } catch (error) {
      console.error('Failed to open external URL in the system browser', error);
      return;
    }
  }
  window.open(url, '_blank', 'noopener,noreferrer');
}

async function readStoredSettings(): Promise<Partial<AppSettings>> {
  return (await readJsonAppData<Partial<AppSettings>>(SETTINGS_STORAGE_KEY)) ?? {};
}

async function writeStoredSettings(settings: Partial<AppSettings>) {
  await writeJsonAppData(SETTINGS_STORAGE_KEY, settings);
}

async function readStoredHistory(): Promise<HistoryItem[]> {
  const rawItems = (await readJsonAppData<Array<Omit<HistoryItem, 'timestamp'> & { readonly timestamp: string }>>(HISTORY_STORAGE_KEY)) ?? [];
  return rawItems.map((item) => ({ ...item, timestamp: new Date(item.timestamp) }));
}

async function writeStoredHistory(history: readonly HistoryItem[]) {
  await writeJsonAppData(
    HISTORY_STORAGE_KEY,
    history.map((item) => ({ ...item, timestamp: item.timestamp.toISOString() })),
  );
}

async function readJsonAppData<T>(key: string): Promise<T | undefined> {
  if (canUseTauri()) {
    try {
      const value = await invoke<string | null>('read_app_data', { key });
      if (value) {
        return JSON.parse(value) as T;
      }
    } catch (error) {
      console.warn(`Failed to read LingFlow SQLite data for ${key}`, error);
    }
  }

  const legacyValue = window.localStorage.getItem(key);
  if (!legacyValue) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(legacyValue) as T;
    if (canUseTauri()) {
      await writeJsonAppData(key, parsed);
      window.localStorage.removeItem(key);
    }
    return parsed;
  } catch {
    window.localStorage.removeItem(key);
    return undefined;
  }
}

async function writeJsonAppData(key: string, value: unknown) {
  const serialized = JSON.stringify(value);
  if (!canUseTauri()) {
    window.localStorage.setItem(key, serialized);
    return;
  }

  try {
    await invoke('write_app_data', { key, value: serialized });
  } catch (error) {
    console.warn(`Failed to write LingFlow SQLite data for ${key}`, error);
  }
}

function mergeStoredSettings(storedSettings: Partial<AppSettings>, storedSecrets: Partial<AppSecrets>): AppSettings {
  const aiSourceApiKeys = storedSecrets.aiSourceApiKeys ?? {};
  const globalSelectionExcludedApps = Array.from(
    new Set([...(DEFAULT_SETTINGS.globalSelectionExcludedApps ?? []), ...(storedSettings.globalSelectionExcludedApps ?? [])]),
  );
  const storedSources = storedSettings.aiSources?.length
    ? storedSettings.aiSources
    : [
        {
          id: DEFAULT_AI_SOURCE_ID,
          name: 'OpenAI Compatible',
          baseUrl: storedSettings.aiBaseUrl || DEFAULT_SETTINGS.aiSources[0].baseUrl,
          apiKey: '',
          models: splitModels(storedSettings.aiModel || DEFAULT_SETTINGS.aiSources[0].models.join(',')),
          enabled: true,
        },
      ];

  const aiSources = storedSources.map((source, index) => ({
    ...source,
    apiKey:
      aiSourceApiKeys[source.id] ??
      (index === 0 ? storedSecrets.aiApiKey || storedSettings.aiApiKey || source.apiKey || '' : source.apiKey || ''),
    models: source.models?.length ? source.models : DEFAULT_SETTINGS.aiSources[0].models,
  }));

  return {
    ...DEFAULT_SETTINGS,
    ...storedSettings,
    onboardingCompleted: storedSettings.onboardingCompleted ?? DEFAULT_SETTINGS.onboardingCompleted,
    globalSelectionExcludedApps,
    aiFallbackEnabled: storedSettings.aiFallbackEnabled ?? DEFAULT_SETTINGS.aiFallbackEnabled,
    aiSources,
    ...storedSecrets,
  };
}

function normalizeSettingsForRuntime(settings: AppSettings): AppSettings {
  if (!isMobileRuntime()) {
    return settings;
  }

  return {
    ...settings,
    globalSelectionEnabled: false,
  };
}

function pickSecrets(settings: Partial<AppSettings>): Partial<AppSecrets> {
  const aiSourceApiKeys = Object.fromEntries(
    (settings.aiSources ?? []).map((source) => [source.id, source.apiKey]).filter(([, apiKey]) => Boolean(apiKey)),
  );

  return {
    aiSourceApiKeys: Object.keys(aiSourceApiKeys).length ? aiSourceApiKeys : undefined,
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
    darkMode: settings.darkMode,
    onboardingCompleted: settings.onboardingCompleted,
    localProxyHost: settings.localProxyHost,
    localProxyPort: settings.localProxyPort,
    globalSelectionEnabled: settings.globalSelectionEnabled,
    globalSelectionExcludedApps: settings.globalSelectionExcludedApps,
    aiFallbackEnabled: settings.aiFallbackEnabled,
    aiSources: settings.aiSources.map((source) => ({ ...source, apiKey: '' })),
    baiduAppId: settings.baiduAppId,
    deeplApiType: settings.deeplApiType,
    microsoftRegion: settings.microsoftRegion,
    microsoftEndpoint: settings.microsoftEndpoint,
    youdaoAppKey: settings.youdaoAppKey,
    tencentSecretId: settings.tencentSecretId,
    tencentRegion: settings.tencentRegion,
  };
}

function hasConfiguredAiSource(sources: readonly AiServiceSourceConfig[]) {
  return getConfiguredAiSources(sources).length > 0;
}

function getConfiguredAiSources(sources: readonly AiServiceSourceConfig[]) {
  return sources.filter(
    (source) =>
      source.enabled !== false &&
      source.baseUrl.trim() &&
      source.apiKey.trim() &&
      source.models.some((model) => model.trim()),
  );
}

function splitModels(value: string) {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

async function fetchAiModels(source: AiServiceSourceConfig) {
  const url = new URL('/v1/models', normalizeBaseUrl(source.baseUrl.trim()));
  const response = await tauriHttpClient(url.toString(), {
    method: 'GET',
    headers: {
      authorization: `Bearer ${source.apiKey.trim()}`,
    },
  });

  if (!response.ok) {
    throw new Error(`获取模型失败：HTTP ${response.status}`);
  }

  const payload = (await response.json()) as { readonly data?: readonly { readonly id?: string }[] };
  return Array.from(
    new Set(
      (payload.data ?? [])
        .map((model) => model.id?.trim())
        .filter((model): model is string => Boolean(model)),
    ),
  ).sort((left, right) => left.localeCompare(right));
}

function normalizeBaseUrl(baseUrl: string) {
  return baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
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

  return new Response(response.body, { status: response.status });
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
