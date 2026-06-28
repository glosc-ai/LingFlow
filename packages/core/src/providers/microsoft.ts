import type {
  MicrosoftProviderConfig,
  ProviderHttpClient,
  TranslationRequest,
  TranslationResponse,
  TranslatorProviderAdapter,
} from '../types.js';

interface MicrosoftTranslateResponseItem {
  readonly translations?: readonly {
    readonly text?: string;
  }[];
}

export class MicrosoftTranslatorProvider implements TranslatorProviderAdapter {
  readonly id = 'microsoft' as const;

  constructor(
    private readonly config?: MicrosoftProviderConfig,
    private readonly httpClient: ProviderHttpClient = fetch,
  ) {}

  async translate(request: TranslationRequest): Promise<TranslationResponse> {
    if (!this.config?.apiKey) {
      throw new Error('Microsoft Translator requires an API key');
    }

    const endpoint = this.config.endpoint ?? 'https://api.cognitive.microsofttranslator.com';
    const url = new URL('/translate', normalizeBaseUrl(endpoint));
    url.searchParams.set('api-version', '3.0');
    url.searchParams.append('to', request.targetLanguage);
    if (request.sourceLanguage && request.sourceLanguage !== 'auto') {
      url.searchParams.set('from', request.sourceLanguage);
    }

    const headers: Record<string, string> = {
      'Ocp-Apim-Subscription-Key': this.config.apiKey,
      'content-type': 'application/json',
    };
    if (this.config.region) {
      headers['Ocp-Apim-Subscription-Region'] = this.config.region;
    }

    const response = await this.httpClient(url.toString(), {
      method: 'POST',
      headers,
      body: JSON.stringify([{ Text: request.text }]),
    });

    if (!response.ok) {
      throw new Error(`Microsoft Translator failed with HTTP ${response.status}: ${await response.text()}`);
    }

    const payload = (await response.json()) as MicrosoftTranslateResponseItem[];
    const translated = payload[0]?.translations?.[0]?.text?.trim();
    if (!translated) {
      throw new Error('Microsoft Translator returned an empty response');
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

function normalizeBaseUrl(baseUrl: string) {
  return baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
}
