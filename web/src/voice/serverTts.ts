/**
 * 서버 TTS 구현 (Typecast 등) — /api/tts 에서 mp3 를 받아 재생
 *  - 세그먼트 단위로 합성 → [[핵심 숫자]] 앞뒤 0.5초 휴지기 유지
 *  - 첫 세그먼트를 재생하는 동안 다음 세그먼트를 미리 요청 (지연 최소화)
 *  - 합성 실패 시 해당 세그먼트는 브라우저 TTS(fallback)로 읽음 → 통화가 끊기지 않음
 */
import type { SpeechSegment, SpeechSynthesizer } from './types';

const sleep = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms));

export class ServerSynthesizer implements SpeechSynthesizer {
  readonly name = 'Server TTS (/api/tts)';
  readonly supported = typeof window !== 'undefined' && typeof Audio !== 'undefined';
  private generation = 0;
  private current: HTMLAudioElement | null = null;
  private urls = new Map<string, Promise<string | null>>();

  constructor(
    private readonly label: string,
    private readonly fallback: SpeechSynthesizer,
  ) {}

  voiceName() {
    return this.label;
  }

  /** 오디오 URL 캐시 (같은 문장은 한 번만 요청) */
  private fetchUrl(text: string): Promise<string | null> {
    let p = this.urls.get(text);
    if (!p) {
      p = fetch('/api/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      })
        .then(async (r) => (r.ok ? URL.createObjectURL(await r.blob()) : null))
        .catch(() => null);
      this.urls.set(text, p);
      // 실패한 요청은 캐시하지 않음 (다음 통화에서 재시도)
      void p.then((u) => u === null && this.urls.delete(text));
    }
    return p;
  }

  async speak(segments: SpeechSegment[], opts: { rate: number; onSegment?: (s: SpeechSegment) => void }) {
    this.cancel();
    const gen = ++this.generation;
    // 미리 요청: 서버가 동시 2건으로 순서대로 처리
    const pending = segments.map((s) => this.fetchUrl(s.text));

    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      if (gen !== this.generation) return;
      if (seg.pauseBeforeMs) await sleep(seg.pauseBeforeMs);
      const url = await pending[i];
      if (gen !== this.generation) return;
      opts.onSegment?.(seg);
      const played = url ? await this.play(url, gen) : false;
      if (!played && gen === this.generation)
        await this.fallback.speak([{ ...seg, pauseBeforeMs: 0, pauseAfterMs: 0 }], { rate: opts.rate });
      if (seg.pauseAfterMs) await sleep(seg.pauseAfterMs);
    }
  }

  cancel() {
    this.generation++;
    if (this.current) {
      this.current.pause();
      this.current = null;
    }
    this.fallback.cancel();
  }

  /** 재생 성공 여부 반환 (자동재생 차단·디코딩 오류 시 false → 브라우저 TTS 폴백) */
  private play(url: string, gen: number) {
    return new Promise<boolean>((resolve) => {
      if (gen !== this.generation) return resolve(true);
      const a = new Audio(url);
      this.current = a;
      const finish = (ok: boolean) => {
        window.clearTimeout(guard);
        if (this.current === a) this.current = null;
        resolve(ok);
      };
      const done = () => finish(true);
      // 재생 이벤트가 오지 않는 환경 대비 안전 타임아웃
      const guard = window.setTimeout(done, 30_000);
      a.onended = done;
      a.onerror = () => finish(false);
      a.onpause = done; // cancel() 시
      a.play().catch(() => finish(false));
    });
  }
}
