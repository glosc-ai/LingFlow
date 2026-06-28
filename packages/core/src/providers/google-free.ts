import type {
  GoogleProviderConfig,
  ProviderHttpClient,
  TranslationRequest,
  TranslationResponse,
  TranslatorProviderAdapter,
} from '../types.js';

export class GoogleFreeTranslatorProvider implements TranslatorProviderAdapter {
  readonly id = 'google-free' as const;

  constructor(
    private readonly config?: GoogleProviderConfig,
    private readonly httpClient: ProviderHttpClient = fetch,
  ) {}

  async translate(request: TranslationRequest): Promise<TranslationResponse> {
    if (!this.config?.apiKey) {
      throw new Error('Google Cloud Translation requires an API key');
    }

    const url = new URL('https://translation.googleapis.com/language/translate/v2');
    url.searchParams.set('key', this.config.apiKey);

    const body: Record<string, string | string[]> = {
      q: request.text,
      target: request.targetLanguage,
      format: 'text',
    };

    if (request.sourceLanguage) {
      body.source = request.sourceLanguage;
    }

    const response = await this.httpClient(url.toString(), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      throw new Error(`Google Cloud Translation failed with HTTP ${response.status}`);
    }

    const payload = (await response.json()) as GoogleTranslateResponse;
    const translated = parseGoogleResponse(payload);
    if (!translated) {
      throw new Error('Google Cloud Translation returned an empty response');
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

interface GoogleTranslateResponse {
  readonly data?: {
    readonly translations?: readonly {
      readonly translatedText?: string;
    }[];
  };
}

function parseGoogleResponse(payload: GoogleTranslateResponse) {
  return payload.data?.translations?.[0]?.translatedText?.trim() ?? '';
}
