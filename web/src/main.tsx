import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
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

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <StoreProvider>
      <ErrorBoundary>
        <BrowserRouter>
          <Routes>
            <Route path="/" element={<Landing />} />
            <Route path="/install" element={<Install />} />
            <Route path="/agents" element={<AgentSurfaces />} />
            <Route path="/approve/:id" element={<Approve />} />
            <Route path="/staff" element={<Staff />} />
            <Route path="/app" element={<AppShell />}>
              <Route index element={<Home />} />
              <Route path="tickets" element={<Tickets />} />
              <Route path="tickets/:id" element={<TicketPage />} />
              <Route path="agents" element={<Agents />} />
              <Route path="endpoints" element={<Endpoints />} />
              <Route path="reports" element={<Reports />} />
              <Route path="billing" element={<Billing />} />
              <Route path="settings" element={<Settings />} />
              <Route path="*" element={<NotFound />} />
            </Route>
            <Route path="*" element={<NotFound />} />
          </Routes>
        </BrowserRouter>
      </ErrorBoundary>
    </StoreProvider>
  </React.StrictMode>,
);
