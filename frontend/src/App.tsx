import { NavLink, Route, Routes, useNavigate } from "react-router-dom";
import { AuthProvider, useAuth } from "./context/AuthContext";
import { ProjectsPage } from "./pages/Projects";
import { CreateProjectPage } from "./pages/CreateProject";
import { ProjectDetailPage } from "./pages/ProjectDetail";
import { shortAddress } from "./auth/wallet";

function Header() {
  const { user, connecting, login, logout } = useAuth();
  const navigate = useNavigate();

  return (
    <header className="header">
      <NavLink to="/" className="brand">
        escrow
      </NavLink>
      <nav className="nav">
        <NavLink to="/">Projects</NavLink>
        <NavLink to="/projects/new">New</NavLink>
      </nav>
      {user ? (
        <div className="session">
          <span className="address" title={user.address}>
            {shortAddress(user.address)}
            {user.isAdmin && <span className="badge">admin</span>}
            {user.jurorStatus === "approved" && <span className="badge">juror</span>}
          </span>
          <button
            onClick={() => {
              logout();
              navigate("/");
            }}
          >
            Log out
          </button>
        </div>
      ) : (
        <button onClick={() => void login()} disabled={connecting}>
          {connecting ? "Signing…" : "Connect wallet"}
        </button>
      )}
    </header>
  );
}

function Shell() {
  const { loading } = useAuth();
  if (loading) return <div className="center muted">Loading…</div>;

  return (
    <>
      <Header />
      <main className="main">
        <Routes>
          <Route path="/" element={<ProjectsPage />} />
          <Route path="/projects/new" element={<CreateProjectPage />} />
          <Route path="/projects/:id" element={<ProjectDetailPage />} />
        </Routes>
      </main>
    </>
  );
}

export function App() {
  return (
    <AuthProvider>
      <Shell />
    </AuthProvider>
  );
}
