import { BrowserRouter, Routes, Route } from "react-router-dom";
import { AuthProvider } from "./auth/auth-context";
import { AuthGuard } from "./auth/auth-guard";
import { LoginPage } from "./auth/login-page";
import { OctosRuntimeProvider } from "./runtime/runtime-provider";
import { ChatLayout } from "./layouts/chat-layout";
import { Thread } from "./components/thread";
import { ThinkingIndicator } from "./components/thinking-indicator";
import { ToolProgressIndicator } from "./components/tool-progress-indicator";
import { NotebookListPage } from "./notebook/pages/notebook-list";
import { NotebookDetailPage } from "./notebook/pages/notebook-detail";
import {
  ShellToolUI,
  ReadFileToolUI,
  WriteFileToolUI,
  EditFileToolUI,
  WebSearchToolUI,
  WebFetchToolUI,
  GrepToolUI,
  GlobToolUI,
  GenericToolUI,
} from "./tools";

export function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route element={<AuthGuard />}>
            {/* Notebook routes */}
            <Route
              path="/notebooks"
              element={
                <ChatLayout>
                  <NotebookListPage />
                </ChatLayout>
              }
            />
            <Route
              path="/notebooks/:id"
              element={
                <ChatLayout>
                  <NotebookDetailPage />
                </ChatLayout>
              }
            />
            {/* Chat route (default) */}
            <Route
              path="/*"
              element={
                <OctosRuntimeProvider>
                  <ChatLayout>
                    <div className="flex h-full flex-col min-h-0">
                      <ThinkingIndicator />
                      <ToolProgressIndicator />
                      <div className="flex-1 min-h-0 overflow-hidden">
                        <Thread />
                      </div>
                    </div>
                  </ChatLayout>
                  {/* Register tool UIs */}
                  <ShellToolUI />
                  <ReadFileToolUI />
                  <WriteFileToolUI />
                  <EditFileToolUI />
                  <WebSearchToolUI />
                  <WebFetchToolUI />
                  <GrepToolUI />
                  <GlobToolUI />
                  <GenericToolUI />
                </OctosRuntimeProvider>
              }
            />
          </Route>
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}
