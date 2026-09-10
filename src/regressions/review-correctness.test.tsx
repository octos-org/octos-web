// Regression cases reproduced against the reviewed baseline cd5824b.
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';
import { clearToken, getToken, setToken } from '@/api/client';
import { createSlidesProject, getAllSlidesProjects, getSlidesProject, upsertSlidesProject } from '@/slides/store';
import { createSiteProject, getAllSiteProjects } from '@/sites/store';
import { adoptLearningSession, listLearningSessions } from '@/learning/learning-session-store';
import { SlidesProvider, useSlides } from '@/slides/context/slides-context';
import { AuthProvider, useAuth } from '@/auth/auth-context';
import { useEvents, parseIcsEvents } from '@/home/use-events';
import * as FileStore from '@/store/file-store';

const mocks = vi.hoisted(() => ({
  getMyProfileStatus: vi.fn(), fetchSlidesManifest: vi.fn(), listSlidesFiles: vi.fn(),
  fetchSlideEdits: vi.fn(), saveSlideEdits: vi.fn(), slideEditsAreRendered: vi.fn(), send: vi.fn(),
  me: vi.fn(), status: vi.fn(), getSessionFiles: vi.fn(),
  home: { events: [] as unknown[], calendarFeedUrl: '', addEvent: vi.fn(), removeEvent: vi.fn() },
}));
vi.mock('@/slides/api', () => ({ fetchSlidesManifest: mocks.fetchSlidesManifest, listSlidesFiles: mocks.listSlidesFiles, fetchSlideEdits: mocks.fetchSlideEdits, saveSlideEdits: mocks.saveSlideEdits, slideEditsAreRendered: mocks.slideEditsAreRendered }));
vi.mock('@/settings/settings-api', () => ({ getMyProfileStatus: mocks.getMyProfileStatus }));
vi.mock('@/runtime/ui-protocol-send', () => ({ sendMessage: mocks.send }));
vi.mock('@/api/auth', () => ({ me: mocks.me, status: mocks.status }));
vi.mock('@/api/sessions', () => ({ getSessionFiles: mocks.getSessionFiles }));
vi.mock('@/home/home-settings-context', () => ({ useHomeSettings: () => mocks.home }));

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  mocks.status.mockResolvedValue({});
  mocks.getMyProfileStatus.mockResolvedValue({ running: true });
  mocks.listSlidesFiles.mockResolvedValue([]);
  mocks.fetchSlideEdits.mockResolvedValue(null);
  mocks.slideEditsAreRendered.mockResolvedValue(false);
  mocks.saveSlideEdits.mockImplementation(async (project, slides) => {
    const document = { revision: 'edit-1', savedAt: new Date().toISOString(), baseGeneratedAt: project.manifestGeneratedAt, slides };
    mocks.fetchSlideEdits.mockResolvedValue(document);
    return document;
  });
  mocks.home.events = [];
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }));
  FileStore.revokeAll();
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('Account isolation', () => {
  it('does not show account A decks after logging out and signing in as B', () => {
    setToken('review-account-a');
    createSlidesProject({ title: 'A confidential acquisition', slides: [{ index: 0, title: 'Private slide', notes: 'Private notes', layout: 'title' }] });
    clearToken(); setToken('review-account-b');
    expect(getAllSlidesProjects()).toEqual([]);
  });
  it('does not show account A sites after logging out and signing in as B', () => {
    setToken('review-account-a'); localStorage.setItem('selected_profile', 'profile-a');
    createSiteProject('astro');
    clearToken(); setToken('review-account-b');
    expect(getAllSiteProjects()).toEqual([]);
  });
  it('does not offer account A learning sessions after signing in as B', () => {
    setToken('review-account-a');
    adoptLearningSession({ id: 'learn-private-review', title: 'A private lesson', status: 'paused', createdAt: 1, updatedAt: 1 });
    clearToken(); setToken('review-account-b');
    expect(listLearningSessions()).toEqual([]);
  });
});

function seedDeck() {
  upsertSlidesProject({ id: 'slides-review', title: 'Review deck', createdAt: 1, updatedAt: 1,
    scaffolded: true, slug: 'review', template: 'business', tags: [], versions: [],
    manifestGeneratedAt: 'unchanged', pptxUrl: '/api/files/review.pptx',
    slides: [1, 2].map((n, index) => ({ index, title: `Slide ${n}`, notes: '', layout: 'content', thumbnailUrl: `pf/review/slide-${n}.png` })),
  });
  mocks.fetchSlidesManifest.mockResolvedValue({ generatedAt: 'unchanged', slides: [1, 2].map((n, index) => ({ index, filename: `slide-${n}.png`, path: `pf/review/slide-${n}.png` })) });
}
function deckWrapper({ children }: { children: ReactNode }) { return <SlidesProvider projectId="slides-review">{children}</SlidesProvider>; }
describe('Slide edits survive unchanged backend polling', () => {
  it('keeps the original deck and shows an error if persistence fails', async () => {
    seedDeck();
    mocks.saveSlideEdits.mockRejectedValueOnce(new Error('Server unavailable'));
    const { result } = renderHook(useSlides, { wrapper: deckWrapper });
    await act(async () => {});
    await act(async () => result.current.removeSlide(0));
    expect(getSlidesProject('slides-review')?.slides).toHaveLength(2);
    expect(result.current.editError).toBe('Server unavailable');
    expect(mocks.send).not.toHaveBeenCalled();
  });
  it('restores saved edits even when the renderer is stopped', async () => {
    seedDeck();
    const slides = [{ index: 0, title: 'Persisted title', notes: 'Persisted notes', layout: 'title' }];
    mocks.fetchSlideEdits.mockResolvedValue({ revision: 'restored', savedAt: '2026-09-10T00:00:00Z', slides });
    mocks.getMyProfileStatus.mockResolvedValue({ running: false });
    const { result } = renderHook(useSlides, { wrapper: deckWrapper });
    await waitFor(() => expect(result.current.project?.slides).toEqual(slides));
    expect(getSlidesProject('slides-review')?.manualEdits?.revision).toBe('restored');
    expect(mocks.listSlidesFiles).not.toHaveBeenCalled();
  });
  it('keeps reordered metadata aligned with the confirmed new images and export', async () => {
    vi.useFakeTimers(); seedDeck();
    const { result } = renderHook(useSlides, { wrapper: deckWrapper });
    await act(async () => {});
    await act(async () => result.current.moveSlide(0, 1));
    mocks.fetchSlidesManifest.mockResolvedValue({ generatedAt: 'new-render', outFile: 'pf/new/deck.pptx', slides: [
      { index: 0, filename: 'slide-1.png', path: 'pf/new/slide-1.png' },
      { index: 1, filename: 'slide-2.png', path: 'pf/new/slide-2.png' },
    ] });
    mocks.slideEditsAreRendered.mockResolvedValue(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    const project = getSlidesProject('slides-review');
    expect(project?.slides[0]).toMatchObject({ title: 'Slide 2', thumbnailUrl: 'pf/new/slide-1.png' });
    expect(project?.pptxPath).toBe('pf/new/deck.pptx');
    expect(project?.appliedEditRevision).toBe('edit-1');
  });
  it('keeps a deleted slide deleted', async () => {
    vi.useFakeTimers(); seedDeck();
    const { result } = renderHook(useSlides, { wrapper: deckWrapper });
    await act(async () => {});
    await act(async () => result.current.removeSlide(0));
    expect(mocks.saveSlideEdits).toHaveBeenCalled();
    expect(getSlidesProject('slides-review')?.slides).toHaveLength(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(getSlidesProject('slides-review')?.slides).toHaveLength(1);
  });
  it('keeps a reordered deck in the chosen order', async () => {
    vi.useFakeTimers(); seedDeck();
    const { result } = renderHook(useSlides, { wrapper: deckWrapper });
    await act(async () => {});
    await act(async () => result.current.moveSlide(0, 1));
    expect(mocks.saveSlideEdits).toHaveBeenCalled();
    expect(getSlidesProject('slides-review')?.slides[0].title).toBe('Slide 2');
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(getSlidesProject('slides-review')?.slides[0].title).toBe('Slide 2');
  });
});

function authWrapper({ children }: { children: ReactNode }) { return <MemoryRouter><AuthProvider>{children}</AuthProvider></MemoryRouter>; }
describe('Auth recovery and cross-tab identity', () => {
  it('retains valid credentials when /me has a temporary network failure', async () => {
    setToken('review-valid-token');
    mocks.me.mockRejectedValue(new TypeError('Failed to fetch'));
    const { result } = renderHook(useAuth, { wrapper: authWrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(getToken()).toBe('review-valid-token');
  });
  it('updates its principal when another tab changes the stored token', async () => {
    setToken('review-account-a');
    mocks.me.mockImplementation(async () => ({ user: { id: getToken() }, portal: {} }));
    const { result } = renderHook(useAuth, { wrapper: authWrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));
    act(() => {
      localStorage.setItem('octos_session_token', 'review-account-b');
      window.dispatchEvent(new StorageEvent('storage', { key: 'octos_session_token', oldValue: 'review-account-a', newValue: 'review-account-b' }));
    });
    await act(async () => {});
    expect(result.current.user?.id).toBe('review-account-b');
  });
});

describe('Calendar correctness', () => {
  it('moves events from upcoming to today after midnight on the standby screen', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date(2026, 8, 10, 23, 59, 59));
    mocks.home.events = [{ id: 'tomorrow', title: 'Morning appointment', date: '2026-09-11', time: '09:00' }];
    const { result, rerender } = renderHook(useEvents);
    expect(result.current.todayEvents).toHaveLength(0);
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    rerender();
    expect(result.current.todayEvents).toHaveLength(1);
  });
  it('converts a UTC feed event to the displayed local calendar date and time', () => {
    const event = parseIcsEvents('BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:review\nDTSTART:20260911T020000Z\nSUMMARY:Call\nEND:VEVENT\nEND:VCALENDAR')[0];
    const expected = new Date('2026-09-11T02:00:00Z');
    const date = `${expected.getFullYear()}-${String(expected.getMonth() + 1).padStart(2, '0')}-${String(expected.getDate()).padStart(2, '0')}`;
    expect({ date: event.date, time: event.time }).toEqual({ date, time: `${String(expected.getHours()).padStart(2, '0')}:${String(expected.getMinutes()).padStart(2, '0')}` });
  });
});

describe('Files deletion', () => {
  it('keeps a deleted file deleted when its session is reloaded', async () => {
    mocks.getSessionFiles.mockResolvedValue([{ filename: 'private.txt', path: 'pf/review/private.txt', size_bytes: 4, modified_at: '2026-09-10T00:00:00Z' }]);
    await FileStore.loadSessionFiles('web-review');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 200 })));
    await FileStore.removeFile(FileStore.getAllFiles()[0].id);
    expect(fetch).toHaveBeenCalledWith('/api/files/mutate', expect.objectContaining({ method: 'POST' }));
    expect(FileStore.getAllFiles()).toHaveLength(0);
    await FileStore.loadSessionFiles('web-review');
    expect(FileStore.getAllFiles()).toHaveLength(0);
  });
});
