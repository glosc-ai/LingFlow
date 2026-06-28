import type {
  DeepLProviderConfig,
  ProviderHttpClient,
  TranslationRequest,
  TranslationResponse,
  TranslatorProviderAdapter,
} from '../types.js';

interface DeepLTranslateResponse {
  readonly translations?: readonly {
    readonly text?: string;
  }[];
  readonly message?: string;
}

export class DeepLTranslatorProvider implements TranslatorProviderAdapter {
  readonly id = 'deepl' as const;

  constructor(
    private readonly config?: DeepLProviderConfig,
    private readonly httpClient: ProviderHttpClient = fetch,
  ) {}

  async translate(request: TranslationRequest): Promise<TranslationResponse> {
    if (!this.config?.apiKey) {
      throw new Error('DeepL requires an API key');
    }

    const endpoint =
      this.config.baseUrl ??
      (this.config.apiType === 'pro' ? 'https://api.deepl.com/v2/translate' : 'https://api-free.deepl.com/v2/translate');
    const body = new URLSearchParams({
      text: request.text,
      target_lang: normalizeDeepLLanguageCode(request.targetLanguage, 'target'),
    });

    if (request.sourceLanguage && request.sourceLanguage !== 'auto') {
      body.set('source_lang', normalizeDeepLLanguageCode(request.sourceLanguage, 'source'));
    }

    const response = await this.httpClient(endpoint, {
      method: 'POST',
      headers: {
        authorization: `DeepL-Auth-Key ${this.config.apiKey}`,
        'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
      },
      body,
    });
    const payload = (await response.json()) as DeepLTranslateResponse;

    if (!response.ok) {
      throw new Error(`DeepL failed with HTTP ${response.status}: ${payload.message ?? 'unknown error'}`);
    }

    const translated = payload.translations?.[0]?.text?.trim();
    if (!translated) {
      throw new Error('DeepL returned an empty response');
    }

    return {
      text: translated,
      sourceText: request.text,
      sourceLanguage: request.sourceLanguage,
      targetLanguage: request.targetLanguage,
      provider: this.id,
    };
  }
}

function normalizeDeepLLanguageCode(language: string, kind: 'source' | 'target') {
  const normalized = language.trim().toLowerCase().replace('_', '-');
  const targetAliases: Record<string, string> = {
    zh: 'ZH-HANS',
    'zh-cn': 'ZH-HANS',
    'zh-hans': 'ZH-HANS',
    'zh-tw': 'ZH-HANT',
    'zh-hant': 'ZH-HANT',
    en: 'EN-US',
    'en-us': 'EN-US',
    'en-gb': 'EN-GB',
    pt: 'PT-PT',
    'pt-br': 'PT-BR',
    ja: 'JA',
    jp: 'JA',
    ko: 'KO',
  };
  const sourceAliases: Record<string, string> = {
    zh: 'ZH',
    'zh-cn': 'ZH',
    'zh-hans': 'ZH',
    'zh-tw': 'ZH',
    'zh-hant': 'ZH',
    'en-us': 'EN',
    'en-gb': 'EN',
    ja: 'JA',
    jp: 'JA',
    ko: 'KO',
  };

  return (kind === 'target' ? targetAliases : sourceAliases)[normalized] ?? normalized.toUpperCase();
}
