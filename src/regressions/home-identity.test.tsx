import { cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { clearToken, setToken } from '@/api/client';
import { HomeSettingsProvider, useHomeSettings } from '@/home/home-settings-context';
const mocks = vi.hoisted(() => ({ getMyProfile: vi.fn(), updateMyProfileConfig: vi.fn() }));
vi.mock('@/settings/settings-api', () => mocks);
afterEach(cleanup);
it('does not migrate account A calendar/photo data into the next account B profile', async () => {
  localStorage.clear(); setToken('review-account-a');
  localStorage.setItem('octos_home_events', JSON.stringify([{ id: 'private', title: 'A private appointment', date: '2026-09-10', time: '15:00' }]));
  localStorage.setItem('octos_home_photos', JSON.stringify(['https://example.invalid/a-private-photo']));
  clearToken(); setToken('review-account-b');
  const profile = { id: 'profile-b', config: { home: null } };
  mocks.getMyProfile.mockResolvedValue(profile);
  mocks.updateMyProfileConfig.mockImplementation(async (p, patch) => ({ ...p, config: { ...p.config, ...patch } }));
  renderHook(useHomeSettings, { wrapper: HomeSettingsProvider });
  await waitFor(() => expect(mocks.updateMyProfileConfig).toHaveBeenCalled());
  expect(mocks.updateMyProfileConfig.mock.calls[0][1].home.events).toEqual([]);
});
