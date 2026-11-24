# AI 보훈이 — 시나리오 1 음성 안내 프로토타입 (LLM 에이전트)

보훈병원 **진료·검사 예약 사전 안내 해피콜**(시나리오 1)을 브라우저에서 실제 음성 대화로 시연하는 프로토타입입니다.
AI 보훈이가 환자에게 "전화"를 걸어 한국어로 안내하고, 환자의 말을 듣고, 명세서(`docs/시나리오명세서.md`)의 목표대로 대화를 진행합니다.
결과는 오른쪽 **관제 대시보드**에 실시간으로 표시됩니다.

> 아키텍처: **STT → LLM(tool calling) → TTS**. 대사 스크립트는 없습니다. LLM 에는 "무엇을, 어떤 태도로" 말할지만 지시하고,
> 예약 조회·내원 확정·콜백 등록 같은 **행동은 tool 로**, 그 **검증은 서버 코드**가 합니다.
> (이전 규칙·시나리오 엔진 버전은 `~/Desktop/AI-Bohuni-Prototype-v1-backup.tar.gz` 에 보관)

## 무엇을 하나요

| 명세서 목표 | 에이전트 동작 |
|---|---|
| 1-1 인사·본인 확인 | 자기소개 후 본인 여부 확인 → `verify_identity`. 보호자면 전달 동의 확인, 거절 시 `end_call(재통화 필요)` |
| 1-2 일정·장소 | `get_appointment` 로 DB 조회 후 날짜·시간·장소·"20분 전 도착" 안내 |
| 1-3 준비물·금식 | 신분증·진료카드, 검사가 있으면 금식 시각·방법 안내 후 이해 확인 (검사 없으면 금식 안내 생략) · "다시 말해 달라" → 핵심만 재안내 · 약 문의 → 의료 판단 없이 간호사 확인 안내 + `register_callback(yellow)` |
| 1-4 내원 여부 | 가능 → `confirm_attendance` + `end_call(내원 확정)` · 어려움 → 희망 일시 질문 → `request_reschedule` + `end_call(변경 요청 접수)` |
| Case C | 못 알아듣거나 무응답 → "잘 듣지 못했습니다" 후 재질문, 2회 연속이면 콜백 + `end_call(상담원 콜백)` (3회째엔 서버가 강제 종료) |
| 병원 이용 질문 | 주차·접수·휠체어 등 → `search_hospital_info`(FTS5) 결과로만 답변, 없으면 지어내지 않고 상담원 연결 + 🟡 |
| 위험 표현 | "가슴이 아파", "숨이 차", "쓰러" … → **규칙 안전망이 LLM 보다 먼저** 🔴 적색 콜백 등록 → 에이전트가 119 안내 후 `end_call(긴급 이관)` (안 하면 서버가 종료) |
| 통화 종료 시 | 환자(알림톡)·보호자(SMS) 요약 메시지 **발송 시뮬레이션** → DB 저장 + 대시보드 표시 |

음성 UX(명세서 0장): TTS **0.88배속**(Typecast), 날짜·시간·금식 시각 앞뒤 **0.5초 휴지기**(LLM 이 `[[ ]]` 로 표시, 빠뜨리면 서버가 자동 표시),
발화 종료 판정 **1.8초**(성인 기본 + 고령자 여유 0.8초), 무응답 판정 **8초**, 끼어들기(barge-in) 지원.

## 아키텍처

```
┌──────────────────────── Browser (React + Vite) ──────────────────────────┐
│  PhonePanel                                   Dashboard                  │
│  ├ STT: WebSpeechRecognizer                    ├ 통화 목록 / 상태 배지     │
│  │   (ko-KR, 커스텀 endpointing + 끼어들기)    ├ 🔴/🟡 콜백 리스트        │
│  ├ TTS: ServerSynthesizer → /api/tts           ├ 알림톡/SMS 로그          │
│  │   (실패 시 브라우저 TTS)                    └ 턴별 LLM 호출·지연·tool  │
│  └ 텍스트 입력 / 빠른 응답 칩 (마이크 대체)                                │
└──────────────┬────────────────────────────────────────▲──────────────────┘
               │ REST /api/calls, /turn, /tts           │ SSE /api/events
┌──────────────▼──────────────── NestJS ────────────────┴──────────────────┐
│ CallsService ─▶ AgentService (에이전트 루프)                               │
│                  ├ 0) 위험 키워드 안전망 (safety/risk.ts, LLM 이전)         │
│                  ├ 1) Claude — system 프롬프트 = 목표·말투·안전 규칙        │
│                  │       ⇄ tool_use / tool_result (턴당 최대 5회)          │
│                  ├ 2) tool 핸들러 (agent/tools.ts) — 가드·검증·DB 쓰기      │
│                  └ 3) 출력 → {환자명} 치환 + 휴지기 세그먼트 (speech.ts)    │
│ Prisma ─▶ SQLite (임베디드): Patient, Appointment, KnowledgeArticle         │
│                    + knowledge_fts(FTS5), Call(history·state), Turn,       │
│                    ToolCall, Callback, SmsLog                              │
│ TtsModule: Typecast ─▶ 디스크 캐시 ─▶ mp3        EventsModule: SSE          │
└──────────────────────────────────────────────────────────────────────────┘
```

### Tool

| Tool | 하는 일 | 서버 가드 |
|---|---|---|
| `verify_identity(respondent, guardian_consent)` | 본인/보호자·동의 기록 | — |
| `get_appointment()` | 예약 일시·장소·준비물·검사·금식 조회 | 본인 또는 동의한 보호자 확인 전엔 거부 |
| `search_hospital_info(query)` | 병원 안내 FTS5 검색 | 결과 없으면 `found:false` (지어내기 방지) |
| `register_callback(level, reason)` | 🔴/🟡 콜백 등록 | 같은 사유 중복 방지 |
| `confirm_attendance()` | 내원 확정 | 예약 안내 전엔 거부 |
| `request_reschedule(desired_slot, cancel)` | 변경·취소 요청 접수 | 희망 일시 비면 거부 |
| `end_call(status)` | 통화 종료 + 요약 문자 | 처리 안 된 결과로 종료 불가 (예: 확정 없이 `내원 확정`) |

가드를 위반하면 `is_error` tool_result 가 LLM 에 돌아가고, LLM 이 대화로 바로잡습니다.

### 주요 파일
- `server/src/agent/prompt.ts` — 시스템 프롬프트 (말투·대화 목표·안전 규칙). 고정 규칙 블록은 프롬프트 캐시 대상.
- `server/src/agent/agent.service.ts` — 에이전트 루프, 안전망·백스톱(위험 후 미종료, 무응답 3회, LLM 실패), append-only 대화 기록.
- `server/src/agent/tools.ts` — tool 정의 + 핸들러 + 가드.
- `server/src/agent/speech.ts` — `{환자명}` 토큰 치환(LLM 에 실명 미전송), 핵심 숫자 휴지기 세그먼트.
- `server/src/safety/risk.ts` — 위험 키워드 안전망.
- `server/prisma/schema.prisma`, `seed.ts`, `faq-data.ts` (**데모용 예시 안내 자료 — 실제 병원 정보 아님**).
- `server/eval/run-eval.ts` — 실제 Claude 로 명세서 분기 10건 평가.
- `web/src/voice/` — STT/TTS 인터페이스, Web Speech 구현, 서버 TTS, 끼어들기 판정.

### REST API

| Method | Path | 설명 |
|---|---|---|
| POST | `/api/calls` `{patientId}` | 발신 (에이전트 첫 인사 반환) |
| POST | `/api/calls/:id/turn` `{text, bargeIn?}` 또는 `{noInput:true}` | 환자 발화 1턴 → 에이전트 응답 + tool 호출 내역 |
| POST | `/api/calls/:id/hangup` | 통화 중단 |
| GET | `/api/calls`, `/api/calls/:id` | 통화 목록 / 상세(턴·tool 호출·콜백·SMS) |
| GET / PATCH | `/api/callbacks`, `/api/callbacks/:id` | 콜백 리스트 / 처리 완료 |
| POST | `/api/tts` `{text}` | 문장 → mp3 (서버 TTS, 캐시) |
| GET | `/api/patients`, `/api/sms`, `/api/config` | 환자·예약, 발송 기록, 에이전트·TTS 설정 |
| GET | `/api/events` | SSE 실시간 이벤트 |

## 기술 선택 이유

| 선택 | 이유 |
|---|---|
| **LLM 에이전트 + tool calling** | 고령 환자의 자유로운 말(질문·사정·맞장구)에 사람처럼 대응. 대사 스크립트 대신 목표·규칙만 주고, 사실은 tool(DB)에서만 가져오며, 상태 변경은 tool 로만 → "대화는 유연, 행동은 통제" |
| **서버 측 가드** | LLM 이 잘못된 순서로 tool 을 불러도 서버가 거부 (본인 확인 전 예약 비공개, 처리 없는 종료 불가). 안전 규칙을 프롬프트에만 의존하지 않음 |
| **위험 키워드 안전망 (규칙)** | 응급 신호 감지는 LLM 지연·오류와 무관해야 함 → LLM 호출 전에 🔴 등록, 미종료 시 서버가 긴급 이관 |
| **Claude Haiku 5.5 · effort low** | 전화 대화는 지연이 핵심. 평가에서 10/10 통과, 턴 지연 p50 ≈ 1.9s. 수동 에이전트 루프로 tool 실행·로그·타임아웃을 직접 제어 |
| **임베디드 DB (SQLite + FTS5)** | 설치 없이 한 파일. 예약·대화 기록·tool 로그·안내 자료 검색(FTS5 전문 검색, 접두어 검색으로 한국어 조사 대응)까지 외부 서비스 없이 처리 |
| **개인정보 최소화** | LLM 에는 환자 이름 대신 `{환자명}` 토큰, 예약 정보는 본인 확인 후 tool 로만 |
| **NestJS + React (TypeScript)** | 모듈(agent·calls·events·tts·safety) 경계가 명확, DI 로 LLM 을 가짜로 바꿔 테스트 |
| **Typecast TTS / Web Speech STT** | 국내 TTS 의 자연스러운 한국어 음성(무료 플랜, “Voice by Typecast” 표기, 디스크 캐시). STT 는 키 없이 브라우저에서 바로 시연, 인터페이스 뒤라 CLOVA 등으로 교체 가능 |
| **SSE** | 대시보드는 서버→클라이언트 단방향이면 충분 |
| **평가(eval)** | LLM 주도 대화는 단위 테스트만으로 부족 → 실제 모델로 명세서 분기 10건을 상태·tool·발화 기준으로 채점 |

## 실행 방법

요구 사항: Node.js 20+ (22 권장), **Chrome** (음성 인식), **Claude API 키**

```bash
npm install
cp server/.env.example server/.env   # ANTHROPIC_API_KEY (필수), TYPECAST_API_KEY (선택) 입력
npm run dev
```

- 웹: http://localhost:5173 · API: http://localhost:3001/api
- `npm run dev` 가 DB 스키마 반영 + 시드(환자 3명·예약, 예약일은 항상 **내일**, 안내 자료 + FTS5 인덱스) 후 서버·웹을 함께 띄웁니다.
- 테스트: `npm test` (가짜 LLM — API 호출·비용 없음)
- 실제 LLM 평가: `npm run eval -w server` (별도 `prisma/eval.db`, 오전 11시 기준 시각, 통화당 수 센트 미만). `EVAL_VERBOSE=1` 이면 대화 전문 출력
- DB 초기화: `npm run db:reset -w server`
- DB 보기: `npm run db:studio -w server` → http://localhost:5555 (Prisma Studio, 데모 DB = `server/prisma/dev.db`)

시드 환자: **홍길동**(채혈·복부 초음파, 밤 10시 금식, 보호자 아들) · **김영수**(검사 없음) · **박순자**(위 내시경, 밤 9시 금식)

## 시연 스크립트 (약 3분)

1. **소개 (20초)** — "대사 스크립트 없이, 명세서 목표와 안전 규칙만 받은 LLM 에이전트가 tool 로 DB 를 조회하며 통화합니다."
2. **정상 흐름 (60초)** — 홍길동 **발신** → "네, 맞아요" → 오른쪽 통화 기록에서 `verify_identity`·`get_appointment` tool 호출 확인 → 금식 안내 → "네, 갈게요" → **내원 확정** + 알림톡/SMS
3. **자유 질문·약 문의 (40초)** — "주차는 돼요?" → `search_hospital_info` 결과로 답한 뒤 본래 안내로 복귀 · "혈압약은 먹어도 되나요?" → 의료 판단 없이 간호사 확인 안내 + 🟡
4. **변경 요청 (30초)** — "그날은 못 가요" → "다음 주 화요일 오전이요" → `request_reschedule` → **변경 요청 접수**
5. **안전장치 (30초)** — "가슴이 너무 아파요" → 🔴 즉시 등록 → **긴급 이관**. (이어폰 착용 시) AI 가 말하는 도중 "뭐라고요?" → 끼어들기
6. **기술 포인트 (20초)** — 턴마다 `LLM ×N · 지연 · 🔧tool` 배지, 거부된 tool(✗), `npm run eval` 10/10 결과

> 마이크가 안 될 때: 입력창이나 빠른 응답 칩으로 같은 흐름을 진행할 수 있습니다.

## 검증 범위

- 자동 테스트: server 17개 (가짜 LLM — 루프·tool 가드·보호자 거절·FTS5 검색·위험 안전망·LLM 실패 폴백·무응답 백스톱·루프 상한·이름 토큰·휴지기, REST e2e) + web 13개 (끼어들기 판정)
- 실제 Claude 평가: 명세서 분기 10건 **10/10 통과** (Haiku 5.5 · low, 턴 지연 p50 1.9s · p90 2.6s)
- 브라우저에서 텍스트 입력으로 전체 흐름 확인 (tool 칩·대시보드 tool 타임라인 표시)
- **미검증**: 실제 마이크 인식 품질·스피커 에코 환경의 끼어들기, Typecast 음성 품질 (Chrome 에서 직접 확인 필요)
- **유의**: 대사가 명세서 문구와 글자 그대로 같지는 않습니다 (내용·순서·안전 규칙은 평가로 확인). 안내 자료(주차 등)는 데모용 예시입니다.

## 다음 단계

- **실시간 음성 인프라**: LiveKit(WebRTC AEC·Silero VAD·turn detection) 위로 이전 → 스피커 에코·턴테이킹 개선, 같은 에이전트를 SIP 전화망에 연결
- **지연 단축**: 첫 문장 스트리밍 → 즉시 TTS, 프롬프트 캐시 효과 측정, tool 병렬 호출 유도
- **STT 교체**: CLOVA Speech(스트리밍)/CSR(키 발급·동작 확인 완료), 고령자·사투리 음성 평가셋
- **평가 확장**: 사용자 시뮬레이터(LLM 환자)로 대화 다양화, 사투리·STT 오류 케이스, 위험 표현 재현율 별도 측정
- **시나리오 2·3**: 산불 대피·퇴원 관리 — 프롬프트 목표 + tool 세트만 추가
- **운영**: 실제 알림톡 발송, 상담원 콜백 큐·SLA, 통화 녹취 정책, 개인정보 마스킹 강화, 국내 리전/모델 검토
