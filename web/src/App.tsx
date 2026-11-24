import { useEffect, useState } from 'react';
import { api, type Patient, type ServerConfig } from './api';
import { Dashboard } from './components/Dashboard';
import { PhonePanel } from './components/PhonePanel';
import { useCallSession } from './useCallSession';

export default function App() {
  const [patients, setPatients] = useState<Patient[]>([]);
  const [config, setConfig] = useState<ServerConfig | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const session = useCallSession();
  const { setServerTtsLabel } = session;

  // npm run dev 직후에는 웹(Vite)이 서버(Nest)보다 먼저 뜨므로, 서버가 준비될 때까지 재시도
  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;
    const load = async (attempt: number) => {
      try {
        const [p, c] = await Promise.all([api.patients(), api.config()]);
        if (cancelled) return;
        setPatients(p);
        setConfig(c);
        setLoadError(null);
        setServerTtsLabel(c.tts?.voice ?? null);
      } catch (e) {
        if (cancelled) return;
        setLoadError(
          attempt < 20
            ? `서버 연결 중… (${attempt + 1}회차 재시도)`
            : `서버 연결 실패: ${(e as Error).message} — server 가 실행 중인지 확인하세요`,
        );
        if (attempt < 20) timer = window.setTimeout(() => void load(attempt + 1), 1500);
      }
    };
    void load(0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [setServerTtsLabel]);

  return (
    <div className="app">
      <header className="top">
        <div className="brand">
          <span className="logo" aria-hidden="true">보</span>
          <div>
            <h1>AI 보훈이 · 관제 대시보드</h1>
            <p>시나리오 1 · 진료 및 검사 예약 사전 안내 (해피콜)</p>
          </div>
        </div>
        {config && (
          <div className={`engine ${config.llmEnabled ? 'on' : ''}`} title="대화 엔진">
            {config.llmEnabled ? `LLM 에이전트: ${config.model} · effort ${config.effort} · tool calling` : 'LLM 키 없음 — 응답 불가 (server/.env 확인)'}
          </div>
        )}
      </header>
      {loadError && <div className="error banner">{loadError}</div>}
      <main className="layout">
        <PhonePanel patients={patients} s={session} />
        <Dashboard activeCallId={session.call?.id ?? null} />
      </main>
    </div>
  );
}
