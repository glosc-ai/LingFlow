import { describe, expect, it } from 'vitest';
import { TranslationScheduler } from './translation-scheduler';
import type { TranslatorProviderAdapter } from '../types';

describe('TranslationScheduler', () => {
  it('translates with a mock provider and caches repeated requests', async () => {
    let calls = 0;
    const provider: TranslatorProviderAdapter = {
      id: 'mock',
      async translate(request) {
        calls += 1;
        return {
          text: `translated:${request.text}`,
          sourceText: request.text,
          targetLanguage: request.targetLanguage,
          provider: 'mock',
        };
      },
    };
    const scheduler = new TranslationScheduler({ defaultProvider: 'mock', providers: [provider] });

    const first = await scheduler.translate({ text: 'hello', targetLanguage: 'zh-CN' });
    const second = await scheduler.translate({ text: 'hello', targetLanguage: 'zh-CN' });

    expect(first.text).toBe('translated:hello');
    expect(second.cached).toBe(true);
    expect(calls).toBe(1);
  });

  it('keeps batch order and returns structured failures', async () => {
    const provider: TranslatorProviderAdapter = {
      id: 'mock',
      async translate(request) {
        if (request.text === 'bad') {
          throw new Error('boom');
        }
        return {
          text: request.text.toUpperCase(),
          sourceText: request.text,
          targetLanguage: request.targetLanguage,
          provider: 'mock',
        };
      },
    };
    const scheduler = new TranslationScheduler({ defaultProvider: 'mock', providers: [provider] });

    const results = await scheduler.translateBatch([
      { text: 'ok', targetLanguage: 'zh-CN' },
      { text: 'bad', targetLanguage: 'zh-CN' },
      { text: 'done', targetLanguage: 'zh-CN' },
    ]);

    expect(results[0]?.ok).toBe(true);
    expect(results[1]?.ok).toBe(false);
    expect(results[2]?.ok).toBe(true);
    if (!results[1]?.ok) {
      expect(results[1].error.message).toBe('boom');
      expect(results[1].sourceText).toBe('bad');
    }
  });
});
