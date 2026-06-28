import CryptoJS from 'crypto-js';
import type {
  ProviderHttpClient,
  TencentProviderConfig,
  TranslationRequest,
  TranslationResponse,
  TranslatorProviderAdapter,
} from '../types.js';

interface TencentTranslateResponse {
  readonly Response?: {
    readonly TargetText?: string;
    readonly Error?: {
      readonly Code?: string;
      readonly Message?: string;
    };
  };
}

export class TencentTranslatorProvider implements TranslatorProviderAdapter {
  readonly id = 'tencent' as const;

  constructor(
    private readonly config?: TencentProviderConfig,
    private readonly httpClient: ProviderHttpClient = fetch,
  ) {}

  async translate(request: TranslationRequest): Promise<TranslationResponse> {
    if (!this.config?.secretId || !this.config.secretKey) {
      throw new Error('Tencent Cloud TMT requires secret id and secret key');
    }

    const host = 'tmt.tencentcloudapi.com';
    const timestamp = Math.floor(Date.now() / 1000);
    const region = this.config.region ?? 'ap-guangzhou';
    const payload = JSON.stringify({
      SourceText: request.text,
      Source: normalizeTencentLanguageCode(request.sourceLanguage ?? 'auto'),
      Target: normalizeTencentLanguageCode(request.targetLanguage),
      ProjectId: this.config.projectId ?? 0,
    });

    const authorization = createTencentAuthorization({
      secretId: this.config.secretId,
      secretKey: this.config.secretKey,
      host,
      timestamp,
      payload,
    });

    const response = await this.httpClient(`https://${host}`, {
      method: 'POST',
      headers: {
        authorization,
        'content-type': 'application/json; charset=utf-8',
        host,
        'X-TC-Action': 'TextTranslate',
        'X-TC-Region': region,
        'X-TC-Timestamp': timestamp.toString(),
        'X-TC-Version': '2018-03-21',
      },
      body: payload,
    });

    if (!response.ok) {
      throw new Error(`Tencent Cloud TMT failed with HTTP ${response.status}: ${await response.text()}`);
    }

    const body = (await response.json()) as TencentTranslateResponse;
    const apiError = body.Response?.Error;
    if (apiError) {
      throw new Error(`Tencent Cloud TMT error ${apiError.Code ?? 'unknown'}: ${apiError.Message ?? 'unknown error'}`);
    }

    const translated = body.Response?.TargetText?.trim();
    if (!translated) {
      throw new Error('Tencent Cloud TMT returned an empty response');
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

interface TencentAuthorizationInput {
  readonly secretId: string;
  readonly secretKey: string;
  readonly host: string;
  readonly timestamp: number;
  readonly payload: string;
}

function createTencentAuthorization(input: TencentAuthorizationInput) {
  const algorithm = 'TC3-HMAC-SHA256';
  const service = 'tmt';
  const date = new Date(input.timestamp * 1000).toISOString().slice(0, 10);
  const canonicalHeaders = `content-type:application/json; charset=utf-8\nhost:${input.host}\n`;
  const signedHeaders = 'content-type;host';
  const canonicalRequest = [
    'POST',
    '/',
    '',
    canonicalHeaders,
    signedHeaders,
    CryptoJS.SHA256(input.payload).toString(),
  ].join('\n');
  const credentialScope = `${date}/${service}/tc3_request`;
  const stringToSign = [
    algorithm,
    input.timestamp.toString(),
    credentialScope,
    CryptoJS.SHA256(canonicalRequest).toString(),
  ].join('\n');
  const secretDate = CryptoJS.HmacSHA256(date, `TC3${input.secretKey}`);
  const secretService = CryptoJS.HmacSHA256(service, secretDate);
  const secretSigning = CryptoJS.HmacSHA256('tc3_request', secretService);
  const signature = CryptoJS.HmacSHA256(stringToSign, secretSigning).toString(CryptoJS.enc.Hex);

  return `${algorithm} Credential=${input.secretId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
}

function normalizeTencentLanguageCode(language: string) {
  const normalized = language.trim().toLowerCase().replace('_', '-');
  const aliases: Record<string, string> = {
    'zh-cn': 'zh',
    'zh-hans': 'zh',
    'zh-tw': 'zh-TW',
    'zh-hant': 'zh-TW',
    en: 'en',
    'en-us': 'en',
    'en-gb': 'en',
    ja: 'ja',
    jp: 'ja',
    ko: 'ko',
    kor: 'ko',
  };

  return aliases[normalized] ?? normalized;
}
