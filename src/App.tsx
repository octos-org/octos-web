import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { AuthProvider } from "./auth/auth-context";
import { AuthGuard } from "./auth/auth-guard";
import { LoginPage } from "./auth/login-page";
import { OctosRuntimeProvider } from "./runtime/runtime-provider";
import { ChatLayout } from "./layouts/chat-layout";
import { ChatThread } from "./components/chat-thread";
import { HomePage } from "./pages/home-page";
import { HomeAssistantPage } from "./home/home-assistant-page";
import { VoicePage } from "./home/voice/voice-page";
import { AdminSettingsPage } from "./settings/settings-page";
import { SlidesGalleryPage } from "./slides/pages/slides-gallery-page";
import { SlidesEditorPage } from "./slides/pages/slides-editor-page";
import { SlidesPresentPage } from "./slides/pages/slides-present-page";
import { SitesGalleryPage } from "./sites/pages/sites-gallery-page";
import { SitesEditorPage } from "./sites/pages/sites-editor-page";
import { StudioPage } from "./studio/studio-page";

function ChatPage() {
  return (
    <OctosRuntimeProvider>
      <ChatLayout>
        <div className="flex h-full flex-col min-h-0">
          <div className="flex-1 min-h-0 overflow-hidden">
            <ChatThread />
          </div>
        </div>
      </ChatLayout>
    </OctosRuntimeProvider>
  );
}


export function App() {
  return (
    <BrowserRouter basename={import.meta.env.BASE_URL}>
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route element={<AuthGuard />}>
            <Route path="/" element={<HomePage />} />
            <Route path="/home" element={<HomeAssistantPage />} />
            <Route path="/voice" element={<VoicePage />} />
            <Route path="/chat/*" element={<ChatPage />} />
            {/* Studio revived (Ivory Obsidian workspace): /studio/:projectId
                hosts the 3-pane workspace pinned to a `web-*` chat session.
                Legacy M9-era `studio-*` ids (deprecated in M9-β-2) are
                redirected home by StudioPage itself; a bare /studio has no
                project to show and also lands home. */}
            <Route path="/studio/:projectId" element={<StudioPage />} />
            <Route path="/studio" element={<Navigate to="/" replace />} />
            <Route path="/settings" element={<AdminSettingsPage />} />
            <Route path="/slides" element={<SlidesGalleryPage />} />
            <Route path="/slides/:id/present" element={<SlidesPresentPage />} />
            <Route path="/slides/:id" element={<SlidesEditorPage />} />
            <Route path="/sites" element={<SitesGalleryPage />} />
            <Route path="/sites/:id" element={<SitesEditorPage />} />
          </Route>
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}
