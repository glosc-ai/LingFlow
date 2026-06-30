import { useEffect, useMemo, useState } from 'react';
import type { AiServiceSourceConfig, TranslatorProvider } from '@lingflow/core';
import {
  CheckCircle2,
  Eraser,
  FileText,
  GripVertical,
  Moon,
  Plus,
  RadioTower,
  RefreshCw,
  ExternalLink,
  Sun,
  X,
} from 'lucide-react';
import { LingFlowLogo } from '@/components/lingflow-logo';
import { Button, Field, IconButton, Section, SelectField, TextField, Toggle } from '@/components/popup-ui';
import { cn } from '@/lib/utils';
import {
  DEFAULT_SETTINGS,
  SETTINGS_STORAGE_KEY,
  type BackgroundMessage,
  type ContentMessage,
  type ContentMessageResponse,
  type LingFlowSettings,
  type ProviderTestMessageResponse,
} from './shared/messages';

const PROVIDERS: ReadonlyArray<{ id: TranslatorProvider; name: string; tone: 'ai' | 'free' }> = [
  { id: 'ai', name: 'AI 翻译', tone: 'ai' },
  { id: 'google-free', name: 'Google Cloud', tone: 'free' },
  { id: 'baidu-free', name: '百度翻译', tone: 'free' },
  { id: 'deepl', name: 'DeepL', tone: 'ai' },
  { id: 'microsoft', name: 'Microsoft Translator', tone: 'free' },
  { id: 'youdao', name: '有道翻译', tone: 'free' },
  { id: 'tencent', name: '腾讯云 TMT', tone: 'free' },
];

const TARGET_LANGUAGES = [
  { value: 'auto', label: '自动检测' },
  { value: 'zh-CN', label: '简体中文' },
  { value: 'en', label: '英语' },
  { value: 'ja', label: '日语' },
  { value: 'ko', label: '韩语' },
  { value: 'fr', label: '法语' },
  { value: 'de', label: '德语' },
  { value: 'es', label: '西班牙语' },
];

type DesktopSettings = Partial<LingFlowSettings>;
type DesktopConnectionState = 'checking' | 'online' | 'offline';

interface AiModelCatalog {
  readonly error?: string;
  readonly loading: boolean;
  readonly models: readonly string[];
}

function App() {
  const [settings, setSettings] = useState<LingFlowSettings>(DEFAULT_SETTINGS);
  const [status, setStatus] = useState('就绪 / 本地代理待检测');
  const [statusTone, setStatusTone] = useState<'ok' | 'warn'>('ok');
  const [testResult, setTestResult] = useState<{ tone: 'success' | 'error'; message: string } | null>(null);
  const [testingProxy, setTestingProxy] = useState(false);
  const [darkMode, setDarkMode] = useState(false);
  const [desktopSettings, setDesktopSettings] = useState<DesktopSettings | null>(null);
  const [desktopConnection, setDesktopConnection] = useState<DesktopConnectionState>('checking');

  const useLocalProxy = settings.useLocalProxy !== false;
  const localProxyUrl = settings.localProxyUrl ?? DEFAULT_SETTINGS.localProxyUrl ?? '';
  const selectedProvider = getProvider(settings.provider);
  const configuredProviders = useMemo(
    () => (useLocalProxy ? getConfiguredDesktopProviders(desktopSettings) : PROVIDERS.map((provider) => provider.id)),
    [desktopSettings, useLocalProxy],
  );
  const providerOptions = useMemo(
    () => PROVIDERS.filter((provider) => configuredProviders.includes(provider.id)),
    [configuredProviders],
  );
  const routeLabel = useLocalProxy ? '本地代理' : selectedProvider.name;

  const statusChip = useMemo(() => {
    if (!settings.enabled) {
      return { text: '已暂停', tone: 'warn' as const };
    }
    return useLocalProxy ? { text: '自动', tone: 'success' as const } : { text: '直连', tone: 'warn' as const };
  }, [settings.enabled, useLocalProxy]);

  useEffect(() => {
    document.documentElement.classList.toggle('dark', darkMode);
  }, [darkMode]);

  useEffect(() => {
    if (!useLocalProxy) {
      setDesktopSettings(null);
      setDesktopConnection('online');
      return;
    }

    let cancelled = false;
    setDesktopConnection('checking');
    fetchDesktopSettings(localProxyUrl)
      .then((value) => {
        if (!cancelled) {
          setDesktopSettings(value);
          setDesktopConnection('online');
        }
      })
      .catch(() => {
        if (!cancelled) {
          setDesktopSettings(null);
          setDesktopConnection('offline');
        }
      });

    return () => {
      cancelled = true;
    };
  }, [localProxyUrl, useLocalProxy]);

  useEffect(() => {
    if (!useLocalProxy || providerOptions.length === 0) {
      return;
    }

    if (!providerOptions.some((provider) => provider.id === settings.provider)) {
      void updateSettings({ ...settings, provider: providerOptions[0].id }, '已切换到桌面端已配置服务商');
    }
  }, [providerOptions, settings, useLocalProxy]);

  useEffect(() => {
    if (!canUseChromeStorage()) {
      setStatus('浏览器预览模式');
      return;
    }

    chrome.storage.local.get(SETTINGS_STORAGE_KEY).then((result) => {
      const stored = result[SETTINGS_STORAGE_KEY] as Partial<LingFlowSettings> | undefined;
      const next = sanitizeSettingsForStorage({ ...DEFAULT_SETTINGS, ...stored });
      setSettings(next);
      chrome.storage.local.set({ [SETTINGS_STORAGE_KEY]: next });
      setStatus(next.enabled ? '就绪 / 本地代理已连接' : '扩展已暂停');
      setStatusTone(next.enabled ? 'ok' : 'warn');
    });
  }, []);

  async function updateSettings(next: LingFlowSettings, nextStatus = '已保存') {
    const sanitized = sanitizeSettingsForStorage(next);
    setSettings(sanitized);
    if (canUseChromeStorage()) {
      await chrome.storage.local.set({ [SETTINGS_STORAGE_KEY]: sanitized });
    }
    setStatus(nextStatus);
    setStatusTone(sanitized.enabled ? 'ok' : 'warn');
  }

  async function testProviderConnection() {
    setTestingProxy(true);
    setTestResult(null);
    setStatus(useLocalProxy ? '正在检查本地代理' : '正在测试服务源');
    setStatusTone('warn');

    try {
      if (!canUseChromeRuntime()) {
        await wait(500);
        setTestResult({ tone: 'success', message: '预览模式 / 检查模拟成功' });
        setStatus('浏览器预览模式 / 本地代理在线');
        setStatusTone('ok');
        return;
      }

      const message: BackgroundMessage = { type: 'LF_TEST_PROVIDER', settings };
      const response = await sendRuntimeMessage<ProviderTestMessageResponse>(message);
      if (!response) {
        setTestResult({ tone: 'error', message: '后台服务未响应，请重新加载扩展' });
        setStatus('后台服务未响应');
        setStatusTone('warn');
        return;
      }

      if (response.ok) {
        setTestResult({
          tone: 'success',
          message: `${providerName(response.provider)} 在线 / 延迟 ${response.elapsedMs}ms`,
        });
        setStatus('就绪 / 服务源可用');
        setStatusTone('ok');
        return;
      }

      setTestResult({ tone: 'error', message: response.error });
      setStatus(response.error);
      setStatusTone('warn');
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error);
      setTestResult({ tone: 'error', message: messageText });
      setStatus(messageText);
      setStatusTone('warn');
    } finally {
      setTestingProxy(false);
    }
  }

  async function sendToActiveTab(message: ContentMessage, progressStatus: string, successStatus: string) {
    if (!settings.enabled) {
      setStatus('请先启用 LingFlow 翻译');
      setStatusTone('warn');
      return;
    }

    if (!canUseChromeTabs()) {
      setStatus(`预览模式 / ${successStatus}`);
      setStatusTone('ok');
      return;
    }

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) {
      setStatus('未找到当前标签页');
      setStatusTone('warn');
      return;
    }

    setStatus(progressStatus);
    setStatusTone('ok');

    const response = await sendMessageWithContentScriptFallback(tab.id, message);
    if (!response) {
      setStatus('页面脚本未响应，请刷新页面后重试');
      setStatusTone('warn');
      return;
    }

    if (response.ok) {
      setStatus(response.message || successStatus);
      setStatusTone('ok');
      return;
    }

    setStatus(response.error);
    setStatusTone('warn');
  }

  async function sendMessageWithContentScriptFallback(tabId: number, message: ContentMessage) {
    const first = await sendContentMessage(tabId, message);
    if (!first) {
      return { ok: false, error: '页面脚本未响应，请刷新页面后重试' } as const;
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

  return (
    <main className="popup-shell">
      <header className="popup-header">
        <LingFlowLogo showWordmark />
        <IconButton label="切换主题" onClick={() => setDarkMode((value) => !value)}>
          {darkMode ? <Sun size={14} /> : <Moon size={14} />}
        </IconButton>
      </header>

      <div className="popup-content">
        <Toggle
          checked={settings.enabled}
          label="启用 LingFlow 翻译"
          onChange={(checked) => updateSettings({ ...settings, enabled: checked }, checked ? '扩展已启用' : '扩展已暂停')}
        />

        <Section title="翻译设置">
          <div className="grid gap-2">
            <Field label="桌面端服务路由">
              <ReadonlyField chip={statusChip.text} chipTone={statusChip.tone} value={routeLabel} />
            </Field>
            <Field label="目标语言">
              <SelectField
                value={settings.targetLanguage}
                onChange={(event) => updateSettings({ ...settings, targetLanguage: event.currentTarget.value })}
              >
                {TARGET_LANGUAGES.map((language) => (
                  <option key={language.value} value={language.value}>
                    {language.label}
                  </option>
                ))}
              </SelectField>
            </Field>
            <Field label="翻译服务商">
              <SelectField
                disabled={useLocalProxy && providerOptions.length === 0}
                value={useLocalProxy && providerOptions.length === 0 ? '' : settings.provider}
                onChange={(event) => updateSettings({ ...settings, provider: event.currentTarget.value as TranslatorProvider })}
              >
                {useLocalProxy && providerOptions.length === 0 ? <option value="">未检测到已配置服务商</option> : null}
                {(useLocalProxy ? providerOptions : PROVIDERS).map((provider) => (
                  <option key={provider.id} value={provider.id}>
                    {provider.name}
                  </option>
                ))}
              </SelectField>
            </Field>
          </div>
        </Section>

        <Section title="本地代理">
          <div className="provider-card">
            <div className="provider-card-header">
              <span className="provider-card-name">
                <span className={cn('provider-dot', selectedProvider.tone)} />
                桌面端代理
              </span>
              <span className={cn('status-chip', statusChip.tone === 'warn' && 'warn')}>{settings.enabled ? '可用' : '暂停'}</span>
            </div>

            <div className="proxy-note">
              <RadioTower size={14} />
              <span>扩展默认通过本地代理调用桌面端服务源，凭据、模型和端点统一在桌面端“服务源配置”中管理。</span>
            </div>

            <div className="config-fields">
              <Field label="代理地址">
                <TextField
                  disabled={!useLocalProxy}
                  onChange={(event) => updateSettings({ ...settings, localProxyUrl: event.currentTarget.value })}
                  placeholder="http://127.0.0.1:47631"
                  value={settings.localProxyUrl ?? DEFAULT_SETTINGS.localProxyUrl}
                />
              </Field>
              <InfoLine label="当前服务源" value={providerOptions.length ? selectedProvider.name : '未检测到已配置服务商'} />
            </div>

            <Button block disabled={testingProxy} onClick={testProviderConnection}>
              {testingProxy ? <RefreshCw className="animate-spin" size={14} /> : <CheckCircle2 size={14} />}
              {useLocalProxy ? '检查本地代理' : '测试直连服务源'}
            </Button>

            {testResult ? <div className={cn('test-result show', testResult.tone)}>{testResult.message}</div> : null}
          </div>
        </Section>

        {useLocalProxy && desktopConnection === 'offline' ? (
          <DesktopOfflineNotice localProxyUrl={localProxyUrl} onRetry={() => void retryDesktopConnection()} />
        ) : null}

        <AdvancedProviderSettings settings={settings} updateSettings={updateSettings} useLocalProxy={useLocalProxy} />

        <div className="action-grid">
          <Button
            className="col-span-2"
            onClick={() => sendToActiveTab({ type: 'LF_TRANSLATE_PAGE' }, '正在翻译当前页面', '整页翻译已发送')}
            variant="primary"
          >
            <FileText size={14} />
            整页翻译
          </Button>
          <Button
            className="col-span-2"
            onClick={() => sendToActiveTab({ type: 'LF_CLEANUP' }, '正在清除页面翻译', '已清除页面翻译')}
          >
            <Eraser size={14} />
            清除页面翻译
          </Button>
        </div>
      </div>

      <footer className="status-bar">
        <span className={cn('status-dot', statusTone)} />
        <span className="truncate">{status}</span>
      </footer>
    </main>
  );

  async function retryDesktopConnection() {
    setDesktopConnection('checking');
    setStatus('正在连接 LingFlow 桌面端');
    setStatusTone('warn');
    try {
      const nextDesktopSettings = await fetchDesktopSettings(localProxyUrl);
      setDesktopSettings(nextDesktopSettings);
      setDesktopConnection('online');
      setStatus('LingFlow 桌面端已连接');
      setStatusTone('ok');
    } catch {
      setDesktopSettings(null);
      setDesktopConnection('offline');
      setStatus('未检测到 LingFlow 桌面端');
      setStatusTone('warn');
    }
  }
}

export default App;

function DesktopOfflineNotice({
  localProxyUrl,
  onRetry,
}: {
  readonly localProxyUrl: string;
  readonly onRetry: () => void;
}) {
  return (
    <section className="desktop-offline-card">
      <div className="desktop-offline-header">
        <RadioTower size={16} />
        <div>
          <h2>需要 LingFlow 桌面端</h2>
          <p>浏览器扩展通过桌面端本地代理同步服务商配置和密钥，因此需要先打开 LingFlow 桌面端。</p>
        </div>
      </div>
      <div className="desktop-offline-meta">
        <span>当前代理地址</span>
        <code>{localProxyUrl}</code>
      </div>
      <div className="desktop-offline-actions">
        <Button onClick={onRetry}>
          <RefreshCw size={14} />
          重新检测
        </Button>
        <a className="popup-button primary" href="https://github.com/glosc-ai/LingFlow/releases" rel="noreferrer" target="_blank">
          <ExternalLink size={14} />
          下载桌面端
        </a>
      </div>
    </section>
  );
}

function ReadonlyField({
  chip,
  chipTone,
  value,
}: {
  readonly chip: string;
  readonly chipTone: 'success' | 'warn';
  readonly value: string;
}) {
  return (
    <div className="readonly-field">
      <span className="truncate">{value}</span>
      <span className={cn('status-chip', chipTone === 'warn' && 'warn')}>{chip}</span>
    </div>
  );
}

function InfoLine({ label, mono, value }: { readonly label: string; readonly mono?: boolean; readonly value: string }) {
  return (
    <div>
      <span className="config-field-label">{label}</span>
      <span className={cn('config-value', mono && 'mono')}>{value}</span>
    </div>
  );
}

function AdvancedProviderSettings({
  settings,
  updateSettings,
  useLocalProxy,
}: {
  readonly settings: LingFlowSettings;
  readonly updateSettings: (settings: LingFlowSettings, status?: string) => Promise<void>;
  readonly useLocalProxy: boolean;
}) {
  return (
    <details className="advanced-card" open={!useLocalProxy}>
      <summary>
        <span>高级直连配置</span>
        <span className="text-[11px] text-[var(--muted)]">{useLocalProxy ? '默认跟随桌面端' : '正在使用直连'}</span>
      </summary>
      <div className="mt-3 grid gap-3">
        <Toggle
          checked={useLocalProxy}
          label="跟随桌面端代理"
          onChange={(checked) =>
            updateSettings({ ...settings, useLocalProxy: checked }, checked ? '已切换为桌面端代理' : '已切换为扩展直连')
          }
        />
        <Field label="本地代理地址">
          <TextField
            disabled={!useLocalProxy}
            onChange={(event) => updateSettings({ ...settings, localProxyUrl: event.currentTarget.value })}
            value={settings.localProxyUrl ?? DEFAULT_SETTINGS.localProxyUrl}
          />
        </Field>
        <Field label="直连服务源">
          <SelectField
            disabled={useLocalProxy}
            value={settings.provider}
            onChange={(event) => updateSettings({ ...settings, provider: event.currentTarget.value as TranslatorProvider })}
          >
            {PROVIDERS.map((provider) => (
              <option key={provider.id} value={provider.id}>
                {provider.name}
              </option>
            ))}
          </SelectField>
        </Field>
        {!useLocalProxy ? <DirectProviderFields settings={settings} updateSettings={updateSettings} /> : null}
      </div>
    </details>
  );
}

function DirectProviderFields({
  settings,
  updateSettings,
}: {
  readonly settings: LingFlowSettings;
  readonly updateSettings: (settings: LingFlowSettings, status?: string) => Promise<void>;
}) {
  if (settings.provider === 'google-free') {
    return (
      <Field label="Google Cloud API Key">
        <TextField
          onChange={(event) => updateSettings({ ...settings, googleApiKey: event.currentTarget.value })}
          type="password"
          value={settings.googleApiKey ?? ''}
        />
      </Field>
    );
  }

  if (settings.provider === 'baidu-free') {
    return (
      <>
        <Field label="Baidu APP ID">
          <TextField
            onChange={(event) => updateSettings({ ...settings, baiduAppId: event.currentTarget.value })}
            value={settings.baiduAppId ?? ''}
          />
        </Field>
        <Field label="Baidu Secret Key">
          <TextField
            onChange={(event) => updateSettings({ ...settings, baiduSecretKey: event.currentTarget.value })}
            type="password"
            value={settings.baiduSecretKey ?? ''}
          />
        </Field>
      </>
    );
  }

  if (settings.provider === 'deepl') {
    return (
      <>
        <Field label="DeepL API 类型">
          <SelectField
            value={settings.deeplApiType ?? 'free'}
            onChange={(event) => updateSettings({ ...settings, deeplApiType: event.currentTarget.value as 'free' | 'pro' })}
          >
            <option value="free">DeepL API Free</option>
            <option value="pro">DeepL API Pro</option>
          </SelectField>
        </Field>
        <Field label="DeepL API Key">
          <TextField
            onChange={(event) => updateSettings({ ...settings, deeplApiKey: event.currentTarget.value })}
            type="password"
            value={settings.deeplApiKey ?? ''}
          />
        </Field>
      </>
    );
  }

  if (settings.provider === 'microsoft') {
    return (
      <>
        <Field label="Microsoft API Key">
          <TextField
            onChange={(event) => updateSettings({ ...settings, microsoftApiKey: event.currentTarget.value })}
            type="password"
            value={settings.microsoftApiKey ?? ''}
          />
        </Field>
        <Field label="Region">
          <TextField
            onChange={(event) => updateSettings({ ...settings, microsoftRegion: event.currentTarget.value })}
            placeholder="eastasia"
            value={settings.microsoftRegion ?? ''}
          />
        </Field>
        <Field label="Endpoint">
          <TextField
            onChange={(event) => updateSettings({ ...settings, microsoftEndpoint: event.currentTarget.value })}
            value={settings.microsoftEndpoint ?? ''}
          />
        </Field>
      </>
    );
  }

  if (settings.provider === 'youdao') {
    return (
      <>
        <Field label="有道 App Key">
          <TextField
            onChange={(event) => updateSettings({ ...settings, youdaoAppKey: event.currentTarget.value })}
            value={settings.youdaoAppKey ?? ''}
          />
        </Field>
        <Field label="有道 App Secret">
          <TextField
            onChange={(event) => updateSettings({ ...settings, youdaoAppSecret: event.currentTarget.value })}
            type="password"
            value={settings.youdaoAppSecret ?? ''}
          />
        </Field>
      </>
    );
  }

  if (settings.provider === 'tencent') {
    return (
      <>
        <Field label="Tencent SecretId">
          <TextField
            onChange={(event) => updateSettings({ ...settings, tencentSecretId: event.currentTarget.value })}
            value={settings.tencentSecretId ?? ''}
          />
        </Field>
        <Field label="Tencent SecretKey">
          <TextField
            onChange={(event) => updateSettings({ ...settings, tencentSecretKey: event.currentTarget.value })}
            type="password"
            value={settings.tencentSecretKey ?? ''}
          />
        </Field>
        <Field label="Region">
          <TextField
            onChange={(event) => updateSettings({ ...settings, tencentRegion: event.currentTarget.value })}
            value={settings.tencentRegion ?? ''}
          />
        </Field>
      </>
    );
  }

  return <DirectAiSources settings={settings} updateSettings={updateSettings} />;
}

function DirectAiSources({
  settings,
  updateSettings,
}: {
  readonly settings: LingFlowSettings;
  readonly updateSettings: (settings: LingFlowSettings, status?: string) => Promise<void>;
}) {
  const sources = settings.aiSources?.length ? settings.aiSources : DEFAULT_SETTINGS.aiSources ?? [];
  const [modelCatalogs, setModelCatalogs] = useState<Record<string, AiModelCatalog>>({});

  function updateSource(sourceId: string, patch: Partial<AiServiceSourceConfig>) {
    return updateSettings({
      ...settings,
      aiSources: sources.map((source) => (source.id === sourceId ? { ...source, ...patch } : source)),
    });
  }

  function addSource() {
    const source: AiServiceSourceConfig = {
      id: `ai-source-${Date.now()}`,
      name: 'AI Service',
      baseUrl: '',
      apiKey: '',
      models: [],
      enabled: true,
    };
    return updateSettings({ ...settings, aiSources: [...sources, source] });
  }

  function removeSource(sourceId: string) {
    const nextSources = sources.filter((source) => source.id !== sourceId);
    return updateSettings({ ...settings, aiSources: nextSources.length ? nextSources : DEFAULT_SETTINGS.aiSources });
  }

  function moveSource(fromId: string, toId: string) {
    const fromIndex = sources.findIndex((source) => source.id === fromId);
    const toIndex = sources.findIndex((source) => source.id === toId);
    if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) {
      return;
    }

    const nextSources = [...sources];
    const [moved] = nextSources.splice(fromIndex, 1);
    nextSources.splice(toIndex, 0, moved);
    void updateSettings({ ...settings, aiSources: nextSources });
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
        void updateSource(source.id, { models: [models[0]] });
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
    void updateSource(source.id, { models: [...source.models, model] });
  }

  return (
    <div className="direct-ai-sources">
      <Toggle
        checked={settings.aiFallbackEnabled !== false}
        label="AI 服务源与模型自动回退"
        onChange={(checked) => updateSettings({ ...settings, aiFallbackEnabled: checked })}
      />
      <Button onClick={addSource}>
        <Plus size={14} />
        添加 AI 服务源
      </Button>
      {sources.map((source) => (
        <article
          className="direct-ai-card"
          draggable
          key={source.id}
          onDragOver={(event) => event.preventDefault()}
          onDragStart={(event) => event.dataTransfer.setData('text/plain', source.id)}
          onDrop={(event) => {
            event.preventDefault();
            moveSource(event.dataTransfer.getData('text/plain'), source.id);
          }}
        >
          <div className="direct-ai-card-header">
            <GripVertical size={15} />
            <TextField
              aria-label="AI 服务源名称"
              onChange={(event) => updateSource(source.id, { name: event.currentTarget.value })}
              value={source.name}
            />
            <IconButton label="删除服务源" onClick={() => removeSource(source.id)}>
              <X size={14} />
            </IconButton>
          </div>
          <Field label="Base URL">
            <TextField
              onChange={(event) => updateSource(source.id, { baseUrl: event.currentTarget.value })}
              placeholder="https://api.openai.com"
              value={source.baseUrl}
            />
          </Field>
          <Field label="API Key">
            <TextField
              onChange={(event) => updateSource(source.id, { apiKey: event.currentTarget.value })}
              type="password"
              value={source.apiKey}
            />
          </Field>
          <Field label="模型">
            <div className="direct-ai-model-select">
              <SelectField
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
              </SelectField>
              <Button
                disabled={!source.baseUrl.trim() || !source.apiKey.trim() || modelCatalogs[source.id]?.loading}
                onClick={() => void fetchModels(source)}
              >
                {modelCatalogs[source.id]?.loading ? <RefreshCw className="animate-spin" size={13} /> : <RefreshCw size={13} />}
                获取模型
              </Button>
            </div>
            {modelCatalogs[source.id]?.error ? (
              <span className="text-[11px] leading-5 text-[var(--danger)]">{modelCatalogs[source.id]?.error}</span>
            ) : null}
          </Field>
          <div className="direct-ai-models">
            {source.models.map((model) => (
              <button
                className="direct-ai-model-chip"
                key={model}
                onClick={() => updateSource(source.id, { models: source.models.filter((item) => item !== model) })}
                type="button"
              >
                <span>{model}</span>
                <X size={11} />
              </button>
            ))}
          </div>
        </article>
      ))}
    </div>
  );
}

function getProvider(provider: TranslatorProvider) {
  return PROVIDERS.find((item) => item.id === provider) ?? PROVIDERS[0];
}

function providerName(provider: TranslatorProvider) {
  return getProvider(provider).name;
}

async function fetchDesktopSettings(proxyUrl: string): Promise<DesktopSettings> {
  const response = await fetch(`${normalizeLocalProxyUrl(proxyUrl)}/settings`);
  if (!response.ok) {
    throw new Error(`LingFlow desktop proxy settings failed with HTTP ${response.status}`);
  }

  return (await response.json()) as DesktopSettings;
}

function getConfiguredDesktopProviders(settings: DesktopSettings | null): readonly TranslatorProvider[] {
  if (!settings) {
    return [];
  }

  const providers: TranslatorProvider[] = [];
  if (settings.aiSources?.some((source) => source.enabled !== false && source.baseUrl?.trim() && source.apiKey?.trim() && source.models?.length)) {
    providers.push('ai');
  }
  if (settings.googleApiKey?.trim()) {
    providers.push('google-free');
  }
  if (settings.baiduAppId?.trim() && settings.baiduSecretKey?.trim()) {
    providers.push('baidu-free');
  }
  if (settings.deeplApiKey?.trim()) {
    providers.push('deepl');
  }
  if (settings.microsoftApiKey?.trim()) {
    providers.push('microsoft');
  }
  if (settings.youdaoAppKey?.trim() && settings.youdaoAppSecret?.trim()) {
    providers.push('youdao');
  }
  if (settings.tencentSecretId?.trim() && settings.tencentSecretKey?.trim()) {
    providers.push('tencent');
  }

  return providers;
}

function normalizeLocalProxyUrl(proxyUrl?: string) {
  return (proxyUrl || DEFAULT_SETTINGS.localProxyUrl || 'http://127.0.0.1:47631').replace(/\/+$/, '');
}

async function fetchAiModels(source: AiServiceSourceConfig) {
  const url = new URL('/v1/models', normalizeBaseUrl(source.baseUrl.trim()));
  const response = await fetch(url.toString(), {
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

function wait(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function canUseChromeStorage() {
  return typeof chrome !== 'undefined' && Boolean(chrome.storage?.local);
}

function canUseChromeRuntime() {
  return typeof chrome !== 'undefined' && Boolean(chrome.runtime?.sendMessage);
}

function canUseChromeTabs() {
  const tabsApi = typeof chrome !== 'undefined' ? chrome.tabs : undefined;
  return Boolean(tabsApi?.query && tabsApi?.sendMessage);
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

async function sendContentMessage(tabId: number, message: ContentMessage): Promise<ContentMessageResponse> {
  try {
    return (
      (await sendTabMessage<ContentMessageResponse>(tabId, message)) ?? {
        ok: false,
        error: '页面脚本未响应，请刷新页面后重试',
      }
    );
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : '无法连接当前页面，请尝试普通 http/https 页面',
    };
  }
}

async function injectContentScript(tabId: number): Promise<ContentMessageResponse> {
  const manifest = chrome.runtime.getManifest();
  const contentScript = manifest.content_scripts?.[0]?.js?.[0];
  if (!contentScript) {
    return { ok: false, error: 'manifest 缺少 content script 入口' };
  }

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: [contentScript],
    });
    return { ok: true, message: '页面脚本已注入' };
  } catch (error) {
    return {
      ok: false,
      error: normalizeContentScriptInjectionError(error),
    };
  }
}

function normalizeContentScriptInjectionError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('src/content.ts-loader.js') || message.includes('CRXJS') || message.includes('Could not load file')) {
    return [
      '当前浏览器仍在使用 LingFlow 开发模式或旧版扩展入口，无法注入页面脚本。',
      '请在扩展管理页删除旧 LingFlow 扩展后，重新加载 E:\\LingFlow\\apps\\extension\\dist，并刷新当前网页。',
    ].join(' ');
  }

  return message || '无法注入 LingFlow，请刷新普通 http/https 页面后重试';
}

function sanitizeSettingsForStorage(settings: LingFlowSettings): LingFlowSettings {
  if (settings.useLocalProxy === false) {
    return settings;
  }

  return {
    enabled: settings.enabled,
    useLocalProxy: true,
    localProxyUrl: settings.localProxyUrl,
    provider: settings.provider,
    targetLanguage: settings.targetLanguage,
    sourceLanguage: settings.sourceLanguage,
  };
}
