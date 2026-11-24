import { BadRequestException, Body, Controller, HttpException, HttpStatus, Module, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import { TtsService } from './tts.service';

@Controller('tts')
export class TtsController {
  constructor(private readonly tts: TtsService) {}

  /** 안내 문장 → 오디오(mp3). 실패 시 502 → 브라우저가 Web Speech 로 폴백 */
  @Post()
  async synthesize(@Body() body: { text?: string }, @Res() res: Response) {
    const text = body?.text?.trim();
    if (!text || text.length > 500) throw new BadRequestException('text 는 1~500자');
    if (!this.tts.info.provider) throw new HttpException('서버 TTS 미설정', HttpStatus.SERVICE_UNAVAILABLE);
    try {
      const r = await this.tts.synthesize(text);
      res.status(200);
      res.setHeader('Content-Type', r.contentType);
      res.setHeader('X-TTS-Cache', r.cached ? 'hit' : 'miss');
      res.setHeader('Cache-Control', 'private, max-age=86400');
      res.send(r.audio);
    } catch (err) {
      throw new HttpException(`TTS 실패: ${(err as Error).message}`, HttpStatus.BAD_GATEWAY);
    }
  }
}

@Module({ providers: [TtsService], controllers: [TtsController], exports: [TtsService] })
export class TtsModule {}
