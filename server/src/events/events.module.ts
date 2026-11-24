/**
 * 관제 대시보드용 실시간 이벤트 (Server-Sent Events)
 * GET /api/events → call.updated | turn.created | callback.created | sms.created
 */
import { BeforeApplicationShutdown, Controller, Injectable, Logger, MessageEvent, Module, Sse } from '@nestjs/common';
import { Observable, Subject, interval, map, merge, takeUntil } from 'rxjs';

export type DashboardEventType = 'call.updated' | 'turn.created' | 'callback.created' | 'sms.created';

export interface DashboardEvent {
  type: DashboardEventType;
  callId: string;
  payload?: unknown;
}

@Injectable()
export class EventsService implements BeforeApplicationShutdown {
  private readonly logger = new Logger('Events');
  private readonly subject = new Subject<DashboardEvent>();
  /** 종료 시 열린 SSE 스트림을 모두 끝내야 HTTP 서버가 닫힘 (watch 재시작이 멈추지 않도록) */
  readonly shutdown$ = new Subject<void>();

  beforeApplicationShutdown() {
    this.shutdown$.next();
    this.shutdown$.complete();
  }

  emit(event: DashboardEvent) {
    this.logger.debug(`${event.type} ${event.callId}`);
    this.subject.next(event);
  }

  stream(): Observable<DashboardEvent> {
    return this.subject.asObservable();
  }
}

@Controller('events')
export class EventsController {
  constructor(private readonly events: EventsService) {}

  @Sse()
  sse(): Observable<MessageEvent> {
    const data = this.events.stream().pipe(map((e) => ({ type: e.type, data: e }) as MessageEvent));
    // 프록시/브라우저 연결 유지를 위한 15초 하트비트
    const ping = interval(15_000).pipe(map(() => ({ type: 'ping', data: { t: Date.now() } }) as MessageEvent));
    return merge(data, ping).pipe(takeUntil(this.events.shutdown$));
  }
}

@Module({ providers: [EventsService], controllers: [EventsController], exports: [EventsService] })
export class EventsModule {}
