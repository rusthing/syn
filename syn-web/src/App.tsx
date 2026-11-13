import { useEffect } from "react";
import { QueryClient, QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { BrowserRouter, HashRouter, Navigate, Route, Routes } from "react-router-dom";
import { AppShell } from "@/components/layout/AppShell";
import { ToastProvider } from "@/components/ui/Toast";
import { AuthGate } from "@/auth/AuthGate";
import { LoginPage } from "@/pages/LoginPage";
import { subscribeDataMode } from "@/lib/api";
import { OverviewPage } from "@/features/overview/OverviewPage";
import { TasksPage } from "@/features/tasks/TasksPage";
import { SourcesPage } from "@/features/sources/SourcesPage";
import { DatasourcesPage } from "@/features/datasources/DatasourcesPage";
import { PlaygroundPage } from "@/features/playground/PlaygroundPage";
import { DeliveriesPage } from "@/features/deliveries/DeliveriesPage";
import { IdemPage } from "@/features/idem/IdemPage";

/**
 * 静态服务器不方便配 SPA 回退（`try_files $uri /syn-web/index.html`）时，
 * 用 `VITE_ROUTER=hash` 退化成 hash 路由，刷新不会 404。
 */
const USE_HASH = import.meta.env.VITE_ROUTER === "hash";

/**
 * 部署在子路径时（PUBLIC_BASE=/syn-web/），路由必须跟着挂同样的前缀。
 * hash 模式例外：react-router 会拿 basename 去匹配 hash 里的路径，带上去整页空白。
 */
const BASENAME = USE_HASH ? "" : import.meta.env.BASE_URL.replace(/\/+$/, "");

const Router = USE_HASH ? HashRouter : BrowserRouter;

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      staleTime: 5_000,
      refetchOnWindowFocus: true,
    },
  },
});

/** 切换数据源后必须清缓存，否则演示数据会混进实时视图 */
function DataModeBridge() {
  const client = useQueryClient();
  useEffect(
    () =>
      subscribeDataMode(() => {
        client.clear();
      }),
    [client],
  );
  return null;
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <Router basename={BASENAME || undefined}>
          <DataModeBridge />
          <Routes>
            {/* 登录页放在登录门之外；主控制台统一走 adm 会话保护 */}
            <Route path="login" element={<LoginPage />} />
            <Route
              element={
                <AuthGate>
                  <AppShell />
                </AuthGate>
              }
            >
              <Route index element={<OverviewPage />} />
              <Route path="tasks" element={<TasksPage />} />
              <Route path="sources" element={<SourcesPage />} />
              <Route path="datasources" element={<DatasourcesPage />} />
              <Route path="playground" element={<PlaygroundPage />} />
              <Route path="deliveries" element={<DeliveriesPage />} />
              <Route path="idem" element={<IdemPage />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Route>
          </Routes>
        </Router>
      </ToastProvider>
    </QueryClientProvider>
  );
}
