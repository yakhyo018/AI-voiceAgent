/**
 * 병원 안내 지식 — ⚠️ 데모용 예시 데이터 (실제 대구보훈병원 정보가 아님)
 * 실제 운영 시 병원이 제공한 공식 안내문으로 교체해야 합니다.
 * seed 에서 KnowledgeArticle 테이블 + FTS5 검색 인덱스로 적재되고,
 * LLM 은 search_hospital_info tool 로만 조회합니다.
 */
export interface KnowledgeSeed {
  id: string;
  topic: string;
  content: string;
  /** 검색 보조 키워드 (공백 구분) */
  tags: string;
}

export const KNOWLEDGE: KnowledgeSeed[] = [
  {
    id: 'parking',
    topic: '주차',
    content: '본관 앞 주차장을 이용하실 수 있고, 보훈 대상자는 주차 요금이 감면됩니다.',
    tags: '주차 주차장 차 자가용 운전 요금',
  },
  {
    id: 'reception',
    topic: '접수 위치·절차',
    content: '본관 1층 접수처에서 신분증과 진료카드를 보여 주시면 접수가 됩니다. 예약 시간 20분 전까지 도착해 주세요.',
    tags: '접수 접수처 원무과 창구 도착 어디 1층',
  },
  {
    id: 'wheelchair',
    topic: '휠체어·거동 불편',
    content: '본관 1층 안내데스크에서 휠체어를 빌리실 수 있고, 필요하시면 직원이 이동을 도와드립니다.',
    tags: '휠체어 거동 다리 무릎 걷기 계단 지팡이 부축 불편',
  },
  {
    id: 'guardian',
    topic: '보호자 동반',
    content: '보호자분과 함께 오셔도 괜찮습니다. 함께 오시면 진료 설명을 같이 들으실 수 있습니다.',
    tags: '보호자 가족 동반 같이 아들 딸',
  },
  {
    id: 'transport',
    topic: '교통·셔틀',
    content: '가까운 지하철역과 병원 사이에 셔틀버스가 운행됩니다. 자세한 운행 시간은 안내 문자로 보내드립니다.',
    tags: '셔틀 버스 지하철 택시 교통 오는길',
  },
  {
    id: 'late',
    topic: '지각',
    content: '조금 늦으실 것 같으면 도착하시는 대로 접수처에 말씀해 주세요. 많이 늦으시면 병원에서 순서를 다시 조정해 드립니다.',
    tags: '지각 늦음 늦게 늦을',
  },
  {
    id: 'cost',
    topic: '진료비',
    content: '국가유공자 진료비 감면이 적용되며, 정확한 금액은 진료 후 수납 창구에서 안내해 드립니다.',
    tags: '진료비 비용 돈 수납 감면 본인부담 얼마',
  },
  {
    id: 'documents',
    topic: '준비물',
    content: '신분증과 보훈병원 진료카드를 꼭 가져오세요. 드시는 약이 있으면 약 봉투도 함께 가져오시면 좋습니다.',
    tags: '준비물 신분증 진료카드 카드 챙길것 약봉투',
  },
];
