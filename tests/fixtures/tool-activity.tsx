import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ThreadAssistantBubble } from '../../src/components/chat-thread';
import { groupWebResearchMessages } from '../../src/components/web-research-activity';
import type { ThreadMessage, ThreadToolCall } from '../../src/store/thread-store';
import '../../src/index.css';

document.documentElement.dataset.theme = new URLSearchParams(location.search).get('theme') || 'light';
// Explicit fixture data; this page does not fetch weather or call a provider.
function Fixture() {
  const [state, setState] = useState<'running' | 'complete' | 'error'>('complete');
  const names = ['web_search','web_fetch','web_fetch','web_fetch','web_search','web_fetch','web_search','web_search'];
  const messages: ThreadMessage[] = names.map((name, i) => ({
    id: `segment-${i}`, role: 'assistant', text: '', files: [], timestamp: 1000,
    status: i === 7 && state === 'running' ? 'streaming' : 'complete',
    toolCalls: [{ id: `tool-${i}`, name, status: i === 7 ? state : 'complete', retryCount: 0,
      args: name === 'web_search' ? {query: i > 3 ? 'Beijing current weather observations' : 'Saratoga heat advisory September'}
        : {url: i < 3 ? 'https://weather.gov/mtr' : 'https://forecast.weather.gov/MapClick.php?token=synthetic-private'},
      progress: [{message: state === 'error' && i === 7 ? 'The source did not respond. Other results are still available.' : 'Received source response', ts: i}],
    } as ThreadToolCall],
  }));
  return <main className="mx-auto min-h-screen max-w-3xl px-4 py-8 text-text">
    <p className="mb-2 text-xs text-muted">Tool activity review · synthetic fixture</p>
    <div className="mb-8 flex flex-wrap gap-2">{(['complete','running','error'] as const).map(value =>
      <button key={value} className="rounded-lg border border-border px-3 py-1.5 text-xs" onClick={() => setState(value)}>Show {value}</button>)}</div>
    <div className="mb-6 flex justify-end"><p className="rounded-xl bg-surface-container px-4 py-3">北京呢</p></div>
    {groupWebResearchMessages(messages).map(message => <ThreadAssistantBubble key={message.id} message={message}
      isStreaming={state === 'running'} showLiveIndicators={state === 'running'} threadId="fixture-turn" />)}
    <div className="mt-6 px-6 text-sm leading-7">短追问直接补充北京的情况，保留相关来源和观测时间；无需重复完整天气表格或引入无关城市。</div>
  </main>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
