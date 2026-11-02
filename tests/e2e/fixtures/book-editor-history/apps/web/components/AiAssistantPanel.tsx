"use client";
export default function AiAssistantPanel({ onDecisionBusy }: { onDecisionBusy: (value: boolean) => void }) {
  return <button type="button" onClick={() => { onDecisionBusy(true); (window as any).__afterAiDecision?.(); }}>Start synthetic AI decision</button>;
}
