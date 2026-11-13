import { useEffect, useState, type ReactNode } from 'react';
import { Link, NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { BookOpen, LayoutGrid, LogIn, LogOut, Menu, Plus, ShieldCheck, UserRound, X } from 'lucide-react';
import { useAuth } from './auth.tsx';
import { LoginPage } from './pages/Login.tsx';
import { ProjectsPage } from './pages/Projects.tsx';
import { NewProjectPage } from './pages/NewProject.tsx';
import { ProjectEditorPage } from './pages/ProjectEditor.tsx';
import { AccountPage } from './pages/Account.tsx';
import { AdminPage } from './pages/Admin.tsx';
import { PublicProjectPage } from './pages/PublicProject.tsx';
import { LegalPage } from './pages/Legal.tsx';
import { StatementView } from './ui/ReportView.tsx';
import { ThemeSwitch } from './ui/controls.tsx';

function Suspended() {
  const { logout, user } = useAuth();
  return (
    <div className="page narrow">
      <h1>Account suspended</h1>
      <div className="msg err">This account is suspended, so you cannot change anything.</div>
      {user?.suspension && <div style={{ margin: 'var(--tm-s-4) 0' }}><StatementView s={user.suspension} /></div>}
      <p className="muted">If you think this is a mistake, write to the contact address in the legal notice and name your account.</p>
      <button className="btn" onClick={() => void logout()}>Log out</button>
    </div>
  );
}

function Protected({ children, admin }: { children: ReactNode; admin?: boolean }) {
  const { user } = useAuth();
  const loc = useLocation();
  if (!user) return <Navigate to={`/login?next=${encodeURIComponent(loc.pathname + loc.search)}`} replace />;
  if (user.suspended) return <Suspended />;
  if (admin && user.role !== 'admin') return <div className="page narrow"><h1>Not allowed</h1><p className="muted">This page is for hub admins.</p></div>;
  return <>{children}</>;
}

// The developer docs live on the website (apps/web, /dev/). VITE_WEB_URL is the website's base URL; unset means same host.
const WEB_URL = String((import.meta as { env?: Record<string, string> }).env?.VITE_WEB_URL ?? '').replace(/\/$/, '');
const DOCS_URL = `${WEB_URL}/dev/`;
// "API" leads to the Public API page of the developer docs (it links the OpenAPI document), not to the raw JSON.
const API_DOCS_URL = `${WEB_URL}/dev/docs/public-api/`;

function Shell({ children }: { children: ReactNode }) {
  const { user, logout } = useAuth();
  const [open, setOpen] = useState(false);
  const loc = useLocation();
  useEffect(() => setOpen(false), [loc.pathname]);
  return (
    <>
      <a className="skip" href="#main" onClick={(e) => { e.preventDefault(); document.getElementById('main')?.focus(); }}>Skip to content</a>
      <div className="topbar">
        <Link to="/" className="brand" style={{ color: 'inherit' }}>TM <b>Hub</b></Link>
        <button className="btn sm menu-btn" onClick={() => setOpen(!open)} aria-label="Menu" aria-expanded={open}>{open ? <X size={16} /> : <Menu size={16} />} Menu</button>
      </div>
      <div className="shell">
        <nav className={`side ${open ? 'open' : ''}`} aria-label="Main">
          <Link to="/" className="brand" style={{ color: 'inherit', textDecoration: 'none' }}>TM <b>Horizon</b> Hub</Link>
          <a className="nav docs-link" href={DOCS_URL} target="_blank" rel="noopener noreferrer"><BookOpen size={16} /> Docs</a>
          {user ? (
            <>
              <NavLink to="/" end className="nav"><LayoutGrid size={16} /> My projects</NavLink>
              <NavLink to="/new" className="nav"><Plus size={16} /> New project</NavLink>
              <NavLink to="/account" className="nav"><UserRound size={16} /> Account</NavLink>
              {user.role === 'admin' && <NavLink to="/admin" className="nav"><ShieldCheck size={16} /> Admin</NavLink>}
              <div className="sp" />
              <div className="side-theme"><span className="lbl">Theme</span><ThemeSwitch /></div>
              <div className="who">
                <div style={{ fontWeight: 600 }}>{user.name}</div>
                <div className="muted small">{user.role}</div>
                <button className="btn sm ghost" style={{ marginTop: 'var(--tm-s-2)' }} onClick={() => void logout()}><LogOut size={14} /> Log out</button>
              </div>
            </>
          ) : (
            <>
              <NavLink to="/login" className="nav"><LogIn size={16} /> Log in</NavLink>
              <div className="sp" />
              <div className="side-theme"><span className="lbl">Theme</span><ThemeSwitch /></div>
            </>
          )}
        </nav>
        <div className="main">
          <main id="main" tabIndex={-1}>{children}</main>
          <footer className="footer">
            <span>TM Horizon Hub</span>
            <Link to="/legal/impressum?lang=en">Legal notice</Link>
            <Link to="/legal/datenschutz?lang=en">Privacy</Link>
            <Link to="/legal/nutzungsbedingungen?lang=en">Terms</Link>
            <a href={DOCS_URL} target="_blank" rel="noopener noreferrer">Docs</a>
            <a href={API_DOCS_URL} target="_blank" rel="noopener noreferrer">API</a>
          </footer>
        </div>
      </div>
    </>
  );
}

export function App() {
  return (
    <Shell>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/" element={<Protected><ProjectsPage /></Protected>} />
        <Route path="/new" element={<Protected><NewProjectPage /></Protected>} />
        <Route path="/projects/:slug" element={<Protected><ProjectEditorPage /></Protected>} />
        <Route path="/account" element={<Protected><AccountPage /></Protected>} />
        <Route path="/admin" element={<Protected admin><AdminPage /></Protected>} />
        <Route path="/p/:slug" element={<PublicProjectPage />} />
        <Route path="/legal/:name" element={<LegalPage />} />
        <Route path="*" element={<div className="page narrow"><h1>Not found</h1><Link to="/">Back to start</Link></div>} />
      </Routes>
    </Shell>
  );
}
