import type {
  AiProviderConfig,
  AiServiceSourceConfig,
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

interface AiAttempt {
  readonly source: AiServiceSourceConfig;
  readonly model: string;
}

export class OpenAiCompatibleTranslatorProvider implements TranslatorProviderAdapter {
  readonly id = 'ai' as const;

  constructor(
    private readonly config: AiProviderConfig,
    private readonly httpClient: ProviderHttpClient = fetch,
  ) {}

  async translate(request: TranslationRequest): Promise<TranslationResponse> {
    const attempts = createAttempts(this.config);
    if (attempts.length === 0) {
      throw new Error('AI provider requires at least one enabled source with base URL, API key, and model');
    }

    const selectedAttempts = this.config.fallbackEnabled === false ? attempts.slice(0, 1) : attempts;
    const errors: string[] = [];

    for (const attempt of selectedAttempts) {
      try {
        return await this.translateWithAttempt(request, attempt);
      } catch (error) {
        errors.push(`${attempt.source.name}/${attempt.model}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    throw new Error(`AI translation failed for all configured sources. ${errors.join(' | ')}`);
  }

  private async translateWithAttempt(request: TranslationRequest, attempt: AiAttempt): Promise<TranslationResponse> {
    const url = new URL('/v1/chat/completions', normalizeBaseUrl(attempt.source.baseUrl));
    const response = await this.httpClient(url.toString(), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${attempt.source.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: attempt.model,
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
      throw new Error(`HTTP ${response.status}`);
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

function createAttempts(config: AiProviderConfig): readonly AiAttempt[] {
  const sources = normalizeSources(config);
  return sources.flatMap((source) =>
    source.models
      .map((model) => model.trim())
      .filter(Boolean)
      .map((model) => ({ source, model })),
  );
}

function normalizeSources(config: AiProviderConfig): readonly AiServiceSourceConfig[] {
  const configuredSources =
    config.sources
      ?.filter((source) => source.enabled !== false)
      .map((source) => ({
        ...source,
        baseUrl: source.baseUrl.trim(),
        apiKey: source.apiKey.trim(),
        models: source.models.map((model) => model.trim()).filter(Boolean),
      }))
      .filter((source) => source.baseUrl && source.apiKey && source.models.length > 0) ?? [];

  if (configuredSources.length > 0) {
    return configuredSources;
  }

  if (config.baseUrl?.trim() && config.apiKey?.trim() && config.model?.trim()) {
    return [
      {
        id: 'legacy',
        name: 'OpenAI Compatible',
        baseUrl: config.baseUrl.trim(),
        apiKey: config.apiKey.trim(),
        models: [config.model.trim()],
        enabled: true,
      },
    ];
  }

  return [];
}

function normalizeBaseUrl(baseUrl: string) {
  return baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
}
