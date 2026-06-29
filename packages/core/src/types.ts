export type TranslatorProvider =
  | 'google-free'
  | 'baidu-free'
  | 'deepl'
  | 'microsoft'
  | 'youdao'
  | 'tencent'
  | 'ai';

export interface AiServiceSourceConfig {
  readonly id: string;
  readonly name: string;
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly models: readonly string[];
  readonly enabled?: boolean;
}

export interface AiProviderConfig {
  readonly sources?: readonly AiServiceSourceConfig[];
  readonly fallbackEnabled?: boolean;
  readonly baseUrl?: string;
  readonly apiKey?: string;
  readonly model?: string;
}

export interface GoogleProviderConfig {
  readonly apiKey: string;
}

export interface BaiduProviderConfig {
  readonly appId: string;
  readonly secretKey: string;
}

export interface DeepLProviderConfig {
  readonly apiKey: string;
  readonly apiType?: 'free' | 'pro';
  readonly baseUrl?: string;
}

export interface MicrosoftProviderConfig {
  readonly apiKey: string;
  readonly region?: string;
  readonly endpoint?: string;
}

export interface YoudaoProviderConfig {
  readonly appKey: string;
  readonly appSecret: string;
}

export interface TencentProviderConfig {
  readonly secretId: string;
  readonly secretKey: string;
  readonly region?: string;
  readonly projectId?: number;
}

export type ProviderHttpClient = typeof fetch;

export interface TranslationRequest {
  readonly text: string;
  readonly sourceLanguage?: string;
  readonly targetLanguage: string;
  readonly provider?: TranslatorProvider;
}

export interface TranslationResponse {
  readonly text: string;
  readonly sourceText: string;
  readonly sourceLanguage?: string;
  readonly targetLanguage: string;
  readonly provider: TranslatorProvider;
  readonly cached?: boolean;
}

export interface TranslationError {
  readonly code: string;
  readonly message: string;
  readonly provider: TranslatorProvider;
  readonly recoverable: boolean;
}

export type TranslationBatchItem =
  | { readonly ok: true; readonly value: TranslationResponse }
  | { readonly ok: false; readonly error: TranslationError; readonly sourceText: string };

export interface TranslatorProviderAdapter {
  readonly id: TranslatorProvider;
  translate(request: TranslationRequest): Promise<TranslationResponse>;
}

export interface TranslationCache {
  get(request: TranslationRequest, provider: TranslatorProvider): TranslationResponse | undefined;
  set(request: TranslationRequest, provider: TranslatorProvider, response: TranslationResponse): void;
  clear(): void;
}

export interface TranslationSchedulerOptions {
  readonly defaultProvider?: TranslatorProvider;
  readonly providers?: readonly TranslatorProviderAdapter[];
  readonly cache?: TranslationCache;
  readonly ai?: AiProviderConfig;
  readonly google?: GoogleProviderConfig;
  readonly baidu?: BaiduProviderConfig;
  readonly deepl?: DeepLProviderConfig;
  readonly microsoft?: MicrosoftProviderConfig;
  readonly youdao?: YoudaoProviderConfig;
  readonly tencent?: TencentProviderConfig;
  readonly httpClient?: ProviderHttpClient;
}

export function createTranslationError(
  provider: TranslatorProvider,
  error: unknown,
  code = 'TRANSLATION_FAILED',
): TranslationError {
  return {
    code,
    message: error instanceof Error ? error.message : String(error),
    provider,
    recoverable: true,
  };
}

export function isTranslationError(error: unknown): error is TranslationError {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    'message' in error &&
    'provider' in error &&
    'recoverable' in error
  );
}
