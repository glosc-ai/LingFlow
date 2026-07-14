import type { AiServiceSourceConfig, TranslationResponse, TranslatorProvider } from '@lingflow/core';

export interface LingFlowSettings {
  readonly enabled: boolean;
  readonly inputTranslationEnabled?: boolean;
  readonly inputTranslationShortcut?: string;
  readonly inputTranslationShortcutVersion?: number;
  readonly useLocalProxy?: boolean;
  readonly localProxyUrl?: string;
  readonly provider: TranslatorProvider;
  readonly targetLanguage: string;
  readonly sourceLanguage?: string;
  readonly aiFallbackEnabled?: boolean;
  readonly aiSources?: readonly AiServiceSourceConfig[];
  readonly aiBaseUrl?: string;
  readonly aiApiKey?: string;
  readonly aiModel?: string;
  readonly googleApiKey?: string;
  readonly baiduAppId?: string;
  readonly baiduSecretKey?: string;
  readonly deeplApiKey?: string;
  readonly deeplApiType?: 'free' | 'pro';
  readonly microsoftApiKey?: string;
  readonly microsoftRegion?: string;
  readonly microsoftEndpoint?: string;
  readonly youdaoAppKey?: string;
  readonly youdaoAppSecret?: string;
  readonly tencentSecretId?: string;
  readonly tencentSecretKey?: string;
  readonly tencentRegion?: string;
}

export type ContentMessage =
  | { readonly type: 'LF_PING' }
  | { readonly type: 'LF_TRANSLATE_PAGE' }
  | { readonly type: 'LF_CLEANUP' };

export type ContentMessageResponse =
  | { readonly ok: true; readonly message: string }
  | { readonly ok: false; readonly error: string };

export type BackgroundMessage =
  | {
      readonly type: 'LF_TRANSLATE_TEXT';
      readonly text: string;
      readonly settings: LingFlowSettings;
    }
  | {
      readonly type: 'LF_TEST_PROVIDER';
      readonly settings: LingFlowSettings;
    }
  | {
      readonly type: 'LF_DESKTOP_STATUS';
    }
  | {
      readonly type: 'LF_REPORT_SELECTION';
      readonly text: string;
      readonly x: number;
      readonly y: number;
    };

export type TranslationMessageResponse =
  | { readonly ok: true; readonly value: TranslationResponse }
  | { readonly ok: false; readonly error: string };

export type ProviderTestMessageResponse =
  | {
      readonly ok: true;
      readonly provider: TranslatorProvider;
      readonly elapsedMs: number;
      readonly translatedText: string;
    }
  | { readonly ok: false; readonly error: string };

export type DesktopStatusMessageResponse =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: string };

export type SelectionReportMessageResponse =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: string };

export const DEFAULT_SETTINGS: LingFlowSettings = {
  enabled: true,
  inputTranslationEnabled: true,
  inputTranslationShortcut: 'Alt+R',
  inputTranslationShortcutVersion: 2,
  useLocalProxy: true,
  localProxyUrl: 'http://127.0.0.1:47631',
  provider: 'baidu-free',
  targetLanguage: 'zh-CN',
  aiFallbackEnabled: true,
  aiSources: [
    {
      id: 'openai-default',
      name: 'OpenAI Compatible',
      baseUrl: 'https://api.openai.com',
      apiKey: '',
      models: ['gpt-4.1-mini'],
      enabled: true,
    },
  ],
  aiBaseUrl: 'https://api.openai.com',
  aiModel: 'gpt-4.1-mini',
  deeplApiType: 'free',
  microsoftEndpoint: 'https://api.cognitive.microsofttranslator.com',
  tencentRegion: 'ap-guangzhou',
};

export const SETTINGS_STORAGE_KEY = 'lingflow.settings';

export function mergeLingFlowSettings(stored?: Partial<LingFlowSettings>): LingFlowSettings {
  const shouldMigrateLegacyDefault =
    (stored?.inputTranslationShortcutVersion ?? 0) < 2 && stored?.inputTranslationShortcut === 'Ctrl+Shift+Enter';
  return {
    ...DEFAULT_SETTINGS,
    ...stored,
    inputTranslationShortcut: shouldMigrateLegacyDefault
      ? DEFAULT_SETTINGS.inputTranslationShortcut
      : stored?.inputTranslationShortcut ?? DEFAULT_SETTINGS.inputTranslationShortcut,
    inputTranslationShortcutVersion: 2,
  };
}

export function mergeDesktopTranslationSettings(
  extensionSettings: LingFlowSettings,
  desktopSettings: Partial<LingFlowSettings>,
): LingFlowSettings {
  const targetLanguage =
    extensionSettings.targetLanguage === 'auto'
      ? desktopSettings.targetLanguage || DEFAULT_SETTINGS.targetLanguage
      : extensionSettings.targetLanguage || desktopSettings.targetLanguage || DEFAULT_SETTINGS.targetLanguage;

  return {
    ...DEFAULT_SETTINGS,
    ...extensionSettings,
    ...desktopSettings,
    provider: extensionSettings.provider || desktopSettings.provider || DEFAULT_SETTINGS.provider,
    sourceLanguage: extensionSettings.sourceLanguage ?? desktopSettings.sourceLanguage,
    targetLanguage,
    useLocalProxy: true,
    localProxyUrl: extensionSettings.localProxyUrl ?? DEFAULT_SETTINGS.localProxyUrl,
  };
}

export interface ShortcutKeyEventLike {
  readonly altKey: boolean;
  readonly ctrlKey: boolean;
  readonly key: string;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
}

export interface InputTranslationDirection {
  readonly sourceLanguage: 'en' | 'zh-CN';
  readonly targetLanguage: 'en' | 'zh-CN';
}

export function resolveInputTranslationDirection(text: string): InputTranslationDirection | undefined {
  const chineseCharacterCount = text.match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g)?.length ?? 0;
  const englishWordCount = text.match(/[A-Za-z]+(?:['’-][A-Za-z]+)*/g)?.length ?? 0;
  if (!chineseCharacterCount && !englishWordCount) {
    return undefined;
  }

  return chineseCharacterCount >= englishWordCount
    ? { sourceLanguage: 'zh-CN', targetLanguage: 'en' }
    : { sourceLanguage: 'en', targetLanguage: 'zh-CN' };
}

export function inputTranslationShortcutFromKeyEvent(event: ShortcutKeyEventLike) {
  if (['Alt', 'AltGraph', 'Control', 'Meta', 'Shift'].includes(event.key)) {
    return null;
  }
  if (event.metaKey) {
    throw new Error('暂不支持 Windows 或 Command 键，请使用 Ctrl、Alt 或 Shift');
  }

  const parts: string[] = [];
  if (event.ctrlKey) {
    parts.push('Ctrl');
  }
  if (event.altKey) {
    parts.push('Alt');
  }
  if (event.shiftKey) {
    parts.push('Shift');
  }
  parts.push(event.key === ' ' ? 'Space' : event.key);
  return normalizeInputTranslationShortcut(parts.join('+'));
}

export function normalizeInputTranslationShortcut(value: string) {
  const parts = value
    .split('+')
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length < 2) {
    throw new Error('快捷键必须包含修饰键和一个按键，例如 Alt+R');
  }

  const modifiers = new Set<string>();
  let key = '';
  for (const part of parts) {
    const normalized = part.toLowerCase();
    if (normalized === 'ctrl' || normalized === 'control') {
      modifiers.add('Ctrl');
    } else if (normalized === 'alt') {
      modifiers.add('Alt');
    } else if (normalized === 'shift') {
      modifiers.add('Shift');
    } else {
      if (key) {
        throw new Error('快捷键只能包含一个普通按键');
      }
      key = normalizeShortcutKey(part);
    }
  }

  if (!modifiers.size || !key) {
    throw new Error('快捷键至少需要 Ctrl、Alt、Shift 中的一个修饰键和一个普通按键');
  }

  const orderedModifiers = ['Ctrl', 'Alt', 'Shift'].filter((modifier) => modifiers.has(modifier));
  return [...orderedModifiers, key].join('+');
}

function normalizeShortcutKey(value: string) {
  const trimmed = value.trim();
  if (/^[a-z0-9]$/i.test(trimmed)) {
    return trimmed.toUpperCase();
  }
  const functionKey = /^f([1-9]|1\d|2[0-4])$/i.exec(trimmed);
  if (functionKey) {
    return `F${functionKey[1]}`;
  }

  const aliases: Record<string, string> = {
    space: 'Space',
    enter: 'Enter',
    tab: 'Tab',
    esc: 'Escape',
    escape: 'Escape',
    backspace: 'Backspace',
    delete: 'Delete',
    insert: 'Insert',
    home: 'Home',
    end: 'End',
    pageup: 'PageUp',
    pagedown: 'PageDown',
    arrowup: 'ArrowUp',
    arrowdown: 'ArrowDown',
    arrowleft: 'ArrowLeft',
    arrowright: 'ArrowRight',
  };
  const key = aliases[trimmed.toLowerCase()];
  if (!key) {
    throw new Error('普通按键仅支持字母、数字、F1-F24 和常用功能键');
  }
  return key;
}
