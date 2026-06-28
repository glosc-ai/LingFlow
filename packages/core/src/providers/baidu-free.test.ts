import { describe, expect, it } from 'vitest';
import { BaiduFreeTranslatorProvider } from './baidu-free';

describe('BaiduFreeTranslatorProvider', () => {
  it('normalizes common BCP-47 language codes to Baidu language codes', async () => {
    let body = '';
    const provider = new BaiduFreeTranslatorProvider(
      { appId: 'appid', secretKey: 'secret' },
      async (_input, init) => {
        body = String(init?.body);
        return new Response(
          JSON.stringify({
            from: 'en',
            to: 'zh',
            trans_result: [{ src: 'Hello', dst: '你好' }],
          }),
        );
      },
    );

    const response = await provider.translate({
      text: 'Hello',
      sourceLanguage: 'en-US',
      targetLanguage: 'zh-CN',
    });

    const params = new URLSearchParams(body);
    expect(params.get('from')).toBe('en');
    expect(params.get('to')).toBe('zh');
    expect(response.text).toBe('你好');
    expect(response.targetLanguage).toBe('zh-CN');
  });
});
