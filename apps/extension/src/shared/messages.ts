import type { TranslationResponse, TranslatorProvider } from '@lingflow/core';

export interface LingFlowSettings {
  readonly enabled: boolean;
  readonly useLocalProxy?: boolean;
  readonly localProxyUrl?: string;
  readonly provider: TranslatorProvider;
  readonly targetLanguage: string;
  readonly sourceLanguage?: string;
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
  | { readonly type: 'LF_TRANSLATE_SELECTION' }
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

export const DEFAULT_SETTINGS: LingFlowSettings = {
  enabled: true,
  useLocalProxy: true,
  localProxyUrl: 'http://127.0.0.1:47631',
  provider: 'mock',
  targetLanguage: 'zh-CN',
  aiBaseUrl: 'https://api.openai.com',
  aiModel: 'gpt-4.1-mini',
  deeplApiType: 'free',
  microsoftEndpoint: 'https://api.cognitive.microsofttranslator.com',
  tencentRegion: 'ap-guangzhou',
};

export const SETTINGS_STORAGE_KEY = 'lingflow.settings';
