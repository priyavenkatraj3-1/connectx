import { Navigate, Route, Routes } from "react-router-dom";
import { AppShellLayout } from "./components/layout/AppShellLayout";
import { AuthProvider } from "./context/AuthContext";
import { RealtimeProvider } from "./context/RealtimeContext";
import { LandingPage } from "./pages/LandingPage";
import { LoginPage } from "./pages/LoginPage";
import { SignupPage } from "./pages/SignupPage";
import { ChatConversationPage } from "./pages/app/ChatConversationPage";
import { ChatsLayout } from "./pages/app/ChatsLayout";
import { ChatsView } from "./pages/app/ChatsView";
import { ProfileView } from "./pages/app/ProfileView";
import { SettingsView } from "./pages/app/SettingsView";
import { StatusView } from "./pages/app/StatusView";
import { ProtectedRoute } from "./routes/ProtectedRoute";

export function App() {
  return (
    <AuthProvider>
      <RealtimeProvider>
        <Routes>
          <Route path="/" element={<LandingPage />} />
          <Route path="/login" element={<LoginPage />} />
          <Route path="/signup" element={<SignupPage />} />

          <Route
            path="/app"
            element={
              <ProtectedRoute>
                <AppShellLayout />
              </ProtectedRoute>
            }
          >
            <Route element={<ChatsLayout />}>
              <Route index element={<ChatsView />} />
              <Route path="chat/:conversationId" element={<ChatConversationPage />} />
            </Route>
            <Route path="status" element={<StatusView />} />
            <Route path="settings" element={<SettingsView />} />
            <Route path="profile" element={<ProfileView />} />
          </Route>

          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </RealtimeProvider>
    </AuthProvider>
  );
}
