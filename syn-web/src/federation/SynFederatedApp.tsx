/**
 * 联邦入口：给 uiam 桌面用的页面级模块。
 *
 * 与独立访问的区别只在「外壳」：这里用 MemoryRouter 把路由关在窗口内部，
 * 不碰宿主地址栏，也不渲染浏览器整页壳；页面清单、数据模式和会话门仍复用
 * App.tsx 的同一份实现，避免出现两套页面表。
 *
 * 主题通过 props 传入而不是读宿主 DOM：React 单例后 props 就是最可靠的通道，
 * 宿主从 light 切到 dark 时这里会直接重渲染。
 */
import { useEffect } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { AppRoutes, DataModeBridge } from '../App';
import { NAV } from '../components/layout/Sidebar';
import { ToastProvider } from '../components/ui/Toast';
import '../styles.css';
import './federation.css';

export interface SynFederatedProps {
  theme?: 'light' | 'dark';
  initialPath?: string;
  onRoute?: (path: string, title: string) => void;
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, staleTime: 5_000, refetchOnWindowFocus: true },
  },
});

function titleOf(pathname: string): string {
  const hit = NAV.find(
    (item) => item.to === pathname || (item.to !== '/' && pathname.startsWith(`${item.to}/`)),
  );
  return hit ? hit.label : '同步控制台';
}

function RouteReporter({ onRoute }: { onRoute?: SynFederatedProps['onRoute'] }) {
  const { pathname } = useLocation();
  useEffect(() => {
    onRoute?.(pathname, titleOf(pathname));
  }, [pathname, onRoute]);
  return null;
}

export default function SynFederatedApp({
  theme = 'light',
  initialPath = '/',
  onRoute,
}: SynFederatedProps) {
  const entry = initialPath.startsWith('/') ? initialPath : '/';
  return (
    <div className="syn-federated" data-theme={theme}>
      <QueryClientProvider client={queryClient}>
        <ToastProvider>
          <MemoryRouter initialEntries={[entry]}>
            <DataModeBridge />
            <RouteReporter onRoute={onRoute} />
            <AppRoutes />
          </MemoryRouter>
        </ToastProvider>
      </QueryClientProvider>
    </div>
  );
}
