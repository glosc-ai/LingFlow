import { describe, expect, it } from 'vitest';
import { DeepLTranslatorProvider } from './deepl';
import { MicrosoftTranslatorProvider } from './microsoft';
import { TencentTranslatorProvider } from './tencent';
import { YoudaoTranslatorProvider } from './youdao';

describe('official translation providers', () => {
  it('calls DeepL API Free with normalized target language', async () => {
    let body = '';
    let authorization = '';
    let headers: Record<string, string> = {};
    const provider = new DeepLTranslatorProvider({ apiKey: 'deepl-key', apiType: 'free' }, async (_input, init) => {
      body = String(init?.body);
      headers = init?.headers as Record<string, string>;
      authorization = headers.authorization;
      return new Response(JSON.stringify({ translations: [{ text: 'translated' }] }));
    });

    const response = await provider.translate({ text: 'Hello', sourceLanguage: 'en', targetLanguage: 'zh-CN' });
    const params = new URLSearchParams(body);

    expect(authorization).toBe('DeepL-Auth-Key deepl-key');
    expect(params.get('target_lang')).toBe('ZH-HANS');
    expect(response.text).toBe('translated');
  });

  it('calls Microsoft Translator with subscription headers', async () => {
    let url = '';
    let body = '';
    let headers: Record<string, string> = {};
    const provider = new MicrosoftTranslatorProvider(
      { apiKey: 'azure-key', region: 'eastasia' },
      async (input, init) => {
        url = String(input);
        body = String(init?.body);
        headers = init?.headers as Record<string, string>;
        return new Response(JSON.stringify([{ translations: [{ text: 'translated' }] }]));
      },
    );

    const response = await provider.translate({ text: 'Hello', sourceLanguage: 'en', targetLanguage: 'zh-Hans' });

    expect(url).toContain('api-version=3.0');
    expect(url).toContain('to=zh-Hans');
    expect(headers['Ocp-Apim-Subscription-Key']).toBe('azure-key');
    expect(headers['Ocp-Apim-Subscription-Region']).toBe('eastasia');
    expect(JSON.parse(body)).toEqual([{ Text: 'Hello' }]);
    expect(response.text).toBe('translated');
  });

  it('calls Youdao with v3 signature fields', async () => {
    let body = '';
    const provider = new YoudaoTranslatorProvider({ appKey: 'youdao-key', appSecret: 'youdao-secret' }, async (_input, init) => {
      body = String(init?.body);
      return new Response(JSON.stringify({ errorCode: '0', translation: ['translated'] }));
    });

    const response = await provider.translate({ text: 'Hello', sourceLanguage: 'en', targetLanguage: 'zh-CN' });
    const params = new URLSearchParams(body);

    expect(params.get('appKey')).toBe('youdao-key');
    expect(params.get('signType')).toBe('v3');
    expect(params.get('to')).toBe('zh-CHS');
    expect(params.get('sign')).toBeTruthy();
    expect(response.text).toBe('translated');
  });

  it('calls Tencent Cloud TMT with TC3 authorization', async () => {
    let body = '';
    let headers: Record<string, string> = {};
    const provider = new TencentTranslatorProvider(
      { secretId: 'secret-id', secretKey: 'secret-key', region: 'ap-guangzhou' },
      async (_input, init) => {
        body = String(init?.body);
        headers = init?.headers as Record<string, string>;
        return new Response(JSON.stringify({ Response: { TargetText: 'translated' } }));
      },
    );

    const response = await provider.translate({ text: 'Hello', sourceLanguage: 'en', targetLanguage: 'zh-CN' });
    const payload = JSON.parse(body) as { Source: string; Target: string; SourceText: string };

    expect(headers.authorization).toContain('TC3-HMAC-SHA256 Credential=secret-id/');
    expect(headers['X-TC-Action']).toBe('TextTranslate');
    expect(payload.Source).toBe('en');
    expect(payload.Target).toBe('zh');
    expect(payload.SourceText).toBe('Hello');
    expect(response.text).toBe('translated');
  });
});
