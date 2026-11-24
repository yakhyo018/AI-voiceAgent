import { BadRequestException, Body, Controller, Get, Param, ParseIntPipe, Patch, Post } from '@nestjs/common';
import { TtsService } from '../tts/tts.service';
import { CallsService } from './calls.service';

@Controller()
export class CallsController {
  constructor(
    private readonly calls: CallsService,
    private readonly tts: TtsService,
  ) {}

  /** 데모 설정 정보 (LLM 에이전트·TTS) */
  @Get('config')
  config() {
    return {
      architecture: 'llm-agent',
      llmEnabled: this.calls.model !== 'none',
      model: this.calls.model,
      effort: process.env.LLM_EFFORT || 'low',
      tts: this.tts.info,
      scenario: 'scenario1',
    };
  }

  @Get('patients')
  patients() {
    return this.calls.listPatients();
  }

  /** 발신: 시드 환자에게 통화 시작 */
  @Post('calls')
  start(@Body() body: { patientId?: number }) {
    const id = Number(body?.patientId);
    if (!Number.isInteger(id)) throw new BadRequestException('patientId 가 필요합니다');
    return this.calls.startCall(id);
  }

  @Get('calls')
  list() {
    return this.calls.listCalls();
  }

  @Get('calls/:id')
  get(@Param('id') id: string) {
    return this.calls.getCall(id);
  }

  /** 환자 발화 1턴: { text } 또는 { noInput: true } */
  @Post('calls/:id/turn')
  turn(@Param('id') id: string, @Body() body: { text?: string; noInput?: boolean; bargeIn?: boolean }) {
    return this.calls.turn(id, { text: body?.text, noInput: body?.noInput === true, bargeIn: body?.bargeIn === true });
  }

  @Post('calls/:id/hangup')
  hangup(@Param('id') id: string) {
    return this.calls.hangup(id);
  }

  @Get('callbacks')
  callbacks() {
    return this.calls.listCallbacks();
  }

  @Patch('callbacks/:id')
  updateCallback(@Param('id', ParseIntPipe) id: number, @Body() body: { status?: string }) {
    return this.calls.updateCallback(id, body?.status || '처리 완료');
  }

  @Get('sms')
  sms() {
    return this.calls.listSms();
  }
}
