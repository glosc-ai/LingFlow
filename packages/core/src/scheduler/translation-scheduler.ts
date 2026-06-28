import { MemoryTranslationCache } from '../cache/memory-cache.js';
import { BaiduFreeTranslatorProvider } from '../providers/baidu-free.js';
import { DeepLTranslatorProvider } from '../providers/deepl.js';
import { GoogleFreeTranslatorProvider } from '../providers/google-free.js';
import { MicrosoftTranslatorProvider } from '../providers/microsoft.js';
import { MockTranslatorProvider } from '../providers/mock.js';
import { OpenAiCompatibleTranslatorProvider } from '../providers/openai-compatible.js';
import { TencentTranslatorProvider } from '../providers/tencent.js';
import { YoudaoTranslatorProvider } from '../providers/youdao.js';
import {
  createTranslationError,
  isTranslationError,
  type TranslationBatchItem,
  type TranslationRequest,
  type TranslationSchedulerOptions,
  type TranslatorProvider,
  type TranslatorProviderAdapter,
} from '../types.js';

export class TranslationScheduler {
  private readonly defaultProvider: TranslatorProvider;
  private readonly providers = new Map<TranslatorProvider, TranslatorProviderAdapter>();
  private readonly cache;

  constructor(options: TranslationSchedulerOptions = {}) {
    this.defaultProvider = options.defaultProvider ?? 'google-free';
    this.cache = options.cache ?? new MemoryTranslationCache();

    const providers: TranslatorProviderAdapter[] = [
      new GoogleFreeTranslatorProvider(options.google, options.httpClient),
      new BaiduFreeTranslatorProvider(options.baidu, options.httpClient),
      new DeepLTranslatorProvider(options.deepl, options.httpClient),
      new MicrosoftTranslatorProvider(options.microsoft, options.httpClient),
      new YoudaoTranslatorProvider(options.youdao, options.httpClient),
      new TencentTranslatorProvider(options.tencent, options.httpClient),
      new MockTranslatorProvider(),
    ];

    if (options.ai) {
      providers.push(new OpenAiCompatibleTranslatorProvider(options.ai, options.httpClient));
    }

    for (const provider of [...providers, ...(options.providers ?? [])]) {
      this.providers.set(provider.id, provider);
    }
  }

  async translate(request: TranslationRequest) {
    const providerId = request.provider ?? this.defaultProvider;
    const cached = this.cache.get(request, providerId);
    if (cached) {
      return cached;
    }

    const provider = this.providers.get(providerId);
    if (!provider) {
      throw createTranslationError(providerId, `Provider "${providerId}" is not configured`, 'PROVIDER_NOT_FOUND');
    }

    const response = await provider.translate({ ...request, provider: providerId });
    this.cache.set(request, providerId, response);
    return response;
  }

  async translateBatch(requests: readonly TranslationRequest[]): Promise<TranslationBatchItem[]> {
    return Promise.all(
      requests.map(async (request) => {
        const provider = request.provider ?? this.defaultProvider;
        try {
          return { ok: true, value: await this.translate(request) } as const;
        } catch (error) {
          return {
            ok: false,
            sourceText: request.text,
            error: isTranslationError(error) ? error : createTranslationError(provider, error),
          } as const;
        }
      }),
    );
  }
}
