import type { TranslationRequest, TranslationResponse, TranslatorProviderAdapter } from '../types.js';

export class MockTranslatorProvider implements TranslatorProviderAdapter {
  readonly id = 'mock' as const;

  async translate(request: TranslationRequest): Promise<TranslationResponse> {
    return {
      text: `[${request.targetLanguage}] ${request.text}`,
      sourceText: request.text,
      sourceLanguage: request.sourceLanguage,
      targetLanguage: request.targetLanguage,
      provider: this.id,
    };
  }
}
