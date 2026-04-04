import { BrowserRouter, Routes, Route } from "react-router-dom";
import { AuthProvider } from "./auth/auth-context";
import { AuthGuard } from "./auth/auth-guard";
import { LoginPage } from "./auth/login-page";
import { OctosRuntimeProvider } from "./runtime/runtime-provider";
import { ChatLayout } from "./layouts/chat-layout";
import { ChatThread } from "./components/chat-thread";
import { HomePage } from "./pages/home-page";
import { SettingsPage } from "./pages/settings-page";
import { StudioPage } from "./pages/studio-page";
import { SlidesGalleryPage } from "./slides/pages/slides-gallery-page";
import { SlidesEditorPage } from "./slides/pages/slides-editor-page";

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
            <Route path="/chat/*" element={<ChatPage />} />
            <Route path="/studio/new" element={<StudioPage />} />
            <Route path="/studio/:projectId" element={<StudioPage />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="/slides" element={<SlidesGalleryPage />} />
            <Route path="/slides/:id" element={<SlidesEditorPage />} />
          </Route>
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}
