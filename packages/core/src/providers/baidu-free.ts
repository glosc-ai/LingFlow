import CryptoJS from 'crypto-js';
import type {
  BaiduProviderConfig,
  ProviderHttpClient,
  TranslationRequest,
  TranslationResponse,
  TranslatorProviderAdapter,
} from '../types.js';

interface BaiduTranslateResponse {
  readonly from?: string;
  readonly to?: string;
  readonly trans_result?: readonly { readonly src?: string; readonly dst?: string }[];
  readonly error_code?: string;
  readonly error_msg?: string;
}

export class BaiduFreeTranslatorProvider implements TranslatorProviderAdapter {
  readonly id = 'baidu-free' as const;

  constructor(
    private readonly config?: BaiduProviderConfig,
    private readonly httpClient: ProviderHttpClient = fetch,
  ) {}

  async translate(request: TranslationRequest): Promise<TranslationResponse> {
    if (!this.config?.appId || !this.config.secretKey) {
      throw new Error('Baidu Translate requires APP ID and secret key');
    }

    const salt = Date.now().toString();
    const from = normalizeBaiduLanguageCode(request.sourceLanguage ?? 'auto');
    const to = normalizeBaiduLanguageCode(request.targetLanguage);
    const sign = CryptoJS.MD5(`${this.config.appId}${request.text}${salt}${this.config.secretKey}`).toString();
    const body = new URLSearchParams({
      q: request.text,
      from,
      to,
      appid: this.config.appId,
      salt,
      sign,
    });

    const response = await this.httpClient('https://fanyi-api.baidu.com/api/trans/vip/translate', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
      },
      body,
    });

    if (!response.ok) {
      throw new Error(`Baidu Translate failed with HTTP ${response.status}`);
    }

    const payload = (await response.json()) as BaiduTranslateResponse;
    if (payload.error_code) {
      throw new Error(`Baidu Translate error ${payload.error_code}: ${payload.error_msg ?? 'unknown error'}`);
    }

    const translated = payload.trans_result?.map((item) => item.dst ?? '').join('\n').trim();
    if (!translated) {
      throw new Error('Baidu Translate returned an empty response');
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

function normalizeBaiduLanguageCode(language: string) {
  const normalized = language.trim().toLowerCase().replace('_', '-');

  const aliases: Record<string, string> = {
    'zh-cn': 'zh',
    'zh-hans': 'zh',
    'zh-sg': 'zh',
    'zh-tw': 'cht',
    'zh-hant': 'cht',
    'zh-hk': 'cht',
    'en-us': 'en',
    'en-gb': 'en',
    'ja-jp': 'jp',
    ja: 'jp',
    ko: 'kor',
    'ko-kr': 'kor',
  };

  return aliases[normalized] ?? normalized;
}
