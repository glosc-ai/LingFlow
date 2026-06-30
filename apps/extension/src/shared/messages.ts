import type { AiServiceSourceConfig, TranslationResponse, TranslatorProvider } from '@lingflow/core';

export interface LingFlowSettings {
  readonly enabled: boolean;
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
