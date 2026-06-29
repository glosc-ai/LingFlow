import { describe, expect, it } from 'vitest';
import { OpenAiCompatibleTranslatorProvider } from './openai-compatible';

describe('OpenAiCompatibleTranslatorProvider', () => {
  it('uses only the first source and model when fallback is disabled', async () => {
    const calls: string[] = [];
    const provider = new OpenAiCompatibleTranslatorProvider(
      {
        fallbackEnabled: false,
        sources: [
          {
            id: 'primary',
            name: 'Primary',
            baseUrl: 'https://primary.example',
            apiKey: 'primary-key',
            models: ['bad-model', 'good-model'],
          },
          {
            id: 'secondary',
            name: 'Secondary',
            baseUrl: 'https://secondary.example',
            apiKey: 'secondary-key',
            models: ['other-model'],
          },
        ],
      },
      async (_input, init) => {
        calls.push(JSON.parse(String(init?.body)).model as string);
        return new Response('nope', { status: 500 });
      },
    );

    await expect(provider.translate({ text: 'Hello', targetLanguage: 'zh-CN' })).rejects.toThrow('bad-model');
    expect(calls).toEqual(['bad-model']);
  });

  it('falls back to the next selected model in the same source', async () => {
    const calls: string[] = [];
    const provider = new OpenAiCompatibleTranslatorProvider(
      {
        fallbackEnabled: true,
        sources: [
          {
            id: 'primary',
            name: 'Primary',
            baseUrl: 'https://primary.example',
            apiKey: 'primary-key',
            models: ['bad-model', 'good-model'],
          },
        ],
      },
      async (_input, init) => {
        const model = JSON.parse(String(init?.body)).model as string;
        calls.push(model);
        if (model === 'bad-model') {
          return new Response('nope', { status: 503 });
        }

        return new Response(JSON.stringify({ choices: [{ message: { content: '你好' } }] }));
      },
    );

    const response = await provider.translate({ text: 'Hello', targetLanguage: 'zh-CN' });

    expect(response.text).toBe('你好');
    expect(calls).toEqual(['bad-model', 'good-model']);
  });

  it('falls back to the next service source after source failures', async () => {
    const urls: string[] = [];
    const provider = new OpenAiCompatibleTranslatorProvider(
      {
        fallbackEnabled: true,
        sources: [
          {
            id: 'primary',
            name: 'Primary',
            baseUrl: 'https://primary.example',
            apiKey: 'primary-key',
            models: ['primary-model'],
          },
          {
            id: 'secondary',
            name: 'Secondary',
            baseUrl: 'https://secondary.example',
            apiKey: 'secondary-key',
            models: ['secondary-model'],
          },
        ],
      },
      async (input) => {
        urls.push(String(input));
        if (String(input).startsWith('https://primary.example')) {
          return new Response('nope', { status: 429 });
        }

        return new Response(JSON.stringify({ choices: [{ message: { content: '你好' } }] }));
      },
    );

    const response = await provider.translate({ text: 'Hello', targetLanguage: 'zh-CN' });

    expect(response.text).toBe('你好');
    expect(urls).toEqual([
      'https://primary.example/v1/chat/completions',
      'https://secondary.example/v1/chat/completions',
    ]);
  });
});
