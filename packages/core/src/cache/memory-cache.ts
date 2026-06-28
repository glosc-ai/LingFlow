import type { TranslationCache, TranslationRequest, TranslationResponse, TranslatorProvider } from '../types.js';

export class MemoryTranslationCache implements TranslationCache {
  private readonly values = new Map<string, TranslationResponse>();

  get(request: TranslationRequest, provider: TranslatorProvider) {
    const value = this.values.get(createTranslationCacheKey(request, provider));
    return value ? { ...value, cached: true } : undefined;
  }

  set(request: TranslationRequest, provider: TranslatorProvider, response: TranslationResponse) {
    this.values.set(createTranslationCacheKey(request, provider), { ...response, cached: false });
  }

  clear() {
    this.values.clear();
  }
}

export function createTranslationCacheKey(request: TranslationRequest, provider: TranslatorProvider) {
  return JSON.stringify({
    provider,
    sourceLanguage: request.sourceLanguage ?? 'auto',
    targetLanguage: request.targetLanguage,
    text: request.text,
  });
}
