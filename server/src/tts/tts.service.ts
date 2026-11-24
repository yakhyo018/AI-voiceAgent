/**
 * 서버 측 TTS (Typecast)
 *  - 키는 서버에만 보관, 브라우저는 /api/tts 로 오디오만 받음
 *  - 디스크 캐시: 같은 문장(고정 안내 문구 등)은 재합성하지 않아 크레딧 절약 + 즉시 재생
 *  - 동시 요청 제한(Free 플랜 concurrency 2)
 *  - 실패 시 호출 측(브라우저)이 Web Speech 로 폴백
 */
import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

export interface TtsAudio {
  audio: Buffer;
  contentType: string;
  cached: boolean;
}

export interface TtsProvider {
  readonly name: string;
  readonly voiceLabel: string;
  /** 캐시 키에 들어갈 설정 (보이스·속도 등) */
  readonly cacheTag: string;
  synthesize(text: string): Promise<{ audio: Buffer; contentType: string }>;
}

export class TypecastProvider implements TtsProvider {
  readonly name = 'typecast';

  constructor(
    private readonly apiKey: string,
    private readonly voiceId: string,
    private readonly voiceName: string,
    private readonly tempo: number,
    private readonly timeoutMs: number,
  ) {}

  get voiceLabel() {
    return `Typecast · ${this.voiceName}`;
  }

  get cacheTag() {
    return `typecast:${this.voiceId}:${this.tempo}`;
  }

  async synthesize(text: string) {
    const res = await fetch('https://api.typecast.ai/v1/text-to-speech', {
      method: 'POST',
      headers: { 'X-API-KEY': this.apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        voice_id: this.voiceId,
        text,
        model: 'ssfm-v31',
        language: 'kor',
        prompt: { emotion_type: 'preset', emotion_preset: 'normal' },
        output: { audio_tempo: this.tempo, audio_format: 'mp3' },
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) {
      const body = (await res.text()).slice(0, 200);
      throw new Error(`Typecast ${res.status}: ${body}`);
    }
    return { audio: Buffer.from(await res.arrayBuffer()), contentType: res.headers.get('content-type') || 'audio/mpeg' };
  }
}

@Injectable()
export class TtsService {
  private readonly logger = new Logger('TTS');
  private readonly provider: TtsProvider | null;
  private readonly cacheDir = path.join(process.cwd(), '.tts-cache');
  private readonly maxConcurrent = Number(process.env.TTS_CONCURRENCY) || 2;
  private active = 0;
  private readonly waiters: (() => void)[] = [];
  private charsUsed = 0;

  constructor() {
    const key = process.env.TYPECAST_API_KEY?.trim();
    this.provider = key
      ? new TypecastProvider(
          key,
          process.env.TYPECAST_VOICE_ID || 'tc_6a21054564d676539427427e',
          process.env.TYPECAST_VOICE_NAME || '혜진',
          Number(process.env.TTS_TEMPO) || 0.88,
          Number(process.env.TTS_TIMEOUT_MS) || 8000,
        )
      : null;
    if (this.provider) fs.mkdirSync(this.cacheDir, { recursive: true });
    this.logger.log(this.provider ? `서버 TTS: ${this.provider.voiceLabel}` : '서버 TTS 없음 → 브라우저 TTS 사용');
  }

  get info() {
    return this.provider
      ? { provider: this.provider.name, voice: this.provider.voiceLabel, attribution: 'Voice by Typecast' }
      : { provider: null, voice: null, attribution: null };
  }

  async synthesize(rawText: string): Promise<TtsAudio> {
    if (!this.provider) throw new Error('TTS provider not configured');
    const text = rawText.trim();
    const key = createHash('sha1').update(`${this.provider.cacheTag}|${text}`).digest('hex');
    const file = path.join(this.cacheDir, `${key}.mp3`);
    if (fs.existsSync(file)) return { audio: await fs.promises.readFile(file), contentType: 'audio/mpeg', cached: true };

    await this.acquire();
    const t0 = Date.now();
    try {
      const { audio, contentType } = await this.provider.synthesize(text);
      await fs.promises.writeFile(file, audio);
      this.charsUsed += text.length;
      this.logger.log(`합성 ${text.length}자 in ${Date.now() - t0}ms (이번 실행 누적 ${this.charsUsed}자)`);
      return { audio, contentType, cached: false };
    } catch (err) {
      this.logger.warn(`합성 실패 (${Date.now() - t0}ms): ${(err as Error).message}`);
      throw err;
    } finally {
      this.release();
    }
  }

  private async acquire() {
    if (this.active < this.maxConcurrent) {
      this.active++;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
    this.active++;
  }

  private release() {
    this.active--;
    this.waiters.shift()?.();
  }
}
