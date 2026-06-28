import type {
  AiProviderConfig,
  ProviderHttpClient,
  TranslationRequest,
  TranslationResponse,
  TranslatorProviderAdapter,
} from '../types.js';

interface ChatCompletionResponse {
  readonly choices?: readonly {
    readonly message?: {
      readonly content?: string;
    };
  }[];
}

export class OpenAiCompatibleTranslatorProvider implements TranslatorProviderAdapter {
  readonly id = 'ai' as const;

  constructor(
    private readonly config: AiProviderConfig,
    private readonly httpClient: ProviderHttpClient = fetch,
  ) {}

  async translate(request: TranslationRequest): Promise<TranslationResponse> {
    const url = new URL('/v1/chat/completions', normalizeBaseUrl(this.config.baseUrl));
    const response = await this.httpClient(url.toString(), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.config.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: this.config.model,
        temperature: 0.2,
        messages: [
          {
            role: 'system',
            content:
              'Translate the user text faithfully. Return only the translated text, without commentary.',
          },
          {
            role: 'user',
            content: `Source language: ${request.sourceLanguage ?? 'auto'}\nTarget language: ${
              request.targetLanguage
            }\n\n${request.text}`,
          },
        ],
      }),
    });

    if (!response.ok) {
      throw new Error(`AI translation failed with HTTP ${response.status}`);
    }

    const payload = (await response.json()) as ChatCompletionResponse;
    const translated = payload.choices?.[0]?.message?.content?.trim();
    if (!translated) {
      throw new Error('AI translation returned an empty response');
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
