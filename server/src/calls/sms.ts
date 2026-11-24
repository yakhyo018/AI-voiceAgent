/**
 * 통화 종료 직후 핵심 요약 알림톡/SMS (시뮬레이션)
 * 명세서 0-3: "통화 종료 직후 환자 본인 및 등록된 보호자에게 핵심 요약 알림톡/SMS 자동 발송"
 * 실제 발송 대신 DB(SmsLog)에 저장하고 대시보드에 표시합니다.
 */
import { koreanDateTime } from '../common/korean-time';
import { CallStatus } from '../agent/agent.types';

export interface SmsPatient {
  name: string;
  phone: string;
  hospital: string;
  appointmentAt: Date;
  location: string;
  exams?: string | null;
  fastingStart?: string | null;
  guardianName?: string | null;
  guardianRelation?: string | null;
  guardianPhone?: string | null;
}

export interface SmsMessage {
  recipientType: 'patient' | 'guardian';
  recipientName: string;
  phone: string;
  channel: '알림톡' | 'SMS';
  body: string;
}

function summary(p: SmsPatient, status: CallStatus, slot: string | null): string {
  const when = koreanDateTime(p.appointmentAt);
  const appt = `예약: ${when} / ${p.location}`;
  const prep = `준비물: 신분증, 보훈병원 진료카드${
    p.exams ? `\n금식: 검사 전날 ${p.fastingStart} 이후 물·커피·껌 포함 금식 (${p.exams})` : ''
  }`;
  switch (status) {
    case '내원 확정':
      return `내원이 확인되었습니다.\n${appt}\n예약 20분 전까지 접수처에 도착해 주세요.\n${prep}`;
    case '변경 요청 접수':
      return slot === '예약 취소'
        ? `예약 취소 요청이 접수되었습니다.\n기존 ${appt}\n담당 직원 확인 후 안내 문자를 드리겠습니다.`
        : `일정 변경 요청이 접수되었습니다. (희망: ${slot})\n기존 ${appt}\n담당 직원 확인 후 확정 문자를 드리겠습니다.`;
    case '재통화 필요':
      return `진료 일정 안내 전화를 드렸으나 안내를 마치지 못했습니다. 다시 연락드리겠습니다.\n${appt}`;
    case '상담원 콜백':
      return `안내 통화 중 음성 확인이 어려워 병원 상담원이 곧 다시 연락드리겠습니다.\n${appt}\n${prep}`;
    case '긴급 이관':
      return `통화 중 건강 이상 호소가 확인되어 담당 간호사·관제센터에 긴급 전달했습니다. 위급 시 즉시 119에 연락해 주세요.\n${appt}`;
    default:
      return `안내 통화가 종료되었습니다.\n${appt}`;
  }
}

export function buildSummaryMessages(p: SmsPatient, status: CallStatus, slot: string | null): SmsMessage[] {
  const body = summary(p, status, slot);
  const msgs: SmsMessage[] = [
    {
      recipientType: 'patient',
      recipientName: p.name,
      phone: p.phone,
      channel: '알림톡',
      body: `[${p.hospital}] ${p.name}님, AI 보훈이 안내 통화 요약입니다.\n${body}`,
    },
  ];
  if (p.guardianPhone) {
    msgs.push({
      recipientType: 'guardian',
      recipientName: `${p.guardianName ?? '보호자'}${p.guardianRelation ? ` (${p.guardianRelation})` : ''}`,
      phone: p.guardianPhone,
      channel: 'SMS',
      body: `[${p.hospital}] ${p.name} 환자 보호자님께 안내드립니다.\n${body}`,
    });
  }
  return msgs;
}
