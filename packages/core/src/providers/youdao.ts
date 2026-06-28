import CryptoJS from 'crypto-js';
import type {
  ProviderHttpClient,
  TranslationRequest,
  TranslationResponse,
  TranslatorProviderAdapter,
  YoudaoProviderConfig,
} from '../types.js';

interface YoudaoTranslateResponse {
  readonly errorCode?: string;
  readonly translation?: readonly string[];
  readonly l?: string;
}

export class YoudaoTranslatorProvider implements TranslatorProviderAdapter {
  readonly id = 'youdao' as const;

  constructor(
    private readonly config?: YoudaoProviderConfig,
    private readonly httpClient: ProviderHttpClient = fetch,
  ) {}

  async translate(request: TranslationRequest): Promise<TranslationResponse> {
    if (!this.config?.appKey || !this.config.appSecret) {
      throw new Error('Youdao Translate requires app key and app secret');
    }

    const salt = crypto.randomUUID();
    const curtime = Math.floor(Date.now() / 1000).toString();
    const input = truncateForSign(request.text);
    const sign = CryptoJS.SHA256(`${this.config.appKey}${input}${salt}${curtime}${this.config.appSecret}`).toString();
    const body = new URLSearchParams({
      q: request.text,
      from: normalizeYoudaoLanguageCode(request.sourceLanguage ?? 'auto'),
      to: normalizeYoudaoLanguageCode(request.targetLanguage),
      appKey: this.config.appKey,
      salt,
      sign,
      signType: 'v3',
      curtime,
    });

    const response = await this.httpClient('https://openapi.youdao.com/api', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
      },
      body,
    });

    if (!response.ok) {
      throw new Error(`Youdao Translate failed with HTTP ${response.status}`);
    }

    const payload = (await response.json()) as YoudaoTranslateResponse;
    if (payload.errorCode && payload.errorCode !== '0') {
      throw new Error(`Youdao Translate error ${payload.errorCode}`);
    }

    const translated = payload.translation?.join('\n').trim();
    if (!translated) {
      throw new Error('Youdao Translate returned an empty response');
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

function truncateForSign(text: string) {
  if (text.length <= 20) {
    return text;
  }

  return `${text.slice(0, 10)}${text.length}${text.slice(-10)}`;
}

function normalizeYoudaoLanguageCode(language: string) {
  const normalized = language.trim().toLowerCase().replace('_', '-');
  const aliases: Record<string, string> = {
    'zh-cn': 'zh-CHS',
    'zh-hans': 'zh-CHS',
    zh: 'zh-CHS',
    'zh-tw': 'zh-CHT',
    'zh-hant': 'zh-CHT',
    ja: 'ja',
    jp: 'ja',
    ko: 'ko',
    kor: 'ko',
  };

  return aliases[normalized] ?? normalized;
}
