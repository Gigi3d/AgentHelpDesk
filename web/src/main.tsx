import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes, useParams } from 'react-router-dom';
import './index.css';
import { StoreProvider } from './lib/store';
import { AppShell } from './components/Shell';
import { ErrorBoundary } from './components/ErrorBoundary';
import Landing from './pages/Landing';
import Home from './pages/Home';
import Tickets from './pages/Tickets';
import TicketPage from './pages/TicketPage';
import { Agents, Endpoints } from './pages/Agents';
import Reports from './pages/Reports';
import Billing from './pages/Billing';
import Settings from './pages/Settings';
import Install from './pages/Install';
import AgentSurfaces from './pages/AgentSurfaces';
import Approve from './pages/Approve';
import Staff from './pages/Staff';
import NotFound from './pages/NotFound';
import Theater from './pages/Theater';
import Memory from './pages/Memory';
import Blaxel from './pages/Blaxel';
import Armature from './pages/Armature';
import Scenarios from './pages/Scenarios';
import { Gate } from './components/Gate';

function OldTheater() {
  const { id } = useParams();
  return <Navigate to={`/app/theater/${id}`} replace />;
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <StoreProvider>
      <ErrorBoundary>
        <BrowserRouter basename={import.meta.env.BASE_URL.replace(/\/+$/, '') || undefined}>
          <Routes>
            <Route path="/" element={<Landing />} />
            <Route path="/unlock" element={<Gate forceLocked />} />
            <Route element={<Gate />}>
            <Route path="/theater" element={<Navigate to="/app/theater" replace />} />
            <Route path="/theater/:id" element={<OldTheater />} />
            <Route path="/memory" element={<Navigate to="/app/memory" replace />} />
            <Route path="/blaxel" element={<Navigate to="/app/blaxel" replace />} />
            <Route path="/approve/:id" element={<Approve />} />
            <Route element={<AppShell />}>
              <Route path="/install" element={<Install />} />
              <Route path="/agents" element={<AgentSurfaces />} />
              <Route path="/staff" element={<Staff />} />
            </Route>
            <Route path="/app" element={<AppShell />}>
              <Route index element={<Home />} />
              <Route path="theater" element={<Theater />} />
              <Route path="theater/:id" element={<Theater />} />
              <Route path="memory" element={<Memory />} />
              <Route path="blaxel" element={<Blaxel />} />
              <Route path="armature" element={<Armature />} />
              <Route path="scenarios" element={<Scenarios />} />
              <Route path="tickets" element={<Tickets />} />
              <Route path="tickets/:id" element={<TicketPage />} />
              <Route path="agents" element={<Agents />} />
              <Route path="endpoints" element={<Endpoints />} />
              <Route path="reports" element={<Reports />} />
              <Route path="billing" element={<Billing />} />
              <Route path="settings" element={<Settings />} />
              <Route path="*" element={<NotFound />} />
            </Route>
            <Route element={<AppShell />}>
              <Route path="*" element={<NotFound />} />
            </Route>
            </Route>
          </Routes>
        </BrowserRouter>
      </ErrorBoundary>
    </StoreProvider>
  </React.StrictMode>,
);
