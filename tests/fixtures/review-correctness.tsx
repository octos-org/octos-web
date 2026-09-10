import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { SitePreview } from '../../src/sites/components/site-preview';
import SlidePreview from '../../src/slides/components/slide-preview';
import { AuthProvider, useAuth } from '../../src/auth/auth-context';
import { request, setToken } from '../../src/api/client';
import { useVoiceCapture } from '../../src/home/voice/use-voice-capture';

function AuthProbe() {
  const auth = useAuth();
  return <><pre data-testid="identity">{JSON.stringify({ user: auth.user?.id, token: auth.token, loading: auth.loading })}</pre><button onClick={() => void request('/api/my/profile')}>Read profile</button><button onClick={() => setToken('review-account-b')}>Switch account</button></>;
}
function VoiceProbe() {
  const capture = useVoiceCapture();
  return <><button onClick={() => void capture.start(() => {})}>Start capture</button><pre data-testid="capture-error">{capture.error}</pre><span data-testid="capturing">{String(capture.capturing)}</span></>;
}
const mode = new URLSearchParams(location.search).get('mode');
const content = mode === 'site'
  ? <SitePreview previewUrl="/api/preview/review-profile/site-review/demo/index.html" siteName="Review demo" template="react" profileId="review-profile" sessionId="site-review" slug="demo" />
  : mode === 'download'
    ? <SlidePreview slides={[]} currentIndex={0} onIndexChange={() => {}} pptxUrl="/api/files/pf%2Freview%2Fdeck.pptx" />
    : mode === 'voice'
      ? <VoiceProbe />
      : mode === 'redirect'
        ? <button onClick={() => void request('/api/auth/me').catch(() => {})}>Probe expired token</button>
        : <MemoryRouter><AuthProvider><AuthProbe /></AuthProvider></MemoryRouter>;
createRoot(document.getElementById('root')!).render(content);
